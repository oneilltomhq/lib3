// src/lissajous.js
// The signal core of the ILDA laser demo, distilled to composable TSL nodes.
//
// Three separable layers live in the original `laser-lissajous.html`; this
// module is layer 1 only — the pure *curve math* (and the velocity/colour the
// beam look depends on). The vector-beam display look (additive persistence,
// tone-map) is a separate concern, deliberately not included here.
//
// Everything is 3D-capable but reduces to the classic flat X-Y figure when
// `ampZ = 0` (the default), so a 2D scope and a 3D orbiting figure share one
// node.

import { Fn, float, vec3, vertexIndex } from "three/tsl";

const TAU = Math.PI * 2;

// hue in [0,1] -> full-saturation rgb. Ported from the demo's hue2rgb().
const hue2rgb = /*@__PURE__*/ Fn(({ hue }) => {
  const r = hue.mul(6).mod(6).sub(3).abs().sub(1);
  const g = hue.mul(6).add(4).mod(6).sub(3).abs().sub(1);
  const b = hue.mul(6).add(2).mod(6).sub(3).abs().sub(1);
  return vec3(r, g, b).clamp(0, 1);
});

// Pure parametric position for one beam-phase `t`.
//
// This is the composable primitive: feed it a scalar phase and it returns a
// point on the figure. Drive it from a per-vertex beam parameter (see
// `beamSampleT`) to trace the whole curve, or from anything else (an emitter
// path, a metaball centre, a displacement) to make non-laser things "jam".
//
// 1+2  base Lissajous     x = sin(2pi.freqX.t + phaseX),  y = sin(2pi.(freqY+detuneY).t)
// 3    ring squeeze       f = (1-d) + d.sin(2pi.ringFreq.t),  scales all axes
// 5    positional drift   slow independent x/y wander
//      z axis             optional third oscillator, ampZ=0 -> flat 2D figure
export const lissajousAt = /*@__PURE__*/ Fn(({
  t,
  freqX = float(60),
  freqY = float(80),
  freqZ = float(90),
  phaseX = float(0),
  phaseY = float(0),
  phaseZ = float(0),
  detuneY = float(0),
  detuneZ = float(0),
  ringFreq = float(600),
  ringDepth = float(0),
  driftRate = float(0.15),
  driftDepth = float(0),
  ampZ = float(0),
  inset = float(0.92),
}) => {
  // 1+2 base oscillators
  const x = t.mul(freqX).mul(TAU).add(phaseX).sin();
  const y = t.mul(freqY.add(detuneY)).mul(TAU).add(phaseY).sin();
  const z = t.mul(freqZ.add(detuneZ)).mul(TAU).add(phaseZ).sin().mul(ampZ);

  // 3 ring-mod amplitude squeeze (A*B+C style), applied to every axis
  const car = t.mul(ringFreq).mul(TAU).sin();
  const f = ringDepth.oneMinus().add(ringDepth.mul(car));

  // 5 slow positional drift on x/y only (matches the demo)
  const dx = driftDepth.mul(t.mul(driftRate).mul(TAU).sin());
  const dy = driftDepth.mul(t.mul(driftRate.mul(0.8)).mul(TAU).cos());

  return vec3(x.mul(f).add(dx), y.mul(f).add(dy), z.mul(f)).mul(inset);
});

// Velocity-weighted brightness: a galvo dwells where the beam moves slowest, so
// turnarounds bloom. The demo finite-differenced against the *previous* sample,
// which a GPU vertex can't see — so we recompute the curve at `t + dt` in the
// same invocation. Embarrassingly parallel, and identical in look when `dt`
// equals the demo's per-sample step (trace / count).
//
// Plain builder (not an Fn): it composes `lissajousAt` and re-passes the params
// object, which only works on a real plain object — inside an Fn, `params` is a
// proxy over the raw argument array, so spreading/re-passing it loses the named
// fields. Callers pass the same plain object they give `lissajousAt`.
export function lissajousBrightness(params) {
  const t = params.t;
  const dt = params.dt ?? float(0.04 / 3500);
  const p0 = lissajousAt(params);
  const p1 = lissajousAt({ ...params, t: t.add(dt) });
  const speed = p1.sub(p0).length().add(1e-4);
  return float(0.012).div(speed).min(1.5);
}

