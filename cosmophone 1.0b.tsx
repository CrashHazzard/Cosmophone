import { useState, useEffect, useRef, useCallback } from "react";
// ─── ÆtherEngine.js — Æther Engine v0.5 ─────────────────────────────────────
// Shared audio engine for the Bubble Workstation.
// Covers both Cosmophone (theremin/pad, persistent voice pool) and
// NeutronDrop (step sequencer, scheduled per-note voices).
//
// ── Cosmophone API (persistent pool) ─────────────────────────────────────────
//   eng.unlock()
//   eng.start("sine")                      // create persistent pool, begin graph
//   eng.setVoiceFreq(i, freq, glideTime)
//   eng.setVoiceGain(i, gain)
//   eng.setVoiceWarble(i, rate, depthHz)
//   eng.setWaveform("PULSAR")
//   eng.silenceAll()
//   eng.kick()                             // re-assert after iOS resume
//   eng.previewNote(freq, wave, dur, gain) // one-shot through fx chain
//   eng.pbStart() / pbSet / pbSilence / pbSilenceAll / pbRoute
//   eng.isStarted() / hasBuses() / MAXV / PB_VOICES
//
// ── NeutronDrop API (scheduled voices) ───────────────────────────────────────
//   eng.setMaster(0..1)                    // cubed gain master (ND volume slider)
//   eng.playNoteWithRamps(trackId, wave, freq, t, vol, sustainSec, glideSec,
//                         ramps, opts, gainRamps)
//   eng.playNote(trackId, wave, freq, t, vol, sustainSec, glideSec)
//   eng.preview(wave, freq, durSec, opts)  // one-shot preview matching voice
//   eng.auditionStart(wave, freq, opts)    // continuous theremin-style slide
//   eng.auditionGlide(freq)
//   eng.stopAudition()
//   eng.resetGlide()
//   eng.killAll()
//   eng.accentFilter(atTime, amount, decaySec)
//
// ── Effects (both apps) ───────────────────────────────────────────────────────
//   eng.setOverdrive({ on, amount, mode }) // mode: "overdrive" | "distortion"
//   eng.setDrive({ on, amount, mode })     // alias for setOverdrive (ND name)
//   eng.setFilter({ on, cutoff, resonance })
//   eng.setDelay({ on?, mix, time, feedback })
//   eng.setChorus({ mix, rate, depth })
//   eng.setPhaser({ on?, mix, rate, depth })
//   eng.setReverb({ on?, mix, size })
//   eng.setPresence(db)
//
// ── Waveform names ────────────────────────────────────────────────────────────
//   Basic:   "sine" | "triangle" | "sawtooth" | "square"
//   Presets: "PULSAR" | "GLASS" | "VOID" | "AEON" | "QUASAR" |
//            "TITAN"  | "ORION" | "CORONA" | "NEBULA" | "TIDE"
//   Special: "USER" — pass userTable: { real, imag, sig } in opts
//
// ── FX chain ──────────────────────────────────────────────────────────────────
//   ndMaster (ND cubed gain) ─┐
//   pool voices               ├─→ driveIn → filter → wetIn
//   pb voices                 │                     → delay → chorus → phaser
//                             │                     → reverb → shelf → outGain
//   dryIn ────────────────────┘ (bypasses wet chain) → shelf → outGain
// ─────────────────────────────────────────────────────────────────────────────

// ── Wavetable presets ─────────────────────────────────────────────────────────
const OSC_PRESETS = {
  PULSAR:  [0,1,0.6,0.3,0.15,0.08,0.04,0.02,0.01],
  GLASS:   [0,1,0,0.5,0,0.25,0,0.1,0,0.05],
  VOID:    [0,0.2,0.5,1,0.7,0.4,0.2,0.1,0.05,0.02],
  AEON:    [0,1,0.5,0,0.25,0,0.1,0,0.05,0,0.02],
  QUASAR:  [0,1,0.8,0.6,0.4,0.3,0.2,0.15,0.1,0.07,0.05],
  TITAN:   [0,1,0,0,0.5,0,0,0.25,0,0,0.1,0,0,0.05],
  ORION:   [0,1,0.7,0.5,0.3,0.1,0.3,0.5,0.7,0.1,0.05],
  CORONA:  [0,1,0.9,0.7,0.5,0.3,0.15,0.07,0.03,0.01],
  NEBULA:  [0,0.5,1,0.5,0,0.3,0.6,0.3,0,0.15,0.3,0.15],
  TIDE:    [0,1,0,0.33,0,0.2,0,0.14,0,0.11,0,0.09],
};
const PRESET_NAMES = Object.keys(OSC_PRESETS);
const BASIC_WAVES  = ["sine","sawtooth","square","triangle"];
const isPreset = (name) => PRESET_NAMES.includes(name);

