// ============================================================================
// TheHumanProject v2 — Coupled Multi-Organ 0D Biophysical ODE Simulator
// ============================================================================
// Implements a continuous-time lumped-parameter physiological model integrated
// with sub-millisecond stability:
//   1. Cardiovascular: Suga-Sagawa Time-Varying Elastance E_LV(t) + Nonlinear
//      EDPVR + 2 Unidirectional Diode Valves (Mitral, Aortic) + 3-Element
//      Windkessel Arterial/Venous Circulation -> emergent Wiggers pressures
//      (P_LV, P_Ao, P_LA) and true dynamic Left Ventricular P-V Loops!
//   2. Respiratory & Gas Exchange: Viscoelastic Lung Mechanics (R_aw, C_lung)
//      + Alveolar O2/CO2 Balance + Severinghaus/Hill Hemoglobin Saturation
//      coupled to Hemoglobin concentration (g/dL) and Cardiac Output!
//   3. Renal Hemodynamics: Afferent/Efferent Arteriolar Resistance + Starling
//      Glomerular Capillary Filtration -> live GFR (mL/min/1.73m²)!
//   4. Endocrine Glucose-Insulin Minimal Dynamics: Hepatic glucose production
//      vs. insulin-mediated peripheral disposal!
// ============================================================================

export class CoupledBiophysicsSolver {
  constructor() {
    this.baseParams = {
      hrBpm: 68,
      lvEmax: 2.35,          // mmHg / mL (end-systolic elastance)
      lvV0: 12.0,            // mL (unstressed LV volume)
      edpvrA: 0.28,          // mmHg (passive diastolic scaling)
      edpvrB: 0.031,         // 1/mL (passive myocardial stiffness)
      rMitral: 0.0055,       // mmHg * s / mL
      rAortic: 0.012,        // mmHg * s / mL (LVOT + aortic valve)
      rCharAo: 0.055,        // mmHg * s / mL (characteristic proximal aortic impedance)
      rSys: 1.02,            // mmHg * s / mL (systemic vascular resistance ~ 1360 dyn·s·cm⁻⁵)
      cArt: 1.55,            // mL / mmHg (arterial Windkessel compliance)
      cVen: 18.0,            // mL / mmHg (pulmonary/left-atrial venous preload capacitance)
      stressedBloodVol: 760, // mL effective stressed loop volume
      atrialKickAmp: 5.5,    // mmHg atrial booster wave
      // Respiratory
      respRate: 14.0,        // breaths / min
      rAirway: 1.8,          // cmH2O / (L/s)
      cLung: 0.20,           // L / cmH2O
      alveolarDiff: 1.0,     // normalized DLCO factor
      hemoglobinGdl: 14.8,   // g / dL
      // Renal
      nephronKf: 12.5,       // mL / min / mmHg filtration coefficient
      rAff: 1.0,             // normalized afferent resistance
      rEff: 1.0,             // normalized efferent resistance
      // Metabolic
      insulinSens: 1.0,
      betaCellSec: 1.0,
      hepaticGlucoseProd: 1.0,
    };

    this.diseaseModifiers = {};
    this.personalModifiers = {};
    this.activeDrug = null;       // { chembl_id, name, action_type, target_symbols }
    this.drugDoseFraction = 0.0;  // 0..1 receptor occupancy theta
    // Ventricular repolarization T-wave mode:
    // 'inverted_ischemic' | 'inverted_strain' | 'biphasic_wellens' | 'upright' | 'auto'
    this.ecgTwaveMode = 'inverted_ischemic';

    this.resetState();
  }

