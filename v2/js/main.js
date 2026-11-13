// ============================================================================
// TheHumanProject v2 — Main Application Controller
// Unites:
//   1. 32-Organ NIH HRA 3D .glb Reference Body (`HraSceneEngine`)
//   2. Coupled 0D Biophysical RK4 ODE Solver (`CoupledBiophysicsSolver`)
//   3. Real Experimental 3D RCSB PDB Macromolecular Viewer (`PdbViewer3D`)
//   4. Personal Health Twin v2 (`.FIT` Binary + Blood Lab CSV + Diet CSV)
//   5. Multi-Scale Knowledge Graph & Live SQLite FTS5 Workbench
// ============================================================================

import { HraSceneEngine } from './hra_scene_engine.js';
import { CoupledBiophysicsSolver } from './biophysics_ode.js';
import { PdbViewer3D } from './pdb_viewer_3d.js';
import { parseFitArrayBuffer } from './fit_parser_client.js';
import { initPilotWorkspace } from './pilot_workspace.js';

let BUNDLE = null;
let sceneEngine = null;
let odeSolver = null;
let pdbViewer = null;
let pilotCtrl = null;

// Active UI state
let currentView = 'atlas';
let activeSystemId = 'WHOLE_BODY';
let selectedOntologyId = 'UBERON:0000948';
let selectedOrganKey = 'heart';
let activeDisease = null;
let userPinnedMuscles = false;
let twinState = {
  profile: null,
  garmin: null,
  blood_panel: {},
  diet: {},
  lastReport: null,
};
let kgNodes = [];

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
async function init() {
  initThemeToggle();

  const res = await fetch('assets/data/atlas_v2_bundle.json');
  BUNDLE = await res.json();

  odeSolver = new CoupledBiophysicsSolver();
  sceneEngine = new HraSceneEngine(document.getElementById('hra-canvas-host'), {
    onSelectMesh: (meshData) => {
      selectedOrganKey = meshData.organKey;
      selectStructureUI(meshData.ontologyId, meshData.prefLabel, meshData.nodeName, false);
    },
    onHoverMesh: (hoverData) => {
      const tip = document.getElementById('mesh-hover-tooltip');
      if (!hoverData) {
        tip.hidden = true;
        return;
      }
      tip.hidden = false;
      tip.style.left = `${hoverData.x + 14}px`;
      tip.style.top = `${hoverData.y + 14}px`;
      tip.innerHTML = `<strong>${escapeHtml(hoverData.prefLabel)}</strong> <span class="mono" style="opacity:0.8">(${escapeHtml(hoverData.ontologyId)})</span><br/><span style="opacity:0.75">Organ: ${escapeHtml(hoverData.organLabel)}</span>`;
    },
    onLoadProgress: (done, total, orgMeta) => {
      const el = document.getElementById('glb-progress-text');
      if (done < total) {
        el.textContent = `Loading 3D Reference Organs & Musculoskeletal Atlas: ${done}/${total} (${orgMeta.label})...`;
      } else {
        const totTris = BUNDLE.hra_3d_organs.reduce((acc, o) => acc + (o.total_triangles || 0), 0);
        el.textContent = `${total} 3D Organs & Musculoskeletal GLBs · ${BUNDLE.stats.hra_3d_meshes.toLocaleString()} Sub-Meshes · ${(totTris / 1e6).toFixed(2)}M Tris`;
      }
    },
  });

  bindNavigationAndControls();
  renderLeftRail();
  populateDiseaseSelector();
  selectStructureUI('UBERON:0000948', 'Heart', null, false);
  initProvenanceAndSql();
  initKnowledgeGraph();
  initHealthTwin();
  pilotCtrl = initPilotWorkspace({
    onProjectTo3D: (pm) => {
      document.getElementById('disease-select').value = '';
      activeDisease = null;
      odeSolver.setDiseaseModifiers({});
      odeSolver.setDrugIntervention(null, 0);
      odeSolver.setPersonalModifiers(pm);
      setTwaveModeUI(pm.ecg_twave_mode || 'upright');
      updateSimBadge();
      switchView('atlas');
      sceneEngine.flyToPreset('thorax');
    },
    onJumpToOrgan: (uberonId, label) => {
      switchView('atlas');
      selectStructureUI(uberonId, label, null, true);
    },
  });

  // Start 60 fps Coupled ODE + 3D Biomechanics + ECG/Wiggers/P-V Loop loop
  let prevTs = performance.now();
  const animate = (now) => {
    requestAnimationFrame(animate);
    const dt = Math.min(0.05, (now - prevTs) / 1000);
    prevTs = now;
    const snap = odeSolver.step(dt);
    if (currentView === 'atlas') {
      sceneEngine.updateBiomechanicsAndRender(snap);
      drawEcgAndRespiration(snap.metrics);
      drawWiggersTelemetry();
      drawPvLoop();
      updateVitalsReadout(snap.metrics);
    }
  };
  requestAnimationFrame(animate);

  // Progressively load all 32 NIH HRA .glb models
  await sceneEngine.loadAllHraOrgans(BUNDLE.hra_3d_organs);

  // Deep-link support from Participant Phone App (?view=twin|pilot or ?sys=...&struct=...&twave=...)
  const urlParams = new URLSearchParams(window.location.search);
  const reqView = urlParams.get('view');
  if (reqView && ['atlas', 'twin', 'pilot', 'graph', 'sql'].includes(reqView)) {
    switchView(reqView);
  }
  const reqTwave = urlParams.get('twave');
  if (reqTwave && ['upright', 'inverted_ischemic', 'inverted_strain', 'biphasic_wellens', 'auto'].includes(reqTwave)) {
    setTwaveModeUI(reqTwave);
  }
  const reqSys = urlParams.get('sys');
  const reqStruct = urlParams.get('struct');
  if (reqSys && BUNDLE.organ_systems.some(s => s.id === reqSys)) {
    setSystemFilterUI(reqSys);
  }
  if (reqStruct) {
    selectStructureUI(reqStruct, '', null, true);
  }
}

// ---------------------------------------------------------------------------
// Theme, Tabs, Search & Dissection Controls
// ---------------------------------------------------------------------------
function initThemeToggle() {
  const saved = localStorage.getItem('thp-v2-theme');
  if (saved) document.documentElement.dataset.theme = saved;
  document.getElementById('theme-btn').addEventListener('click', () => {
    const root = document.documentElement;
    const darkNow = root.dataset.theme
      ? root.dataset.theme === 'dark'
      : window.matchMedia('(prefers-color-scheme: dark)').matches;
    root.dataset.theme = darkNow ? 'light' : 'dark';
    localStorage.setItem('thp-v2-theme', root.dataset.theme);
    if (sceneEngine) sceneEngine.applyTheme();
    if (currentView === 'graph') drawKnowledgeGraph();
  });
}

function switchView(viewName) {
  currentView = viewName;
  document.querySelectorAll('.nav-tab').forEach(btn => {
    const active = btn.dataset.view === viewName;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-selected', String(active));
  });
  for (const id of ['atlas', 'twin', 'pilot', 'graph', 'sql']) {
    document.getElementById(`view-${id}`).hidden = (id !== viewName);
  }
  if (viewName === 'atlas' && sceneEngine) {
    requestAnimationFrame(() => sceneEngine.resize());
  } else if (viewName === 'graph') {
    requestAnimationFrame(() => drawKnowledgeGraph());
  } else if (viewName === 'pilot' && pilotCtrl) {
    requestAnimationFrame(() => pilotCtrl.redraw());
  }
}

