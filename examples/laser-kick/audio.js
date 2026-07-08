// examples/laser-kick/audio.js
// The sound half of the laser-kick example: a synthesized kick drum on a
// euclidean 16-step clock, fed through a convolution reverb whose impulse
// response is rendered live by an 8-line Hadamard feedback delay network.
//
// The kick voice and the FDN room live in src/dsp.js (renderKick /
// fdnStereoIR) — the decorrelated L/R tail is what makes the XY scope bloom
// into 2D.
//
// Scheduling is sample-accurate: a lookahead loop books BufferSources on the
// audio clock; the visual side consumes the same hit list as each booked hit's
// time arrives, so light and sound share one clock.

import { euclideanPattern } from "../../src/conductor.js";
import { renderKick, fdnStereoIR } from "../../src/dsp.js";

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
