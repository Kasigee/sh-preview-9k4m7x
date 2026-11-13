// ============================================================================
// TheHumanProject v2 — Real-Anatomy 32-Organ NIH HRA .glb Three.js Engine
// ============================================================================
// Loads and co-registers 32 authentic NIH Human Reference Atlas (Visible Human
// & Allen Brain) 3D .glb organ models (773 anatomical sub-meshes, 3.75M tris)
// with PBR RoomEnvironment lighting, anatomical layer peeling, exploded system
// dissection, 3-axis surgical cross-section clipping, sub-mesh raycasting,
// smooth camera fly-to, and live ODE-coupled cardiac/respiratory biomechanics!
// ============================================================================

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

const SYSTEM_PALETTE = {
  'SYS:CARDIOVASCULAR':  { color: 0xb8332c, roughness: 0.34, clearcoat: 0.45 },
  'SYS:RESPIRATORY':     { color: 0xc97f79, roughness: 0.52, clearcoat: 0.22 },
  'SYS:NERVOUS':         { color: 0xd8c3b8, roughness: 0.46, clearcoat: 0.28 },
  'SYS:RENAL':           { color: 0x8f4632, roughness: 0.32, clearcoat: 0.48 },
  'SYS:HEPATOBILIARY':   { color: 0x733224, roughness: 0.30, clearcoat: 0.52 },
  'SYS:GASTROINTESTINAL':{ color: 0xc98b70, roughness: 0.40, clearcoat: 0.35 },
  'SYS:ENDOCRINE':       { color: 0xd1a256, roughness: 0.44, clearcoat: 0.30 },
  'SYS:IMMUNE':          { color: 0x7d3545, roughness: 0.36, clearcoat: 0.38 },
  'SYS:MUSCULOSKELETAL': { color: 0xdcd6c8, roughness: 0.58, clearcoat: 0.12 },
  'SYS:INTEGUMENTARY':   { color: 0xc9a897, roughness: 0.65, clearcoat: 0.08 },
};

export class HraSceneEngine {
  constructor(canvasContainer, callbacks = {}) {
    this.container = canvasContainer;
    this.onSelectMesh = callbacks.onSelectMesh || (() => {});
    this.onHoverMesh = callbacks.onHoverMesh || (() => {});
    this.onLoadProgress = callbacks.onLoadProgress || (() => {});

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(36, 1, 0.015, 25);
    // Initial framing of full 1.82m standing human body (Y in [-0.91, +0.91], centered near Y=+0.15)
    this.camera.position.set(0.0, 0.22, 2.55);

    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.06;
    this.renderer.localClippingEnabled = true;
    this.container.appendChild(this.renderer.domElement);

    // Subtle studio PBR environment
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    pmrem.dispose();

    const hemi = new THREE.HemisphereLight(0xfffcf7, 0x3b3d3a, 0.85);
    const dirKey = new THREE.DirectionalLight(0xfffaf2, 1.35);
    dirKey.position.set(1.8, 2.4, 2.6);
    const dirRim = new THREE.DirectionalLight(0xd9e8f5, 0.65);
    dirRim.position.set(-2.2, 0.8, -1.8);
    this.scene.add(hemi, dirKey, dirRim);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.075;
    this.controls.target.set(0.0, 0.16, 0.0);
    this.controls.minDistance = 0.08;
    this.controls.maxDistance = 5.5;

    this.bodyRoot = new THREE.Group();
    this.scene.add(this.bodyRoot);

    // Subtle anatomical floor reference grid / ring at feet (Y = -0.915 m)
    this.floorRing = new THREE.Mesh(
      new THREE.RingGeometry(0.28, 0.286, 64),
      new THREE.MeshBasicMaterial({ color: 0x99968e, side: THREE.DoubleSide, transparent: true, opacity: 0.35 })
    );
    this.floorRing.rotation.x = -Math.PI / 2;
    this.floorRing.position.y = -0.915;
    this.scene.add(this.floorRing);

    // Surgical cross-section clipping plane
    this.clipAxis = 'off'; // 'off' | 'x' | 'y' | 'z'
    this.clipOffset = 0.0;
    this.clipPlane = new THREE.Plane(new THREE.Vector3(-1, 0, 0), 0.0);

    // Layer visibility & dissection state
    this.layers = {
      skin: true,
      vasculature: true,
      skeleton: true,
      musculature: false,
      organs: true,
      serosa: false,
    };
    this.activeSystemFilter = 'WHOLE_BODY';
    this.selectedOntologyId = null;
    this.selectedNodeName = null;
    this.explodeFactor = 0.0; // 0..1

    // Registries populated as GLBs load
    this.organGroups = new Map();        // organKey -> THREE.Group
    this.pickableMeshes = [];            // THREE.Mesh[]
    this.meshesByOntology = new Map();   // ontologyId -> THREE.Mesh[]
    this.dynamicCardiac = { lv: [], rv: [], la: [], ra: [] };
    this.dynamicLungs = [];
    this.dynamicRespMuscles = [];

    // Camera fly-to tween state
    this._camTween = null;

    // Pointer / Raycaster interaction
    this.raycaster = new THREE.Raycaster();
    this.pointer = new THREE.Vector2();
    this._downPos = { x: 0, y: 0 };
    this._bindPointerEvents();

    this.applyTheme();
    this.resize();
    window.addEventListener('resize', () => this.resize());
    if (typeof ResizeObserver !== 'undefined') {
      this._resizeObs = new ResizeObserver(() => this.resize());
      this._resizeObs.observe(this.container);
    }
  }

