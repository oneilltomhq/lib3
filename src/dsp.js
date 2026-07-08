// src/dsp.js — the small DSP bench the sound-making examples share. Pure JS,
// no THREE, no WebAudio nodes: every function renders Float32Array signals the
// caller wraps in AudioBuffers. Lifted out of examples/laser-kick/audio.js
// once a second example (lissajous-lightning) needed the same kick and room.

const TAU = Math.PI * 2;

/**
 * The phasor kick from agentic-faust-web's techno-bed.dsp: a sine whose
 * frequency drops exponentially hi→lo under an exponential amplitude decay.
 * Phase is integrated (not sin(2π·f·t)) so the sweep stays click-free.
 *
 * f(t) = lo + (hi − lo)·e^(−pitchDecay·t), amp e^(−ampDecay·t).
 */
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

// Mutually prime-ish delay seconds — the classic spread from study-1-reverb.
const DEL = [0.0119, 0.0147, 0.0187, 0.0223, 0.0279, 0.0317, 0.0383, 0.0437];

// L hears the tank taps summed straight, R through alternating signs: two
// orthogonal mixes of the same lossless tank, so the tails decorrelate
// without either channel losing energy.
const SIGN_L = [1, 1, 1, 1, 1, 1, 1, 1];
const SIGN_R = [1, -1, 1, -1, 1, -1, 1, -1];

/**
 * Stereo impulse response of an 8-line Hadamard feedback delay network — the
 * reverb machine from dynamics-notebook's study-1-reverb, with two orthogonal
 * output taps so the tail blooms into 2D on an XY scope. Returns [L, R],
 * peak-normalized as a pair. Load into a ConvolverNode for the room.
 */
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

/**
 * Thunder crack: the storm capstone's delay-sum of N-waves, sourced from real
 * geometry. Every point of `sources` (listener-relative, meters) is a shock
 * front arriving at d/343 s, stretching with distance, falling off 1/d, with
 * crackle dice on each amplitude. Returns { data, startDelay }: a mono signal
 * beginning at the FIRST arrival, plus how long after the flash that is.
 */
export function renderCrack(sr, sources, { energy = 1, seed = Math.random } = {}) {
  const C = 343;
  const ds = sources.map((p) => Math.hypot(p[0], p[1], p[2]));
  const minD = Math.min(...ds);
  const maxD = Math.max(...ds);
  const dur = (maxD - minD) / C + 1.2;
  const data = new Float32Array(Math.ceil(dur * sr));
  for (const d of ds) {
    const at = ((d - minD) / C) * sr;
    const T = (0.006 + d * 0.00006) * sr; // N-wave stretches with distance
    const a = (minD / d) * (0.5 + seed()); // 1/d falloff + crackle dice
    const j0 = at | 0;
    for (let n = 0; n < T; n++) {
      const q = j0 + n;
      if (q >= data.length) break;
      data[q] += a * (1 - 2 * n / T); // the N-wave: +a ramp to −a
    }
  }
  let peak = 1e-9;
  for (let n = 0; n < data.length; n++) peak = Math.max(peak, Math.abs(data[n]));
  const sc = (0.9 * energy) / peak;
  for (let n = 0; n < data.length; n++) data[n] *= sc;
  return { data, startDelay: minD / C };
}