function bindNavigationAndControls() {
  document.querySelectorAll('.nav-tab').forEach(btn => {
    btn.addEventListener('click', () => switchView(btn.dataset.view));
  });
  document.getElementById('brand-home').addEventListener('click', (e) => {
    e.preventDefault();
    switchView('atlas');
  });

  // Layer pills
  document.querySelectorAll('.layer-pill').forEach(pill => {
    pill.addEventListener('click', () => {
      const next = pill.getAttribute('aria-pressed') !== 'true';
      pill.setAttribute('aria-pressed', String(next));
      if (pill.dataset.layer === 'musculature') {
        userPinnedMuscles = next;
      }
      if (pill.dataset.layer === 'skin') {
        const span = pill.querySelector('.mono');
        if (span) span.textContent = next ? 'ON' : 'OFF';
      }
      sceneEngine.setLayerVisible(pill.dataset.layer, next);
    });
  });

  // Expand / Compact Live ECG & Biophysics Deck
  const deckBtn = document.getElementById('toggle-deck-size-btn');
  if (deckBtn) {
    deckBtn.addEventListener('click', () => {
      const stg = document.querySelector('.center-stage');
      const expanded = stg.classList.toggle('deck-expanded');
      deckBtn.textContent = expanded ? 'Compact ECG' : 'Expand ECG';
      requestAnimationFrame(() => sceneEngine.resize());
    });
  }

  // Explode slider
  const expSlider = document.getElementById('explode-slider');
  expSlider.addEventListener('input', () => {
    const v = Number(expSlider.value);
    document.getElementById('explode-val').textContent = `${v}%`;
    sceneEngine.setExplodeFactor(v / 100);
  });

  // Surgical Cross-Section Clipping
  let clipAxis = 'off';
  const clipSlider = document.getElementById('clip-slider');
  document.querySelectorAll('#clip-axis-group .seg-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#clip-axis-group .seg-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      clipAxis = btn.dataset.axis;
      sceneEngine.setClipping(clipAxis, Number(clipSlider.value) / 100);
    });
  });
  clipSlider.addEventListener('input', () => {
    const norm = Number(clipSlider.value) / 100;
    document.getElementById('clip-val').textContent = norm.toFixed(2);
    if (clipAxis !== 'off') sceneEngine.setClipping(clipAxis, norm);
  });

  // Camera presets
  document.querySelectorAll('[data-cam]').forEach(btn => {
    btn.addEventListener('click', () => sceneEngine.flyToPreset(btn.dataset.cam));
  });

  // Global search (instant client-side + server SQLite FTS5)
  const searchInput = document.getElementById('global-search');
  const dropdown = document.getElementById('search-dropdown');
  searchInput.addEventListener('input', async () => {
    const q = searchInput.value.trim().toLowerCase();
    if (q.length < 2) {
      dropdown.hidden = true;
      return;
    }
    const hits = [];
    for (const s of BUNDLE.anatomical_structures) {
      if (s.name.toLowerCase().includes(q) || s.ontology_id.toLowerCase().includes(q)) {
        hits.push({ type: '3D Structure', title: s.name, sub: s.ontology_id, action: () => { switchView('atlas'); selectStructureUI(s.ontology_id, s.name, null, true); } });
        if (hits.length >= 6) break;
      }
    }
    for (const g of BUNDLE.genes) {
      if (g.gene_symbol.toLowerCase().includes(q) || g.protein_name.toLowerCase().includes(q)) {
        hits.push({
          type: g.has_local_3d_pdb ? '3D PDB Gene' : 'Gene/Protein',
          title: `${g.gene_symbol} — ${g.protein_name}`,
          sub: g.uniprot_id || g.ensembl_id,
          action: () => {
            if (g.has_local_3d_pdb) openPdbModal(g.gene_symbol);
            else {
              switchView('atlas');
              setSystemFilterUI(g.organ_system_id);
            }
          },
        });
        if (hits.length >= 12) break;
      }
    }
    for (const d of BUNDLE.diseases) {
      if (d.name.toLowerCase().includes(q) || d.id.toLowerCase().includes(q)) {
        hits.push({
          type: 'MONDO Disease',
          title: d.name,
          sub: d.id,
          action: () => {
            switchView('atlas');
            document.getElementById('disease-select').value = d.id;
            applyDiseaseSelection(d.id);
          },
        });
      }
    }
    dropdown.innerHTML = '';
    if (!hits.length) {
      dropdown.hidden = true;
      return;
    }
    for (const h of hits.slice(0, 12)) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'search-hit';
      b.innerHTML = `<span><strong>${escapeHtml(h.title)}</strong><br/><span class="mono" style="color:var(--ink-3)">${escapeHtml(h.sub)}</span></span><span class="status-pill status-watch">${escapeHtml(h.type)}</span>`;
      b.addEventListener('click', () => {
        dropdown.hidden = true;
        searchInput.value = '';
        h.action();
      });
      dropdown.appendChild(b);
    }
    dropdown.hidden = false;
  });
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.search-wrap')) dropdown.hidden = true;
  });

  // PDB Modal close
  document.getElementById('close-pdb-modal').addEventListener('click', () => {
    if (pdbViewer) pdbViewer.stop();
    document.getElementById('pdb-modal').close();
  });
}

// ---------------------------------------------------------------------------
// Left Organ Systems Rail & 3D PDB Quick-Launch Chips
// ---------------------------------------------------------------------------
function renderLeftRail() {
  const host = document.getElementById('system-rail-list');
  const makeBtn = (id, label, color, count) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `sys-btn${activeSystemId === id ? ' active' : ''}`;
    btn.dataset.sys = id;
    btn.innerHTML = `<span class="sys-dot" style="background:${color}"></span><span>${escapeHtml(label)}</span><span class="sys-count">${count}</span>`;
    btn.addEventListener('click', () => setSystemFilterUI(id));
    return btn;
  };

  host.innerHTML = '';
  host.appendChild(makeBtn('WHOLE_BODY', 'Whole Human Body', '#cc4b27', BUNDLE.stats.hra_3d_meshes));
  for (const sys of BUNDLE.organ_systems) {
    const meshCnt = BUNDLE.hra_3d_organs
      .filter(o => o.organ_system_id === sys.id)
      .reduce((acc, o) => acc + o.nodes.filter(n => n.has_mesh).length, 0);
    host.appendChild(makeBtn(sys.id, sys.short_name, sys.color_hex, meshCnt));
  }

  // Update dynamic tissue layer badge counts
  const countLayer = (lyr) => BUNDLE.hra_3d_organs
    .filter(o => o.layer === lyr)
    .reduce((acc, o) => acc + o.nodes.filter(n => n.has_mesh).length, 0);
  const setTxt = (id, val) => { const e = document.getElementById(id); if (e) e.textContent = String(val); };
  setTxt('cnt-layer-organs', countLayer('organs'));
  setTxt('cnt-layer-vasc', countLayer('vasculature'));
  setTxt('cnt-layer-skel', countLayer('skeleton'));
  setTxt('cnt-layer-musc', countLayer('musculature'));

  const pdbChips = document.getElementById('rail-pdb-chips');
  pdbChips.innerHTML = '';
  for (const p of BUNDLE.pdb_structures) {
    const ch = document.createElement('button');
    ch.type = 'button';
    ch.className = 'chip mono';
    ch.textContent = `${p.gene_symbol} (${p.pdb_id})`;
    ch.title = p.biological_role;
    ch.addEventListener('click', () => openPdbModal(p.gene_symbol));
    pdbChips.appendChild(ch);
  }
}

function setSystemFilterUI(sysId) {
  activeSystemId = sysId;
  document.querySelectorAll('#system-rail-list .sys-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.sys === sysId);
  });

  // Automatically reveal all 177 skeletal muscles + 313 bones when Musculoskeletal is selected!
  const muscPill = document.getElementById('pill-layer-muscles');
  if (sysId === 'SYS:MUSCULOSKELETAL') {
    sceneEngine.layers.musculature = true;
    sceneEngine.layers.skeleton = true;
    if (muscPill) muscPill.setAttribute('aria-pressed', 'true');
    const skelPill = document.querySelector('.layer-pill[data-layer="skeleton"]');
    if (skelPill) skelPill.setAttribute('aria-pressed', 'true');
  } else if (!userPinnedMuscles) {
    sceneEngine.layers.musculature = false;
    if (muscPill) muscPill.setAttribute('aria-pressed', 'false');
  }

  sceneEngine.setSystemFilter(sysId);
  if (sysId !== 'WHOLE_BODY') {
    const sys = BUNDLE.organ_systems.find(s => s.id === sysId);
    if (sys) selectStructureUI(sys.primary_uberon, sys.short_name, null, false);
  }
}

