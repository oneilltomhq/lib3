// test/journey.test.mjs
// The journey module is pure JS (no THREE/TSL), so everything is testable
// headlessly: channel-space lerp, stop resolution, modulators, and the driver
// state machine stepped with a fake clock.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  lerpChannel,
  lerpValues,
  EASES,
  cameraPosition,
  cameraToSpherical,
  lerpCamera,
  resolveStop,
  resolveJourney,
  lfo,
  drift,
  modulate,
  createJourneyDriver,
} from "../src/journey.js";

const TAU = Math.PI * 2;
const close = (a, b, eps = 1e-9) =>
  assert.ok(Math.abs(a - b) < eps, `expected ${a} ≈ ${b}`);

// ---- channel lerp ----------------------------------------------------------------

test("lerpChannel: linear by default", () => {
  close(lerpChannel(undefined, 0, 10, 0.5), 5);
});

test("lerpChannel: log space is multiplicative (geometric midpoint)", () => {
  close(lerpChannel({ space: "log" }, 10, 1000, 0.5), 100, 1e-6);
});

test("lerpChannel: wrap takes the shortest arc across the seam", () => {
  // 6.0 -> 0.2 over period TAU: short way is +0.483, not -5.8
  const mid = lerpChannel({ space: "wrap", period: TAU }, 6.0, 0.2, 0.5);
  close(mid, 6.0 + (0.2 + TAU - 6.0) / 2, 1e-9);
});

test("lerpValues: honors per-key spec and falls back to `to` when `from` misses a key", () => {
  const channels = { f: { space: "log" } };
  const out = lerpValues(channels, { f: 10 }, { f: 1000, extra: 3 }, 0.5);
  close(out.f, 100, 1e-6);
  close(out.extra, 3);
});

// ---- camera ------------------------------------------------------------------------

test("camera pose round-trips through position and back", () => {
  const pose = { azimuth: 0.7, elevation: 0.3, distance: 4, target: [1, 2, 3] };
  const back = cameraToSpherical(cameraPosition(pose), pose.target);
  close(back.azimuth, pose.azimuth, 1e-9);
  close(back.elevation, pose.elevation, 1e-9);
  close(back.distance, pose.distance, 1e-9);
});

test("lerpCamera: azimuth shortest arc, distance multiplicative", () => {
  const a = { azimuth: 0.1, elevation: 0, distance: 1, target: [0, 0, 0] };
  const b = { azimuth: TAU - 0.1, elevation: 0, distance: 4, target: [0, 0, 0] };
  const mid = lerpCamera(a, b, 0.5);
  close(mid.azimuth, 0, 1e-9); // crosses the seam, not the long way round
  close(mid.distance, 2, 1e-9); // geometric, not arithmetic (2.5)
});

// ---- stops -------------------------------------------------------------------------

test("resolveStop: preset lookup, transition shorthand, camera inheritance", () => {
  const opts = {
    defaults: { a: 1, b: 2 },
    presets: { hot: { a: 9 } },
    prevCamera: { azimuth: 1, elevation: 0, distance: 3, target: [0, 0, 0] },
    cameraDefault: { azimuth: 0, elevation: 0.1, distance: 3, target: [0, 0, 0] },
  };
  const s = resolveStop({ preset: "hot", transition: 2 }, opts);
  assert.equal(s.name, "hot");
  assert.deepEqual(s.values, { a: 9, b: 2 });
  assert.equal(s.transition.duration, 2);
  assert.equal(s.transition.ease, "smooth");
  close(s.camera.azimuth, 1); // no camera on the stop -> inherits prev

  const explicit = resolveStop({ values: { a: 5 }, camera: { azimuth: 2 } }, opts);
  close(explicit.camera.azimuth, 2);
  close(explicit.camera.elevation, 0.1); // missing fields fill from cameraDefault
});

test("resolveJourney: threads camera inheritance through the reel", () => {
  const opts = {
    defaults: { a: 0 },
    presets: {},
    cameraDefault: { azimuth: 0, elevation: 0, distance: 3, target: [0, 0, 0] },
  };
  const reel = resolveJourney(
    [
      { values: { a: 1 }, camera: { azimuth: 1.5 } },
      { values: { a: 2 } }, // no camera: holds the previous stop's pose
    ],
    opts
  );
  close(reel[1].camera.azimuth, 1.5);
});

// ---- modulators --------------------------------------------------------------------

test("lfo: sine hits 0 at t=0 and +depth at quarter period", () => {
  const s = lfo({ rate: 1, depth: 0.5 });
  close(s(0), 0, 1e-12);
  close(s(0.25), 0.5, 1e-9);
});

