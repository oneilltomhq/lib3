// Swappable techniques for the motion-score playground. Each slot is one
// decomposed "move" of the phrase choreography; a recipe picks one technique
// per slot. Techniques share a context (ctx) built by the host:
//   { T, state, wells, pos, vel, N, mass, bary, drive, conductor }
// and may keep transient per-fire state on state.fx (host clears on switch).
//
// The crash grammar that separates "impact" from "jank": sharp attack (one
// frame), coherent debris direction (radial / reflected / tangential — never
// random), and persistence (consequence keeps moving after the hit).

const lcg = (seed) => {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
};

// mean radius of the swarm from the barycentre — used to size shells/blasts
function clusterRadius(ctx) {
  const { pos, N, bary } = ctx;
  let sum = 0;
  for (let i = 0; i < N; i++) {
    const dx = pos[i * 3] - bary.x, dy = pos[i * 3 + 1] - bary.y, dz = pos[i * 3 + 2] - bary.z;
    sum += Math.sqrt(dx * dx + dy * dy + dz * dz);
  }
  return sum / N;
}

// ---- crash slot: what the stored phrase energy converts INTO -------------------------

export const crashes = {
  // Baseline (the original): incoherent spray + drive cut. Energy deleted,
  // not transferred — kept as the control specimen for comparison.
  spray: {
    label: "spray (control)",
    uses: ["crashKick", "scatterBase", "scatterGain"],
    fire(ctx, e) {
      const { T, vel, N, drive } = ctx;
      drive.kick(-T.crashKick);
      const imp = T.scatterBase + T.scatterGain * e;
      const rnd = lcg(987654321);
      for (let i = 0; i < N; i++) {
        const az = rnd() * Math.PI * 2;
        const el = (rnd() - 0.5) * Math.PI * 0.7;
        const m = imp * (0.35 + rnd() * 0.65);
        vel[i * 3] += Math.cos(az) * Math.cos(el) * m;
        vel[i * 3 + 1] += Math.sin(az) * Math.cos(el) * m;
        vel[i * 3 + 2] += Math.sin(el) * m * 0.6;
      }
    },
  },

  // Blast front: radial impulse from the barycentre, magnitude falling with
  // distance. Coherent direction is what makes it read as an impact.
  shockwave: {
    label: "shockwave",
    uses: ["crashKick", "scatterBase", "scatterGain"],
    fire(ctx, e) {
      const { T, pos, vel, N, bary, drive } = ctx;
      drive.kick(-T.crashKick * 0.25); // a flinch, not a stall
      const imp = (T.scatterBase + T.scatterGain * e) * 1.6;
      const rnd = lcg(24681357);
      for (let i = 0; i < N; i++) {
        const ix = i * 3;
        const dx = pos[ix] - bary.x, dy = pos[ix + 1] - bary.y, dz = pos[ix + 2] - bary.z;
        const d = Math.sqrt(dx * dx + dy * dy + dz * dz) + 1e-4;
        const m = (imp * (0.7 + rnd() * 0.3)) / (1 + d * d * 0.35);
        vel[ix] += (dx / d) * m;
        vel[ix + 1] += (dy / d) * m;
        vel[ix + 2] += (dz / d) * m * 0.6;
      }
    },
  },

  // The force that held you throws you: partner wells flip repulsive for a
  // beat, scaled by the ledger, then re-grip and gather the debris.
  repulse: {
    label: "repulse flip",
    uses: [], // scales off the ledger only — crashKick/scatter knobs are inert here
    fire(ctx, e) {
      ctx.state.fx.repulse = { time: 0.45, e };
    },
    frame(ctx, dt) {
      const fx = ctx.state.fx.repulse;
      if (!fx || fx.time <= 0) return;
      fx.time -= dt;
      // Needs to be brutal: 1/d² falls off fast at cloud distances, and the
      // flipped g also reverses the spin torque (which reads as the orbit
      // violently unwinding — part of the throw).
      const k = -(4 + 6 * fx.e);
      ctx.wells[0].g *= k;
      ctx.wells[1].g *= k;
    },
  },

  // Containment: an outward slam into a hard shell; radial velocity reflects
  // with restitution, tangential survives — debris keeps its speed, redirected.
  wall: {
    label: "wall",
    uses: ["crashKick", "scatterBase", "scatterGain"], // via the shockwave it rides on
    fire(ctx, e) {
      crashes.shockwave.fire(ctx, e * 0.8); // send them flying first
      ctx.state.fx.shell = {
        time: 1.3,
        r: Math.max(1.7, clusterRadius(ctx) * 1.25),
        rest: 0.75,
      };
    },
    frame(ctx, dt) {
      const fx = ctx.state.fx.shell;
      if (!fx || fx.time <= 0) return;
      fx.time -= dt;
      const { pos, vel, N, bary } = ctx;
      for (let i = 0; i < N; i++) {
        const ix = i * 3;
        const dx = pos[ix] - bary.x, dy = pos[ix + 1] - bary.y, dz = pos[ix + 2] - bary.z;
        const d = Math.sqrt(dx * dx + dy * dy + dz * dz) + 1e-6;
        if (d < fx.r) continue;
        const nx = dx / d, ny = dy / d, nz = dz / d;
        const vr = vel[ix] * nx + vel[ix + 1] * ny + vel[ix + 2] * nz;
        if (vr > 0) { // moving outward: reflect the radial component
          const j = (1 + fx.rest) * vr;
          vel[ix] -= j * nx; vel[ix + 1] -= j * ny; vel[ix + 2] -= j * nz;
        }
        const push = d - fx.r; // and keep them inside the shell
        pos[ix] -= nx * push; pos[ix + 1] -= ny * push; pos[ix + 2] -= nz * push;
      }
    },
  },

  // The slap ADDS force: drive kicks UP, plus a coherent tangential whip —
  // the whole room surges around the orbit instead of dying.
  surge: {
    label: "surge",
    uses: ["crashKick", "scatterBase", "scatterGain"],
    fire(ctx, e) {
      const { T, pos, vel, N, bary, drive } = ctx;
      drive.kick(T.crashKick * 0.7); // up, not down
      const imp = (T.scatterBase + T.scatterGain * e) * 0.9;
      // whip WITH the swarm's angular momentum — against it, the impulse
      // cancels the orbit and reads as a stall instead of a surge
      let lz = 0;
      for (let i = 0; i < N; i++) {
        const ix = i * 3;
        lz += (pos[ix] - bary.x) * vel[ix + 1] - (pos[ix + 1] - bary.y) * vel[ix];
      }
      const dir = Math.sign(lz) || 1;
      const rnd = lcg(1357911);
      for (let i = 0; i < N; i++) {
        const ix = i * 3;
        const dx = pos[ix] - bary.x, dy = pos[ix + 1] - bary.y;
        const d = Math.sqrt(dx * dx + dy * dy) + 1e-4;
        const m = imp * (0.6 + rnd() * 0.4) * dir;
        // z × r = (-dy, dx, 0), signed by current spin sense
        vel[ix] += (-dy / d) * m;
        vel[ix + 1] += (dx / d) * m;
        vel[ix + 2] += (rnd() - 0.5) * m * 0.25;
      }
    },
  },
};

// ---- recover slot: what happens to the consequence ------------------------------------

export const recovers = {
  // Heavy mop-up (the original): damping spikes and soaks the debris fast.
  mop: {
    label: "mop (control)",
    uses: ["crashDamp", "crashDampTime", "damp"],
    dampTarget(ctx) {
      return ctx.state.crashTimer > 0 ? ctx.T.crashDamp : ctx.T.damp;
    },
  },
  // Consequence persists: cruise damping throughout, the debris rides out.
  ride: {
    label: "ride",
    uses: ["damp"],
    dampTarget(ctx) {
      return ctx.T.damp;
    },
  },
};

export const slots = { crash: crashes, recover: recovers };

// one-liners the panel shows under each slot's buttons
export const slotHints = {
  crash: "what the stored phrase energy converts into at the head",
  recover: "damping after the hit — mop soaks debris fast, ride lets it run",
};
