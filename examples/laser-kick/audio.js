// examples/laser-kick/audio.js
// The sound half of the laser-kick example: a synthesized kick drum on a
// euclidean 16-step clock, fed through a convolution reverb whose impulse
// response is rendered live by an 8-line Hadamard feedback delay network.
//
// The kick voice is the phasor kick from agentic-faust-web's techno-bed.dsp
// (sine with an exponential pitch drop under an exponential amplitude decay),
// ported from Faust to a rendered AudioBuffer. The FDN is the reverb machine
// from dynamics-notebook's study-1-reverb (had8 / fdnIR), extended to stereo
// by mixing the eight tank taps through two orthogonal sign vectors — the
// decorrelated L/R tail is what makes the XY scope bloom into 2D.
//
// Scheduling is sample-accurate: a lookahead loop books BufferSources on the
// audio clock; the visual side consumes the same hit list as each booked hit's
// time arrives, so light and sound share one clock.

import { euclideanPattern } from "../../src/conductor.js";

const TAU = Math.PI * 2;

// sin(phase) with f(t) = lo + (hi - lo)·e^(-pitchDecay·t), amp e^(-ampDecay·t).
// Phase is integrated (not sin(2pi·f·t)) so the sweep stays click-free.
export function renderKick(sr, { pitchHi, pitchLo, pitchDecay, ampDecay, dur = 0.7 }) {
  const n = Math.floor(sr * dur);
  const out = new Float32Array(n);
  let phase = 0;
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const f = pitchLo + (pitchHi - pitchLo) * Math.exp(-pitchDecay * t);
    phase += (TAU * f) / sr;
    out[i] = Math.sin(phase) * Math.exp(-ampDecay * t);
  }
  const fade = Math.min(n, Math.floor(sr * 0.01)); // kill any truncation tick
  for (let i = 0; i < fade; i++) out[n - 1 - i] *= i / fade;
  return out;
}

// Fast Walsh-Hadamard over 8 lanes, in place. Orthogonal, lossless.
function had8(v) {
  for (let s = 1; s < 8; s <<= 1)
    for (let i = 0; i < 8; i += s << 1)
      for (let j = i; j < i + s; j++) {
        const a = v[j], b = v[j + s];
        v[j] = a + b;
        v[j + s] = a - b;
      }
  for (let i = 0; i < 8; i++) v[i] *= 0.3535533906; // 1/√8
}

// Mutually prime-ish delay seconds — the classic spread from the study.
const DEL = [0.0119, 0.0147, 0.0187, 0.0223, 0.0279, 0.0317, 0.0383, 0.0437];

// L hears the tank taps summed straight, R through alternating signs: two
// orthogonal mixes of the same lossless tank, so the tails decorrelate
// without either channel losing energy.
const SIGN_L = [1, 1, 1, 1, 1, 1, 1, 1];
const SIGN_R = [1, -1, 1, -1, 1, -1, 1, -1];

export function fdnStereoIR(sr, { size, rt60, damp }) {
  const N = 8;
  const len = Math.floor(Math.min(6.5, rt60 * 1.1 + 0.3) * sr);
  const dl = DEL.map((d) => Math.max(8, Math.floor(d * size * sr)));
  const cap = dl.map((d) => d + 4);
  const bufs = cap.map((c) => new Float32Array(c));
  const wp = new Array(N).fill(0);
  const lp = new Float32Array(N);
  const g = dl.map((d) => Math.pow(10, (-3 * (d / sr)) / rt60));
  const o = new Float32Array(N);
  const outL = new Float32Array(len);
  const outR = new Float32Array(len);
  for (let k = 0; k < len; k++) {
    let sumL = 0, sumR = 0;
    for (let i = 0; i < N; i++) {
      const v = bufs[i][(((wp[i] - dl[i]) % cap[i]) + cap[i]) % cap[i]];
      lp[i] = v * (1 - damp) + lp[i] * damp; // one-pole damping: air + walls
      o[i] = lp[i] * g[i]; // RT60 → per-line gain
      sumL += o[i] * SIGN_L[i];
      sumR += o[i] * SIGN_R[i];
    }
    outL[k] = sumL;
    outR[k] = sumR;
    had8(o);
    const x = k === 0 ? 1 : 0;
    for (let i = 0; i < N; i++) {
      bufs[i][wp[i]] = x + o[i];
      wp[i] = (wp[i] + 1) % cap[i];
    }
  }
  let peak = 1e-9;
  for (let k = 0; k < len; k++) peak = Math.max(peak, Math.abs(outL[k]), Math.abs(outR[k]));
  for (let k = 0; k < len; k++) {
    outL[k] /= peak;
    outR[k] /= peak;
  }
  return [outL, outR];
}

export class KickEngine {
  constructor() {
    this.params = {
      bpm: 118, hits: 4, rotate: 0, swing: 0,
      pitchHi: 160, pitchLo: 45, pitchDecay: 45, ampDecay: 18, level: 0.85,
      size: 1.0, rt60: 2.6, damp: 0.35, wet: 0.4,
    };
    this.steps = 16;
    this.pattern = euclideanPattern(this.steps, this.params.hits, this.params.rotate);
    this.playing = false;
    this.ctx = null;
    this._hits = []; // booked hits awaiting their audio time (visual side pops)
    this._irTimer = null;
  }

