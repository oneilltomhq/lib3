// src/rack.js
// The control plane — a modular-synth jack panel for a scene's parameters.
//
// Pure JS: no THREE, no DOM. A Rack owns a flat address space of params
// (/knot/roll, /room/pump); each param BINDS to live state — a TSL uniform,
// a journey base value, a spring target, any get/set pair. Every mutation
// (human control, agent call, snapshot restore, replay) flows through ONE
// dispatch channel and is recorded with timestamps, so a session log is
// directly replayable and any moment of it can be lifted back out as a
// snapshot. Same contract as the agentic-faust rack, re-hosted for visuals:
//
//   set / ramp    — glide a param (linear, cancel-on-new-set, clamped)
//   pulse         — momentary max→min (a trigger jack)
//   snap / apply  — snapshots: the unit of keeping (named param configs)
//   session/replay/lift — time-based recordings; time is only an address
//                   for extraction
//
// Ramps advance in update(dt) from the host's own loop — a visual param only
// matters when a frame renders, so the render loop IS the ramp clock.

const clamp = (v, lo, hi) =>
  (lo !== undefined && v < lo) ? lo : (hi !== undefined && v > hi) ? hi : v;

/** Bind a TSL uniform (anything with .value) as a rack target. */
export function bindUniform(u) {
  return { get: () => u.value, set: (v) => { u.value = v; } };
}

/** Bind one key of a plain object (e.g. a journey base patch). */
export function bindKey(obj, key) {
  return { get: () => obj[key], set: (v) => { obj[key] = v; } };
}

export class Rack {
  /**
   * @param {object} opts
   *   now       — ms clock for session timestamps (default performance.now)
   *   storage   — { load(): object, save(object) } snapshot persistence
   *               (default in-memory; pass a localStorage adapter in a page)
   *   defaultRamp — ms glide for agent set() (default 400, matches faust rack)
   *   muteRamp  — ms ease of a voice's mask between rack and binding (default 400)
   */
  constructor({ now, storage, defaultRamp = 400, muteRamp = 400 } = {}) {
    this._now = now || (() => (globalThis.performance ?? Date).now());
    this._storage = storage || memoryStorage();
    this.defaultRamp = defaultRamp;
    this._muteRamp = muteRamp;
    this._params = new Map();   // path -> { meta, get, set }
    this._ramps = new Map();    // path -> { from, target, elapsed, ms, resolve }
    this._carry = new Map();    // path -> last value, survives rebuilds
    this._voices = new Map();   // path -> { binding, identity, shadow, mix, goal }
    this._soloPath = null;      // the one voice currently soloed, or null
    this._preSolo = null;       // path -> goal, the mute states solo interrupted
    this._handlers = {};        // extra command types
    this._session = [];
    this._sessionStart = this._now();
  }

  // ---- address space -------------------------------------------------------

  /**
   * Register a param. binding = { get, set } (see bindUniform/bindKey) plus
   * meta: { label, type = "knob", min, max, step, init, unit, voice }. If this
   * path was set before a rebuild, the previous value is re-applied (clamped) —
   * agents iterate on a scene without losing knob settings.
   *
   * VOICE (meta.voice = true | <number>): declares the param mutable/soloable.
   * `true` means the binding's identity is 0 (the additive/gain contribution
   * subtracts cleanly); a number gives an explicit identity. Voice is DECLARED,
   * never inferred from min===0 — a floor of zero that FREEZES rather than
   * removes is bone, not a voice. A voice's effective get/set are swapped for
   * shadow accessors: the rack reads/writes the LOGICAL value (shadow), while
   * the real binding receives  identity + (shadow − identity) · mix  whenever
   * shadow or mix moves. Mute only eases `mix`, so it is a mask, never a
   * destructive write: whatever arrives while muted is honored on unmute.
   */
  add(path, binding, meta = {}) {
    let get = binding.get, set = binding.set;
    const isVoice = meta.voice !== undefined && meta.voice !== false;
    if (isVoice) {
      const identity = meta.voice === true ? 0 : meta.voice;
      const prev = this._voices.get(path); // a plain re-add keeps the mask state
      const v = {
        binding, identity,
        shadow: prev ? prev.shadow : binding.get(),
        mix: prev?.mix ?? 1, goal: prev?.goal ?? 1,
      };
      this._voices.set(path, v);
      get = () => v.shadow;
      set = (x) => { v.shadow = x; this._applyVoice(v); };
      this._applyVoice(v); // seat the real binding under the current mask
    } else {
      this._voices.delete(path); // re-added as bone: drop any stale mask
    }
    const m = {
      path, label: meta.label ?? path.split("/").filter(Boolean).pop(),
      type: meta.type ?? "knob",
      min: meta.min, max: meta.max, step: meta.step,
      init: meta.init ?? get(), unit: meta.unit,
      voice: isVoice,
    };
    this._params.set(path, { meta: m, get, set });
    if (this._carry.has(path) && m.type !== "trigger") {
      set(clamp(this._carry.get(path), m.min, m.max));
    }
    return this;
  }

