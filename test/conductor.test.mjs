import { test } from "node:test";
import assert from "node:assert/strict";
import { Conductor, Spring, euclideanPattern } from "../src/conductor.js";

test("euclideanPattern(8,3) is the tresillo", () => {
  const p = euclideanPattern(8, 3);
  const hits = p.flatMap((v, i) => (v ? [i] : []));
  assert.deepEqual(hits, [0, 3, 6]);
});

test("euclideanPattern hit count and rotation", () => {
  for (const [steps, hits] of [[16, 5], [12, 7], [4, 4], [9, 1]]) {
    const p = euclideanPattern(steps, hits);
    assert.equal(p.filter(Boolean).length, hits, `${hits} of ${steps}`);
  }
  const r = euclideanPattern(8, 3, 1);
  assert.deepEqual(
    r.flatMap((v, i) => (v ? [i] : [])),
    [1, 4, 7]
  );
});

test("conductor fires each hit exactly once per cycle", () => {
  const c = new Conductor({ bpm: 120, beatsPerBar: 4 });
  const fired = [];
  c.voice({ steps: 8, hits: 3, onHit: (e) => fired.push(e.step) });
  // one bar at 120bpm = 2s; step through in uneven chunks
  let t = 0;
  while (t < 2.0 - 1e-9) {
    const dt = Math.min(0.033, 2.0 - t);
    c.update(dt);
    t += dt;
  }
  assert.deepEqual(fired, [0, 3, 6]);
});

test("pattern head is accented above other hits", () => {
  const c = new Conductor({ bpm: 60 });
  const accents = new Map();
  c.voice({ steps: 8, hits: 3, onHit: (e) => accents.set(e.step, e.accent) });
  for (let i = 0; i < 400; i++) c.update(0.0167);
  assert.ok(accents.get(0) > accents.get(3));
});

test("swing delays odd steps only", () => {
  const straight = new Conductor({ bpm: 60, swing: 0 });
  const swung = new Conductor({ bpm: 60, swing: 0.5 });
  const at = (c) => {
    const beats = [];
    c.voice({ steps: 4, hits: 4, onHit: (e) => beats.push(e.beat) });
    for (let i = 0; i < 500; i++) c.update(0.01);
    return beats.slice(0, 4);
  };
  const a = at(straight);
  const b = at(swung);
  assert.ok(Math.abs(a[0] - b[0]) < 0.02); // even step on time
  assert.ok(b[1] - a[1] > 0.1); // odd step late
  assert.ok(Math.abs(a[2] - b[2]) < 0.02);
});

test("phrase01 rises through the phrase and wraps", () => {
  const c = new Conductor({ bpm: 60, beatsPerBar: 4, barsPerPhrase: 2 });
  c.update(4); // 4 beats = half the 8-beat phrase
  assert.ok(Math.abs(c.phrase01 - 0.5) < 1e-6);
  c.update(4.4);
  assert.ok(c.phrase01 < 0.06); // wrapped past the head
});

test("pump peaks on the beat and decays before the next", () => {
  const c = new Conductor({ bpm: 60 });
  c.update(1.000001); // clock starts at -1e-6; land just past beat 1
  assert.ok(c.pump() > 0.99);
  c.update(0.5); // halfway to beat 2
  const mid = c.pump();
  assert.ok(mid < 0.2 && mid > 0);
  c.update(0.49);
  assert.ok(c.pump() < mid); // still falling at the tail
});

test("spring kicks, rings, and settles back to target", () => {
  const s = new Spring({ value: 1, freq: 2, zeta: 0.4 });
  s.kick(5);
  let peak = 1;
  for (let i = 0; i < 60; i++) peak = Math.max(peak, s.update(0.016));
  assert.ok(peak > 1.1, "kick moved it");
  for (let i = 0; i < 600; i++) s.update(0.016);
  assert.ok(Math.abs(s.value - 1) < 0.01, "settled to target");
});

test("spring survives a huge dt without exploding", () => {
  const s = new Spring({ value: 0, target: 1, freq: 3, zeta: 0.3 });
  s.update(10);
  assert.ok(Number.isFinite(s.value) && Math.abs(s.value) < 5);
});
