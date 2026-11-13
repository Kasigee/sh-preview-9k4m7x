// ============================================================================
// TheHumanProject v2 — Real Experimental 3D RCSB PDB Macromolecular Viewer
// ============================================================================
// Renders actual C-alpha backbone coordinates, secondary structure ribbons
// (alpha-helices, beta-strands, coils), bound small-molecule ligands (CPK),
// and UniProt human pathogenic missense variant residues in interactive 3D!
// ============================================================================

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

const ELEMENT_COLORS = {
  C: 0x383b39,
  N: 0x2f68b8,
  O: 0xc93b2b,
  S: 0xd9a528,
  P: 0xd96b27,
  FE: 0xc84b31,
  ZN: 0x6f7a8a,
  MG: 0x3e9c5e,
  MN: 0x8a52a8,
  F: 0x5ab878,
  CL: 0x3ea858,
};

export class PdbViewer3D {
  constructor(containerEl) {
    this.container = containerEl;
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(38, 1, 0.5, 600);
    this.camera.position.set(0, 0, 75);

    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.container.innerHTML = '';
    this.container.appendChild(this.renderer.domElement);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.autoRotate = true;
    this.controls.autoRotateSpeed = 0.9;

    const amb = new THREE.AmbientLight(0xffffff, 1.35);
    const key = new THREE.DirectionalLight(0xfff8f0, 1.8);
    key.position.set(35, 50, 45);
    const rim = new THREE.DirectionalLight(0xdce8f5, 0.95);
    rim.position.set(-40, -25, -35);
    this.scene.add(amb, key, rim);

    this.rootGroup = new THREE.Group();
    this.scene.add(this.rootGroup);
    this.variantMeshes = new Map(); // position -> THREE.Mesh
    this.centroid = new THREE.Vector3();
    this._animId = null;
    this._running = false;

    this._onResize = () => this.resize();
    window.addEventListener('resize', this._onResize);
  }

  resize() {
    if (!this.container) return;
    const w = Math.max(240, this.container.clientWidth || 420);
    const h = Math.max(200, this.container.clientHeight || 300);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
  }

  start() {
    if (this._running) return;
    this._running = true;
    this.resize();
    const tick = () => {
      if (!this._running) return;
      this._animId = requestAnimationFrame(tick);
      const pulse = 1.0 + 0.14 * Math.sin(performance.now() * 0.0045);
      for (const m of this.variantMeshes.values()) {
        m.scale.setScalar(m.userData.focused ? pulse * 1.35 : pulse);
      }
      this.controls.update();
      this.renderer.render(this.scene, this.camera);
    };
    tick();
  }

  stop() {
    this._running = false;
    if (this._animId) cancelAnimationFrame(this._animId);
  }

  clearGroup() {
    while (this.rootGroup.children.length > 0) {
      const ch = this.rootGroup.children.pop();
      if (ch.geometry) ch.geometry.dispose();
      if (ch.material) {
        if (Array.isArray(ch.material)) ch.material.forEach(m => m.dispose());
        else ch.material.dispose();
      }
    }
    this.variantMeshes.clear();
  }

