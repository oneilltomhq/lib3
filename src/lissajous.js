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
//
// A stop is a keyframe the autopilot flies to:
//   values     — the knobs (a preset name, or a full captured snapshot)
//   camera      — where the eye orbits to (azimuth/elevation/distance, see below);
//                 omit it and the camera holds the previous stop's pose
//   hold        — seconds parked at the stop
//   transition  — how we glide IN from the previous stop. A bare number is shorthand
//                 for `{ duration }`; the long form `{ duration, ease, kind }` is
//                 reserved for richer joins (only ease:"smooth"/kind:"morph" wired up).
//
// Parameters interpolate channel-by-channel in their *natural* space (see
// LISSAJOUS_CHANNELS) — frequencies sweep multiplicatively, phase/hue take the
// shortest arc — so a frequency change writhes through the in-between ratios
// before locking, and the camera orbits the figure rather than dollying through it.
export const LISSAJOUS_JOURNEY = [
  { preset: "circle",       hold: 3.0, transition: 0.0, camera: { azimuth:  0.00, elevation: 0.06, distance: 3.0 } }, // clean ellipse, near head-on
  { preset: "detuned spin", hold: 2.0, transition: 4.0, camera: { azimuth:  0.50, elevation: 0.18, distance: 3.0 } }, // drift aside: parallax on the precession
  { preset: "3:4",          hold: 3.0, transition: 3.5, camera: { azimuth: -0.45, elevation: 0.12, distance: 2.9 } }, // swing across; re-lock to 3:4
  { preset: "ring texture", hold: 2.5, transition: 3.0, camera: { azimuth:  0.35, elevation: 0.28, distance: 2.5 } }, // push in to read the texture
  { preset: "sphere knot",  hold: 3.0, transition: 4.5, camera: { azimuth:  1.10, elevation: 0.55, distance: 3.5 } }, // rise & pull back as it lifts into 3D
  { preset: "helix",        hold: 3.0, transition: 3.5, camera: { azimuth:  2.20, elevation: 0.32, distance: 3.2 } }, // orbit round the turning coil
];

// ---- journey model: interpolation + stop resolution ----------------------------
// Pure (no THREE, no TSL) so it's testable and reusable by any driver.

// Per-channel interpolation space. Unlisted channels lerp linearly.
//   log  — multiplicative (frequencies, zoom): a perceptually even sweep, so
//          12->100 Hz spends as much time low as high instead of rushing the top.
//   wrap — angular: takes the shortest path around `period` (so phase 6.0->0.2
//          nudges across the seam instead of unwinding the whole cycle).
export const LISSAJOUS_CHANNELS = {
  freqX: { space: "log" }, freqY: { space: "log" }, freqZ: { space: "log" },
  ringFreq: { space: "log" },
  phaseX: { space: "wrap", period: TAU }, phaseY: { space: "wrap", period: TAU },
  phaseZ: { space: "wrap", period: TAU },
  hue: { space: "wrap", period: 1 },
};

// Default eye pose, in the spherical terms a stop's `camera` block uses.
export const LISSAJOUS_CAMERA_DEFAULT = { azimuth: 0, elevation: 0.12, distance: 3.2, target: [0, 0, 0] };

function lerpScalar(a, b, e) { return a + (b - a) * e; }

// Interpolate one knob honoring its channel space; `e` in [0,1].
export function lerpChannel(key, a, b, e) {
  const space = LISSAJOUS_CHANNELS[key]?.space;
  if (space === "log") {
    const la = Math.log(Math.max(1e-6, a)), lb = Math.log(Math.max(1e-6, b));
    return Math.exp(lerpScalar(la, lb, e));
  }
  if (space === "wrap") {
    const p = LISSAJOUS_CHANNELS[key].period;
    let d = (b - a) % p;
    if (d > p / 2) d -= p;
    if (d < -p / 2) d += p;
    return a + d * e;
  }
  return lerpScalar(a, b, e);
}

// Interpolate a whole knob set from `from` to `to` (a full resolved stop value map).
export function lerpLissajous(from, to, e) {
  const out = {};
  for (const k in to) out[k] = lerpChannel(k, from[k] ?? to[k], to[k], e);
  return out;
}

// Spherical eye pose -> world position [x,y,z], orbiting `target`.
export function cameraPosition({ azimuth, elevation, distance, target = [0, 0, 0] }) {
  const ce = Math.cos(elevation);
  return [
    target[0] + distance * ce * Math.sin(azimuth),
    target[1] + distance * Math.sin(elevation),
    target[2] + distance * ce * Math.cos(azimuth),
  ];
}

// World position (+target) -> the spherical pose, so a live camera can be captured
// or handed back to the autopilot.
export function cameraToSpherical(pos, target = [0, 0, 0]) {
  const dx = pos[0] - target[0], dy = pos[1] - target[1], dz = pos[2] - target[2];
  const distance = Math.hypot(dx, dy, dz) || 1e-6;
  return {
    azimuth: Math.atan2(dx, dz),
    elevation: Math.asin(Math.max(-1, Math.min(1, dy / distance))),
    distance,
    target: [...target],
  };
}

// Interpolate two eye poses: azimuth on the shortest arc, distance multiplicative
// (zoom), elevation/target linear. Keeps the move an *orbit*, never a chord.
export function lerpCamera(a, b, e) {
  let dT = (b.azimuth - a.azimuth) % TAU;
  if (dT > Math.PI) dT -= TAU;
  if (dT < -Math.PI) dT += TAU;
  const ta = a.target ?? [0, 0, 0], tb = b.target ?? [0, 0, 0];
  return {
    azimuth: a.azimuth + dT * e,
    elevation: lerpScalar(a.elevation, b.elevation, e),
    distance: Math.exp(lerpScalar(Math.log(a.distance), Math.log(b.distance), e)),
    target: [0, 1, 2].map((i) => lerpScalar(ta[i], tb[i], e)),
  };
}

// Normalize one authored/preset stop into a complete keyframe: values resolved
// against the defaults, transition upgraded to its object form, camera filled in
// (inheriting `prevCamera` when the stop names none, so camera is opt-in).
export function resolveLissajousStop(stop, prevCamera = LISSAJOUS_CAMERA_DEFAULT) {
  const values = stop.values
    ? { ...LISSAJOUS_DEFAULTS, ...stop.values }
    : { ...LISSAJOUS_DEFAULTS, ...(LISSAJOUS_PRESETS[stop.preset] || {}) };
  const transition =
    typeof stop.transition === "number"
      ? { duration: stop.transition, ease: "smooth", kind: "morph" }
      : { duration: 3.0, ease: "smooth", kind: "morph", ...(stop.transition || {}) };
  const camera = stop.camera
    ? { ...LISSAJOUS_CAMERA_DEFAULT, ...stop.camera }
    : { ...prevCamera };
  return { name: stop.name || stop.preset || "stop", values, camera, hold: stop.hold ?? 2.5, transition };
}

// Resolve a whole reel in order, threading camera inheritance through the stops.
export function resolveLissajousJourney(stops) {
  const out = [];
  let prevCamera = LISSAJOUS_CAMERA_DEFAULT;
  for (const stop of stops) {
    const resolved = resolveLissajousStop(stop, prevCamera);
    prevCamera = resolved.camera;
    out.push(resolved);
  }
  return out;
}
