// ============================================================================
// Genesis Foundation Labs — Open Anatomy & Movement Library Controller
// ============================================================================
import { MOVEMENTS, JOINT_TYPES } from './anatomy_data.js';
import { AnatomyScene } from './anatomy_scene.js';

const prettyName = (slug) => String(slug || '')
  .replace(/-/g, ' ')
  .replace(/\b\w/g, (c) => c.toUpperCase());

const esc = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// ---------------------------------------------------------------------------
// Theme Toggle (modern-web-guidance: dark-mode-toggle two-state <meta> model)
// ---------------------------------------------------------------------------
function initColorSchemeToggle(onSchemeChanged) {
  const meta = document.querySelector('meta[name="color-scheme"]');
  const btn = document.getElementById('theme-toggle-btn');

  const getSystemDark = () => window.matchMedia('(prefers-color-scheme: dark)').matches;
  const getEffectiveDark = () => {
    const c = (meta.content || 'light dark').trim();
    if (c === 'dark') return true;
    if (c === 'light') return false;
    return getSystemDark();
  };
  const syncLabel = () => {
    const isDark = getEffectiveDark();
    btn.textContent = isDark ? 'Light mode' : 'Dark mode';
    btn.setAttribute('aria-label', isDark ? 'Switch to light theme' : 'Switch to dark theme');
    if (onSchemeChanged) onSchemeChanged();
  };

  btn.addEventListener('click', () => {
    const target = getEffectiveDark() ? 'light' : 'dark';
    const sysScheme = getSystemDark() ? 'dark' : 'light';
    try {
      if (target === sysScheme) {
        localStorage.removeItem('color-scheme');
        meta.content = 'light dark';
      } else {
        localStorage.setItem('color-scheme', target);
        meta.content = target;
      }
    } catch (_) {
      meta.content = target;
    }
    syncLabel();
  });

  window.addEventListener('storage', (e) => {
    if (e.key === 'color-scheme') {
      meta.content = (e.newValue === 'light' || e.newValue === 'dark') ? e.newValue : 'light dark';
      syncLabel();
    }
  });
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => syncLabel());
  syncLabel();
}

// ---------------------------------------------------------------------------
// Light-Dismiss Dialog Fallback (Safari fallback per modern-web-guidance)
// ---------------------------------------------------------------------------
function wireLightDismissFallback(dialog) {
  if (!dialog || ('closedBy' in HTMLDialogElement.prototype)) return;
  dialog.addEventListener('click', (event) => {
    if (event.target !== dialog) return;
    const rect = dialog.getBoundingClientRect();
    const inside = (
      rect.top <= event.clientY &&
      event.clientY <= rect.top + rect.height &&
      rect.left <= event.clientX &&
      event.clientX <= rect.left + rect.width
    );
    if (!inside) dialog.close();
  });
}

// ---------------------------------------------------------------------------
// State & Initialization
// ---------------------------------------------------------------------------
const prefersReduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
let activeMove = MOVEMENTS[0];
let isPlaying = !prefersReduced;
let animPhase = 0; // radians
let manualU = 0.0;
let scene = null;
let lastCardUrl = null;
let dirFilterKind = 'all';

// Interactive 2D Lever Lab & Foot Arch state
let leverClassActive = 3;
let leverForceU = 0.55;
let archTensionU = 0.35;