  applyTheme() {
    const isDark = document.documentElement.dataset.theme === 'dark' ||
      (!document.documentElement.dataset.theme && window.matchMedia('(prefers-color-scheme: dark)').matches);
    this.scene.background = new THREE.Color(isDark ? 0x131514 : 0xf2f0eb);
    if (this.floorRing && this.floorRing.material) {
      this.floorRing.material.color.setHex(isDark ? 0x4b4e4a : 0xa8a49b);
    }
  }

  resize() {
    const w = Math.max(240, this.container.clientWidth || 800);
    const h = Math.max(180, this.container.clientHeight || 520);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
  }

  async loadAllHraOrgans(organManifests) {
    const loader = new GLTFLoader();
    // Load priority 1 first, then priority 2, then priority 3 so core organs appear immediately!
    const sorted = [...organManifests].sort((a, b) => a.priority - b.priority);
    let completed = 0;
    const total = sorted.length;

    const loadOne = (orgMeta) => new Promise((resolve) => {
      loader.load(
        orgMeta.glb_rel_url,
        (gltf) => {
          this._registerLoadedOrgan(orgMeta, gltf.scene);
          completed++;
          this.onLoadProgress(completed, total, orgMeta);
          resolve();
        },
        undefined,
        (err) => {
          console.warn('GLB load warning:', orgMeta.key, err);
          completed++;
          this.onLoadProgress(completed, total, orgMeta);
          resolve();
        }
      );
    });

    // Concurrency-limited parallel batching (6 simultaneous local HTTP fetches)
    const concurrency = 6;
    let idx = 0;
    const workers = Array.from({ length: concurrency }, async () => {
      while (idx < sorted.length) {
        const cur = sorted[idx++];
        await loadOne(cur);
      }
    });
    await Promise.all(workers);
    this.updateVisibilityAndHighlighting();
  }

