// ============================================================================
// Genesis Foundation Labs — Real-Time 3D Musculoskeletal Skinning & Bulge Engine
// ============================================================================
// Loads authentic BodyParts3D (BP3D) 242-bone skeleton + 177-muscle .glb models
// and performs real-time 60 fps vertex-level anatomical muscle deformation:
//   - Two-Anchor Quadratic Bezier + Pulley-Wrapped Skinning (Origin locked,
//     Insertion rigidly tracks the rotating distal bone!)
//   - Constant-Volume Poisson Belly Bulge & Superficial Lift on Agonists,
//     plus Visible Elongation & Narrowing on Antagonists
//   - Rigid Distal-Limb Rider Skinning for zero floating ghost muscles
//   - Live PBR normal recomputation & Dynamic Activation Color Modulation
// ============================================================================

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

// Pure reusable scratch vectors/quaternions (zero GC churn per frame!)
const _vA = new THREE.Vector3();
const _vB = new THREE.Vector3();
const _vC = new THREE.Vector3();
const _vOrig = new THREE.Vector3();
const _vIns0 = new THREE.Vector3();
const _vInsLive = new THREE.Vector3();
const _vD0 = new THREE.Vector3();
const _vT0 = new THREE.Vector3();
const _vMid0 = new THREE.Vector3();
const _vMidLive = new THREE.Vector3();
const _vLift = new THREE.Vector3();
const _vPivot = new THREE.Vector3();
const _vAxis = new THREE.Vector3();
const _vPulley = new THREE.Vector3();
const _vR0 = new THREE.Vector3();
const _vCenter = new THREE.Vector3();
const _vTang = new THREE.Vector3();
const _qRot = new THREE.Quaternion();
const _qStart = new THREE.Quaternion();
const _qHalf = new THREE.Quaternion();
const _qFrame = new THREE.Quaternion();
const _vInsStart = new THREE.Vector3();
const _cRelaxed = new THREE.Color(0xb03a32);
const _cContracted = new THREE.Color(0xf04c38);
const _cTendon = new THREE.Color(0xe7dfc8);
const _cAntagonist = new THREE.Color(0x18a999);
const _cTemp = new THREE.Color();

