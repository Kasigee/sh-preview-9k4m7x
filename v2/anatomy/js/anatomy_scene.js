// ============================================================================
// Genesis Foundation Labs — Real-Time 3D Musculoskeletal Articulation Engine
// ============================================================================
// Loads authentic BodyParts3D (BP3D) 242-bone skeleton + 177-muscle .glb models,
// rigs live anatomical joint hinges, renders Origin (O) -> Insertion (I) pull
// vectors with moving insertion anchors, and supports branded PNG card export.
// ============================================================================

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

export class AnatomyScene {
  constructor(container, callbacks = {}) {
    this.container = container;
    this.onHover = callbacks.onHover || (() => {});
    this.onSelect = callbacks.onSelect || (() => {});
    this.onReady = callbacks.onReady || (() => {});
    this.onProgress = callbacks.onProgress || (() => {});

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(35, 1, 0.01, 20);
    this.camera.position.set(-0.88, 0.36, 0.42);

    this.renderer = new THREE.WebGLRenderer({
      antialias: true,
      powerPreference: 'high-performance',
      preserveDrawingBuffer: true, // Enables instant 1-click branded PNG card export
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.localClippingEnabled = true;
    this.container.appendChild(this.renderer.domElement);

    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    pmrem.dispose();

    const hemi = new THREE.HemisphereLight(0xfffdf9, 0x30363c, 0.92);
    const key = new THREE.DirectionalLight(0xfffcf5, 1.45);
    key.position.set(1.6, 2.3, 2.5);
    const rim = new THREE.DirectionalLight(0xcbe8e4, 0.72);
    rim.position.set(-2.0, 0.9, -1.8);
    this.scene.add(hemi, key, rim);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.minDistance = 0.14;
    this.controls.maxDistance = 4.2;

    this.root = new THREE.Group();
    this.scene.add(this.root);

    this.skeletonGroup = new THREE.Group();
    this.musclesGroup = new THREE.Group();
    this.pivotGroup = new THREE.Group();
    this.overlayGroup = new THREE.Group();
    this.root.add(this.skeletonGroup, this.musclesGroup, this.pivotGroup, this.overlayGroup);

    // Subtle floor reference disc at soles (Y = -0.915 m)
    this.floorDisc = new THREE.Mesh(
      new THREE.RingGeometry(0.24, 0.246, 64),
      new THREE.MeshBasicMaterial({ color: 0x8b959a, side: THREE.DoubleSide, transparent: true, opacity: 0.3 })
    );
    this.floorDisc.rotation.x = -Math.PI / 2;
    this.floorDisc.position.y = -0.915;
    this.scene.add(this.floorDisc);

    // Registries
    this.boneNodes = new Map();      // name -> { obj, origParent, origPos, origQuat, origScale, meshes }
    this.muscleNodes = new Map();    // name -> { obj, meshes, center }
    this.pickables = [];
    this.allBoneNames = [];
    this.allMuscleNames = [];

    // Clipping plane that keeps anatomical right side (x <= +0.015) for clean unilateral teaching
    this.rightSidePlane = new THREE.Plane(new THREE.Vector3(-1, 0, 0), 0.018);

    // Active movement & view options
    this.activeMove = null;
    this.contraction = 0.0; // 0..1
    this.options = {
      showAntagonists: true,
      showAllMusclesGhost: false,
      showVectors: true,
      unilateralFocus: true,
      isolatedHighlight: null, // Optional single bone/muscle highlight from directory
    };

    // Dynamic overlay primitives (Origin pin, Insertion pin, Joint ring, Pull line, Force beads)
    this._buildOverlayPrimitives();

    // Camera animation tween
    this._camTween = null;

    // Pointer hover/pick
    this.raycaster = new THREE.Raycaster();
    this.pointer = new THREE.Vector2();
    this._downXY = { x: 0, y: 0 };
    this._bindPointer();

    this.applyTheme();
    this.resize();
    window.addEventListener('resize', () => this.resize());
    if (typeof ResizeObserver !== 'undefined') {
      this._ro = new ResizeObserver(() => this.resize());
      this._ro.observe(this.container);
    }
  }

  _buildOverlayPrimitives() {
    const pinGeo = new THREE.SphereGeometry(0.012, 20, 20);
    this.originPin = new THREE.Mesh(
      pinGeo,
      new THREE.MeshStandardMaterial({ color: 0xe69f22, emissive: 0xb87409, emissiveIntensity: 0.65, roughness: 0.25 })
    );
    this.insertionPin = new THREE.Mesh(
      pinGeo,
      new THREE.MeshStandardMaterial({ color: 0xe03e36, emissive: 0xa61d17, emissiveIntensity: 0.75, roughness: 0.25 })
    );
    this.pulleyPin = new THREE.Mesh(
      new THREE.SphereGeometry(0.009, 16, 16),
      new THREE.MeshStandardMaterial({ color: 0x18a999, emissive: 0x0c7368, emissiveIntensity: 0.6, roughness: 0.3 })
    );

    // Fulcrum ring at joint center
    this.fulcrumRing = new THREE.Mesh(
      new THREE.TorusGeometry(0.044, 0.0032, 12, 48),
      new THREE.MeshStandardMaterial({
        color: 0x18a999,
        emissive: 0x118578,
        emissiveIntensity: 0.55,
        transparent: true,
        opacity: 0.85,
        roughness: 0.25,
      })
    );
    this.fulcrumDot = new THREE.Mesh(
      new THREE.SphereGeometry(0.0085, 16, 16),
      new THREE.MeshStandardMaterial({ color: 0x18a999, emissive: 0x18a999, emissiveIntensity: 0.8 })
    );

    // Dynamic tendon/force line (updated each frame as insertion moves)
    this.pullLineGeo = new THREE.BufferGeometry();
    this.pullLineGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(9), 3));
    this.pullLine = new THREE.Line(
      this.pullLineGeo,
      new THREE.LineBasicMaterial({ color: 0xff5a4e, transparent: true, opacity: 0.92 })
    );

    // Animated force beads sliding from Insertion -> Origin along line of pull
    this.forceBeads = [];
    const beadGeo = new THREE.SphereGeometry(0.0062, 12, 12);
    const beadMat = new THREE.MeshBasicMaterial({ color: 0xffe066 });
    for (let i = 0; i < 6; i++) {
      const m = new THREE.Mesh(beadGeo, beadMat);
      this.forceBeads.push(m);
      this.overlayGroup.add(m);
    }

    this.overlayGroup.add(this.originPin, this.pulleyPin, this.fulcrumRing, this.fulcrumDot, this.pullLine);
    // Insertion pin sits inside pivotGroup so it rotates directly with the distal moving bone!
    this.pivotGroup.add(this.insertionPin);
    this.overlayGroup.visible = false;
    this.insertionPin.visible = false;
  }