// ---------------------------------------------------------------------------
// Multi-Scale Structure Selection & Right Inspector
// ---------------------------------------------------------------------------
function selectStructureUI(ontologyId, fallbackLabel = '', specificNodeName = null, fly = true) {
  selectedOntologyId = ontologyId;
  const struct = BUNDLE.anatomical_structures.find(s => s.ontology_id === ontologyId);
  const sysId = struct?.organ_system_id || (activeSystemId !== 'WHOLE_BODY' ? activeSystemId : 'SYS:CARDIOVASCULAR');
  if (struct?.organ_key) selectedOrganKey = struct.organ_key;
  else {
    const matchingOrg = BUNDLE.hra_3d_organs.find(o => o.primary_ontology_id === ontologyId || o.organ_system_id === sysId);
    if (matchingOrg) selectedOrganKey = matchingOrg.key;
  }

  sceneEngine.selectStructure(ontologyId, specificNodeName, fly);

  document.getElementById('ins-ont-id').textContent = `${ontologyId} · ${sysId}`;
  document.getElementById('ins-title').textContent = specificNodeName
    ? fallbackLabel
    : (struct?.name || fallbackLabel || ontologyId);
  const sysObj = BUNDLE.organ_systems.find(s => s.id === sysId);
  document.getElementById('ins-subtitle').textContent = sysObj ? sysObj.overview : '';

  // 1. Sub-meshes inside the active 3D HRA Organ
  const orgMeta = BUNDLE.hra_3d_organs.find(o => o.key === selectedOrganKey) || BUNDLE.hra_3d_organs[0];
  const meshNodes = (orgMeta?.nodes || []).filter(n => n.has_mesh);
  document.getElementById('ins-mesh-count').textContent = `${meshNodes.length} in ${orgMeta?.label || 'organ'}`;
  const submeshHost = document.getElementById('ins-submeshes');
  submeshHost.innerHTML = '';
  for (const n of meshNodes.slice(0, 36)) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `chip${(specificNodeName === n.node_name || (!specificNodeName && n.ontology_id === ontologyId && meshNodes.length < 20)) ? ' active' : ''}`;
    b.textContent = n.pref_label;
    b.title = `${n.node_name} (${n.ontology_id}) · ${n.triangle_count.toLocaleString()} tris`;
    b.addEventListener('click', () => {
      selectStructureUI(n.ontology_id, n.pref_label, n.node_name, true);
    });
    submeshHost.appendChild(b);
  }

  // 2. NIH ASCT+B Cell Types & HGNC Biomarkers (exact structure match + organ system fallback)
  let cells = BUNDLE.cell_markers_by_structure[ontologyId] || [];
  if (!cells.length && orgMeta) {
    cells = BUNDLE.cell_markers_by_structure[orgMeta.primary_ontology_id] || [];
  }
  if (!cells.length) {
    // Collect across structures in this organ system
    const sysStructs = BUNDLE.anatomical_structures.filter(s => s.organ_system_id === sysId);
    for (const ss of sysStructs) {
      const cList = BUNDLE.cell_markers_by_structure[ss.ontology_id];
      if (cList?.length) {
        cells = cells.concat(cList);
        if (cells.length >= 8) break;
      }
    }
  }
  document.getElementById('ins-cell-count').textContent = String(cells.length);
  const cellHost = document.getElementById('ins-cells');
  cellHost.innerHTML = cells.slice(0, 7).map(c => `
    <div class="list-item">
      <div class="list-item-head">
        <span>${escapeHtml(c.name)}</span>
        <span class="mono" style="color:var(--ink-3)">${escapeHtml(c.id)}</span>
      </div>
      <div style="margin-top:4px;font-size:11.2px;color:var(--ink-2)">
        HGNC Biomarkers: ${(c.biomarkers || []).map(sym => `<code style="color:var(--accent)">${escapeHtml(sym)}</code>`).join(', ') || 'Curated morphology'}
      </div>
    </div>
  `).join('') || '<div class="list-item">Select a visceral organ to inspect ASCT+B cell markers.</div>';

  // 3. Open Targets Genes & 3D PDB Structures for this system
  const sysGenes = BUNDLE.genes
    .filter(g => g.organ_system_id === sysId)
    .sort((a, b) => (b.has_local_3d_pdb - a.has_local_3d_pdb) || (b.variants.length - a.variants.length));
  document.getElementById('ins-gene-count').textContent = String(sysGenes.length);
  const geneHost = document.getElementById('ins-genes');
  geneHost.innerHTML = '';
  for (const g of sysGenes.slice(0, 8)) {
    const div = document.createElement('div');
    div.className = 'list-item';
    div.innerHTML = `
      <div class="list-item-head">
        <span><strong class="mono">${escapeHtml(g.gene_symbol)}</strong> · ${escapeHtml(g.protein_name)}</span>
        ${g.has_local_3d_pdb ? `<button type="button" class="btn btn-sm btn-accent" data-pdb="${escapeHtml(g.gene_symbol)}">3D PDB (${escapeHtml(g.pdb_id)})</button>` : `<span class="mono" style="color:var(--ink-3)">${escapeHtml(g.uniprot_id || g.ensembl_id)}</span>`}
      </div>
      <div style="margin-top:3px;font-size:11.3px;color:var(--ink-2)">
        ${escapeHtml((g.function_summary || g.tissue_cluster || 'Disease-associated human target').slice(0, 145))}${g.variants.length ? ` · <strong>${g.variants.length} UniProt variants</strong>` : ''}
      </div>
    `;
    const btn = div.querySelector('[data-pdb]');
    if (btn) btn.addEventListener('click', () => openPdbModal(btn.dataset.pdb));
    geneHost.appendChild(div);
  }

  // 4. Enriched Reactome Pathways
  const pws = BUNDLE.pathways.filter(p => p.organ_system_id === sysId);
  document.getElementById('ins-pw-count').textContent = String(pws.length);
  document.getElementById('ins-pathways').innerHTML = pws.slice(0, 7).map(pw => `
    <div class="list-item">
      <div class="list-item-head">
        <span>${escapeHtml(pw.name)}</span>
        <span class="mono" style="color:var(--ok)">FDR ${pw.fdr.toExponential(1)}</span>
      </div>
      <div class="mono" style="font-size:10.8px;color:var(--ink-3);margin-top:2px">
        ${escapeHtml(pw.stId)} · ${pw.entities_found}/${pw.entities_total} genes · ${pw.reactions_found}/${pw.reactions_total} reactions
      </div>
    </div>
  `).join('');
}

// ---------------------------------------------------------------------------
// Disease Perturbation & Mechanistic ChEMBL Pharmacology Simulator
// ---------------------------------------------------------------------------
const TWAVE_MECHANISM_NOTES = {
  inverted_ischemic: 'Symmetric Inverted T-Wave (-0.45 mV, Wellens B / Subendocardial Ischemia): epicardial/apical APD₉₀ prolongation reverses the transmural repolarization vector below the 0 mV isoelectric baseline.',
  inverted_strain: 'Asymmetric Deep Strain T-Wave Inversion (-0.58 mV, LVH / Apical HCM): MYH7 sarcomeric hypertrophy elevates R-wave voltage (+1.36 mV) with downsloping ST depression and steep terminal T return.',
  biphasic_wellens: 'Biphasic (+/-) T-Wave (+0.19 / -0.38 mV, Wellens Type A): initial positive deflection followed by terminal T-wave inversion characteristic of proximal LAD reperfusion.',
  upright: 'Normal Concordant Upright T-Wave (+0.34 mV): shorter subepicardial APD₉₀ (I_to / I_Ks) drives epicardium-to-endocardium repolarization, yielding a positive Lead-II T-wave.',
  auto: 'ODE-Coupled Repolarization: T-wave polarity & depth respond dynamically to MONDO cardiac pathology (HCM strain, CAD ischemia, HF) and normalize with ChEMBL drug receptor occupancy (θ).',
};