// Full beam colour: hue -> rgb, scaled by velocity brightness, intensity gain,
// and the rhythmic colour pulse (technique 4). Returns an additive-ready rgb.
// Plain builder for the same reason as `lissajousBrightness`.
export function lissajousBeamColor(params) {
  const t = params.t;
  const hue = params.hue ?? float(0.4);
  const colorRate = params.colorRate ?? float(2);
  const colorDepth = params.colorDepth ?? float(0);
  const gain = params.gain ?? float(0.6);
  const b = lissajousBrightness(params);
  const pulse = colorDepth
    .oneMinus()
    .add(colorDepth.mul(t.mul(colorRate).mul(TAU).sin().mul(0.5).add(0.5)));
  return hue2rgb({ hue }).mul(b.mul(gain).mul(pulse));
}

// Per-vertex beam phase for a Points/Line geometry of `count` vertices: spreads
// the samples across a short time window `trace` ending at `time`. Drives
// `lissajousAt` / `lissajousBeamColor` as a positionNode/colorNode.
export const beamSampleT = /*@__PURE__*/ Fn(({
  time,
  trace = float(0.04),
  count = float(3500),
}) => {
  return float(vertexIndex).mul(trace.div(count)).add(time);
});

// Knob defaults (plain numbers) — mirrors the demo's `P`, plus the 3D axis.
// persistence/exposure are display-layer (Phase 2) and intentionally absent.
export const LISSAJOUS_DEFAULTS = {
  freqX: 60, freqY: 80, freqZ: 90,
  phaseX: 0, phaseY: 0, phaseZ: 0,
  detuneY: 0, detuneZ: 0,
  ringFreq: 600, ringDepth: 0,
  driftRate: 0.15, driftDepth: 0,
  ampZ: 0, inset: 0.92,
  hue: 0.4, colorRate: 2, colorDepth: 0, gain: 0.6,
  trace: 0.04, size: 6, scale: 1.4,
};

// Named starting points. The first block matches the demo's 2D presets; the
// last two switch on the Z axis to show the figure is genuinely 3D now.
export const LISSAJOUS_PRESETS = {
  diagonal:       { freqX: 60, freqY: 60, phaseX: 0, detuneY: 0, ringDepth: 0, colorDepth: 0, driftDepth: 0, ampZ: 0 },
  circle:         { freqX: 60, freqY: 60, phaseX: 1.5708, detuneY: 0, ringDepth: 0, ampZ: 0 },
  "3:4":          { freqX: 60, freqY: 80, phaseX: 0, detuneY: 0, ringDepth: 0, ampZ: 0 },
  "detuned spin": { freqX: 60, freqY: 80, detuneY: 0.18, phaseX: 0, ringDepth: 0, ampZ: 0 },
  "ring texture": { freqX: 50, freqY: 70, detuneY: 0.1, ringFreq: 740, ringDepth: 0.55, ampZ: 0 },
  "beat pulse":   { freqX: 60, freqY: 90, detuneY: 0.12, colorRate: 2, colorDepth: 0.9, ampZ: 0 },
  float:          { freqX: 55, freqY: 75, detuneY: 0.14, driftRate: 0.12, driftDepth: 0.28, ampZ: 0 },
  helix:          { freqX: 60, freqY: 60, freqZ: 12, phaseX: 1.5708, detuneZ: 0.0, ampZ: 0.9 },
  "sphere knot":  { freqX: 60, freqY: 80, freqZ: 100, detuneY: 0.05, ampZ: 0.8 },
};

// A default "demo reel": an ordered tour of sweet spots, chosen so each
// transition shows off a *different kind* of move rather than random hopping.
// `hold` = seconds parked at the stop; `transition` = seconds to glide into it
// from the previous one (the figure is interpolated parameter-by-parameter, so
// e.g. a frequency change writhes through the in-between ratios before locking).
// A stop may reference a preset by name, or carry its own `values` (what the
// lab's capture button records). Each stop is resolved against the defaults, so
// it's a complete configuration regardless of how few fields the preset names.
export const LISSAJOUS_JOURNEY = [
  { preset: "circle",       hold: 3.0, transition: 0.0 }, // arrive on a clean ellipse
  { preset: "detuned spin", hold: 2.0, transition: 4.0 }, // detune unlocks it -> slow precession
  { preset: "3:4",          hold: 3.0, transition: 3.5 }, // writhe through ratios, re-lock to 3:4
  { preset: "ring texture", hold: 2.5, transition: 3.0 }, // ring-mod blooms surface texture
  { preset: "sphere knot",  hold: 3.0, transition: 4.5 }, // ampZ lifts the flat figure into 3D
  { preset: "helix",        hold: 3.0, transition: 3.5 }, // settle into a turning 3D coil
];
