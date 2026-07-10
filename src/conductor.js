// Musical time for parameter motion. One root clock (bpm) that every piece
// hangs off; euclidean voices give each piece its own hit pattern at a ratio
// of the same root, so separate pieces land in rhythmic harmony by
// construction. Hits carry accents; springs turn hits into physics — a beat
// KICKS a parameter and the spring settles, instead of the parameter
// teleporting. Phrase position (0→1 over barsPerPhrase) is the slow arc:
// tension builds through the phrase and releases at the head.
//
// Composer surface stays small: bpm, swing, and per-voice (steps, hits,
// rotate, bars). Everything else is the piece's own mapping of hit → physics.

/**
 * K hits spread as evenly as possible over `steps` steps (Bjorklund /
 * Bresenham construction). euclideanPattern(8, 3) → hits on 0, 3, 6: the
 * tresillo. `rotate` shifts the pattern right.
 * @returns {boolean[]}
 */
export function euclideanPattern(steps, hits, rotate = 0) {
  const pattern = [];
  for (let i = 0; i < steps; i++) {
    const j = (((i - rotate) % steps) + steps) % steps;
    pattern.push((j * hits) % steps < hits);
  }
  return pattern;
}

/**
 * Damped spring. `kick(impulse)` adds velocity (a drum hit); `target` pulls
 * (a held note). zeta < 1 overshoots and rings — the "physical" in physical.
 */
export class Spring {
  constructor({ value = 0, target, freq = 2.5, zeta = 0.4 } = {}) {
    this.value = value;
    this.target = target ?? value;
    this.velocity = 0;
    this.freq = freq; // oscillations per second when undamped
    this.zeta = zeta; // damping ratio: <1 rings, 1 critical, >1 sluggish
  }

  kick(impulse) {
    this.velocity += impulse;
    return this;
  }

  update(dt) {
    // semi-implicit Euler, substepped so big dt (tab-back) can't explode
    const w = 2 * Math.PI * this.freq;
    let remaining = Math.min(dt, 0.25);
    while (remaining > 0) {
      const h = Math.min(remaining, 1 / 120);
      this.velocity +=
        (-w * w * (this.value - this.target) - 2 * this.zeta * w * this.velocity) *
        h;
      this.value += this.velocity * h;
      remaining -= h;
    }
    return this.value;
  }
}

/**
 * Motion-profiled approach: value moves toward `target` at a capped rate,
 * with velocity changes capped by `maxAccel` — a trapezoidal S-curve that
 * accelerates, cruises, and brakes to arrive without overshoot. This is the
 * "expensive motion" primitive: where Spring rings, Slew glides. Leave
 * maxAccel at Infinity for a pure rate limiter.
 */
export class Slew {
  constructor({ value = 0, target, maxRate = 1, maxAccel = Infinity } = {}) {
    this.value = value;
    this.target = target ?? value;
    this.velocity = 0;
    this.maxRate = maxRate; // units per second
    this.maxAccel = maxAccel; // units per second²
  }

  update(dt) {
    // substepped like Spring so big dt (tab-back) can't tunnel past target
    let remaining = Math.min(dt, 0.25);
    while (remaining > 0) {
      const h = Math.min(remaining, 1 / 120);
      const err = this.target - this.value;
      const cap = this.maxAccel * h; // velocity budget per substep
      // fastest speed that can still brake to a stop at target, in discrete
      // steps of -cap per substep (continuous sqrt(2a|err|) overshoots).
      // Budget from the err left AFTER this substep's travel — entering the
      // brake curve mid-step from cruise otherwise lands a hair long.
      const lead = Math.max(Math.abs(err) - Math.abs(this.velocity) * h, 0);
      const brake = Number.isFinite(cap)
        ? Math.sqrt((cap * cap) / 4 + 2 * this.maxAccel * lead) - cap / 2
        : Infinity;
      const want =
        Math.sign(err) * Math.min(this.maxRate, brake, Math.abs(err) / h);
      this.velocity += Math.max(-cap, Math.min(cap, want - this.velocity));
      this.value += this.velocity * h;
      remaining -= h;
    }
    return this.value;
  }
}

export class Conductor {
  constructor({ bpm = 96, swing = 0, beatsPerBar = 4, barsPerPhrase = 4 } = {}) {
    this.bpm = bpm;
    this.swing = swing; // 0..~0.6: how late every off-step lands
    this.beatsPerBar = beatsPerBar;
    this.barsPerPhrase = barsPerPhrase;
    // Just below 0 so step 0 fires on the first update. Phase getters clamp
    // to 0 so this never reads as "end of phrase" before the clock starts.
    this.beat = -1e-6;
    this._voices = [];
    this._phraseSubs = [];
  }