function setTwaveModeUI(mode) {
  odeSolver.setEcgTwaveMode(mode);
  const ecgSel = document.getElementById('ecg-twave-select');
  const insSel = document.getElementById('inspector-twave-select');
  const noteEl = document.getElementById('twave-mech-note');
  if (ecgSel && ecgSel.value !== mode) ecgSel.value = mode;
  if (insSel && insSel.value !== mode) insSel.value = mode;
  if (noteEl) noteEl.textContent = TWAVE_MECHANISM_NOTES[mode] || TWAVE_MECHANISM_NOTES.auto;
}

function populateDiseaseSelector() {
  const ecgSel = document.getElementById('ecg-twave-select');
  const insSel = document.getElementById('inspector-twave-select');
  if (ecgSel) ecgSel.addEventListener('change', () => setTwaveModeUI(ecgSel.value));
  if (insSel) insSel.addEventListener('change', () => setTwaveModeUI(insSel.value));
  setTwaveModeUI(odeSolver.ecgTwaveMode || 'inverted_ischemic');

  const sel = document.getElementById('disease-select');
  sel.innerHTML = '<option value="">— Healthy Physiological Baseline —</option>';
  for (const d of BUNDLE.diseases) {
    const opt = document.createElement('option');
    opt.value = d.id;
    opt.textContent = `${d.name} (${d.id})`;
    sel.appendChild(opt);
  }
  sel.addEventListener('change', () => applyDiseaseSelection(sel.value));

  document.getElementById('reset-sim-btn').addEventListener('click', () => {
    sel.value = '';
    odeSolver.setPersonalModifiers({});
    setTwaveModeUI('upright');
    applyDiseaseSelection('');
  });

  const drugSel = document.getElementById('drug-select');
  const doseSlider = document.getElementById('drug-dose-slider');
  const updateDrug = () => {
    const cid = drugSel.value;
    const occ = Number(doseSlider.value) / 100;
    document.getElementById('drug-dose-label').textContent = `${doseSlider.value}%`;
    if (!cid || !activeDisease) {
      odeSolver.setDrugIntervention(null, 0);
      document.getElementById('drug-moa-summary').textContent = '';
      updateSimBadge();
      return;
    }
    const dr = activeDisease.drugs.find(x => x.chembl_id === cid);
    if (dr) {
      const syms = [...new Set(dr.mechanisms.flatMap(m => m.target_symbols))];
      const actType = dr.mechanisms[0]?.action_type || 'MODULATOR';
      const moaTxt = dr.mechanisms.map(m => m.mechanism).filter(Boolean).join('; ') || `${actType} (${dr.drug_type})`;
      odeSolver.setDrugIntervention({ chembl_id: cid, name: dr.name, action_type: actType, target_symbols: syms }, occ);
      document.getElementById('drug-moa-summary').textContent = `${dr.chembl_id} · ${moaTxt} · Targets: ${syms.join(', ') || 'Clinical pathway'}`;
      updateSimBadge();
    }
  };
  drugSel.addEventListener('change', updateDrug);
  doseSlider.addEventListener('input', updateDrug);
}

function applyDiseaseSelection(diseaseId) {
  const drugBox = document.getElementById('drug-control-box');
  const descEl = document.getElementById('disease-desc');
  if (!diseaseId) {
    activeDisease = null;
    odeSolver.setDiseaseModifiers({});
    odeSolver.setDrugIntervention(null, 0);
    drugBox.hidden = true;
    descEl.textContent = 'Coupled 0D Suga-Sagawa cardiovascular, pulmonary, renal & glycemic ODEs operating at healthy resting equilibrium.';
    updateSimBadge();
    return;
  }

  const d = BUNDLE.diseases.find(x => x.id === diseaseId);
  if (!d) return;
  activeDisease = d;
  odeSolver.setDiseaseModifiers(d.ode_modifiers || {});
  odeSolver.setDrugIntervention(null, 0);
  // Automatically couple cardiac disease selection to ODE repolarization (T-wave inversion & drug rescue)
  if (['MONDO_0005045', 'MONDO_0005010', 'MONDO_0005252', 'MONDO_0005149'].includes(d.id)) {
    setTwaveModeUI('auto');
  }
  descEl.textContent = `${d.description.slice(0, 210)} (${d.total_target_count.toLocaleString()} Open Targets genes, ${d.total_drug_count} clinical drugs).`;

  // Fly 3D camera to the disease's primary affected UBERON structure!
  selectStructureUI(d.primary_uberon, d.name, null, true);

  const drugSel = document.getElementById('drug-select');
  drugSel.innerHTML = '<option value="">— Untreated Pathophysiology —</option>';
  for (const dr of d.drugs) {
    const syms = [...new Set(dr.mechanisms.flatMap(m => m.target_symbols))];
    const opt = document.createElement('option');
    opt.value = dr.chembl_id;
    opt.textContent = `${dr.name} [${dr.max_stage}]${syms.length ? ' → ' + syms.join(',') : ''}`;
    drugSel.appendChild(opt);
  }
  document.getElementById('drug-moa-summary').textContent = '';
  drugBox.hidden = false;
  updateSimBadge();
}

function updateSimBadge() {
  const badge = document.getElementById('sim-mode-badge');
  if (activeDisease && odeSolver.activeDrug) {
    badge.textContent = `${activeDisease.name} + ${odeSolver.activeDrug.name} (θ=${Math.round(odeSolver.drugDoseFraction * 100)}%)`;
    badge.style.color = 'var(--ok)';
  } else if (activeDisease) {
    badge.textContent = `Pathology: ${activeDisease.name}`;
    badge.style.color = 'var(--bad)';
  } else if (Object.keys(odeSolver.personalModifiers).length > 0) {
    badge.textContent = 'Personalized Health Twin ODE Active';
    badge.style.color = 'var(--accent)';
  } else {
    badge.textContent = 'Physiological Baseline';
    badge.style.color = 'var(--ink-2)';
  }
}

// ---------------------------------------------------------------------------
// Live 2D Canvas Wiggers Telemetry & Dynamic Left Ventricular P-V Loop
// ---------------------------------------------------------------------------
function updateVitalsReadout(m) {
  document.getElementById('v-hr').textContent = `${m.hr} bpm`;
  document.getElementById('v-bp').textContent = `${m.sbp}/${m.dbp}`;
  document.getElementById('v-co').textContent = `${m.sv}mL · ${m.ef}%`;
  document.getElementById('v-spo2').textContent = `${m.spo2}% · ${m.caO2}`;
  document.getElementById('v-gfr').textContent = `${m.gfr} mL/m`;
  document.getElementById('v-glu').textContent = `${m.glucose} mg/dL`;
  document.getElementById('pv-edv-esv').textContent = `EDV ${m.edv} · ESV ${m.esv} mL`;
}

function fitCanvas(canvas) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = Math.max(120, canvas.clientWidth);
  const h = Math.max(80, canvas.clientHeight);
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, w, h };
}

