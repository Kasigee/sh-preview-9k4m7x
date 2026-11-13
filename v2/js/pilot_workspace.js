// ============================================================================
// TheHumanProject v2 — Genomics × Rhythm Pilot & Multi-Agent Health Council UI
// ============================================================================
// Implements the interactive frontend workspace for:
//   1. 72h Circadian & Ultradian Cosinor Rhythm Engine ("Basic Data" Phenotyping)
//   2. Personal Genome Parser (.VCF / 23andMe .TXT / AncestryDNA) + Dad's Pilot
//   3. Dual-Engine Google AlphaGenome 2 ToS Firewall vs. Sovereign Commercial-Safe
//   4. Genetics vs. Modifiable Lifestyle Attribution Matrix + Yu Epigenetic Bridge
//   5. Modular Multi-Agent Personal Health Council (DS + DE + HC + Orchestrator)
// ============================================================================

function esc(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function initPilotWorkspace({ onProjectTo3D, onJumpToOrgan }) {
  const state = {
    presets: {},
    presetId: 'DADS_PILOT_CASE_STUDY',
    engineMode: 'sovereign_open',
    commercialContext: false,
    genotypesOverride: null,
    rhythmRecordsOverride: null,
    query: '',
    lastBundle: null,
  };

  const presetSel = document.getElementById('pilot-preset-select');
  const engineSel = document.getElementById('pilot-engine-select');
  const commChk = document.getElementById('pilot-commercial-check');
  const projBtn = document.getElementById('project-pilot-to-3d-btn');
  const genomeInput = document.getElementById('pilot-genome-input');
  const rhythmInput = document.getElementById('pilot-rhythm-input');
  const parseBanner = document.getElementById('pilot-parse-banner');
  const queryInput = document.getElementById('pilot-agent-query');
  const runQueryBtn = document.getElementById('pilot-run-query-btn');

  if (!presetSel) return { redraw: () => {} };

  async function evaluateCurrent() {
    const resp = await fetch('/api/v2/pilot/evaluate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        preset_id: state.presetId,
        engine_mode: state.engineMode,
        commercial_context: state.commercialContext,
        genotypes: state.genotypesOverride,
        rhythm_records: state.rhythmRecordsOverride,
        query: state.query,
      }),
    });
    const bundle = await resp.json();
    state.lastBundle = bundle;
    renderPilotBundle(bundle, state, { onJumpToOrgan });
  }

  // Initial load from /api/v2/pilot/presets
  fetch('/api/v2/pilot/presets')
    .then(r => r.json())
    .then(data => {
      state.presets = data.presets || {};
      presetSel.innerHTML = Object.values(state.presets)
        .map(p => `<option value="${esc(p.id)}">${esc(p.label)}</option>`)
        .join('');
      presetSel.value = state.presetId;

      if (data.default_evaluation) {
        state.lastBundle = data.default_evaluation;
        renderPilotBundle(data.default_evaluation, state, { onJumpToOrgan });
      } else {
        evaluateCurrent();
      }
    });

  presetSel.addEventListener('change', () => {
    state.presetId = presetSel.value;
    state.genotypesOverride = null;
    state.rhythmRecordsOverride = null;
    if (parseBanner) parseBanner.hidden = true;
    evaluateCurrent();
  });

  engineSel.addEventListener('change', () => {
    state.engineMode = engineSel.value;
    evaluateCurrent();
  });

  commChk.addEventListener('change', () => {
    state.commercialContext = commChk.checked;
    evaluateCurrent();
  });

  // Personal Genome File Upload (.vcf / 23andMe .txt / Ancestry)
  async function ingestGenomeText(rawText, filename) {
    const r = await fetch('/api/v2/pilot/parse-genome', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ raw_text: rawText, filename }),
    });
    const parsed = await r.json();
    if (parsed.genotypes && Object.keys(parsed.genotypes).length > 0) {
      state.genotypesOverride = parsed.genotypes;
      parseBanner.hidden = false;
      parseBanner.textContent = `Parsed ${parsed.filename} [${parsed.detected_format}]: ${parsed.curated_panel_matched}/${parsed.curated_panel_total} GRCh38 loci matched (${parsed.total_variants_scanned} total records).`;
      await evaluateCurrent();
    }
  }

  genomeInput.addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const text = await file.text();
    await ingestGenomeText(text, file.name);
  });

  document.getElementById('load-sample-vcf-btn')?.addEventListener('click', async () => {
    const txt = await (await fetch('assets/samples/dads_pilot_case_study.vcf')).text();
    await ingestGenomeText(txt, 'dads_pilot_case_study.vcf');
  });

  document.getElementById('load-sample-23andme-btn')?.addEventListener('click', async () => {
    const txt = await (await fetch('assets/samples/dads_23andme_pilot.txt')).text();
    await ingestGenomeText(txt, 'dads_23andme_pilot.txt');
  });

  // 72h Rhythm CSV Upload
  async function ingestRhythmText(rawText, label) {
    const r = await fetch('/api/v2/pilot/parse-rhythm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ raw_text: rawText }),
    });
    const parsed = await r.json();
    if (parsed.records && parsed.records.length >= 8) {
      state.rhythmRecordsOverride = parsed.records;
      parseBanner.hidden = false;
      parseBanner.textContent = `Parsed ${label}: ${parsed.count} hourly wearable epochs -> Cosinor R²=${parsed.rhythm_evaluation.hr_cosinor.r_squared}, Nocturnal Dip=${parsed.rhythm_evaluation.nocturnal_hr_dipping_pct}%.`;
      await evaluateCurrent();
    }
  }

  rhythmInput.addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const text = await file.text();
    await ingestRhythmText(text, file.name);
  });

  document.getElementById('load-sample-rhythm-btn')?.addEventListener('click', async () => {
    const txt = await (await fetch('assets/samples/wearable_72h_rhythm_sample.csv')).text();
    await ingestRhythmText(txt, 'wearable_72h_rhythm_sample.csv');
  });

  // Multi-Agent Council Query Box & Quick Prompts
  runQueryBtn.addEventListener('click', () => {
    state.query = queryInput.value.trim();
    evaluateCurrent();
  });
  queryInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      state.query = queryInput.value.trim();
      evaluateCurrent();
    }
  });

  document.querySelectorAll('[data-pilot-prompt]').forEach(btn => {
    btn.addEventListener('click', () => {
      const q = btn.getAttribute('data-pilot-prompt') || '';
      queryInput.value = q;
      state.query = q;
      evaluateCurrent();
    });
  });

  // Project Unified Pilot Twin into 3D Body & 0D Biophysics ODE!
  projBtn.addEventListener('click', () => {
    if (!state.lastBundle) return;
    onProjectTo3D(state.lastBundle.coupled_ode_modifiers || {}, state.lastBundle);
  });

  window.addEventListener('resize', () => {
    if (state.lastBundle && !document.getElementById('view-pilot')?.hidden) {
      drawCosinorRhythmCanvas(state.lastBundle.rhythm);
    }
  });

  return {
    redraw: () => {
      if (state.lastBundle) drawCosinorRhythmCanvas(state.lastBundle.rhythm);
    },
  };
}