async function init() {
  const viewport = document.getElementById('anatomy-viewport');
  const tip = document.getElementById('viewport-hover-tip');
  const loadEl = document.getElementById('viewport-loading');
  const loadTxt = document.getElementById('viewport-loading-text');

  scene = new AnatomyScene(viewport, {
    onProgress: (label, pct) => {
      loadTxt.textContent = `Loading authentic BodyParts3D ${label}... ${pct}%`;
    },
    onHover: (info) => {
      if (!info) { tip.hidden = true; return; }
      tip.hidden = false;
      tip.style.left = `${info.x + 14}px`;
      tip.style.top = `${info.y + 14}px`;
      tip.innerHTML = `<strong>${esc(prettyName(info.name))}</strong> <span class="mono" style="opacity:.75">(${esc(info.kind)})</span>`;
    },
    onSelect: (info) => {
      document.getElementById('picked-readout').textContent = `Selected ${info.kind}: ${prettyName(info.name)}`;
    },
    onReady: ({ boneCount, muscleCount }) => {
      loadEl.hidden = true;
      document.getElementById('mesh-stats-badge').textContent = `${boneCount} 3D Bones · ${muscleCount} 3D Muscles (BodyParts3D)`;
      renderDirectory();
      const params = new URLSearchParams(window.location.search);
      const reqMove = MOVEMENTS.find(m => m.id === params.get('move')) || MOVEMENTS[0];
      selectMovement(reqMove.id, true);
    },
  });

  initColorSchemeToggle(() => {
    if (scene) scene.applyTheme();
    drawLeverSvg();
    drawFootArchSvg();
  });

  bindTabs();
  renderMovementRail();
  bindPlaybackControls();
  renderJointsGallery();
  bindLeverAndArchLab();
  bindModalsAndShareCard();

  // Start 60 fps loop
  let prev = performance.now();
  const tick = (now) => {
    requestAnimationFrame(tick);
    const dt = Math.min(0.05, (now - prev) / 1000);
    prev = now;
    if (isPlaying && !scene.options.isolatedHighlight) {
      animPhase += dt * 1.65;
      const u = 0.5 - 0.5 * Math.cos(animPhase);
      manualU = u;
      scene.setContraction(u);
      updateLiveKinematicsUI(u);
    }
    scene.renderFrame(dt, now * 0.001);
    if (!document.getElementById('tab-panel-foundations').hidden) {
      animateJointCards(now * 0.001);
    }
  };
  requestAnimationFrame(tick);

  await scene.loadModels('../assets/models/hra/');
}

// ---------------------------------------------------------------------------
// Primary Navigation Tabs
// ---------------------------------------------------------------------------
function bindTabs() {
  const btns = document.querySelectorAll('.tab-btn[data-tab]');
  const panels = ['lab', 'foundations', 'directory'];
  window.switchAnatomyTab = (target) => {
    btns.forEach(b => b.setAttribute('aria-selected', String(b.dataset.tab === target)));
    panels.forEach(p => {
      document.getElementById(`tab-panel-${p}`).hidden = (p !== target);
    });
    if (target === 'lab' && scene) requestAnimationFrame(() => scene.resize());
    if (target === 'foundations') {
      drawLeverSvg();
      drawFootArchSvg();
    }
  };
  btns.forEach(b => b.addEventListener('click', () => window.switchAnatomyTab(b.dataset.tab)));
}

// ---------------------------------------------------------------------------
// Left Movement Rail & Right Biomechanics Inspector
// ---------------------------------------------------------------------------
function renderMovementRail() {
  const host = document.getElementById('movement-rail-list');
  const regions = [...new Set(MOVEMENTS.map(m => m.region))];
  host.innerHTML = regions.map(reg => {
    const items = MOVEMENTS.filter(m => m.region === reg);
    return `
      <div class="region-group-title">${esc(reg)}</div>
      ${items.map(m => `
        <button type="button" class="move-btn" data-move-id="${esc(m.id)}" aria-pressed="false">
          <strong>${esc(m.title)}</strong>
          <span>${esc(m.agonists.slice(0, 2).map(prettyName).join(' · '))}</span>
        </button>
      `).join('')}
    `;
  }).join('');

  host.querySelectorAll('.move-btn').forEach(btn => {
    btn.addEventListener('click', () => selectMovement(btn.dataset.moveId, true));
  });
}

function selectMovement(moveId, flyCam = true) {
  const m = MOVEMENTS.find(x => x.id === moveId) || MOVEMENTS[0];
  activeMove = m;
  document.querySelectorAll('.move-btn').forEach(b => {
    b.setAttribute('aria-pressed', String(b.dataset.moveId === m.id));
  });

  // Sync URL query param without reload so every movement is instantly shareable!
  try {
    const u = new URL(window.location.href);
    u.searchParams.set('move', m.id);
    window.history.replaceState({}, '', u.toString());
  } catch (_) {}

  document.getElementById('ins-region').textContent = `${m.region} · ${m.plane}`;
  document.getElementById('ins-title').textContent = m.title;
  document.getElementById('ins-sub').textContent = m.subtitle;
  document.getElementById('ins-origin').textContent = m.originLabel;
  document.getElementById('ins-insertion').textContent = m.insertionLabel;
  document.getElementById('ins-joint').textContent = `${m.jointName} — ${m.jointType}`;
  document.getElementById('ins-lever').textContent = m.leverClass;
  document.getElementById('ins-nerve').textContent = m.nerve;
  document.getElementById('ins-note').textContent = m.biomechanicsNote;
  document.getElementById('ins-cue').textContent = m.cue;
  document.getElementById('picked-readout').textContent = 'Drag to orbit · Scroll to zoom · Click any bone or muscle';

  const makeChips = (list, cls) => list.map(slug =>
    `<button type="button" class="muscle-chip ${cls}" data-inspect-muscle="${esc(slug)}">${esc(prettyName(slug))}</button>`
  ).join('');
  document.getElementById('ins-agonists').innerHTML = makeChips(m.agonists, 'ag');
  document.getElementById('ins-antagonists').innerHTML = makeChips(m.antagonists, 'ant');

  document.querySelectorAll('[data-inspect-muscle]').forEach(ch => {
    ch.addEventListener('click', () => {
      isPlaying = false;
      updatePlayBtn();
      scene.focusSingleStructure('muscle', ch.dataset.inspectMuscle);
      document.getElementById('picked-readout').textContent = `Isolated 3D Muscle: ${prettyName(ch.dataset.inspectMuscle)} (Click movement on left to resume)`;
    });
  });

  animPhase = 0;
  manualU = 0;
  if (scene) scene.setMovement(m, flyCam);
  updateLiveKinematicsUI(0);
}

