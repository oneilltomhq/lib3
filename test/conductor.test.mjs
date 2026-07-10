import { test } from "node:test";
import assert from "node:assert/strict";
import { Conductor, Spring, Slew, euclideanPattern } from "../src/conductor.js";

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

test("phrase01 reads 0 before the first update, not ~1", () => {
  const c = new Conductor({ bpm: 60, beatsPerBar: 4, barsPerPhrase: 4 });
  assert.equal(c.phrase01, 0);
  assert.equal(c.bar01, 0);
});

test("phraseBeats and phraseSeconds track config and live bpm", () => {
  const c = new Conductor({ bpm: 120, beatsPerBar: 4, barsPerPhrase: 2 });
  assert.equal(c.phraseBeats, 8);
  assert.equal(c.phraseSeconds, 4); // 8 beats at 120bpm
  c.bpm = 60;
  assert.equal(c.phraseSeconds, 8);
});

test("onPhrase fires at each phrase head but never at t=0", () => {
  const c = new Conductor({ bpm: 60, beatsPerBar: 4, barsPerPhrase: 1 });
  const heads = [];
  c.onPhrase((e) => heads.push(e.phrase));
  c.update(0.01); // crosses beat 0 — must not fire
  assert.deepEqual(heads, []);
  for (let i = 0; i < 900; i++) c.update(0.01); // ~9s = past heads 1 and 2
  assert.deepEqual(heads, [1, 2]);
});

test("onPhrase catches every head crossed by one big dt", () => {
  const c = new Conductor({ bpm: 60, beatsPerBar: 4, barsPerPhrase: 1 });
  const heads = [];
  c.onPhrase((e) => heads.push(e.phrase));
  c.update(13); // 13 beats = heads 1, 2, 3
  assert.deepEqual(heads, [1, 2, 3]);
});

test("onPhrase unsubscribe stops further fires", () => {
  const c = new Conductor({ bpm: 60, beatsPerBar: 4, barsPerPhrase: 1 });
  let n = 0;
  const off = c.onPhrase(() => n++);
  c.update(5);
  off();
  c.update(4);
  assert.equal(n, 1);
});

test("voice window gates hits to a slice of the phrase", () => {
  const c = new Conductor({ bpm: 60, beatsPerBar: 4, barsPerPhrase: 1 });
  const fired = [];
  // 4 steps over the 4-beat phrase land at phrase01 0, .25, .5, .75
  c.voice({ steps: 4, hits: 4, window: [0.5, 1], onHit: (e) => fired.push(e.step) });
  for (let i = 0; i < 500; i++) c.update(0.01); // one 4s phrase + 1s of next
  assert.deepEqual(fired, [2, 3]); // heads land at phrase01 = 0, outside window
});

test("wrapped voice window (a > b) spans the phrase head", () => {
  const c = new Conductor({ bpm: 60, beatsPerBar: 4, barsPerPhrase: 1 });
  const fired = [];
  c.voice({ steps: 4, hits: 4, window: [0.7, 0.3], onHit: (e) => fired.push(e.step) });
  for (let i = 0; i < 400; i++) c.update(0.01); // one 4s phrase
  assert.deepEqual(fired, [0, 1, 3]); // 0.5 excluded, head and 0.25/0.75 kept
});

test("slew rate cap makes arrival take distance/maxRate", () => {
  const s = new Slew({ value: 0, target: 2, maxRate: 1 });
  for (let i = 0; i < 100; i++) s.update(0.016); // 1.6s of a 2s ramp
  assert.ok(s.value > 1.5 && s.value < 1.7, `mid-ramp at rate cap, got ${s.value}`);
  for (let i = 0; i < 50; i++) s.update(0.016);
  assert.ok(Math.abs(s.value - 2) < 1e-3, "arrived");
});

test("slew accel cap gives an S-curve that never overshoots", () => {
  const s = new Slew({ value: 0, target: 1, maxRate: 2, maxAccel: 4 });
  let peak = 0;
  let early = null;
  for (let i = 0; i < 200; i++) {
    s.update(0.016);
    if (i === 5) early = s.value;
    peak = Math.max(peak, s.value);
  }
  assert.ok(early < 0.08, "starts slow (accel-limited)");
  assert.ok(peak <= 1 + 1e-6, `no overshoot, peaked at ${peak}`);
  assert.ok(Math.abs(s.value - 1) < 1e-3, "settled at target");
});

test("slew survives a huge dt and retarget mid-flight", () => {
  const s = new Slew({ value: 0, target: 1, maxRate: 3, maxAccel: 10 });
  s.update(10); // clamped to 0.25s of sim, like Spring — bounded, no blowup
  assert.ok(Number.isFinite(s.value) && s.value <= 1 + 1e-6);
  for (let i = 0; i < 100; i++) s.update(0.016);
  assert.ok(Math.abs(s.value - 1) < 1e-3, "arrived after enough frames");
  s.target = -1;
  for (let i = 0; i < 500; i++) s.update(0.016);
  assert.ok(Math.abs(s.value + 1) < 1e-3, "retargeted and arrived");
});