  _registerLoadedOrgan(orgMeta, gltfScene) {
    const wrapper = new THREE.Group();
    wrapper.name = `organ_${orgMeta.key}`;
    wrapper.userData = {
      organKey: orgMeta.key,
      organSystemId: orgMeta.organ_system_id,
      layer: orgMeta.layer,
      baseCenter: new THREE.Vector3(...(orgMeta.center || [0, 0, 0])),
    };

    // Map node metadata by glTF node name
    const nodeMetaByName = new Map();
    for (const n of (orgMeta.nodes || [])) {
      nodeMetaByName.set(n.node_name, n);
    }

    const pal = SYSTEM_PALETTE[orgMeta.organ_system_id] || SYSTEM_PALETTE['SYS:CARDIOVASCULAR'];
    const isSkin = orgMeta.key === 'skin' || orgMeta.key === 'adipose';
    const isVasc = orgMeta.key === 'blood_vasculature';
    const isBone = orgMeta.layer === 'skeleton';
    const isMuscle = orgMeta.layer === 'musculature';

    gltfScene.traverse((obj) => {
      if (!obj.isMesh) return;
      // Walk up ancestors if mesh is an unnamed primitive child of a named glTF node
      let namedNode = obj;
      while (namedNode && !nodeMetaByName.has(namedNode.name) && namedNode.parent) {
        namedNode = namedNode.parent;
      }
      const nMeta = nodeMetaByName.get(namedNode ? namedNode.name : obj.name) || {
        node_name: obj.name || orgMeta.key,
        ontology_id: orgMeta.primary_ontology_id,
        pref_label: orgMeta.label,
      };

      let baseColor = pal.color;
      let roughness = pal.roughness;
      let clearcoat = pal.clearcoat;
      let transparent = false;
      let opacity = 1.0;

      // Subtle anatomical sub-structure color differentiation!
      const nmLower = (nMeta.node_name || '').toLowerCase();
      if (isSkin) {
        baseColor = orgMeta.key === 'adipose' ? 0xd9b86c : 0xcbb5a6;
        transparent = true;
        opacity = orgMeta.key === 'adipose' ? 0.16 : 0.11;
        roughness = 0.72;
        clearcoat = 0.0;
      } else if (isVasc) {
        baseColor = nmLower.includes('vein') || nmLower.includes('venous') || nmLower.includes('vena_cava')
          ? 0x355c96
          : 0xc22f27;
        roughness = 0.28;
        clearcoat = 0.55;
      } else if (isBone) {
        baseColor = (
          nmLower.includes('disk') || nmLower.includes('disc') ||
          nmLower.includes('cartilage') || nmLower.includes('meniscus')
        )
          ? 0xb8cad4
          : 0xe5dfd1;
        roughness = 0.50;
        clearcoat = 0.14;
      } else if (isMuscle) {
        const isTendinous = (
          nmLower.includes('tendon') || nmLower.includes('aponeurosis') ||
          nmLower.includes('tract') || nmLower.includes('retinaculum') ||
          nmLower.includes('linea-alba') || nmLower.includes('ligament')
        );
        baseColor = isTendinous ? 0xdad1c2 : 0xa63930;
        roughness = isTendinous ? 0.36 : 0.44;
        clearcoat = isTendinous ? 0.28 : 0.20;
      } else if (orgMeta.key === 'heart') {
        if (nmLower.includes('valve')) baseColor = 0xe8dfd1;
        else if (nmLower.includes('papillary')) baseColor = 0xa83b32;
        else if (nmLower.includes('right')) baseColor = 0x9e3644;
        else baseColor = 0xbd332a;
      } else if (orgMeta.key === 'trachea' || orgMeta.key === 'main_bronchus' || orgMeta.key === 'larynx') {
        baseColor = 0xd6c7be;
      }

      const mat = new THREE.MeshPhysicalMaterial({
        color: baseColor,
        roughness,
        metalness: 0.02,
        clearcoat,
        clearcoatRoughness: 0.28,
        transparent,
        opacity,
        depthWrite: !transparent,
        side: THREE.DoubleSide,
        clippingPlanes: this.clipAxis === 'off' ? [] : [this.clipPlane],
      });

      obj.material = mat;
      obj.userData = {
        organKey: orgMeta.key,
        organLabel: orgMeta.label,
        organSystemId: orgMeta.organ_system_id,
        layer: orgMeta.layer,
        nodeName: nMeta.node_name,
        prefLabel: nMeta.pref_label || orgMeta.label,
        ontologyId: nMeta.ontology_id || orgMeta.primary_ontology_id,
        baseColorHex: baseColor,
        baseOpacity: opacity,
        isSkinLike: isSkin,
      };

      if (!isSkin) {
        this.pickableMeshes.push(obj);
      }
      const ontId = obj.userData.ontologyId;
      if (!this.meshesByOntology.has(ontId)) this.meshesByOntology.set(ontId, []);
      this.meshesByOntology.get(ontId).push(obj);

      // Register dynamic biomechanical meshes (pivot-safe local centroid scaling)
      if (orgMeta.key === 'heart') {
        obj.geometry.computeBoundingBox();
        const c = new THREE.Vector3();
        obj.geometry.boundingBox.getCenter(c);
        obj.userData.localCentroid = c;
        obj.userData.origPos = obj.position.clone();
        if (nmLower.includes('left_ventricle') || nmLower.includes('septum')) this.dynamicCardiac.lv.push(obj);
        else if (nmLower.includes('right_ventricle')) this.dynamicCardiac.rv.push(obj);
        else if (nmLower.includes('left_cardiac_atrium')) this.dynamicCardiac.la.push(obj);
        else if (nmLower.includes('right_cardiac_atrium')) this.dynamicCardiac.ra.push(obj);
      } else if (orgMeta.key === 'lung') {
        obj.geometry.computeBoundingBox();
        const c = new THREE.Vector3();
        obj.geometry.boundingBox.getCenter(c);
        obj.userData.localCentroid = c;
        obj.userData.origPos = obj.position.clone();
        this.dynamicLungs.push(obj);
      } else if (isMuscle && (nmLower === 'diaphragm' || nmLower.includes('intercostal'))) {
        obj.geometry.computeBoundingBox();
        const c = new THREE.Vector3();
        obj.geometry.boundingBox.getCenter(c);
        obj.userData.localCentroid = c;
        obj.userData.origPos = obj.position.clone();
        this.dynamicRespMuscles.push(obj);
      }
    });

    wrapper.add(gltfScene);
    this.bodyRoot.add(wrapper);
    this.organGroups.set(orgMeta.key, wrapper);
  }