  /**
   * fn({ phrase, beat }) fires as the clock crosses each phrase head, before
   * that frame's voice hits. The t=0 head is skipped — nothing has built yet,
   * so a release there is always spurious. Returns an unsubscribe function.
   */
  onPhrase(fn) {
    this._phraseSubs.push(fn);
    return () => {
      const i = this._phraseSubs.indexOf(fn);
      if (i >= 0) this._phraseSubs.splice(i, 1);
    };
  }

  /**
   * Register a voice: `hits` spread over `steps` spanning `bars` bars.
   * onHit({ step, accent, phrase01, beat }) fires as the clock crosses each
   * scheduled (swung) step. Pattern heads (step 0) are accented. `window:
   * [a, b]` (phrase01 span, inclusive; a > b wraps past the head) gates hits
   * to a slice of the phrase — "shifts only during the build". Returns a
   * handle whose `set(patch)` re-shapes the pattern live (instrument panels);
   * bpm, swing, and window are read at fire time, so they're live for free.
   */
  voice({ steps = 16, hits = 4, rotate = 0, bars = 1, accent = 1, window = null, onHit }) {
    const v = {
      steps,
      hits,
      rotate,
      bars,
      accent,
      window,
      onHit,
      pattern: euclideanPattern(steps, hits, rotate),
      set(patch) {
        Object.assign(v, patch);
        v.hits = Math.min(v.hits, v.steps);
        v.pattern = euclideanPattern(v.steps, v.hits, v.rotate);
      },
    };
    this._voices.push(v);
    return v;
  }

  /**
   * Four-on-the-floor kick envelope, sampled continuously: 1.0 exactly on
   * every beat, exponential decay toward 0 before the next (sidechain pump).
   * Multiply brightness/size/intensity by `1 - depth + depth * pump()` and
   * the whole room ducks in sync. Straight time — swing never touches it.
   */
  pump(sharpness = 5) {
    // clamp: pre-roll beat reads as "on the beat", not end-of-cycle. The
    // +1 %1 double mod also float-snaps a hair-under-integer beat to 0.
    const b = ((Math.max(this.beat, 0) % 1) + 1) % 1;
    return Math.exp(-sharpness * b);
  }

  /** Beats in one phrase. */
  get phraseBeats() {
    return this.beatsPerBar * this.barsPerPhrase;
  }

  /** Seconds in one phrase at the current bpm — the energy-ledger unit. */
  get phraseSeconds() {
    return (this.phraseBeats * 60) / this.bpm;
  }

  /** 0→1 through the current phrase; snaps to 0 at each phrase head. */
  get phrase01() {
    const span = this.phraseBeats;
    return (((Math.max(this.beat, 0) % span) + span) % span) / span;
  }

  /** 0→1 through the current bar. */
  get bar01() {
    const span = this.beatsPerBar;
    return (((Math.max(this.beat, 0) % span) + span) % span) / span;
  }

  update(dt) {
    const prev = this.beat;
    this.beat += (dt * this.bpm) / 60;
    const pspan = this.phraseBeats;
    // phrase heads crossed this frame (t=0 head excluded), before voice hits
    const lastHead = Math.floor(this.beat / pspan);
    for (let n = Math.max(Math.floor(prev / pspan) + 1, 1); n <= lastHead; n++) {
      for (const fn of this._phraseSubs) fn({ phrase: n, beat: n * pspan });
    }
    for (const v of this._voices) {
      const span = v.bars * this.beatsPerBar;
      const first = Math.floor(prev / span);
      const last = Math.floor(this.beat / span);
      for (let c = first; c <= last; c++) {
        for (let i = 0; i < v.steps; i++) {
          if (!v.pattern[i]) continue;
          const late = i % 2 === 1 ? (this.swing * span) / v.steps / 2 : 0;
          const t = c * span + (i / v.steps) * span + late;
          if (t > prev && t <= this.beat) {
            if (v.window) {
              const p = (((t % pspan) + pspan) % pspan) / pspan;
              const [a, b] = v.window;
              if (a <= b ? p < a || p > b : p < a && p > b) continue;
            }
            v.onHit({
              step: i,
              accent: (i === 0 ? 1 : 0.6) * v.accent,
              phrase01: this.phrase01,
              beat: this.beat,
            });
          }
        }
      }
    }
  }
}
