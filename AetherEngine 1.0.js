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
export const OSC_PRESETS = {
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
export const PRESET_NAMES = Object.keys(OSC_PRESETS);
const BASIC_WAVES  = ["sine","sawtooth","square","triangle"];
const isPreset = (name) => PRESET_NAMES.includes(name);

export function createAudioEngine() {
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