function updateLiveKinematicsUI(u) {
  const m = activeMove;
  if (!m) return;
  const pct = Math.round(u * 100);
  const angle = Math.round(m.romDeg[0] + (m.romDeg[1] - m.romDeg[0]) * u);
  // Bell-shaped length-tension / moment-arm torque curve peaking near mid-range
  const torque = Math.round(m.peakTorqueNm * Math.sin(Math.PI * Math.max(0.08, Math.min(0.95, 0.15 + u * 0.78))));

  const slider = document.getElementById('contraction-slider');
  if (document.activeElement !== slider) slider.value = String(pct);
  document.getElementById('contraction-pct').textContent = `${pct}%`;
  document.getElementById('kpi-angle').textContent = `${angle}°`;
  document.getElementById('kpi-torque').textContent = `${torque} N·m`;
  document.getElementById('kpi-phase').textContent = pct < 15 ? 'Rest' : (pct > 85 ? 'Peak' : 'Active');
}

function updatePlayBtn() {
  const btn = document.getElementById('play-pause-btn');
  btn.textContent = isPlaying ? 'Pause' : 'Play Contraction';
  btn.setAttribute('aria-pressed', String(isPlaying));
}

function bindPlaybackControls() {
  const playBtn = document.getElementById('play-pause-btn');
  const slider = document.getElementById('contraction-slider');
  updatePlayBtn();

  playBtn.addEventListener('click', () => {
    if (scene.options.isolatedHighlight) {
      selectMovement(activeMove.id, false);
    }
    isPlaying = !isPlaying;
    updatePlayBtn();
  });

  slider.addEventListener('input', () => {
    if (scene.options.isolatedHighlight) selectMovement(activeMove.id, false);
    isPlaying = false;
    updatePlayBtn();
    manualU = Number(slider.value) / 100;
    animPhase = Math.acos(1 - 2 * manualU);
    scene.setContraction(manualU);
    updateLiveKinematicsUI(manualU);
  });

  document.getElementById('reset-cam-btn').addEventListener('click', () => scene.resetCamera());

  const bindToggle = (id, key) => {
    const el = document.getElementById(id);
    el.addEventListener('click', () => {
      const next = el.getAttribute('aria-pressed') !== 'true';
      el.setAttribute('aria-pressed', String(next));
      scene.setOptions({ [key]: next });
    });
  };
  bindToggle('tog-antagonists', 'showAntagonists');
  bindToggle('tog-vectors', 'showVectors');
  bindToggle('tog-ghost', 'showAllMusclesGhost');
  bindToggle('tog-unilateral', 'unilateralFocus');
}

// ---------------------------------------------------------------------------
// Tab 2: AnatoBase-Style Visual Explainers — Levers, Foot Arch & 6 Joint Types
// ---------------------------------------------------------------------------
function bindLeverAndArchLab() {
  document.querySelectorAll('[data-lever-class]').forEach(btn => {
    btn.addEventListener('click', () => {
      leverClassActive = Number(btn.dataset.leverClass);
      document.querySelectorAll('[data-lever-class]').forEach(b => b.setAttribute('aria-pressed', String(b === btn)));
      drawLeverSvg();
    });
  });
  document.getElementById('lever-slider').addEventListener('input', (e) => {
    leverForceU = Number(e.target.value) / 100;
    drawLeverSvg();
  });
  document.getElementById('arch-slider').addEventListener('input', (e) => {
    archTensionU = Number(e.target.value) / 100;
    drawFootArchSvg();
  });
  drawLeverSvg();
  drawFootArchSvg();
}