  /** Seat a voice's real binding under its current mask. */
  _applyVoice(v) {
    v.binding.set(v.identity + (v.shadow - v.identity) * v.mix);
  }

  /** Register every key of a values object under a prefix; channel specs
   * (journey channels: { min, max }) become ranges. */
  addValues(prefix, values, channels = {}) {
    for (const key in values) {
      this.add(`${prefix}/${key}`, bindKey(values, key), {
        min: channels[key]?.min, max: channels[key]?.max,
      });
    }
    return this;
  }

  remove(path) { this._cancelRamp(path); this._params.delete(path); this._voices.delete(path); }
  clear() { for (const p of [...this._params.keys()]) this.remove(p); }

  params() {
    return [...this._params.values()].map(({ meta, get }) =>
      ({ ...meta, value: get(), muted: this.muted(meta.path) }));
  }

  get(path) { return this._params.get(path)?.get(); }

  // ---- the command channel --------------------------------------------------

  /** Extend the vocabulary with a scene-specific command type. */
  handle(type, fn) { this._handlers[type] = fn; return this; }

  dispatch(cmd, source = "human", shouldRecord = true) {
    if (shouldRecord) {
      this._session.push({ t: Math.round(this._now() - this._sessionStart), source, cmd });
    }
    if (cmd.type === "set") return this._doSet(cmd.path, cmd.value, cmd.ramp ?? 0);
    if (cmd.type === "pulse") return this._doPulse(cmd.path, cmd.ms ?? 90);
    if (cmd.type === "mute") return this._doMute(cmd.path, cmd.on ?? true);
    if (cmd.type === "solo") return this._doSolo(cmd.path);
    const h = this._handlers[cmd.type];
    if (h) return h(cmd, source);
    throw new Error(`rack: unknown command type "${cmd.type}"`);
  }

  /** Glide a param over rampMs (linear, cancels an in-flight ramp on the same
   * path). Resolves with the clamped target once the ramp lands. */
  set(path, value, rampMs = this.defaultRamp, source = "agent") {
    return this.dispatch({ type: "set", path, value, ramp: rampMs }, source);
  }

  /** Momentary: param to max, hold ms, back to min. */
  pulse(path, ms = 90, source = "agent") {
    return this.dispatch({ type: "pulse", path, ms }, source);
  }

  // ---- the mute bus: subtraction as a mask, never a destructive write --------
  // Mute eases a voice's `mix` toward 0 (in update over muteRamp ms), masking
  // the binding to its identity while the rack keeps ramping the logical value.
  // These flow through the recorded channel like set/pulse, so a session replays
  // its mutes and solos too.

  /** Mask a voice toward its identity (on) or back to its logical value (off). */
  mute(path, on = true, source = "human") {
    return this.dispatch({ type: "mute", path, on }, source);
  }

  /** Solo a voice: mute every OTHER voice, keep this one. Pressing the same
   * path again restores the mute states solo interrupted; a different path
   * re-targets. Returns the soloed path, or null once solo is released. */
  solo(path, source = "human") {
    return this.dispatch({ type: "solo", path }, source);
  }

  /** Is this voice masked (goal toward identity)? Non-voices are never muted. */
  muted(path) { return (this._voices.get(path)?.goal ?? 1) < 0.5; }

