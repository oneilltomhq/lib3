// src/journey.js
// Composable parameter journeys — the time-domain mirror of lib3's TSL nodes.
//
// Pure JS: no THREE, no TSL, no DOM. Everything here is a plain function of
// numbers, so it's unit-testable and drivable from any renderer (or none).
//
// The model is the one every motion discipline converged on (DAWs, animation,
// modular synths) — three separable layers:
//
//   patch       — a point in parameter space (a preset / a stop's values)
//   modulation  — continuous motion *around* the current point (lfo, drift),
//                 so a held patch never freezes
//   arrangement — phrased movement *between* patches (stops, transitions,
//                 holds), driven by `createJourneyDriver`
//
// A `channels` map gives each parameter its interpolation geometry:
//   space: "log"  — multiplicative (frequencies, zoom); sweeps perceptually even
//   space: "wrap" — angular over `period` (phase, hue); takes the shortest arc
//   otherwise     — linear
//   min / max     — optional clamp, applied after modulation
//
// Modulators respect the same geometry: on a log channel a modulator's output
// is applied multiplicatively (base·e^m), on a wrap channel it stays on the
// circle, on a linear channel it adds.

const TAU = Math.PI * 2;

// ---- channel interpolation ------------------------------------------------------

function lerpScalar(a, b, e) { return a + (b - a) * e; }

// Interpolate one value in the geometry its channel `spec` declares; `e` in [0,1].
export function lerpChannel(spec, a, b, e) {
  const space = spec?.space;
  if (space === "log") {
    const la = Math.log(Math.max(1e-6, a)), lb = Math.log(Math.max(1e-6, b));
    return Math.exp(lerpScalar(la, lb, e));
  }
  if (space === "wrap") {
    const p = spec.period;
    let d = (b - a) % p;
    if (d > p / 2) d -= p;
    if (d < -p / 2) d += p;
    return a + d * e;
  }
  return lerpScalar(a, b, e);
}

// Interpolate a whole value map from `from` to `to` under a `channels` schema.
export function lerpValues(channels, from, to, e) {
  const out = {};
  for (const k in to) out[k] = lerpChannel(channels[k], from[k] ?? to[k], to[k], e);
  return out;
}

export const EASES = {
  linear: (a) => a,
  smooth: (a) => a * a * (3 - 2 * a),
  smoother: (a) => a * a * a * (a * (a * 6 - 15) + 10),
};

// ---- camera (spherical orbit pose) ----------------------------------------------
// A pose is { azimuth, elevation, distance, target:[x,y,z] } — the terms a
// stop's `camera` block uses. Interpolating poses keeps the move an *orbit*
// (azimuth on the shortest arc, distance multiplicative), never a chord
// through the subject.

export function cameraPosition({ azimuth, elevation, distance, target = [0, 0, 0] }) {
  const ce = Math.cos(elevation);
  return [
    target[0] + distance * ce * Math.sin(azimuth),
    target[1] + distance * Math.sin(elevation),
    target[2] + distance * ce * Math.cos(azimuth),
  ];
}

// World position (+target) -> spherical pose, so a live camera can be captured
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

// ---- stops / journeys ------------------------------------------------------------
// An authored stop is sparse: { preset } or { values }, plus optional camera,
// hold (seconds parked) and transition (seconds gliding in, or a
// { duration, ease, kind } object). Resolving normalizes it into a complete
// keyframe against the module's defaults/presets, threading camera inheritance
// (a stop with no camera holds the previous stop's pose).

export function resolveStop(stop, { defaults = {}, presets = {}, prevCamera, cameraDefault } = {}) {
  const values = stop.values
    ? { ...defaults, ...stop.values }
    : { ...defaults, ...(presets[stop.preset] || {}) };
  const transition =
    typeof stop.transition === "number"
      ? { duration: stop.transition, ease: "smooth", kind: "morph" }
      : { duration: 3.0, ease: "smooth", kind: "morph", ...(stop.transition || {}) };
  const inherited = prevCamera ?? cameraDefault ?? null;
  const camera = stop.camera
    ? { ...(cameraDefault || {}), ...stop.camera }
    : inherited && { ...inherited };
  return { name: stop.name || stop.preset || "stop", values, camera, hold: stop.hold ?? 2.5, transition };
}

export function resolveJourney(stops, { defaults = {}, presets = {}, cameraDefault } = {}) {
  const out = [];
  let prevCamera = cameraDefault;
  for (const stop of stops) {
    const resolved = resolveStop(stop, { defaults, presets, prevCamera, cameraDefault });
    prevCamera = resolved.camera ?? prevCamera;
    out.push(resolved);
  }
  return out;
}

// ---- modulators -------------------------------------------------------------------
// A modulator is just a signal: (t) => number, centred on 0, |value| <= depth.
// Attach them per channel and fold them over a base patch with `modulate` —
// the arrangement layer moves the base point, modulation breathes around it.

// Periodic low-frequency oscillator. rate in Hz, phase in cycles.
export function lfo({ rate = 0.1, depth = 1, shape = "sine", phase = 0 } = {}) {
  return (t) => {
    const p = rate * t + phase;
    const f = p - Math.floor(p);
    let v;
    if (shape === "triangle") v = 4 * Math.abs(f - 0.5) - 1;
    else if (shape === "saw") v = 2 * f - 1;
    else if (shape === "square") v = f < 0.5 ? 1 : -1;
    else v = Math.sin(TAU * p);
    return v * depth;
  };
}