  loadStructureData(structData) {
    this.clearGroup();
    const trace = structData.ca_trace || [];
    if (!trace.length) return;

    // Compute geometric centroid so structure sits cleanly at (0, 0, 0)
    let cx = 0, cy = 0, cz = 0;
    for (const a of trace) { cx += a.x; cy += a.y; cz += a.z; }
    cx /= trace.length; cy /= trace.length; cz /= trace.length;
    this.centroid.set(cx, cy, cz);

    let maxR = 12;
    const resCoordMap = new Map();
    const byChain = new Map();
    for (const a of trace) {
      const pt = new THREE.Vector3(a.x - cx, a.y - cy, a.z - cz);
      const d = pt.length();
      if (d > maxR) maxR = d;
      if (!resCoordMap.has(a.res)) resCoordMap.set(a.res, { pt, aa: a.aa, chain: a.chain });
      if (!byChain.has(a.chain)) byChain.set(a.chain, []);
      byChain.get(a.chain).push({ ...a, pt });
    }

    // Build vertex-colored smooth C-alpha ribbon tube per contiguous chain segment!
    const ssColors = {
      H: new THREE.Color(0xd2512d), // Alpha-helix: warm terracotta accent
      E: new THREE.Color(0x2c6680), // Beta-sheet: deep slate cyan
      C: new THREE.Color(0x8e9189), // Coil/loop: neutral stone
    };

    for (const [, atoms] of byChain.entries()) {
      // Split at crystallographic chain breaks (> 5.5 Angstroms between consecutive CAs)
      const segments = [];
      let cur = [];
      for (let i = 0; i < atoms.length; i++) {
        if (cur.length > 0 && cur[cur.length - 1].pt.distanceTo(atoms[i].pt) > 5.8) {
          if (cur.length >= 2) segments.push(cur);
          cur = [];
        }
        cur.push(atoms[i]);
      }
      if (cur.length >= 2) segments.push(cur);

      for (const seg of segments) {
        const pts = seg.map(s => s.pt);
        const curve = new THREE.CatmullRomCurve3(pts, false, 'catmullrom', 0.35);
        const tubularSegs = Math.min(900, Math.max(16, seg.length * 4));
        const geom = new THREE.TubeGeometry(curve, tubularSegs, 0.62, 8, false);

        // Assign secondary-structure vertex colors along the tube!
        const posAttr = geom.attributes.position;
        const colors = new Float32Array(posAttr.count * 3);
        const radialVerts = 9; // radialSegments + 1
        for (let ring = 0; ring <= tubularSegs; ring++) {
          const frac = ring / tubularSegs;
          const atomIdx = Math.min(seg.length - 1, Math.round(frac * (seg.length - 1)));
          const col = ssColors[seg[atomIdx].ss] || ssColors.C;
          for (let rv = 0; rv < radialVerts; rv++) {
            const vIdx = (ring * radialVerts + rv) * 3;
            if (vIdx + 2 < colors.length) {
              colors[vIdx] = col.r;
              colors[vIdx + 1] = col.g;
              colors[vIdx + 2] = col.b;
            }
          }
        }
        geom.setAttribute('color', new THREE.BufferAttribute(colors, 3));
        const mat = new THREE.MeshStandardMaterial({
          vertexColors: true,
          roughness: 0.35,
          metalness: 0.08,
        });
        this.rootGroup.add(new THREE.Mesh(geom, mat));
      }
    }

    // Bound Small-Molecule Ligand / Cofactor Atoms (CPK spheres + covalent sticks)
    const ligAtoms = structData.ligand_atoms || [];
    if (ligAtoms.length > 0) {
      const sphGeo = new THREE.SphereGeometry(0.82, 14, 12);
      const ligPts = [];
      for (const la of ligAtoms) {
        const p = new THREE.Vector3(la.x - cx, la.y - cy, la.z - cz);
        const colHex = ELEMENT_COLORS[(la.elem || 'C').toUpperCase()] || 0x2fb37d;
        const m = new THREE.Mesh(
          sphGeo,
          new THREE.MeshStandardMaterial({ color: colHex, roughness: 0.22, metalness: 0.18 })
        );
        m.position.copy(p);
        this.rootGroup.add(m);
        ligPts.push({ p, comp: la.comp, chain: la.chain });
      }
      // Covalent bonds (< 1.95 Å within same ligand residue/chain)
      const bondMat = new THREE.MeshStandardMaterial({ color: 0x5c605d, roughness: 0.4 });
      for (let i = 0; i < ligPts.length; i++) {
        for (let j = i + 1; j < ligPts.length; j++) {
          if (ligPts[i].comp === ligPts[j].comp && ligPts[i].chain === ligPts[j].chain) {
            const d = ligPts[i].p.distanceTo(ligPts[j].p);
            if (d > 0.6 && d < 1.98) {
              const cyl = new THREE.CylinderGeometry(0.24, 0.24, d, 6);
              const bond = new THREE.Mesh(cyl, bondMat);
              bond.position.copy(ligPts[i].p).add(ligPts[j].p).multiplyScalar(0.5);
              bond.quaternion.setFromUnitVectors(
                new THREE.Vector3(0, 1, 0),
                ligPts[j].p.clone().sub(ligPts[i].p).normalize()
              );
              this.rootGroup.add(bond);
            }
          }
        }
      }
    }

    // Highlighted Human Pathogenic Variant Residues (mapped by exact sequence number!)
    const variants = structData.variants || [];
    const varGeo = new THREE.SphereGeometry(1.45, 18, 16);
    for (const v of variants) {
      const hit = resCoordMap.get(v.position);
      if (!hit) continue;
      const varMat = new THREE.MeshStandardMaterial({
        color: 0xe63946,
        emissive: 0x9e1b24,
        emissiveIntensity: 0.55,
        roughness: 0.2,
      });
      const vm = new THREE.Mesh(varGeo, varMat);
      vm.position.copy(hit.pt);
      vm.userData = { variant: v, focused: false };
      this.rootGroup.add(vm);
      this.variantMeshes.set(v.position, vm);
    }

    // Frame camera cleanly around the macromolecule
    this.controls.target.set(0, 0, 0);
    const dist = Math.max(28, maxR * 2.35);
    this.camera.position.set(dist * 0.45, dist * 0.28, dist);
    this.controls.update();
    this.start();
  }

  focusResidue(resNum) {
    for (const [pos, mesh] of this.variantMeshes.entries()) {
      mesh.userData.focused = (pos === resNum);
      mesh.material.emissiveIntensity = (pos === resNum) ? 1.0 : 0.45;
    }
    const targetMesh = this.variantMeshes.get(resNum);
    if (targetMesh) {
      this.controls.autoRotate = false;
      this.controls.target.copy(targetMesh.position);
      const dir = targetMesh.position.clone().normalize();
      if (dir.lengthSq() < 0.01) dir.set(0, 0, 1);
      this.camera.position.copy(targetMesh.position).addScaledVector(dir, 22);
      this.controls.update();
    }
  }
}
