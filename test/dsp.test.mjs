import test from "node:test";
import assert from "node:assert/strict";
import { renderKick, fdnStereoIR, renderCrack } from "../src/dsp.js";

const SR = 48000;

test("renderKick: length, decay, click-free tail", () => {
  const out = renderKick(SR, { pitchHi: 160, pitchLo: 45, pitchDecay: 45, ampDecay: 18, dur: 0.5 });
  assert.equal(out.length, SR * 0.5);
  // amplitude decays: early window louder than late window
  const rms = (a, b) => {
    let s = 0;
    for (let i = a; i < b; i++) s += out[i] * out[i];
    return Math.sqrt(s / (b - a));
  };
  assert.ok(rms(0, 4800) > rms(out.length - 4800, out.length) * 4);
  assert.equal(out[out.length - 1], 0); // faded to nothing
});

test("fdnStereoIR: stereo pair, peak-normalized, decorrelated", () => {
  const [L, R] = fdnStereoIR(SR, { size: 1, rt60: 1.2, damp: 0.3 });
  assert.equal(L.length, R.length);
  let peak = 0, dot = 0, nL = 0, nR = 0;
  for (let i = 0; i < L.length; i++) {
    peak = Math.max(peak, Math.abs(L[i]), Math.abs(R[i]));
    dot += L[i] * R[i];
    nL += L[i] * L[i];
    nR += R[i] * R[i];
  }
  assert.ok(Math.abs(peak - 1) < 1e-6);
  // orthogonal output taps: channels correlate weakly
  assert.ok(Math.abs(dot / Math.sqrt(nL * nR)) < 0.5);
});

test("renderCrack: arrival order and spread from geometry", () => {
  // two sources: 343 m and 686 m out — second N-wave lands 1 s after the first
  const { data, startDelay } = renderCrack(SR, [[0, 0, 343], [0, 0, 686]], { seed: () => 0.5 });
  assert.ok(Math.abs(startDelay - 1) < 1e-6);
  assert.ok(data.length >= SR * 1.2); // spread (1 s) + tail
  assert.notEqual(data[0], 0); // signal starts at the FIRST arrival
  let peak = 0;
  for (const v of data) peak = Math.max(peak, Math.abs(v));
  assert.ok(peak <= 0.9 + 1e-6);
});