// Smooth aperiodic wander (fractal value noise over time) — the king of
// organic motion. Deterministic for a given seed. rate in Hz-ish (features
// per second), |output| <= depth.
export function drift({ rate = 0.1, depth = 1, seed = 1, octaves = 2 } = {}) {
  return (t) => {
    let amp = 1, sum = 0, norm = 0, f = rate;
    for (let o = 0; o < octaves; o++) {
      sum += amp * valueNoise1D(t * f, seed + o * 101);
      norm += amp;
      amp *= 0.5;
      f *= 2.13; // non-integer lacunarity: octaves never phase-lock
    }
    return (sum / norm) * depth;
  };
}

function hash1(i, seed) {
  const x = Math.sin(i * 127.1 + seed * 311.7) * 43758.5453123;
  return x - Math.floor(x);
}

function valueNoise1D(u, seed) {
  const i = Math.floor(u), f = u - i;
  const s = f * f * (3 - 2 * f);
  return (hash1(i, seed) * (1 - s) + hash1(i + 1, seed) * s) * 2 - 1;
}

// Fold modulators over a base patch. `mods` maps channel -> signal (or array
// of signals; they sum). `master` scales every depth at once — a "life" macro.
// Returns a fresh object; `base` is never touched.
export function modulate(channels, base, mods, t, master = 1) {
  const out = { ...base };
  if (!mods || master === 0) return out;
  for (const key in mods) {
    if (!(key in out)) continue;
    const sigs = Array.isArray(mods[key]) ? mods[key] : [mods[key]];
    let m = 0;
    for (const s of sigs) m += s(t);
    m *= master;
    const spec = channels[key] || {};
    let v = spec.space === "log" ? out[key] * Math.exp(m) : out[key] + m;
    if (spec.space === "wrap") {
      const p = spec.period;
      v = ((v % p) + p) % p;
    }
    if (spec.min !== undefined) v = Math.max(spec.min, v);
    if (spec.max !== undefined) v = Math.min(spec.max, v);
    out[key] = v;
  }
  return out;
}

// ---- driver -----------------------------------------------------------------------
// The arrangement state machine: transition -> hold -> advance (looping).
// It owns *base* values only — apply `modulate` on top each frame yourself, so
// modulation keeps breathing whether or not the autopilot is flying.
//
//   getBase / setBase     — read/write the base patch (plain {key: number})
//   getCamera / setCamera — optional; spherical poses (see above)
//   holdOrbit             — rad/s of idle azimuth drift while parked, so a
//                           held figure keeps its parallax
//   grabCamera()          — call when the user takes the controls mid-flight;
//                           the autopilot stops flying the camera (values keep
//                           morphing) and reclaims it at the next stop
export function createJourneyDriver({
  stops = [],
  channels = {},
  getBase,
  setBase,
  getCamera,
  setCamera,
  holdOrbit = 0,
  onStopChange,
} = {}) {
  const d = { playing: false, idx: 0, mode: "transition", tIn: 0, from: null, fromCam: null, camPose: null, camManual: false };
  const hasCam = typeof getCamera === "function" && typeof setCamera === "function";

  function start() {
    if (!stops.length) return;
    d.playing = true;
    d.idx = 0;
    d.mode = "transition";
    d.tIn = 0;
    d.from = { ...getBase() };
    d.fromCam = hasCam ? getCamera() : null;
    d.camPose = d.fromCam;
    d.camManual = false;
    onStopChange?.(d.idx, stops[d.idx]);
  }

  function stop() { d.playing = false; }

  function grabCamera() { if (d.playing) d.camManual = true; }

  function update(dt) {
    if (!d.playing || !stops.length) return;
    if (d.idx >= stops.length) d.idx = 0; // stops edited under us
    const step = stops[d.idx];
    d.tIn += dt;
    if (d.mode === "transition") {
      const T = step.transition.duration;
      const a = T > 0 ? Math.min(1, d.tIn / T) : 1;
      const e = (EASES[step.transition.ease] || EASES.smooth)(a);
      setBase(lerpValues(channels, d.from, step.values, e));
      if (hasCam && !d.camManual && step.camera) {
        d.camPose = lerpCamera(d.fromCam, step.camera, e);
        setCamera(d.camPose);
      }
      if (a >= 1) { d.mode = "hold"; d.tIn = 0; }
    } else {
      if (hasCam && !d.camManual && d.camPose) {
        d.camPose = { ...d.camPose, azimuth: d.camPose.azimuth + holdOrbit * dt };
        setCamera(d.camPose);
      }
      if (d.tIn >= step.hold) {
        d.idx = (d.idx + 1) % stops.length;
        d.from = { ...getBase() };
        d.fromCam = hasCam ? (d.camManual ? getCamera() : d.camPose) : null;
        d.camManual = false;
        d.mode = "transition";
        d.tIn = 0;
        onStopChange?.(d.idx, stops[d.idx]);
      }
    }
  }

  return {
    start,
    stop,
    grabCamera,
    update,
    get playing() { return d.playing; },
    get index() { return d.idx; },
    get stops() { return stops; },
    set stops(s) { stops = s; },
  };
}