function drawLeverSvg() {
  const svg = document.getElementById('lever-svg');
  const note = document.getElementById('lever-caption');
  const tilt = (leverForceU - 0.35) * 28; // degrees
  const configs = {
    1: {
      title: 'Class 1 · Effort — Fulcrum — Load (Triceps / Neck)',
      fulcrumX: 165, effortX: 85, loadX: 295, ma: '0.62×',
      desc: 'Fulcrum sits between Effort and Load (like a seesaw). Triceps pulls upward on the olecranon behind the elbow fulcrum to extend the forearm.',
    },
    2: {
      title: 'Class 2 · Fulcrum — Load — Effort (Calf Raise / Foot Arch)',
      fulcrumX: 70, loadX: 185, effortX: 295, ma: '1.96× (Force Multiplier)',
      desc: 'Load sits between Fulcrum (toes/metatarsals) and Effort (Achilles tendon on calcaneus). High mechanical advantage lets your calf lift your entire bodyweight!',
    },
    3: {
      title: 'Class 3 · Fulcrum — Effort — Load (Biceps Curl)',
      fulcrumX: 72, effortX: 138, loadX: 295, ma: '0.30× (Speed & Range Multiplier)',
      desc: 'Most human limb muscles are Class 3 levers: Effort inserts right next to the Fulcrum so tiny 2 cm muscle shortening sweeps the hand through a massive arc.',
    },
  };
  const cfg = configs[leverClassActive];
  note.innerHTML = `<strong>${cfg.title}</strong> · Mechanical Advantage: <span class="mono">${cfg.ma}</span><br/>${cfg.desc}`;

  const pivotY = 128;
  svg.innerHTML = `
    <g transform="rotate(${-tilt.toFixed(1)} ${cfg.fulcrumX} ${pivotY})">
      <rect x="52" y="${pivotY - 8}" width="266" height="16" rx="8" fill="#dfd9cb" stroke="#7c878d" stroke-width="1.6"/>
      <circle cx="${cfg.effortX}" cy="${pivotY}" r="6" fill="#d6453a"/>
      <line x1="${cfg.effortX}" y1="${pivotY - 12}" x2="${cfg.effortX}" y2="${pivotY - 52}" stroke="#d6453a" stroke-width="3.2" stroke-linecap="round"/>
      <polygon points="${cfg.effortX},${pivotY - 62} ${cfg.effortX - 7},${pivotY - 48} ${cfg.effortX + 7},${pivotY - 48}" fill="#d6453a"/>
      <text x="${cfg.effortX}" y="${pivotY - 68}" text-anchor="middle" font-size="11" font-weight="700" fill="#d6453a">MUSCLE EFFORT</text>

      <circle cx="${cfg.loadX}" cy="${pivotY}" r="6" fill="#4f6d7a"/>
      <line x1="${cfg.loadX}" y1="${pivotY + 12}" x2="${cfg.loadX}" y2="${pivotY + 46}" stroke="#4f6d7a" stroke-width="2.6" stroke-dasharray="4 3"/>
      <rect x="${cfg.loadX - 18}" y="${pivotY + 46}" width="36" height="22" rx="5" fill="#4f6d7a"/>
      <text x="${cfg.loadX}" y="${pivotY + 61}" text-anchor="middle" font-size="10.5" font-weight="700" fill="#fff">LOAD</text>
    </g>
    <polygon points="${cfg.fulcrumX},${pivotY + 7} ${cfg.fulcrumX - 14},${pivotY + 34} ${cfg.fulcrumX + 14},${pivotY + 34}" fill="#18a999"/>
    <circle cx="${cfg.fulcrumX}" cy="${pivotY}" r="5.5" fill="#101418" stroke="#18a999" stroke-width="2.5"/>
    <text x="${cfg.fulcrumX}" y="${pivotY + 49}" text-anchor="middle" font-size="11" font-weight="700" fill="#18a999">JOINT FULCRUM</text>
  `;
}

