import test from "node:test";
import assert from "node:assert/strict";
import { Rack, bindUniform, bindKey } from "../src/rack.js";

// deterministic clock for session timestamps
function fakeClock(start = 0) {
  const c = { t: start, now: () => c.t, tick: (ms) => { c.t += ms; } };
  return c;
}

test("add/get/params: metadata + live values through a uniform binding", () => {
  const rack = new Rack();
  const u = { value: 0.35 };
  rack.add("/knot/roll", bindUniform(u), { min: 0, max: 2, label: "roll rate", unit: "rad/s" });
  assert.equal(rack.get("/knot/roll"), 0.35);
  const [p] = rack.params();
  assert.deepEqual(
    { path: p.path, label: p.label, min: p.min, max: p.max, unit: p.unit, value: p.value, init: p.init },
    { path: "/knot/roll", label: "roll rate", min: 0, max: 2, unit: "rad/s", value: 0.35, init: 0.35 },
  );
});

test("immediate set clamps to range and writes through", async () => {
  const rack = new Rack();
  const u = { value: 0.5 };
  rack.add("/a", bindUniform(u), { min: 0, max: 1 });
  const landed = await rack.set("/a", 4, 0);
  assert.equal(landed, 1);
  assert.equal(u.value, 1);
});

test("ramp: linear glide driven by update(dt), resolves at target", async () => {
  const rack = new Rack();
  const u = { value: 0 };
  rack.add("/a", bindUniform(u));
  const done = rack.set("/a", 1, 1000);
  rack.update(0.25);
  assert.ok(Math.abs(u.value - 0.25) < 1e-9);
  rack.update(0.25);
  assert.ok(Math.abs(u.value - 0.5) < 1e-9);
  rack.update(0.5);
  assert.equal(await done, 1);
  assert.equal(u.value, 1);
});

test("new set cancels the in-flight ramp on the same path", async () => {
  const rack = new Rack();
  const u = { value: 0 };
  rack.add("/a", bindUniform(u));
  const first = rack.set("/a", 1, 1000);
  rack.update(0.25); // 0.25
  const second = rack.set("/a", 0.25, 0); // cancel + snap
  assert.equal(await first, 0.25); // old promise resolves with current value
  assert.equal(await second, 0.25);
  rack.update(1); // must not move
  assert.equal(u.value, 0.25);
});

test("carry-over: a rebuilt scene re-adding the path gets the set value back", async () => {
  const rack = new Rack();
  const u1 = { value: 0.2 };
  rack.add("/a", bindUniform(u1), { min: 0, max: 1 });
  await rack.set("/a", 0.8, 0);
  rack.remove("/a");
  const u2 = { value: 0.2 }; // fresh uniform, default value
  rack.add("/a", bindUniform(u2), { min: 0, max: 1 });
  assert.equal(u2.value, 0.8);
});

test("session records every mutation; replay re-executes without re-recording", async () => {
  const clock = fakeClock();
  const rack = new Rack({ now: clock.now });
  const u = { value: 0 };
  rack.add("/a", bindUniform(u));
  clock.tick(100);
  await rack.set("/a", 0.5, 0);
  clock.tick(200);
  await rack.set("/a", 0.9, 0, "human");
  const session = rack.session();
  assert.deepEqual(session.map((e) => [e.t, e.source, e.cmd.value]), [
    [100, "agent", 0.5],
    [300, "human", 0.9],
  ]);
  u.value = 0;
  rack.clearSession();
  await rack.replay(session, 1000); // 1000x speed: waits collapse
  assert.equal(u.value, 0.9);
  assert.equal(rack.session().length, 0, "replay is not re-recorded");
});

test("snapshots: snap captures, apply restores through the channel", async () => {
  const rack = new Rack();
  const a = { value: 0.3 }, b = { value: 4 };
  rack.add("/a", bindUniform(a));
  rack.add("/b", bindUniform(b));
  rack.snap("scene-1");
  a.value = 0.9; b.value = 7;
  await rack.apply("scene-1", 0); // immediate
  assert.equal(a.value, 0.3);
  assert.equal(b.value, 4);
  assert.deepEqual(rack.snaps().map((s) => [s.name, s.params]), [["scene-1", 2]]);
  assert.equal(rack.snapshot("scene-1").params["/b"], 4);
});

test("lift: reconstructs config at a moment, interpolating mid-ramp", () => {
  const rack = new Rack();
  rack.add("/a", bindKey({ a: 0 }, "a"), { init: 0 });
  const session = [
    { t: 0, source: "agent", cmd: { type: "set", path: "/a", value: 1, ramp: 0 } },
    { t: 1000, source: "agent", cmd: { type: "set", path: "/a", value: 3, ramp: 2000 } },
  ];
  rack.lift(session, 2, "mid"); // t=2000ms: halfway through the 1→3 ramp
  assert.equal(rack.snapshot("mid").params["/a"], 2);
  rack.lift(session, 10, "after");
  assert.equal(rack.snapshot("after").params["/a"], 3);
});

test("pulse: max, hold, back to min", async () => {
  const rack = new Rack();
  const u = { value: 0 };
  rack.add("/hit", bindUniform(u), { min: 0, max: 1, type: "trigger" });
  const p = rack.pulse("/hit", 10);
  assert.equal(u.value, 1);
  await p;
  assert.equal(u.value, 0);
});

test("custom command types extend the same recorded channel", () => {
  const rack = new Rack();
  let got = null;
  rack.handle("patch", (cmd) => { got = cmd.name; return "ok"; });
  const r = rack.dispatch({ type: "patch", name: "ember" }, "agent");
  assert.equal(r, "ok");
  assert.equal(got, "ember");
  assert.equal(rack.session()[0].cmd.type, "patch");
});

test("addValues: journey base values become addressable with channel ranges", async () => {
  const rack = new Rack();
  const base = { freq: 2, phase: 0.5 };
  const channels = { freq: { space: "log", min: 0.1, max: 20 }, phase: {} };
  rack.addValues("/liss", base, channels);
  assert.equal(rack.get("/liss/freq"), 2);
  await rack.set("/liss/freq", 100, 0);
  assert.equal(base.freq, 20, "clamped to channel max");
});