function createAudioEngine() {
  let ctx = null, started = false;
  const MAXV = 5;

  // ── Persistent pool voices (Cosmophone) ──
  const voices = []; // { osc, warbleOsc, warbleGain, gain, freq }

  // ── Scheduled voices (NeutronDrop) ──
  let scheduledVoices = []; // { o, g, mod }
  let audition = null;      // continuous audition voice
  const lastFreq = {};      // per-track glide tracking

  let busesReady = false;
  let wetIn = null, dryIn = null, outGain = null;
  let poolMaster = null;  // entry point for persistent pool → fx chain
  let ndMaster   = null;  // cubed-gain GainNode for ND volume slider → fx chain
  let fx = null;
  let periodicCache = {};

  // ── Context ───────────────────────────────────────────────────────────────
  function getCtx() {
    if (!ctx) {
      ctx = new (window.AudioContext || window.webkitAudioContext)();
      periodicCache = {};
    }
    if (ctx.state === "suspended") ctx.resume();
    return ctx;
  }

  function getCtxRaw() { return ctx; }

  function unlock() {
    const c = getCtx();
    if (c.state === "suspended") { try { c.resume(); } catch(_){} }
    return c;
  }

  // ── PeriodicWave helpers ──────────────────────────────────────────────────
  function basicWaveTable(type) {
    const N = 33;
    const imag = new Float32Array(N);
    if (type === "sine") {
      imag[1] = 1;
    } else if (type === "sawtooth") {
      for (let n = 1; n < N; n++) imag[n] = 1 / n;
    } else if (type === "square") {
      for (let n = 1; n < N; n += 2) imag[n] = 1 / n;
    } else { // triangle
      let sign = 1;
      for (let n = 1; n < N; n += 2) { imag[n] = sign / (n * n); sign = -sign; }
    }
    return imag;
  }

  function getPeriodicWave(waveName) {
    const key = waveName;
    if (periodicCache[key]) return periodicCache[key];
    let imag, real;
    if (isPreset(waveName)) {
      imag = Float32Array.from(OSC_PRESETS[waveName]);
      real = new Float32Array(imag.length);
    } else {
      const basicName = BASIC_WAVES.includes(waveName) ? waveName : "sine";
      imag = basicWaveTable(basicName);
      real = new Float32Array(imag.length);
    }
    const pw = ctx.createPeriodicWave(real, imag, { disableNormalization: false });
    periodicCache[key] = pw;
    return pw;
  }

  // applyWave — 3-arg form supports USER waveform (NeutronDrop).
  // userTable = { real, imag, sig } as produced by samplesToUserTable().
  // 2-arg form (Cosmophone) simply omits userTable.
  function applyWave(osc, waveName, userTable) {
    if (waveName === "USER" && userTable && userTable.real && userTable.imag) {
      const key = "USER:" + userTable.sig;
      let pw = periodicCache[key];
      if (!pw) {
        const real = Float32Array.from(userTable.real);
        const imag = Float32Array.from(userTable.imag);
        pw = ctx.createPeriodicWave(real, imag, { disableNormalization: false });
        periodicCache[key] = pw;
      }
      osc.setPeriodicWave(pw);
      return;
    }
    osc.setPeriodicWave(getPeriodicWave(waveName));
  }

  // ── Impulse response ─────────────────────────────────────────────────────
  function makeImpulse(c, seconds, decay) {
    const rate = c.sampleRate, len = Math.max(1, Math.floor(rate * seconds));
    const buf = c.createBuffer(2, len, rate);
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
    }
    return buf;
  }

  // ── Effects chain ─────────────────────────────────────────────────────────
  // Signal path:
  //   poolMaster (persistent pool) ─┐
  //   ndMaster   (ND scheduled)    ─┤→ driveIn → [shaper] → driveOut
  //                                  │→ filter → wetIn
  //                                  │→ delay → chorus → phaser → reverb → shelf → outGain
  //   dryIn ─────────────────────────┘→ shelf → outGain
  //
  // Filter is always in the wet chain. At rest (filter off) cutoff=18kHz, Q=1
  // so it's transparent. ND activates it; Cosmophone leaves it at rest.
  function ensureBuses() {
    if (busesReady) return;
    const c = getCtx();

    outGain = c.createGain(); outGain.gain.value = 1.4; outGain.connect(c.destination);
    dryIn   = c.createGain(); dryIn.gain.value = 1.0;
    wetIn   = c.createGain(); wetIn.gain.value = 1.0;

    // ── OVERDRIVE / DRIVE ──
    const driveIn      = c.createGain(); driveIn.gain.value = 1;
    const driveWet     = c.createGain(); driveWet.gain.value = 0;
    const driveDry     = c.createGain(); driveDry.gain.value = 1;
    const driveOut     = c.createGain(); driveOut.gain.value = 1;
    const shaper       = c.createWaveShaper(); shaper.oversample = "4x";
    const postDriveGain = c.createGain(); postDriveGain.gain.value = 1;
    driveIn.connect(driveDry); driveDry.connect(driveOut);
    driveIn.connect(shaper); shaper.connect(driveWet); driveWet.connect(postDriveGain);
    postDriveGain.connect(driveOut);

    // ── FILTER — transparent at rest (18kHz, Q=1); ND activates ──
    const filt = c.createBiquadFilter();
    filt.type = "lowpass"; filt.frequency.value = 18000; filt.Q.value = 1;
    driveOut.connect(filt);
    filt.connect(wetIn);

    // ── DELAY ──
    const dIn = c.createGain(), dOut = c.createGain();
    const dDry = c.createGain(); dDry.gain.value = 1;
    const dWet = c.createGain(); dWet.gain.value = 0;
    const delay = c.createDelay(2.0); delay.delayTime.value = 0.3;
    const dFb = c.createGain(); dFb.gain.value = 0.3;
    dIn.connect(dDry); dDry.connect(dOut);
    dIn.connect(delay); delay.connect(dWet); dWet.connect(dOut);
    delay.connect(dFb); dFb.connect(delay);

    // ── CHORUS ──
    const chIn = c.createGain(), chOut = c.createGain();
    const chDry = c.createGain(); chDry.gain.value = 1;
    const chWet = c.createGain(); chWet.gain.value = 0;
    chIn.connect(chDry); chDry.connect(chOut);
    const mkChorusLine = (baseMs, rate) => {
      const dl = c.createDelay(0.05); dl.delayTime.value = baseMs / 1000;
      const lfo = c.createOscillator(); lfo.type = "sine"; lfo.frequency.value = rate;
      const lfoG = c.createGain(); lfoG.gain.value = 0.002;
      lfo.connect(lfoG); lfoG.connect(dl.delayTime); lfo.start();
      chIn.connect(dl); dl.connect(chWet);
      return { dl, lfo, lfoG };
    };
    const chL = mkChorusLine(18, 0.6), chR = mkChorusLine(23, 0.5);
    chWet.connect(chOut);

    // ── PHASER ──
    const phIn = c.createGain(), phOut = c.createGain();
    const phDry = c.createGain(); phDry.gain.value = 1;
    const phWet = c.createGain(); phWet.gain.value = 0;
    phIn.connect(phDry); phDry.connect(phOut);
    const aps = []; let prev = phIn;
    for (let i = 0; i < 4; i++) {
      const ap = c.createBiquadFilter(); ap.type = "allpass"; ap.frequency.value = 400 + i * 250;
      prev.connect(ap); prev = ap; aps.push(ap);
    }
    prev.connect(phWet); phWet.connect(phOut);
    const phLfo = c.createOscillator(); phLfo.type = "sine"; phLfo.frequency.value = 0.4;
    const phLfoG = c.createGain(); phLfoG.gain.value = 0;
    phLfo.connect(phLfoG); aps.forEach(ap => phLfoG.connect(ap.frequency)); phLfo.start();

    // ── REVERB ──
    const rvIn = c.createGain(), rvOut = c.createGain();
    const rvDry = c.createGain(); rvDry.gain.value = 1;
    const rvWet = c.createGain(); rvWet.gain.value = 0;
    const conv = c.createConvolver(); conv.buffer = makeImpulse(c, 2.2, 2.5);
    rvIn.connect(rvDry); rvDry.connect(rvOut);
    rvIn.connect(conv); conv.connect(rvWet); rvWet.connect(rvOut);

    // ── PRESENCE shelf ──
    const shelf = c.createBiquadFilter();
    shelf.type = "highshelf"; shelf.frequency.value = 3500; shelf.gain.value = 0;
    shelf.connect(outGain);

    // Chain: wetIn → delay → chorus → phaser → reverb → shelf → outGain
    wetIn.connect(dIn); dOut.connect(chIn); chOut.connect(phIn); phOut.connect(rvIn); rvOut.connect(shelf);
    dryIn.connect(shelf);

    fx = {
      drive:  { in: driveIn, wet: driveWet, dry: driveDry, out: driveOut, shaper, postGain: postDriveGain },
      filter: { node: filt },
      delay:  { wet: dWet, dry: dDry, delay, fb: dFb },
      chorus: { wet: chWet, dry: chDry, lines: [chL, chR] },
      phaser: { wet: phWet, dry: phDry, lfo: phLfo, lfoG: phLfoG, aps },
      reverb: { wet: rvWet, dry: rvDry, conv },
      shelf,
    };

    // poolMaster: persistent pool voices → driveIn (Cosmophone)
    poolMaster = driveIn;

    // ndMaster: ND scheduled voices → driveIn, with cubed gain for volume slider
    ndMaster = c.createGain();
    ndMaster.gain.value = 0.85 * 0.85 * 0.85;
    ndMaster.connect(driveIn);

    busesReady = true;
  }

  // ── Effect setters ────────────────────────────────────────────────────────
  // Setters accept both Cosmophone form { mix, ... } and NeutronDrop form
  // { on, mix, ... }. When `on` is present, mix is gated by it.

  function makeDriveCurve(amount, mode) {
    const n = 256, curve = new Float32Array(n);
    const k = mode === "distortion" ? amount * 400 + 1 : amount * 100 + 1;
    for (let i = 0; i < n; i++) {
      const x = (i * 2) / n - 1;
      if (mode === "distortion") {
        curve[i] = Math.max(-1, Math.min(1, x * k / (1 + Math.abs(x * k)) * 1.5));
      } else {
        curve[i] = Math.tanh(x * k) / Math.tanh(k);
      }
    }
    return curve;
  }

  // setOverdrive — Cosmophone name; setDrive is the NeutronDrop alias.
  function setOverdrive({ on, amount, mode }) {
    if (!fx) return;
    const c = getCtx(), n = c.currentTime;
    if (on && amount > 0.01) {
      fx.drive.shaper.curve = makeDriveCurve(amount, mode || "overdrive");
      fx.drive.wet.gain.setTargetAtTime(1, n, 0.05);
      fx.drive.dry.gain.setTargetAtTime(0, n, 0.05);
      fx.drive.postGain.gain.setTargetAtTime(Math.max(0.3, 1 - amount * 0.5), n, 0.05);
    } else {
      fx.drive.wet.gain.setTargetAtTime(0, n, 0.05);
      fx.drive.dry.gain.setTargetAtTime(1, n, 0.05);
    }
  }
  const setDrive = setOverdrive;

  // setFilter — NeutronDrop lowpass with resonance + accent state.
  // Cosmophone doesn't call this; filter rests transparent at 18kHz.
  function setFilter({ on, cutoff, resonance }) {
    if (!fx) return;
    const c = getCtxRaw(); if (!c) return;
    const n = c.currentTime;
    const freq = on ? Math.max(80, Math.min(18000, cutoff)) : 18000;
    fx.filter.node.frequency.setTargetAtTime(freq, n, 0.05);
    fx.filter.node.Q.setTargetAtTime(on ? resonance : 1, n, 0.05);
    fx._filterBase = freq;
    fx._filterOn = on;
  }

  // accentFilter — 303-style filter bump. No-op when filter is off.
  function accentFilter(atTime, amount = 0.6, decaySec = 0.18) {
    if (!fx || !fx._filterOn) return;
    const base = fx._filterBase ?? 2000;
    const peak = Math.min(18000, base + (18000 - base) * amount);
    const p = fx.filter.node.frequency;
    p.setValueAtTime(peak, atTime);
    p.setTargetAtTime(base, atTime + 0.005, decaySec);
  }

  function setDelay({ on, mix, time, feedback }) {
    if (!fx) return; const c = getCtx(), n = c.currentTime;
    const m = (on != null) ? (on ? (mix ?? 0.3) : 0) : mix;
    if (m != null) fx.delay.wet.gain.setTargetAtTime(m, n, 0.05);
    if (time != null) fx.delay.delay.delayTime.setTargetAtTime(time, n, 0.05);
    if (feedback != null) fx.delay.fb.gain.setTargetAtTime(feedback, n, 0.05);
  }

  function setChorus({ mix, rate, depth }) {
    if (!fx) return; const c = getCtx(), n = c.currentTime;
    if (mix != null) fx.chorus.wet.gain.setTargetAtTime(mix, n, 0.05);
    fx.chorus.lines.forEach(L => {
      if (rate != null) L.lfo.frequency.setTargetAtTime(rate, n, 0.05);
      if (depth != null) L.lfoG.gain.setTargetAtTime(depth * 0.004, n, 0.05);
    });
  }

  function setPhaser({ on, mix, rate, depth }) {
    if (!fx) return; const c = getCtx(), n = c.currentTime;
    const m = (on != null) ? (on ? (mix ?? 0.5) : 0) : mix;
    if (m != null) fx.phaser.wet.gain.setTargetAtTime(m, n, 0.05);
    if (rate != null) fx.phaser.lfo.frequency.setTargetAtTime(rate, n, 0.05);
    if (depth != null) fx.phaser.lfoG.gain.setTargetAtTime(depth * 900, n, 0.05);
  }

  function setReverb({ on, mix, size }) {
    if (!fx) return; const c = getCtx(), n = c.currentTime;
    const m = (on != null) ? (on ? (mix ?? 0.3) : 0) : mix;
    if (m != null) fx.reverb.wet.gain.setTargetAtTime(m, n, 0.05);
    if (size != null) fx.reverb.conv.buffer = makeImpulse(c, 0.5 + size * 3.5, 2.5);
  }

  function setPresence(db) {
    if (!fx) return;
    fx.shelf.gain.setTargetAtTime(db, getCtx().currentTime, 0.05);
  }

  // ── NeutronDrop master gain ───────────────────────────────────────────────
  // Cubed taper: linear 0..1 slider → perceptually even volume travel.
  function setMaster(v) {
    ensureBuses();
    const curved = Math.max(0.0001, v * v * v);
    const c = getCtxRaw();
    if (c) ndMaster.gain.setTargetAtTime(curved, c.currentTime, 0.02);
    else ndMaster.gain.value = curved;
  }

  // ── Persistent voice pool (Cosmophone) ───────────────────────────────────
  function start(waveform) {
    ensureBuses();
    if (started) return;
    const c = getCtx();
    const pw = getPeriodicWave(waveform);
    for (let i = 0; i < MAXV; i++) {
      const osc = c.createOscillator();
      osc.setPeriodicWave(pw);
      const warbleOsc = c.createOscillator();
      warbleOsc.type = "sine"; warbleOsc.frequency.value = 0;
      const warbleGain = c.createGain(); warbleGain.gain.value = 0;
      warbleOsc.connect(warbleGain); warbleGain.connect(osc.frequency);
      const gain = c.createGain(); gain.gain.value = 0;
      osc.connect(gain); gain.connect(poolMaster);
      osc.start(); warbleOsc.start();
      voices.push({ osc, warbleOsc, warbleGain, gain, freq: 440 });
    }
    started = true;
  }

  function stop() {
    if (!started) return;
    voices.forEach(v => { try { v.osc.stop(); v.warbleOsc.stop(); } catch(_){} });
    voices.length = 0;
    started = false;
  }

  function setWaveform(w) { voices.forEach(v => applyWave(v.osc, w)); }

  function setVoiceFreq(i, freq, glideTime) {
    const v = voices[i]; if (!v) return;
    const c = getCtx(), now = c.currentTime;
    v.freq = freq;
    v.osc.frequency.cancelScheduledValues(now);
    if (glideTime > 0.001) v.osc.frequency.setTargetAtTime(freq, now, glideTime / 3);
    else v.osc.frequency.setValueAtTime(freq, now);
  }

  function setVoiceGain(i, g) {
    const v = voices[i]; if (!v) return;
    v.gain.gain.setTargetAtTime(Math.max(0, Math.min(1, g)), getCtx().currentTime, 0.015);
  }

  function setVoiceWarble(i, rate, depthHz) {
    const v = voices[i]; if (!v) return;
    const c = getCtx();
    v.warbleOsc.frequency.setTargetAtTime(rate, c.currentTime, 0.05);
    v.warbleGain.gain.setTargetAtTime(depthHz, c.currentTime, 0.05);
  }

  function silenceAll() { voices.forEach((_, i) => setVoiceGain(i, 0)); }

  function kick() {
    if (!started) return;
    const c = getCtx(), now = c.currentTime;
    voices.forEach(v => {
      v.osc.frequency.cancelScheduledValues(now);
      v.osc.frequency.setValueAtTime(v.freq, now);
    });
  }

  // ── Metronome click ───────────────────────────────────────────────────────
  function click(time, accent) {
    const c = getCtx();
    const o = c.createOscillator(), g = c.createGain();
    o.frequency.value = accent ? 1600 : 1000; o.type = "square";
    g.gain.setValueAtTime(0.0001, time);
    g.gain.exponentialRampToValueAtTime(accent ? 0.32 : 0.18, time + 0.002);
    g.gain.exponentialRampToValueAtTime(0.0001, time + 0.045);
    o.connect(g); g.connect(c.destination);
    o.start(time); o.stop(time + 0.05);
  }

  // ── One-shot preview (Cosmophone) ─────────────────────────────────────────
  // Routes through wetIn so it passes through the FX chain.
  function previewNote(freq, wave, durationSec, gainVal) {
    ensureBuses();
    const c = getCtx(), now = c.currentTime;
    const osc = c.createOscillator();
    applyWave(osc, wave);
    const gn = c.createGain();
    osc.frequency.value = freq;
    gn.gain.setValueAtTime(0.0001, now);
    gn.gain.exponentialRampToValueAtTime(gainVal || 0.3, now + 0.02);
    gn.gain.exponentialRampToValueAtTime(0.0001, now + durationSec - 0.04);
    osc.connect(gn); gn.connect(wetIn);
    osc.start(now); osc.stop(now + durationSec);
  }

  // ── Playback bank (Cosmophone Studio) ────────────────────────────────────
  const PB_VOICES = 40;
  const pb = [];
  let pbStarted = false;

  function pbStart() {
    ensureBuses();
    if (pbStarted) return;
    const c = getCtx();
    for (let i = 0; i < PB_VOICES; i++) {
      const osc = c.createOscillator();
      applyWave(osc, "sine");
      const wo = c.createOscillator(); wo.type = "sine"; wo.frequency.value = 0;
      const wg = c.createGain(); wg.gain.value = 0;
      wo.connect(wg); wg.connect(osc.frequency);
      const gn = c.createGain(); gn.gain.value = 0;
      osc.connect(gn); gn.connect(wetIn);
      osc.start(); wo.start();
      pb.push({ osc, warbleOsc: wo, warbleGain: wg, gain: gn });
    }
    pbStarted = true;
  }

  function pbEnsureMaster() { ensureBuses(); }

  function pbSet(idx, { freq, gain, wave, warbleRate = 0, warbleDepth = 0 }) {
    const v = pb[idx]; if (!v) return;
    const c = getCtx(), now = c.currentTime;
    if (wave) applyWave(v.osc, wave);
    v.osc.frequency.setTargetAtTime(freq, now, 0.01);
    v.gain.gain.setTargetAtTime(Math.max(0, Math.min(1, gain)), now, 0.015);
    v.warbleOsc.frequency.setTargetAtTime(warbleRate, now, 0.04);
    v.warbleGain.gain.setTargetAtTime(warbleDepth, now, 0.04);
  }

  function pbSilence(idx) {
    const v = pb[idx]; if (!v) return;
    v.gain.gain.setTargetAtTime(0, getCtx().currentTime, 0.02);
  }

  function pbSilenceAll() { for (let i = 0; i < pb.length; i++) pbSilence(i); }

  function pbRoute(idx, wet) {
    const v = pb[idx]; if (!v || !busesReady) return;
    try { v.gain.disconnect(); } catch(_) {}
    v.gain.connect(wet ? wetIn : dryIn);
  }

  // ── NeutronDrop scheduled voice helpers ───────────────────────────────────

  function detuneFactorFor(cents) { return Math.pow(2, (cents ?? 8) / 1200); }

  function mixGains(opts) {
    if (!opts.osc2On) return [1, 0];
    const mix = (typeof opts.mix === "number") ? opts.mix : 0.5;
    return [Math.cos(mix * Math.PI / 2), Math.sin(mix * Math.PI / 2)];
  }

  // buildFmPair — static-pitch FM carrier+modulator for preview/audition paths.
  function buildFmPair(c, carrierWave, carrierFreq, ratio, index, userTable) {
    const carrier = c.createOscillator();
    applyWave(carrier, carrierWave, carrierWave === "USER" ? userTable : undefined);
    const modulator = c.createOscillator();
    modulator.type = "sine";
    const modGain = c.createGain();
    modulator.connect(modGain); modGain.connect(carrier.frequency);
    modulator.frequency.value = carrierFreq * ratio;
    modGain.gain.value = carrierFreq * index;
    return { carrier, modulator, modGain };
  }

  // ── playNoteWithRamps ─────────────────────────────────────────────────────
  // Core NeutronDrop note scheduler. Supports FM, dual oscillator, glide,
  // and per-step gain ramps with raised-cosine (click-free) release.
  function playNoteWithRamps(trackId, wave, freq, t, vol, sustainSec, glideSec, ramps = [], opts = {}, gainRamps = []) {
    ensureBuses();
    const c = getCtx();
    if (!Number.isFinite(freq) || freq <= 0) return null;

    const g = c.createGain();
    const peak   = Math.max(0.0001, vol);
    const t0     = Math.max(t, c.currentTime + 0.001);
    const hold   = Math.max(0.05, sustainSec);
    const maxFade = hold * 0.45;
    const atk    = Math.min(0.004, maxFade);
    const rel    = Math.min(0.06, Math.max(0.012, maxFade));
    const relStart = t0 + hold - rel;

    const cosFade = (from) => {
      const N = 64, arr = new Float32Array(N);
      for (let i = 0; i < N; i++) {
        const x = i / (N - 1);
        arr[i] = from * 0.5 * (1 + Math.cos(Math.PI * x));
      }
      arr[N - 1] = 0;
      return arr;
    };

    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(peak, t0 + atk);

    if (gainRamps.length > 0) {
      let prevTime = t0 + atk, lastLevel = peak;
      gainRamps.forEach(({ atTime, level }) => {
        const lv = Math.max(0.0001, level);
        const tau = Math.max(0.01, (atTime - prevTime) * 0.3);
        g.gain.setTargetAtTime(lv, atTime, tau);
        prevTime = atTime; lastLevel = lv;
      });
      if (g.gain.cancelAndHoldAtTime) g.gain.cancelAndHoldAtTime(relStart);
      else g.gain.setValueAtTime(lastLevel, relStart);
      g.gain.setValueCurveAtTime(cosFade(lastLevel), relStart, rel);
    } else {
      g.gain.setValueAtTime(peak, relStart);
      g.gain.setValueCurveAtTime(cosFade(peak), relStart, rel);
    }
    g.connect(ndMaster);

    const prev = lastFreq[trackId];

    function makeOsc(oscWave, baseFreq, oscGain = 1, freqMul = 1) {
      const o = c.createOscillator();
      applyWave(o, oscWave, oscWave === "USER" ? opts.userTable : undefined);
      if (glideSec > 0 && Number.isFinite(prev) && prev > 0) {
        o.frequency.setValueAtTime(prev * freqMul, t);
        o.frequency.exponentialRampToValueAtTime(Math.max(1, baseFreq), t + glideSec);
      } else {
        o.frequency.setValueAtTime(baseFreq, t);
      }
      ramps.forEach(({ atTime, freq: targetFreq, instant }) => {
        if (!Number.isFinite(targetFreq) || targetFreq <= 0) return;
        const f = Math.max(1, targetFreq * freqMul);
        if (instant) {
          o.frequency.setValueAtTime(f, atTime);
        } else {
          const glideOver = (sustainSec / Math.max(ramps.length + 1, 1)) * 0.4;
          o.frequency.setTargetAtTime(f, atTime, glideOver * 0.3);
        }
      });
      if (oscGain >= 0.999) { o.connect(g); } else {
        const og = c.createGain(); og.gain.value = oscGain;
        o.connect(og); og.connect(g);
      }
      o.start(t0); o.stop(t0 + hold + 0.08);
      return o;
    }

    function makeFmOsc(carrierWave, baseFreq, oscGain = 1, ratio = 2, index = 1) {
      const carrier = c.createOscillator();
      applyWave(carrier, carrierWave, carrierWave === "USER" ? opts.userTable : undefined);
      const modulator = c.createOscillator(); modulator.type = "sine";
      const modGain = c.createGain();
      modulator.connect(modGain); modGain.connect(carrier.frequency);
      if (glideSec > 0 && Number.isFinite(prev) && prev > 0) {
        carrier.frequency.setValueAtTime(prev, t);
        carrier.frequency.exponentialRampToValueAtTime(Math.max(1, baseFreq), t + glideSec);
        modulator.frequency.setValueAtTime(prev * ratio, t);
        modulator.frequency.exponentialRampToValueAtTime(Math.max(1, baseFreq * ratio), t + glideSec);
      } else {
        carrier.frequency.setValueAtTime(baseFreq, t);
        modulator.frequency.setValueAtTime(baseFreq * ratio, t);
      }
      modGain.gain.setValueAtTime(baseFreq * index, t);
      ramps.forEach(({ atTime, freq: targetFreq, instant }) => {
        if (!Number.isFinite(targetFreq) || targetFreq <= 0) return;
        const f = Math.max(1, targetFreq);
        if (instant) {
          carrier.frequency.setValueAtTime(f, atTime);
          modulator.frequency.setValueAtTime(f * ratio, atTime);
          modGain.gain.setValueAtTime(f * index, atTime);
        } else {
          const glideOver = (sustainSec / Math.max(ramps.length + 1, 1)) * 0.4;
          carrier.frequency.setTargetAtTime(f, atTime, glideOver * 0.3);
          modulator.frequency.setTargetAtTime(f * ratio, atTime, glideOver * 0.3);
          modGain.gain.setTargetAtTime(f * index, atTime, glideOver * 0.3);
        }
      });
      if (oscGain >= 0.999) { carrier.connect(g); } else {
        const og = c.createGain(); og.gain.value = oscGain;
        carrier.connect(og); og.connect(g);
      }
      carrier.start(t0); modulator.start(t0);
      carrier.stop(t0 + hold + 0.08); modulator.stop(t0 + hold + 0.08);
      return { carrier, modulator };
    }

    const mixVal = (opts.osc2On && typeof opts.mix === "number") ? opts.mix : 0;
    const g1 = opts.osc2On ? Math.cos(mixVal * Math.PI / 2) : 1;
    const g2 = opts.osc2On ? Math.sin(mixVal * Math.PI / 2) : 0;

    let fmModulator = null, o1;
    if (opts.engine === "fm") {
      const pair = makeFmOsc(wave, freq, g1, opts.fmRatio ?? 2, opts.fmIndex ?? 1);
      o1 = pair.carrier; fmModulator = pair.modulator;
    } else {
      o1 = makeOsc(wave, freq, g1);
    }

    lastFreq[trackId] = freq;
    ramps.forEach(({ freq: tf }) => { if (Number.isFinite(tf) && tf > 0) lastFreq[trackId] = tf; });

    if (opts.osc2On && opts.engine !== "fm") {
      const cents = opts.detune ?? 8;
      const detuneFactor = detuneFactorFor(cents);
      makeOsc(opts.osc2Wave || wave, freq * detuneFactor, g2, detuneFactor);
    }

    const voice = { o: o1, g, mod: fmModulator };
    scheduledVoices.push(voice);
    o1.onended = () => { scheduledVoices = scheduledVoices.filter(v => v !== voice); };
    return o1;
  }

  function playNote(trackId, wave, freq, t, vol, sustainSec, glideSec) {
    return playNoteWithRamps(trackId, wave, freq, t, vol, sustainSec, glideSec, []);
  }

  // ── preview — one-shot note matching full voice config (NeutronDrop) ─────
  function preview(wave, freq, durSec, opts = {}) {
    ensureBuses();
    const c = getCtx();
    const g = c.createGain();
    const peak = 0.5, a = 0.006, hold = Math.max(0.1, durSec);
    const rel = Math.min(0.05, hold * 0.4);
    g.gain.setValueAtTime(0.0001, c.currentTime);
    g.gain.exponentialRampToValueAtTime(peak, c.currentTime + a);
    g.gain.setValueAtTime(peak, c.currentTime + hold - rel);
    g.gain.linearRampToValueAtTime(0, c.currentTime + hold);
    g.connect(ndMaster);

    if (opts.engine === "fm") {
      const { carrier, modulator } = buildFmPair(c, wave, freq, opts.fmRatio ?? 2, opts.fmIndex ?? 1, opts.userTable);
      carrier.connect(g);
      carrier.start(); modulator.start();
      carrier.stop(c.currentTime + hold + 0.08);
      modulator.stop(c.currentTime + hold + 0.08);
      return;
    }

    const [g1, g2] = mixGains(opts);
    const mkOsc = (oscWave, f, oscGain) => {
      const o = c.createOscillator();
      applyWave(o, oscWave, oscWave === "USER" ? opts.userTable : undefined);
      o.frequency.setValueAtTime(f, c.currentTime);
      if (oscGain >= 0.999) { o.connect(g); } else {
        const og = c.createGain(); og.gain.value = oscGain;
        o.connect(og); og.connect(g);
      }
      o.start(); o.stop(c.currentTime + hold + 0.08);
      return o;
    };
    mkOsc(wave, freq, g1);
    if (opts.osc2On) mkOsc(opts.osc2Wave || wave, freq * detuneFactorFor(opts.detune), g2);
  }

  // ── auditionStart / auditionGlide / stopAudition ──────────────────────────
  function auditionStart(wave, freq, opts = {}) {
    ensureBuses();
    const c = getCtx();
    stopAudition();
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, c.currentTime);
    g.gain.exponentialRampToValueAtTime(0.4, c.currentTime + 0.02);
    g.connect(ndMaster);

    if (opts.engine === "fm") {
      const ratio = opts.fmRatio ?? 2, index = opts.fmIndex ?? 1;
      const { carrier, modulator, modGain } = buildFmPair(c, wave, freq, ratio, index, opts.userTable);
      carrier.connect(g);
      carrier.start(); modulator.start();
      audition = { o: carrier, g, o2: null, o2Factor: 1, mod: modulator, modGain, fmRatio: ratio, fmIndex: index };
      return;
    }

    const [g1, g2] = mixGains(opts);
    const og1 = c.createGain(); og1.gain.value = g1; og1.connect(g);
    const o1 = c.createOscillator();
    applyWave(o1, wave, wave === "USER" ? opts.userTable : undefined);
    o1.frequency.setValueAtTime(freq, c.currentTime);
    o1.connect(og1); o1.start();

    let o2 = null, o2Factor = 1;
    if (opts.osc2On) {
      o2Factor = detuneFactorFor(opts.detune);
      const og2 = c.createGain(); og2.gain.value = g2; og2.connect(g);
      o2 = c.createOscillator();
      applyWave(o2, opts.osc2Wave || wave);
      o2.frequency.setValueAtTime(freq * o2Factor, c.currentTime);
      o2.connect(og2); o2.start();
    }
    audition = { o: o1, g, o2, o2Factor, mod: null };
  }

  function auditionGlide(freq) {
    if (!audition) return;
    const c = getCtx(), f = Math.max(1, freq);
    audition.o.frequency.setTargetAtTime(f, c.currentTime, 0.02);
    if (audition.o2) audition.o2.frequency.setTargetAtTime(f * audition.o2Factor, c.currentTime, 0.02);
    if (audition.mod) {
      audition.mod.frequency.setTargetAtTime(f * audition.fmRatio, c.currentTime, 0.02);
      audition.modGain.gain.setTargetAtTime(f * audition.fmIndex, c.currentTime, 0.02);
    }
  }

  function stopAudition() {
    if (!audition) return;
    const c = getCtx();
    const { o, g, o2, mod } = audition;
    audition = null;
    try {
      const now = c.currentTime;
      g.gain.cancelScheduledValues(now);
      g.gain.setValueAtTime(g.gain.value, now);
      g.gain.linearRampToValueAtTime(0, now + 0.05);
      o.stop(now + 0.08);
      if (o2) o2.stop(now + 0.08);
      if (mod) mod.stop(now + 0.08);
    } catch(_) {}
  }

  function resetGlide() { for (const k in lastFreq) delete lastFreq[k]; }

  function killAll() {
    if (!ctx) return;
    const now = ctx.currentTime;
    scheduledVoices.forEach(({ o, g, mod }) => {
      try {
        g.gain.cancelScheduledValues(now);
        g.gain.setValueAtTime(g.gain.value, now);
        g.gain.linearRampToValueAtTime(0, now + 0.012);
        o.stop(now + 0.02);
        if (mod) mod.stop(now + 0.02);
      } catch(_) {}
    });
    scheduledVoices = [];
  }

  // ── Public API ────────────────────────────────────────────────────────────
  return {
    // Context
    getCtx, unlock, ensureBuses, hasBuses: () => busesReady,

    // Cosmophone — persistent pool
    start, stop, isStarted: () => started, MAXV,
    setWaveform, setVoiceFreq, setVoiceGain, setVoiceWarble,
    silenceAll, kick, click, previewNote,
    pbStart, pbEnsureMaster, pbSet, pbSilence, pbSilenceAll, pbRoute, PB_VOICES,

    // NeutronDrop — scheduled voices
    setMaster, playNote, playNoteWithRamps,
    preview, auditionStart, auditionGlide, stopAudition,
    resetGlide, killAll, accentFilter,

    // Effects (both apps)
    setOverdrive, setDrive,
    setFilter,
    setDelay, setChorus, setPhaser, setReverb, setPresence,
  };
}

