// flubber-machine: the flubber experience rebuilt WITH its circuitry from
// the first line — six organs (hand → sling → mass, synth → echo → eye),
// every tunable addressed at the moment it is written, every tap set at the
// compute site. The frame loop below is the top-level graph's topological
// sort; the machine (machine.js) is its drawn picture, not a retrofit.
//
// ?inspect=1 drag-orbit camera · ?bridge rackctl WebSocket · ?artist=1
// scrubbable overlay (stage 2) · ?circuit=0 no overlay
import {
  Scene, PerspectiveCamera, Vector2, Vector3, Quaternion, Raycaster,
  RenderTarget, QuadMesh, MeshBasicNodeMaterial, WebGPURenderer,
  HalfFloatType, LinearFilter, ClampToEdgeWrapping,
} from "three/webgpu";
import {
  texture, screenUV, vec3, mix, smoothstep, uniform, screenCoordinate, float,
} from "three/tsl";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { registerWarp } from "./warp.js";
import { HydraSynth } from "../../src/hydra/index.js";
import {
  FlubberField, wellDriver, noiseFlowDriver, cohesionDriver, burstDriver,
} from "../../src/flubber.js";
import { Rack, connectRackBridge } from "../../src/rack.js";
import { createSling } from "./sling.js";
import { createMachine } from "./machine.js";

const params = new URLSearchParams(location.search);
const canvas = document.getElementById("view");
if (!navigator.gpu) {
  document.getElementById("fail").style.display = "grid";
  throw new Error("WebGPU unavailable");
}
const renderer = new WebGPURenderer({ canvas, antialias: true });
renderer.setSize(innerWidth, innerHeight);
renderer.setPixelRatio(Math.min(devicePixelRatio, 1.75));
await renderer.init();

// ---- synth: o0 warp nebula + o1 ember rim, each self-feeding ------------
// display: true gives every output a STABLE third target (displayNode) —
// the scene composites those, never the swapping ping-pong pair.
registerWarp(); // before the api is built
const synth = new HydraSynth({ renderer, width: 960, height: 540, outputs: 2, display: true });
const { warp, osc, noise, src, o0, o1 } = synth.api;

// the expressive scalars are shared uniform nodes with rack addresses
// (/synth/*): the compiler passes nodes through untouched, so a chord and
// an artist scrub move the SAME values.
const synthU = {
  speed: uniform(1.0),  // warp time rate
  pink: uniform(0.6),   // filament intensity
  feed: uniform(0.016), // o0 self-feed appetite
  haste: uniform(1.0),  // ember's time rate
  gain: uniform(0.5),   // backdrop level in the scene (the chamber's heir)
};
warp(3.2, 0.34, 0.72, synthU.pink, 21, synthU.speed)
  .modulate(src(o0).scale(1.01).rotate(0.0018), synthU.feed)
  .out(o0);
const hasty = (v) => float(v).mul(synthU.haste);
osc(6, hasty(0.06), 0.4)
  .modulate(src(o1).scale(1.018).rotate(-0.01), 0.08)
  .modulate(noise(2.6, hasty(0.08)), 0.35)
  .color(1.25, 0.55, 0.32)
  .saturate(0.82)
  .contrast(1.4)
  .out(o1); // ember — the glass wears it as a rim

// ---- scene: the nebula as full-frame backdrop ----------------------------
const scene = new Scene();
scene.backgroundNode = texture(o0.display.texture, screenUV).mul(synthU.gain);

// ---- echo: the scene's own ping-pong — previous frame as a texture -------
// Every frame the whole scene renders into one of these two targets and is
// presented from it; next frame the flubber glass refracts it. Sample only
// the half not being rendered into.
const mkSceneRT = () => new RenderTarget(1, 1, {
  type: HalfFloatType, minFilter: LinearFilter, magFilter: LinearFilter,
  wrapS: ClampToEdgeWrapping, wrapT: ClampToEdgeWrapping, depthBuffer: true,
});
const ping = { read: mkSceneRT(), write: mkSceneRT() };

