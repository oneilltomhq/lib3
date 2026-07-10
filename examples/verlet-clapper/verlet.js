// examples/verlet-clapper/verlet.js
// The one verlet file. A soft rod as position-based dynamics: points carry
// implicit velocity in the gap between `pos` and `prev`; constraints do all
// the material work.
//
//   anchor (driven from outside, invMass 0)
//     ● — ● — ● — ● — ● — ●●● (tip, heavy)
//
// Two constraint families:
//   distance (i, i+1)  rest = seg          k = 1     the rod's length. Never soft.
//   bending  (i, i+2)  rest = 2·seg        k = bend  the material. Weak = whip,
//                                                     strong = stiff rod with flex.
// The bend constraint is just "stay far from your second neighbour" — a folded
// joint pulls i and i+2 close, the constraint pushes them apart, the rod
// straightens. Its strength is dial #1. Solver `iterations` is dial #2: each
// pass re-applies every constraint, so more passes = stiffer, snappier.
//
// Mass enters ONLY through constraint weighting (invMass): a heavy point
// concedes less per relax, so the light shaft wraps around it. That asymmetry
// is the whole bell-clapper feel — and the slingshot: reverse the anchor, the
// shaft bends and stores spring energy in violated bend constraints, then
// unloads through the tip.
//
// `taper` is the crack amplifier (dynamics-notebook study 5): a wave carrying
// ½mv² into lighter segments must speed up, v ∝ 1/√m, so a handle→tip mass
// taper multiplies tip speed by ~√(1/taper). A whip is taper ≪ 1 with a light
// tip; a clapper is taper = 1 with a heavy tip. A heavy tip on a uniform
// shaft can never crack — it asks the amplifier to run backwards.
//
// No engine. Rigid-body engines (Rapier, cannon) model soft rods as jointed
// rigid chains — stiff joint stacks that fight the solver. Fifteen verlet
// points and two constraint loops do it better, in a page.

import { Vector3 } from "three/webgpu";

const _d = new Vector3();

export class VerletChain {
  constructor({
    points = 12,
    length = 1.7,
    tipMass = 8,
    taper = 1, // tip/handle mass ratio, geometric along the chain
    bend = 0.5,
    iterations = 14,
    drag = 0.995, // velocity kept per step (verlet damping)
    gravity = 1.2,
  } = {}) {
    this.points = points;
    this.length = length;
    this.tipMass = tipMass;
    this.taper = taper;
    this.bend = bend;
    this.iterations = iterations;
    this.drag = drag;
    this.gravity = gravity;
    this.anchor = new Vector3();
    this.rebuild();
  }

  // (re)hang the chain straight down from the anchor
  rebuild() {
    const n = Math.max(3, this.points | 0);
    this.points = n;
    this.seg = this.length / (n - 1);
    this.pos = [];
    this.prev = [];
    this.invMass = [];
    for (let i = 0; i < n; i++) {
      const p = new Vector3(this.anchor.x, this.anchor.y - this.seg * i, this.anchor.z);
      this.pos.push(p);
      this.prev.push(p.clone());
      // 0 = pinned: the anchor never concedes; the rest taper geometrically
      this.invMass.push(i === 0 ? 0 : 1 / Math.pow(this.taper, i / (n - 1)));
    }
    this.setTipMass(this.tipMass);
  }

  // extra mass on the last point, ON TOP of the taper: the clapper ball
  setTipMass(m) {
    this.tipMass = m;
    this.invMass[this.points - 1] = 1 / Math.max(1e-3, m * this.taper);
  }

  setTaper(t) {
    this.taper = t;
    const n = this.points;
    for (let i = 1; i < n; i++) this.invMass[i] = 1 / Math.pow(t, i / (n - 1));
    this.setTipMass(this.tipMass);
  }

  tip() {
    return this.pos[this.points - 1];
  }

  // one fixed-h step: integrate, pin, relax
  step(h) {
    const g = this.gravity * h * h;
    for (let i = 1; i < this.points; i++) {
      const p = this.pos[i];
      const q = this.prev[i];
      // verlet: next = p + (p - prev)·drag + a·h²
      const nx = p.x + (p.x - q.x) * this.drag;
      const ny = p.y + (p.y - q.y) * this.drag - g;
      const nz = p.z + (p.z - q.z) * this.drag;
      q.copy(p);
      p.set(nx, ny, nz);
    }
    this.pos[0].copy(this.anchor);
    this.prev[0].copy(this.anchor);

    const seg2 = this.seg * 2;
    for (let it = 0; it < this.iterations; it++) {
      for (let i = 0; i < this.points - 1; i++) this.relax(i, i + 1, this.seg, 1);
      for (let i = 0; i < this.points - 2; i++) this.relax(i, i + 2, seg2, this.bend);
    }
  }

  // move a pair toward rest distance, split by inverse mass
  relax(i, j, rest, k) {
    const wi = this.invMass[i];
    const wj = this.invMass[j];
    const w = wi + wj;
    if (w === 0 || k === 0) return;
    const a = this.pos[i];
    const b = this.pos[j];
    _d.subVectors(b, a);
    const dist = _d.length() || 1e-9;
    const s = ((dist - rest) / dist) * (k / w);
    a.addScaledVector(_d, s * wi);
    b.addScaledVector(_d, -s * wj);
  }

  // stored bend energy at interior joint i, 0 straight → 1 folded flat.
  // |p[i+1] - p[i-1]| = 2·seg when straight; the shortfall IS the violated
  // bend constraint — the spring the slingshot unloads from.
  bendEnergy(i) {
    if (i < 1 || i > this.points - 2) return 0;
    const d = this.pos[i + 1].distanceTo(this.pos[i - 1]);
    const e = 1 - d / (this.seg * 2);
    return e < 0 ? 0 : e > 1 ? 1 : e;
  }
}

// Finite-difference derivatives of the tip, fed at the fixed sim rate.
// vel drives the flubber smear, |accel| is the discharge trigger, jerk is
// there for anyone who wants an even twitchier signal. Raw derivatives of a
// constraint-solved point are spiky, so magnitudes are EMA-smoothed.
export class TipProbe {
  constructor({ smooth = 24 } = {}) {
    this.smooth = smooth; // EMA cutoff, 1/s
    this.vel = new Vector3(); // smoothed velocity vector
    this.accMag = 0;
    this.jerkMag = 0;
    this._p = new Vector3();
    this._v = new Vector3();
    this._a = new Vector3();
    this._vRaw = new Vector3();
    this._aRaw = new Vector3();
    this._primed = 0;
  }

  reset(p) {
    this._p.copy(p);
    this.vel.set(0, 0, 0);
    this.accMag = this.jerkMag = 0;
    this._primed = 0;
  }

  feed(p, h) {
    this._vRaw.subVectors(p, this._p).divideScalar(h);
    this._aRaw.subVectors(this._vRaw, this._v).divideScalar(h);
    const jerk = this._aRaw.distanceTo(this._a) / h;

    const k = 1 - Math.exp(-this.smooth * h);
    if (this._primed >= 2) {
      this.vel.lerp(this._vRaw, k);
      this.accMag += (this._aRaw.length() - this.accMag) * k;
      this.jerkMag += (jerk - this.jerkMag) * k;
    } else this._primed++; // first two feeds have garbage derivatives

    this._p.copy(p);
    this._v.copy(this._vRaw);
    this._a.copy(this._aRaw);
  }
}