function drawEcgAndRespiration(metrics) {
  const canvas = document.getElementById('ecg-canvas');
  if (!canvas) return;
  const { ctx, w, h } = fitCanvas(canvas);
  ctx.clearRect(0, 0, w, h);

  const hist = odeSolver.traceHistory;
  if (hist.length < 4) return;

  const style = getComputedStyle(document.documentElement);
  const gridCol = style.getPropertyValue('--rule').trim() || '#d3cfc5';
  const ecgBaseY = h * 0.47;
  const ecgAmp = h * 0.30;

  ctx.strokeStyle = gridCol;
  ctx.lineWidth = 0.75;

  // Clinical ECG millimeter-style vertical & horizontal reference grid
  const stepX = Math.max(18, Math.round(w / 15));
  for (let gx = stepX; gx < w; gx += stepX) {
    ctx.beginPath();
    ctx.moveTo(gx, 0);
    ctx.lineTo(gx, h);
    ctx.stroke();
  }
  for (const mvRef of [1.0, -0.5]) {
    const gy = ecgBaseY - mvRef * ecgAmp;
    ctx.beginPath();
    ctx.moveTo(0, gy);
    ctx.lineTo(w, gy);
    ctx.stroke();
  }

  // Distinct dashed 0 mV isoelectric reference baseline
  ctx.save();
  ctx.strokeStyle = style.getPropertyValue('--rule-strong').trim() || '#9c978d';
  ctx.lineWidth = 0.95;
  ctx.setLineDash([4, 3]);
  ctx.beginPath();
  ctx.moveTo(0, ecgBaseY);
  ctx.lineTo(w, ecgBaseY);
  ctx.stroke();
  ctx.restore();

  // Isoelectric & voltage scale labels (+1mV, 0mV, -0.5mV)
  ctx.fillStyle = style.getPropertyValue('--ink-3').trim() || '#777';
  ctx.font = '9.2px monospace';
  ctx.fillText('+1mV', 3, Math.max(10, ecgBaseY - 1.0 * ecgAmp - 2));
  ctx.fillText('0mV', 3, ecgBaseY - 2);
  ctx.fillText('-0.5', 3, Math.min(h - 14, ecgBaseY + 0.5 * ecgAmp + 9));

  // Shade negative Inverted T-Wave troughs below 0 mV isoelectric line
  ctx.fillStyle = 'rgba(217, 72, 48, 0.17)';
  let inNegSeg = false;
  let segStartX = 0;
  hist.forEach((pt, idx) => {
    const x = (idx / (hist.length - 1)) * w;
    const isNegT = pt.isTwaveSeg && pt.ecg < -0.012;
    if (isNegT) {
      const y = ecgBaseY - pt.ecg * ecgAmp;
      if (!inNegSeg) {
        inNegSeg = true;
        segStartX = x;
        ctx.beginPath();
        ctx.moveTo(x, ecgBaseY);
      }
      ctx.lineTo(x, y);
    } else if (inNegSeg) {
      ctx.lineTo(x, ecgBaseY);
      ctx.closePath();
      ctx.fill();
      inNegSeg = false;
    }
  });
  if (inNegSeg) {
    ctx.lineTo(w, ecgBaseY);
    ctx.closePath();
    ctx.fill();
  }

  // Primary Lead-II Surface ECG trace (emerald P-QRS-T)
  ctx.strokeStyle = '#249c68';
  ctx.lineWidth = 1.9;
  ctx.beginPath();
  hist.forEach((pt, idx) => {
    const x = (idx / (hist.length - 1)) * w;
    const y = ecgBaseY - pt.ecg * ecgAmp;
    if (idx === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  });
  ctx.stroke();

  // Highlight Inverted ST-T wave segment in clinical coral-crimson + track most recent trough
  let latestTrough = null;
  if (metrics?.tWaveInverted) {
    ctx.strokeStyle = '#d94830';
    ctx.lineWidth = 2.15;
    let drawingInv = false;
    hist.forEach((pt, idx) => {
      const x = (idx / (hist.length - 1)) * w;
      const y = ecgBaseY - pt.ecg * ecgAmp;
      if (pt.isTwaveSeg && pt.ecg < 0.02) {
        if (!drawingInv) {
          ctx.beginPath();
          ctx.moveTo(x, y);
          drawingInv = true;
        } else {
          ctx.lineTo(x, y);
        }
        if (x > w * 0.24 && x < w * 0.90 && pt.phi > 0.25 && pt.phi < 0.33) {
          if (!latestTrough || x > latestTrough.x - 14) {
            if (!latestTrough || pt.ecg <= latestTrough.ecg || x - latestTrough.x > 24) {
              latestTrough = { x, y, ecg: pt.ecg };
            }
          }
        }
      } else if (drawingInv) {
        ctx.stroke();
        drawingInv = false;
      }
    });
    if (drawingInv) ctx.stroke();

    if (latestTrough) {
      ctx.fillStyle = '#d94830';
      ctx.beginPath();
      ctx.arc(latestTrough.x, latestTrough.y, 2.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.font = 'bold 9.3px monospace';
      const lbl = metrics.tWaveLabel || `T↓ ${metrics.tWaveMv}mV`;
      const lx = Math.min(w - ctx.measureText(lbl).width - 4, Math.max(28, latestTrough.x - 18));
      const ly = Math.min(h * 0.80, latestTrough.y + 11);
      ctx.fillText(lbl, lx, ly);
    }
  }

  // Alveolar Tidal Volume V_T (cool cyan respiratory wave along lower band)
  ctx.strokeStyle = '#2f7fa3';
  ctx.lineWidth = 1.35;
  ctx.beginPath();
  hist.forEach((pt, idx) => {
    const x = (idx / (hist.length - 1)) * w;
    const y = h - 4 - Math.min(1.0, Math.max(0.0, pt.vAlv / 650.0)) * (h * 0.16);
    if (idx === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  });
  ctx.stroke();

  const ecgSel = document.getElementById('ecg-twave-select');
  if (ecgSel) ecgSel.classList.toggle('is-inverted', Boolean(metrics?.tWaveInverted));

  const badge = document.getElementById('ecg-rhythm-badge');
  if (badge && metrics) {
    const hr = metrics.hr || 68;
    const rhythm = hr > 100 ? 'Tachy' : (hr < 55 ? 'Brady' : 'Sinus');
    badge.textContent = `· ${rhythm} ${Math.round(hr)} bpm`;
  }
}

function drawWiggersTelemetry() {
  const canvas = document.getElementById('wiggers-canvas');
  const { ctx, w, h } = fitCanvas(canvas);
  ctx.clearRect(0, 0, w, h);

  const hist = odeSolver.traceHistory;
  if (hist.length < 4) return;

  // Subtle horizontal pressure grid lines (160, 100, 40 mmHg)
  const style = getComputedStyle(document.documentElement);
  ctx.strokeStyle = style.getPropertyValue('--rule').trim() || '#d3cfc5';
  ctx.lineWidth = 0.9;
  const pTop = 6, pH = h - 12;
  const mapP = (mmHg) => pTop + pH * (1.0 - Math.min(1.0, Math.max(0.0, mmHg / 195.0)));

  for (const pRef of [160, 100, 40]) {
    const gy = mapP(pRef);
    ctx.beginPath();
    ctx.moveTo(0, gy);
    ctx.lineTo(w, gy);
    ctx.stroke();
  }

  ctx.fillStyle = style.getPropertyValue('--ink-3').trim() || '#777';
  ctx.font = '9.5px monospace';
  ctx.fillText('160', 3, mapP(160) - 2);
  ctx.fillText('100', 3, mapP(100) - 2);
  ctx.fillText('40', 3, mapP(40) - 2);

  // Aortic Root Pressure P_Ao (amber)
  ctx.strokeStyle = '#d98a26';
  ctx.lineWidth = 1.7;
  ctx.beginPath();
  hist.forEach((pt, idx) => {
    const x = (idx / (hist.length - 1)) * w;
    const y = mapP(pt.pAo);
    if (idx === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  });
  ctx.stroke();

  // Left Ventricular Pressure P_LV (crimson)
  ctx.strokeStyle = '#cc3e28';
  ctx.lineWidth = 2.0;
  ctx.beginPath();
  hist.forEach((pt, idx) => {
    const x = (idx / (hist.length - 1)) * w;
    const y = mapP(pt.pLv);
    if (idx === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  });
  ctx.stroke();
}

function drawPvLoop() {
  const canvas = document.getElementById('pv-loop-canvas');
  const { ctx, w, h } = fitCanvas(canvas);
  ctx.clearRect(0, 0, w, h);

  const pts = odeSolver.pvHistory;
  if (pts.length < 4) return;

  const padL = 26, padR = 8, padT = 6, padB = 16;
  const pw = w - padL - padR;
  const ph = h - padT - padB;
  const vMin = 15, vMax = 210;
  const pMin = 0, pMax = 200;
  const xOf = (v) => padL + ((v - vMin) / (vMax - vMin)) * pw;
  const yOf = (p) => padT + (1.0 - (p - pMin) / (pMax - pMin)) * ph;

  const style = getComputedStyle(document.documentElement);
  ctx.strokeStyle = style.getPropertyValue('--rule-strong').trim() || '#999';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(padL, padT);
  ctx.lineTo(padL, padT + ph);
  ctx.lineTo(padL + pw, padT + ph);
  ctx.stroke();

  ctx.fillStyle = style.getPropertyValue('--ink-3').trim() || '#777';
  ctx.font = '10px monospace';
  ctx.fillText('180', 2, yOf(180) + 3);
  ctx.fillText('90', 6, yOf(90) + 3);
  ctx.fillText('40mL', xOf(40) - 10, h - 3);
  ctx.fillText('160mL', xOf(160) - 16, h - 3);

  // Draw live P-V trajectory
  ctx.strokeStyle = '#cc4b27';
  ctx.lineWidth = 2.1;
  ctx.beginPath();
  pts.forEach((pt, idx) => {
    const x = xOf(Math.min(vMax, Math.max(vMin, pt.v)));
    const y = yOf(Math.min(pMax, Math.max(pMin, pt.p)));
    if (idx === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  });
  ctx.stroke();

  // Current instantaneous state dot
  const cur = pts[pts.length - 1];
  ctx.fillStyle = '#cc4b27';
  ctx.beginPath();
  ctx.arc(xOf(Math.min(vMax, Math.max(vMin, cur.v))), yOf(Math.min(pMax, Math.max(pMin, cur.p))), 3.5, 0, Math.PI * 2);
  ctx.fill();
}

// ---------------------------------------------------------------------------
// Real 3D RCSB PDB Macromolecular & Variant Viewer Modal
// ---------------------------------------------------------------------------
async function openPdbModal(geneSymbol) {
  const meta = BUNDLE.pdb_structures.find(p => p.gene_symbol === geneSymbol);
  if (!meta) return;

  const dialog = document.getElementById('pdb-modal');
  if (!dialog.open) dialog.showModal();

  document.getElementById('pdb-modal-eyebrow').textContent = `RCSB PDB EXPERIMENTAL 3D · UNIPROT ${meta.uniprot_id} · ${meta.residue_count} CA RESIDUES`;
  document.getElementById('pdb-modal-title').textContent = `${meta.gene_symbol} (${meta.pdb_id}) — ${meta.title}`;
  document.getElementById('pdb-modal-role').textContent = meta.biological_role;

  const res = await fetch(meta.asset_url);
  const structData = await res.json();

  if (!pdbViewer) {
    pdbViewer = new PdbViewer3D(document.getElementById('pdb-canvas-host'));
  }
  pdbViewer.loadStructureData(structData);

  const ligHost = document.getElementById('pdb-ligand-badges');
  ligHost.innerHTML = (structData.ligands || []).length
    ? structData.ligands.map(l => `<span class="status-pill status-optimal">Bound Ligand: ${escapeHtml(l)}</span>`).join(' ')
    : '<span class="mono" style="font-size:11px;color:var(--ink-3)">Apo experimental conformation</span>';

  const varHost = document.getElementById('pdb-variant-list');
  varHost.innerHTML = '';
  for (const v of (structData.variants || [])) {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'list-item';
    item.style.textAlign = 'left';
    item.style.cursor = 'pointer';
    item.innerHTML = `
      <div class="list-item-head">
        <span class="mono" style="color:var(--bad)">${escapeHtml(v.hgvs_like)}</span>
        <span class="mono" style="color:var(--ink-3)">${escapeHtml(v.rsid || 'UniProt')} · res ${v.position}</span>
      </div>
      <div style="font-size:11.3px;color:var(--ink-2);margin-top:2px">${escapeHtml(v.description.slice(0, 140))}</div>
    `;
    item.addEventListener('click', () => pdbViewer.focusResidue(v.position));
    varHost.appendChild(item);
  }
}

// ---------------------------------------------------------------------------
// Personal Health Twin v2 (.FIT Binary + CSV Blood Labs + Diet + 3D ODE Projection)
// ---------------------------------------------------------------------------
async function initHealthTwin() {
  const res = await fetch('/api/v2/twin/presets');
  const data = await res.json();
  const presets = data.presets || {};
  const sel = document.getElementById('twin-preset-select');
  sel.innerHTML = '';
  for (const [key, p] of Object.entries(presets)) {
    const opt = document.createElement('option');
    opt.value = key;
    opt.textContent = p.label;
    sel.appendChild(opt);
  }

  const twinTwaveSel = document.getElementById('twin-ecg-twave-select');

  const loadPreset = async (key) => {
    const p = presets[key];
    if (!p) return;
    twinState.profile = structuredClone(p.profile);
    twinState.garmin = structuredClone(p.garmin);
    twinState.blood_panel = structuredClone(p.blood_panel);
    twinState.diet = structuredClone(p.diet);
    if (twinTwaveSel) {
      twinTwaveSel.value = twinState.garmin.ecg_twave || 'upright';
    }
    await recomputeTwinReport();
  };

  if (twinTwaveSel) {
    twinTwaveSel.addEventListener('change', async () => {
      if (twinState.garmin) {
        twinState.garmin.ecg_twave = twinTwaveSel.value;
        await recomputeTwinReport();
      }
    });
  }

  sel.addEventListener('change', () => loadPreset(sel.value));
  await loadPreset(Object.keys(presets)[0]);

  // Real Binary .FIT upload (decoded in browser via parseFitArrayBuffer AND verified!)
  const handleFitBuffer = async (buf, fileName) => {
    const parsed = parseFitArrayBuffer(buf);
    const s = parsed.summary;
    const banner = document.getElementById('fit-parse-banner');
    banner.hidden = false;
    banner.innerHTML = `<strong>Decoded ${escapeHtml(fileName)}</strong> (FIT v${parsed.protocol.protocol_version}, CRC-16: ${parsed.protocol.crc_valid ? 'VALID' : 'WARN'})<br/>` +
      `${s.sport.toUpperCase()} · ${s.duration_min} min · ${s.distance_km} km · Avg HR ${s.avg_hr_bpm} bpm · Power ${s.avg_power_w} W · ` +
      `HRV RMSSD ${s.hrv_rmssd_ms ?? '--'} ms (${s.rr_beat_count} R-R beats) · Est VO₂max ${s.estimated_vo2max ?? '--'}`;

    twinState.garmin.recent_activity = {
      sport: s.sport,
      duration_min: s.duration_min,
      distance_km: s.distance_km,
      avg_hr_bpm: s.avg_hr_bpm,
      max_hr_bpm: s.max_hr_bpm,
      avg_power_w: s.avg_power_w,
      calories_kcal: s.calories_kcal,
    };
    if (s.hrv_rmssd_ms) twinState.garmin.hrv_rmssd_ms = s.hrv_rmssd_ms;
    if (s.estimated_vo2max) twinState.garmin.vo2_max_ml_kg_min = s.estimated_vo2max;
    await recomputeTwinReport();
  };

  document.getElementById('fit-file-input').addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const buf = await file.arrayBuffer();
    await handleFitBuffer(buf, file.name);
  });

  document.getElementById('load-sample-fit-btn').addEventListener('click', async () => {
    const r = await fetch('assets/samples/garmin_threshold_run.fit');
    const buf = await r.arrayBuffer();
    await handleFitBuffer(buf, 'garmin_threshold_run.fit');
  });

  // Blood Lab CSV upload
  const ingestBloodText = async (rawText) => {
    const r = await fetch('/api/v2/twin/parse-blood', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ raw_text: rawText }),
    });
    const out = await r.json();
    if (out.blood_panel) {
      twinState.blood_panel = { ...twinState.blood_panel, ...out.blood_panel };
      await recomputeTwinReport();
    }
  };
  document.getElementById('blood-csv-input').addEventListener('change', async (e) => {
    const f = e.target.files?.[0];
    if (f) await ingestBloodText(await f.text());
  });
  document.getElementById('load-sample-blood-btn').addEventListener('click', async () => {
    const r = await fetch('assets/samples/blood_panel_sample.csv');
    await ingestBloodText(await r.text());
  });

  // Diet CSV upload
  const ingestDietText = async (rawText) => {
    const r = await fetch('/api/v2/twin/parse-diet', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ raw_text: rawText }),
    });
    const out = await r.json();
    if (out.diet) {
      twinState.diet = out.diet;
      await recomputeTwinReport();
    }
  };
  document.getElementById('diet-csv-input').addEventListener('change', async (e) => {
    const f = e.target.files?.[0];
    if (f) await ingestDietText(await f.text());
  });
  document.getElementById('load-sample-diet-btn').addEventListener('click', async () => {
    const r = await fetch('assets/samples/daily_nutrition_sample.csv');
    await ingestDietText(await r.text());
  });

  // Project Twin into 3D Body & Hemodynamic ODE Simulator!
  document.getElementById('project-twin-to-3d-btn').addEventListener('click', () => {
    if (!twinState.lastReport) return;
    const pm = twinState.lastReport.personal_ode_modifiers || {};
    document.getElementById('disease-select').value = '';
    activeDisease = null;
    odeSolver.setDiseaseModifiers({});
    odeSolver.setDrugIntervention(null, 0);
    odeSolver.setPersonalModifiers(pm);
    setTwaveModeUI(pm.ecg_twave_mode || 'upright');
    updateSimBadge();
    switchView('atlas');
    sceneEngine.flyToPreset(pm.ecg_twave_mode && pm.ecg_twave_mode !== 'upright' ? 'heart' : 'thorax');
  });
}