  ensureCtx() {
    if (this.ctx) return;
    const ctx = new AudioContext();
    this.ctx = ctx;
    this.master = ctx.createGain();
    this.master.gain.value = 0.8;
    this.master.connect(ctx.destination);

    this.dry = ctx.createGain();
    this.dry.gain.value = 0.9;
    this.dry.connect(this.master);

    this.convolver = ctx.createConvolver();
    this.wetGain = ctx.createGain();
    this.wetGain.gain.value = this.params.wet;
    this.convolver.connect(this.wetGain);
    this.wetGain.connect(this.master);

    // stereo taps for the XY scope
    const split = ctx.createChannelSplitter(2);
    this.master.connect(split);
    this.analyserL = ctx.createAnalyser();
    this.analyserR = ctx.createAnalyser();
    this.analyserL.fftSize = this.analyserR.fftSize = 2048;
    split.connect(this.analyserL, 0);
    split.connect(this.analyserR, 1);
    this._scopeL = new Float32Array(2048);
    this._scopeR = new Float32Array(2048);

    // wet-only energy tap — drives the reverb-tail visuals
    this.analyserWet = ctx.createAnalyser();
    this.analyserWet.fftSize = 1024;
    this.wetGain.connect(this.analyserWet);
    this._wetBuf = new Float32Array(1024);

    this.rebuildKick();
    this.rebuildIR();
  }

  rebuildKick() {
    if (!this.ctx) return;
    const sr = this.ctx.sampleRate;
    const data = renderKick(sr, this.params);
    const buf = this.ctx.createBuffer(1, data.length, sr);
    buf.copyToChannel(data, 0);
    this.kickBuf = buf;
  }

  rebuildIR() {
    if (!this.ctx) return;
    const sr = this.ctx.sampleRate;
    const [L, R] = fdnStereoIR(sr, this.params);
    const buf = this.ctx.createBuffer(2, L.length, sr);
    buf.copyToChannel(L, 0);
    buf.copyToChannel(R, 1);
    this.convolver.buffer = buf;
  }

  // IR renders take tens of ms — coalesce slider scrubs
  rebuildIRSoon() {
    clearTimeout(this._irTimer);
    this._irTimer = setTimeout(() => this.rebuildIR(), 150);
  }

  setPattern() {
    this.params.hits = Math.min(this.params.hits, this.steps);
    this.pattern = euclideanPattern(this.steps, this.params.hits, this.params.rotate);
  }

  setWet(w) {
    this.params.wet = w;
    if (this.wetGain) this.wetGain.gain.value = w;
  }

  start() {
    this.ensureCtx();
    this.ctx.resume();
    this.playing = true;
    this.step = 0;
    this.nextTime = this.ctx.currentTime + 0.08;
  }

  stop() {
    this.playing = false;
    this._hits.length = 0;
  }

  // Lookahead scheduler: called every frame, books everything inside the
  // horizon at exact audio times. Swing delays odd 16ths at book time.
  tick() {
    if (!this.playing) return;
    const horizon = this.ctx.currentTime + 0.12;
    while (this.nextTime < horizon) {
      const stepDur = 60 / this.params.bpm / 4;
      if (this.pattern[this.step]) {
        const late = this.step % 2 === 1 ? this.params.swing * stepDur * 0.5 : 0;
        const accent = this.step === 0 ? 1 : 0.8;
        this.scheduleKick(this.nextTime + late, accent);
      }
      this.step = (this.step + 1) % this.steps;
      this.nextTime += stepDur;
    }
  }

  scheduleKick(t, accent) {
    const src = this.ctx.createBufferSource();
    src.buffer = this.kickBuf;
    const g = this.ctx.createGain();
    g.gain.value = accent * this.params.level;
    src.connect(g);
    g.connect(this.dry);
    g.connect(this.convolver);
    src.start(t);
    this._hits.push({ time: t, accent });
  }

  // Hits whose audio time has arrived — the visual side kicks springs off these.
  consumeHits() {
    if (!this.ctx || !this._hits.length) return [];
    const now = this.ctx.currentTime;
    const due = [];
    while (this._hits.length && this._hits[0].time <= now) due.push(this._hits.shift());
    return due;
  }

  // RMS of the wet bus — the audible reverb tail as a number.
  wetRms() {
    if (!this.ctx) return 0;
    this.analyserWet.getFloatTimeDomainData(this._wetBuf);
    let s = 0;
    for (let i = 0; i < this._wetBuf.length; i++) s += this._wetBuf[i] * this._wetBuf[i];
    return Math.sqrt(s / this._wetBuf.length);
  }

  // Write the newest L/R window into an RGBA float texture: r = left, g = right.
  fillScope(rgba) {
    if (!this.ctx) return false;
    this.analyserL.getFloatTimeDomainData(this._scopeL);
    this.analyserR.getFloatTimeDomainData(this._scopeR);
    for (let i = 0; i < this._scopeL.length; i++) {
      rgba[i * 4] = this._scopeL[i];
      rgba[i * 4 + 1] = this._scopeR[i];
    }
    return true;
  }
}