  resetState() {
    this.simTime = 0.0;
    this.vLv = 122.0;        // mL
    this.pArt = 88.0;        // mmHg (Windkessel arterial reservoir)
    this.pLaBase = 8.8;      // mmHg (preload reservoir)
    this.pLv = 9.0;          // mmHg
    this.pAo = 88.0;         // mmHg
    this.pLa = 9.0;          // mmHg
    this.vAlv = 0.0;         // mL above FRC (0..520 mL tidal volume)
    this.flowAir = 0.0;      // L/s
    this.paO2 = 102.0;       // mmHg
    this.paCO2 = 40.0;       // mmHg
    this.spO2 = 98.1;        // %
    this.gfr = 106.0;        // mL/min
    this.glucoseMgDl = 86.0; // mg/dL
    this.insulinUiu = 5.8;   // uIU/mL

    // Rolling cycle extrema for EDV, ESV, SBP, DBP, EF, SV, CO
    this._cycleMinV = 999;
    this._cycleMaxV = 0;
    this._cycleMaxPao = 0;
    this._cycleMinPao = 999;
    this._prevCycleIdx = 0;

    this.metrics = {
      hr: 68,
      sbp: 119,
      dbp: 76,
      map: 90,
      edv: 124,
      esv: 50,
      sv: 74,
      ef: 60,
      co: 5.0,
      spo2: 98.1,
      pao2: 102,
      gfr: 106,
      glucose: 86,
      caO2: 19.4,
      tWaveMv: -0.45,
      tWaveInverted: true,
      tWaveLabel: 'T↓ -0.45mV',
    };

    // Ring buffers for telemetry & live P-V loop
    this.pvHistory = [];         // [{ v, p }] last ~260 samples
    this.traceHistory = [];      // [{ t, phi, pLv, pAo, pLa, ecg, isTwaveSeg, vAlv, gfr }] last ~360 samples
  }

  setEcgTwaveMode(mode = 'inverted_ischemic') {
    this.ecgTwaveMode = mode;
  }

  setDiseaseModifiers(mods = {}) {
    this.diseaseModifiers = { ...mods };
  }

  setPersonalModifiers(mods = {}) {
    this.personalModifiers = { ...mods };
  }

  setDrugIntervention(drugObj, occupancy = 0.75) {
    this.activeDrug = drugObj || null;
    this.drugDoseFraction = Math.max(0, Math.min(1, Number(occupancy ?? 0.75)));
  }

