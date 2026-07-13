// ---- the sling: two tips, one band, stirred forever ----------------------
// The whole choreography is one perpetual mechanism. Two free tips ride an
// elastic band that can only PULL — the e2-slack law, s < 0 ⇒ T = 0 — while
// a slow circling push (the stir, a hand whirling the sling) feeds the spin
// that drag bleeds away. When the band goes taut it yanks the pair in, the
// whirl tightens and WHIPS; when the stir falls out of step with the orbit
// it fights it, the ellipse breathes, and the pattern never settles. The
// blob's gravity wells ARE the tips.
//
// Host-agnostic: Vector3 + Math only, so the dynamics can be stepped
// headlessly — the code that runs the demo is the code the probes pin.
// Ported near-verbatim from oneilltom.com/src/sling.js (contracts already
// swept there; the mechanism is byte-identical).
import { Vector3 } from "three/webgpu";
import { bindKey } from "../../src/rack.js";
import { createGraph } from "../../src/circuit/graph.js";

export function createSling({ wells, rack }) {
  // the few chosen parameters — everything else is committed
  const P = {
    rest: 0.6,   // band slack length (orbit scale)
    stiff: 5.0,  // band stiffness (whip snap)
    spin: 1.8,   // stir strength (energy in)
    rate: 1.2,   // stir tempo, rad/s — the whirl locks to it
    squash: 1.0, // stir ellipse: 0 = round (calm circle) → 1 = a flat
                 // shake (the orbit is forced eccentric and WHIPS)
    drag: 0.4,   // per-second bleed (energy out)
    grav: 1.0,   // the tips' pull on the particle mass (scales gm)
  };
  const M = [1.5, 0.75]; // tip masses — the light tip whips the wide arc
  const GM = [1.8, 1.1]; // per-tip gravity temperament (× P.grav)
  // swirl kept faint: the whipping tips stir the mass plenty — any more
  // and the particles centrifuge into a donut around the pair
  const SM = [0.25, 0.4];
  const CENT = 0.8; // both tips feel the same anchor pull — no torque
  const VMAX = 2.4; // soft governor on tip speed (continuity budget)

  const graph = createGraph();
  const anchor = new Vector3();
  graph.vec("anchor", anchor, {
    label: "anchor", caption: "the slow wander the pair rides",
  });
  const nStir = graph.tap("stir", {
    label: "stir", caption: "a circling push — in step it feeds the whirl, out of step it fights it",
    min: -1, max: 1, knobs: ["/sling/spin", "/sling/rate", "/sling/squash"],
  });
  const nStretch = graph.tap("stretch", {
    label: "stretch", caption: "how far past slack length",
    min: -1, max: 2, unit: "u", knobs: ["/sling/rest"],
    inputs: [{ from: "tip.a" }, { from: "tip.b" }],
  });
  const nTension = graph.tap("tension", {
    label: "tension", caption: "the yank back — a band can’t push",
    min: 0, max: 8, knobs: ["/sling/stiff"],
    inputs: [{ from: "stretch" }],
  });
  const nOmega = graph.tap("omega", {
    label: "whirl", caption: "yanked tight, it whips — drag bleeds it",
    min: 0, max: 8, unit: "rad/s", knobs: ["/sling/drag"],
    inputs: [{ from: "tip.a" }, { from: "tip.b" }],
  });
  graph.vec("tip.a", wells[0].p, {
    label: "tip A", caption: "the heavy end — the mass rides it",
    knobs: ["/sling/grav"],
    inputs: [{ from: "anchor" }, { from: "stir" }, { from: "tension" }],
  });
  graph.vec("tip.b", wells[1].p, {
    label: "tip B", caption: "the light end — it does the whipping",
    inputs: [{ from: "anchor" }, { from: "stir" }, { from: "tension" }],
  });
  if (rack) {
    // ranges carried over from the site's swept contracts (same mechanism)
    rack.add("/sling/rest", bindKey(P, "rest"), { min: 0.2, max: 1.4, unit: "u" });
    rack.add("/sling/stiff", bindKey(P, "stiff"), { min: 0.5, max: 10 });
    rack.add("/sling/spin", bindKey(P, "spin"), { min: 0, max: 3 });
    rack.add("/sling/rate", bindKey(P, "rate"), { min: 0.1, max: 3, unit: "rad/s" });
    rack.add("/sling/squash", bindKey(P, "squash"), { min: 0, max: 1 });
    rack.add("/sling/drag", bindKey(P, "drag"), { min: 0.05, max: 2, unit: "/s" });
    rack.add("/sling/grav", bindKey(P, "grav"), { min: 0, max: 3 });
  }

  const A = wells[0].p, B = wells[1].p;
  const vel = [new Vector3(), new Vector3()];
  const d = new Vector3(), u = new Vector3(), n = new Vector3();
  const p1 = new Vector3(), p2 = new Vector3(), e = new Vector3();
  const tdir = new Vector3(), com = new Vector3(), pull = new Vector3();
  const vrel = new Vector3(), lcross = new Vector3();
  const yAxis = new Vector3(0, 1, 0);

  const setAnchor = (t) => anchor.set(
    1.0 + 0.30 * Math.sin(0.11 * t + 1.2),
    0.28 * Math.sin(0.07 * t + 0.5),
    0.3 + 0.22 * Math.sin(0.09 * t + 2.0));

  // start: tips astride the anchor with a gentle opposite flick, so the
  // stir has something to grab (deterministic — no Math.random anywhere)
  setAnchor(0);
  A.copy(anchor).add(new Vector3(-0.30, 0.05, 0));
  B.copy(anchor).add(new Vector3(0.60, -0.10, 0));
  vel[0].set(0, -0.35, 0);
  vel[1].set(0, 0.70, 0);

  const step = (dt, t) => {
    setAnchor(t);
    // the whirl plane tilts and precesses slowly — a 3D tumble, not a disc
    n.set(0.35 * Math.sin(0.05 * t), 0.35 * Math.cos(0.043 * t), 1).normalize();
    d.subVectors(B, A);
    const dist = Math.max(d.length(), 1e-6);
    u.copy(d).divideScalar(dist);
    // the band: stretch, then Hooke — but a band can't push (e2's law)
    const s = nStretch.set(dist - P.rest);
    const T = nTension.set(s > 0 ? P.stiff * s : 0);
    vel[0].addScaledVector(u, T / M[0] * dt);  // pulled toward each other,
    vel[1].addScaledVector(u, -T / M[1] * dt); // ∓ is Newton III, /m is II
    // the stir: a unit push circling in the whirl plane at its own tempo.
    // Opposite signs on the tips = a couple; when ê lines up with the
    // orbit's tangent it pumps, when it lags it brakes — that phase war
    // is what keeps the ellipse alive instead of settling to a circle.
    p1.crossVectors(n, yAxis).normalize();
    p2.crossVectors(n, p1);
    // squash flattens the stir circle into an ellipse: a squashed push
    // cannot hold a circular orbit, so the pair is forced eccentric —
    // the whip is a parameter, not an accident
    e.copy(p1).multiplyScalar(Math.cos(P.rate * t))
      .addScaledVector(p2, (1 - P.squash) * Math.sin(P.rate * t));
    vel[0].addScaledVector(e, -P.spin / M[0] * dt);
    vel[1].addScaledVector(e, P.spin / M[1] * dt);
    tdir.crossVectors(n, u);
    nStir.set(tdir.dot(e)); // alignment: +1 feeding, −1 fighting
    // the anchor holds the pair, not the tips: one shared pull on the
    // barycentre, so the whirl itself is never torqued by it
    com.copy(A).multiplyScalar(M[0]).addScaledVector(B, M[1])
      .divideScalar(M[0] + M[1]);
    pull.subVectors(anchor, com);
    vel[0].addScaledVector(pull, CENT * dt);
    vel[1].addScaledVector(pull, CENT * dt);
    // drag bleeds what the stir feeds; the governor is a backstop only
    const k = Math.exp(-P.drag * dt);
    for (const v of vel) {
      v.multiplyScalar(k);
      const sp = v.length();
      if (sp > VMAX) v.multiplyScalar(Math.exp(-3 * dt * (sp / VMAX - 1)));
    }
    A.addScaledVector(vel[0], dt);
    B.addScaledVector(vel[1], dt);
    // the whirl, measured off the tips (never assumed): |û × vrel| / r.
    // The radius is floored: at full squash the tips pass through each
    // other, and angular rate at zero radius is not a number worth showing
    vrel.subVectors(vel[1], vel[0]);
    nOmega.set(lcross.crossVectors(u, vrel).length() / Math.max(dist, 0.15));
    // the tips are the wells: pull scaled live, swirl axes on the plane
    for (let i = 0; i < 2; i++) {
      wells[i].gm = GM[i] * P.grav;
      wells[i].sm = SM[i];
      wells[i].axis.copy(n);
    }
  };

  return { P, graph, step };
}