  _bindPointerEvents() {
    const dom = this.renderer.domElement;
    dom.addEventListener('pointerdown', (e) => {
      this._downPos = { x: e.clientX, y: e.clientY };
    });

    dom.addEventListener('pointermove', (e) => {
      const rect = dom.getBoundingClientRect();
      this.pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      this.pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
      const hit = this._raycastVisible();
      if (hit) {
        dom.style.cursor = 'pointer';
        this.onHoverMesh({
          x: e.clientX,
          y: e.clientY,
          ...hit.object.userData,
        });
      } else {
        dom.style.cursor = 'grab';
        this.onHoverMesh(null);
      }
    });

    dom.addEventListener('pointerleave', () => {
      this.onHoverMesh(null);
    });

    dom.addEventListener('pointerup', (e) => {
      const dist = Math.hypot(e.clientX - this._downPos.x, e.clientY - this._downPos.y);
      if (dist > 5) return; // orbit drag, not click
      const rect = dom.getBoundingClientRect();
      this.pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      this.pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
      const hit = this._raycastVisible();
      if (hit) {
        const ud = hit.object.userData;
        this.selectStructure(ud.ontologyId, ud.nodeName, true);
        this.onSelectMesh(ud);
      }
    });
  }

  _raycastVisible() {
    if (!this.pickableMeshes.length) return null;
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const candidates = this.pickableMeshes.filter(m => this._isMeshEffectivelyVisible(m) && m.material.opacity > 0.14);
    const hits = this.raycaster.intersectObjects(candidates, false);
    if (!hits.length) return null;
    if (this.clipAxis !== 'off') {
      const valid = hits.find(h => this.clipPlane.distanceToPoint(h.point) >= -0.001);
      return valid || null;
    }
    return hits[0];
  }