// ---- display grade: one committed look on the way out --------------------
// Lives ONLY on the present pass: the synth buffers and the echo recursion
// sample ungraded signal. Pivoted-power tone contrast, cool-shadow /
// warm-highlight split tone, gentle vibrance, IGN dither.
const grade = {
  exposure: uniform(1.05),
  contrast: uniform(1.32),
  pivot: uniform(0.11),
  split: uniform(0.6),
  sat: uniform(1.28),
};
const LUMA = vec3(0.2126, 0.7152, 0.0722);
const SHADOW_TINT = vec3(0.82, 0.93, 1.14);
const HIGH_TINT = vec3(1.14, 0.96, 1.04);
const gradeNode = (c0) => {
  let c = c0.rgb.mul(grade.exposure).max(0.0);
  c = c.div(grade.pivot).pow(grade.contrast).mul(grade.pivot);
  const y = c.dot(LUMA);
  const shadows = smoothstep(0.02, 0.32, y).oneMinus().mul(grade.split);
  const highs = smoothstep(0.22, 0.72, y).mul(grade.split);
  c = c.mul(mix(vec3(1), SHADOW_TINT, shadows));
  c = c.mul(mix(vec3(1), HIGH_TINT, highs));
  c = mix(vec3(c.dot(LUMA)), c, grade.sat);
  // IGN dither: ±0.5/255, breaks up quantization steps invisibly
  const ign = screenCoordinate.x.mul(0.06711056)
    .add(screenCoordinate.y.mul(0.00583715)).fract()
    .mul(52.9829189).fract();
  return c.add(ign.sub(0.5).mul(1 / 255));
};
const presentMat = new MeshBasicNodeMaterial();
const presentTex = texture(ping.read.texture, screenUV);
presentMat.colorNode = gradeNode(presentTex);
const presentQuad = new QuadMesh(presentMat);

// ---- the wells: the two tips of the sling ---------------------------------
const wells = [
  { p: new Vector3(), axis: new Vector3(0, 0, 1), gm: 1.3, sm: 0.7 }, // tip A: heavy
  { p: new Vector3(), axis: new Vector3(0, 0, 1), gm: 0.8, sm: 1.6 }, // tip B: light
];

// ---- mass: GPU storage-buffer particles marched as one glass skin ---------
const camera = new PerspectiveCamera(38, innerWidth / innerHeight, 0.1, 50);
camera.position.z = 6;
const flubberBurst = burstDriver();
const flubNoise = noiseFlowDriver();
// firmer than the library default: the standing pull must survive the
// whips on its own
const flubCohesion = cohesionDriver({ strength: 0.8 });
const flubber = new FlubberField({
  renderer, camera,
  drivers: [wellDriver({ wells, count: 2 }), flubNoise, flubCohesion, flubberBurst],
  sceneTexture: ping.read.texture,
  rimTexture: o1.display.texture,
});
flubber.u.uDamp.value = 0.75; // eat the whip's fling a little faster
scene.add(flubber.mesh);

// ---- the rack: every tunable gets an address -------------------------------
// nothing persists — a reload always serves the authored defaults
const rack = new Rack();
if (params.has("bridge")) connectRackBridge(rack);

// ---- the sling: the perpetual mechanism -----------------------------------
const sling = createSling({ wells, rack });
const slingStep = sling.step;