  applyTheme() {
    const meta = document.querySelector('meta[name="color-scheme"]');
    const content = meta ? meta.content.trim() : 'light dark';
    const isDark = content === 'dark' ||
      (content === 'light dark' && window.matchMedia('(prefers-color-scheme: dark)').matches);
    this.scene.background = new THREE.Color(isDark ? 0x101418 : 0xf4f6f4);
    if (this.floorDisc && this.floorDisc.material) {
      this.floorDisc.material.color.setHex(isDark ? 0x3b4852 : 0x9aa4a0);
    }
  }

  resize() {
    const w = Math.max(240, this.container.clientWidth || 720);
    const h = Math.max(220, this.container.clientHeight || 480);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
  }

  async loadModels(baseAssetsUrl = '../assets/models/hra/') {
    const loader = new GLTFLoader();
    const loadGlb = (url, label) => new Promise((resolve, reject) => {
      loader.load(
        url,
        (gltf) => resolve(gltf.scene),
        (ev) => {
          if (ev.total > 0) this.onProgress(label, Math.round((ev.loaded / ev.total) * 100));
        },
        reject
      );
    });

    this.onProgress('Skeleton (242 bones)', 5);
    const [skelScene, muscScene] = await Promise.all([
      loadGlb(`${baseAssetsUrl}bp3d-vh-m-skeleton-full.glb`, 'Skeleton'),
      loadGlb(`${baseAssetsUrl}bp3d-vh-m-muscles-full.glb`, 'Muscles'),
    ]);

    this._indexBones(skelScene);
    this._indexMuscles(muscScene);

    this.skeletonGroup.add(skelScene);
    this.musclesGroup.add(muscScene);
    this.onReady({
      boneCount: this.allBoneNames.length,
      muscleCount: this.allMuscleNames.length,
    });
  }