  _isMeshEffectivelyVisible(mesh) {
    let cur = mesh;
    while (cur) {
      if (!cur.visible) return false;
      cur = cur.parent;
    }
    return true;
  }

  setLayerVisible(layerName, visible) {
    this.layers[layerName] = Boolean(visible);
    this.updateVisibilityAndHighlighting();
  }

  setSystemFilter(sysId) {
    this.activeSystemFilter = sysId || 'WHOLE_BODY';
    this.updateVisibilityAndHighlighting();
    if (sysId && sysId !== 'WHOLE_BODY') {
      this.flyToSystem(sysId);
    } else {
      this.flyToPreset('whole_body');
    }
  }

  setExplodeFactor(val) {
    this.explodeFactor = Math.max(0, Math.min(1, Number(val) || 0));
    for (const grp of this.organGroups.values()) {
      const ud = grp.userData;
      if (ud.layer === 'skin') {
        grp.position.set(0, 0, 0);
        continue;
      }
      const c = ud.baseCenter.clone();
      // Museum-grade lateral system separation + visceral radial expansion
      const radial = new THREE.Vector3(c.x * 1.9, (c.y - 0.30) * 0.40, c.z * 2.0);
      if (ud.layer === 'vasculature') radial.set(-0.52, 0, -0.06);
      else if (ud.layer === 'skeleton') radial.set(0.52, 0, -0.08);
      else if (ud.layer === 'musculature') radial.set(1.04, 0, -0.08);
      grp.position.copy(radial.multiplyScalar(this.explodeFactor));
    }
  }

  setClipping(axis, normalizedOffset = 0.0) {
    this.clipAxis = axis;
    this.clipOffset = Number(normalizedOffset) || 0.0;
    if (axis === 'x') {
      this.clipPlane.set(new THREE.Vector3(-1, 0, 0), this.clipOffset * 0.45);
    } else if (axis === 'y') {
      this.clipPlane.set(new THREE.Vector3(0, -1, 0), 0.25 + this.clipOffset * 0.75);
    } else if (axis === 'z') {
      this.clipPlane.set(new THREE.Vector3(0, 0, -1), this.clipOffset * 0.22);
    }
    const planes = axis === 'off' ? [] : [this.clipPlane];
    this.bodyRoot.traverse((obj) => {
      if (obj.isMesh && obj.material) {
        obj.material.clippingPlanes = planes;
        obj.material.needsUpdate = true;
      }
    });
  }

  selectStructure(ontologyId, specificNodeName = null, fly = true) {
    this.selectedOntologyId = ontologyId;
    this.selectedNodeName = specificNodeName;
    this.updateVisibilityAndHighlighting();
    if (fly && ontologyId) {
      this.flyToOntology(ontologyId, specificNodeName);
    }
  }