function drawFootArchSvg() {
  const svg = document.getElementById('arch-svg');
  // Windlass mechanism: raising big toe tightens plantar fascia & elevates medial longitudinal arch!
  const lift = archTensionU * 20;
  const toeDeg = archTensionU * 42;
  const talusY = 74 - lift;
  const navY = 92 - lift * 0.9;
  const heelX = 68, heelY = 148;
  const metX = 258, metY = 148;

  svg.innerHTML = `
    <line x1="25" y1="162" x2="345" y2="162" stroke="currentColor" stroke-opacity="0.22" stroke-width="1.5"/>
    <!-- Plantar fascia elastic tie-beam -->
    <line x1="${heelX + 12}" y1="${heelY + 4}" x2="${metX}" y2="${metY + 4}" stroke="#18a999" stroke-width="${2.5 + archTensionU * 3.5}" stroke-dasharray="6 3"/>
    <text x="165" y="177" text-anchor="middle" font-size="10.5" font-weight="700" fill="#18a999">PLANTAR FASCIA WINDLASS (${Math.round(archTensionU * 100)}% TENSION)</text>

    <!-- Simplified Structural Blocks (AnatoBase "Foot Arch as Shapes") -->
    <polygon points="${heelX - 16},${heelY + 8} ${heelX + 36},${heelY + 6} ${heelX + 42},${talusY + 26} ${heelX - 10},${talusY + 30}" fill="#e6dfd0" stroke="#7c878d" stroke-width="1.5"/>
    <text x="${heelX + 12}" y="${heelY - 12}" text-anchor="middle" font-size="9.5" fill="#101418" font-weight="600">Calcaneus</text>

    <polygon points="${heelX + 34},${talusY + 24} ${heelX + 86},${talusY + 8} ${heelX + 94},${talusY - 16} ${heelX + 46},${talusY - 14}" fill="#d6453a" fill-opacity="0.82" stroke="#992a22" stroke-width="1.5"/>
    <text x="${heelX + 66}" y="${talusY + 5}" text-anchor="middle" font-size="9.5" fill="#fff" font-weight="700">Talus</text>

    <polygon points="${heelX + 88},${navY + 14} ${heelX + 132},${navY + 20} ${heelX + 138},${navY - 6} ${heelX + 94},${navY - 10}" fill="#e6dfd0" stroke="#7c878d" stroke-width="1.5"/>
    <text x="${heelX + 113}" y="${navY + 7}" text-anchor="middle" font-size="9" fill="#101418" font-weight="600">Navicular</text>

    <polygon points="${heelX + 134},${navY + 16} ${metX},${metY + 6} ${metX + 4},${metY - 14} ${heelX + 138},${navY - 4}" fill="#e6dfd0" stroke="#7c878d" stroke-width="1.5"/>
    <text x="218" y="${(navY + metY) / 2 - 4}" text-anchor="middle" font-size="9.5" fill="#101418" font-weight="600">1st Metatarsal</text>

    <!-- Hallux (Big Toe) rotating up to engage Windlass -->
    <g transform="rotate(${-toeDeg.toFixed(1)} ${metX + 6} ${metY})">
      <rect x="${metX + 6}" y="${metY - 10}" width="52" height="16" rx="7" fill="#18a999" stroke="#0d6e63" stroke-width="1.4"/>
      <text x="${metX + 32}" y="${metY + 1}" text-anchor="middle" font-size="9.5" fill="#061816" font-weight="700">Hallux</text>
    </g>

    <!-- Achilles Pull Arrow -->
    <line x1="${heelX - 10}" y1="${heelY - 16}" x2="${heelX - 10}" y2="26" stroke="#d6453a" stroke-width="3" stroke-linecap="round"/>
    <polygon points="${heelX - 10},16 ${heelX - 16},29 ${heelX - 4},29" fill="#d6453a"/>
    <text x="${heelX + 38}" y="29" font-size="10.5" font-weight="700" fill="#d6453a">ACHILLES TENDON</text>
  `;
}

function renderJointsGallery() {
  const host = document.getElementById('joints-gallery');
  host.innerHTML = JOINT_TYPES.map(j => `
    <article class="joint-card">
      <div class="joint-svg-box">
        <svg id="joint-svg-${esc(j.id)}" viewBox="0 0 220 130" width="220" height="130" role="img" aria-label="${esc(j.name)} kinematic diagram"></svg>
      </div>
      <div>
        <div class="eyebrow">${esc(j.dof)}</div>
        <h3 style="font-size:16px;margin-top:3px">${esc(j.name)}</h3>
        <p style="font-size:12.6px;color:var(--ink-2);margin-top:5px">${esc(j.mechanics)}</p>
        <p class="mono" style="font-size:11px;color:var(--ink-3);margin-top:6px">Examples: ${esc(j.examples)}</p>
      </div>
      <div style="margin-top:auto">
        <button type="button" class="btn" data-jump-move="${esc(j.moveId)}" style="width:100%">Explore Live in 3D &rarr;</button>
      </div>
    </article>
  `).join('');

  host.querySelectorAll('[data-jump-move]').forEach(btn => {
    btn.addEventListener('click', () => {
      window.switchAnatomyTab('lab');
      selectMovement(btn.dataset.jumpMove, true);
    });
  });
  animateJointCards(0);
}