  /** The path currently soloed, or null. */
  soloed() { return this._soloPath; }

  /** Every declared voice path. */
  voices() { return [...this._voices.keys()]; }

  _doMute(path, on = true) {
    const v = this._voices.get(path);
    if (!v) return false; // bone / unknown: nothing to mask, no-op
    v.goal = on ? 0 : 1;
    this._soloPath = null; this._preSolo = null; // a hand-set mute owns the bus
    return this.muted(path);
  }

  _doSolo(path) {
    if (!this._voices.has(path)) return null;
    if (this._soloPath === path) { // release: restore what solo interrupted
      for (const [p, g] of this._preSolo) { const v = this._voices.get(p); if (v) v.goal = g; }
      this._soloPath = null; this._preSolo = null;
      return null;
    }
    if (!this._preSolo) // remember the pre-solo state only on the first solo
      this._preSolo = new Map([...this._voices].map(([p, v]) => [p, v.goal]));
    for (const [p, v] of this._voices) v.goal = p === path ? 1 : 0;
    this._soloPath = path;
    return path;
  }

  _doSet(path, value, rampMs) {
    const p = this._params.get(path);
    if (!p) return Promise.reject(new Error(`rack: unknown param "${path}"`));
    const target = clamp(value, p.meta.min, p.meta.max);
    this._cancelRamp(path);
    this._carry.set(path, target);
    if (!rampMs || rampMs <= 16) {
      p.set(target);
      return Promise.resolve(target);
    }
    return new Promise((resolve) => {
      this._ramps.set(path, { from: p.get(), target, elapsed: 0, ms: rampMs, resolve });
    });
  }

  _doPulse(path, ms) {
    const p = this._params.get(path);
    if (!p) return Promise.reject(new Error(`rack: unknown param "${path}"`));
    p.set(p.meta.max ?? 1);
    return new Promise((resolve) => setTimeout(() => {
      p.set(p.meta.min ?? 0);
      resolve();
    }, ms));
  }

  _cancelRamp(path) {
    const r = this._ramps.get(path);
    if (r) { this._ramps.delete(path); r.resolve(this._params.get(path)?.get()); }
  }

  /** Advance ramps from the host loop. dt in SECONDS (lib3 convention). */
  update(dt) {
    for (const [path, r] of [...this._ramps]) {
      const p = this._params.get(path);
      if (!p) { this._ramps.delete(path); r.resolve(undefined); continue; }
      r.elapsed += dt * 1000;
      const k = Math.min(1, r.elapsed / r.ms);
      p.set(r.from + (r.target - r.from) * k);
      if (k >= 1) { this._ramps.delete(path); r.resolve(r.target); }
    }
    // ease each voice's mask toward its goal, reapplying it as it moves
    const step = (dt * 1000) / this._muteRamp;
    for (const v of this._voices.values()) {
      if (v.mix === v.goal) continue;
      v.mix = v.goal > v.mix
        ? Math.min(v.goal, v.mix + step)
        : Math.max(v.goal, v.mix - step);
      this._applyVoice(v);
    }
  }

  // ---- sessions: the time-based recording ------------------------------------

  session() { return structuredClone(this._session); }
  clearSession() { this._session = []; this._sessionStart = this._now(); }

  /** Time-accurate replay of a recorded session. Ramps scale with speed
   * (a 2x replay glides 2x faster). Replayed commands are NOT re-recorded. */
  async replay(session, speed = 1) {
    const t0 = this._now();
    for (const entry of session) {
      const wait = entry.t / speed - (this._now() - t0);
      if (wait > 0) await new Promise((res) => setTimeout(res, wait));
      const cmd = speed !== 1 && entry.cmd.type === "set" && entry.cmd.ramp
        ? { ...entry.cmd, ramp: entry.cmd.ramp / speed }
        : entry.cmd;
      this.dispatch(cmd, "replay", false);
    }
  }

  // ---- snapshots: the unit of keeping ----------------------------------------