function renderPilotBundle(bundle, state, { onJumpToOrgan }) {
  const { rhythm, genomics, multi_agent_council: council, coupled_ode_modifiers: odeMods } = bundle;
  const presetMeta = state.presets[bundle.preset_id];
  if (presetMeta) {
    document.getElementById('pilot-preset-desc').textContent = presetMeta.description;
  }

  // 1. License & Non-Diagnostic Guardrail Banner
  const guardEl = document.getElementById('pilot-firewall-banner');
  const em = genomics.engine_metadata;
  const keyBadge = genomics.alphagenome_api_key_configured
    ? '<span class="status-pill status-optimal">ALPHAGENOME_API_KEY: Configured</span>'
    : '<span class="status-pill status-watch">ALPHAGENOME_API_KEY: Not Set (Atlas Links + Prior Active)</span>';

  const alertsHtml = (genomics.guardrail_alerts || [])
    .map(a => `<div style="margin-top:5px;color:var(--bad);font-weight:600">&#9888; ${esc(a)}</div>`)
    .join('');

  guardEl.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px">
      <div>
        <strong>Active Engine: ${esc(em.label)}</strong>
        <span class="status-pill ${em.commercial_allowed ? 'status-optimal' : 'status-watch'}" style="margin-left:6px">
          ${em.commercial_allowed ? 'Commercial-Safe Open Stack' : 'Non-Commercial Research ONLY'}
        </span>
        <span class="status-pill status-action_needed" style="margin-left:4px">Non-Diagnostic Wellness/Research Only</span>
      </div>
      <div>${genomics.effective_engine_mode === 'alphagenome2_noncommercial_pilot' ? keyBadge : ''}</div>
    </div>
    <p style="font-size:11.8px;color:var(--ink-2);margin-top:4px">${esc(em.summary)}</p>
    ${alertsHtml}
  `;

  // 2. Biological Rhythm Metrics & 24h Cosinor Canvas
  document.getElementById('pilot-rhythm-score').textContent = `Rhythm Vitality: ${rhythm.rhythm_vitality_score}/100`;
  document.getElementById('pilot-rhythm-kpis').innerHTML = `
    <div class="vital-box"><div class="vital-lbl">Nocturnal HR Dip</div><div class="vital-val">${rhythm.nocturnal_hr_dipping_pct}%</div></div>
    <div class="vital-box"><div class="vital-lbl">Sleep Regularity</div><div class="vital-val">${rhythm.sleep_regularity_index}/100</div></div>
    <div class="vital-box"><div class="vital-lbl">24h Cosinor R²</div><div class="vital-val">${rhythm.hr_cosinor.r_squared}</div></div>
    <div class="vital-box"><div class="vital-lbl">HR-HRV Antiphase</div><div class="vital-val">${rhythm.antiphase_alignment_pct}%</div></div>
  `;
  document.getElementById('pilot-rhythm-findings').innerHTML = (rhythm.rhythm_findings || []).map(f => `
    <div class="list-item">
      <div class="list-item-head">
        <span>${esc(f.title)}</span>
        <span class="status-pill status-${f.severity}">${esc(f.severity)}</span>
      </div>
      <p style="font-size:11.6px;color:var(--ink-2);margin-top:3px">${esc(f.mechanism)}</p>
      <p style="font-size:11.6px;margin-top:3px"><strong>Rhythm Lever:</strong> ${esc(f.lifestyle_lever)}</p>
    </div>
  `).join('');
  requestAnimationFrame(() => drawCosinorRhythmCanvas(rhythm));

  // 3. Yu Project Epigenetics Bridge + ODE Modifiers
  const yu = genomics.yu_epigenetics_bridge || {};
  const accel = Number(yu.epigenetic_age_acceleration_yr || 0);
  document.getElementById('pilot-yu-epigenetics').innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center">
      <strong>${esc(yu.source)}</strong>
      <span class="status-pill ${accel <= 0 ? 'status-optimal' : 'status-watch'}">DNAm Accel: ${accel > 0 ? '+' : ''}${accel} yr</span>
    </div>
    <div class="mono" style="font-size:11.3px;color:var(--ink-2);margin-top:4px">
      Sample: ${esc(yu.sample_id)} (${esc(yu.condition)}) · MethylNet ${yu.methylnet_dnam_age} yr vs ElasticNet ${yu.elasticnet_dnam_age} yr
    </div>
    <p style="font-size:11.5px;color:var(--ink-2);margin-top:4px">${esc(yu.heat_rejuvenation_note)}</p>
  `;

  document.getElementById('pilot-ode-mods').innerHTML = Object.entries(odeMods || {})
    .map(([k, v]) => `<div style="display:flex;justify-content:space-between"><span>${esc(k)}</span><strong>${esc(v)}</strong></div>`)
    .join('');

  // 4. Genetics vs. Modifiable Lifestyle Attribution Matrix
  document.getElementById('pilot-lifestyle-headline').textContent =
    `${genomics.overall_modifiable_lifestyle_pct}% Modifiable Lifestyle vs. ${genomics.overall_genetic_baseline_pct}% Fixed Genetic Baseline`;

  document.getElementById('pilot-attribution-list').innerHTML = (genomics.attribution_axes || []).map(ax => `
    <div class="list-item">
      <div style="display:flex;justify-content:space-between;gap:8px;font-size:12px;font-weight:600">
        <span>${esc(ax.label)}</span>
        <span class="mono">Phenotype Load ${ax.live_phenotype_burden}/100</span>
      </div>
      <div class="attr-dual-bar" title="Genetic Share ${ax.genetic_share_pct}% | Modifiable Lifestyle Share ${ax.modifiable_lifestyle_share_pct}%">
        <div class="attr-seg-gene" style="width:${ax.genetic_share_pct}%"></div>
        <div class="attr-seg-life" style="width:${ax.modifiable_lifestyle_share_pct}%"></div>
      </div>
      <div class="mono" style="display:flex;justify-content:space-between;font-size:10.8px;color:var(--ink-2);margin-top:3px">
        <span>Constitutional Genetics: ${ax.genetic_share_pct}% (Sens ${ax.genetic_sensitivity_score})</span>
        <span style="color:var(--ok);font-weight:600">Modifiable Lifestyle Lever: ${ax.modifiable_lifestyle_share_pct}%</span>
      </div>
    </div>
  `).join('');

  // 5. Modular Multi-Agent Personal Health Council (DS + DE + HC + Orchestrator)
  const bench = council.paper_benchmark_comparison;
  document.getElementById('pilot-council-meta').textContent =
    `${council.cuj_label} · Lead: ${council.lead_specialist} · Executed in ${council.latency_ms} ms (${bench.local_deterministic_speedup_x.toLocaleString()}× faster than 205.3s sequential LLM loop)`;

  document.getElementById('pilot-council-consensus').innerHTML = `
    <div class="list-item" style="border-color:${council.clinical_escalation_triggered ? 'var(--bad)' : 'var(--accent)'}">
      <strong>Orchestrator Consensus Synthesis:</strong>
      <p style="margin-top:4px;font-size:12.4px">${esc(council.executive_consensus)}</p>
    </div>
  `;

  const ds = council.agents.DS;
  const de = council.agents.DE;
  const hc = council.agents.HC;
  document.getElementById('pilot-agents-grid').innerHTML = `
    <div class="list-item">
      <div class="list-item-head"><span>1. ${esc(ds.agent_name)}</span><span class="mono">wt ${Math.round(council.specialist_weights.DS * 100)}%</span></div>
      <ul class="pilot-tight-ul">${ds.findings.map(x => `<li>${esc(x)}</li>`).join('')}</ul>
    </div>
    <div class="list-item">
      <div class="list-item-head"><span>2. ${esc(de.agent_name)}</span><span class="mono">wt ${Math.round(council.specialist_weights.DE * 100)}%</span></div>
      <p style="font-size:11.6px;color:var(--ink-2);margin-top:5px">${esc(de.mechanistic_synthesis)}</p>
      <div class="mono" style="font-size:10.5px;color:var(--ok);margin-top:5px">Curated Grounding: ${esc(de.curated_evidence_sources[0])}</div>
    </div>
    <div class="list-item">
      <div class="list-item-head"><span>3. ${esc(hc.agent_name)}</span><span class="mono">wt ${Math.round(council.specialist_weights.HC * 100)}%</span></div>
      <ul class="pilot-tight-ul">${hc.smart_protocol_steps.map(x => `<li>${esc(x)}</li>`).join('')}</ul>
      <div style="font-size:11.3px;color:var(--accent);margin-top:5px"><strong>Coach Check-In:</strong> ${esc(hc.follow_up_question)}</div>
    </div>
  `;

  document.getElementById('pilot-reflection-checks').innerHTML = (council.reflection_audit || [])
    .map(chk => `<span class="chip" style="cursor:default;font-size:11px">&#10003; ${esc(chk)}</span>`)
    .join('');

  // 6. Evaluated GRCh38 Variants Table (+ AlphaGenome Atlas Links in Non-Commercial Pilot Mode)
  const isAg2 = genomics.effective_engine_mode === 'alphagenome2_noncommercial_pilot';
  const tbody = document.querySelector('#pilot-variants-table tbody');
  tbody.innerHTML = (genomics.evaluated_variants || []).map(v => {
    const ag = v.alphagenome2_pilot;
    const atlasCell = isAg2 && ag
      ? `<a href="${esc(ag.atlas_variant_url)}" target="_blank" rel="noopener noreferrer" class="btn btn-sm" style="display:inline-block;text-decoration:none">Atlas Variant &#8599;</a>
         <a href="${esc(ag.atlas_1mb_locus_url)}" target="_blank" rel="noopener noreferrer" class="btn btn-sm" style="display:inline-block;text-decoration:none;margin-top:2px">1Mb Locus &#8599;</a>
         <div class="mono" style="font-size:10px;color:var(--ink-3);margin-top:2px">Est AVI: ${ag.estimated_avi_impact} · ${esc(ag.single_cell_modality.slice(0, 56))}...</div>`
      : `<span class="mono" style="font-size:11px;color:var(--ok)">Sovereign Score ${v.sovereign_functional_score} · AF ${v.gnomad_af} · LOEUF ${v.gnomad_loeuf}</span>`;

    return `
      <tr>
        <td>
          <strong>${esc(v.gene)}</strong> <span class="mono">${esc(v.rsid)}</span><br/>
          <button type="button" class="chip" data-jump-ont="${esc(v.uberon_id)}" data-jump-lbl="${esc(v.gene)}" style="margin-top:3px;font-size:10.3px">${esc(v.uberon_id)} &rarr; 3D</button>
        </td>
        <td class="mono">${esc(v.locus_grch38)}<br/><span class="status-pill ${v.risk_allele_dosage > 0 ? 'status-watch' : 'status-optimal'}">${esc(v.genotype)} (${esc(v.zygosity)})</span></td>
        <td style="font-size:11.5px">${esc(v.consequence)}<div class="mono" style="font-size:10.3px;color:var(--ink-3);margin-top:2px">GTEx: ${esc(v.gtex_top_tissues)}</div></td>
        <td>${atlasCell}</td>
        <td style="font-size:11.5px">${esc(v.lifestyle_optimization)}</td>
      </tr>
    `;
  }).join('');

  tbody.querySelectorAll('[data-jump-ont]').forEach(btn => {
    btn.addEventListener('click', () => {
      onJumpToOrgan(btn.getAttribute('data-jump-ont'), btn.getAttribute('data-jump-lbl'));
    });
  });
}

