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

// ---- voices: mute/solo as a mask, never a destructive write ----------------

test("mute eases the mask to identity over update() steps; unmute restores", () => {
  const rack = new Rack({ muteRamp: 400 });
  const u = { value: 0.8 };
  rack.add("/v", bindUniform(u), { min: 0, max: 1, voice: true });
  assert.equal(rack.muted("/v"), false);
  rack.mute("/v");
  assert.equal(rack.muted("/v"), true);
  rack.update(0.2); // 200ms of a 400ms ease — halfway
  assert.ok(Math.abs(u.value - 0.4) < 1e-9, "mask half-applied");
  rack.update(0.2); // lands at identity (0)
  assert.equal(u.value, 0);
  assert.equal(rack.get("/v"), 0.8, "logical value survives the mask");
  rack.mute("/v", false);
  rack.update(0.4);
  assert.equal(u.value, 0.8, "unmute honors the logical value");
});

test("explicit identity: mask eases to the declared identity, not zero", () => {
  const rack = new Rack({ muteRamp: 400 });
  const u = { value: 0.2 };
  rack.add("/v", bindUniform(u), { min: 0, max: 1, voice: 1 });
  rack.mute("/v");
  rack.update(1);
  assert.equal(u.value, 1, "masked to identity 1");
});

test("set-while-muted lands on unmute (shadow honored)", () => {
  const rack = new Rack({ muteRamp: 400 });
  const u = { value: 0.8 };
  rack.add("/v", bindUniform(u), { min: 0, max: 1, voice: true });
  rack.mute("/v");
  rack.update(1); // fully masked: u.value 0
  assert.equal(u.value, 0);
  rack.set("/v", 0.5, 0); // arrives while muted — writes the shadow
  assert.equal(u.value, 0, "still masked");
  assert.equal(rack.get("/v"), 0.5, "logical value updated under the mask");
  rack.mute("/v", false);
  rack.update(1);
  assert.equal(u.value, 0.5, "the value that arrived while muted lands");
});

test("ramp-while-muted lands on unmute", async () => {
  const rack = new Rack({ muteRamp: 400 });
  const u = { value: 0 };
  rack.add("/v", bindUniform(u), { min: 0, max: 1, voice: true });
  rack.mute("/v");
  rack.update(1); // masked
  const done = rack.set("/v", 1, 1000); // ramp the LOGICAL value while muted
  rack.update(0.5);
  assert.ok(Math.abs(rack.get("/v") - 0.5) < 1e-9, "logical ramp advances under the mask");
  assert.equal(u.value, 0, "still masked mid-ramp");
  rack.update(0.5);
  assert.equal(await done, 1);
  rack.mute("/v", false);
  rack.update(1);
  assert.equal(u.value, 1, "the ramped logical value lands on unmute");
});

test("solo isolates: other voices masked, the target and bone untouched", () => {
  const rack = new Rack({ muteRamp: 400 });
  const a = { value: 0.8 }, b = { value: 0.6 }, bone = { value: 0.5 };
  rack.add("/a", bindUniform(a), { min: 0, max: 1, voice: true });
  rack.add("/b", bindUniform(b), { min: 0, max: 1, voice: true });
  rack.add("/bone", bindUniform(bone), { min: 0.3, max: 1 }); // not a voice
  assert.equal(rack.solo("/a"), "/a");
  assert.equal(rack.soloed(), "/a");
  rack.update(1);
  assert.equal(a.value, 0.8, "soloed voice untouched");
  assert.equal(b.value, 0, "other voice masked to identity");
  assert.equal(bone.value, 0.5, "bone never registers on the bus");
  assert.equal(rack.solo("/a"), null, "second solo releases");
  rack.update(1);
  assert.equal(b.value, 0.6, "release restores the other voice");
});

test("second solo() restores the prior mute states", () => {
  const rack = new Rack({ muteRamp: 400 });
  const a = { value: 0.8 }, b = { value: 0.6 };
  rack.add("/a", bindUniform(a), { min: 0, max: 1, voice: true });
  rack.add("/b", bindUniform(b), { min: 0, max: 1, voice: true });
  rack.mute("/a"); // pre-solo: /a muted, /b open
  rack.solo("/b");
  assert.equal(rack.muted("/a"), true);
  assert.equal(rack.muted("/b"), false);
  rack.solo("/b"); // release — restore the pre-solo picture
  assert.equal(rack.muted("/a"), true, "the pre-solo mute is back");
  assert.equal(rack.muted("/b"), false);
  assert.equal(rack.soloed(), null);
});