function animateJointCards(t) {
  const s = prefersReduced ? 0.45 : Math.sin(t * 2.0);
  const c = prefersReduced ? 0.35 : Math.cos(t * 1.6);

  const setSvg = (id, html) => { const el = document.getElementById(`joint-svg-${id}`); if (el) el.innerHTML = html; };

  // 1. Hinge
  setSvg('hinge', `
    <rect x="42" y="55" width="66" height="22" rx="6" fill="#dfd9cb" stroke="#7c878d" stroke-width="1.6"/>
    <g transform="rotate(${(-42 + s * 42).toFixed(1)} 108 66)">
      <rect x="108" y="55" width="72" height="22" rx="6" fill="#d6453a" fill-opacity="0.86" stroke="#9b2b22" stroke-width="1.5"/>
    </g>
    <circle cx="108" cy="66" r="14" fill="#18a999" stroke="#101418" stroke-width="2"/>
    <circle cx="108" cy="66" r="4" fill="#101418"/>
  `);

  // 2. Ball-and-Socket
  setSvg('ball-socket', `
    <path d="M 80 34 A 34 34 0 1 0 80 96 L 80 82 A 20 20 0 1 1 80 48 Z" fill="#dfd9cb" stroke="#7c878d" stroke-width="1.6"/>
    <g transform="rotate(${(s * 36).toFixed(1)} 88 65)">
      <circle cx="88" cy="65" r="18" fill="#18a999" stroke="#0d6e63" stroke-width="1.6"/>
      <rect x="102" y="56" width="76" height="18" rx="7" fill="#d6453a" fill-opacity="0.88" stroke="#9b2b22" stroke-width="1.5"/>
    </g>
    <ellipse cx="176" cy="65" rx="14" ry="28" fill="none" stroke="#18a999" stroke-dasharray="3 3" stroke-width="1.4"/>
  `);

  // 3. Pivot (matching AnatoBase screenshot!)
  const px = (s * 24).toFixed(1);
  setSvg('pivot', `
    <rect x="98" y="18" width="24" height="92" rx="8" fill="#dfd9cb" stroke="#7c878d" stroke-width="1.6"/>
    <ellipse cx="110" cy="66" rx="44" ry="16" fill="#d6453a" fill-opacity="0.78" stroke="#9b2b22" stroke-width="1.6"/>
    <ellipse cx="110" cy="66" rx="16" ry="7" fill="#101418" fill-opacity="0.22"/>
    <circle cx="${(110 + Number(px)).toFixed(1)}" cy="78" r="6" fill="#18a999"/>
    <path d="M 62 42 Q 110 24 158 42" fill="none" stroke="#18a999" stroke-width="2" stroke-dasharray="4 3"/>
  `);

  // 4. Ellipsoid / Condyloid
  setSvg('ellipsoid', `
    <path d="M 68 88 Q 110 112 152 88 L 152 108 L 68 108 Z" fill="#dfd9cb" stroke="#7c878d" stroke-width="1.6"/>
    <g transform="rotate(${(s * 24).toFixed(1)} 110 82) translate(${(c * 8).toFixed(1)}, 0)">
      <ellipse cx="110" cy="68" rx="34" ry="20" fill="#d6453a" fill-opacity="0.85" stroke="#9b2b22" stroke-width="1.6"/>
      <rect x="98" y="18" width="24" height="36" rx="6" fill="#e6dfd0" stroke="#7c878d" stroke-width="1.5"/>
    </g>
    <path d="M 74 28 Q 110 14 146 28" fill="none" stroke="#18a999" stroke-width="2" stroke-dasharray="4 3"/>
  `);

  // 5. Saddle
  setSvg('saddle', `
    <path d="M 60 88 Q 110 62 160 88 L 160 112 L 60 112 Z" fill="#dfd9cb" stroke="#7c878d" stroke-width="1.6"/>
    <g transform="rotate(${(s * 20).toFixed(1)} 110 74) translate(0, ${(c * 4).toFixed(1)})">
      <path d="M 72 34 L 148 34 L 148 64 Q 110 90 72 64 Z" fill="#18a999" fill-opacity="0.85" stroke="#0d6e63" stroke-width="1.6"/>
    </g>
  `);

  // 6. Plane / Gliding
  const gx = (s * 22).toFixed(1);
  setSvg('plane', `
    <rect x="46" y="72" width="128" height="28" rx="6" fill="#dfd9cb" stroke="#7c878d" stroke-width="1.6"/>
    <rect x="${(66 + Number(gx)).toFixed(1)}" y="38" width="88" height="28" rx="6" fill="#d6453a" fill-opacity="0.86" stroke="#9b2b22" stroke-width="1.6"/>
    <line x1="56" y1="24" x2="164" y2="24" stroke="#18a999" stroke-width="2" stroke-dasharray="4 3"/>
  `);
}