  updateVisibilityAndHighlighting() {
    const sysFilter = this.activeSystemFilter;
    const selOnt = this.selectedOntologyId;
    const selNode = this.selectedNodeName;

    for (const grp of this.organGroups.values()) {
      const layerOn = this.layers[grp.userData.layer] !== false;
      grp.visible = layerOn;
    }

    this.bodyRoot.traverse((obj) => {
      if (!obj.isMesh || !obj.userData.organKey) return;
      const ud = obj.userData;
      const mat = obj.material;

      if (ud.isSkinLike) {
        mat.opacity = sysFilter === 'WHOLE_BODY' ? ud.baseOpacity : ud.baseOpacity * 0.45;
        mat.emissive.setHex(0x000000);
        return;
      }

      const inActiveSystem = (sysFilter === 'WHOLE_BODY') || (ud.organSystemId === sysFilter);
      const isOntMatch = Boolean(selOnt && ud.ontologyId === selOnt);
      const isExactNode = Boolean(isOntMatch && (!selNode || ud.nodeName === selNode));

      if (isExactNode) {
        mat.transparent = false;
        mat.opacity = 1.0;
        mat.depthWrite = true;
        mat.emissive.setHex(0x6e1f0e);
        mat.emissiveIntensity = 0.62;
      } else if (isOntMatch) {
        mat.transparent = false;
        mat.opacity = 0.92;
        mat.depthWrite = true;
        mat.emissive.setHex(0x2e0d05);
        mat.emissiveIntensity = 0.25;
      } else if (!inActiveSystem) {
        mat.transparent = true;
        mat.opacity = 0.08;
        mat.depthWrite = false;
        mat.emissive.setHex(0x000000);
        mat.emissiveIntensity = 0.0;
      } else if (selOnt) {
        // Keep sibling structures clearly visible for anatomical context
        const isFrameLayer = ud.layer === 'skeleton' || ud.layer === 'musculature';
        mat.transparent = true;
        mat.opacity = ud.organSystemId === sysFilter ? 0.72 : (isFrameLayer ? 0.46 : 0.42);
        mat.depthWrite = true;
        mat.emissive.setHex(0x000000);
        mat.emissiveIntensity = 0.0;
      } else {
        mat.transparent = false;
        mat.opacity = 1.0;
        mat.depthWrite = true;
        mat.emissive.setHex(0x000000);
        mat.emissiveIntensity = 0.0;
      }
      ud.baseEmissiveHex = mat.emissive.getHex();
      ud.baseEmissiveIntensity = mat.emissiveIntensity;
    });
  }

  flyToOntology(ontologyId, specificNodeName = null) {
    const meshes = this.meshesByOntology.get(ontologyId) || [];
    if (!meshes.length) return;
    const targetMeshes = specificNodeName
      ? meshes.filter(m => m.userData.nodeName === specificNodeName)
      : meshes;
    const box = new THREE.Box3();
    for (const m of (targetMeshes.length ? targetMeshes : meshes)) {
      box.expandByObject(m);
    }
    if (box.isEmpty()) return;
    const center = new THREE.Vector3();
    const size = new THREE.Vector3();
    box.getCenter(center);
    box.getSize(size);
    const radius = Math.max(0.045, size.length() * 0.5);
    const dist = Math.min(2.6, Math.max(0.22, radius * 2.75));
    const offsetDir = new THREE.Vector3(0.28, 0.16, 0.94).normalize();
    this._startCameraTween(center.clone().addScaledVector(offsetDir, dist), center);
  }

  flyToSystem(sysId) {
    const box = new THREE.Box3();
    let count = 0;
    for (const grp of this.organGroups.values()) {
      if (grp.userData.organSystemId === sysId && grp.userData.layer !== 'skin') {
        box.expandByObject(grp);
        count++;
      }
    }
    if (!count || box.isEmpty()) return;
    const center = new THREE.Vector3();
    const size = new THREE.Vector3();
    box.getCenter(center);
    box.getSize(size);
    const dist = Math.min(2.7, Math.max(0.32, size.length() * 1.25));
    this._startCameraTween(center.clone().add(new THREE.Vector3(0.22 * dist, 0.12 * dist, dist)), center);
  }

  flyToPreset(preset) {
    const presets = {
      whole_body: { pos: new THREE.Vector3(0.0, 0.06, 2.62), tgt: new THREE.Vector3(0.0, 0.01, 0.0) },
      thorax:     { pos: new THREE.Vector3(0.14, 0.48, 0.72), tgt: new THREE.Vector3(0.0, 0.46, 0.0) },
      heart:      { pos: new THREE.Vector3(0.08, 0.50, 0.34), tgt: new THREE.Vector3(0.02, 0.47, 0.03) },
      head:       { pos: new THREE.Vector3(0.16, 0.81, 0.48), tgt: new THREE.Vector3(0.0, 0.79, 0.0) },
      abdomen:    { pos: new THREE.Vector3(0.10, 0.22, 0.72), tgt: new THREE.Vector3(0.0, 0.20, 0.0) },
      knees:      { pos: new THREE.Vector3(0.18, -0.28, 1.15), tgt: new THREE.Vector3(0.0, -0.34, -0.02) },
    };
    const p = presets[preset] || presets.whole_body;
    this._startCameraTween(p.pos, p.tgt);
  }