  /** Save the rack as it is right now: { name, created, params: {path: value} }. */
  snap(name) {
    const all = this._storage.load();
    name = name || `snap-${Object.keys(all).length + 1}`;
    const params = {};
    for (const [path, p] of this._params) params[path] = p.get();
    const snapshot = { name, created: new Date().toISOString(), params };
    all[name] = snapshot;
    this._storage.save(all);
    return { name, params: Object.keys(params).length };
  }

  /** Restore a snapshot — params glide in (120 ms, as the faust rack does). */
  async apply(name, rampMs = 120) {
    const snapshot = this._storage.load()[name];
    if (!snapshot) throw new Error(`rack: no snapshot "${name}"`);
    const settles = [];
    for (const [path, value] of Object.entries(snapshot.params)) {
      if (this._params.has(path)) {
        settles.push(this.dispatch({ type: "set", path, value, ramp: rampMs }, "snap"));
      }
    }
    await Promise.all(settles);
    return { name, params: Object.keys(snapshot.params).length };
  }

  snaps() {
    return Object.values(this._storage.load()).map((s) => ({
      name: s.name, created: s.created, params: Object.keys(s.params).length,
    }));
  }

  snapshot(name) { return this._storage.load()[name] ?? null; }
  dropSnap(name) {
    const all = this._storage.load();
    delete all[name];
    this._storage.save(all);
  }

  /**
   * Reconstruct the configuration at `seconds` into a recorded session and
   * keep it as a snapshot — time as an address for extraction. Mid-ramp
   * moments interpolate linearly, exactly as they played.
   */
  lift(session, seconds, name) {
    const tMs = seconds * 1000;
    const params = {};
    for (const { t, cmd } of session) {
      if (t > tMs || cmd.type !== "set") continue;
      const ramp = cmd.ramp ?? 0;
      if (!ramp || t + ramp <= tMs) { params[cmd.path] = cmd.value; continue; }
      const from = params[cmd.path] ?? this._params.get(cmd.path)?.meta.init ?? 0;
      params[cmd.path] = from + (cmd.value - from) * ((tMs - t) / ramp);
    }
    const all = this._storage.load();
    name = name || `lift-${seconds}s`;
    all[name] = {
      name, created: new Date().toISOString(),
      lifted: { seconds }, params,
    };
    this._storage.save(all);
    return { name, params: Object.keys(params).length };
  }
}

function memoryStorage() {
  let data = {};
  return { load: () => structuredClone(data), save: (d) => { data = structuredClone(d); } };
}

/**
 * Connect a page's rack to the bridge relay (scripts/rack-bridge.mjs), so a
 * terminal agent drives the LIVE page through scripts/rackctl.mjs — same
 * recorded channel as the on-page UI. Retries forever; call once at startup
 * (examples gate it behind ?bridge).
 */
export function connectRackBridge(rack, url = "ws://127.0.0.1:5175") {
  let wasConnected = false;
  function connect() {
    let sock;
    try {
      sock = new WebSocket(url);
    } catch {
      setTimeout(connect, 2000);
      return;
    }
    sock.addEventListener("open", () => {
      sock.send(JSON.stringify({ role: "rack" }));
      wasConnected = true;
      console.log("[rack] bridge connected");
    });
    sock.addEventListener("message", async (event) => {
      const msg = JSON.parse(event.data);
      const reply = { id: msg.id };
      try {
        const fn = rack[msg.method];
        if (typeof fn !== "function") throw new Error(`unknown rack method: ${msg.method}`);
        reply.ok = true;
        reply.result = (await fn.apply(rack, msg.args ?? [])) ?? null;
      } catch (error) {
        reply.ok = false;
        reply.error = error.message;
      }
      if (sock.readyState === 1) sock.send(JSON.stringify(reply));
    });
    sock.addEventListener("close", () => {
      if (wasConnected) console.log("[rack] bridge disconnected — retrying");
      wasConnected = false;
      setTimeout(connect, 2000);
    });
  }
  connect();
}

/** Snapshot persistence in a browser page. */
export function localStorageAdapter(key = "lib3RackSnaps") {
  return {
    load: () => { try { return JSON.parse(localStorage.getItem(key)) || {}; } catch { return {}; } },
    save: (d) => localStorage.setItem(key, JSON.stringify(d)),
  };
}
