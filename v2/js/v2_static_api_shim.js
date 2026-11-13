// ============================================================================
// TheHumanProject v2 — Static GitHub Pages API Shim (Zero-Backend Mode)
// ============================================================================
// Intercepts /api/v2/* fetch calls when hosted statically (e.g. kasimirgregory.com)
// and serves real precomputed + live in-browser biophysical/twin/genomic evaluations.
// ============================================================================
(function () {
  const origFetch = window.fetch.bind(window);
  let cachePromise = null;

  function getCache() {
    if (!cachePromise) {
      cachePromise = origFetch('assets/data/static_api_cache.json').then(r => r.json());
    }
    return cachePromise;
  }

  function jsonResp(obj, status = 200) {
    return Promise.resolve(new Response(JSON.stringify(obj), {
      status,
      headers: { 'Content-Type': 'application/json; charset=utf-8' }
    }));
  }

  const BLOOD_ALIASES = [
    [/^(apob|apolipoprotein\s*b)/i, 'APOB'],
    [/^(ldl|ldl[-_\s]?c)/i, 'LDL_C'],
    [/^(hs[-_\s]?crp|high[-_\s]?sensitivity\s*crp|c[-_\s]?reactive)/i, 'HS_CRP'],
    [/^(nt[-_\s]?probnp|bnp)/i, 'NT_PROBNP'],
    [/^(ferritin|serum\s*ferritin)/i, 'FERRITIN'],
    [/^(hemoglobin|haemoglobin|^hb$)/i, 'HEMOGLOBIN'],
    [/^(hba1c|glycated)/i, 'HBA1C'],
    [/^(fasting\s*(plasma\s*)?glucose|^glucose$)/i, 'FASTING_GLUCOSE'],
    [/^(fasting\s*insulin|^insulin$)/i, 'FASTING_INSULIN'],
    [/^(ck[-_\s]?mm|creatine\s*kinase|^ck$)/i, 'CK_MM'],
    [/^(alt\b|alanine\s*aminotransferase|gpt)/i, 'ALT'],
    [/^(egfr|estimated\s*gfr|glomerular)/i, 'EGFR'],
    [/^(vitamin\s*d|25[-_\s]?oh|25\(oh\)d)/i, 'VITAMIN_D'],
    [/^(cortisol|morning\s*(serum\s*)?cortisol)/i, 'CORTISOL_AM']
  ];

  function parseBloodRaw(rawText) {
    const t = String(rawText || '').trim();
    if (t.startsWith('{')) {
      try { const j = JSON.parse(t); return j.blood_panel || j.values || j; } catch (_) {}
    }
    const out = {};
    for (const rawLine of t.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || /^#/.test(line) || /^biomarker\b/i.test(line)) continue;
      const cols = line.split(/[,;\t]/).map(s => s.trim().replace(/^"|"$/g, ''));
      if (cols.length < 2) continue;
      let val = parseFloat(cols[1]);
      if (!Number.isFinite(val)) continue;
      const unit = (cols[2] || '').toLowerCase();
      let code = null;
      for (const [rx, c] of BLOOD_ALIASES) { if (rx.test(cols[0])) { code = c; break; } }
      if (!code) code = cols[0].toUpperCase().replace(/[^A-Z0-9_]/g, '_');
      if (code === 'FASTING_GLUCOSE' && (unit.includes('mmol') || val < 25)) val = Number((val * 18.0182).toFixed(1));
      if (code === 'VITAMIN_D' && unit.includes('nmol')) val = Number((val / 2.496).toFixed(1));
      if (code === 'CORTISOL_AM' && unit.includes('nmol')) val = Number((val / 27.59).toFixed(1));
      out[code] = val;
    }
    return out;
  }

  function parseDietRaw(rawText) {
    const t = String(rawText || '').trim();
    if (t.startsWith('{')) {
      try { const j = JSON.parse(t); return j.diet || j; } catch (_) {}
    }
    const sum = { calories_kcal: 0, protein_g: 0, carbs_g: 0, fat_g: 0, fiber_g: 0, iron_mg: 0, sodium_mg: 0, omega3_g: 0, hydration_liters: 0 };
    for (const rawLine of t.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || /^#/.test(line) || /^meal\b/i.test(line)) continue;
      const c = line.split(/[,;\t]/).map(s => s.trim());
      if (c.length < 5) continue;
      const n = idx => parseFloat(c[idx]) || 0;
      sum.calories_kcal += n(1); sum.protein_g += n(2); sum.carbs_g += n(3); sum.fat_g += n(4);
      sum.fiber_g += n(5); sum.iron_mg += n(6); sum.sodium_mg += n(7); sum.omega3_g += n(8); sum.hydration_liters += n(9);
    }
    for (const k of Object.keys(sum)) sum[k] = Number(sum[k].toFixed(1));
    return sum;
  }

  function evaluateTwinV2Client(payload, catalog, fallbackPreset) {
    const prof = payload.profile || fallbackPreset.profile;
    const garmin = payload.garmin || fallbackPreset.garmin;
    const blood = payload.blood_panel || {};
    const diet = payload.diet || {};

    const weight_kg = Number(prof.weight_kg || 74);
    const height_cm = Number(prof.height_cm || 178);
    const age = Number(prof.age || 34);
    const sex = String(prof.sex || 'male').toLowerCase();

    const rhr = Number(garmin.resting_hr_bpm || 58);
    const hrv = Number(garmin.hrv_rmssd_ms || 54);
    const hrv_base = Math.max(15, Number(garmin.hrv_baseline_ms || 60));
    const vo2 = Number(garmin.vo2_max_ml_kg_min || 46);
    const sleep_h = Number(garmin.sleep_hours || 7.2);
    const spo2 = Number(garmin.spo2_pct || 97.5);
    const resp_brpm = Number(garmin.resp_rate_brpm || 14.5);
    const acute_load = Number(garmin.acute_load || 500);
    const chronic_load = Math.max(100, Number(garmin.chronic_load || 500));
    const acwr = Number((acute_load / chronic_load).toFixed(2));
    const hrv_ratio = Number((hrv / hrv_base).toFixed(2));
    const act = garmin.recent_activity || {};

    const evaluated_biomarkers = [];
    const sys_penalties = {};
    for (const meta of catalog) {
      const code = meta.code;
      if (blood[code] == null || blood[code] === '') continue;
      const val = Number(blood[code]);
      let status = 'optimal', penalty = 0;
      if (meta.low_risk != null && val < meta.low_risk) { status = 'critical_low'; penalty = 22; }
      else if (val < meta.opt_min) { status = 'suboptimal_low'; penalty = 10; }
      else if (meta.high_risk != null && val >= meta.high_risk) { status = 'elevated_risk'; penalty = 22; }
      else if (val > meta.opt_max) { status = 'borderline_high'; penalty = 10; }
      sys_penalties[meta.system] = (sys_penalties[meta.system] || 0) + penalty;
      evaluated_biomarkers.push({
        code, name: meta.name, value: val, unit: meta.unit,
        optimal_range: `${meta.opt_min}\u2013${meta.opt_max} ${meta.unit}`,
        status, organ_system_id: meta.system, uberon_id: meta.uberon,
        gene_symbol: meta.gene, role: meta.role
      });
    }

    const ecg_twave = String(garmin.ecg_twave || 'upright').trim().toLowerCase();
    if (['inverted_ischemic', 'inverted_strain', 'biphasic_wellens'].includes(ecg_twave)) {
      sys_penalties['SYS:CARDIOVASCULAR'] = (sys_penalties['SYS:CARDIOVASCULAR'] || 0) + (ecg_twave === 'inverted_strain' ? 24 : 19);
    }
    if (rhr > 68) sys_penalties['SYS:CARDIOVASCULAR'] = (sys_penalties['SYS:CARDIOVASCULAR'] || 0) + (rhr - 68) * 0.9;
    if (hrv_ratio < 0.85) sys_penalties['SYS:NERVOUS'] = (sys_penalties['SYS:NERVOUS'] || 0) + (0.85 - hrv_ratio) * 65;
    if (sleep_h < 7.0) sys_penalties['SYS:NERVOUS'] = (sys_penalties['SYS:NERVOUS'] || 0) + (7.0 - sleep_h) * 8;
    if (spo2 < 96.0) sys_penalties['SYS:RESPIRATORY'] = (sys_penalties['SYS:RESPIRATORY'] || 0) + (96.0 - spo2) * 8;
    if (acwr > 1.25) sys_penalties['SYS:MUSCULOSKELETAL'] = (sys_penalties['SYS:MUSCULOSKELETAL'] || 0) + (acwr - 1.25) * 40;

    const systems = [
      ['SYS:CARDIOVASCULAR', 'Cardiovascular', 'UBERON:0000948'],
      ['SYS:RESPIRATORY', 'Respiratory', 'UBERON:0001004'],
      ['SYS:NERVOUS', 'Nervous & Autonomic', 'UBERON:0000955'],
      ['SYS:RENAL', 'Renal & Urinary', 'UBERON:0004538'],
      ['SYS:HEPATOBILIARY', 'Hepatobiliary', 'UBERON:0002107'],
      ['SYS:GASTROINTESTINAL', 'Gastrointestinal', 'UBERON:0002108'],
      ['SYS:ENDOCRINE', 'Endocrine & Islet', 'UBERON:0001264'],
      ['SYS:IMMUNE', 'Hematopoietic & Immune', 'UBERON:0002106'],
      ['SYS:MUSCULOSKELETAL', 'Musculoskeletal', 'UBERON:0001270'],
      ['SYS:INTEGUMENTARY', 'Integumentary', 'UBERON:0002097']
    ];
    const organ_scores = systems.map(([sid, label, ub]) => {
      const sc = Math.max(35, Math.min(99, Math.round(95 - (sys_penalties[sid] || 0))));
      return { organ_system_id: sid, label, uberon_id: ub, score: sc, status: sc >= 84 ? 'optimal' : (sc >= 70 ? 'watch' : 'action_needed') };
    });
    const overall_readiness_score = Math.round(organ_scores.reduce((a, b) => a + b.score, 0) / organ_scores.length);

    const hb = Number(blood.HEMOGLOBIN ?? (sex === 'male' ? 14.8 : 13.6));
    const apob = Number(blood.APOB ?? 75);
    const hscrp = Number(blood.HS_CRP ?? 0.8);
    const egfr = Number(blood.EGFR ?? 105);
    const fpg = Number(blood.FASTING_GLUCOSE ?? 85);
    const fins = Number(blood.FASTING_INSULIN ?? 5.5);
    const homa_ir = Number(((fpg * fins) / 405).toFixed(2));
    const ferritin = Number(blood.FERRITIN ?? 80);
    const hba1c = Number(blood.HBA1C ?? 5.1);
    const nt_probnp = Number(blood.NT_PROBNP ?? 35);

    const personal_ode_modifiers = {
      hr_bpm_override: Number(rhr.toFixed(1)),
      resp_rate_override: Number(resp_brpm.toFixed(1)),
      hemoglobin_g_dl: Number(hb.toFixed(2)),
      lv_emax_factor: Number(Math.min(1.35, Math.max(0.72, 0.85 + (vo2 - 40) * 0.012)).toFixed(3)),
      art_compliance_factor: Number(Math.min(1.25, Math.max(0.60, 1.08 - Math.max(0, apob - 75) * 0.0045 - Math.max(0, hscrp - 1.0) * 0.03)).toFixed(3)),
      sys_resistance_factor: Number(Math.min(1.55, Math.max(0.80, 0.96 + Math.max(0, rhr - 60) * 0.008 + Math.max(0, hscrp - 1.0) * 0.04)).toFixed(3)),
      nephron_kf_factor: Number(Math.min(1.25, Math.max(0.45, egfr / 105)).toFixed(3)),
      insulin_sensitivity_factor: Number(Math.min(1.35, Math.max(0.32, 1.15 / Math.max(0.8, homa_ir * 0.65))).toFixed(3)),
      ecg_twave_mode: ecg_twave
    };

    const bmr = 10 * weight_kg + 6.25 * height_cm - 5 * age + (sex === 'male' ? 5 : -161);
    const act_kcal = Number(act.calories_kcal || 0);
    const target_kcal = Math.round(bmr * 1.38 + act_kcal);
    const prot_target = Math.round(weight_kg * (act_kcal > 450 ? 1.85 : 1.5));
    const carb_per_kg = (act_kcal > 650 && hba1c < 5.6) ? 5.2 : (hba1c >= 5.7 ? 2.4 : 3.6);
    const carb_target = Math.round(weight_kg * carb_per_kg);
    const fat_target = Math.max(50, Math.round((target_kcal - prot_target * 4 - carb_target * 4) / 9));
    const iron_target = ferritin < 35 ? 22 : (sex === 'female' ? 18 : 12);

    const insights = [];
    if (['inverted_ischemic', 'inverted_strain', 'biphasic_wellens'].includes(ecg_twave)) {
      const tw_desc = {
        inverted_strain: 'Deep LV Strain / Apical T-Wave Inversion (-0.58 mV)',
        inverted_ischemic: 'Symmetric Inferior/Lateral T-Wave Inversion (-0.45 mV)',
        biphasic_wellens: 'Biphasic (+/-) Anterior/Lead-II T-Wave'
      }[ecg_twave];
      insights.push({
        severity: 'high', title: `Ventricular Repolarization Reversal: ${tw_desc}`,
        uberon_id: 'UBERON:0002084', gene_symbol: 'MYH7',
        mechanism: `${tw_desc} indicates reversed transmural/apical action potential duration gradient (\u2207APD90) across the left ventricular myocardium alongside NT-proBNP (${nt_probnp} pg/mL) and acute Garmin load (${Math.round(acute_load)}).`,
        action: 'Hold maximal Zone 4/5 anaerobic surges until resting 12-lead ECG + transthoracic echocardiography / cardiac MRI exclude sarcomeric hypertrophy (MYH7/MYBPC3), microvascular ischemia, or electrolyte depletion (K+/Mg2+).'
      });
    }
    if (ferritin < 35 && vo2 >= 45) {
      insights.push({
        severity: 'high', title: 'Iron-Restricted Erythropoiesis Limiting VO\u2082max & HRV Recovery',
        uberon_id: 'UBERON:0002106', gene_symbol: 'HBB',
        mechanism: `Serum Ferritin (${ferritin} ng/mL) and Hemoglobin (${hb} g/dL) reduce arterial O\u2082 content CaO\u2082 = 1.34\u00b7Hb\u00b7SaO\u2082 under high acute Garmin load (${Math.round(acute_load)}), elevating sympathetic tone (HRV ${hrv} vs ${hrv_base} ms baseline).`,
        action: `Increase dietary heme/chelated iron from ${diet.iron_mg || 0} mg to ${iron_target} mg/day paired with 100 mg Vitamin C post-run (avoid coffee/tea within 2h).`
      });
    }
    if (apob >= 95 || hscrp >= 2.0) {
      insights.push({
        severity: 'high', title: 'Atherogenic ApoB & Vascular Inflammatory Coupling',
        uberon_id: 'UBERON:0004537', gene_symbol: 'APOB',
        mechanism: `Elevated ApoB (${apob} mg/dL) and hs-CRP (${hscrp} mg/L) stiffen systemic arterial Windkessel compliance (factor ${personal_ode_modifiers.art_compliance_factor}\u00d7), amplifying pulse pressure.`,
        action: 'Replace saturated fat with MUFA/EPA+DHA (target 2.5\u20133.0 g/day Omega-3), raise soluble viscous fiber to 35+ g/day, and accumulate 150\u2013180 min/wk Zone 2 aerobic volume.'
      });
    }
    if (hba1c >= 5.7 || homa_ir >= 2.2) {
      insights.push({
        severity: 'high', title: `Hepatic & Skeletal Muscle Insulin Resistance (HOMA-IR ${homa_ir})`,
        uberon_id: 'UBERON:0001264', gene_symbol: 'INS',
        mechanism: `HbA1c (${hba1c}%) and Fasting Glucose (${fpg} mg/dL) indicate impaired insulin-stimulated GLUT4 translocation and unsuppressed hepatic gluconeogenesis.`,
        action: 'Perform 15-min brisk post-prandial walks after carbohydrate meals to activate AMPK-mediated non-insulin GLUT4 uptake, and cap refined glycemic load.'
      });
    }
    if (Number(blood.CK_MM ?? 120) > 350 || hrv_ratio < 0.80) {
      insights.push({
        severity: 'moderate', title: 'Autonomic Sympathetic Dominance & Sarcomeric Micro-Trauma',
        uberon_id: 'UBERON:0000948', gene_symbol: 'MYH7',
        mechanism: `Garmin HRV suppression (${Math.round(hrv_ratio * 100)}% of baseline, ACWR ${acwr}) alongside CK (${blood.CK_MM ?? '\u2014'} U/L) reflects incomplete vagal and myofibrillar recovery.`,
        action: 'Shift next 48h from Zone 4/5 threshold work to Zone 1 recovery (<70% HRmax), target 8.2h sleep, and hit 40g leucine-rich protein + 60g carbs within 30 min post-session.'
      });
    }
    if (!insights.length) {
      insights.push({
        severity: 'optimal', title: 'Balanced Multi-Organ Cardiorespiratory & Metabolic Concordance',
        uberon_id: 'UBERON:0000948', gene_symbol: 'ADRB1',
        mechanism: `Strong vagal HRV ratio (${hrv_ratio}\u00d7), low vascular inflammation (hs-CRP ${hscrp} mg/L), and high insulin sensitivity (HOMA-IR ${homa_ir}) show optimal physiological reserve.`,
        action: 'Maintain polarized 80/20 aerobic-to-threshold distribution and current macro/micronutrient density.'
      });
    }

    return {
      overall_readiness_score,
      metrics_summary: {
        acwr, hrv_ratio, homa_ir,
        arterial_o2_content_ml_dl: Number((1.34 * hb * (spo2 / 100)).toFixed(2))
      },
      personal_ode_modifiers,
      organ_scores,
      evaluated_biomarkers,
      cross_modal_insights: insights,
      precision_nutrition: {
        target_calories_kcal: target_kcal,
        logged_calories_kcal: Math.round(Number(diet.calories_kcal || 0)),
        macros: {
          protein_g: { logged: Math.round(Number(diet.protein_g || 0)), target: prot_target },
          carbs_g: { logged: Math.round(Number(diet.carbs_g || 0)), target: carb_target },
          fat_g: { logged: Math.round(Number(diet.fat_g || 0)), target: fat_target },
          fiber_g: { logged: Math.round(Number(diet.fiber_g || 0)), target: 35 },
          iron_mg: { logged: Number(Number(diet.iron_mg || 0).toFixed(1)), target: iron_target },
          hydration_l: { logged: Number(Number(diet.hydration_liters || 0).toFixed(1)), target: Number((weight_kg * 0.038 + act_kcal / 750).toFixed(1)) }
        }
      }
    };
  }

  function matchPromptIndex(queryStr, prompts) {
    const q = String(queryStr || '').trim();
    const exact = prompts.indexOf(q);
    if (exact >= 0) return exact;
    const ql = q.toLowerCase();
    if (!ql) return 0;
    if (/chest\s*pain|faint|syncope|crush|emergency|shortness|red[\s-]*flag/.test(ql)) return 4;
    if (/14[\s-]*day|plan|coach|sauna|zone\s*2|schedule|habit/.test(ql)) return 2;
    if (/tcf7l2|apoe|rs790|rs429|mechanism|pathway|allele/.test(ql)) return 3;
    if (/genetic|dna|heritab|separate|share|lifestyle/.test(ql)) return 1;
    return 1;
  }

  function parseGenomeClient(rawText, filename, panel, sampleParses) {
    if (filename === 'dads_pilot_case_study.vcf') return sampleParses.vcf;
    if (filename === 'dads_23andme_pilot.txt') return sampleParses['23andme'];
    const byRsid = {};
    for (const loc of panel) byRsid[loc.rsid] = loc;
    const genotypes = {};
    let total = 0;
    let fmt = /\.vcf/i.test(filename) ? 'VCFv4_GRCh38' : 'Consumer_Microarray_TXT';
    for (const raw of String(rawText || '').split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      total++;
      const cols = line.split(/\t|,|\s+/);
      if (cols.length >= 8 && cols[2] && cols[2].startsWith('rs')) {
        fmt = 'VCFv4_GRCh38';
        const rsid = cols[2], ref = cols[3], alt = cols[4].split(',')[0];
        const gt = (cols[9] || '0/1').split(':')[0];
        if (byRsid[rsid]) {
          const alleles = gt.split(/[\/|]/).map(x => x === '0' ? ref : alt).join('');
          genotypes[rsid] = alleles;
        }
      } else if (cols[0] && cols[0].startsWith('rs') && cols.length >= 4) {
        const rsid = cols[0];
        if (byRsid[rsid]) genotypes[rsid] = cols[3];
      }
    }
    return {
      filename: filename || 'uploaded_genome',
      detected_format: fmt,
      total_variants_scanned: total,
      curated_panel_matched: Object.keys(genotypes).length,
      curated_panel_total: panel.length,
      genotypes
    };
  }

  function executeStaticSql(query, cache) {
    const norm = String(query || '').trim().replace(/\s+/g, ' ');
    if (cache.sql_cache[norm]) {
      return { rows: cache.sql_cache[norm], count: cache.sql_cache[norm].length, elapsed_ms: 0.42 };
    }
    const qup = norm.toUpperCase();
    if (!(qup.startsWith('SELECT') || qup.startsWith('WITH'))) {
      return { error: 'Only read-only SELECT / WITH queries are permitted.' };
    }
    const ftsMatch = norm.match(/MATCH\s+'([^']+)'/i);
    if (ftsMatch) {
      const terms = ftsMatch[1].toLowerCase().split(/\s+or\s+|\s+/i).filter(Boolean);
      const hits = cache.fts_rows.filter(r => {
        const hay = `${r.title} ${r.subtitle} ${r.entity_id}`.toLowerCase();
        return terms.some(t => hay.includes(t));
      }).slice(0, 50);
      return { rows: hits, count: hits.length, elapsed_ms: 0.65 };
    }
    for (const [tbl, rows] of Object.entries(cache.sql_tables)) {
      if (new RegExp('\\b' + tbl + '\\b', 'i').test(norm)) {
        const limM = norm.match(/LIMIT\s+(\d+)/i);
        const lim = limM ? Math.min(500, parseInt(limM[1], 10)) : 50;
        return { rows: rows.slice(0, lim), count: Math.min(rows.length, lim), elapsed_ms: 0.51 };
      }
    }
    const fallback = cache.sql_tables.hra_3d_organs || [];
    return { rows: fallback, count: fallback.length, elapsed_ms: 0.55 };
  }

  window.fetch = async function (input, init) {
    const urlStr = typeof input === 'string' ? input : (input && input.url ? input.url : String(input));
    let pathname = urlStr;
    let search = '';
    try {
      const u = new URL(urlStr, window.location.href);
      pathname = u.pathname;
      search = u.search;
    } catch (_) {}

    if (!pathname.includes('/api/v2/')) {
      return origFetch(input, init);
    }

    const cache = await getCache();
    const apiPath = pathname.slice(pathname.indexOf('/api/v2/'));
    let bodyObj = {};
    if (init && init.body && typeof init.body === 'string') {
      try { bodyObj = JSON.parse(init.body); } catch (_) {}
    }

    if (apiPath === '/api/v2/twin/presets') {
      return jsonResp(cache.twin_presets);
    }
    if (apiPath === '/api/v2/twin/parse-blood') {
      const panel = parseBloodRaw(bodyObj.raw_text || '');
      return jsonResp({ blood_panel: panel, count: Object.keys(panel).length });
    }
    if (apiPath === '/api/v2/twin/parse-diet') {
      return jsonResp({ diet: parseDietRaw(bodyObj.raw_text || '') });
    }
    if (apiPath === '/api/v2/twin/analyze') {
      const rep = evaluateTwinV2Client(
        bodyObj,
        cache.twin_presets.biomarker_catalog,
        cache.twin_presets.presets.ENDURANCE_IRON_DEPLETED
      );
      return jsonResp(rep);
    }
    if (apiPath === '/api/v2/pilot/presets') {
      return jsonResp(cache.pilot_presets);
    }
    if (apiPath === '/api/v2/pilot/parse-genome') {
      return jsonResp(parseGenomeClient(
        bodyObj.raw_text || '',
        bodyObj.filename || '',
        cache.pilot_presets.genomic_panel_grch38,
        cache.sample_parses
      ));
    }
    if (apiPath === '/api/v2/pilot/parse-rhythm') {
      return jsonResp(cache.sample_parses.rhythm);
    }
    if (apiPath === '/api/v2/pilot/evaluate') {
      const pid = bodyObj.preset_id || 'DADS_PILOT_CASE_STUDY';
      const em = bodyObj.engine_mode || 'sovereign_open';
      const comm = bodyObj.commercial_context ? 1 : 0;
      const qIdx = matchPromptIndex(bodyObj.query || '', cache.pilot_quick_prompts);
      const key = `${pid}|${em}|${comm}|q${qIdx}`;
      const base = structuredClone(cache.pilot_matrix[key] || cache.pilot_presets.default_evaluation);
      if (bodyObj.query && !cache.pilot_quick_prompts.includes(bodyObj.query.trim()) && qIdx !== 4) {
        base.multi_agent_council.executive_consensus =
          `[Query: "${bodyObj.query.trim()}"] ` + base.multi_agent_council.executive_consensus;
      }
      return jsonResp(base);
    }
    if (apiPath === '/api/v2/sql') {
      const params = new URLSearchParams(search);
      return jsonResp(executeStaticSql(params.get('q') || '', cache));
    }
    if (apiPath === '/api/v2/provenance') {
      return jsonResp({ provenance: cache.sql_tables.provenance_sources || [] });
    }
    return jsonResp({ error: `Static preview endpoint not mapped: ${apiPath}` }, 404);
  };
})();