// ─── Fonts ──────────────────────────────────────────────────────────────────
const fontLink = document.createElement("link");
fontLink.rel = "stylesheet";
fontLink.href = "https://fonts.googleapis.com/css2?family=Cinzel:wght@500;700&family=Cormorant+Garamond:ital,wght@0,300;0,400;0,600;1,500&family=Poiret+One&family=Share+Tech+Mono&display=swap";
document.head.appendChild(fontLink);

// ─── Haptics ────────────────────────────────────────────────────────────────
function haptic(ms = 8) { try { navigator.vibrate?.(ms); } catch (_) {} }

// ─── Art assets ─────────────────────────────────────────────────────────────
const ART_PAD_BG    = "/art/pad-bg.jpg";
const ART_RAIL_DECO = "";
const ART_LYRA      = "/art/lyra.jpg";

// ─── Rotating taglines ───────────────────────────────────────────────────────
const TAGLINES = [
  "Vacuum Tubes Not Included",
  "A Modern Theremin for the Modern Luddite",
  "Thanks for the Aether",
  "You're Annoying Your Sister",
  "Too Spooky",
  "Wow You're Really Good at This",
  "Now With Exactly the Same Amount of AI as Before",
  "Did You Actually Pay for This?",
  "I'm a Cat. Meow.",
  "Here a Min Theremin Everywhere a...",
  "Bela Lugosi Lives",
];

// ─── Palette (steampunk) ─────────────────────────────────────────────────────
const BRASS    = "#b8860b";
const BRASS_LT = "#e8c170";
const GOLD     = "#ffcc44";
const VIOLET   = "#7d4fbf";
const VIOLET_LT= "#b07fe8";
const RED      = "#c0392b";
const RED_LT   = "#e8604f";
const INK      = "#1a1410";
const PANEL    = "#241b12";
const SAGE     = "#71A39F";
const SAGE_DK  = "#3d6460";
const VOICE_COLORS = ["#ffcc44","#e8604f","#b07fe8","#71A39F","#6fa8e8"];

// ─── Music theory ────────────────────────────────────────────────────────────
const NOTE_NAMES = ["C","C#","D","D#","E","F","F#","G","G#","A","A#","B"];
const A4 = 440;
const midiToFreq = (m) => A4 * Math.pow(2, (m - 69) / 12);
const isBlack = (m) => [1,3,6,8,10].includes(((m % 12) + 12) % 12);
const noteName = (m) => NOTE_NAMES[((m % 12) + 12) % 12];
const octaveOf = (m) => Math.floor(m/12) - 1;
const fullName = (m) => `${noteName(m)}${octaveOf(m)}`;

const CHORD_SHAPES = {
  "Free (all notes)": null,
  "Major":            [0,4,7],
  "Minor":            [0,3,7],
  "Major 7":          [0,4,7,11],
  "Minor 7":          [0,3,7,10],
  "Dominant 7":       [0,4,7,10],
  "Diminished":       [0,3,6],
  "Augmented":        [0,4,8],
  "Sus4":             [0,5,7],
  "Major pentatonic": [0,2,4,7,9],
  "Minor pentatonic": [0,3,5,7,10],
  "Major scale":      [0,2,4,5,7,9,11],
  "Minor scale":      [0,2,3,5,7,8,10],
  "Blues":            [0,3,5,6,7,10],
};
const CHORD_NAMES = Object.keys(CHORD_SHAPES);
const ROOT_NAMES  = NOTE_NAMES;

// ─── Constants ───────────────────────────────────────────────────────────────
const WAVEFORMS = ["sine","triangle","saw","square"];
// map display labels to Web Audio OscillatorType
const WAVE_TYPE = {"sine":"sine","triangle":"triangle","saw":"sawtooth","square":"square"};
const LOW_MIDI  = 48;          // C3
const OCTAVES   = 3;
const HIGH_MIDI = LOW_MIDI + OCTAVES * 12;
const MIDI_SPAN = HIGH_MIDI - LOW_MIDI;
const MODES     = ["THEREMIN","AUTOHARP","SYMPHONY"];
const DEAD_ZONE = 0.06;        // fraction of width at each edge that pins extremes
const SYM_LOW   = 36;          // C2  — symphony picker 4 octaves
const SYM_OCT   = 4;
const SYM_HIGH  = SYM_LOW + SYM_OCT*12;
const MAX_SYM_NOTES = 5;

// ─── Symphony chord presets ───────────────────────────────────────────────────
// All rooted near C3 (MIDI 48) for a warm mid-range pad feel.
// Intervals in semitones from root; driver = floor((n-1)/2) for odd, n-2 for even.
const SYM_CHORD_ROOT = 48; // C3
const SYM_CHORDS = {
  "3-VOICE": [
    { name:"Major",      ivs:[0,7,12]   },
    { name:"Minor",      ivs:[0,7,15]   }, // open voicing: root, 5th, minor 3rd above
    { name:"Sus2",       ivs:[0,7,14]   },
    { name:"Sus4",       ivs:[0,7,17]   },
    { name:"Diminished", ivs:[0,6,12]   },
    { name:"Augmented",  ivs:[0,8,16]   },
  ],
  "4-VOICE": [
    { name:"Major 7",    ivs:[0,7,11,16]  }, // root, 5th, maj7, maj3 up
    { name:"Minor 7",    ivs:[0,7,10,15]  },
    { name:"Dom 7",      ivs:[0,7,10,16]  },
    { name:"Half-Dim",   ivs:[0,6,10,15]  },
    { name:"Major 6",    ivs:[0,7,9,16]   },
  ],
  "5-VOICE": [
    { name:"Major 9",    ivs:[0,7,11,14,16] },
    { name:"Minor 9",    ivs:[0,7,10,14,15] },
    { name:"Dom 9",      ivs:[0,7,10,14,16] },
    { name:"Maj 7♯11",   ivs:[0,6,11,14,16] },
    { name:"Minor 11",   ivs:[0,7,10,12,17] },
    { name:"Major add9", ivs:[0,4,7,12,14]  },
    { name:"Minor add9", ivs:[0,3,7,12,14]  },
  ],
};

function symChordMidis(ivs){ return ivs.map(i=>SYM_CHORD_ROOT+i).sort((a,b)=>a-b); }
function symChordDriver(midis){
  return midis[0]; // lowest note is the harmonic root driver by default
}
// ─── Pure resolver ────────────────────────────────────────────────────────────
// Given normalized pad coords (nx,ny) and a patch snapshot, return the per-voice
// synth output. Used by BOTH live play and loop playback so they sound identical.
// patch = { mode, waveform, pitchAssist, symAssistMode, xAxis, glideMs,
//           warbleRate, warbleDistort, volFloor, selected:[midi...], symNotes, symDriver }
function deadZoneX(nx){
  if (nx <= DEAD_ZONE) return 0;
  if (nx >= 1-DEAD_ZONE) return 1;
  return (nx - DEAD_ZONE) / (1 - 2*DEAD_ZONE);
}
function nearestInSet(midiFloat, selArr){
  if (!selArr || selArr.length===0) return Math.round(midiFloat);
  let best=selArr[0], bd=Infinity;
  for (const m of selArr){ const d=Math.abs(m-midiFloat); if(d<bd){bd=d;best=m;} }
  return best;
}
// returns { voices:[{freq,gain,warbleRate,warbleDepth}], wave, driverNote }
function resolveFrame(nx, ny, p){
  const xv = deadZoneX(nx);
  const wave = p.waveform;
  const xAmpWarble = (freq, ampScale)=>{
    if (p.xAxis === "VOLUME"){
      const floor = p.volFloor/100;
      return { gain:(floor + xv*(1-floor))*ampScale, warbleRate:0, warbleDepth:0 };
    }
    return { gain:0.9*ampScale,
             warbleRate: xv*p.warbleRate,
             warbleDepth: (p.warbleDistort/100)*freq };
  };

  if (p.mode === "SYMPHONY"){
    const notes = p.symNotes || [];
    if (notes.length===0) return { voices:[], wave, driverNote:null };
    let driverBase = p.symDriver;
    if (driverBase==null || !notes.includes(driverBase)) driverBase = notes[0];
    const drivenFloat = LOW_MIDI + (1-ny)*MIDI_SPAN;
    const delta = drivenFloat - driverBase;
    const assistOn = p.pitchAssist;
    const ampScale = 1/Math.sqrt(notes.length);
    const voices = notes.map(base=>{
      let outMidi = base + delta;
      if (assistOn){
        if (p.symAssistMode === "EXPERIMENTAL") outMidi = nearestInSet(outMidi, p.selected);
        else if (base === driverBase) outMidi = nearestInSet(outMidi, p.selected);
        else { const ds = nearestInSet(driverBase+delta, p.selected); outMidi = base + (ds-driverBase); }
      }
      const freq = midiToFreq(outMidi);
      return { freq, ...xAmpWarble(freq, ampScale) };
    });
    const drvNote = assistOn ? nearestInSet(driverBase+delta, p.selected) : (driverBase+delta);
    return { voices, wave, driverNote: drvNote };
  }

  // THEREMIN / AUTOHARP — single voice
  const midiFloat = LOW_MIDI + (1-ny)*MIDI_SPAN;
  let outMidi = midiFloat;
  if (p.mode === "AUTOHARP") outMidi = nearestInSet(midiFloat, p.selected);
  else if (p.pitchAssist){ const near=Math.round(midiFloat); outMidi = midiFloat + (near-midiFloat)*0.5; }
  const freq = midiToFreq(outMidi);
  return { voices:[{ freq, ...xAmpWarble(freq,1) }], wave, driverNote: outMidi };
}