// ---------------------------------------------------------------------------
// Tab 3: Searchable Directory of All 419 Real BodyParts3D Bones & Muscles
// ---------------------------------------------------------------------------
function renderDirectory() {
  const host = document.getElementById('directory-grid');
  const q = (document.getElementById('dir-search').value || '').trim().toLowerCase();
  const items = [];
  if (dirFilterKind === 'all' || dirFilterKind === 'muscle') {
    for (const m of scene.allMuscleNames) items.push({ kind: 'muscle', name: m });
  }
  if (dirFilterKind === 'all' || dirFilterKind === 'bone') {
    for (const b of scene.allBoneNames) items.push({ kind: 'bone', name: b });
  }
  const filtered = q ? items.filter(it => it.name.includes(q) || prettyName(it.name).toLowerCase().includes(q)) : items;
  document.getElementById('dir-count').textContent = `Showing ${filtered.length} of ${scene.allBoneNames.length + scene.allMuscleNames.length} authentic 3D BodyParts3D meshes`;

  host.innerHTML = filtered.slice(0, 180).map(it => `
    <button type="button" class="dir-item" data-iso-kind="${esc(it.kind)}" data-iso-name="${esc(it.name)}">
      <span style="font-size:12.8px;font-weight:500">${esc(prettyName(it.name))}</span>
      <span class="dir-badge" style="color:${it.kind === 'muscle' ? 'var(--muscle)' : 'var(--accent)'}">${esc(it.kind)}</span>
    </button>
  `).join('');

  host.querySelectorAll('.dir-item').forEach(btn => {
    btn.addEventListener('click', () => {
      isPlaying = false;
      updatePlayBtn();
      window.switchAnatomyTab('lab');
      scene.focusSingleStructure(btn.dataset.isoKind, btn.dataset.isoName);
      document.getElementById('picked-readout').textContent =
        `Isolated 3D ${prettyName(btn.dataset.isoKind)}: ${prettyName(btn.dataset.isoName)} (Select any movement on left to animate)`;
    });
  });
}

document.getElementById('dir-search').addEventListener('input', () => renderDirectory());
document.querySelectorAll('[data-dir-filter]').forEach(btn => {
  btn.addEventListener('click', () => {
    dirFilterKind = btn.dataset.dirFilter;
    document.querySelectorAll('[data-dir-filter]').forEach(b => b.setAttribute('aria-pressed', String(b === btn)));
    renderDirectory();
  });
});

// ---------------------------------------------------------------------------
// 1-Click Branded Social Card Export (Viral Marketing Engine) & Modals
// ---------------------------------------------------------------------------
function bindModalsAndShareCard() {
  const waitlistDialog = document.getElementById('waitlist-dialog');
  const shareDialog = document.getElementById('share-dialog');
  wireLightDismissFallback(waitlistDialog);
  wireLightDismissFallback(shareDialog);

  document.querySelectorAll('[data-open-waitlist]').forEach(b => {
    b.addEventListener('click', () => waitlistDialog.showModal());
  });

  document.getElementById('waitlist-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const email = document.getElementById('waitlist-email').value.trim();
    const role = document.getElementById('waitlist-role').value;
    try {
      const existing = JSON.parse(localStorage.getItem('gfl-waitlist-entries') || '[]');
      existing.push({ email, role, ts: new Date().toISOString(), move: activeMove.id });
      localStorage.setItem('gfl-waitlist-entries', JSON.stringify(existing));
    } catch (_) {}
    document.getElementById('waitlist-status').textContent =
      `You're on the Genesis Foundation Labs early-access list (${email}). We'll notify you when Personal Health Twin beta opens!`;
    document.getElementById('waitlist-email').value = '';
  });

  document.getElementById('copy-move-link-btn').addEventListener('click', (e) => {
    const btn = e.currentTarget;
    navigator.clipboard.writeText(window.location.href).then(() => {
      btn.textContent = 'Copied Link!';
      setTimeout(() => { btn.textContent = 'Copy Movement Link'; }, 1800);
    });
  });

  document.getElementById('export-card-btn').addEventListener('click', async () => {
    const cardUrl = await renderBrandedSocialCard();
    lastCardUrl = cardUrl;
    document.getElementById('share-card-preview').src = cardUrl;
    document.getElementById('share-card-download').href = cardUrl;
    document.getElementById('share-card-download').download = `genesis-anatomy-${activeMove.id}.png`;
    shareDialog.showModal();
  });
}