test("drift: bounded by depth, deterministic per seed, seeds differ", () => {
  const a = drift({ rate: 1, depth: 0.3, seed: 7 });
  const b = drift({ rate: 1, depth: 0.3, seed: 7 });
  const c = drift({ rate: 1, depth: 0.3, seed: 8 });
  let differ = false;
  for (let i = 0; i < 200; i++) {
    const t = i * 0.173;
    assert.ok(Math.abs(a(t)) <= 0.3 + 1e-9);
    close(a(t), b(t), 1e-12); // same seed, same wander
    if (Math.abs(a(t) - c(t)) > 1e-6) differ = true;
  }
  assert.ok(differ, "different seeds should wander differently");
});

test("modulate: additive on linear, multiplicative on log, wrapped on wrap, clamped", () => {
  const channels = {
    f: { space: "log" },
    h: { space: "wrap", period: 1 },
    d: { min: 0, max: 1 },
  };
  const base = { f: 100, h: 0.95, d: 0.98, plain: 1 };
  const mods = {
    f: () => Math.log(2), // log channel: base * e^m = 200
    h: () => 0.1,         // wrap channel: 1.05 -> 0.05
    d: () => 0.5,         // clamped at 1
    plain: () => 0.25,    // linear add
  };
  const out = modulate(channels, base, mods, 0);
  close(out.f, 200, 1e-9);
  close(out.h, 0.05, 1e-9);
  close(out.d, 1);
  close(out.plain, 1.25);
  assert.equal(base.f, 100, "base must never be mutated");

  const frozen = modulate(channels, base, mods, 0, 0); // master depth 0
  close(frozen.f, 100);
});

test("modulate: master scales, signal arrays sum", () => {
  const out = modulate({}, { x: 0 }, { x: [() => 1, () => 2] }, 0, 0.5);
  close(out.x, 1.5);
});

// ---- driver ------------------------------------------------------------------------

function makeWorld() {
  const base = { a: 0 };
  const cam = { azimuth: 0, elevation: 0, distance: 3, target: [0, 0, 0] };
  return {
    base,
    cam,
    getBase: () => ({ ...base }),
    setBase: (v) => Object.assign(base, v),
    getCamera: () => ({ ...cam }),
    setCamera: (p) => Object.assign(cam, p),
  };
}

test("driver: transition eases to the stop, holds, then advances and loops", () => {
  const w = makeWorld();
  const stops = resolveJourney(
    [
      { values: { a: 10 }, transition: 1, hold: 1 },
      { values: { a: 20 }, transition: 1, hold: 1 },
    ],
    { defaults: { a: 0 } }
  );
  const seen = [];
  const driver = createJourneyDriver({
    stops,
    channels: {},
    getBase: w.getBase,
    setBase: w.setBase,
    onStopChange: (i) => seen.push(i),
  });
  driver.start();
  assert.equal(driver.playing, true);
  assert.deepEqual(seen, [0]);

  driver.update(0.5); // halfway through transition: smoothstep(0.5) = 0.5
  close(w.base.a, 5, 1e-9);
  driver.update(0.5); // transition done
  close(w.base.a, 10);
  driver.update(1.0); // hold elapses -> advance to stop 1
  assert.deepEqual(seen, [0, 1]);
  assert.equal(driver.index, 1);
  driver.update(1.0); // stop 1 transition done
  close(w.base.a, 20);
  driver.update(1.0); // hold -> loops back to stop 0
  assert.deepEqual(seen, [0, 1, 0]);
});

test("driver: holdOrbit drifts the camera during holds; grabCamera hands it over for the leg", () => {
  const w = makeWorld();
  const stops = resolveJourney(
    [{ values: { a: 1 }, transition: 1, hold: 2, camera: { azimuth: 1 } }],
    { defaults: { a: 0 }, cameraDefault: { azimuth: 0, elevation: 0, distance: 3, target: [0, 0, 0] } }
  );
  const driver = createJourneyDriver({
    stops,
    channels: {},
    getBase: w.getBase,
    setBase: w.setBase,
    getCamera: w.getCamera,
    setCamera: w.setCamera,
    holdOrbit: 0.5,
  });
  driver.start();
  driver.update(1.0); // transition done, camera flown to azimuth 1
  close(w.cam.azimuth, 1, 1e-9);
  driver.update(1.0); // holding: idle orbit at 0.5 rad/s
  close(w.cam.azimuth, 1.5, 1e-9);

  driver.grabCamera(); // user takes the wheel: autopilot stops flying it
  const grabbed = w.cam.azimuth;
  driver.update(0.5);
  close(w.cam.azimuth, grabbed, 1e-9);
});

test("driver: without camera callbacks it still flies values", () => {
  const w = makeWorld();
  const stops = resolveJourney([{ values: { a: 4 }, transition: 1, hold: 1 }], { defaults: { a: 0 } });
  const driver = createJourneyDriver({ stops, channels: {}, getBase: w.getBase, setBase: w.setBase });
  driver.start();
  driver.update(1.0);
  close(w.base.a, 4);
});