// ---- eye: a slow, deliberate orbit ----------------------------------------
// One legible ellipse around the resting pose: slightly eccentric (Kepler
// pacing), tilted off the flat, the whole loop precessing about Y so no two
// laps trace the same line.
const INSPECT = params.get("inspect") === "1";
const camRest = new Vector3(0, 0, 6);
const ORBIT = {
  period: 34,   // s per lap
  a: 1.25,      // semi-major axis, world units
  b: 0.6,       // semi-minor — an ellipse, not a circle
  tilt: 0.6,    // off-flat inclination, rad
  ecc: 0.35,    // pacing: faster near, slower far
  nodal: 0.015, // loop precession about Y, rad/s
};
const GAZE = {
  ax: 0.10, fx: 0.043, px: 2.1, // look-at wander, x
  ay: 0.08, fy: 0.061, py: 0.4, // look-at wander, y
  roll: 0.05, fr: 0.037, pr: 0.5, // bank about the view axis, rad
};
const rollAxis = new Vector3(0, 0, 1);
const qRoll = new Quaternion(), qNode = new Quaternion();
const yAxis = new Vector3(0, 1, 0), xAxis = new Vector3(1, 0, 0);
const sway = new Vector3();
const applyDriftCamera = (t) => {
  const m = (2 * Math.PI / ORBIT.period) * t;
  const th = m + ORBIT.ecc * Math.sin(m); // equation-of-center pacing
  sway.set(ORBIT.a * Math.cos(th), 0, ORBIT.b * Math.sin(th));
  sway.applyAxisAngle(xAxis, ORBIT.tilt);
  qNode.setFromAxisAngle(yAxis, ORBIT.nodal * t);
  sway.applyQuaternion(qNode);
  camera.position.copy(camRest).add(sway);
  camera.lookAt(
    GAZE.ax * Math.sin(t * GAZE.fx + GAZE.px),
    GAZE.ay * Math.sin(t * GAZE.fy + GAZE.py),
    0);
  // roll: a faint bank about the view axis — the one motion lookAt can't
  // express; composed as a quaternion so it works in view space
  qRoll.setFromAxisAngle(rollAxis, GAZE.roll * Math.sin(t * GAZE.fr + GAZE.pr));
  camera.quaternion.multiply(qRoll);
};
let controls = null;
if (INSPECT) {
  controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.target.set(0.8, 0, 0);
}

// ---- the machine: the whole circuit, drawn from birth ----------------------
const machine = createMachine({
  sling, wells, flubber,
  noise: flubNoise, cohesion: flubCohesion, burst: flubberBurst,
  synthU, grade, orbit: ORBIT, gaze: GAZE,
  echoSize: () => ({ w: ping.read.width, h: ping.read.height }),
  echoLag: () => lastFdt * 1000,
  rack,
});

// ---- chords: named multi-knob gestures, composed from characterized solos --
// each is one affect sentence + a list of ramped moves; the rack's glide
// plays them, so a chord and a scrub move the SAME addresses
const CHORDS = {
  calm: {
    affect: "the mass settles into syrup, the field slows, the camera lingers",
    moves: [
      ["/sling/drag", 0.9, 1200], ["/sling/squash", 0.35, 1200],
      ["/flubber/noise", 0.15, 800], ["/synth/speed", 0.7, 800],
      ["/synth/gain", 0.42, 800], ["/eye/period", 60, 1500],
    ],
  },
  void: {
    affect: "the stage falls to its floor and the glass wears only its ember skin",
    moves: [
      ["/synth/gain", 0.25, 900], ["/flubber/rim", 1.5, 900],
      ["/flubber/refract", 0.12, 900], ["/eye/contrast", 1.6, 900],
      ["/synth/pink", 0.2, 900],
    ],
  },
  storm: {
    affect: "the stir flattens and whips, the surface boils, the nebula churns",
    moves: [
      ["/sling/squash", 1.0, 800], ["/sling/spin", 2.6, 800],
      ["/sling/drag", 0.25, 800], ["/flubber/noise", 0.9, 600],
      ["/synth/speed", 1.6, 600], ["/synth/feed", 0.03, 600],
      ["/eye/contrast", 1.45, 800],
    ],
  },
};
const playChord = (name) => {
  for (const [path, v, ms] of CHORDS[name].moves) rack.set(path, v, ms);
  machine.note("chord", name);
};
addEventListener("keydown", (ev) => {
  const names = Object.keys(CHORDS);
  const i = ev.key.charCodeAt(0) - 49; // keys 1..3
  if (i >= 0 && i < names.length) playChord(names[i]);
});

