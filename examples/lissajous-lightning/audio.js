// examples/lissajous-lightning/audio.js
// The thunder half. One strike = one figure, heard three ways at once:
//
//   crack — the storm capstone's delay-sum of N-waves, but the sources are
//           the POINTS OF THE LISSAJOUS FIGURE itself, scaled up into the sky.
//           The figure's spatial spread IS the rumble's temporal spread.
//   body  — two sub kicks (src/dsp.js renderKick) at fLo·p and fLo·q Hz — the
//           strike's frequency ratio, dropped five octaves into the chest.
//           p hard left, q hard right: on an XY scope the thunder literally
//           draws the same p:q figure the bolt flashed, smeared by the room.
//   room  — everything through study-1-reverb's stereo FDN (fdnStereoIR in a
//           ConvolverNode). The decorrelated tail is the "deep uncanny
//           spacious" part, and its RMS is handed back to the visuals.
//
// Distance is real physics: the crack starts minD/343 seconds after the
// flash, N-waves stretch and lowpass with range, close strikes crack, far
// ones only rumble.

import { renderKick, fdnStereoIR, renderCrack } from "../../src/dsp.js";

export class ThunderEngine {
  constructor() {
    this.params = {
      distanceKm: 0.8, level: 0.9,
      size: 1.7, rt60: 5.2, damp: 0.55, wet: 0.55,
    };
    this.enabled = false;
    this.ctx = null;
    this._irTimer = null;
  }

  ensureCtx() {
    if (this.ctx) return;
    const ctx = new AudioContext();
    this.ctx = ctx;
    this.master = ctx.createGain();
    this.master.gain.value = 0.85;
    this.master.connect(ctx.destination);

    this.dry = ctx.createGain();
    this.dry.gain.value = 0.8;
    this.dry.connect(this.master);

    this.convolver = ctx.createConvolver();
    this.wetGain = ctx.createGain();
    this.wetGain.gain.value = this.params.wet;
    this.convolver.connect(this.wetGain);
    this.wetGain.connect(this.master);

    // stereo taps for the XY scope — the thunder, seen
    const split = ctx.createChannelSplitter(2);
    this.master.connect(split);
    this.analyserL = ctx.createAnalyser();
    this.analyserR = ctx.createAnalyser();
    this.analyserL.fftSize = this.analyserR.fftSize = 2048;
    split.connect(this.analyserL, 0);
    split.connect(this.analyserR, 1);
    this._scopeL = new Float32Array(2048);
    this._scopeR = new Float32Array(2048);

    // wet-only energy tap — the audible tail as a number, for the visuals
    this.analyserWet = ctx.createAnalyser();
    this.analyserWet.fftSize = 1024;
    this.wetGain.connect(this.analyserWet);
    this._wetBuf = new Float32Array(1024);

    this.rebuildIR();
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

  setWet(w) {
    this.params.wet = w;
    if (this.wetGain) this.wetGain.gain.value = w;
  }

  _play(data, channels, when, gain, lowpassHz) {
    const ctx = this.ctx;
    const buf = ctx.createBuffer(channels.length, data[0].length, ctx.sampleRate);
    for (let c = 0; c < channels.length; c++) buf.copyToChannel(data[c], c);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    let node = src;
    if (lowpassHz) {
      const lp = ctx.createBiquadFilter();
      lp.type = "lowpass";
      lp.frequency.value = lowpassHz;
      node.connect(lp);
      node = lp;
    }
    const g = ctx.createGain();
    g.gain.value = gain;
    node.connect(g);
    g.connect(this.dry);
    g.connect(this.convolver);
    src.start(when);
  }

  /**
   * Fire the thunder for one strike.
   * @param {Array<[x,y,z]>} figurePts — points ON the bolt figure, world units
   * @param {{p:number, q:number}} ratio — the strike's frequency ratio
   * @param {number} energy — 1 on the first stroke, less on restrikes
   * @param {number} fLo — sub fundamental (Hz per ratio unit), ~16
   * @returns {number} seconds from flash to first thunder arrival
   */
  strike(figurePts, ratio, energy = 1, fLo = 16) {
    if (!this.enabled || !this.ctx) return 0;
    const ctx = this.ctx;
    const sr = ctx.sampleRate;
    const { distanceKm, level } = this.params;

    // lift the figure into the sky: ~150 m per figure unit, centred at 600 m
    // altitude, distanceKm out. The listener sits at the origin.
    const UNIT = 150, ALT = 600, D = distanceKm * 1000;
    const sources = figurePts.map(([x, y, z]) => [
      x * UNIT, ALT + y * UNIT, D + z * UNIT,
    ]);

    const { data, startDelay } = renderCrack(sr, sources, { energy });
    const when = ctx.currentTime + startDelay;
    const far = 0.4 + distanceKm;
    const lp = Math.min(4500, Math.max(110, 4000 / far)); // far = rumble only
    const g = Math.min(1.4, 1.4 / far) * level;
    this._play([data], [0], when, g, lp);

    // the body: the figure's interval, five octaves down. p left, q right —
    // the thunder hums the same fraction the bolt drew.
    const dur = 2.2 + energy * 1.6;
    const mk = (mult) => renderKick(sr, {
      pitchHi: fLo * mult * 2.4, pitchLo: fLo * mult,
      pitchDecay: 5, ampDecay: 1.6 / (0.4 + energy), dur,
    });
    const silence = new Float32Array(Math.floor(sr * dur));
    const bodyGain = 0.5 * level * energy * Math.min(1, 1.6 / far);
    this._play([mk(ratio.p), silence], [0, 1], when, bodyGain);
    this._play([silence, mk(ratio.q)], [0, 1], when, bodyGain);

    return startDelay;
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