  _indexBones(sceneObj) {
    const byName = new Map();
    sceneObj.traverse((obj) => {
      if (!obj.isMesh) return;
      const nm = obj.name || (obj.parent && obj.parent.name) || 'bone';
      obj.material = new THREE.MeshPhysicalMaterial({
        color: 0xe6e0d2,
        roughness: 0.56,
        metalness: 0.02,
        clearcoat: 0.08,
        transparent: false,
        opacity: 1.0,
      });
      obj.userData = { kind: 'bone', name: nm };
      this.pickables.push(obj);

      // Attach to direct mesh node (in BP3D GLB every bone is a direct child node)
      const targetNode = obj.parent && obj.parent !== sceneObj && obj.parent.name === nm ? obj.parent : obj;
      if (!byName.has(nm)) {
        byName.set(nm, {
          name: nm,
          obj: targetNode,
          origParent: targetNode.parent,
          origPos: targetNode.position.clone(),
          origQuat: targetNode.quaternion.clone(),
          origScale: targetNode.scale.clone(),
          meshes: [],
        });
      }
      byName.get(nm).meshes.push(obj);
    });
    this.boneNodes = byName;
    this.allBoneNames = [...byName.keys()].sort();
  }

  _indexMuscles(sceneObj) {
    const byName = new Map();
    sceneObj.traverse((obj) => {
      if (!obj.isMesh) return;
      const nm = obj.name || (obj.parent && obj.parent.name) || 'muscle';
      obj.material = new THREE.MeshPhysicalMaterial({
        color: 0xb6453c,
        roughness: 0.44,
        metalness: 0.02,
        clearcoat: 0.24,
        transparent: true,
        opacity: 0.94,
        side: THREE.DoubleSide,
      });
      obj.userData = { kind: 'muscle', name: nm };
      this.pickables.push(obj);
      if (!byName.has(nm)) {
        byName.set(nm, { name: nm, obj, meshes: [], center: new THREE.Vector3() });
      }
      byName.get(nm).meshes.push(obj);
    });
    for (const entry of byName.values()) {
      const box = new THREE.Box3();
      for (const m of entry.meshes) box.expandByObject(m);
      box.getCenter(entry.center);
    }
    this.muscleNodes = byName;
    this.allMuscleNames = [...byName.keys()].sort();
  }

  _restoreAllBonesToRest() {
    this.pivotGroup.quaternion.identity();
    this.pivotGroup.position.set(0, 0, 0);
    for (const rec of this.boneNodes.values()) {
      if (rec.obj.parent !== rec.origParent && rec.origParent) {
        rec.origParent.add(rec.obj);
      }
      rec.obj.position.copy(rec.origPos);
      rec.obj.quaternion.copy(rec.origQuat);
      rec.obj.scale.copy(rec.origScale);
    }
  }

