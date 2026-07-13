// ---- the machine: the WHOLE experience as one directed graph -------------
// Six organs, built WITH the circuitry from the first line (not retrofitted):
// hand → sling → mass, synth → echo → eye, with the echo feeding back into
// the glass one frame late. The top level IS frame(): its evaluation order
// is the topological sort of this graph, and every cycle in it passes
// through a one-frame delay (echo; the o0 patch feeding on its own last
// output) — which is exactly why the whole thing is crankable.
//
// Layout convention: x/y are viewport fractions (the overlay adds the
// plate drift); `probe` pins a node to projected world positions;
// `enter` names the level a click drills into.
import { bindKey, bindUniform } from "../../src/rack.js";
import { createGraph } from "../../src/circuit/graph.js";

export function createMachine({
  sling, wells, flubber, noise, cohesion, burst,
  synthU, grade, orbit, gaze, echoSize, echoLag, rack,
}) {
  const levels = {};
  const lvl = (id, title, parent, layout) => {
    const graph = createGraph();
    levels[id] = { id, title, parent, graph, layout };
    return graph;
  };

  // ---- the tunables, addressed like everything else --------------------
  // Ranges carried over from the site's swept contracts where the bound
  // mechanism is byte-identical; anything whose CONTEXT changed (refract:
  // new echo content; grade: full frame; warp: no text column) gets
  // re-swept at contract time. voice: true marks knobs whose floor is a
  // true identity — the sweep proved the piece survives without them, so
  // they may mute. Floors pinned above zero are bone (zero broke the
  // piece); rate knobs (speed, haste) freeze the medium rather than
  // remove it, so they are bone too, despite their zero floors.
  if (rack) {
    if (noise) rack.add("/flubber/noise", bindUniform(noise.uniforms.uAmt), { min: 0, max: 2, voice: true });
    if (cohesion) rack.add("/flubber/cohesion", bindUniform(cohesion.uniforms.uStr), { min: 0.3, max: 2 });
    if (flubber) {
      rack.add("/flubber/damp", bindUniform(flubber.u.uDamp), { min: 0.45, max: 2, unit: "/s" });
      // refract re-swept 2026-07 on the new echo content (fullscreen
      // backdrop, no room): at 0 the glass dies into a flat cutout wearing
      // only its rim — still the clearest demo of what the echo feeds it;
      // at 0.8 the lensing goes heavy and the field swims inside the body.
      // Both legible, both safe.
      rack.add("/flubber/refract", bindUniform(flubber.u.uRefract), { min: 0, max: 0.8, voice: true });
      // rim solo (black stage, orange skin alone) is the piece's best
      // portrait — swept 0→2, tasteful throughout
      rack.add("/flubber/rim", bindUniform(flubber.u.uRimStrength), { min: 0, max: 2, voice: true });
    }
    if (synthU) {
      rack.add("/synth/speed", bindUniform(synthU.speed), { min: 0, max: 3 });
      rack.add("/synth/pink", bindUniform(synthU.pink), { min: 0, max: 1.2, voice: true });
      rack.add("/synth/feed", bindUniform(synthU.feed), { min: 0, max: 0.08, voice: true });
      rack.add("/synth/haste", bindUniform(synthU.haste), { min: 0, max: 4 });
      // gain is BONE with a floor, not a voice — swept 2026-07: 0 was safe
      // and dramatic, but as a voice its mute/solo killed the stage every
      // other synth voice performs on (pink/feed/noise solos went black).
      // Floor 0.25 keeps the stage dimly lit; ceiling 1.0 measured — at 1.2
      // the wash swallows the mass.
      rack.add("/synth/gain", bindUniform(synthU.gain), { min: 0.25, max: 1.0 });
    }
    if (orbit) rack.add("/eye/period", bindKey(orbit, "period"), { min: 12, max: 90, unit: "s" });
    if (grade) {
      // grade re-swept 2026-07 on the full frame: exposure 0.4 is a moody
      // dusk (mass still reads), 2.0 a bright wash — display-only, cannot
      // feed back, so the extremes are taste, not danger. contrast 2.2
      // punches nicely; 0.8 goes soft and flat.
      rack.add("/eye/exposure", bindUniform(grade.exposure), { min: 0.4, max: 2 });
      rack.add("/eye/contrast", bindUniform(grade.contrast), { min: 0.8, max: 2.2 });
    }
  }

  // ---- top level: six organs --------------------------------------------
  const top = lvl("machine", "machine", null, {
    hand: { x: 0.50, y: 0.12, color: "#b8b8b4", enter: "hand" },
    synth: { x: 0.82, y: 0.12, color: "#ffd9fb", enter: "synth" },
    sling: { x: 0.30, y: 0.55, color: "#5ee8e0", enter: "sling" },
    mass: { probe: "mid", color: "#5ee8e0", enter: "mass" },
    echo: { x: 0.88, y: 0.52, color: "#e4699b", enter: "echo" },
    eye: { x: 0.66, y: 0.87, color: "#f2b75c", enter: "eye" },
  });
  const nHand = top.tap("hand", {
    label: "hand", init: "—",
    caption: "you — clicks burst the mass, scrubs turn knobs",
  });
  top.tap("synth", {
    label: "synth", init: "warp nebula",
    caption: "the video patch, feeding on its own last frame",
    knobs: ["/synth/gain"],
  });
  const nSlingTop = top.tap("sling", {
    label: "sling", min: 0, max: 8,
    caption: "two tips, one band, stirred forever — the choreography",
    inputs: [{ from: "hand" }],
    fmt: (v) => `T ${(+v).toFixed(2)}`,
  });
  const nMassTop = top.tap("mass", {
    label: "mass", min: 0, max: 22,
    caption: "the liquid glass — particles falling toward the tips",
    inputs: [{ from: "sling" }, { from: "hand" }, { from: "synth" }, { from: "echo" }],
    fmt: (v) => `${flubber?.count ?? 0} drops · burst ${(+v).toFixed(1)}`,
  });
  top.tap("echo", {
    label: "echo", init: "—",
    caption: "last frame, kept — every loop pays one frame of delay",
    inputs: [{ from: "mass" }, { from: "synth" }],
  });
  const nEyeTop = top.tap("eye", {
    label: "eye", min: 0, max: 360, unit: "°",
    caption: "an orbiting camera, one committed grade on the way out",
    inputs: [{ from: "echo" }],
    fmt: (v) => `φ ${Math.round(v)}°`,
  });

  // ---- sling interior: the graph createSling already authored ----------
  levels.sling = {
    id: "sling", title: "sling", parent: "machine",
    graph: sling.graph,
    layout: {
      anchor: { x: 0.56, y: 0.10, color: "#b8b8b4" },
      stir: { x: 0.86, y: 0.12, color: "#ffd9fb" },
      stretch: { x: 0.52, y: 0.78, color: "#b8b8b4" },
      tension: { x: 0.68, y: 0.88, color: "#f2b75c" },
      omega: { x: 0.86, y: 0.78, color: "#e4699b" },
      "tip.a": { probe: 0, color: "#5ee8e0" },
      "tip.b": { probe: 1, color: "#5ee8e0" },
    },
  };

  // ---- mass interior: forces → integrate → splat → march ---------------
  const gm = lvl("mass", "mass", "machine", {
    wells: { x: 0.52, y: 0.12, color: "#5ee8e0" },
    burst: { x: 0.86, y: 0.10, color: "#f2b75c" },
    forces: { x: 0.62, y: 0.38, color: "#ffd9fb" },
    integrate: { x: 0.86, y: 0.50, color: "#b8b8b4" },
    splat: { x: 0.62, y: 0.68, color: "#b8b8b4" },
    march: { x: 0.82, y: 0.86, color: "#e4699b" },
  });
  const nWells = gm.tap("wells", {
    label: "wells", min: 0, max: 9,
    caption: "the two tips, arrived from the sling",
    fmt: (v) => `pull ${(+v).toFixed(1)}`,
  });
  const nBurst = gm.tap("burst", {
    label: "burst", min: 0, max: 22,
    caption: "the click shockwave, decaying away",
  });
  gm.tap("forces", {
    label: "forces",
    caption: "gravity toward the tips, a noise breeze, a pull to the middle",
    min: 0, max: 2, knobs: ["/flubber/noise", "/flubber/cohesion"],
    inputs: [{ from: "wells" }, { from: "burst" }],
  });
  gm.tap("integrate", {
    label: "integrate",
    caption: "velocity damped each second, speed softly governed",
    min: 0, max: 2, knobs: ["/flubber/damp"],
    inputs: [{ from: "forces" }],
  });
  gm.tap("splat", {
    label: "splat", init: flubber ? `${flubber.grid}³ grid` : "—",
    caption: "every particle splats its density into one shared field",
    inputs: [{ from: "integrate" }],
  });
  gm.tap("march", {
    label: "march", init: "one skin",
    caption: "one isosurface raymarched as glass, bending last frame around itself",
    min: 0, max: 0.8, knobs: ["/flubber/refract", "/flubber/rim"],
    inputs: [{ from: "splat" }],
  });

  // ---- synth interior: the patch and its feedback rail ------------------
  // The self-feed loop is drawn as its own node — o0's output passes
  // through it (kept one frame) and comes back as an input. That delay
  // node IS why the patch can run forever without exploding.
  const gs = lvl("synth", "synth", "machine", {
    o0: { x: 0.54, y: 0.16, color: "#ffd9fb" },
    feed: { x: 0.87, y: 0.40, color: "#e4699b" },
    ember: { x: 0.56, y: 0.68, color: "#f2b75c" },
  });
  gs.tap("o0", {
    label: "o0 nebula", init: "warp",
    caption: "domain-warped fbm — the backdrop the eye sees live",
    knobs: ["/synth/speed", "/synth/pink"],
    inputs: [{ from: "feed" }],
  });
  gs.tap("feed", {
    label: "self-feed", init: "1 frame late",
    caption: "the patch drinks its own last frame — drift without smear",
    knobs: ["/synth/feed"],
    inputs: [{ from: "o0" }, { from: "ember" }],
  });
  gs.tap("ember", {
    label: "o1 ember", init: "rim light",
    caption: "a quiet warm loop the glass wears as a rim",
    knobs: ["/synth/haste"],
    inputs: [{ from: "feed" }],
  });

  // ---- echo interior: the feedback rail ---------------------------------
  const ge = lvl("echo", "echo", "machine", {
    write: { x: 0.58, y: 0.24, color: "#e4699b" },
    read: { x: 0.82, y: 0.62, color: "#e4699b" },
  });
  const nWrite = ge.tap("write", {
    label: "write", init: "—",
    caption: "this frame renders here",
  });
  const nRead = ge.tap("read", {
    label: "read", min: 0, max: 60,
    caption: "the glass refracts this — the whole scene, one frame late",
    inputs: [{ from: "write" }],
    fmt: (v) => `lag ${(+v).toFixed(1)} ms`,
  });

  // ---- eye interior ------------------------------------------------------
  const gy = lvl("eye", "eye", "machine", {
    orbit: { x: 0.56, y: 0.18, color: "#f2b75c" },
    gaze: { x: 0.84, y: 0.44, color: "#b8b8b4" },
    grade: { x: 0.64, y: 0.76, color: "#ffd9fb" },
  });
  const nOrbit = gy.tap("orbit", {
    label: "orbit", min: 0, max: 360, unit: "°",
    caption: "an eccentric tilted ellipse, precessing — no lap retraces",
    knobs: ["/eye/period"],
    fmt: (v) => `φ ${Math.round(v)}°`,
  });
  const nGaze = gy.tap("gaze", {
    label: "gaze", init: "drifts + banks",
    caption: "the look-at wanders; a faint roll banks the horizon",
    inputs: [{ from: "orbit" }],
  });
  gy.tap("grade", {
    label: "grade", init: "display only",
    caption: "pivoted contrast, split tone, dither — never inside the loop",
    knobs: ["/eye/exposure", "/eye/contrast"],
  });

  // ---- hand interior -----------------------------------------------------
  const gh = lvl("hand", "hand", "machine", {
    pointer: { x: 0.56, y: 0.22, color: "#f2b75c" },
    scrub: { x: 0.78, y: 0.62, color: "#ffd9fb" },
  });
  const nPointer = gh.tap("pointer", {
    label: "pointer", init: "click me",
    caption: "a click detonates a shockwave at the blob’s depth",
  });
  const nScrub = gh.tap("scrub", {
    label: "scrub", init: "—",
    caption: "artist mode: every knob row writes straight into the rack",
  });

  // ---- live wiring -------------------------------------------------------
  const tension = sling.graph.get("tension");
  const note = (kind, detail = "") => {
    if (kind === "burst") { nHand.set("click — burst"); nPointer.set("burst!"); }
    if (kind === "scrub") { nHand.set(`scrub ${detail.split("/").pop()}`); nScrub.set(detail); }
    if (kind === "mute") { nHand.set(`mute ${detail.split("/").pop()}`); }
    if (kind === "solo") { nHand.set(detail ? `solo ${detail.split("/").pop()}` : "solo off"); }
  };
  // the eye's φ, recomputed from the same pacing formula the camera uses
  const phase = (t) => {
    if (!orbit) return 0;
    const m = (2 * Math.PI / orbit.period) * t;
    const th = m + orbit.ecc * Math.sin(m);
    return ((th * 180 / Math.PI) % 360 + 360) % 360;
  };
  let lagMs = 0;
  const update = (t) => {
    nSlingTop.set(tension.value);
    const b = burst ? burst.uniforms.uStr.value : 0;
    nMassTop.set(b);
    nBurst.set(b);
    if (wells) nWells.set((wells[0].gm ?? 0) + (wells[1].gm ?? 0));
    if (echoSize) {
      const s = echoSize();
      const label = `${s.w}×${s.h}`;
      top.get("echo").set(label);
      nWrite.set(label);
    }
    // the echo's price, measured: one frame of real time (reported by the
    // frame loop — this update runs at 10Hz, so it can't time it itself),
    // smoothed a little so the readout breathes instead of flickering
    if (echoLag) {
      lagMs += (echoLag() - lagMs) * 0.3;
      nRead.set(lagMs);
    }
    const deg = phase(t);
    nEyeTop.set(deg);
    nOrbit.set(deg);
    if (gaze) nGaze.set(
      `bank ${(gaze.roll * Math.sin(t * gaze.fr + gaze.pr) * 180 / Math.PI).toFixed(1)}°`);
  };

  return { levels, top: "machine", update, note, tension };
}