function drawCosinorRhythmCanvas(rhythm) {
  const canvas = document.getElementById('pilot-cosinor-canvas');
  if (!canvas || !rhythm?.hourly_24_curve) return;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = Math.max(240, canvas.clientWidth || 320);
  const h = Math.max(135, canvas.clientHeight || 150);
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  const curve = rhythm.hourly_24_curve;
  const padL = 30, padR = 28, padT = 14, padB = 20;
  const pw = w - padL - padR;
  const ph = h - padT - padB;

  const style = getComputedStyle(document.documentElement);
  const ink3 = style.getPropertyValue('--ink-3').trim() || '#777';
  const rule = style.getPropertyValue('--rule').trim() || '#ccc';

  // Shade nocturnal sleep window (23:00 -> 07:00)
  ctx.fillStyle = 'rgba(40, 100, 128, 0.10)';
  ctx.fillRect(padL, padT, (7 / 23) * pw, ph);
  ctx.fillRect(padL + (22.5 / 23) * pw, padT, (0.5 / 23) * pw, ph);

  ctx.strokeStyle = rule;
  ctx.lineWidth = 0.85;
  for (const frac of [0.25, 0.5, 0.75]) {
    const gy = padT + ph * frac;
    ctx.beginPath();
    ctx.moveTo(padL, gy);
    ctx.lineTo(padL + pw, gy);
    ctx.stroke();
  }

  const xOf = (hr) => padL + (hr / 23) * pw;
  const yHr = (bpm) => padT + (1 - (Math.min(95, Math.max(42, bpm)) - 42) / (95 - 42)) * ph;
  const yHrv = (ms) => padT + (1 - (Math.min(90, Math.max(15, ms)) - 15) / (90 - 15)) * ph;

  // Observed HR dots + Fitted Cosinor HR curve (crimson)
  ctx.fillStyle = 'rgba(204, 75, 39, 0.45)';
  curve.forEach(pt => {
    ctx.beginPath();
    ctx.arc(xOf(pt.hour), yHr(pt.obs_hr_bpm), 2.1, 0, Math.PI * 2);
    ctx.fill();
  });

  ctx.strokeStyle = '#cc4b27';
  ctx.lineWidth = 2.1;
  ctx.beginPath();
  curve.forEach((pt, idx) => {
    const x = xOf(pt.hour), y = yHr(pt.fit_hr_bpm);
    if (idx === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  });
  ctx.stroke();

  // Fitted Cosinor HRV curve (emerald)
  ctx.strokeStyle = '#267855';
  ctx.lineWidth = 1.85;
  ctx.setLineDash([4, 2]);
  ctx.beginPath();
  curve.forEach((pt, idx) => {
    const x = xOf(pt.hour), y = yHrv(pt.fit_hrv_ms);
    if (idx === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  });
  ctx.stroke();
  ctx.setLineDash([]);

  ctx.fillStyle = ink3;
  ctx.font = '9.8px monospace';
  ctx.fillText('90bpm', 2, yHr(90) + 3);
  ctx.fillText('50bpm', 2, yHr(50) + 3);
  ctx.fillStyle = '#267855';
  ctx.fillText('80ms', w - 26, yHrv(80) + 3);
  ctx.fillText('25ms', w - 26, yHrv(25) + 3);

  ctx.fillStyle = ink3;
  for (const hTick of [0, 6, 12, 18, 23]) {
    ctx.fillText(`${String(hTick).padStart(2, '0')}h`, xOf(hTick) - 8, h - 4);
  }
}