// click/tap: a shockwave where the pointer ray crosses the blob's depth
// plane — the mass scatters, cohesion gathers it back up
const raycaster = new Raycaster(), pointer = new Vector2();
addEventListener("pointerdown", (ev) => {
  // artist scrubs and circuit drilling must not fire the shockwave
  if (INSPECT || ev.target.closest("a, .knobrow, .hub, .crumb")) return;
  pointer.set((ev.clientX / innerWidth) * 2 - 1, -(ev.clientY / innerHeight) * 2 + 1);
  raycaster.setFromCamera(pointer, camera);
  const ro = raycaster.ray.origin, rd = raycaster.ray.direction;
  const tz = Math.abs(rd.z) > 1e-3 ? (flubber.center.z - ro.z) / rd.z : 6;
  const bp = ro.clone().addScaledVector(rd, Math.max(0.5, tz));
  flubberBurst.trigger(bp, 1.8, 22);
  machine.note("burst");
});

const resize = () => {
  const pr = Math.min(devicePixelRatio, 1.75);
  renderer.setPixelRatio(pr);
  renderer.setSize(innerWidth, innerHeight);
  // echo targets track the drawing buffer so the recursion stays crisp
  ping.read.setSize(Math.round(innerWidth * pr), Math.round(innerHeight * pr));
  ping.write.setSize(Math.round(innerWidth * pr), Math.round(innerHeight * pr));
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
};
resize();
addEventListener("resize", resize);

// ---- frame: the top-level graph, linearized --------------------------------
// hand (events, above) → sling (substeps) → mass (compute) → synth →
// echo (scene→write, present, swap) → eye (grade rode the present pass).
let circuit = null;
let last = 0;
let lastFdt = 0; // the frame's real cost — the echo's lag readout
let lastMachine = 0;
const SUBSTEP = 1 / 60; // fixed-ish step: stable forces
const frame = (t) => {
  const fdt = Math.min(t - last, 1 / 20); // clamp: tab refocus, hitches
  let dt = fdt;
  last = t;
  lastFdt = fdt;
  // advance in-flight rack glides BEFORE the substeps read bound constants
  rack.update(fdt);
  if (INSPECT) controls.update(); else applyDriftCamera(t);
  while (dt > 0) {
    const h = Math.min(dt, SUBSTEP);
    slingStep(h, t - dt + h);
    dt -= h;
  }
  // push the freshly-stepped wells to the sim, point refraction at last
  // frame's presented buffer, run the compute passes — all BEFORE the
  // scene render marches the density
  flubber.setSceneTexture(ping.read.texture);
  flubber.update(fdt, t);
  synth.update(t); // patch passes + stable display blits, offscreen
  // scene → write, present write through the grade, swap
  renderer.setRenderTarget(ping.write);
  renderer.render(scene, camera);
  presentTex.value = ping.write.texture;
  renderer.setRenderTarget(null);
  presentQuad.render(renderer);
  const r = ping.read; ping.read = ping.write; ping.write = r;
  // the circuitry overlay: DOM/SVG, outside the GPU loop entirely
  if (circuit) circuit.tick(t);
  else if (t - lastMachine > 0.1) { machine.update(t); lastMachine = t; }
};

// the piece exposes its own circuitry: a dim live rendering of the machine,
// part of the piece for every viewer. Hard escape: ?circuit=0.
if (params.get("circuit") !== "0") {
  const { createCircuitOverlay } = await import("../../src/circuit/overlay.js");
  // probe pinning: the HOST owns world→screen projection — normalized
  // top-left coords, x/y ∈ [0,1]
  const pv = new Vector3();
  const project = (p) => {
    pv.copy(p).project(camera);
    return [(pv.x + 1) / 2, (1 - pv.y) / 2];
  };
  circuit = createCircuitOverlay(machine, rack, {
    artist: params.get("artist") === "1",
    flare: () => machine.tension.value / 3,
    probes: () => {
      const a = project(wells[0].p), b = project(wells[1].p);
      const mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      return { points: { 0: a, 1: b, mid }, focal: mid };
    },
  });
}

document.getElementById("backend").textContent =
  synth.backend === "WebGPU" ? "WebGPU · WGSL" : "WebGL · GLSL";

// test hooks
window.__rack = rack; window.__machine = machine; window.__sling = sling;
window.__wells = wells; window.__flubber = flubber; window.__grade = grade;

const t0 = performance.now();
const loop = () => {
  frame((performance.now() - t0) / 1000);
  requestAnimationFrame(loop);
};
loop();
window.__ready = true;