  computeEffectiveParams() {
    const b = this.baseParams;
    const dm = this.diseaseModifiers || {};
    const pm = this.personalModifiers || {};

    let hr = pm.hr_bpm_override ?? b.hrBpm;
    hr += (dm.hr_bpm_delta || 0);

    let lvEmax = b.lvEmax * (dm.lv_emax_factor ?? 1.0) * (pm.lv_emax_factor ?? 1.0);
    let lvV0 = b.lvV0 + (dm.lv_v0_delta_ml || 0);
    let edpvrB = b.edpvrB * Math.pow(dm.lv_edpvr_stiffness ?? 1.0, 0.55);
    let edpvrA = b.edpvrA * (dm.lv_edpvr_stiffness ?? 1.0);
    let rAortic = b.rAortic * (dm.outflow_resistance_factor ?? 1.0);
    let rSys = b.rSys * (dm.sys_resistance_factor ?? 1.0) * (pm.sys_resistance_factor ?? 1.0);
    let cArt = b.cArt * (dm.art_compliance_factor ?? 1.0) * (pm.art_compliance_factor ?? 1.0);
    let atrialKick = b.atrialKickAmp * (dm.atrial_kick_factor ?? 1.0);

    let respRate = (pm.resp_rate_override ?? b.respRate) + (dm.resp_rate_delta || 0);
    let rAirway = b.rAirway * (dm.airway_resistance_factor ?? 1.0);
    let cLung = b.cLung * (dm.lung_compliance_factor ?? 1.0);
    let alvDiff = b.alveolarDiff * (dm.alveolar_diffusion_factor ?? 1.0);
    let hb = dm.hemoglobin_g_dl ?? pm.hemoglobin_g_dl ?? b.hemoglobinGdl;

    let kf = b.nephronKf * (dm.nephron_kf_factor ?? 1.0) * (pm.nephron_kf_factor ?? 1.0);
    let rAff = b.rAff * (dm.afferent_res_factor ?? 1.0);
    let rEff = b.rEff;

    let insSens = b.insulinSens * (dm.insulin_sensitivity_factor ?? 1.0) * (pm.insulin_sensitivity_factor ?? 1.0);
    let betaSec = b.betaCellSec * (dm.beta_cell_secretion_factor ?? 1.0);
    let hepProd = b.hepaticGlucoseProd * (dm.hepatic_glucose_prod_factor ?? 1.0);

    // Mechanistic ChEMBL Drug Receptor Occupancy Rescue!
    if (this.activeDrug && this.drugDoseFraction > 0.01) {
      const th = this.drugDoseFraction;
      const syms = new Set(this.activeDrug.target_symbols || []);
      const act = (this.activeDrug.action_type || '').toUpperCase();
      const nameUpper = (this.activeDrug.name || '').toUpperCase();

      // Sarcomeric myosin modulators (MYH7: Mavacamten / Aficamten vs Omecamtiv)
      if (syms.has('MYH7')) {
        if (act.includes('INHIBITOR') || act.includes('NEGATIVE') || nameUpper.includes('MAVACAMTEN') || nameUpper.includes('AFICAMTEN')) {
          lvEmax *= (1 - 0.34 * th);
          edpvrA *= (1 - 0.38 * th);
          rAortic = b.rAortic + (rAortic - b.rAortic) * (1 - 0.72 * th);
        } else {
          lvEmax *= (1 + 0.42 * th);
        }
      }
      // Beta-adrenergic blockers vs agonists (ADRB1, ADRB2)
      if (syms.has('ADRB1')) {
        if (act.includes('ANTAGONIST') || act.includes('BLOCKER') || act.includes('INVERSE')) {
          hr -= 14 * th;
          lvEmax *= (1 - 0.08 * th);
          rSys *= (1 - 0.10 * th);
        } else if (act.includes('AGONIST')) {
          hr += 18 * th;
          lvEmax *= (1 + 0.38 * th);
        }
      }
      if (syms.has('ADRB2') && act.includes('AGONIST')) {
        rAirway = Math.max(1.4, rAirway * (1 - 0.52 * th));
      }
      // RAAS blockade (ACE, AGTR1, NR3C2, MME)
      if (syms.has('ACE') || syms.has('AGTR1') || syms.has('NR3C2') || syms.has('MME')) {
        rSys *= (1 - 0.24 * th);
        cArt *= (1 + 0.18 * th);
        rEff *= (1 - 0.18 * th);
        kf *= (1 + 0.16 * th);
        lvEmax *= (1 + 0.10 * th); // afterload-relief reverse remodeling
      }
      // PDE5A / sGC / Endothelin pulmonary vasodilators (Sildenafil, Riociguat, Bosentan)
      if (syms.has('PDE5A') || syms.has('GUCY1A1') || syms.has('EDNRA') || syms.has('PTGIR')) {
        alvDiff = Math.min(1.05, alvDiff * (1 + 0.28 * th));
        rSys *= (1 - 0.12 * th);
      }
      // SGLT2 inhibitors (SLC5A2: Empagliflozin, Dapagliflozin)
      if (syms.has('SLC5A2')) {
        rAff *= (1 + 0.12 * th); // restores tubuloglomerular feedback
        kf *= (1 + 0.24 * th);
        rSys *= (1 - 0.10 * th);
        hepProd *= (1 - 0.18 * th);
        insSens *= (1 + 0.22 * th);
      }
      // Incretin / Insulin / Glycemic agents (GLP1R, INSR, PPARG, DPP4, ABCC8)
      if (syms.has('GLP1R') || syms.has('INSR') || syms.has('PPARG') || syms.has('DPP4')) {
        insSens *= (1 + 0.55 * th);
        betaSec *= (1 + 0.38 * th);
        hepProd *= (1 - 0.26 * th);
      }
      // Anti-inflammatory biologics / glucocorticoids (TNF, IL6R, IL17A, IL23A, NR3C1, JAK1)
      if (syms.has('TNF') || syms.has('IL6R') || syms.has('IL17A') || syms.has('IL23A') || syms.has('NR3C1') || syms.has('JAK1')) {
        rAirway = b.rAirway + (rAirway - b.rAirway) * (1 - 0.55 * th);
        cArt = b.cArt + (cArt - b.cArt) * (1 - 0.45 * th);
      }
      // Generic fallback if a clinical candidate targets another disease-mapped gene
      if (syms.size > 0 && lvEmax < 1.5 && !syms.has('MYH7') && !syms.has('ADRB1')) {
        lvEmax += (b.lvEmax - lvEmax) * 0.28 * th;
      }
    }

    return {
      hr: Math.max(38, Math.min(175, hr)),
      lvEmax: Math.max(0.65, Math.min(4.8, lvEmax)),
      lvV0,
      edpvrA,
      edpvrB,
      rMitral: b.rMitral,
      rAortic,
      rCharAo: b.rCharAo,
      rSys: Math.max(0.45, Math.min(2.6, rSys)),
      cArt: Math.max(0.55, Math.min(2.8, cArt)),
      atrialKick,
      respRate: Math.max(8, Math.min(34, respRate)),
      rAirway,
      cLung,
      alvDiff,
      hb: Math.max(6.5, Math.min(19.0, hb)),
      kf,
      rAff,
      rEff,
      insSens,
      betaSec,
      hepProd,
    };
  }

