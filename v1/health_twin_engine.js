// In-browser port of app/health_twin_engine.py so the participant app runs with no server
// (on a phone, inside the Android build). Data comes from health_twin_data.js, generated
// from the Python file by export_health_twin_data.py. Keep the two in step:
// `node app/test_engine_parity.js` compares both engines on every preset.
(function (root) {
  const DATA = root.HEALTH_TWIN_DATA;

  // Python's round(): halves go to even
  function pyRound(x, n = 0) {
    const m = Math.pow(10, n);
    const y = x * m;
    let r = Math.round(y);
    if (Math.abs(y - Math.trunc(y)) === 0.5) r = 2 * Math.round(y / 2);
    return r / m;
  }
  // str() of a Python float: whole numbers keep ".0"
  const pyFloat = x => (Number.isInteger(x) ? x.toFixed(1) : String(x));
  const fix = (x, d) => pyRound(x, d).toFixed(d);
  const signed = x => (x >= 0 ? '+' : '') + String(x);
  const signedFix = (x, d) => (x >= 0 ? '+' : '') + fix(x, d);
  const num = (v, dflt) => (v === undefined || v === null ? dflt : Number(v));

  function syncGarminSandbox() {
    return {
      mode: 'GARMIN_PERSONAL_API_SANDBOX',
      status: 'Connected to Garmin Connect Personal API v2 Sandbox',
      garmin: JSON.parse(JSON.stringify(DATA.presets.ENDURANCE_IRON_DEPLETED.garmin))
    };
  }

  function evaluate(payload) {
    const P = DATA.presets.ENDURANCE_IRON_DEPLETED;
    const profile = payload.user_profile || P.user_profile;
    const garmin = payload.garmin || P.garmin;
    const blood = (payload.blood_panel || {}).values || P.blood_panel.values;
    const diet = payload.diet || P.diet;

    const weight_kg = num(profile.weight_kg, 72.0);
    const height_cm = num(profile.height_cm, 178.0);
    const age = Math.trunc(num(profile.age, 34));
    const sex = String(profile.sex || 'M').toUpperCase();

    // 1. Blood markers against optimal and risk ranges
    const biomarker_evaluations = [];
    const pen = {
      'SYS:CARDIOVASCULAR': 0, 'SYS:RESPIRATORY': 0, 'SYS:NERVOUS': 0, 'SYS:RENAL': 0, 'SYS:HEPATOBILIARY': 0,
      'SYS:GASTROINTESTINAL': 0, 'SYS:ENDOCRINE': 0, 'SYS:MUSCULOSKELETAL': 0, 'SYS:IMMUNE': 0
    };
    DATA.catalog.forEach(meta => {
      const val = num(blood[meta.code], (meta.optimal_min + meta.optimal_max) / 2);
      const optMin = meta.optimal_min, optMax = meta.optimal_max;
      let status = 'OPTIMAL', severity = 0;
      if ('low_risk' in meta && val < optMin) {
        status = val <= meta.low_risk ? 'DEFICIENT' : 'SUBOPTIMAL_LOW';
        severity = Math.min(1, (optMin - val) / Math.max(1, optMin - meta.low_risk));
      } else if ('high_risk' in meta && val > optMax) {
        status = val >= meta.high_risk ? 'ELEVATED_RISK' : 'BORDERLINE_HIGH';
        severity = Math.min(1, (val - optMax) / Math.max(1, meta.high_risk - optMax));
      }
      pen[meta.organ_system_id] += severity * 18;
      biomarker_evaluations.push({
        code: meta.code, name: meta.name, value: val, unit: meta.unit,
        optimal_range: `${pyFloat(optMin)} – ${pyFloat(optMax)} ${meta.unit}`,
        status, severity: pyRound(severity, 2), organ_system_id: meta.organ_system_id,
        uberon_id: meta.uberon_id, gene_symbol: meta.gene_symbol, role: meta.role
      });
    });

    // 2. Wearable data and recovery
    const rhr = num(garmin.resting_hr_bpm, 54);
    const base_rhr = num(garmin.baseline_rhr_bpm, 50);
    const hrv = num(garmin.hrv_rmssd_ms, 58);
    const base_hrv = num(garmin.baseline_hrv_ms, 65);
    const vo2_max = num(garmin.vo2_max_ml_kg_min, 50.0);
    const sleep_score = num(garmin.sleep_score, 78);
    const sleep_hrs = num(garmin.sleep_duration_hours, 7.3);
    const body_battery = num(garmin.body_battery_score, 70);
    const acute_load = num(garmin.training_load_acute, 550);
    const chronic_load = Math.max(100, num(garmin.training_load_chronic, 550));
    const acwr = pyRound(acute_load / chronic_load, 2);
    const active_kcal = num(garmin.active_kcal, 650);
    const rhr_delta = rhr - base_rhr;
    const hrv_ratio = hrv / Math.max(20, base_hrv);

    if (rhr_delta >= 5 || hrv_ratio < 0.78) { pen['SYS:NERVOUS'] += 18; pen['SYS:CARDIOVASCULAR'] += 10; }
    if (sleep_score < 70) { pen['SYS:NERVOUS'] += 12; pen['SYS:ENDOCRINE'] += 8; }
    if (acwr > 1.30) pen['SYS:MUSCULOSKELETAL'] += 14;

    // 3. Energy used (Mifflin-St Jeor + activity) against food
    const bmr = 10 * weight_kg + 6.25 * height_cm - 5 * age + (sex === 'M' ? 5 : -161);
    const tdee_kcal = pyRound(bmr + bmr * 0.30 + active_kcal);
    const intake_kcal = num(diet.calories_kcal, 2400);
    const energy_balance_kcal = pyRound(intake_kcal - tdee_kcal);
    const fiber_g = num(diet.fiber_g, 25);
    if (fiber_g < 25) pen['SYS:GASTROINTESTINAL'] += 14;

    // 4. Nine system scores
    const organ_scores = DATA.organ_catalog.map(([sys_id, name, uberon_id, color_hex, sim]) => {
      const score = pyRound(Math.max(42, Math.min(99, 96 - (pen[sys_id] || 0))));
      const status = score >= 85 ? 'OPTIMAL' : (score >= 72 ? 'WATCH' : 'ACTION_NEEDED');
      return { organ_system_id: sys_id, name, score, status, uberon_id, color_hex, sim_disease_id: status !== 'OPTIMAL' ? sim : 'NORMAL' };
    });
    const overall = pyRound(organ_scores.reduce((a, o) => a + o.score, 0) / organ_scores.length);
    const readiness = pyRound(
      0.35 * Math.min(100, hrv_ratio * 90) + 0.25 * sleep_score + 0.20 * body_battery +
      0.20 * Math.max(40, 100 - Math.max(0, (acwr - 1) * 65))
    );

    // 5. Findings and suggestions
    const insights = [];
    const recs = [];
    const ferritin = num(blood.FERRITIN, 80), hb = num(blood.HEMOGLOBIN, 14.8), apob = num(blood.APOB, 75);
    const hba1c = num(blood.HBA1C, 5.1), hs_crp = num(blood.HS_CRP, 0.8), ck_mm = num(blood.CK_MM, 150);
    const vit_d = num(blood.VITAMIN_D, 45), cortisol = num(blood.CORTISOL_AM, 14);
    const T = DATA.text;
    const fill = (tpl, vars) => tpl.replace(/\{(\w+)\}/g, (_, k) => (k in vars ? vars[k] : `{${k}}`));

    if (ferritin < 35) {
      insights.push({ severity: 'HIGH', title: T.iron.title, systems: ['SYS:IMMUNE', 'SYS:CARDIOVASCULAR'], uberon_id: 'UBERON:0002371',
        explanation: fill(T.iron.explanation, { ferritin: fix(ferritin, 0), hb: fix(hb, 1), acwr: pyFloat(acwr), rhr_delta: signedFix(rhr_delta, 0) }) });
      recs.push({ priority: 'HIGH_PRIORITY', category: T.iron.category, title: T.iron.rec_title, action: T.iron.action, evidence_gene: 'HBB / HAMP' });
    }
    if (hrv_ratio < 0.82 || acwr > 1.25 || cortisol > 19.5 || energy_balance_kcal < -400) {
      insights.push({ severity: (hrv_ratio < 0.75 || energy_balance_kcal < -500) ? 'HIGH' : 'MODERATE', title: T.recovery.title,
        systems: ['SYS:NERVOUS', 'SYS:ENDOCRINE', 'SYS:MUSCULOSKELETAL'], uberon_id: 'UBERON:0000955',
        explanation: fill(T.recovery.explanation, { hrv: fix(hrv, 0), pct: String(pyRound((1 - hrv_ratio) * 100)), base_hrv: fix(base_hrv, 0),
          cortisol: fix(cortisol, 1), balance: signed(energy_balance_kcal), tdee: String(tdee_kcal) }) });
      recs.push({ priority: 'HIGH_PRIORITY', category: T.recovery.category, title: T.recovery.rec_title,
        action: fill(T.recovery.action, { hr_cap: String(pyRound(180 - age)), base_hrv: fix(base_hrv, 0),
          carbs: String(Math.max(40, pyRound(Math.abs(energy_balance_kcal) / 4))) }), evidence_gene: 'NR3C2 / ADRB1' });
    }
    if (ck_mm > 300 || hs_crp > 1.5) {
      insights.push({ severity: 'MODERATE', title: T.muscle.title, systems: ['SYS:MUSCULOSKELETAL', 'SYS:CARDIOVASCULAR'], uberon_id: 'UBERON:0001134',
        explanation: fill(T.muscle.explanation, { ck: fix(ck_mm, 0), crp: fix(hs_crp, 1), sleep: fix(sleep_hrs, 1) }) });
      const omega = diet.omega3_g === undefined ? 1.0 : diet.omega3_g;
      recs.push({ priority: 'OPTIMIZATION', category: T.muscle.category, title: T.muscle.rec_title,
        action: fill(T.muscle.action, { protein: String(pyRound(weight_kg * 2.0)), omega: String(omega) }),
        evidence_gene: 'CKM / TTN / CRP' });
    }
    if (apob > 85 || hba1c >= 5.6) {
      insights.push({ severity: apob >= 100 ? 'HIGH' : 'MODERATE', title: T.cardiometabolic.title,
        systems: ['SYS:CARDIOVASCULAR', 'SYS:ENDOCRINE', 'SYS:HEPATOBILIARY'], uberon_id: 'UBERON:0001621',
        explanation: fill(T.cardiometabolic.explanation, { apob: fix(apob, 0), hba1c: fix(hba1c, 1), glucose: fix(num(blood.FASTING_GLUCOSE, 90), 0), fiber: fix(fiber_g, 0) }) });
      recs.push({ priority: 'HIGH_PRIORITY', category: T.cardiometabolic.category, title: T.cardiometabolic.rec_title, action: T.cardiometabolic.action, evidence_gene: 'APOB / LDLR / INS /SLC2A4' });
    }
    if (vit_d < 35) {
      recs.push({ priority: 'OPTIMIZATION', category: T.vitamin_d.category, title: T.vitamin_d.rec_title, action: fill(T.vitamin_d.action, { vit_d: fix(vit_d, 0) }), evidence_gene: 'COL1A1 / VDR' });
    }
    if (!insights.length) {
      insights.push({ severity: 'OPTIMAL', title: T.all_clear.title, systems: ['SYS:CARDIOVASCULAR', 'SYS:NERVOUS', 'SYS:ENDOCRINE'], uberon_id: 'UBERON:0000948',
        explanation: fill(T.all_clear.explanation, { hrv: fix(hrv, 0), rhr: fix(rhr, 0), vo2: fix(vo2_max, 0) }) });
      recs.push({ priority: 'MAINTENANCE', category: T.all_clear.category, title: T.all_clear.rec_title, action: T.all_clear.action, evidence_gene: 'PPARGC1A / NOS3' });
    }

    // 6. Food targets and session fuelling
    let carb_per_kg = active_kcal >= 900 ? 5.5 : (active_kcal >= 500 ? 4.2 : 3.2);
    if (hba1c >= 5.7 && active_kcal < 600) carb_per_kg = 2.6;
    const t_protein = pyRound(weight_kg * (ck_mm > 300 || active_kcal > 800 ? 2.1 : 1.8));
    const t_carbs = pyRound(weight_kg * carb_per_kg);
    const t_kcal = hba1c < 5.7 ? tdee_kcal : pyRound(tdee_kcal - 300);
    const t_fat = Math.max(55, pyRound((t_kcal - (t_protein * 4 + t_carbs * 4)) / 9));
    const t_water = pyRound(weight_kg * 0.035 + (active_kcal / 1000) * 1.1, 1);
    const acts = garmin.activities || [];
    // with no activities Python formats the float active_kcal, so keep its trailing .0
    const act = acts[0] || { name: 'Daily Aerobic Conditioning', duration_min: 45, calories_kcal: pyFloat(active_kcal) };
    const F = T.fuel;

    const nutrition_plan = {
      bmr_kcal: pyRound(bmr), tdee_kcal, logged_kcal: pyRound(intake_kcal), energy_balance_kcal,
      targets: { calories_kcal: t_kcal, protein_g: t_protein, carbs_g: t_carbs, fat_g: t_fat, fiber_g: 36, water_liters: t_water,
        sodium_mg: pyRound(2300 + (active_kcal / 600) * 800) },
      workout_fueling_protocol: {
        trigger_activity: `${act.name}, ${act.duration_min} min, ${act.calories_kcal} kcal`,
        pre_workout: fill(F.pre, { carbs: String(pyRound(weight_kg * 0.8)) }),
        intra_workout: num(act.duration_min, 45) >= 60 ? F.intra_long : F.intra_short,
        post_workout: fill(F.post, { protein: String(pyRound(weight_kg * 0.5)), carbs: String(pyRound(weight_kg * 1.1)) })
      },
      biomarker_targeted_foods: [
        { target: ferritin < 50 ? fill(F.iron_target, { ferritin: fix(ferritin, 0) }) : F.endurance_target, foods: ferritin < 50 ? F.iron_foods : F.endurance_foods },
        { target: apob > 80 ? fill(F.apob_target, { apob: fix(apob, 0) }) : F.omega_target, foods: apob > 80 ? F.apob_foods : F.omega_foods },
        { target: fill(F.recovery_target, { hrv: fix(hrv, 0), ck: fix(ck_mm, 0) }), foods: F.recovery_foods }
      ]
    };

    return {
      user_profile: profile,
      garmin_attribution: {
        device_model: garmin.device_model || 'Garmin Wearable',
        api_tier: garmin.api_tier || 'Garmin Connect Personal API v2',
        compliance_notice: `Garmin Connect™ data sourced from ${garmin.device_model || 'Garmin Device'}. Attributed in accordance with Garmin API Brand Guidelines.`
      },
      summary_scores: { overall_health_score: overall, autonomic_readiness_score: readiness, acwr_load_ratio: acwr, vo2_max },
      organ_scores, biomarker_evaluations, cross_modal_insights: insights, recommendations: recs, nutrition_plan, garmin, diet
    };
  }

  root.HealthTwinEngine = { evaluate, syncGarminSandbox, presets: DATA.presets, catalog: DATA.catalog };
  if (typeof module !== 'undefined') module.exports = root.HealthTwinEngine;
})(typeof window !== 'undefined' ? window : globalThis);