test("solo a different path re-targets, keeping the original pre-solo memory", () => {
  const rack = new Rack({ muteRamp: 400 });
  const a = { value: 0.8 }, b = { value: 0.6 }, c = { value: 0.4 };
  rack.add("/a", bindUniform(a), { min: 0, max: 1, voice: true });
  rack.add("/b", bindUniform(b), { min: 0, max: 1, voice: true });
  rack.add("/c", bindUniform(c), { min: 0, max: 1, voice: true });
  rack.solo("/a");
  assert.equal(rack.soloed(), "/a");
  rack.solo("/b"); // re-target without releasing
  assert.equal(rack.soloed(), "/b");
  assert.equal(rack.muted("/a"), true);
  assert.equal(rack.muted("/c"), true);
  assert.equal(rack.muted("/b"), false);
  rack.solo("/b"); // release restores the ORIGINAL pre-solo state (all open)
  assert.equal(rack.soloed(), null);
  assert.equal(rack.muted("/a"), false);
  assert.equal(rack.muted("/b"), false);
  assert.equal(rack.muted("/c"), false);
});

test("a manual mute while soloed clears the solo memory (the hand takes over)", () => {
  const rack = new Rack({ muteRamp: 400 });
  const a = { value: 0.8 }, b = { value: 0.6 };
  rack.add("/a", bindUniform(a), { min: 0, max: 1, voice: true });
  rack.add("/b", bindUniform(b), { min: 0, max: 1, voice: true });
  rack.solo("/a");
  rack.mute("/b"); // hand-set mute overrides the solo
  assert.equal(rack.soloed(), null);
});

test("mute API is a no-op on a non-voice (bone) param", () => {
  const rack = new Rack({ muteRamp: 400 });
  const bone = { value: 0.5 };
  rack.add("/bone", bindUniform(bone), { min: 0.3, max: 1 });
  assert.equal(rack.mute("/bone"), false, "nothing to mask — no-op returns false");
  assert.equal(rack.muted("/bone"), false);
  assert.equal(rack.solo("/bone"), null, "a bone cannot be soloed");
  rack.update(1);
  assert.equal(bone.value, 0.5, "bone untouched by the mute bus");
  assert.deepEqual(rack.voices(), [], "no voices declared");
});

test("params() carries voice and muted per param", () => {
  const rack = new Rack({ muteRamp: 400 });
  rack.add("/v", bindUniform({ value: 0.8 }), { min: 0, max: 1, voice: true });
  rack.add("/bone", bindUniform({ value: 0.5 }), { min: 0.3, max: 1 });
  const byPath = Object.fromEntries(rack.params().map((p) => [p.path, p]));
  assert.equal(byPath["/v"].voice, true);
  assert.equal(byPath["/v"].muted, false);
  assert.equal(byPath["/bone"].voice, false);
  assert.equal(byPath["/bone"].muted, false);
  rack.mute("/v");
  assert.equal(rack.params().find((p) => p.path === "/v").muted, true);
});

test("mute and solo flow through the recorded channel", () => {
  const clock = fakeClock();
  const rack = new Rack({ now: clock.now, muteRamp: 400 });
  rack.add("/v", bindUniform({ value: 0.8 }), { min: 0, max: 1, voice: true });
  clock.tick(100);
  rack.mute("/v", true, "human");
  clock.tick(50);
  rack.solo("/v", "human");
  const session = rack.session();
  assert.deepEqual(
    session.map((e) => [e.t, e.source, e.cmd.type, e.cmd.path]),
    [[100, "human", "mute", "/v"], [150, "human", "solo", "/v"]],
  );
  assert.equal(session[0].cmd.on, true);
});

test("snapshots record LOGICAL values and stay mute-state-free", () => {
  const rack = new Rack({ muteRamp: 400 });
  const u = { value: 0 };
  rack.add("/v", bindUniform(u), { min: 0, max: 1, voice: true });
  rack.set("/v", 0.7, 0);
  rack.mute("/v");
  rack.update(1); // fully masked: u.value 0, but logical is 0.7
  assert.equal(u.value, 0);
  rack.snap("kept");
  const snap = rack.snapshot("kept");
  assert.equal(snap.params["/v"], 0.7, "snapshot records the logical value");
  assert.deepEqual(Object.keys(snap).sort(), ["created", "name", "params"], "no mute state in the snapshot");
});

test("apply restores logical values through the voice mask", async () => {
  const rack = new Rack({ muteRamp: 400 });
  const u = { value: 0.7 };
  rack.add("/v", bindUniform(u), { min: 0, max: 1, voice: true });
  rack.snap("kept");
  rack.set("/v", 0.1, 0);
  await rack.apply("kept", 0); // immediate
  rack.update(1); // mask is open (mix 1), so the real binding follows
  assert.equal(rack.get("/v"), 0.7, "logical restored");
  assert.equal(u.value, 0.7, "real binding follows since unmuted");
});