  _startCameraTween(destPos, destTarget) {
    this._camTween = {
      t0: performance.now(),
      dur: 680,
      startPos: this.camera.position.clone(),
      endPos: destPos.clone(),
      startTgt: this.controls.target.clone(),
      endTgt: destTarget.clone(),
    };
  }

  // Update 3D organ biomechanics synchronized to live ODE ventricular & alveolar volumes!
  updateBiomechanicsAndRender(odeSnapshot) {
    if (this._camTween) {
      const u = Math.min(1.0, (performance.now() - this._camTween.t0) / this._camTween.dur);
      const ease = 1.0 - Math.pow(1.0 - u, 3);
      this.camera.position.lerpVectors(this._camTween.startPos, this._camTween.endPos, ease);
      this.controls.target.lerpVectors(this._camTween.startTgt, this._camTween.endTgt, ease);
      if (u >= 1.0) this._camTween = null;
    }

    if (odeSnapshot) {
      // Ventricular volumetric contraction around local mesh centroid: s = (V_LV / 115)^(1/3)
      const vRatio = Math.max(0.84, Math.min(1.08, Math.cbrt((odeSnapshot.vLv || 110) / 115.0)));
      // Atrial contraction out-of-phase (peaks just before QRS)
      const phi = odeSnapshot.cyclePhi || 0;
      const aRatio = phi > 0.86 ? 1.0 - 0.08 * Math.sin(((phi - 0.86) / 0.14) * Math.PI) : 1.0 + 0.03 * Math.sin(phi * Math.PI);

      const applyCentroidScale = (mesh, s) => {
        const c = mesh.userData.localCentroid;
        const orig = mesh.userData.origPos;
        if (!c || !orig) return;
        mesh.scale.setScalar(s);
        mesh.position.set(
          orig.x + c.x * (1.0 - s),
          orig.y + c.y * (1.0 - s),
          orig.z + c.z * (1.0 - s)
        );
      };

      for (const m of this.dynamicCardiac.lv) {
        applyCentroidScale(m, vRatio);
        // Phase-locked transmural repolarization highlight during inverted T-wave window (phi in [0.16, 0.40])
        if (m !== this.hoveredMesh) {
          const inRepol = odeSnapshot.tWaveInverted && phi >= 0.16 && phi <= 0.40;
          if (inRepol) {
            const pulse = Math.sin(((phi - 0.16) / 0.24) * Math.PI);
            m.material.emissive.setHex(0x8c2414);
            m.material.emissiveIntensity = Math.max(m.userData.baseEmissiveIntensity || 0, 0.42 * pulse);
          } else {
            m.material.emissive.setHex(m.userData.baseEmissiveHex ?? 0x000000);
            m.material.emissiveIntensity = m.userData.baseEmissiveIntensity ?? 0.0;
          }
        }
      }
      for (const m of this.dynamicCardiac.rv) applyCentroidScale(m, 1.0 + (vRatio - 1.0) * 0.85);
      for (const m of this.dynamicCardiac.la) applyCentroidScale(m, aRatio);
      for (const m of this.dynamicCardiac.ra) applyCentroidScale(m, aRatio);

      // Pulmonary tidal expansion (0..600 mL -> subtle realistic 3.5% ribcage/parenchymal excursion)
      const lungScale = 1.0 + Math.min(0.045, Math.max(0.0, (odeSnapshot.vAlv || 0) / 14000.0));
      for (const m of this.dynamicLungs) applyCentroidScale(m, lungScale);
      const respMuscScale = 1.0 + Math.min(0.022, Math.max(0.0, (odeSnapshot.vAlv || 0) / 28000.0));
      for (const m of this.dynamicRespMuscles) applyCentroidScale(m, respMuscScale);
    }

    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  }
}