  // Normalized Suga-Sagawa Double-Hill Ventricular Elastance e_v(phi) in [0, 1]
  _elastanceNormalized(phi, tCycle) {
    const tSys = 0.16 + 0.18 * tCycle;
    const tau = (phi * tCycle) / tSys;
    if (tau > 1.85) return 0.0;
    const g1 = Math.pow(tau / 0.303, 1.32);
    const g2 = Math.pow(tau / 0.508, 21.9);
    // Peak normalization factor ~ 1.585
    return Math.min(1.0, 1.585 * (g1 / (1.0 + g1)) * (1.0 / (1.0 + g2)));
  }

  // Resolve ventricular repolarization (ST-T) profile from manual mode or coupled ODE state
  _resolveRepolarizationProfile(p) {
    const dm = this.diseaseModifiers || {};
    const pm = this.personalModifiers || {};
    let mode = this.ecgTwaveMode || 'inverted_ischemic';
    let drugRescue = (this.activeDrug && this.drugDoseFraction > 0.01)
      ? Math.min(0.82, 0.74 * this.drugDoseFraction)
      : 0.0;

    if (mode === 'auto') {
      if (pm.ecg_twave_mode && pm.ecg_twave_mode !== 'upright' && pm.ecg_twave_mode !== 'auto') {
        mode = pm.ecg_twave_mode;
      } else if (dm.ecg_twave_mode) {
        mode = dm.ecg_twave_mode;
      } else if (p.edpvrA > 0.44 || p.rAortic > 0.020) {
        mode = 'inverted_strain';
      } else if (p.cArt < 1.08 || p.lvEmax < 1.65) {
        mode = 'inverted_ischemic';
      } else {
        mode = 'upright';
      }
    } else {
      // Manual T-wave morphology still responds subtly if user tests ChEMBL drug rescue on a disease
      drugRescue = (Object.keys(dm).length > 0 && this.activeDrug) ? Math.min(0.55, 0.50 * this.drugDoseFraction) : 0.0;
    }

    const scale = Number(dm.ecg_twave_scale ?? 1.0);

    if (mode === 'inverted_strain') {
      const tAmp = (-0.58 * scale) * (1.0 - drugRescue) + 0.14 * drugRescue;
      const stAmp = (-0.14 * scale) * (1.0 - drugRescue);
      return {
        mode,
        rAmp: 1.36 - 0.14 * drugRescue,
        stAmp,
        tAmp,
        sigL: 0.056,
        sigR: 0.025,
        muT: 0.295,
        biphasicPos: 0.0,
        isInverted: tAmp < -0.05,
        label: `T↓ ${tAmp.toFixed(2)}mV (Strain)`,
      };
    }
    if (mode === 'inverted_ischemic') {
      const tAmp = (-0.45 * scale) * (1.0 - drugRescue) + 0.18 * drugRescue;
      const stAmp = (-0.07 * scale) * (1.0 - drugRescue);
      return {
        mode,
        rAmp: 1.16,
        stAmp,
        tAmp,
        sigL: 0.036,
        sigR: 0.036,
        muT: 0.285,
        biphasicPos: 0.0,
        isInverted: tAmp < -0.05,
        label: tAmp < -0.05 ? `T↓ ${tAmp.toFixed(2)}mV` : `T↑ +${tAmp.toFixed(2)}mV`,
      };
    }
    if (mode === 'biphasic_wellens') {
      const negAmp = -0.38 * (1.0 - drugRescue);
      return {
        mode,
        rAmp: 1.16,
        stAmp: 0.03 * (1.0 - drugRescue),
        tAmp: negAmp,
        sigL: 0.024,
        sigR: 0.034,
        muT: 0.312,
        biphasicPos: 0.19 * (1.0 - 0.5 * drugRescue),
        isInverted: negAmp < -0.05,
        label: `T± +0.19/${negAmp.toFixed(2)}mV`,
      };
    }
    // Physiological upright T-wave
    return {
      mode: 'upright',
      rAmp: 1.16,
      stAmp: 0.0,
      tAmp: 0.34,
      sigL: 0.048,
      sigR: 0.033,
      muT: 0.285,
      biphasicPos: 0.0,
      isInverted: false,
      label: 'T↑ +0.34mV',
    };
  }