  setMovement(move, flyCamera = true) {
    this._restoreAllBonesToRest();
    this.activeMove = move;
    this.options.isolatedHighlight = null;

    if (!move) return;

    // Position pivot group at exact anatomical joint center & attach moving distal bones
    const pivotVec = new THREE.Vector3(...move.pivot);
    this.pivotGroup.position.copy(pivotVec);
    this.pivotGroup.quaternion.identity();

    const movingSet = new Set(move.movingBones || []);
    for (const bName of movingSet) {
      const rec = this.boneNodes.get(bName);
      if (!rec) continue;
      this.pivotGroup.add(rec.obj);
      rec.obj.position.copy(rec.origPos).sub(pivotVec);
    }

    // Configure overlay pins & joint fulcrum ring
    this.originPin.position.set(...move.originPos);
    const insWorld = new THREE.Vector3(...move.insertionPos);
    this.insertionPin.position.copy(insWorld).sub(pivotVec);

    if (move.pulleyPos) {
      this.pulleyPin.position.set(...move.pulleyPos);
      this.pulleyPin.visible = true;
    } else {
      this.pulleyPin.visible = false;
    }

    this.fulcrumRing.position.copy(pivotVec);
    this.fulcrumDot.position.copy(pivotVec);
    const ax = new THREE.Vector3(...move.axis).normalize();
    const ringQuat = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), ax);
    this.fulcrumRing.quaternion.copy(ringQuat);

    this.applyVisualStyling();
    this.setContraction(0.0);

    if (flyCamera && move.camPos && move.camTarget) {
      this.flyTo(new THREE.Vector3(...move.camPos), new THREE.Vector3(...move.camTarget));
    }
  }

  setOptions(partial) {
    Object.assign(this.options, partial);
    this.applyVisualStyling();
    this._updateVectorOverlay(performance.now() * 0.001);
  }

  focusSingleStructure(kind, name) {
    this._restoreAllBonesToRest();
    this.options.isolatedHighlight = { kind, name };
    this.overlayGroup.visible = false;
    this.insertionPin.visible = false;
    this.applyVisualStyling();

    const rec = kind === 'bone' ? this.boneNodes.get(name) : this.muscleNodes.get(name);
    if (!rec) return;
    const box = new THREE.Box3();
    for (const m of rec.meshes) box.expandByObject(m);
    const center = new THREE.Vector3();
    const size = new THREE.Vector3();
    box.getCenter(center);
    box.getSize(size);
    const dist = Math.max(0.45, Math.min(1.8, size.length() * 2.1));
    const camPos = center.clone().add(new THREE.Vector3(center.x < 0 ? -dist * 0.55 : dist * 0.55, dist * 0.18, dist * 0.85));
    this.flyTo(camPos, center);
  }

  applyVisualStyling() {
    const move = this.activeMove;
    const iso = this.options.isolatedHighlight;

    if (iso) {
      for (const [bName, rec] of this.boneNodes.entries()) {
        const isHit = iso.kind === 'bone' && iso.name === bName;
        for (const m of rec.meshes) {
          m.visible = true;
          m.material.color.setHex(isHit ? 0x18a999 : 0xe4dfd3);
          m.material.emissive.setHex(isHit ? 0x0c6358 : 0x000000);
          m.material.emissiveIntensity = isHit ? 0.45 : 0;
          m.material.transparent = !isHit;
          m.material.opacity = isHit ? 1.0 : 0.34;
          m.material.clippingPlanes = [];
        }
      }
      for (const [mName, rec] of this.muscleNodes.entries()) {
        const isHit = iso.kind === 'muscle' && iso.name === mName;
        for (const m of rec.meshes) {
          m.visible = isHit || this.options.showAllMusclesGhost;
          m.material.color.setHex(isHit ? 0xd94538 : 0x996560);
          m.material.emissive.setHex(isHit ? 0x7c1d16 : 0x000000);
          m.material.emissiveIntensity = isHit ? 0.42 : 0;
          m.material.opacity = isHit ? 0.96 : 0.14;
          m.material.clippingPlanes = [];
          m.scale.set(1, 1, 1);
        }
      }
      return;
    }

    if (!move) return;
    const agSet = new Set(move.agonists || []);
    const antSet = new Set(move.antagonists || []);
    const anchorSet = new Set(move.anchorBones || []);
    const movingSet = new Set(move.movingBones || []);
    const clipArr = (this.options.unilateralFocus && move.side === 'right') ? [this.rightSidePlane] : [];

    // Bones: warm ivory for anchor & moving bones, subtle muted ivory for rest of skeleton
    for (const [bName, rec] of this.boneNodes.entries()) {
      const isMoving = movingSet.has(bName);
      const isAnchor = anchorSet.has(bName);
      for (const m of rec.meshes) {
        m.visible = true;
        if (isMoving) {
          m.material.color.setHex(0xf3ede0);
          m.material.emissive.setHex(0x164a44);
          m.material.emissiveIntensity = 0.12;
          m.material.transparent = false;
          m.material.opacity = 1.0;
        } else if (isAnchor) {
          m.material.color.setHex(0xe8e2d4);
          m.material.emissive.setHex(0x000000);
          m.material.emissiveIntensity = 0;
          m.material.transparent = false;
          m.material.opacity = 1.0;
        } else {
          m.material.color.setHex(0xd8d2c6);
          m.material.emissive.setHex(0x000000);
          m.material.emissiveIntensity = 0;
          m.material.transparent = true;
          m.material.opacity = 0.28;
        }
      }
    }

    // Muscles: Agonist (vivid coral-crimson), Antagonist (Genesis teal), others hidden or ghosted
    for (const [mName, rec] of this.muscleNodes.entries()) {
      const isAg = agSet.has(mName);
      const isAnt = antSet.has(mName);
      for (const m of rec.meshes) {
        m.scale.set(1, 1, 1);
        if (isAg) {
          m.visible = true;
          m.material.color.setHex(mName.includes('tendon') ? 0xe7dfc8 : 0xd6453a);
          m.material.emissive.setHex(mName.includes('tendon') ? 0x6b6043 : 0x7a1a14);
          m.material.emissiveIntensity = 0.22;
          m.material.opacity = 0.94;
          m.material.clippingPlanes = clipArr;
        } else if (isAnt && this.options.showAntagonists) {
          m.visible = true;
          m.material.color.setHex(0x18a999);
          m.material.emissive.setHex(0x0a5a52);
          m.material.emissiveIntensity = 0.2;
          m.material.opacity = 0.42;
          m.material.clippingPlanes = clipArr;
        } else if (this.options.showAllMusclesGhost) {
          m.visible = true;
          m.material.color.setHex(0xa86b66);
          m.material.emissive.setHex(0x000000);
          m.material.emissiveIntensity = 0;
          m.material.opacity = 0.11;
          m.material.clippingPlanes = [];
        } else {
          m.visible = false;
        }
      }
    }

    this.overlayGroup.visible = this.options.showVectors;
    this.insertionPin.visible = this.options.showVectors;
  }

  setContraction(u) {
    this.contraction = Math.max(0, Math.min(1, u));
    const move = this.activeMove;
    if (!move || this.options.isolatedHighlight) return;

    // 1. Articulate moving distal bones around joint fulcrum
    const deg = move.angleStartDeg + (move.angleEndDeg - move.angleStartDeg) * this.contraction;
    const rad = THREE.MathUtils.degToRad(deg);
    const ax = new THREE.Vector3(...move.axis).normalize();
    this.pivotGroup.setRotationFromAxisAngle(ax, rad);

    // 2. Pulse agonist emissive recruitment & subtle radial belly thickening
    const agSet = new Set(move.agonists || []);
    const antSet = new Set(move.antagonists || []);
    for (const mName of agSet) {
      const rec = this.muscleNodes.get(mName);
      if (!rec) continue;
      for (const m of rec.meshes) {
        if (!mName.includes('tendon')) {
          m.material.emissiveIntensity = 0.16 + 0.52 * this.contraction;
          // Subtle lateral contractile bulge
          const bulge = 1 + 0.032 * this.contraction;
          m.scale.set(bulge, 1 - 0.012 * this.contraction, bulge);
        }
      }
    }
    for (const mName of antSet) {
      const rec = this.muscleNodes.get(mName);
      if (!rec) continue;
      for (const m of rec.meshes) {
        m.material.opacity = 0.48 - 0.20 * this.contraction;
      }
    }

    this._updateVectorOverlay(performance.now() * 0.001);
  }

  _updateVectorOverlay(timeSec) {
    const move = this.activeMove;
    if (!move || !this.options.showVectors || this.options.isolatedHighlight) return;

    this.pivotGroup.updateMatrixWorld(true);
    const pOrigin = this.originPin.position;
    const pInsWorld = new THREE.Vector3();
    this.insertionPin.getWorldPosition(pInsWorld);

    const posAttr = this.pullLineGeo.getAttribute('position');
    if (move.pulleyPos) {
      const pPulley = this.pulleyPin.position;
      posAttr.setXYZ(0, pOrigin.x, pOrigin.y, pOrigin.z);
      posAttr.setXYZ(1, pPulley.x, pPulley.y, pPulley.z);
      posAttr.setXYZ(2, pInsWorld.x, pInsWorld.y, pInsWorld.z);
      this.pullLineGeo.setDrawRange(0, 3);
    } else {
      posAttr.setXYZ(0, pOrigin.x, pOrigin.y, pOrigin.z);
      posAttr.setXYZ(1, pInsWorld.x, pInsWorld.y, pInsWorld.z);
      this.pullLineGeo.setDrawRange(0, 2);
    }
    posAttr.needsUpdate = true;

    // Move force-vector beads from Insertion -> Origin showing active concentric pull direction
    const speed = 0.55 + this.contraction * 0.9;
    for (let i = 0; i < this.forceBeads.length; i++) {
      const t = ((timeSec * speed + i / this.forceBeads.length) % 1);
      if (move.pulleyPos) {
        const pPulley = this.pulleyPin.position;
        if (t < 0.35) {
          this.forceBeads[i].position.lerpVectors(pInsWorld, pPulley, t / 0.35);
        } else {
          this.forceBeads[i].position.lerpVectors(pPulley, pOrigin, (t - 0.35) / 0.65);
        }
      } else {
        this.forceBeads[i].position.lerpVectors(pInsWorld, pOrigin, t);
      }
    }
  }

  flyTo(targetCamPos, targetLookAt) {
    this._camTween = {
      startPos: this.camera.position.clone(),
      endPos: targetCamPos.clone(),
      startTarget: this.controls.target.clone(),
      endTarget: targetLookAt.clone(),
      t: 0,
      dur: 0.65,
    };
  }

  resetCamera() {
    if (this.activeMove) {
      this.flyTo(new THREE.Vector3(...this.activeMove.camPos), new THREE.Vector3(...this.activeMove.camTarget));
    } else {
      this.flyTo(new THREE.Vector3(0, 0.15, 2.35), new THREE.Vector3(0, 0.05, 0));
    }
  }

  _bindPointer() {
    const dom = this.renderer.domElement;
    dom.addEventListener('pointerdown', (e) => {
      this._downXY = { x: e.clientX, y: e.clientY };
      this._camTween = null;
    });
    dom.addEventListener('pointermove', (e) => {
      const rect = dom.getBoundingClientRect();
      this.pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      this.pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
      this.raycaster.setFromCamera(this.pointer, this.camera);
      const visiblePicks = this.pickables.filter(m => m.visible && m.material.opacity > 0.22);
      const hits = this.raycaster.intersectObjects(visiblePicks, false);
      if (hits.length) {
        const u = hits[0].object.userData;
        dom.style.cursor = 'pointer';
        this.onHover({ kind: u.kind, name: u.name, x: e.clientX - rect.left, y: e.clientY - rect.top });
      } else {
        dom.style.cursor = 'grab';
        this.onHover(null);
      }
    });
    dom.addEventListener('pointerleave', () => this.onHover(null));
    dom.addEventListener('pointerup', (e) => {
      if (Math.hypot(e.clientX - this._downXY.x, e.clientY - this._downXY.y) > 5) return;
      const rect = dom.getBoundingClientRect();
      this.pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      this.pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
      this.raycaster.setFromCamera(this.pointer, this.camera);
      const visiblePicks = this.pickables.filter(m => m.visible && m.material.opacity > 0.22);
      const hits = this.raycaster.intersectObjects(visiblePicks, false);
      if (hits.length) {
        const u = hits[0].object.userData;
        this.onSelect({ kind: u.kind, name: u.name });
      }
    });
  }

  renderFrame(dtSec, nowSec) {
    if (this._camTween) {
      this._camTween.t = Math.min(1, this._camTween.t + dtSec / this._camTween.dur);
      const s = 1 - Math.pow(1 - this._camTween.t, 3);
      this.camera.position.lerpVectors(this._camTween.startPos, this._camTween.endPos, s);
      this.controls.target.lerpVectors(this._camTween.startTarget, this._camTween.endTarget, s);
      if (this._camTween.t >= 1) this._camTween = null;
    }
    this._updateVectorOverlay(nowSec);
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  }

  captureCanvasDataUrl() {
    this.renderer.render(this.scene, this.camera);
    return this.renderer.domElement.toDataURL('image/png');
  }
}