async function recomputeTwinReport() {
  const r = await fetch('/api/v2/twin/analyze', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      profile: twinState.profile,
      garmin: twinState.garmin,
      blood_panel: twinState.blood_panel,
      diet: twinState.diet,
    }),
  });
  const rep = await r.json();
  twinState.lastReport = rep;
  renderTwinReport(rep);
}

function renderTwinReport(rep) {
  const badge = document.getElementById('twin-overall-badge');
  badge.textContent = `Readiness: ${rep.overall_readiness_score}/100 · CaO₂ ${rep.metrics_summary.arterial_o2_content_ml_dl} mL/dL · HOMA-IR ${rep.metrics_summary.homa_ir}`;
  badge.className = `status-pill ${rep.overall_readiness_score >= 82 ? 'status-optimal' : (rep.overall_readiness_score >= 68 ? 'status-watch' : 'status-action_needed')}`;

  // ODE Preview
  const pm = rep.personal_ode_modifiers;
  document.getElementById('twin-ode-preview').innerHTML = Object.entries(pm)
    .map(([k, v]) => `<div style="display:flex;justify-content:space-between"><span>${escapeHtml(k)}</span><strong>${v}</strong></div>`)
    .join('');

  // 10 Organ cards
  const grid = document.getElementById('twin-organ-grid');
  grid.innerHTML = '';
  for (const o of rep.organ_scores) {
    const card = document.createElement('div');
    card.className = 'organ-score-card';
    card.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center">
        <strong>${escapeHtml(o.label)}</strong>
        <span class="status-pill status-${o.status}">${o.score}</span>
      </div>
      <div class="score-bar"><div class="score-fill" style="width:${o.score}%"></div></div>
      <div class="mono" style="font-size:10.5px;color:var(--ink-3);margin-top:4px">${escapeHtml(o.uberon_id)} &rarr; 3D</div>
    `;
    card.addEventListener('click', () => {
      switchView('atlas');
      selectStructureUI(o.uberon_id, o.label, null, true);
    });
    grid.appendChild(card);
  }

  // Insights
  document.getElementById('twin-insights-list').innerHTML = rep.cross_modal_insights.map(ins => `
    <div class="list-item">
      <div class="list-item-head">
        <span>${escapeHtml(ins.title)}</span>
        <span class="status-pill status-${ins.severity}">${escapeHtml(ins.gene_symbol)} · ${escapeHtml(ins.uberon_id)}</span>
      </div>
      <p style="font-size:12px;color:var(--ink-2);margin-top:4px">${escapeHtml(ins.mechanism)}</p>
      <p style="font-size:12px;margin-top:4px"><strong>Action:</strong> ${escapeHtml(ins.action)}</p>
    </div>
  `).join('');

  // Biomarker table
  document.querySelector('#twin-biomarker-table tbody').innerHTML = rep.evaluated_biomarkers.map(b => `
    <tr>
      <td><strong>${escapeHtml(b.name)}</strong></td>
      <td class="mono">${b.value} ${escapeHtml(b.unit)}</td>
      <td class="mono" style="color:var(--ink-3)">${escapeHtml(b.optimal_range)}</td>
      <td class="mono">${escapeHtml(b.gene_symbol)}</td>
      <td><span class="status-pill status-${b.status}">${escapeHtml(b.status.replace('_', ' '))}</span></td>
    </tr>
  `).join('');

  // Nutrition bars
  const nut = rep.precision_nutrition;
  const macros = nut.macros;
  document.getElementById('twin-nutrition-bars').innerHTML = `
    <div class="mono" style="font-size:12px">Daily Energy Target: <strong>${nut.logged_calories_kcal} / ${nut.target_calories_kcal} kcal</strong></div>
    ${Object.entries(macros).map(([k, v]) => {
      const pct = Math.min(100, Math.round((v.logged / Math.max(1, v.target)) * 100));
      return `
        <div>
          <div style="display:flex;justify-content:space-between;font-size:11.8px">
            <span>${escapeHtml(k.replace('_', ' ').toUpperCase())}</span>
            <span class="mono">${v.logged} / ${v.target}</span>
          </div>
          <div class="score-bar"><div class="score-fill" style="width:${pct}%"></div></div>
        </div>
      `;
    }).join('')}
  `;
}

// ---------------------------------------------------------------------------
// Multi-Scale Knowledge Graph Canvas (#view-graph)
// ---------------------------------------------------------------------------
function initKnowledgeGraph() {
  const sel = document.getElementById('graph-sys-select');
  sel.innerHTML = BUNDLE.organ_systems
    .map(s => `<option value="${s.id}">${escapeHtml(s.name)}</option>`)
    .join('');
  sel.addEventListener('change', () => drawKnowledgeGraph());

  const canvas = document.getElementById('kg-canvas');
  canvas.addEventListener('click', (e) => {
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const hit = kgNodes.find(n => Math.hypot(mx - n.x, my - n.y) <= n.r + 6);
    if (!hit) return;
    if (hit.kind === 'pdb') openPdbModal(hit.gene);
    else if (hit.kind === 'structure') { switchView('atlas'); selectStructureUI(hit.id, hit.label, null, true); }
    else if (hit.kind === 'disease') { switchView('atlas'); document.getElementById('disease-select').value = hit.id; applyDiseaseSelection(hit.id); }
    else if (hit.kind === 'gene') {
      if (hit.hasPdb) openPdbModal(hit.id);
      else { switchView('atlas'); setSystemFilterUI(sel.value); }
    }
  });
  window.addEventListener('resize', () => { if (currentView === 'graph') drawKnowledgeGraph(); });
}

function drawKnowledgeGraph() {
  const sysId = document.getElementById('graph-sys-select').value || 'SYS:CARDIOVASCULAR';
  const canvas = document.getElementById('kg-canvas');
  const { ctx, w, h } = fitCanvas(canvas);
  ctx.clearRect(0, 0, w, h);

  const structs = BUNDLE.anatomical_structures.filter(s => s.organ_system_id === sysId && s.has_3d_mesh).slice(0, 9);
  const cells = [];
  for (const s of structs) {
    for (const c of (BUNDLE.cell_markers_by_structure[s.ontology_id] || []).slice(0, 2)) {
      if (cells.length < 9) cells.push({ ...c, parentOnt: s.ontology_id });
    }
  }
  const genes = BUNDLE.genes.filter(g => g.organ_system_id === sysId).slice(0, 10);
  const diseases = BUNDLE.diseases.filter(d => d.organ_system_id === sysId);
  const drugsAndPdbs = [
    ...BUNDLE.pdb_structures.filter(p => p.organ_system_id === sysId).map(p => ({ id: p.pdb_id, label: `PDB ${p.pdb_id} (${p.gene_symbol})`, kind: 'pdb', gene: p.gene_symbol })),
    ...diseases.flatMap(d => d.drugs.slice(0, 4).map(dr => ({ id: dr.chembl_id, label: dr.name, kind: 'drug', diseaseId: d.id }))),
  ].slice(0, 10);

  const cols = [
    { title: '3D UBERON Structures', color: '#cc4b27', items: structs.map(s => ({ id: s.ontology_id, label: s.name, kind: 'structure' })) },
    { title: 'NIH ASCT+B Cells', color: '#286480', items: cells.map(c => ({ id: c.id, label: c.name, kind: 'cell', parentOnt: c.parentOnt })) },
    { title: 'HGNC / UniProt Genes', color: '#267855', items: genes.map(g => ({ id: g.gene_symbol, label: g.gene_symbol, kind: 'gene', hasPdb: g.has_local_3d_pdb })) },
    { title: 'MONDO Diseases', color: '#b8352a', items: diseases.map(d => ({ id: d.id, label: d.name, kind: 'disease' })) },
    { title: 'ChEMBL Drugs & 3D PDB', color: '#8a5cbf', items: drugsAndPdbs },
  ];

  kgNodes = [];
  const nodeById = new Map();
  const style = getComputedStyle(document.documentElement);
  const ink = style.getPropertyValue('--ink').trim() || '#222';
  const rule = style.getPropertyValue('--rule-strong').trim() || '#999';

  cols.forEach((col, cIdx) => {
    const x = (w * (cIdx + 0.6)) / cols.length;
    ctx.fillStyle = ink;
    ctx.font = '600 11.5px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(col.title, x, 24);

    col.items.forEach((it, rIdx) => {
      const y = 62 + ((h - 95) * (rIdx + 0.5)) / Math.max(1, col.items.length);
      const node = { ...it, x, y, r: 7, color: col.color };
      kgNodes.push(node);
      nodeById.set(it.id, node);
    });
  });

  // Draw curved edges
  const drawEdge = (a, b) => {
    if (!a || !b) return;
    ctx.strokeStyle = rule;
    ctx.globalAlpha = 0.42;
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    const mx = (a.x + b.x) * 0.5;
    ctx.moveTo(a.x, a.y);
    ctx.bezierCurveTo(mx, a.y, mx, b.y, b.x, b.y);
    ctx.stroke();
    ctx.globalAlpha = 1.0;
  };

  for (const n of kgNodes) {
    if (n.kind === 'cell' && n.parentOnt) drawEdge(nodeById.get(n.parentOnt), n);
    if (n.kind === 'pdb' && n.gene) drawEdge(nodeById.get(n.gene), n);
    if (n.kind === 'drug' && n.diseaseId) drawEdge(nodeById.get(n.diseaseId), n);
  }
  for (const d of diseases) {
    const dn = nodeById.get(d.id);
    drawEdge(nodeById.get(d.primary_uberon), dn);
    for (const tg of d.targets) {
      drawEdge(nodeById.get(tg.gene_symbol), dn);
    }
  }

  // Draw nodes & labels
  for (const n of kgNodes) {
    ctx.fillStyle = n.color;
    ctx.beginPath();
    ctx.arc(n.x, n.y, n.r, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = ink;
    ctx.font = '11.5px sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText(n.label.slice(0, 26), n.x + 11, n.y + 4);
  }
}

// ---------------------------------------------------------------------------
// Live SQLite Workbench & Provenance Table (#view-sql)
// ---------------------------------------------------------------------------
function initProvenanceAndSql() {
  document.querySelector('#provenance-table tbody').innerHTML = BUNDLE.provenance.map(p => `
    <tr>
      <td class="mono"><strong>${escapeHtml(p.id)}</strong></td>
      <td>${escapeHtml(p.name)}</td>
      <td class="mono">${escapeHtml(p.version)}</td>
      <td class="mono">${Number(p.records).toLocaleString()}</td>
      <td><a href="${escapeHtml(p.license)}" target="_blank" rel="noopener">${escapeHtml(p.license)}</a></td>
    </tr>
  `).join('');

  const presets = [
    {
      label: '32 NIH HRA 3D Organs & Mesh Counts',
      sql: 'SELECT organ_key, label, organ_system_id, file_size_mb, total_triangles, primary_ontology_id FROM hra_3d_organs ORDER BY total_triangles DESC;',
    },
    {
      label: 'Heart 3D Sub-Meshes (Valves, Chambers, Papillary Muscles)',
      sql: "SELECT node_name, pref_label, ontology_id, vertex_count, triangle_count FROM hra_3d_meshes WHERE organ_key = 'heart' ORDER BY triangle_count DESC;",
    },
    {
      label: 'Top Open Targets Disease-Gene Scores',
      sql: 'SELECT d.name AS disease, a.gene_symbol, ROUND(a.overall_score, 3) AS score, ROUND(a.genetic_score, 3) AS genetic, ROUND(a.clinical_score, 3) AS clinical FROM disease_target_associations a JOIN diseases d ON d.id = a.disease_id ORDER BY a.overall_score DESC LIMIT 25;',
    },
    {
      label: 'ChEMBL Drugs with Target Genes & Physicochemical Properties',
      sql: "SELECT chembl_id, name, max_stage, mw_freebase, alogp, formula, target_symbols_json FROM clinical_drugs WHERE target_symbols_json != '[]' ORDER BY max_stage, name LIMIT 30;",
    },
    {
      label: 'UniProt Curated Human Pathogenic Missense Variants',
      sql: 'SELECT gene_symbol, hgvs_like, position, rsid, substr(description, 1, 110) AS clinical_note FROM protein_variants WHERE is_disease_linked = 1 LIMIT 30;',
    },
    {
      label: 'FTS5 Full-Text Search ("valve OR sarcomere OR nephron")',
      sql: "SELECT entity_type, entity_id, title, subtitle FROM atlas_search_fts WHERE atlas_search_fts MATCH 'valve OR myosin OR nephron' LIMIT 25;",
    },
  ];

  const editor = document.getElementById('sql-editor');
  const chipHost = document.getElementById('sql-preset-chips');
  presets.forEach((p, idx) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'chip';
    b.textContent = p.label;
    b.addEventListener('click', () => {
      editor.value = p.sql;
      executeSql(p.sql);
    });
    chipHost.appendChild(b);
    if (idx === 0) editor.value = p.sql;
  });

  document.getElementById('run-sql-btn').addEventListener('click', () => executeSql(editor.value));
  executeSql(presets[0].sql);
}

async function executeSql(query) {
  const status = document.getElementById('sql-status');
  status.textContent = 'Executing against human_atlas_v2.db...';
  const r = await fetch(`/api/v2/sql?q=${encodeURIComponent(query)}`);
  const data = await r.json();
  const thead = document.querySelector('#sql-result-table thead');
  const tbody = document.querySelector('#sql-result-table tbody');
  if (data.error) {
    status.textContent = `SQL Error: ${data.error}`;
    thead.innerHTML = '';
    tbody.innerHTML = '';
    return;
  }
  const rows = data.rows || [];
  status.textContent = `Returned ${rows.length} rows (${data.elapsed_ms} ms)`;
  if (!rows.length) {
    thead.innerHTML = '';
    tbody.innerHTML = '<tr><td>0 rows returned.</td></tr>';
    return;
  }
  const cols = Object.keys(rows[0]);
  thead.innerHTML = `<tr>${cols.map(c => `<th>${escapeHtml(c)}</th>`).join('')}</tr>`;
  tbody.innerHTML = rows.map(row => `<tr>${cols.map(c => `<td class="mono">${escapeHtml(String(row[c] ?? ''))}</td>`).join('')}</tr>`).join('');
}

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

init();