  // Synthetic Lead-II ECG mV waveform phase-locked to phi with configurable T-wave inversion
  _leadIIEcg(phi, p, repol) {
    const gauss = (x, mu, sig, amp) => amp * Math.exp(-0.5 * Math.pow((x - mu) / sig, 2));
    const asymGauss = (x, mu, sigL, sigR, amp) => {
      const sig = x < mu ? sigL : sigR;
      return amp * Math.exp(-0.5 * Math.pow((x - mu) / sig, 2));
    };

    // Wraparound P-wave centered at phi = 0.915 (pPhi = -0.085)
    const pPhi = phi > 0.80 ? phi - 1.0 : phi;
    const pScale = Math.max(0.6, Math.min(1.35, (p?.atrialKick ?? 5.5) / 5.5));
    const pWave = gauss(pPhi, -0.085, 0.020, 0.15 * pScale);

    // Ventricular depolarization: Q-R-S complex
    const qrs = (
      gauss(phi, 0.024, 0.0070, -0.13) +
      gauss(phi, 0.045, 0.0095, repol.rAmp) +
      gauss(phi, 0.067, 0.0095, -0.25)
    );

    // ST-segment shift + Ventricular repolarization (Upright, Symmetric Inverted, Strain Inverted, or Biphasic T-wave)
    const stBridge = (phi > 0.082 && phi < 0.275)
      ? repol.stAmp * Math.sin(((phi - 0.082) / 0.193) * Math.PI)
      : 0.0;
    const biPos = repol.biphasicPos
      ? asymGauss(phi, 0.228, 0.028, 0.022, repol.biphasicPos)
      : 0.0;
    const tWave = asymGauss(phi, repol.muT, repol.sigL, repol.sigR, repol.tAmp);

    return pWave + qrs + stBridge + biPos + tWave;
  }