export class AnatomyScene {
  constructor(container, callbacks = {}) {
    this.container = container;
    this.onHover = callbacks.onHover || (() => {});
    this.onSelect = callbacks.onSelect || (() => {});
    this.onReady = callbacks.onReady || (() => {});
    this.onProgress = callbacks.onProgress || (() => {});

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(35, 1, 0.01, 20);
    this.camera.position.set(-0.84, 0.37, 0.40);

    this.renderer = new THREE.WebGLRenderer({
      antialias: true,
      powerPreference: 'high-performance',
      preserveDrawingBuffer: true,
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.06;
    this.renderer.localClippingEnabled = true;
    this.container.appendChild(this.renderer.domElement);

    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    pmrem.dispose();

    const hemi = new THREE.HemisphereLight(0xfffdf9, 0x30363c, 0.94);
    const key = new THREE.DirectionalLight(0xfffcf5, 1.5);
    key.position.set(1.6, 2.3, 2.5);
    const rim = new THREE.DirectionalLight(0xcbe8e4, 0.78);
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

    this.floorDisc = new THREE.Mesh(
      new THREE.RingGeometry(0.24, 0.246, 64),
      new THREE.MeshBasicMaterial({ color: 0x8b959a, side: THREE.DoubleSide, transparent: true, opacity: 0.3 })
    );
    this.floorDisc.rotation.x = -Math.PI / 2;
    this.floorDisc.position.y = -0.915;
    this.scene.add(this.floorDisc);

    // Registries
    this.boneNodes = new Map();
    this.muscleNodes = new Map();
    this.pickables = [];
    this.allBoneNames = [];
    this.allMuscleNames = [];
    this._deformedMuscles = new Set();

    // Clipping plane keeping anatomical right side (x <= +0.015) for clean unilateral teaching
    this.rightSidePlane = new THREE.Plane(new THREE.Vector3(-1, 0, 0), 0.016);

    // Active movement & view options
    this.activeMove = null;
    this._activeMovingBones = new Set();
    this._activeRiderMuscles = new Set();
    this.contraction = 0.0;
    this.lastTelemetry = { agonistStrainPct: 0, agonistBulgePct: 0, antagonistStrainPct: 0 };
    this.options = {
      showAntagonists: true,
      showAllMusclesGhost: false,
      showVectors: true,
      unilateralFocus: true,
      isolatedHighlight: null,
    };

    this._buildOverlayPrimitives();
    this._camTween = null;

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
    const pinGeo = new THREE.SphereGeometry(0.0115, 20, 20);
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

    this.fulcrumRing = new THREE.Mesh(
      new THREE.TorusGeometry(0.042, 0.003, 12, 48),
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
      new THREE.SphereGeometry(0.008, 16, 16),
      new THREE.MeshStandardMaterial({ color: 0x18a999, emissive: 0x18a999, emissiveIntensity: 0.8 })
    );

    this.pullLineGeo = new THREE.BufferGeometry();
    this.pullLineGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(9), 3));
    this.pullLine = new THREE.Line(
      this.pullLineGeo,
      new THREE.LineBasicMaterial({ color: 0xff5a4e, transparent: true, opacity: 0.92 })
    );

    this.forceBeads = [];
    const beadGeo = new THREE.SphereGeometry(0.006, 12, 12);
    const beadMat = new THREE.MeshBasicMaterial({ color: 0xffe066 });
    for (let i = 0; i < 6; i++) {
      const m = new THREE.Mesh(beadGeo, beadMat);
      this.forceBeads.push(m);
      this.overlayGroup.add(m);
    }

    this.overlayGroup.add(this.originPin, this.pulleyPin, this.fulcrumRing, this.fulcrumDot, this.pullLine);
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
          minY: Infinity,
          maxY: -Infinity,
        });
      }
      const rec = byName.get(nm);
      rec.meshes.push(obj);
      obj.geometry.computeBoundingBox();
      if (obj.geometry.boundingBox) {
        rec.minY = Math.min(rec.minY, obj.geometry.boundingBox.min.y);
        rec.maxY = Math.max(rec.maxY, obj.geometry.boundingBox.max.y);
      }
    });
    this.boneNodes = byName;
    this.allBoneNames = [...byName.keys()].sort();
  }

  _indexMuscles(sceneObj) {
    const byName = new Map();
    sceneObj.traverse((obj) => {
      if (!obj.isMesh) return;
      const nm = obj.name || (obj.parent && obj.parent.name) || 'muscle';

      // De-interleave POSITION & NORMAL into clean dedicated Float32Arrays
      // so vertex-level skinning never mutates shared GLB interleaved buffers!
      const geom = obj.geometry.clone();
      const srcPos = geom.attributes.position;
      const count = srcPos.count;
      const posArr = new Float32Array(count * 3);
      for (let i = 0; i < count; i++) {
        posArr[i * 3] = srcPos.getX(i);
        posArr[i * 3 + 1] = srcPos.getY(i);
        posArr[i * 3 + 2] = srcPos.getZ(i);
      }
      const dynPos = new THREE.BufferAttribute(posArr, 3);
      dynPos.setUsage(THREE.DynamicDrawUsage);
      geom.setAttribute('position', dynPos);

      if (geom.attributes.normal) {
        const srcNorm = geom.attributes.normal;
        const normArr = new Float32Array(count * 3);
        for (let i = 0; i < count; i++) {
          normArr[i * 3] = srcNorm.getX(i);
          normArr[i * 3 + 1] = srcNorm.getY(i);
          normArr[i * 3 + 2] = srcNorm.getZ(i);
        }
        const dynNorm = new THREE.BufferAttribute(normArr, 3);
        dynNorm.setUsage(THREE.DynamicDrawUsage);
        geom.setAttribute('normal', dynNorm);
      } else {
        geom.computeVertexNormals();
      }

      obj.geometry = geom;
      obj.frustumCulled = false; // Prevents culling when deformed vertices extend beyond initial bounding sphere
      obj.material = new THREE.MeshPhysicalMaterial({
        color: 0xb6453c,
        roughness: 0.42,
        metalness: 0.02,
        clearcoat: 0.28,
        transparent: true,
        opacity: 0.94,
        side: THREE.DoubleSide,
      });
      obj.userData = {
        kind: 'muscle',
        name: nm,
        origPos: new Float32Array(posArr),
        origNorm: new Float32Array(geom.attributes.normal.array),
      };
      this.pickables.push(obj);

      if (!byName.has(nm)) {
        byName.set(nm, { name: nm, obj, meshes: [], center: new THREE.Vector3(), minY: Infinity, maxY: -Infinity });
      }
      const rec = byName.get(nm);
      rec.meshes.push(obj);
      geom.computeBoundingBox();
      if (geom.boundingBox) {
        rec.minY = Math.min(rec.minY, geom.boundingBox.min.y);
        rec.maxY = Math.max(rec.maxY, geom.boundingBox.max.y);
      }
    });

    for (const entry of byName.values()) {
      const box = new THREE.Box3();
      for (const m of entry.meshes) box.expandByObject(m);
      box.getCenter(entry.center);
    }
    this.muscleNodes = byName;
    this.allMuscleNames = [...byName.keys()].sort();
  }

  _restoreAllRestGeometry() {
    // 1. Restore articulated bones
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

    // 2. Restore exact rest vertices & normals for any previously deformed muscle mesh
    for (const mName of this._deformedMuscles) {
      const rec = this.muscleNodes.get(mName);
      if (!rec) continue;
      for (const mesh of rec.meshes) {
        const posAttr = mesh.geometry.attributes.position;
        const normAttr = mesh.geometry.attributes.normal;
        posAttr.array.set(mesh.userData.origPos);
        normAttr.array.set(mesh.userData.origNorm);
        posAttr.needsUpdate = true;
        normAttr.needsUpdate = true;
      }
    }
    this._deformedMuscles.clear();
  }

  setMovement(move, flyCamera = true) {
    this._restoreAllRestGeometry();
    this.activeMove = move;
    this.options.isolatedHighlight = null;
    this._activeMovingBones.clear();
    this._activeRiderMuscles.clear();

    if (!move) return;

    const pivotVec = new THREE.Vector3(...move.pivot);
    this.pivotGroup.position.copy(pivotVec);
    this.pivotGroup.quaternion.identity();

    // Collect moving distal bones (explicit list + optional Y-threshold for coherent spinal flexion!)
    const movingSet = new Set(move.movingBones || []);
    if (typeof move.movingBonesAboveY === 'number') {
      for (const [bName, rec] of this.boneNodes.entries()) {
        if (rec.minY >= move.movingBonesAboveY) movingSet.add(bName);
      }
    }
    this._activeMovingBones = movingSet;

    for (const bName of movingSet) {
      const rec = this.boneNodes.get(bName);
      if (!rec) continue;
      this.pivotGroup.add(rec.obj);
      rec.obj.position.copy(rec.origPos).sub(pivotVec);
    }

    // Collect distal rider muscles (muscles riding wholly on the moving limb!)
    const rigMap = move.muscleRigs || {};
    const riderSet = new Set(move.riderMuscles || []);
    if (typeof move.riderMusclesAboveY === 'number') {
      for (const [mName, rec] of this.muscleNodes.entries()) {
        if (!rigMap[mName] && rec.minY >= move.riderMusclesAboveY) riderSet.add(mName);
      }
    }
    // Never treat an explicitly rigged bridging muscle as a pure rigid rider
    for (const k of Object.keys(rigMap)) riderSet.delete(k);
    this._activeRiderMuscles = riderSet;

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
    this.setContraction(this.contraction);
    this._updateVectorOverlay(performance.now() * 0.001);
  }

  focusSingleStructure(kind, name) {
    this._restoreAllRestGeometry();
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
        }
      }
      return;
    }

    if (!move) return;
    const agSet = new Set(move.agonists || []);
    const antSet = new Set(move.antagonists || []);
    const anchorSet = new Set(move.anchorBones || []);
    const movingSet = this._activeMovingBones;
    const clipArr = (this.options.unilateralFocus && move.side === 'right') ? [this.rightSidePlane] : [];

    for (const [bName, rec] of this.boneNodes.entries()) {
      const isMoving = movingSet.has(bName);
      const isAnchor = anchorSet.has(bName);
      for (const m of rec.meshes) {
        m.visible = true;
        if (isMoving) {
          m.material.color.setHex(0xf3ede0);
          m.material.emissive.setHex(0x164a44);
          m.material.emissiveIntensity = 0.11;
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

    for (const [mName, rec] of this.muscleNodes.entries()) {
      const isAg = agSet.has(mName);
      const isAnt = antSet.has(mName);
      for (const m of rec.meshes) {
        if (isAg) {
          m.visible = true;
          m.material.color.copy(mName.includes('tendon') ? _cTendon : _cRelaxed);
          m.material.emissive.setHex(mName.includes('tendon') ? 0x6b6043 : 0x7c1a13);
          m.material.emissiveIntensity = 0.18;
          m.material.opacity = 0.96;
          m.material.clippingPlanes = clipArr;
        } else if (isAnt && this.options.showAntagonists) {
          m.visible = true;
          m.material.color.copy(_cAntagonist);
          m.material.emissive.setHex(0x0a5a52);
          m.material.emissiveIntensity = 0.2;
          m.material.opacity = 0.48;
          m.material.clippingPlanes = clipArr;
        } else if (this.options.showAllMusclesGhost) {
          m.visible = true;
          m.material.color.setHex(0xa86b66);
          m.material.emissive.setHex(0x000000);
          m.material.emissiveIntensity = 0;
          m.material.opacity = 0.13;
          m.material.clippingPlanes = clipArr;
        } else {
          m.visible = false;
        }
      }
    }

    this.overlayGroup.visible = this.options.showVectors;
    this.insertionPin.visible = this.options.showVectors;
  }

  // -------------------------------------------------------------------------
  // True Real-Time Vertex-Level Anatomical Muscle Deformation
  // -------------------------------------------------------------------------
  setContraction(u) {
    this.contraction = Math.max(0, Math.min(1, u));
    const move = this.activeMove;
    if (!move || this.options.isolatedHighlight) return this.lastTelemetry;

    // 1. Articulate moving distal bones rigidly around exact anatomical joint fulcrum
    const deg = move.angleStartDeg + (move.angleEndDeg - move.angleStartDeg) * this.contraction;
    const rad = THREE.MathUtils.degToRad(deg);
    const startRad = THREE.MathUtils.degToRad(move.angleStartDeg);
    _vPivot.set(...move.pivot);
    _vAxis.set(...move.axis).normalize();
    _qRot.setFromAxisAngle(_vAxis, rad);
    _qStart.setFromAxisAngle(_vAxis, startRad);
    _qHalf.setFromAxisAngle(_vAxis, rad * 0.5);
    this.pivotGroup.quaternion.copy(_qRot);

    const agSet = new Set(move.agonists || []);
    const antSet = new Set(move.antagonists || []);
    const rigMap = move.muscleRigs || {};
    const onlyRight = move.side === 'right';

    let agStrainSum = 0, agStrainN = 0;
    let agBulgeMax = 0;
    let antStrainSum = 0, antStrainN = 0;

    // 2. Deform every rigged Agonist & Antagonist muscle at vertex level!
    for (const [mName, rig] of Object.entries(rigMap)) {
      const rec = this.muscleNodes.get(mName);
      if (!rec) continue;
      const isAg = agSet.has(mName);
      const isAnt = antSet.has(mName);
      if (!isAg && !(isAnt && this.options.showAntagonists)) continue;

      const uAct = isAg ? this.contraction : -0.22 * this.contraction;
      let stats = { strain: 0, bulgePeak: 0 };

      if (rig.mode === 'stabilizer') {
        stats = this._deformStabilizerMuscle(rec, rig, uAct, onlyRight);
      } else {
        stats = this._deformBridgingMuscle(rec, rig, _vPivot, _qRot, _qHalf, uAct, onlyRight);
      }
      this._deformedMuscles.add(mName);

      if (isAg) {
        agStrainSum += stats.strain;
        agStrainN++;
        agBulgeMax = Math.max(agBulgeMax, stats.bulgePeak);
      } else if (isAnt) {
        antStrainSum += stats.strain;
        antStrainN++;
      }

      // Dynamic activation color & specular sheen shift with recruitment!
      for (const mesh of rec.meshes) {
        if (isAg && !mName.includes('tendon')) {
          _cTemp.copy(_cRelaxed).lerp(_cContracted, this.contraction);
          mesh.material.color.copy(_cTemp);
          mesh.material.emissiveIntensity = 0.14 + 0.44 * this.contraction;
        } else if (isAnt) {
          mesh.material.opacity = 0.54 - 0.14 * this.contraction;
          mesh.material.emissiveIntensity = 0.18 + 0.16 * this.contraction;
        }
      }
    }

    // 3. Rigidly rotate visible distal-limb rider muscles (prevents floating ghost muscles!)
    if (this.options.showAllMusclesGhost) {
      for (const mName of this._activeRiderMuscles) {
        const rec = this.muscleNodes.get(mName);
        if (!rec) continue;
        this._deformRiderMuscle(rec, _vPivot, _qRot, onlyRight);
        this._deformedMuscles.add(mName);
      }
    }

    const agStrainPct = agStrainN ? Math.round((agStrainSum / agStrainN) * 100) : 0;
    const antStrainPct = antStrainN ? Math.round((antStrainSum / antStrainN) * 100) : 0;
    const agBulgePct = Math.round(agBulgeMax * 100);

    this.lastTelemetry = {
      agonistStrainPct: agStrainPct,     // positive = shortening (e.g. +24% shorter -> displayed as -24% length)
      agonistBulgePct: agBulgePct,       // e.g. +28% mid-belly diameter
      antagonistStrainPct: antStrainPct, // negative = lengthening (e.g. -18% -> displayed as +18% stretch)
    };

    this._updateVectorOverlay(performance.now() * 0.001);
    return this.lastTelemetry;
  }

  _deformBridgingMuscle(rec, rig, pivot, qRot, qHalf, uAct, onlyRight) {
    _vOrig.set(...rig.origin);
    _vIns0.set(...rig.insertion);
    _vLift.set(...(rig.liftDir || [0, 0, 1])).normalize();

    // Exact live distal insertion on the articulated bone: J + R(theta) * (I0 - J)
    _vInsLive.copy(_vIns0).sub(pivot).applyQuaternion(qRot).add(pivot);
    _vInsStart.copy(_vIns0).sub(pivot).applyQuaternion(_qStart).add(pivot);

    _vD0.copy(_vIns0).sub(_vOrig);
    const L0 = Math.max(0.02, _vD0.length());
    _vT0.copy(_vD0).divideScalar(L0);

    const hasPulley = Boolean(rig.pulley);
    let strain = 0;

    if (hasPulley) {
      _vPulley.set(...rig.pulley);
      const startDist = _vPulley.distanceTo(_vOrig) + _vInsStart.distanceTo(_vPulley);
      const liveDist = _vPulley.distanceTo(_vOrig) + _vInsLive.distanceTo(_vPulley);
      strain = (startDist - liveDist) / Math.max(0.05, startDist);
    } else {
      const Lstart = Math.max(0.02, _vInsStart.distanceTo(_vOrig));
      const Llive = Math.max(0.02, _vInsLive.distanceTo(_vOrig));
      strain = (Lstart - Llive) / Lstart;
    }

    const bulgeGain = rig.bulgeGain ?? 0.28;
    const liftMax = rig.liftMax ?? 0.014;
    // Physical Poisson constant-volume expansion + active sarcomere recruitment bulge
    const bulgeMag = Math.max(-0.22, Math.min(0.46, 0.75 * strain + bulgeGain * uAct));
    const liftMag = liftMax * uAct;

    // Mid-belly Quadratic Bezier control point wraps smoothly around the joint instead of cutting through bone!
    _vMid0.copy(_vOrig).add(_vIns0).multiplyScalar(0.5);
    _vA.copy(_vMid0).sub(pivot).applyQuaternion(qHalf).add(pivot); // Partially rotated rest midpoint
    _vB.copy(_vOrig).add(_vInsLive).multiplyScalar(0.5);            // Direct chord midpoint
    _vMidLive.lerpVectors(_vB, _vA, 0.42).addScaledVector(_vLift, liftMag);

    for (const mesh of rec.meshes) {
      const posAttr = mesh.geometry.attributes.position;
      const dst = posAttr.array;
      const src = mesh.userData.origPos;
      const n = posAttr.count;

      for (let i = 0; i < n; i++) {
        const ix = i * 3;
        const vx = src[ix], vy = src[ix + 1], vz = src[ix + 2];

        // Leave contralateral side untouched on bilateral BP3D meshes
        if (onlyRight && vx > 0.014) {
          dst[ix] = vx; dst[ix + 1] = vy; dst[ix + 2] = vz;
          continue;
        }

        // Longitudinal parameter s in [0, 1] along rest muscle line O0 -> I0
        const rx = vx - _vOrig.x, ry = vy - _vOrig.y, rz = vz - _vOrig.z;
        const sRaw = (rx * _vT0.x + ry * _vT0.y + rz * _vT0.z) / L0;
        const s = sRaw < 0 ? 0 : (sRaw > 1 ? 1 : sRaw);

        // Rest centerline point c0(s) and radial cross-section offset r0 = v0 - c0(s)
        _vR0.set(
          vx - (_vOrig.x + s * _vD0.x),
          vy - (_vOrig.y + s * _vD0.y),
          vz - (_vOrig.z + s * _vD0.z)
        );

        // Smooth belly envelope: 0 at bony tendon attachments (s=0,1), peak 1.0 at mid-belly
        const bell = Math.pow(Math.sin(Math.PI * s), 1.3);
        const radScale = 1.0 + bulgeMag * bell;

        if (hasPulley) {
          // Pulley-wrapped Quadriceps kinematics:
          // Above patella (s < 0.85): fibers slide axially with excursion & bulge anteriorly
          // Below patella (s >= 0.85): distal patellar tendon bends around knee onto rotating tibia
          const deltaL = _vInsLive.distanceTo(_vPulley) - _vIns0.distanceTo(_vPulley);
          if (s < 0.85) {
            const slide = (s / 0.85) * deltaL;
            dst[ix] = _vOrig.x + s * _vD0.x + _vT0.x * slide + _vR0.x * radScale + _vLift.x * (liftMag * bell);
            dst[ix + 1] = _vOrig.y + s * _vD0.y + _vT0.y * slide + _vR0.y * radScale + _vLift.y * (liftMag * bell);
            dst[ix + 2] = _vOrig.z + s * _vD0.z + _vT0.z * slide + _vR0.z * radScale + _vLift.z * (liftMag * bell);
          } else {
            const wDist = (s - 0.85) / 0.15;
            const wSmooth = wDist * wDist * (3 - 2 * wDist);
            _vC.set(vx, vy, vz).sub(pivot).applyQuaternion(qRot).add(pivot);
            dst[ix] = vx + (_vC.x - vx) * wSmooth;
            dst[ix + 1] = vy + (_vC.y - vy) * wSmooth;
            dst[ix + 2] = vz + (_vC.z - vz) * wSmooth;
          }
        } else {
          // Quadratic Bezier centerline c(s) = (1-s)^2*O + 2(1-s)s*M + s^2*I_live
          const om = 1.0 - s;
          const b0 = om * om;
          const b1 = 2.0 * om * s;
          const b2 = s * s;
          _vCenter.set(
            b0 * _vOrig.x + b1 * _vMidLive.x + b2 * _vInsLive.x,
            b0 * _vOrig.y + b1 * _vMidLive.y + b2 * _vInsLive.y,
            b0 * _vOrig.z + b1 * _vMidLive.z + b2 * _vInsLive.z
          );

          // Exact Bezier tangent T(s) = 2(1-s)(M - O) + 2s(I_live - M)
          _vTang.set(
            2.0 * om * (_vMidLive.x - _vOrig.x) + 2.0 * s * (_vInsLive.x - _vMidLive.x),
            2.0 * om * (_vMidLive.y - _vOrig.y) + 2.0 * s * (_vInsLive.y - _vMidLive.y),
            2.0 * om * (_vMidLive.z - _vOrig.z) + 2.0 * s * (_vInsLive.z - _vMidLive.z)
          );
          if (_vTang.lengthSq() > 1e-8) {
            _vTang.normalize();
            _qFrame.setFromUnitVectors(_vT0, _vTang);
            _vR0.applyQuaternion(_qFrame);
          }

          dst[ix] = _vCenter.x + _vR0.x * radScale;
          dst[ix + 1] = _vCenter.y + _vR0.y * radScale;
          dst[ix + 2] = _vCenter.z + _vR0.z * radScale;
        }
      }

      posAttr.needsUpdate = true;
      mesh.geometry.computeVertexNormals();
    }

    return { strain, bulgePeak: Math.max(0, bulgeMag) };
  }

  _deformStabilizerMuscle(rec, rig, uAct, onlyRight) {
    _vOrig.set(...rig.origin);
    _vIns0.set(...rig.insertion);
    _vLift.set(...(rig.liftDir || [0, 0, -1])).normalize();
    _vD0.copy(_vIns0).sub(_vOrig);
    const L0 = Math.max(0.02, _vD0.length());
    _vT0.copy(_vD0).divideScalar(L0);
    const bulgeMag = (rig.bulgeGain ?? 0.16) * uAct;
    const liftMag = (rig.liftMax ?? 0.007) * uAct;

    for (const mesh of rec.meshes) {
      const posAttr = mesh.geometry.attributes.position;
      const dst = posAttr.array;
      const src = mesh.userData.origPos;
      const n = posAttr.count;
      for (let i = 0; i < n; i++) {
        const ix = i * 3;
        const vx = src[ix], vy = src[ix + 1], vz = src[ix + 2];
        if (onlyRight && vx > 0.014) {
          dst[ix] = vx; dst[ix + 1] = vy; dst[ix + 2] = vz;
          continue;
        }
        const sRaw = ((vx - _vOrig.x) * _vT0.x + (vy - _vOrig.y) * _vT0.y + (vz - _vOrig.z) * _vT0.z) / L0;
        const s = sRaw < 0 ? 0 : (sRaw > 1 ? 1 : sRaw);
        const bell = Math.pow(Math.sin(Math.PI * s), 1.3);
        const cx = _vOrig.x + s * _vD0.x;
        const cy = _vOrig.y + s * _vD0.y;
        const cz = _vOrig.z + s * _vD0.z;
        const radScale = 1.0 + bulgeMag * bell;
        dst[ix] = cx + (vx - cx) * radScale + _vLift.x * (liftMag * bell);
        dst[ix + 1] = cy + (vy - cy) * radScale + _vLift.y * (liftMag * bell);
        dst[ix + 2] = cz + (vz - cz) * radScale + _vLift.z * (liftMag * bell);
      }
      posAttr.needsUpdate = true;
      mesh.geometry.computeVertexNormals();
    }
    return { strain: 0.04 * uAct, bulgePeak: Math.max(0, bulgeMag) };
  }

  _deformRiderMuscle(rec, pivot, qRot, onlyRight) {
    for (const mesh of rec.meshes) {
      const posAttr = mesh.geometry.attributes.position;
      const dst = posAttr.array;
      const src = mesh.userData.origPos;
      const n = posAttr.count;
      for (let i = 0; i < n; i++) {
        const ix = i * 3;
        const vx = src[ix], vy = src[ix + 1], vz = src[ix + 2];
        if (onlyRight && vx > 0.014) {
          dst[ix] = vx; dst[ix + 1] = vy; dst[ix + 2] = vz;
          continue;
        }
        _vC.set(vx, vy, vz).sub(pivot).applyQuaternion(qRot).add(pivot);
        dst[ix] = _vC.x; dst[ix + 1] = _vC.y; dst[ix + 2] = _vC.z;
      }
      posAttr.needsUpdate = true;
      mesh.geometry.computeVertexNormals();
    }
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