async function renderBrandedSocialCard() {
  const W = 1200, H = 675;
  const cvs = document.createElement('canvas');
  cvs.width = W;
  cvs.height = H;
  const ctx = cvs.getContext('2d');

  // Deep Genesis Obsidian canvas
  ctx.fillStyle = '#101418';
  ctx.fillRect(0, 0, W, H);

  // Left: live 3D WebGL viewport snapshot
  const snapImg = await loadImage(scene.captureCanvasDataUrl());
  const boxX = 34, boxY = 34, boxW = 630, boxH = 607;
  ctx.save();
  roundRectPath(ctx, boxX, boxY, boxW, boxH, 16);
  ctx.clip();
  const scale = Math.max(boxW / snapImg.width, boxH / snapImg.height);
  const dw = snapImg.width * scale, dh = snapImg.height * scale;
  ctx.drawImage(snapImg, boxX + (boxW - dw) / 2, boxY + (boxH - dh) / 2, dw, dh);
  ctx.restore();
  ctx.strokeStyle = '#25323b';
  ctx.lineWidth = 2;
  roundRectPath(ctx, boxX, boxY, boxW, boxH, 16);
  ctx.stroke();

  // Right: Publication-grade educational anatomy breakdown
  const rx = 700, rw = 466;
  ctx.fillStyle = '#18a999';
  ctx.font = '700 15px monospace';
  ctx.fillText(`FREE 3D MOVEMENT LIBRARY · ${activeMove.region.toUpperCase()}`, rx, 76);

  ctx.fillStyle = '#eef4f3';
  ctx.font = '700 36px system-ui, -apple-system, sans-serif';
  wrapText(ctx, activeMove.title, rx, 126, rw, 42);

  ctx.fillStyle = '#9db0b7';
  ctx.font = '400 18px system-ui, -apple-system, sans-serif';
  wrapText(ctx, activeMove.subtitle, rx, 174, rw, 26);

  const drawField = (y, label, color, val) => {
    ctx.fillStyle = color;
    ctx.font = '700 13px monospace';
    ctx.fillText(label, rx, y);
    ctx.fillStyle = '#e7efee';
    ctx.font = '500 17px system-ui, -apple-system, sans-serif';
    wrapText(ctx, val, rx, y + 24, rw, 23);
  };

  drawField(246, 'ORIGIN (START)', '#e6a825', activeMove.originLabel);
  drawField(326, 'INSERTION (ATTACHES)', '#ec6256', activeMove.insertionLabel);
  drawField(406, 'JOINT & LEVER MECHANICS', '#18a999', `${activeMove.jointName} · ${activeMove.leverClass}`);
  drawField(486, 'PRIME MOVERS (AGONISTS)', '#ec6256', activeMove.agonists.map(prettyName).join(', '));

  // Footer Genesis Foundation Labs brand logo
  ctx.strokeStyle = '#25323b';
  ctx.beginPath(); ctx.moveTo(rx, 560); ctx.lineTo(W - 34, 560); ctx.stroke();

  try {
    const wm = await loadImage('../assets/brand/logo-wordmark-dark.png');
    const wmH = 22;
    const wmW = wm.width * (wmH / wm.height);
    ctx.drawImage(wm, rx, 582, wmW, wmH);
  } catch (_) {}
  ctx.fillStyle = '#8fa3aa';
  ctx.font = '600 12px monospace';
  ctx.fillText('FOUNDATION LABS · FREE INTERACTIVE 3D ANATOMY', rx, 628);

  return cvs.toDataURL('image/png');
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

function roundRectPath(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function wrapText(ctx, text, x, y, maxW, lineH) {
  const words = String(text || '').split(' ');
  let line = '';
  let cy = y;
  for (const w of words) {
    const test = line ? `${line} ${w}` : w;
    if (ctx.measureText(test).width > maxW && line) {
      ctx.fillText(line, x, cy);
      line = w;
      cy += lineH;
    } else {
      line = test;
    }
  }
  if (line) ctx.fillText(line, x, cy);
}

init();