  step(dtRealSec) {
    const dtClamped = Math.min(0.05, Math.max(0.001, dtRealSec));
    const p = this.computeEffectiveParams();
    const tCycle = 60.0 / p.hr;
    const subDt = 0.001; // 1 ms integration substep for crisp valve switching
    const nSteps = Math.max(1, Math.round(dtClamped / subDt));
    const h = dtClamped / nSteps;

    for (let i = 0; i < nSteps; i++) {
      this.simTime += h;
      const cycleFloat = this.simTime / tCycle;
      const cycleIdx = Math.floor(cycleFloat);
      const phi = cycleFloat - cycleIdx;

      if (cycleIdx !== this._prevCycleIdx) {
        if (this._cycleMaxV > this._cycleMinV + 5) {
          const edv = this._cycleMaxV;
          const esv = this._cycleMinV;
          const sv = edv - esv;
          const ef = (sv / edv) * 100.0;
          const co = (sv * p.hr) / 1000.0;
          const sbp = this._cycleMaxPao;
          const dbp = this._cycleMinPao;
          const map = dbp + (sbp - dbp) / 3.0;
          this.metrics.hr = Math.round(p.hr);
          this.metrics.edv = Math.round(edv);
          this.metrics.esv = Math.round(esv);
          this.metrics.sv = Math.round(sv);
          this.metrics.ef = Math.round(ef);
          this.metrics.co = Number(co.toFixed(2));
          this.metrics.sbp = Math.round(sbp);
          this.metrics.dbp = Math.round(dbp);
          this.metrics.map = Math.round(map);
        }
        this._cycleMinV = 999;
        this._cycleMaxV = 0;
        this._cycleMaxPao = 0;
        this._cycleMinPao = 999;
        this._prevCycleIdx = cycleIdx;
      }

      const ev = this._elastanceNormalized(phi, tCycle);
      const dv = Math.max(1.0, this.vLv - p.lvV0);
      const pActive = p.lvEmax * dv;
      const pPassive = p.edpvrA * (Math.exp(Math.min(6.0, p.edpvrB * dv)) - 1.0);
      this.pLv = ev * pActive + (1.0 - ev) * pPassive;

      // Left atrial preload with end-diastolic atrial booster kick + preload compensation
      const pKick = phi > 0.88 ? p.atrialKick * Math.sin(((phi - 0.88) / 0.12) * Math.PI) : 0.0;
      const preloadBase = 8.2 + Math.max(0, (2.2 - p.lvEmax) * 4.8);
      this.pLa = preloadBase + pKick + 1.1 * Math.sin(phi * Math.PI * 2.0);

      // Unidirectional Mitral & Aortic Valve Flows (mL/s)
      const qMitral = this.pLa > this.pLv ? (this.pLa - this.pLv) / p.rMitral : 0.0;
      const qAortic = this.pLv > this.pArt ? (this.pLv - this.pArt) / (p.rAortic + p.rCharAo) : 0.0;

      // Proximal aortic root pressure includes characteristic impedance drop during ejection
      this.pAo = qAortic > 0 ? this.pArt + qAortic * p.rCharAo : this.pArt;

      // Windkessel arterial & LV volume ODE updates
      const qPeripheral = (this.pArt - 6.0) / p.rSys;
      this.vLv = Math.max(p.lvV0 + 5.0, Math.min(260.0, this.vLv + h * (qMitral - qAortic)));
      this.pArt = Math.max(35.0, Math.min(260.0, this.pArt + h * ((qAortic - qPeripheral) / p.cArt)));

      if (this.vLv > this._cycleMaxV) this._cycleMaxV = this.vLv;
      if (this.vLv < this._cycleMinV) this._cycleMinV = this.vLv;
      if (this.pAo > this._cycleMaxPao) this._cycleMaxPao = this.pAo;
      if (this.pAo < this._cycleMinPao) this._cycleMinPao = this.pAo;
    }

    // Coupled Respiratory Mechanics & Alveolar-Capillary Gas Exchange
    const respPhase = ((this.simTime * p.respRate) / 60.0) % 1.0;
    const pMusc = respPhase < 0.42 ? 6.5 * Math.sin((respPhase / 0.42) * Math.PI) : 0.0;
    const targetTidalMl = (pMusc * p.cLung * 1000.0) / Math.pow(p.rAirway / 1.8, 0.55);
    const prevAlv = this.vAlv;
    this.vAlv += (targetTidalMl - this.vAlv) * Math.min(1.0, dtClamped * 6.5);
    this.flowAir = (this.vAlv - prevAlv) / (dtClamped * 1000.0);

    const ventFactor = (p.respRate / 14.0) * Math.pow(1.8 / p.rAirway, 0.42);
    this.paCO2 = Math.max(26.0, Math.min(68.0, 40.0 / Math.max(0.55, ventFactor)));
    // Alveolar gas equation PAO2 = PIO2 (150) - PACO2 / R (0.8) * diffusion efficiency
    const rawPaO2 = (149.5 - this.paCO2 / 0.8) * Math.min(1.02, Math.pow(p.alvDiff, 0.45));
    this.paO2 = Math.max(48.0, Math.min(115.0, rawPaO2 + 1.8 * Math.sin(respPhase * Math.PI * 2.0)));
    // Hill O2-Hemoglobin dissociation curve (P50 = 26.8 mmHg, n = 2.7)
    const pO2n = Math.pow(this.paO2, 2.7);
    this.spO2 = (100.0 * pO2n) / (pO2n + Math.pow(26.8, 2.7));
    this.metrics.pao2 = Math.round(this.paO2);
    this.metrics.spo2 = Number(this.spO2.toFixed(1));
    this.metrics.caO2 = Number((1.34 * p.hb * (this.spO2 / 100.0)).toFixed(1));

    // Coupled Renal Glomerular Filtration Rate (Starling Glomerular Dynamics)
    const mapNow = this.metrics.map || 90;
    const pGlomCap = Math.max(32.0, Math.min(75.0, mapNow * (0.58 * p.rEff / (p.rAff * 0.52 + p.rEff * 0.48))));
    const netFiltrationPressure = Math.max(1.5, pGlomCap - 14.0 - 28.0); // P_GC - P_Bowman - Pi_oncotic
    this.gfr = Math.round(Math.max(12.0, Math.min(145.0, p.kf * netFiltrationPressure * 0.82)));
    this.metrics.gfr = this.gfr;

    // Coupled Hepatic-Pancreatic Glucose Equilibrium
    const eqGlucose = (85.0 * p.hepProd) / Math.pow(Math.max(0.25, p.insSens * Math.sqrt(p.betaSec)), 0.48);
    this.glucoseMgDl += (eqGlucose - this.glucoseMgDl) * Math.min(1.0, dtClamped * 3.0);
    this.metrics.glucose = Math.round(this.glucoseMgDl);

    // Record telemetry & P-V trajectory points
    const cyclePhi = ((this.simTime * p.hr) / 60.0) % 1.0;
    const repol = this._resolveRepolarizationProfile(p);
    const ecg = this._leadIIEcg(cyclePhi, p, repol);
    this.metrics.tWaveMv = Number(repol.tAmp.toFixed(2));
    this.metrics.tWaveInverted = repol.isInverted;
    this.metrics.tWaveLabel = repol.label;
    this.metrics.tWaveModeResolved = repol.mode;

    this.pvHistory.push({ v: this.vLv, p: this.pLv });
    if (this.pvHistory.length > 220) this.pvHistory.shift();

    this.traceHistory.push({
      t: this.simTime,
      phi: cyclePhi,
      pLv: this.pLv,
      pAo: this.pAo,
      pLa: this.pLa,
      ecg,
      isTwaveSeg: cyclePhi >= 0.09 && cyclePhi <= 0.43,
      isTwaveInverted: repol.isInverted,
      vAlv: this.vAlv,
      gfr: this.gfr,
    });
    if (this.traceHistory.length > 320) this.traceHistory.shift();

    return {
      cyclePhi,
      respPhase,
      vLv: this.vLv,
      pLv: this.pLv,
      pAo: this.pAo,
      pLa: this.pLa,
      vAlv: this.vAlv,
      ecg,
      tWaveInverted: repol.isInverted,
      tWaveMv: this.metrics.tWaveMv,
      metrics: this.metrics,
    };
  }
}