// ─── Component ───────────────────────────────────────────────────────────────
export default function Cosmophone() {
  const [waveform,   setWaveform]   = useState("sine");
  const [mode,       setMode]       = useState("THEREMIN");
  const [pitchAssist,setPitchAssist]= useState(true);
  const [symAssistMode,setSymAssistMode] = useState("HARMONIC"); // HARMONIC | EXPERIMENTAL
  const [xAxis,      setXAxis]      = useState("VOLUME");
  const [glideMs,    setGlideMs]    = useState(80);
  const [warbleDepth,setWarbleDepth]= useState(6);   // how fast/strong the warble swings
  const [warbleDistort,setWarbleDistort] = useState(8); // pitch-distortion amount
  const [volFloor,   setVolFloor]   = useState(15);  // % — how quiet the left edge gets
  const [rootIdx,    setRootIdx]    = useState(0);
  const [chordName,  setChordName]  = useState("Free (all notes)");
  const [selected,   setSelected]   = useState(() => allOn());
  const [active,     setActive]     = useState(false);
  const [readout,    setReadout]    = useState({ note: "—", freq: 0, x: 0, y: 0 });

  // panels
  const [keyboardOut,setKeyboardOut]= useState(false);
  const [controlsOut,setControlsOut]= useState(false); // kept for legacy compat; settingsOut is the live one
  const [settingsOut,setSettingsOut]= useState(false); // unified settings panel (ctrl + fx)

  // symphony
  const [symNotes,   setSymNotes]   = useState([]);   // array of midi, max 5 (sorted for display)
  const [symDriver,  setSymDriver]  = useState(null); // MIDI note that the finger drives (stable identity)
  const [symOrder,   setSymOrder]   = useState([]);   // midi notes in press order (oldest first)
  const [symPickerOpen,setSymPickerOpen] = useState(false);
  const [ahPickerOpen, setAhPickerOpen]  = useState(false); // autoharp voices panel

  // ── Effects (global chain) ──
  const [fxOut, setFxOut] = useState(false); // standalone effects panel
  const [fxParams, setFxParams] = useState({
    overdrive: { on:false, amount:0.4, mode:"overdrive" },
    delay:    { on:false, mix:0.25, time:0.30, feedback:0.30 },
    chorus:   { on:false, mix:0.40, rate:0.6,  depth:0.5 },
    phaser:   { on:false, mix:0.40, rate:0.4,  depth:0.5 },
    reverb:   { on:false, mix:0.30, size:0.5 },
    presence: { on:false, db:6 },
  });

  // ── Studio (Plan B core: metronome + single-slot capture + gesture playback) ──
  const [studioOut,  setStudioOut]  = useState(false);
  const [bpm,        setBpm]        = useState(100);
  const [beatsPerMeasure, setBeatsPerMeasure] = useState(4);
  const [measures,   setMeasures]   = useState(2);
  const [metroOn,    setMetroOn]    = useState(true);
  const [recState,   setRecState]   = useState("idle"); // idle | countin | recording | playing
  const [recSlot,    setRecSlot]    = useState(0);       // which of 8 slots is armed
  const [slots,      setSlots]      = useState(()=>Array(8).fill(null)); // each: {gesture:[], patch:{}, mode}
  const [monitorSlots, setMonitorSlots] = useState(()=>new Set()); // which slots play under a take
  const [recBeat,    setRecBeat]    = useState(-1);      // current beat index for UI
  const [recProgress,setRecProgress]= useState(0);       // 0..1 through the loop

  // arranger: 3 rows × 8 cells, each cell = slot index (0-7) or null
  const ARR_ROWS = 3, ARR_CELLS = 8;
  const [arrRows, setArrRows] = useState(()=>Array.from({length:3},()=>Array(8).fill(null)));
  const [arrMutes, setArrMutes] = useState(()=>Array(3).fill(false));
  const [activeArrRow, setActiveArrRow] = useState(0);
  const [arrPos, setArrPos] = useState(-1);
  const [studioTab, setStudioTab] = useState("RECORD"); // RECORD | ARRANGE

  const studioRefs = useRef({
    recState:"idle", capture:[], captureStart:0, loopLen:0, monitorSlots:new Set(),
    recSlot:0, slots:Array(8).fill(null), metroOn:true,
    arrRows:Array.from({length:3},()=>Array(8).fill(null)), arrMutes:Array(3).fill(false),
  });
  // keep a live mirror for the scheduler/capture (avoids stale closures)
  useEffect(()=>{ studioRefs.current.recState = recState; },[recState]);
  useEffect(()=>{ studioRefs.current.recSlot = recSlot; },[recSlot]);
  useEffect(()=>{ studioRefs.current.slots = slots; },[slots]);
  useEffect(()=>{ studioRefs.current.monitorSlots = monitorSlots; },[monitorSlots]);
  useEffect(()=>{ studioRefs.current.metroOn = metroOn; },[metroOn]);
  useEffect(()=>{ studioRefs.current.arrRows = arrRows; },[arrRows]);
  useEffect(()=>{ studioRefs.current.arrMutes = arrMutes; },[arrMutes]);

  const engineRef = useRef(null);
  const fieldRef  = useRef(null);

  // live refs
  const modeRef=useRef(mode), assistRef=useRef(pitchAssist), xAxisRef=useRef(xAxis);
  const glideRef=useRef(glideMs), depthRef=useRef(warbleDepth), distortRef=useRef(warbleDistort);
  const floorRef=useRef(volFloor), selRef=useRef(selected), waveRef=useRef(waveform);
  const symNotesRef=useRef(symNotes), symDriverRef=useRef(symDriver), symAssistRef=useRef(symAssistMode);
  const activeRef=useRef(active);
  useEffect(()=>{modeRef.current=mode;},[mode]);
  useEffect(()=>{assistRef.current=pitchAssist;},[pitchAssist]);
  useEffect(()=>{xAxisRef.current=xAxis;},[xAxis]);
  useEffect(()=>{glideRef.current=glideMs;},[glideMs]);
  useEffect(()=>{depthRef.current=warbleDepth;},[warbleDepth]);
  useEffect(()=>{distortRef.current=warbleDistort;},[warbleDistort]);
  useEffect(()=>{floorRef.current=volFloor;},[volFloor]);
  useEffect(()=>{selRef.current=selected;},[selected]);
  useEffect(()=>{waveRef.current=waveform;},[waveform]);
  useEffect(()=>{symNotesRef.current=symNotes;},[symNotes]);
  useEffect(()=>{symDriverRef.current=symDriver;},[symDriver]);
  useEffect(()=>{symAssistRef.current=symAssistMode;},[symAssistMode]);
  useEffect(()=>{activeRef.current=active;},[active]);

  // ── Tagline — picked once per session, never rotates ──
  const [taglineIdx] = useState(()=>Math.floor(Math.random()*TAGLINES.length));

  function allOn() { const s=new Set(); for(let m=LOW_MIDI;m<=HIGH_MIDI;m++) s.add(m); return s; }

  useEffect(()=>{ engineRef.current=createAudioEngine(); return ()=>engineRef.current?.stop(); },[]);
  useEffect(()=>{ engineRef.current?.setWaveform(WAVE_TYPE[waveform]||waveform); },[waveform]);

  // push effects params to the engine whenever they change
  // keep a live ref so the first-touch path can push FX params once buses exist
  const fxParamsRef = useRef(fxParams);
  useEffect(()=>{ fxParamsRef.current = fxParams; },[fxParams]);

  const pushFxParams = useCallback((fp)=>{
    const eng = engineRef.current; if(!eng || !eng.hasBuses?.()) return;
    const ov=fp.overdrive, d=fp.delay, ch=fp.chorus, ph=fp.phaser, rv=fp.reverb, pr=fp.presence;
    eng.setOverdrive?.(ov);
    eng.setDelay({ mix: d.on?d.mix:0, time:d.time, feedback:d.feedback });
    eng.setChorus({ mix: ch.on?ch.mix:0, rate:ch.rate, depth:ch.depth });
    eng.setPhaser({ mix: ph.on?ph.mix:0, rate:ph.rate, depth:ph.depth });
    eng.setReverb({ mix: rv.on?rv.mix:0, size:rv.size });
    eng.setPresence?.(pr.on ? pr.db : 0);
  },[]);

  useEffect(()=>{
    const eng = engineRef.current; if(!eng) return;
    // Don't force-create the AudioContext here — that would happen before any
    // user gesture and leave it stuck suspended (autoplay policy). Only push FX
    // params once the buses actually exist (i.e. after first touch builds them).
    if(!eng.hasBuses?.()) return;
    pushFxParams(fxParams);
  },[fxParams, pushFxParams]);

  // chord → lit notes
  useEffect(()=>{
    const shape = CHORD_SHAPES[chordName];
    if (!shape) { setSelected(allOn()); return; }
    const pcs = new Set(shape.map(s => (rootIdx + s) % 12));
    const s = new Set();
    for (let m=LOW_MIDI;m<=HIGH_MIDI;m++) if (pcs.has(((m%12)+12)%12)) s.add(m);
    if (s.size===0) s.add(LOW_MIDI);
    setSelected(s);
  },[chordName, rootIdx]);

  const nearestSelected = useCallback((midiFloat)=>{
    const sel = selRef.current;
    if (sel.size===0) return Math.round(midiFloat);
    let best=null, bd=Infinity;
    for (const m of sel){ const d=Math.abs(m-midiFloat); if(d<bd){bd=d;best=m;} }
    return best;
  },[]);

  // X axis → returns {volTargets per active voice not needed here} we compute amplitude & warble globally
  const computeX = useCallback((nx)=>{
    // dead zones pin the extremes
    let xv;
    if (nx <= DEAD_ZONE) xv = 0;
    else if (nx >= 1-DEAD_ZONE) xv = 1;
    else xv = (nx - DEAD_ZONE) / (1 - 2*DEAD_ZONE);
    return xv; // 0..1
  },[]);

  // ── core pointer update ────────────────────────────────────────────────────
  const currentPatch = useCallback(()=>({
    mode: modeRef.current, waveform: WAVE_TYPE[waveRef.current]||waveRef.current, pitchAssist: assistRef.current,
    symAssistMode: symAssistRef.current, xAxis: xAxisRef.current,
    warbleRate: depthRef.current, warbleDistort: distortRef.current, volFloor: floorRef.current,
    selected: [...selRef.current], symNotes: [...symNotesRef.current], symDriver: symDriverRef.current,
  }),[]);

  const updateFromPointer = useCallback((clientX, clientY)=>{
    const el = fieldRef.current; if (!el) return;
    const r = el.getBoundingClientRect();
    let nx = (clientX-r.left)/r.width, ny = (clientY-r.top)/r.height;
    nx=Math.max(0,Math.min(1,nx)); ny=Math.max(0,Math.min(1,ny));
    const eng = engineRef.current; if(!eng) return;

    // Capture raw input while recording
    const S = studioRefs.current;
    if (S.recState === "recording"){
      const t = eng.getCtx().currentTime - S.captureStart;
      if (t >= 0 && t <= S.loopLen) S.capture.push({ t, nx, ny });
    }

    const xv = computeX(nx);
    const m = modeRef.current;

    // helper: x → amplitude / warble for a given voice freq
    const applyX = (vi, freq, ampScale=1)=>{
      if (xAxisRef.current==="VOLUME"){
        const floor = floorRef.current/100;
        const amp = (floor + xv*(1-floor)) * ampScale;
        eng.setVoiceGain(vi, amp);
        eng.setVoiceWarble(vi, 0, 0);
      } else {
        eng.setVoiceGain(vi, 0.9*ampScale);
        const rate = xv * (depthRef.current); // depth slider = max rate (Hz)
        const depthHz = (distortRef.current/100) * freq; // distort slider = pitch swing
        eng.setVoiceWarble(vi, rate, depthHz);
      }
    };

    if (m === "SYMPHONY") {
      const notes = symNotesRef.current;
      if (notes.length === 0){ eng.silenceAll(); setReadout(rd=>({...rd,note:"—",x:nx,y:ny})); return; }
      // driver is a stable MIDI note; if it's somehow not in the set, fall back to lowest
      let driverBase = symDriverRef.current;
      if (driverBase == null || !notes.includes(driverBase)) driverBase = notes[0];
      const drivenFloat = LOW_MIDI + (1-ny)*MIDI_SPAN;
      const delta = drivenFloat - driverBase; // how far driver has moved from its base
      const assistOn = assistRef.current;
      const ampScale = 1/Math.sqrt(notes.length); // keep chord from clipping
      notes.forEach((base, idx)=>{
        let outMidi = base + delta; // parallel slide
        if (assistOn){
          if (symAssistRef.current === "EXPERIMENTAL"){
            outMidi = nearestSelected(outMidi);
          } else { // HARMONIC: snap driver, others keep interval
            if (base === driverBase) outMidi = nearestSelected(outMidi);
            else {
              const drivenSnapped = nearestSelected(driverBase + delta);
              outMidi = base + (drivenSnapped - driverBase);
            }
          }
        }
        const glide = (assistOn && glideRef.current>0) ? glideRef.current/1000 : 0;
        const freq = midiToFreq(outMidi);
        eng.setVoiceFreq(idx, freq, glide);
        applyX(idx, freq, ampScale);
      });
      const drvNote = assistOn ? nearestSelected(driverBase+delta) : (driverBase+delta);
      setReadout({ note: fullName(Math.round(drvNote)), freq: midiToFreq(drvNote), x:nx, y:ny });
      window.dispatchEvent(new CustomEvent("th:move",{detail:{x:nx,y:ny,mode:m,voices:notes.length}}));
      return;
    }

    // THEREMIN / AUTOHARP — single voice (voice 0)
    const midiFloat = LOW_MIDI + (1-ny)*MIDI_SPAN;
    let outMidi = midiFloat, glide = 0;
    if (m === "AUTOHARP"){
      outMidi = nearestSelected(midiFloat);
      glide = glideRef.current>0 ? glideRef.current/1000 : 0;
    } else { // THEREMIN
      if (assistRef.current){
        const near = Math.round(midiFloat);
        outMidi = midiFloat + (near-midiFloat)*0.5;
      }
      glide = 0;
    }
    const freq = midiToFreq(outMidi);
    eng.setVoiceFreq(0, freq, glide);
    applyX(0, freq, 1);
    // mute the other voices in mono modes
    for (let i=1;i<eng.MAXV;i++) eng.setVoiceGain(i,0);

    setReadout({ note: fullName(Math.round(outMidi)), freq, x:nx, y:ny });
    window.dispatchEvent(new CustomEvent("th:move",{detail:{freq,midi:outMidi,x:nx,y:ny,mode:m}}));
  },[computeX, nearestSelected]);

  // panels block play — EXCEPT the studio, keyboard, and chords panel (you play while those are open)
  const panelsOpen = settingsOut || symPickerOpen;

  // slide keyboard back in when switching to THEREMIN
  useEffect(()=>{
    if (mode==="THEREMIN" && keyboardOut) setKeyboardOut(false);
  },[mode]);

  const hasPrimed = useRef(false);
  const start = useCallback((clientX, clientY)=>{
    if (settingsOut || symPickerOpen) return;
    const eng = engineRef.current; if (!eng) return;
    try {
      // ── Audio bring-up, ordered to match the path that's known to work ──
      // The Symphony tab reliably produces sound because it does getCtx →
      // ensureBuses → previewNote (one-shot) inside the gesture. One-shot
      // oscillators with explicit start(now)/stop survive the iOS suspended→
      // running resume; the persistent voice pool, whose gain is ramped later,
      // does not if it's built before the clock advances. So we mirror the
      // working path: create+resume the context, fire the one-shot prime FIRST
      // (this is what actually wakes iOS audio), THEN build the live pool.
      const c = eng.getCtx();
      eng.unlock?.();
      eng.ensureBuses?.();
      if (!hasPrimed.current) {
        hasPrimed.current = true;
        const w = WAVE_TYPE[waveRef.current]||waveRef.current;
        // soft C-major-7, same one-shot path Symphony uses to wake the context
        [0,4,7,11].forEach(iv=>{
          eng.previewNote?.(midiToFreq(60+iv), w, 0.6, 0.10);
        });
      }
      const build = ()=>{
        eng.start(WAVE_TYPE[waveRef.current]||waveRef.current);
        pushFxParams(fxParamsRef.current);
        eng.kick?.();
        if (activeRef.current) updateFromPointer(clientX, clientY);
      };
      build();
      // If the context was still parked, rebuild once it's genuinely running.
      if (c && c.state === "suspended" && c.resume) {
        c.resume().then(()=>{ try{ build(); }catch(_){} });
      }
    } catch(_) {}
    activeRef.current = true;
    setActive(true); haptic(10);
    updateFromPointer(clientX, clientY);
  },[settingsOut, symPickerOpen, updateFromPointer, pushFxParams]);

  // Wake/prime audio from ANY user gesture the same way the Symphony tab does
  // (the path that's always worked): create+resume the context, ensure buses,
  // and fire one silent-ish one-shot so iOS flips suspended→running. Safe to
  // call repeatedly; the heavy prime only happens once.
  const wakeAudio = useCallback(()=>{
    const eng = engineRef.current; if (!eng) return;
    try {
      eng.getCtx(); eng.unlock?.(); eng.ensureBuses?.();
      if (!hasPrimed.current) {
        hasPrimed.current = true;
        const w = WAVE_TYPE[waveRef.current]||waveRef.current;
        eng.previewNote?.(midiToFreq(60), w, 0.25, 0.04); // brief, quiet wake tone
      }
    } catch(_) {}
  },[]);

  const end = useCallback(()=>{
    engineRef.current?.silenceAll();
    // if recording, mark a gate-off point so playback silences when the finger was up
    const S = studioRefs.current;
    if (S.recState === "recording"){
      const t = engineRef.current.getCtx().currentTime - S.captureStart;
      if (t >= 0 && t <= S.loopLen) S.capture.push({ t, gate:0 });
    }
    setActive(false);
    setReadout(r=>({...r, note:"—"}));
  },[]);

  const onPointerDown=(e)=>{ if(panelsOpen) return; e.preventDefault(); fieldRef.current?.setPointerCapture?.(e.pointerId); start(e.clientX,e.clientY); };
  const onPointerMove=(e)=>{ if(!activeRef.current) return; e.preventDefault(); updateFromPointer(e.clientX,e.clientY); };
  const onPointerUp  =(e)=>{ e.preventDefault(); end(); };

  // ── Studio transport: metronome + count-in + capture + gesture playback ──────
  const transportRef = useRef(null);  // setTimeout handle
  const playbackRef = useRef({ active:false, slotPlays:[] }); // for arranger later; now: monitor + preview

  const loopLength = useCallback(()=>{
    const spb = 60 / bpm;                 // seconds per beat
    return spb * beatsPerMeasure * measures;
  },[bpm, beatsPerMeasure, measures]);

  // Schedule clicks + drive capture/playback. We use a lookahead scheduler.
  const stopTransport = useCallback(()=>{
    clearTimeout(transportRef.current);
    transportRef.current = null;
    const eng = engineRef.current;
    eng?.pbSilenceAll?.();
    playbackRef.current.active = false;
    // if we were recording/counting-in, bring the studio panel back
    const wasRecording = studioRefs.current.recState==="recording" || studioRefs.current.recState==="countin";
    setRecState("idle"); studioRefs.current.recState = "idle";
    setRecBeat(-1); setRecProgress(0); setArrPos(-1);
    if (wasRecording) setStudioOut(true);
  },[]);

  // Play back a set of slots for one loop, re-synthesizing via resolveFrame.
  // Returns a function called each tick with elapsed time to update voices.
  const buildSlotPlayers = useCallback((slotIndices)=>{
    const eng = engineRef.current;
    const players = [];
    let voiceCursor = 0;
    slotIndices.forEach(si=>{
      const slot = studioRefs.current.slots[si];
      if (!slot || !slot.gesture || slot.gesture.length===0) return;
      const nVoice = slot.patch.mode==="SYMPHONY" ? Math.max(1,(slot.patch.symNotes||[]).length) : 1;
      const base = voiceCursor; voiceCursor += nVoice;
      // route this slot's voices to wet (effects) or dry, per its fxEnabled flag
      const wet = slot.fxEnabled !== false;
      for(let v=0; v<nVoice; v++) eng.pbRoute?.(base+v, wet);
      players.push({ slot, base, nVoice });
    });
    return players;
  },[]);

  const tickPlayers = useCallback((players, loopT)=>{
    const eng = engineRef.current;
    players.forEach(({slot, base, nVoice})=>{
      const g = slot.gesture;
      let lo=0, hi=g.length-1, idx=0;
      while(lo<=hi){ const mid=(lo+hi)>>1; if(g[mid].t<=loopT){idx=mid;lo=mid+1;} else hi=mid-1; }
      const f = g[idx];
      if (!f){ for(let v=0;v<nVoice;v++) eng.pbSilence(base+v); return; }
      if (f.gate===0){ for(let v=0;v<nVoice;v++) eng.pbSilence(base+v); return; }
      const res = resolveFrame(f.nx, f.ny, slot.patch);
      res.voices.forEach((v,vi)=>{
        eng.pbSet(base+vi, { freq:v.freq, gain:v.gain, wave:res.wave,
          warbleRate:v.warbleRate, warbleDepth:v.warbleDepth });
      });
      for(let v=res.voices.length; v<nVoice; v++) eng.pbSilence(base+v);
    });
  },[]);

  const startRecording = useCallback(()=>{
    const eng = engineRef.current;
    eng.getCtx(); eng.pbEnsureMaster(); eng.pbStart(); eng.start(waveRef.current);
    const spb = 60 / bpm;
    const loopLen = loopLength();
    const t0 = eng.getCtx().currentTime + 0.12;

    const S = studioRefs.current;
    S.capture = [];
    S.loopLen = loopLen;
    S.recSlot = recSlot;

    const monitors = [...S.monitorSlots].filter(si=>si!==recSlot);
    const hasMonitors = monitors.length > 0;
    const players = buildSlotPlayers(monitors);

    // If monitors exist: play them for one full loop (preroll), then record.
    // If no monitors: use a one-measure metronome count-in (original behaviour).
    const prerollLen = hasMonitors ? loopLen : (spb * beatsPerMeasure);
    const recStartTime = t0 + prerollLen;
    S.captureStart = recStartTime;

    setRecState("countin"); S.recState = "countin";
    setStudioOut(false); // hide panel so the pad is visible

    // Schedule metronome clicks: always play during both preroll and the take
    if (S.metroOn){
      const totalBeats = Math.round((prerollLen + loopLen) / spb);
      for (let b=0; b<totalBeats; b++)
        eng.click(t0 + b*spb, b % beatsPerMeasure === 0);
    }

    const loop = ()=>{
      const now = eng.getCtx().currentTime;
      const elapsed = now - t0;

      if (elapsed < prerollLen){
        // preroll phase: play monitors, show countdown
        if (players.length) tickPlayers(players, elapsed % loopLen);
        const beatsIn = Math.floor(elapsed / spb);
        const beatsLeft = Math.round(prerollLen/spb) - beatsIn;
        setRecBeat(-beatsLeft); // negative = counting down
        setRecProgress(elapsed / prerollLen * 0.5); // fill to 50% during preroll
        transportRef.current = setTimeout(loop, 16);
        return;
      }

      // recording phase
      if (S.recState === "countin"){ S.recState="recording"; setRecState("recording"); }
      const loopT = elapsed - prerollLen;
      if (players.length) tickPlayers(players, loopT % loopLen);
      const beatIdx = Math.floor(loopT/spb);
      setRecBeat(beatIdx);
      setRecProgress(0.5 + Math.min(0.5, loopT/loopLen*0.5)); // 50%→100% during take

      if (loopT >= loopLen){
        eng.pbSilenceAll();
        const gesture = S.capture.slice();
        const patch = currentPatch();
        setSlots(prev=>{ const n=[...prev]; n[recSlot]={ gesture, patch, mode:patch.mode, length:loopLen, fxEnabled:true }; return n; });
        stopTransport();
        return;
      }
      transportRef.current = setTimeout(loop, 12);
    };
    loop();
  },[bpm, beatsPerMeasure, measures, recSlot, loopLength, buildSlotPlayers, tickPlayers, currentPatch, stopTransport]);

  // Preview-play a single slot once (for auditioning)
  const previewSlot = useCallback((si)=>{
    const eng = engineRef.current;
    eng.getCtx(); eng.pbEnsureMaster(); eng.pbStart();
    const slot = studioRefs.current.slots[si];
    if (!slot) return;
    const players = buildSlotPlayers([si]);
    const loopLen = slot.length || loopLength();
    const t0 = eng.getCtx().currentTime;
    setRecState("playing"); studioRefs.current.recState="playing";
    const loop = ()=>{
      const now = eng.getCtx().currentTime;
      const loopT = now - t0;
      tickPlayers(players, Math.min(loopT, loopLen-0.001));
      setRecProgress(Math.min(1, loopT/loopLen));
      if (loopT >= loopLen){ eng.pbSilenceAll(); stopTransport(); return; }
      transportRef.current = setTimeout(loop, 12);
    };
    loop();
  },[buildSlotPlayers, tickPlayers, loopLength, stopTransport]);

  const clearSlot = useCallback((si)=>{
    setSlots(prev=>{ const n=[...prev]; n[si]=null; return n; });
    // also remove from arranger cells
    setArrRows(prev=>prev.map(row=>row.map(c=>c===si?null:c)));
  },[]);

  const toggleMonitor = useCallback((si)=>{
    setMonitorSlots(prev=>{ const n=new Set(prev); if(n.has(si))n.delete(si); else n.add(si); return n; });
  },[]);

  // ── Arranger playback: 3 rows in lockstep, each column = one loop length ──
  const playArrangement = useCallback(()=>{
    const eng = engineRef.current;
    eng.getCtx(); eng.pbEnsureMaster(); eng.pbStart();
    const S = studioRefs.current;
    const rows = S.arrRows, mutes = S.arrMutes;

    // last column that has any filled cell → loop bound
    let lastCol = -1;
    for (let c=0;c<ARR_CELLS;c++) if (rows.some(r=>r[c]!==null)) lastCol=c;
    if (lastCol < 0) return; // nothing to play
    const numCols = lastCol+1;
    const loopLen = loopLength();

    // metronome clicks for the whole arrangement (optional)
    const spb = 60/bpm;
    const t0 = eng.getCtx().currentTime + 0.12;

    setRecState("playing"); S.recState="playing";

    let colPlayers = null, colStart = t0, curCol = -1;

    const buildColumn = (col)=>{
      // which slots are active this column (across non-muted rows)
      const sis = [];
      for (let r=0;r<rows.length;r++){
        if (mutes[r]) continue;
        const si = rows[r][col];
        if (si!==null && S.slots[si]) sis.push(si);
      }
      return buildSlotPlayers(sis);
    };

    const loop = ()=>{
      const now = eng.getCtx().currentTime;
      const elapsed = now - t0;
      const col = Math.floor(elapsed / loopLen) % numCols;
      const colT = elapsed - Math.floor(elapsed/loopLen)*loopLen;

      if (col !== curCol){
        curCol = col; colPlayers = buildColumn(col);
        eng.pbSilenceAll();
        setArrPos(col);
      }
      if (colPlayers && colPlayers.length) tickPlayers(colPlayers, Math.min(colT, loopLen-0.001));
      // metronome click on each beat if enabled
      setRecProgress(colT/loopLen);
      transportRef.current = setTimeout(loop, 12);
    };
    loop();
  },[bpm, loopLength, buildSlotPlayers, tickPlayers]);

  const dropSlotInCell = useCallback((row, cell)=>{
    setArrRows(prev=>prev.map((r,ri)=>{
      if (ri!==row) return r;
      const n=[...r];
      // tapping a cell assigns the armed slot if filled; tapping same removes
      n[cell] = (n[cell]===recSlot) ? null : recSlot;
      return n;
    }));
  },[recSlot]);

  const clearArrRow = useCallback((row)=>{
    setArrRows(prev=>prev.map((r,ri)=>ri===row?Array(ARR_CELLS).fill(null):r));
  },[]);
  const toggleArrMute = useCallback((row)=>{
    setArrMutes(prev=>prev.map((m,i)=>i===row?!m:m));
  },[]);

  // per-note pitch override for piano-roll editing (autoharp slots only)
  const toggleSlotFx = useCallback((si)=>{
    setSlots(prev=>prev.map((s,i)=> (i===si && s) ? {...s, fxEnabled: s.fxEnabled===false} : s));
  },[]);

  const transposeSlot = useCallback((si, semis)=>{
    setSlots(prev=>prev.map((s,i)=>{
      if (i!==si || !s) return s;
      const shift = semis / MIDI_SPAN;
      const gesture = s.gesture.map(f=> f.nx==null ? f
        : { ...f, ny: Math.max(0, Math.min(1, f.ny - shift)) });
      return { ...s, gesture };
    }));
  },[]);

  // ── Melody save / load ──────────────────────────────────────────────────────
  const [melodyStatus, setMelodyStatus] = useState("");
  const saveMelody = useCallback(()=>{
    const data = {
      version: 2, kind: "cosmophone-melody",
      bpm, beatsPerMeasure, measures,
      slots: slots.map(s => s ? { gesture:s.gesture, patch:s.patch, mode:s.mode, length:s.length, fxEnabled:s.fxEnabled!==false } : null),
      arrRows, arrMutes, fxParams,
    };
    const blob = new Blob([JSON.stringify(data)], {type:"application/json"});
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href=url; a.download="cosmophone-melody.json"; a.click();
    URL.revokeObjectURL(url);
    setMelodyStatus("saved!"); setTimeout(()=>setMelodyStatus(""),1800);
  },[bpm,beatsPerMeasure,measures,slots,arrRows,arrMutes,fxParams]);

  const loadMelody = useCallback(()=>{
    const input=document.createElement("input");
    input.type="file"; input.accept=".json,application/json";
    input.onchange=(e)=>{
      const file=e.target.files[0]; if(!file) return;
      const reader=new FileReader();
      reader.onload=(ev)=>{
        try{
          const d=JSON.parse(ev.target.result);
          if(d.kind!=="cosmophone-melody"){ setMelodyStatus("not a melody!"); setTimeout(()=>setMelodyStatus(""),2200); return; }
          if(d.bpm) setBpm(d.bpm);
          if(d.beatsPerMeasure) setBeatsPerMeasure(d.beatsPerMeasure);
          if(d.measures) setMeasures(d.measures);
          if(d.slots) setSlots(d.slots.map(s=>s?{...s}:null));
          if(d.arrRows) setArrRows(d.arrRows);
          if(d.arrMutes) setArrMutes(d.arrMutes);
          if(d.fxParams) setFxParams(d.fxParams);
          setMelodyStatus("loaded!"); setTimeout(()=>setMelodyStatus(""),1800);
        }catch(_){ setMelodyStatus("error!"); setTimeout(()=>setMelodyStatus(""),2200); }
      };
      reader.readAsText(file);
    };
    input.click();
  },[]);

  useEffect(()=>()=>clearTimeout(transportRef.current),[]);


  // ── Module API ───────────────────────────────────────────────────────────
  useEffect(()=>{
    window.Cosmophone = {
      setWaveform:(w)=>WAVEFORMS.includes(w)&&setWaveform(w),
      setMode:(m)=>MODES.includes(m)&&setMode(m),
      getState:()=>({mode:modeRef.current,waveform:waveRef.current,active:activeRef.current}),
    };
    const h=(e)=>{ if(e.data?.target!=="cosmophone")return;
      const{action,payload}=e.data;
      if(action==="setWaveform")setWaveform(payload);
      if(action==="setMode")setMode(payload); };
    window.addEventListener("message",h);
    return ()=>window.removeEventListener("message",h);
  },[]);

  // ── note selection (shared lit-note set) ─────────────────────────────────
  const toggleNote=(m)=>{
    if (CHORD_SHAPES[chordName]) setChordName("Free (all notes)");
    setSelected(prev=>{ const n=new Set(prev); if(n.has(m))n.delete(m); else n.add(m);
      if(n.size===0)n.add(m); return n; });
    haptic(6);
  };

  // symphony note picking — driver is protected; overwrite evicts oldest RED key
  const toggleSymNote=(m)=>{
    const cur = symNotesRef.current;
    const driver = symDriverRef.current;
    const order = symOrder;

    if (cur.includes(m)) {
      // remove this note
      const n = cur.filter(x=>x!==m);
      const newOrder = order.filter(x=>x!==m);
      setSymNotes(n);
      setSymOrder(newOrder);
      if (m === driver) {
        // driver removed → oldest remaining becomes new driver
        setSymDriver(newOrder.length ? newOrder[0] : null);
      }
      haptic(6);
      return;
    }

    // adding a note
    if (cur.length < MAX_SYM_NOTES) {
      const n = [...cur, m].sort((a,b)=>a-b);
      const newOrder = [...order, m];
      setSymNotes(n);
      setSymOrder(newOrder);
      if (driver == null) setSymDriver(m); // first note pressed becomes driver
      haptic(6);
      return;
    }

    // full → evict the oldest RED (non-driver) key, keep driver protected
    const oldestRed = order.find(x => x !== driver);
    if (oldestRed == null) return; // shouldn't happen with 5 notes & 1 driver
    const n = cur.filter(x=>x!==oldestRed).concat(m).sort((a,b)=>a-b);
    const newOrder = order.filter(x=>x!==oldestRed).concat(m);
    setSymNotes(n);
    setSymOrder(newOrder);
    haptic(10);
  };

  // long-press a selected note to make it the gold driver
  const setDriverNote=(m)=>{
    if (!symNotesRef.current.includes(m)) return;
    setSymDriver(m);
    haptic(18);
  };

  const previewChord = useCallback((midis)=>{
    const eng = engineRef.current;
    eng.getCtx(); eng.ensureBuses();
    const perVoice = 0.3 / midis.length;
    midis.forEach(midi=>{
      eng.previewNote(midiToFreq(midi), WAVE_TYPE[waveRef.current]||waveRef.current, 1.0, perVoice);
    });
  },[]);

  const applySymChord = useCallback((ivs)=>{
    const midis = symChordMidis(ivs);
    setSymNotes(midis);
    setSymOrder(midis);
    setSymDriver(symChordDriver(midis));
    previewChord(midis);
    haptic(12);
  },[previewChord]);

  // track whether we've ever entered symphony mode (for default chord + tooltip)
  const symHasDefaulted = useRef(false);

  const keyNotes=[]; for(let m=HIGH_MIDI;m>=LOW_MIDI;m--) keyNotes.push(m);

  const autoharp = mode==="AUTOHARP";
  const symphony = mode==="SYMPHONY";
  const litShown = autoharp || (symphony && pitchAssist);

  // ── Render ───────────────────────────────────────────────────────────────
  return (
    <div style={{height:"100vh",maxHeight:"100vh",overflow:"hidden",
      background:`radial-gradient(ellipse at 50% 0%, #2c2114 0%, ${INK} 55%, #0d0a07 100%)`,
      display:"flex",flexDirection:"column",alignItems:"center",
      fontFamily:"'Cormorant Garamond', Georgia, serif",color:BRASS_LT,
      padding:"8px 8px 0",userSelect:"none",WebkitUserSelect:"none",position:"relative",
      backgroundImage:`radial-gradient(ellipse at 50% 0%, #2c2114 0%, ${INK} 55%, #0d0a07 100%),
        repeating-linear-gradient(45deg, #ffffff03 0 2px, transparent 2px 5px)`}}>

      <div style={{width:"100%",maxWidth:"760px",display:"flex",flexDirection:"column",
        height:"100%",minHeight:0}}>

        {/* ── Title ── */}
        <div style={{textAlign:"center",marginBottom:"6px",flexShrink:0}}>
          <div style={{display:"block",padding:"5px 22px",
            border:`2px solid ${BRASS}`,borderRadius:"3px",
            background:"linear-gradient(180deg,#3a2c1a,#241a10)",
            boxShadow:`inset 0 1px 0 ${BRASS_LT}55, 0 3px 10px #000a, 0 0 24px ${BRASS}22`,
            overflow:"hidden"}}>
            <div style={{fontFamily:"'Poiret One',sans-serif",fontWeight:400,letterSpacing:"5px",
              fontSize:"clamp(16px,4.5vw,26px)",
              background:`linear-gradient(180deg,${GOLD},${BRASS} 60%,#6b4e0a)`,
              WebkitBackgroundClip:"text",WebkitTextFillColor:"transparent",backgroundClip:"text"}}>
              COSMOPHONE</div>
            <div style={{fontFamily:"'Poiret One',sans-serif",
              fontSize:"10px",letterSpacing:"3px",
              color:"#888",marginTop:"1px",
              whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>
              {TAGLINES[taglineIdx].toUpperCase()}</div>
          </div>
        </div>

        {/* ── Stage: keyboard + field, fills remaining height ── */}
        <div style={{flex:1,minHeight:0,display:"flex",gap:"8px",position:"relative"}}>

          {/* Play field (always rendered; inert when panels out) */}
          <div ref={fieldRef}
            onPointerDown={onPointerDown} onPointerMove={onPointerMove}
            onPointerUp={onPointerUp} onPointerCancel={onPointerUp}
            style={{flex:1,position:"relative",height:"100%",
              border:`2px solid ${BRASS}`,borderRadius:"8px",
              cursor:panelsOpen?"not-allowed":"crosshair",
              background:`radial-gradient(ellipse at 50% 50%, #2a1d3a 0%, #1a1226 45%, #0e0a16 100%)`,
              ...(ART_PAD_BG ? {
                backgroundImage:`radial-gradient(ellipse at 50% 50%, #2a1d3acc 0%, #1a1226cc 45%, #0e0a16cc 100%), url(${ART_PAD_BG})`,
                backgroundSize:"cover, cover",
                backgroundPosition:"center, center",
              } : {}),
              boxShadow:`inset 0 0 40px #000c, 0 0 22px ${VIOLET}22`,
              touchAction:"none",overflow:"hidden",
              opacity:panelsOpen?0.45:1,transition:"opacity .2s"}}>

            {/* dead-zone shading */}
            <div style={{position:"absolute",top:0,bottom:0,left:0,width:`${DEAD_ZONE*100}%`,
              background:`linear-gradient(90deg, ${RED}1e, transparent)`,pointerEvents:"none"}}/>
            <div style={{position:"absolute",top:0,bottom:0,right:0,width:`${DEAD_ZONE*100}%`,
              background:`linear-gradient(270deg, ${RED}1e, transparent)`,pointerEvents:"none"}}/>

            {/* note rulings */}
            {Array.from({length:MIDI_SPAN+1},(_,i)=>{
              const mm=LOW_MIDI+i, y=(1-i/MIDI_SPAN)*100, isC=noteName(mm)==="C", sel=selected.has(mm);
              const rulingColor = litShown&&sel ? (autoharp?`${SAGE}66`:`${VIOLET_LT}55`) : isC?`${BRASS}33`:`${BRASS}12`;
              return <div key={mm} style={{position:"absolute",left:0,right:0,top:`${y}%`,
                height:isC?"1.5px":"1px",
                background: rulingColor,
                pointerEvents:"none"}}/>;
            })}

            {/* axis labels */}
            <div style={lblBL()}>◄ {xAxis==="VOLUME"?"QUIET":"STILL"}</div>
            <div style={lblBR()}>{xAxis==="VOLUME"?"LOUD":"FAST"} ►</div>
            <div style={lblTL()}>▲ HIGH</div>

            {/* finger orb(s) */}
            {active && !panelsOpen && (
              <div style={{position:"absolute",left:`${readout.x*100}%`,top:`${readout.y*100}%`,
                width:"46px",height:"46px",marginLeft:"-23px",marginTop:"-23px",borderRadius:"50%",
                pointerEvents:"none",border:`2px solid ${GOLD}`,
                background:`radial-gradient(circle, ${RED}55 0%, ${VIOLET}22 60%, transparent 70%)`,
                boxShadow:`0 0 24px ${GOLD}, 0 0 50px ${RED}88`}}>
                <div style={{position:"absolute",inset:"16px",borderRadius:"50%",
                  background:GOLD,boxShadow:`0 0 14px ${GOLD}`}}/>
              </div>
            )}

            {/* readout */}
            <div style={{position:"absolute",top:"8px",right:"10px",textAlign:"right",pointerEvents:"none"}}>
              <div style={{fontFamily:"'Cinzel',serif",fontWeight:700,fontSize:"26px",
                color:active?GOLD:`${BRASS}55`,textShadow:active?`0 0 14px ${GOLD}99`:"none",lineHeight:1}}>
                {readout.note}</div>
              <div style={{fontFamily:"'Share Tech Mono',monospace",fontSize:"11px",color:`${BRASS}99`}}>
                {readout.freq?readout.freq.toFixed(1)+" Hz":""}</div>
              {symphony && <div style={{fontFamily:"'Share Tech Mono',monospace",fontSize:"10px",color:`${VIOLET_LT}cc`}}>
                {symNotes.length} VOICE{symNotes.length===1?"":"S"}</div>}
            </div>

            {/* mode badge */}
            <div style={{position:"absolute",top:"8px",left:"10px",pointerEvents:"none",
              fontFamily:"'Cinzel',serif",fontWeight:600,fontSize:"13px",letterSpacing:"2px",
              color: symphony?VIOLET_LT:autoharp?SAGE:RED_LT,
              textShadow:`0 0 10px ${symphony?VIOLET:autoharp?SAGE:RED}66`}}>{mode}</div>

            {/* panels-out hint */}
            {panelsOpen && (
              <div style={{position:"absolute",inset:0,display:"flex",alignItems:"center",justifyContent:"center",
                pointerEvents:"none"}}>
                <span style={{fontFamily:"'Cinzel',serif",fontSize:"15px",letterSpacing:"3px",
                  color:`${BRASS}aa`,textAlign:"center"}}>STOW PANELS TO PLAY</span>
              </div>
            )}
          </div>

          {/* Retractable keyboard — overlays the stage from the left, locked to field bounds.
              Keys span exactly top:0 to bottom:0 matching the pad. The ✕ dismiss button
              floats above the pad border as a separate absolutely-positioned element. */}
          <div style={{position:"absolute",top:0,left:0,bottom:0,width:"62px",
            transform:keyboardOut?"translateX(0)":"translateX(-68px)",
            transition:"transform .25s ease",zIndex:5,
            pointerEvents:keyboardOut?"auto":"none"}}>
          {/* CHORDS button — opens chord/scale picker for both Autoharp and Symphony */}
            <button onClick={()=>setAhPickerOpen(o=>!o)}
              style={{position:"absolute",top:"-67px",left:0,right:0,height:"65px",
                border:`2px solid ${BRASS}`,borderBottom:"none",
                borderRadius:"6px 6px 0 0",cursor:"pointer",
                background:`linear-gradient(180deg,${SAGE_DK},${SAGE_DK})`,color:"#ffffff",
                fontFamily:"'Poiret One',sans-serif",fontWeight:400,letterSpacing:"2px",
                zIndex:6,overflow:"hidden",
                display:"flex",alignItems:"center",justifyContent:"center"}}>
              {/* treble clef — anchored to top of button (= right in user's frame) */}
              <span aria-hidden="true" style={{position:"absolute",top:"-8px",left:"60%",
                transform:"translateX(-50%)",
                fontSize:"72px",lineHeight:1,color:"#000",opacity:0.45,
                pointerEvents:"none",userSelect:"none",fontFamily:"serif"}}>𝄞</span>
              {/* label — anchored to bottom of button (= left in user's frame)
                  writingMode makes text flow vertically; rotate(180deg) flips it
                  so it reads bottom-to-top (toward the user's left). Both must be
                  in a single style prop — React objects deduplicate keys. */}
              <span style={{position:"absolute",top:"50%",left:0,right:0,
                display:"flex",justifyContent:"center",zIndex:1,
                writingMode:"vertical-rl",
                transform:"translate(8px,-50%) rotate(180deg)",
                letterSpacing:"3px",fontSize:"9px",lineHeight:1}}>CHORDS</span>
            </button>
            {/* Keys — full field height, no compression */}
            <div style={{position:"absolute",top:0,left:0,right:0,bottom:0,
              display:"flex",flexDirection:"column",
              border:`2px solid ${BRASS}`,borderRadius:"0 0 6px 6px",overflow:"hidden",
              background:PANEL,boxShadow:keyboardOut?`0 0 20px #000c, 4px 0 16px #000a`:"none"}}>
            {keyNotes.map(m=>{
              const on=selected.has(m), blk=isBlack(m);
              return (
                <button key={m} onClick={()=>toggleNote(m)}
                  style={{flex:1,minHeight:0,border:"none",cursor:"pointer",
                    borderTop:noteName(m)==="C"?`1px solid ${BRASS}66`:"none",
                    background:on?`linear-gradient(90deg, ${SAGE_DK}, ${SAGE})`:(blk?"#110c06":"#2e2116"),
                    boxShadow:on?`inset 0 0 4px ${SAGE}88`:"none",
                    display:"flex",alignItems:"center",justifyContent:"space-between",padding:"0 5px",
                    transition:"background .12s"}}>
                  <span style={{fontSize:"9px",fontFamily:"'Poiret One',sans-serif",
                    letterSpacing:"1px",
                    color:"#ffffff",opacity:on?1:0.7}}>{noteName(m)}</span>
                  <span style={{width:"5px",height:"5px",borderRadius:"50%",
                    background:on?SAGE:"#0008",boxShadow:on?`0 0 5px ${SAGE}`:"none"}}/>
                </button>
              );
            })}
            </div>
          </div>
        </div>

        {/* ── Rail decoration (handmade art strip) ── */}
        {ART_RAIL_DECO && (
          <div style={{flexShrink:0,width:"100%",height:"32px",marginBottom:"2px",
            borderRadius:"4px",overflow:"hidden",
            border:`1px solid ${BRASS}44`}}>
            <img src={ART_RAIL_DECO} alt=""
              style={{width:"100%",height:"100%",objectFit:"cover",objectPosition:"center",
                display:"block",opacity:0.85}}/>
          </div>
        )}

        {/* ── Toggle rail ── */}
        {/* STUDIO button preserved but hidden — re-enable when ready:
            <RailBtn icon="●" label="STUDIO" on={studioOut} disabled={active}
              onClick={()=>!active && setStudioOut(o=>!o)} color={RED}/> */}
        <div style={{flexShrink:0,display:"flex",gap:"4px",padding:"5px 0",alignItems:"stretch"}}>
          <RailBtn icon="▼" label={keyboardOut?"STOW":"KEYS"}
            on={keyboardOut}
            disabled={active}
            overlay={mode==="THEREMIN"}
            onClick={()=>{ if(!active){
              if(mode==="THEREMIN"){ wakeAudio(); setMode("AUTOHARP"); setKeyboardOut(true); }
              else setKeyboardOut(o=>!o);
            }}} color={SAGE}/>
          <RailBtn icon="〰" label="THEREMIN" iconWeight="bold"
            on={mode==="THEREMIN"} disabled={active}
            onClick={()=>{ if(!active){ wakeAudio(); setMode("THEREMIN"); } }} color={RED_LT}/>
          <RailBtn icon="♬"
            label={mode==="AUTOHARP" ? "CHORDS" : "AUTOHARP"}
            on={mode==="AUTOHARP"} disabled={active}
            onClick={()=>{ if(!active){
              wakeAudio();
              if(mode==="AUTOHARP") setAhPickerOpen(o=>!o);
              else setMode("AUTOHARP");
            }}} color={SAGE}/>
          <RailBtn
            icon={mode==="SYMPHONY" ? "◈" : "♦"}
            label={mode==="SYMPHONY" ? "VOICES" : "SYMPHONY"}
            on={mode==="SYMPHONY"} disabled={active}
            onClick={()=>{ if(!active){
              if(mode==="SYMPHONY") setSymPickerOpen(o=>!o);
              else {
                setMode("SYMPHONY");
                if(!symHasDefaulted.current){
                  symHasDefaulted.current = true;
                  applySymChord([0,7,11,16]);
                }
              }
            }}} color={VIOLET_LT}/>
          <RailBtn icon="≡" label="SETTINGS"
            on={settingsOut} disabled={active}
            onClick={()=>!active && setSettingsOut(o=>!o)} color={BRASS}/>
        </div>
      </div>

      {/* ── SETTINGS panel (slides up — unified controls + effects) ── */}
      <div style={{position:"fixed",left:0,right:0,bottom:0,zIndex:20,
        transform:settingsOut?"translateY(0)":"translateY(110%)",
        transition:"transform .28s ease",
        display:"flex",justifyContent:"center",padding:"0 8px 8px",pointerEvents:"none"}}>
        <div style={{width:"100%",maxWidth:"760px",pointerEvents:settingsOut?"auto":"none",
          border:`2px solid ${BRASS}`,borderRadius:"10px 10px 8px 8px",padding:"12px",
          background:"linear-gradient(180deg,#2c2014,#1d150d)",
          boxShadow:`inset 0 1px 0 ${BRASS_LT}33, 0 -6px 24px #000c`,
          maxHeight:"92vh",overflowY:"auto"}}>

          {/* ── Header ── */}
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",
            marginBottom:"10px",position:"sticky",top:0,zIndex:2,
            paddingBottom:"8px",borderBottom:`1px solid ${BRASS}22`,
            background:"linear-gradient(180deg,#2c2014,#2c2014 70%,transparent)"}}>
            <span style={{fontFamily:"'Cinzel',serif",fontWeight:700,letterSpacing:"3px",
              fontSize:"14px",color:BRASS_LT}}>SETTINGS</span>
            <div style={{display:"flex",gap:"8px"}}>
              <button onClick={()=>{ setSettingsOut(false); setFxOut(true); }}
                style={{fontFamily:"'Cinzel',serif",fontWeight:600,fontSize:"11px",letterSpacing:"1px",
                  padding:"7px 14px",borderRadius:"5px",cursor:"pointer",
                  color:VIOLET_LT,border:`2px solid ${VIOLET}`,
                  background:`linear-gradient(180deg,${VIOLET}44,${VIOLET}22)`,
                  boxShadow:`0 0 10px ${VIOLET}44`}}>✦ EFFECTS</button>
              <button onClick={()=>setSettingsOut(false)} style={chip(true,BRASS)}>✕ CLOSE</button>
            </div>
          </div>

          {/* ── Pitch assist ── */}
          <div style={{display:"flex",gap:"8px",flexWrap:"wrap",marginBottom:"12px",alignItems:"flex-end"}}>
            {!symphony && (
              <button onClick={()=>setPitchAssist(p=>!p)} disabled={autoharp}
                style={lampBtn(pitchAssist&&!autoharp,GOLD,autoharp)}>
                <Lamp on={pitchAssist&&!autoharp} color={GOLD}/> PITCH ASSIST
              </button>
            )}
            {symphony && (
              <button onClick={()=>setPitchAssist(p=>!p)} style={lampBtn(pitchAssist,GOLD,false)}>
                <Lamp on={pitchAssist} color={GOLD}/> PITCH ASSIST
              </button>
            )}
            <Toggle label="X AXIS" value={xAxis} options={["VOLUME","WARBLE"]}
              onPick={setXAxis} activeColor={RED}/>
          </div>

          {/* symphony assist sub-toggle */}
          {symphony && pitchAssist && (
            <div style={{marginBottom:"12px"}}>
              <Toggle label="ASSIST CHARACTER" value={symAssistMode}
                options={["HARMONIC","EXPERIMENTAL"]} onPick={setSymAssistMode}
                activeColor={symAssistMode==="EXPERIMENTAL"?RED:VIOLET}/>
              {symAssistMode==="EXPERIMENTAL" && (
                <div style={{marginTop:"6px",fontFamily:"'Share Tech Mono',monospace",fontSize:"10px",
                  letterSpacing:"1px",color:RED_LT}}>
                  ⚠ CAUTION: EXPERIMENTAL — voices snap independently. Intervals will flex. Have fun!
                </div>
              )}
            </div>
          )}

          {/* symphony driver selector + voices button */}
          {symphony && (
            <div style={{marginBottom:"12px"}}>
              <div style={{display:"flex",alignItems:"center",gap:"8px",marginBottom:"6px"}}>
                <Label>SYMPHONY VOICES</Label>
                <button onClick={()=>setSymPickerOpen(true)}
                  style={{...chip(false,VIOLET_LT),fontSize:"11px",padding:"5px 10px"}}>
                  EDIT VOICES →
                </button>
              </div>
              {symNotes.length>0 && (
                <div style={{display:"flex",gap:"5px",flexWrap:"wrap"}}>
                  <Label>DRIVER (gold) · tap to reassign</Label>
                  <div style={{display:"flex",gap:"5px",flexWrap:"wrap",width:"100%"}}>
                    {symNotes.map((m)=>{
                      const isDriver = symDriver===m;
                      return (
                        <button key={m} onClick={()=>setSymDriver(m)}
                          style={{...chip(isDriver, isDriver?GOLD:RED),
                            borderColor:isDriver?GOLD:RED,minWidth:"54px",
                            color:isDriver?"#1a1208":"#fff",
                            background:isDriver?`linear-gradient(180deg,${GOLD},${BRASS})`
                                               :`linear-gradient(180deg,${RED},#7a241b)`}}>
                          {fullName(m)}
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* waveform */}
          <div style={{marginBottom:"12px"}}>
            {/* basics row — full width */}
            <div style={{display:"flex",gap:"6px",alignItems:"center",marginBottom:"6px",flexWrap:"nowrap"}}>
              <Label>VOICE</Label>
              {WAVEFORMS.map(w=>(
                <button key={w} onClick={()=>setWaveform(w)}
                  style={{...chip(waveform===w,BRASS),
                    textTransform:"capitalize",
                    fontSize:"10px",padding:"6px 8px",
                    flex:1,minWidth:0,textAlign:"center"}}>
                  {w==="triangle"?"TRI":w==="sine"?"SINE":w==="saw"?"SAW":"SQR"}</button>
              ))}
            </div>
            {/* preset rows + visualizer side by side */}
            <div style={{display:"flex",gap:"8px",alignItems:"stretch"}}>
              <div style={{flex:1,display:"flex",flexWrap:"wrap",gap:"4px",alignContent:"flex-start"}}>
                {PRESET_NAMES.map(p=>(
                  <button key={p} onClick={()=>setWaveform(p)}
                    style={{...chip(waveform===p,VIOLET),
                      fontSize:"9px",padding:"5px 7px",letterSpacing:"0.5px",
                      fontFamily:"'Share Tech Mono',monospace"}}>
                    {p}</button>
                ))}
              </div>
              <WavePreview waveform={waveform}/>
            </div>
          </div>

          {/* sliders */}
          <div style={{display:"flex",gap:"16px",flexWrap:"wrap"}}>
            <Slider label="GLIDE (0 = instant)" disabled={!autoharp&&!(symphony&&pitchAssist)}
              min={0} max={400} step={5} value={glideMs} onChange={setGlideMs} suffix=" ms" color={VIOLET_LT}/>
            <Slider label="VOLUME FLOOR" min={0} max={90} step={1} value={volFloor}
              onChange={setVolFloor} suffix=" %" color={GOLD}
              disabled={xAxis!=="VOLUME"}/>
          </div>
          <div style={{display:"flex",gap:"16px",flexWrap:"wrap",marginTop:"10px",marginBottom:"12px"}}>
            <Slider label="WARBLE RATE" disabled={xAxis!=="WARBLE"} min={0} max={14} step={1}
              value={warbleDepth} onChange={setWarbleDepth} suffix=" Hz" color={RED_LT}/>
            <Slider label="WARBLE DEPTH" disabled={xAxis!=="WARBLE"} min={0} max={40} step={1}
              value={warbleDistort} onChange={setWarbleDistort} suffix="" color={RED_LT}/>
          </div>

          <div style={{marginTop:"12px",paddingTop:"10px",borderTop:`1px solid ${BRASS}22`,
            fontFamily:"'Share Tech Mono',monospace",fontSize:"10px",letterSpacing:"1px",
            color:`${BRASS}66`,display:"flex",justifyContent:"space-between"}}>
            <span>{statusLine(mode,pitchAssist,symAssistMode)}</span>
            <span>window.Cosmophone</span>
          </div>
        </div>
      </div>

      {/* ── Effects panel (slides up from bottom, separate from settings) ── */}
      <div style={{position:"fixed",left:0,right:0,bottom:0,zIndex:22,
        transform:fxOut?"translateY(0)":"translateY(110%)",
        transition:"transform .28s ease",
        display:"flex",justifyContent:"center",padding:"0 8px 8px",pointerEvents:"none"}}>
        <div style={{width:"100%",maxWidth:"760px",pointerEvents:fxOut?"auto":"none",
          border:`2px solid ${VIOLET}`,borderRadius:"10px 10px 8px 8px",padding:"12px",
          background:"linear-gradient(180deg,#1d1530,#120c1e)",
          boxShadow:`inset 0 1px 0 ${VIOLET_LT}33, 0 -6px 24px #000c`,
          maxHeight:"80vh",overflowY:"auto"}}>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",
            marginBottom:"10px",position:"sticky",top:0,zIndex:2,
            paddingBottom:"6px",borderBottom:`1px solid ${VIOLET}44`,
            background:"linear-gradient(180deg,#1d1530,#1d1530 70%,transparent)"}}>
            <div style={{fontFamily:"'Cinzel',serif",fontWeight:700,letterSpacing:"3px",
              fontSize:"14px",color:VIOLET_LT}}>EFFECTS RACK</div>
            <button onClick={()=>setFxOut(false)} style={chip(true,VIOLET_LT)}>✕ CLOSE</button>
          </div>

          <FxRow name="OVERDRIVE" color={RED_LT} p={fxParams.overdrive}
            onToggle={()=>setFxParams(f=>({...f,overdrive:{...f.overdrive,on:!f.overdrive.on}}))}
            params={[
              {key:"amount",label:"DRIVE",min:0,max:1,step:0.01},
            ]}
            onParam={(k,v)=>setFxParams(f=>({...f,overdrive:{...f.overdrive,[k]:v}}))}/>
          {fxParams.overdrive.on && (
            <div style={{display:"flex",gap:"4px",marginTop:"-4px",marginBottom:"8px"}}>
              {["overdrive","distortion"].map(m=>(
                <button key={m} onClick={()=>setFxParams(f=>({...f,overdrive:{...f.overdrive,mode:m}}))}
                  style={{...chip(fxParams.overdrive.mode===m, RED_LT),
                    fontSize:"9px",padding:"4px 8px",flex:1}}>
                  {m==="overdrive"?"OVERDRIVE":"DISTORTION"}
                </button>
              ))}
            </div>
          )}
          <FxRow name="DELAY" color={VIOLET_LT} p={fxParams.delay}
            onToggle={()=>setFxParams(f=>({...f,delay:{...f.delay,on:!f.delay.on}}))}
            params={[
              {key:"mix",label:"MIX",min:0,max:1,step:0.01},
              {key:"time",label:"TIME",min:0.02,max:1.0,step:0.01,suffix:"s"},
              {key:"feedback",label:"FEEDBACK",min:0,max:0.9,step:0.01},
            ]}
            onParam={(k,v)=>setFxParams(f=>({...f,delay:{...f.delay,[k]:v}}))}/>
          <FxRow name="CHORUS" color={VIOLET_LT} p={fxParams.chorus}
            onToggle={()=>setFxParams(f=>({...f,chorus:{...f.chorus,on:!f.chorus.on}}))}
            params={[
              {key:"mix",label:"MIX",min:0,max:1,step:0.01},
              {key:"rate",label:"RATE",min:0.1,max:6,step:0.1,suffix:"Hz"},
              {key:"depth",label:"DEPTH",min:0,max:1,step:0.01},
            ]}
            onParam={(k,v)=>setFxParams(f=>({...f,chorus:{...f.chorus,[k]:v}}))}/>
          <FxRow name="PHASER" color={VIOLET_LT} p={fxParams.phaser}
            onToggle={()=>setFxParams(f=>({...f,phaser:{...f.phaser,on:!f.phaser.on}}))}
            params={[
              {key:"mix",label:"MIX",min:0,max:1,step:0.01},
              {key:"rate",label:"RATE",min:0.05,max:4,step:0.05,suffix:"Hz"},
              {key:"depth",label:"DEPTH",min:0,max:1,step:0.01},
            ]}
            onParam={(k,v)=>setFxParams(f=>({...f,phaser:{...f.phaser,[k]:v}}))}/>
          <FxRow name="REVERB" color={VIOLET_LT} p={fxParams.reverb}
            onToggle={()=>setFxParams(f=>({...f,reverb:{...f.reverb,on:!f.reverb.on}}))}
            params={[
              {key:"mix",label:"MIX",min:0,max:1,step:0.01},
              {key:"size",label:"SIZE",min:0,max:1,step:0.01},
            ]}
            onParam={(k,v)=>setFxParams(f=>({...f,reverb:{...f.reverb,[k]:v}}))}/>
          <FxRow name="PRESENCE" color={GOLD} p={fxParams.presence}
            onToggle={()=>setFxParams(f=>({...f,presence:{...f.presence,on:!f.presence.on}}))}
            params={[
              {key:"db",label:"BRIGHTNESS",min:-12,max:18,step:0.5,suffix:" dB"},
            ]}
            onParam={(k,v)=>setFxParams(f=>({...f,presence:{...f.presence,[k]:v}}))}/>
          <div style={{fontFamily:"'Share Tech Mono',monospace",fontSize:"9px",color:`${BRASS}66`,marginTop:"4px"}}>
            High-shelf at 3.5 kHz · overdrive → delay → chorus → phaser → reverb
          </div>
        </div>
      </div>

      {/* ── Chords panel (slides up — sage, keyboard + chord presets; accessible from any mode) ── */}
      <div style={{position:"fixed",left:0,right:0,bottom:0,zIndex:28,
        transform:ahPickerOpen?"translateY(0)":"translateY(110%)",
        transition:"transform .28s ease",
        display:"flex",justifyContent:"center",padding:"0 8px 8px",pointerEvents:"none"}}>
        <div style={{width:"100%",maxWidth:"760px",pointerEvents:ahPickerOpen?"auto":"none",
          border:`2px solid ${SAGE}`,borderRadius:"10px 10px 8px 8px",padding:"12px",
          background:`linear-gradient(180deg,#0e1e1d,#091514)`,
          boxShadow:`inset 0 1px 0 ${SAGE}33, 0 -6px 24px #000c`,
          maxHeight:"80vh",overflowY:"auto"}}>

          {/* Header */}
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:"8px"}}>
            <div>
              <div style={{fontFamily:"'Poiret One',sans-serif",letterSpacing:"3px",
                fontSize:"16px",color:SAGE}}>CHORDS</div>
              <div style={{fontFamily:"'Share Tech Mono',monospace",fontSize:"10px",color:`${SAGE}88`}}>
                {chordName==="Free (all notes)"
                  ? `free · ${selected.size} notes lit`
                  : `${chordName} in ${ROOT_NAMES[rootIdx]}`}
              </div>
            </div>
            <div style={{display:"flex",gap:"6px"}}>
              <button onClick={()=>{ setChordName("Free (all notes)"); }}
                style={{...chip(false,SAGE),borderColor:`${SAGE}66`,color:SAGE,
                  background:`${SAGE}11`}}>ALL</button>
              <button onClick={()=>setAhPickerOpen(false)}
                style={{...chip(true,SAGE),borderColor:SAGE,color:SAGE,
                  background:`${SAGE}22`}}>DONE</button>
            </div>
          </div>

          {/* Keyboard — display only, sage for lit notes */}
          <AhKeyboard selected={selected}/>

          {/* Chord presets */}
          <div style={{borderTop:`1px solid ${SAGE}33`,paddingTop:"8px"}}>
            <div style={{fontFamily:"'Share Tech Mono',monospace",fontSize:"9px",letterSpacing:"2px",
              color:`${SAGE}66`,marginBottom:"6px"}}>CHORD PRESETS</div>
            <div style={{marginBottom:"8px"}}>
              {/* Root picker as a compact row */}
              <div style={{display:"flex",gap:"4px",flexWrap:"wrap",marginBottom:"8px"}}>
                <div style={{fontFamily:"'Share Tech Mono',monospace",fontSize:"9px",
                  color:`${SAGE}66`,alignSelf:"center",marginRight:"4px",letterSpacing:"1px"}}>ROOT</div>
                {ROOT_NAMES.map((n,i)=>{
                  const active = rootIdx===i;
                  return (
                    <button key={n} onClick={()=>{
                      setRootIdx(i);
                      const shape = CHORD_SHAPES[chordName];
                      if (shape && engineRef.current) {
                        const eng = engineRef.current;
                        try {
                          eng.unlock?.(); eng.ensureBuses?.();
                          const w = WAVE_TYPE[waveRef.current]||waveRef.current;
                          const root = 48 + i;
                          shape.forEach(iv=>{
                            eng.previewNote?.(midiToFreq(root+iv), w, 0.5, 0.1);
                          });
                        } catch(_) {}
                      }
                    }}
                      style={{padding:"4px 8px",borderRadius:"4px",cursor:"pointer",
                        fontFamily:"'Cinzel',serif",fontWeight:600,fontSize:"10px",
                        border:`2px solid ${active?SAGE:`${SAGE}33`}`,
                        background:active?SAGE:`${SAGE}11`,
                        color:active?"#091a16":SAGE,
                        transition:"all .12s"}}>
                      {n}
                    </button>
                  );
                })}
              </div>
              {/* Chord buttons */}
              <div style={{display:"flex",gap:"4px",flexWrap:"wrap"}}>
                {CHORD_NAMES.filter(c=>c!=="Free (all notes)").map(c=>{
                  const active = chordName===c;
                  const shape = CHORD_SHAPES[c];
                  return (
                    <button key={c} onClick={()=>{
                      setChordName(c);
                      // preview the chord to wake the audio context (same trick as Symphony)
                      if (shape && engineRef.current) {
                        const eng = engineRef.current;
                        try {
                          eng.unlock?.(); eng.ensureBuses?.();
                          const w = WAVE_TYPE[waveRef.current]||waveRef.current;
                          const root = 48 + rootIdx; // C3 + rootIdx
                          shape.forEach(iv=>{
                            eng.previewNote?.(midiToFreq(root+iv), w, 0.5, 0.1);
                          });
                        } catch(_) {}
                      }
                    }}
                      style={{padding:"5px 9px",borderRadius:"5px",cursor:"pointer",
                        fontFamily:"'Cinzel',serif",fontWeight:600,fontSize:"11px",letterSpacing:"0.5px",
                        border:`2px solid ${active?SAGE:`${SAGE}44`}`,
                        background:active?SAGE:`${SAGE}11`,
                        color:active?"#091a16":SAGE,
                        boxShadow:active?`0 0 8px ${SAGE}66`:"none",
                        transition:"all .12s"}}>
                      {c}
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* ── Symphony note picker (slides up, 4-octave) ── */}
      <div style={{position:"fixed",left:0,right:0,bottom:0,zIndex:30,
        transform:symPickerOpen?"translateY(0)":"translateY(110%)",
        transition:"transform .28s ease",
        display:"flex",justifyContent:"center",padding:"0 8px 8px",pointerEvents:"none"}}>
        <div style={{width:"100%",maxWidth:"760px",pointerEvents:symPickerOpen?"auto":"none",
          border:`2px solid ${VIOLET}`,borderRadius:"10px 10px 8px 8px",padding:"12px",
          background:"linear-gradient(180deg,#241733,#160f22)",
          boxShadow:`inset 0 1px 0 ${VIOLET_LT}33, 0 -6px 24px #000c`}}>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:"8px"}}>
            <div>
              <div style={{fontFamily:"'Poiret One',sans-serif",letterSpacing:"3px",
                fontSize:"16px",color:VIOLET_LT}}>SYMPHONY VOICES</div>
              <div style={{fontFamily:"'Share Tech Mono',monospace",fontSize:"10px",color:`${VIOLET_LT}aa`}}>
                pick up to {MAX_SYM_NOTES} · {symNotes.length} chosen</div>
            </div>
            <div style={{display:"flex",gap:"6px"}}>
              <button onClick={()=>{setSymNotes([]);setSymOrder([]);setSymDriver(null);}} style={chip(false,VIOLET)}>CLEAR</button>
              <button onClick={()=>setSymPickerOpen(false)} style={chip(true,VIOLET)}>DONE</button>
            </div>
          </div>
          <SymKeyboard symNotes={symNotes} driver={symDriver}
            onToggle={toggleSymNote} onSetDriver={setDriverNote}/>

          {/* ── Chord presets ── */}
          <div style={{marginTop:"10px",borderTop:`1px solid ${VIOLET}33`,paddingTop:"8px"}}>
            <div style={{fontFamily:"'Share Tech Mono',monospace",fontSize:"9px",letterSpacing:"2px",
              color:`${VIOLET_LT}88`,marginBottom:"6px"}}>PRESETS · rooted at C3 · ✦ marks your driver</div>
            {Object.entries(SYM_CHORDS).map(([group, chords])=>(
              <div key={group} style={{marginBottom:"8px"}}>
                <div style={{fontFamily:"'Share Tech Mono',monospace",fontSize:"9px",
                  color:`${BRASS}66`,marginBottom:"4px",letterSpacing:"2px"}}>{group}</div>
                <div style={{display:"flex",gap:"4px",flexWrap:"wrap"}}>
                  {chords.map(({name,ivs})=>{
                    const midis = symChordMidis(ivs);
                    const active = midis.length===symNotes.length &&
                      midis.every((m,i)=>symNotes[i]===m);
                    return (
                      <button key={name} onClick={()=>applySymChord(ivs)}
                        style={{padding:"5px 9px",borderRadius:"5px",cursor:"pointer",
                          fontFamily:"'Cinzel',serif",fontWeight:600,fontSize:"11px",letterSpacing:"0.5px",
                          border:`2px solid ${active?GOLD:VIOLET+"66"}`,
                          background:active?`linear-gradient(180deg,${GOLD},${BRASS})`:`${VIOLET}18`,
                          color:active?"#1a1208":VIOLET_LT,
                          boxShadow:active?`0 0 8px ${GOLD}66`:"none",
                          transition:"all .12s"}}>
                        {name}
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>


      {/* ── Recording strip (fixed top, visible while panel is hidden during a take) ── */}
      {(recState==="countin" || recState==="recording") && (
        <div style={{position:"fixed",top:0,left:0,right:0,zIndex:40,
          background:"linear-gradient(180deg,#1a0d0a,#1a0d0acc)",borderBottom:`1px solid ${RED}66`,
          padding:"6px 10px",display:"flex",alignItems:"center",gap:"10px",
          boxShadow:`0 4px 16px #000a`}}>
          <span style={{fontFamily:"'Cinzel',serif",fontWeight:700,fontSize:"13px",letterSpacing:"2px",
            color:recState==="countin"?GOLD:RED_LT,whiteSpace:"nowrap"}}>
            {recState==="countin"
              ? (monitorSlots.size>0 ? `PREROLL ${Math.abs(recBeat)} beats` : `COUNT-IN ${Math.abs(recBeat)}`)
              : `● REC · SLOT ${recSlot+1}`}
          </span>
          <div style={{flex:1,height:"10px",borderRadius:"5px",background:"#000",overflow:"hidden",
            border:`1px solid ${RED}44`}}>
            <div style={{height:"100%",width:`${recProgress*100}%`,
              background:recState==="recording"?RED:GOLD,transition:"width .05s"}}/>
          </div>
          <span style={{fontFamily:"'Share Tech Mono',monospace",fontSize:"11px",color:`${BRASS}aa`,whiteSpace:"nowrap"}}>
            {recState==="recording" ? `${recBeat+1}/${beatsPerMeasure*measures}` : ""}
          </span>
          <button onClick={stopTransport}
            style={{padding:"4px 12px",borderRadius:"5px",cursor:"pointer",border:`2px solid ${GOLD}`,
              background:"#1a120a",color:GOLD,fontFamily:"'Cinzel',serif",fontWeight:700,fontSize:"12px",
              letterSpacing:"1px",whiteSpace:"nowrap"}}>■ STOP</button>
        </div>
      )}

      {/* ── Studio panel (slides in from the right) ── */}
      <div style={{position:"fixed",top:0,right:0,bottom:0,zIndex:25,
        width:"min(340px, 92vw)",
        transform:studioOut?"translateX(0)":"translateX(110%)",
        transition:"transform .28s ease",pointerEvents:studioOut?"auto":"none",
        background:"linear-gradient(180deg,#2a1410,#1a0d0a)",
        borderLeft:`2px solid ${RED}`,boxShadow:`-8px 0 28px #000c`,
        display:"flex",flexDirection:"column",padding:"12px",overflowY:"auto"}}>

        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:"10px"}}>
          <div>
            <div style={{fontFamily:"'Cinzel',serif",fontWeight:700,letterSpacing:"3px",
              fontSize:"17px",color:RED_LT}}>RECORDING STUDIO</div>
            <div style={{fontFamily:"'Share Tech Mono',monospace",fontSize:"9px",color:`${RED_LT}aa`}}>
              METRONOME · CAPTURE · PLAYBACK</div>
          </div>
          <button onClick={()=>{ if(recState!=="idle")stopTransport(); setStudioOut(false); }}
            style={chip(true,RED)}>✕</button>
        </div>

        {/* tab bar */}
        <div style={{display:"flex",gap:"4px",marginBottom:"10px"}}>
          {["RECORD","ARRANGE"].map(t=>(
            <button key={t} onClick={()=>{ if(recState!=="idle")stopTransport(); setStudioTab(t); }}
              style={{flex:1,padding:"8px 4px",borderRadius:"5px",cursor:"pointer",
                fontFamily:"'Cinzel',serif",fontWeight:600,fontSize:"12px",letterSpacing:"1px",
                border:`2px solid ${studioTab===t?RED:"#3a2a1a"}`,
                background:studioTab===t?`linear-gradient(180deg,${RED},#7a241b)`:"#1a120a",
                color:studioTab===t?"#fff":BRASS_LT}}>{t}</button>
          ))}
        </div>

        {/* save / load — always available */}
        <div style={{display:"flex",gap:"6px",marginBottom:"10px",alignItems:"center"}}>
          <button onClick={saveMelody} style={chip(false,BRASS)}>💾 SAVE MELODY</button>
          <button onClick={loadMelody} style={chip(false,BRASS)}>📂 LOAD</button>
          {melodyStatus && <span style={{fontFamily:"'Cinzel',serif",fontSize:"12px",color:GOLD}}>{melodyStatus}</span>}
        </div>

        {/* ════ RECORD TAB ════ */}
        {studioTab==="RECORD" && <>
        {/* metronome */}
        <div style={{border:`1px solid ${RED}44`,borderRadius:"8px",padding:"10px",marginBottom:"10px",
          background:"#ffffff05"}}>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:"8px"}}>
            <Label>TEMPO</Label>
            <span style={{fontFamily:"'Cinzel',serif",fontSize:"18px",color:GOLD,fontWeight:700}}>{bpm}<span style={{fontSize:"11px",color:`${BRASS}99`}}> BPM</span></span>
          </div>
          <input type="range" min="40" max="220" value={bpm} disabled={recState!=="idle"}
            onChange={e=>setBpm(Number(e.target.value))}
            style={{width:"100%",accentColor:RED_LT,cursor:"pointer",marginBottom:"8px"}}/>
          <div style={{display:"flex",gap:"10px"}}>
            <Stepper label="BEATS/MEAS" value={beatsPerMeasure} min={1} max={12}
              disabled={recState!=="idle"} onChange={setBeatsPerMeasure}/>
            <Stepper label="MEASURES" value={measures} min={1} max={8}
              disabled={recState!=="idle"} onChange={setMeasures}/>
          </div>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginTop:"8px"}}>
            <span style={{fontFamily:"'Share Tech Mono',monospace",fontSize:"10px",color:`${BRASS}88`}}>
              LOOP = {beatsPerMeasure*measures} beats</span>
            <button onClick={()=>setMetroOn(o=>!o)} style={lampBtn(metroOn,GOLD,false)}>
              <Lamp on={metroOn} color={GOLD}/> CLICK
            </button>
          </div>
        </div>

        {/* transport */}
        <div style={{marginBottom:"10px"}}>
          {recState==="idle" ? (
            <button onClick={startRecording}
              style={{width:"100%",padding:"14px",borderRadius:"8px",cursor:"pointer",
                border:`2px solid ${RED}`,background:`linear-gradient(180deg,${RED},#7a241b)`,
                color:"#fff",fontFamily:"'Cinzel',serif",fontWeight:700,letterSpacing:"3px",fontSize:"16px",
                boxShadow:`0 0 16px ${RED}66`}}>
              ● RECORD INTO SLOT {recSlot+1}
            </button>
          ) : (
            <button onClick={stopTransport}
              style={{width:"100%",padding:"14px",borderRadius:"8px",cursor:"pointer",
                border:`2px solid ${GOLD}`,background:"#1a120a",
                color:GOLD,fontFamily:"'Cinzel',serif",fontWeight:700,letterSpacing:"3px",fontSize:"16px"}}>
              ■ STOP {recState==="countin"?"(COUNT-IN…)":recState==="recording"?"(REC)":"(PLAY)"}
            </button>
          )}
          {/* progress + beat */}
          <div style={{marginTop:"8px",height:"8px",borderRadius:"4px",background:"#000",overflow:"hidden",
            border:`1px solid ${RED}33`}}>
            <div style={{height:"100%",width:`${recProgress*100}%`,
              background:recState==="recording"?RED:GOLD,transition:"width .05s"}}/>
          </div>
          <div style={{textAlign:"center",fontFamily:"'Share Tech Mono',monospace",fontSize:"11px",
            color:recState==="countin"?GOLD:`${BRASS}99`,marginTop:"4px",height:"12px"}}>
            {recState==="countin"
              ? (monitorSlots.size>0 ? `PREROLL · ${Math.abs(recBeat)} beats left` : `COUNT-IN ${Math.abs(recBeat)}`)
              : recState==="recording" ? `BEAT ${recBeat+1} / ${beatsPerMeasure*measures}`
              : recState==="playing" ? "PLAYING" : "ready"}
          </div>
        </div>

        {/* slots */}
        <Label>LOOP SLOTS · tap to arm · ♪ preview · ✕ clear</Label>
        <div style={{display:"flex",flexDirection:"column",gap:"5px",marginBottom:"10px"}}>
          {slots.map((slot,si)=>{
            const armed = recSlot===si;
            const filled = !!slot;
            const monitoring = monitorSlots.has(si);
            return (
              <div key={si} style={{display:"flex",alignItems:"center",gap:"5px"}}>
                <button onClick={()=>recState==="idle"&&setRecSlot(si)}
                  style={{flex:1,display:"flex",alignItems:"center",gap:"8px",
                    padding:"8px 10px",borderRadius:"6px",cursor:"pointer",
                    border:`2px solid ${armed?GOLD:filled?RED:"#3a2a1a"}`,
                    background:armed?`${GOLD}18`:filled?`${RED}14`:"#ffffff05",
                    color:armed?GOLD:filled?RED_LT:"#6b5838"}}>
                  <span style={{fontFamily:"'Cinzel',serif",fontWeight:700,fontSize:"15px"}}>{si+1}</span>
                  <span style={{fontFamily:"'Share Tech Mono',monospace",fontSize:"10px",flex:1,textAlign:"left"}}>
                    {filled ? `${slot.patch.mode} · ${slot.gesture.length} pts` : "empty"}</span>
                  {armed && <span style={{fontSize:"10px",color:GOLD}}>ARMED</span>}
                </button>
                {/* monitor toggle (only useful for filled, non-armed slots) */}
                <button onClick={()=>toggleMonitor(si)} disabled={!filled||armed}
                  title="Monitor under take"
                  style={{width:"30px",height:"34px",borderRadius:"5px",cursor:filled&&!armed?"pointer":"not-allowed",
                    border:`1px solid ${monitoring?VIOLET:"#3a2a1a"}`,
                    background:monitoring?`${VIOLET}33`:"transparent",color:monitoring?VIOLET_LT:"#5a4a30",
                    fontSize:"13px",opacity:filled&&!armed?1:0.4}}>♫</button>
                <button onClick={()=>previewSlot(si)} disabled={!filled||recState!=="idle"}
                  style={{width:"30px",height:"34px",borderRadius:"5px",cursor:filled?"pointer":"not-allowed",
                    border:`1px solid ${filled?BRASS:"#3a2a1a"}`,background:"transparent",
                    color:filled?BRASS_LT:"#5a4a30",fontSize:"14px",opacity:filled?1:0.4}}>♪</button>
                {/* transpose: only show when filled */}
                {filled && <>
                  <button onClick={()=>transposeSlot(si,-1)}
                    style={{width:"22px",height:"34px",borderRadius:"4px",cursor:"pointer",
                      border:`1px solid ${VIOLET}66`,background:"transparent",
                      color:VIOLET_LT,fontSize:"11px"}}>−1</button>
                  <button onClick={()=>transposeSlot(si,1)}
                    style={{width:"22px",height:"34px",borderRadius:"4px",cursor:"pointer",
                      border:`1px solid ${VIOLET}66`,background:"transparent",
                      color:VIOLET_LT,fontSize:"11px"}}>+1</button>
                  <button onClick={()=>toggleSlotFx(si)} title="Effects on/off for this loop"
                    style={{width:"30px",height:"34px",borderRadius:"4px",cursor:"pointer",
                      border:`1px solid ${slot.fxEnabled!==false?VIOLET_LT:"#3a2a1a"}`,
                      background:slot.fxEnabled!==false?`${VIOLET_LT}28`:"transparent",
                      color:slot.fxEnabled!==false?VIOLET_LT:"#5a4a30",fontSize:"10px",
                      fontFamily:"'Cinzel',serif",fontWeight:600}}>FX</button>
                </>}
                <button onClick={()=>clearSlot(si)} disabled={!filled||recState!=="idle"}
                  style={{width:"26px",height:"34px",borderRadius:"5px",cursor:filled?"pointer":"not-allowed",
                    border:"1px solid #3a2a1a",background:"transparent",color:"#6b4a3a",fontSize:"12px",
                    opacity:filled?1:0.4}}>✕</button>
              </div>
            );
          })}
        </div>

        <div style={{fontFamily:"'Share Tech Mono',monospace",fontSize:"9px",color:`${BRASS}66`,
          lineHeight:1.5,borderTop:`1px solid ${BRASS}22`,paddingTop:"8px"}}>
          Arm a slot, optionally toggle ♫ on other loops to hear them underneath, then RECORD.
          A one-measure count-in gives you time to place your finger. Capture stops automatically at the
          end of the loop.
        </div>
        </>}

        {/* ════ ARRANGE TAB ════ */}
        {studioTab==="ARRANGE" && <>
          <div style={{display:"flex",alignItems:"center",gap:"8px",marginBottom:"8px"}}>
            <Label>ARRANGEMENT · 3 rows play together</Label>
            <div style={{flex:1}}/>
            {recState==="idle"
              ? <button onClick={playArrangement} style={chip(true,RED)}>▶ PLAY</button>
              : <button onClick={stopTransport} style={chip(true,GOLD)}>■ STOP</button>}
          </div>
          <div style={{fontFamily:"'Share Tech Mono',monospace",fontSize:"10px",color:`${BRASS}88`,marginBottom:"8px"}}>
            Tap a cell to place armed slot <span style={{color:GOLD}}>#{recSlot+1}</span> · tap again to clear
          </div>
          {arrRows.map((row,ri)=>(
            <div key={ri} style={{display:"flex",alignItems:"center",gap:"4px",marginBottom:"5px"}}>
              <button onClick={()=>setActiveArrRow(ri)} style={{width:"20px",height:"34px",flexShrink:0,
                borderRadius:"4px",cursor:"pointer",border:`2px solid ${activeArrRow===ri?GOLD:"#3a2a1a"}`,
                background:activeArrRow===ri?`${GOLD}22`:"#111",color:activeArrRow===ri?GOLD:"#5a4a30",
                fontFamily:"'Cinzel',serif",fontSize:"12px"}}>{ri+1}</button>
              <div style={{flex:1,display:"flex",gap:"3px",opacity:arrMutes[ri]?0.35:1}}>
                {row.map((cell,ci)=>{
                  const isPlayhead = recState==="playing" && ci===arrPos && !arrMutes[ri];
                  return (
                    <button key={ci} onClick={()=>dropSlotInCell(ri,ci)}
                      style={{flex:"1 1 0",minWidth:0,height:"34px",borderRadius:"4px",cursor:"pointer",
                        border:`2px solid ${cell!==null?RED:(isPlayhead?"#ffffff66":"#222")}`,
                        background:cell!==null?`${RED}28`:(isPlayhead?"#ffffff10":"#111"),
                        color:cell!==null?"#fff":"#333",fontFamily:"'Cinzel',serif",fontWeight:700,fontSize:"13px",
                        boxShadow:isPlayhead?"0 0 8px #ffffff55":(cell!==null?`0 0 5px ${RED}55`:"none")}}>
                      {cell!==null?cell+1:ci+1}
                    </button>
                  );
                })}
              </div>
              <button onClick={()=>toggleArrMute(ri)} style={{width:"28px",height:"34px",flexShrink:0,
                borderRadius:"4px",cursor:"pointer",border:`1px solid ${arrMutes[ri]?"#ff3333aa":"#3a2a1a"}`,
                background:arrMutes[ri]?"#ff333322":"transparent",color:arrMutes[ri]?"#ff5555":"#5a4a30",
                fontSize:"13px"}}>{arrMutes[ri]?"🔇":"🔊"}</button>
              <button onClick={()=>clearArrRow(ri)} style={{width:"24px",height:"34px",flexShrink:0,
                borderRadius:"4px",cursor:"pointer",border:"1px solid #3a2a1a",background:"transparent",
                color:"#6b4a3a",fontSize:"12px"}}>✕</button>
            </div>
          ))}
          <div style={{fontFamily:"'Share Tech Mono',monospace",fontSize:"9px",color:`${BRASS}66`,
            lineHeight:1.5,borderTop:`1px solid ${BRASS}22`,paddingTop:"8px",marginTop:"6px"}}>
            Each column is one loop length. Cells show which slot plays; empty cells are silent for that row.
            Rows layer. Loops repeat to fill. 🔇 mutes a row.
          </div>
        </>}
      </div>
    </div>

  );
}
function SymKeyboard({symNotes, driver, onToggle, onSetDriver}){
  const whites=[], blacks=[];
  for (let m=SYM_LOW;m<SYM_HIGH;m++){
    if (isBlack(m)) blacks.push(m); else whites.push(m);
  }
  const W = 100/whites.length;
  const whiteIndex = (m)=>whites.indexOf(m);
  const lpTimer = useRef(null);
  const lpFired = useRef(false);

  const press = (m)=>{
    lpFired.current = false;
    clearTimeout(lpTimer.current);
    // long-press only meaningful for already-selected notes (claim driver)
    lpTimer.current = setTimeout(()=>{
      if (symNotes.includes(m)) { lpFired.current = true; onSetDriver(m); }
    }, 450);
  };
  const release = (m)=>{
    clearTimeout(lpTimer.current);
    if (!lpFired.current) onToggle(m);
  };

  const keyColor = (m, isWhiteBase)=>{
    const sel = symNotes.includes(m);
    if (!sel) return isWhiteBase ? "linear-gradient(180deg,#d9c9a8,#b09a72)"
                                 : "linear-gradient(180deg,#2a2030,#0e0a16)";
    if (m === driver) return `linear-gradient(180deg,${GOLD},${BRASS})`;     // gold driver
    return `linear-gradient(180deg,${RED},#7a241b)`;                         // red voice
  };

  return (
    <div style={{position:"relative",width:"100%",height:"110px",
      border:`1px solid ${VIOLET}55`,borderRadius:"6px",overflow:"hidden",background:"#0e0a16"}}>
      {/* whites */}
      <div style={{position:"absolute",inset:0,display:"flex"}}>
        {whites.map(m=>{
          const sel=symNotes.includes(m); const isDrv=m===driver;
          return (
            <button key={m}
              onPointerDown={(e)=>{e.preventDefault();press(m);}}
              onPointerUp={(e)=>{e.preventDefault();release(m);}}
              onPointerLeave={()=>clearTimeout(lpTimer.current)}
              style={{flex:1,border:`1px solid #0008`,cursor:"pointer",
                background:keyColor(m,true),
                boxShadow:isDrv?`inset 0 0 10px ${GOLD}, 0 0 8px ${GOLD}99`:"none",
                display:"flex",alignItems:"flex-end",justifyContent:"center",paddingBottom:"3px",
                position:"relative"}}>
              <span style={{fontSize:"9px",fontFamily:"'Share Tech Mono',monospace",
                color:sel?"#fff":"#3a2c1a"}}>{noteName(m)==="C"?fullName(m):""}</span>
              {isDrv && <span style={{position:"absolute",top:"3px",fontSize:"11px"}}>✦</span>}
            </button>
          );
        })}
      </div>
      {/* blacks */}
      {blacks.map(m=>{
        const wiBelow = whiteIndex(m-1);
        const left = (wiBelow+1)*W - (W*0.3);
        const isDrv=m===driver;
        return (
          <button key={m}
            onPointerDown={(e)=>{e.preventDefault();press(m);}}
            onPointerUp={(e)=>{e.preventDefault();release(m);}}
            onPointerLeave={()=>clearTimeout(lpTimer.current)}
            style={{position:"absolute",top:0,height:"62%",width:`${W*0.6}%`,
              left:`${left}%`,cursor:"pointer",zIndex:2,border:`1px solid #000`,borderRadius:"0 0 3px 3px",
              background:keyColor(m,false),
              boxShadow:isDrv?`inset 0 0 10px ${GOLD}, 0 0 8px ${GOLD}99`:"none",
              display:"flex",alignItems:"flex-end",justifyContent:"center",paddingBottom:"2px"}}>
            {isDrv && <span style={{fontSize:"11px"}}>✦</span>}
          </button>
        );
      })}
    </div>
  );
}

// ─── Waveform visualizer (canvas, redraws on waveform change) ────────────────
function WavePreview({ waveform }) {
  const canvasRef = useRef(null);
  useEffect(() => {
    const canvas = canvasRef.current; if (!canvas) return;
    const ctx = canvas.getContext("2d");
    const W = canvas.width, H = canvas.height;
    ctx.clearRect(0, 0, W, H);

    // background
    ctx.fillStyle = "#0c0906";
    ctx.fillRect(0, 0, W, H);

    // grid lines
    ctx.strokeStyle = "#b8860b22";
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(0, H/2); ctx.lineTo(W, H/2); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(W/2, 0); ctx.lineTo(W/2, H); ctx.stroke();

    // build samples
    const N = W;
    const samples = new Float32Array(N);
    const name = waveform;

    if (OSC_PRESETS[name]) {
      // reconstruct from harmonics via additive synthesis
      const harmonics = OSC_PRESETS[name];
      for (let x = 0; x < N; x++) {
        const t = x / N; // 0..1 = one cycle
        let s = 0;
        for (let k = 1; k < harmonics.length; k++) {
          s += harmonics[k] * Math.sin(2 * Math.PI * k * t);
        }
        samples[x] = s;
      }
    } else {
      // basic waves
      const type = name === "saw" ? "sawtooth" : name === "triangle" ? "triangle"
                 : name === "square" ? "square" : "sine";
      for (let x = 0; x < N; x++) {
        const t = x / N;
        if (type === "sine")     samples[x] = Math.sin(2 * Math.PI * t);
        else if (type === "sawtooth") samples[x] = 2 * (t - Math.floor(t + 0.5));
        else if (type === "square")   samples[x] = t < 0.5 ? 1 : -1;
        else /* triangle */           samples[x] = 1 - 4 * Math.abs(t - Math.round(t));
      }
    }

    // normalise
    const peak = samples.reduce((m, v) => Math.max(m, Math.abs(v)), 0.0001);
    for (let i = 0; i < N; i++) samples[i] /= peak;

    // draw waveform
    const color = OSC_PRESETS[name] ? VIOLET_LT : BRASS_LT;
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.shadowColor = color;
    ctx.shadowBlur = 4;
    ctx.beginPath();
    for (let x = 0; x < N; x++) {
      const y = H/2 - samples[x] * (H/2 - 4);
      x === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    }
    ctx.stroke();
  }, [waveform]);

  return (
    <div style={{width:"88px",flexShrink:0,
      border:`1px solid ${BRASS}55`,borderRadius:"6px",overflow:"hidden",
      background:"#0c0906",boxShadow:`inset 0 0 8px #000`}}>
      <canvas ref={canvasRef} width={88} height={62}
        style={{display:"block",width:"100%",height:"100%"}}/>
    </div>
  );
}


function AhKeyboard({ selected }) {
  const AH_LOW = 48, AH_HIGH = 84;
  const whites = [], blacks = [];
  for (let m = AH_LOW; m < AH_HIGH; m++) {
    if (isBlack(m)) blacks.push(m); else whites.push(m);
  }
  const W = 100 / whites.length;
  const whiteIndex = (m) => whites.indexOf(m);
  const keyColor = (m, isWhite) => {
    const on = selected.has(m);
    if (!on) return isWhite ? "linear-gradient(180deg,#1e2a29,#141d1c)"
                            : "linear-gradient(180deg,#111,#0a0e0e)";
    return `linear-gradient(180deg,${SAGE},${SAGE_DK})`;
  };
  return (
    <div style={{position:"relative",width:"100%",height:"110px",
      border:`1px solid ${SAGE}44`,borderRadius:"6px",overflow:"hidden",background:"#0c1514",
      marginBottom:"10px"}}>
      <div style={{position:"absolute",inset:0,display:"flex"}}>
        {whites.map(m=>{
          const on = selected.has(m);
          return (
            <div key={m} style={{flex:1,border:"1px solid #000a",
              background:keyColor(m,true),
              boxShadow:on?`inset 0 0 10px ${SAGE}88`:"none",
              display:"flex",alignItems:"flex-end",justifyContent:"center",paddingBottom:"3px"}}>
              <span style={{fontSize:"9px",fontFamily:"'Share Tech Mono',monospace",
                color:on?"#d0e8e6":"#2a3d3c"}}>
                {noteName(m)==="C"?fullName(m):""}
              </span>
            </div>
          );
        })}
      </div>
      {blacks.map(m=>{
        const wiBelow = whiteIndex(m-1);
        const left = (wiBelow+1)*W - (W*0.3);
        const on = selected.has(m);
        return (
          <div key={m} style={{position:"absolute",top:0,height:"62%",width:`${W*0.6}%`,
            left:`${left}%`,zIndex:2,border:"1px solid #000",borderRadius:"0 0 3px 3px",
            background:keyColor(m,false),
            boxShadow:on?`inset 0 0 8px ${SAGE}aa`:"none"}}/>
        );
      })}
    </div>
  );
}

// ─── status line ──────────────────────────────────────────────────────────────
function statusLine(mode,assist,symAssist){
  if (mode==="AUTOHARP") return "AUTOHARP · snaps to lit notes · glide smooths the leap";
  if (mode==="SYMPHONY") return assist
    ? `SYMPHONY · ${symAssist==="HARMONIC"?"harmonic — chord holds shape":"experimental — voices roam free"}`
    : "SYMPHONY · parallel glide · no assist";
  return assist ? "THEREMIN · assisted — gentle pull to true pitch" : "THEREMIN · free flight";
}

// ─── UI helpers ────────────────────────────────────────────────────────────────
function Label({children}){return <div style={{fontFamily:"'Share Tech Mono',monospace",fontSize:"10px",
  letterSpacing:"2px",color:`${BRASS}99`,marginBottom:"4px"}}>{children}</div>;}

function Lamp({on,color}){return <span style={{display:"inline-block",width:"8px",height:"8px",borderRadius:"50%",
  marginRight:"6px",verticalAlign:"middle",background:on?color:"#0008",
  boxShadow:on?`0 0 8px ${color}, inset 0 0 2px #fff8`:"inset 0 0 3px #000",
  border:`1px solid ${on?color:"#0006"}`}}/>;}

function lampBtn(on,color,disabled){return {fontFamily:"'Cinzel',serif",fontWeight:500,fontSize:"12px",
  letterSpacing:"2px",padding:"9px 12px",borderRadius:"5px",cursor:disabled?"not-allowed":"pointer",
  color:disabled?"#5a4a30":(on?"#fff":BRASS_LT),border:`2px solid ${on?color:BRASS}`,
  background:on?`linear-gradient(180deg,${color}33,#1a120a)`:"linear-gradient(180deg,#2a1f13,#1a120a)",
  boxShadow:on?`0 0 12px ${color}55`:"none",opacity:disabled?0.45:1,transition:"all .15s",
  display:"flex",alignItems:"center"};}

function chip(on,color){return {fontFamily:"'Cinzel',serif",fontWeight:500,fontSize:"12px",letterSpacing:"1px",
  padding:"7px 12px",borderRadius:"5px",cursor:"pointer",color:on?"#1a1208":BRASS_LT,
  border:`2px solid ${on?color:BRASS+"88"}`,
  background:on?`linear-gradient(180deg,${BRASS_LT},${BRASS})`:"linear-gradient(180deg,#2a1f13,#1a120a)",
  boxShadow:on?`0 0 10px ${color}55`:"none",transition:"all .12s"};}

function selectStyle(disabled){return {fontFamily:"'Cormorant Garamond',serif",fontSize:"16px",fontWeight:600,
  padding:"7px 10px",borderRadius:"5px",cursor:disabled?"not-allowed":"pointer",
  background:"linear-gradient(180deg,#2a1f13,#160f08)",color:disabled?"#5a4a30":GOLD,
  border:`2px solid ${disabled?BRASS+"55":BRASS}`,outline:"none",opacity:disabled?0.5:1,minWidth:"120px"};}

function Toggle({label,value,options,onPick,activeColor}){
  return (
    <div>
      <Label>{label}</Label>
      <div style={{display:"flex",border:`2px solid ${BRASS}`,borderRadius:"6px",overflow:"hidden"}}>
        {options.map(opt=>{const on=value===opt;
          return <button key={opt} onClick={()=>onPick(opt)}
            style={{fontFamily:"'Cinzel',serif",fontWeight:600,fontSize:"12px",letterSpacing:"1px",
              padding:"8px 11px",cursor:"pointer",border:"none",color:on?"#1a1208":BRASS_LT,
              background:on?`linear-gradient(180deg,${activeColor}dd,${activeColor}99)`:"#1a120a",
              boxShadow:on?`inset 0 0 10px ${activeColor}`:"none",transition:"all .12s"}}>{opt}</button>;
        })}
      </div>
    </div>
  );
}

function RailBtn({icon,imgIcon,label,on,onClick,color,disabled,iconSize,iconColor,iconWeight,overlay}){
  return (
    <div style={{flex:1,position:"relative",minWidth:0}}>
      <button onClick={onClick} disabled={disabled}
        style={{width:"100%",display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",
          gap:"2px",padding:"6px 2px",borderRadius:"6px",cursor:disabled?"not-allowed":"pointer",
          color:disabled?"#5a4a30":(on?"#1a1208":BRASS_LT),
          border:`2px solid ${on?color:BRASS}`,
          background:on?`linear-gradient(180deg,${color},${color}aa)`:"linear-gradient(180deg,#2a1f13,#1a120a)",
          boxShadow:on?`0 0 10px ${color}66`:"none",opacity:disabled?0.5:1,transition:"all .15s"}}>
        {imgIcon
          ? <img src={imgIcon} alt="" style={{width:"18px",height:"18px",objectFit:"contain",
              mixBlendMode:"screen",opacity:disabled?0.4:1,lineHeight:1}}/>
          : <span style={{fontSize:iconSize||"14px",lineHeight:1,fontWeight:iconWeight||"normal",
              color:iconColor||(disabled?"#5a4a30":(on?"#1a1208":BRASS_LT))}}>{icon}</span>}
        <span style={{fontFamily:"'Cinzel',serif",fontWeight:600,fontSize:"10px",letterSpacing:"1px",lineHeight:1}}>{label}</span>
      </button>
      {overlay && <div style={{position:"absolute",top:0,right:0,bottom:0,left:0,
        background:"#00000066",borderRadius:"6px",pointerEvents:"none"}}/>}
    </div>
  );
}

function Slider({label,min,max,step,value,onChange,suffix,color,disabled}){
  return (
    <div style={{flex:1,minWidth:"180px",opacity:disabled?0.45:1}}>
      <div style={{display:"flex",justifyContent:"space-between",marginBottom:"4px"}}>
        <Label>{label}</Label>
        <span style={{fontFamily:"'Share Tech Mono',monospace",fontSize:"12px",color}}>{value}{suffix}</span>
      </div>
      <input type="range" min={min} max={max} step={step} value={value} disabled={disabled}
        onChange={e=>onChange(Number(e.target.value))}
        style={{width:"100%",accentColor:color,cursor:disabled?"not-allowed":"pointer"}}/>
    </div>
  );
}

function FxRow({name,color,p,params,onToggle,onParam}){
  const on = p.on;
  return (
    <div style={{border:`1px solid ${on?color:"#3a2a4a"}44`,borderRadius:"8px",padding:"10px",
      marginBottom:"8px",background:on?`${color}10`:"#ffffff04",transition:"all .15s"}}>
      <div style={{display:"flex",alignItems:"center",gap:"8px",marginBottom:on?"8px":"0"}}>
        <button onClick={onToggle} style={{display:"flex",alignItems:"center",gap:"6px",
          background:"transparent",border:"none",cursor:"pointer",padding:0}}>
          <span style={{display:"inline-block",width:"10px",height:"10px",borderRadius:"50%",
            background:on?color:"#0008",boxShadow:on?`0 0 8px ${color}`:"inset 0 0 3px #000",
            border:`1px solid ${on?color:"#0006"}`}}/>
          <span style={{fontFamily:"'Cinzel',serif",fontWeight:700,fontSize:"14px",letterSpacing:"2px",
            color:on?color:"#6b5878"}}>{name}</span>
        </button>
      </div>
      {on && (
        <div style={{display:"flex",gap:"12px",flexWrap:"wrap"}}>
          {params.map(pr=>(
            <div key={pr.key} style={{flex:1,minWidth:"90px"}}>
              <div style={{display:"flex",justifyContent:"space-between",marginBottom:"2px"}}>
                <span style={{fontFamily:"'Share Tech Mono',monospace",fontSize:"9px",
                  letterSpacing:"1px",color:`${BRASS}99`}}>{pr.label}</span>
                <span style={{fontFamily:"'Share Tech Mono',monospace",fontSize:"10px",color}}>
                  {pr.key==="mix"||pr.key==="depth"||pr.key==="feedback"
                    ? Math.round(p[pr.key]*100)+"%"
                    : p[pr.key].toFixed(2)+(pr.suffix||"")}</span>
              </div>
              <input type="range" min={pr.min} max={pr.max} step={pr.step} value={p[pr.key]}
                onChange={e=>onParam(pr.key, Number(e.target.value))}
                style={{width:"100%",accentColor:color,cursor:"pointer"}}/>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function Stepper({label,value,min,max,onChange,disabled}){
  return (
    <div style={{flex:1}}>
      <Label>{label}</Label>
      <div style={{display:"flex",alignItems:"center",gap:"4px"}}>
        <button onClick={()=>!disabled&&onChange(Math.max(min,value-1))} disabled={disabled}
          style={{width:"24px",height:"24px",borderRadius:"4px",border:`1px solid ${disabled?"#3a2a1a":RED+"88"}`,
            background:"transparent",color:disabled?"#5a4a30":RED_LT,cursor:disabled?"not-allowed":"pointer",
            fontSize:"16px"}}>−</button>
        <div style={{flex:1,textAlign:"center",fontFamily:"'Cinzel',serif",fontWeight:700,fontSize:"17px",
          color:disabled?"#6b5838":GOLD}}>{value}</div>
        <button onClick={()=>!disabled&&onChange(Math.min(max,value+1))} disabled={disabled}
          style={{width:"24px",height:"24px",borderRadius:"4px",border:`1px solid ${disabled?"#3a2a1a":RED+"88"}`,
            background:"transparent",color:disabled?"#5a4a30":RED_LT,cursor:disabled?"not-allowed":"pointer",
            fontSize:"16px"}}>+</button>
      </div>
    </div>
  );
}

// small absolute label helpers for the field
function lblBL(){return {position:"absolute",bottom:"6px",left:"10px",fontSize:"10px",
  fontFamily:"'Share Tech Mono',monospace",color:`${BRASS}88`,pointerEvents:"none"};}
function lblBR(){return {position:"absolute",bottom:"6px",right:"10px",fontSize:"10px",
  fontFamily:"'Share Tech Mono',monospace",color:`${BRASS}88`,pointerEvents:"none"};}
function lblTL(){return {position:"absolute",top:"28px",left:"10px",fontSize:"10px",
  fontFamily:"'Share Tech Mono',monospace",color:`${BRASS}88`,pointerEvents:"none"};}
