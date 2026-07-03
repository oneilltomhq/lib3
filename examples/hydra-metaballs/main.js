// Hydra × Metaballs — the site's "signal chamber" pattern as a lib3 demo,
// with the whole stack in one patch:
//
//   hydra    — o0 backdrop (feedback melt) + o1 ember rim, compiled to TSL
//   metaballs— liquid glass in front, refracting the backdrop, rim-lit by o1
//   conductor— one 120bpm clock; the backdrop DUCKS to the kick (sidechain
//              through a hydra dynamic arg), a tresillo voice kicks the swirl
//   rack     — every knob addressable: window.rack from the console (or an
//              agent) — set/ramp/snap/replay the whole piece
//
// The wiring rule (from oneilltom.com): separate producers, coupled via
// textures. Hydra paints; the balls sample what it painted. Beat pushes
// momentum (spring targets and kicks), never pose.

import * as THREE from "three/webgpu";
import { texture } from "three/tsl";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { HydraSynth } from "../../src/hydra/index.js";
import { RaymarchedMetaballs } from "../../src/metaballs.js";
import { Conductor, Spring } from "../../src/conductor.js";
import { Rack, bindKey, bindUniform, localStorageAdapter } from "../../src/rack.js";

const canvas = document.getElementById("view");
const renderer = new THREE.WebGPURenderer({ canvas, antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
await renderer.init();

// ---- musical time -----------------------------------------------------------------
const conductor = new Conductor({ bpm: 120, swing: 0.08 });
const rack = new Rack({ storage: localStorageAdapter("hydraMetaballsRack") });

// live control state — what the rack addresses; hydra reads it through
// dynamic args (t => ...), so knob moves hit the synth without recompiles
const ctrl = {
  flow: 9, // backdrop osc frequency
  melt: 0.045, // feedback modulate amount (the infinite-zoom pull)
  hueDrift: 0.0012, // colorama rate — it accumulates through the feedback, keep tiny
  duck: 0.5, // how hard the backdrop ducks to the kick
  throb: 0.22, // blob radius pump depth
  kickSwirl: 0.55, // swirl surge per accented hit
};
let pump = 0; // conductor.pump(), sampled once per frame

// ---- hydra: two outputs -----------------------------------------------------------
// display: true — the scene composites the outputs, so it samples their
// stable display targets, never the feedback ping-pong
const synth = new HydraSynth({ renderer, width: 1024, height: 576, outputs: 2, display: true });
const { osc, voronoi, src, o0, o1 } = synth.api;

// o0 backdrop: classic feedback melt, sidechained — brightness dips between
// beats and blooms back on every kick, so the ROOM pumps, not just the balls
osc(() => ctrl.flow, 0.055, 1.2)
  .rotate(0.35, 0.015)
  .modulate(src(o0).scale(1.035).rotate(0.004), () => ctrl.melt)
  .colorama(() => ctrl.hueDrift)
  .saturate(0.72) // bleed saturation back out each pass or the loop blows to neon
  .contrast(1.12)
  .brightness(() => -0.22 * ctrl.duck * (1 - pump))
  .out(o0);

// o1 ember: slow-crawling cells, warm — only the glass edges ever show it
voronoi(6, 0.22, 0.5).color(1.5, 0.75, 0.35).contrast(1.5).out(o1);

// ---- scene ------------------------------------------------------------------------
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(
  60, window.innerWidth / window.innerHeight, 0.1, 100);
camera.position.set(0, 0.15, 4);

const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.minDistance = 2.2;
controls.maxDistance = 7;

// backdrop plane: the synth on the far wall, sized to overfill the frustum
const BACKDROP_Z = -2.4;
const backdropMat = new THREE.MeshBasicNodeMaterial();
backdropMat.colorNode = texture(o0.display.texture);
const backdrop = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), backdropMat);
backdrop.position.z = BACKDROP_Z;
scene.add(backdrop);
function sizeBackdrop() {
  const dist = camera.position.length() - BACKDROP_Z;
  const h = 2 * dist * Math.tan((camera.fov * Math.PI) / 360) * 1.6;
  backdrop.scale.set(h * camera.aspect, h, 1);
}
sizeBackdrop();

// ---- the liquid -------------------------------------------------------------------
// blobs orbit on interleaved spirals; the kick pumps their radius, a
// euclidean voice surges the swirl — circles that breathe with the floor
const BLOBS = 6;
const blobs = Array.from({ length: BLOBS }, (_, i) => ({
  position: new THREE.Vector3(),
  radius: 0.3,
  base: 0.2 + 0.13 * Math.abs(Math.sin(i * 2.39996)), // golden-angle sizes
  orbit: 0.55 + 0.22 * i,
  phase: (i / BLOBS) * Math.PI * 2,
  rate: 1 - 0.09 * i, // outer rings lag — the spiral look
  bob: i * 1.7,
}));

const swirl = new Spring({ value: 0.28, target: 0.28, freq: 0.5, zeta: 1.0 });
const swirlBoost = new Spring({ value: 0, target: 0, freq: 0.7, zeta: 0.85 });

conductor.voice({
  steps: 8, hits: 3, // tresillo against the four-on-the-floor pump
  onHit({ accent }) { swirlBoost.kick(ctrl.kickSwirl * accent); },
});

const metaballs = new RaymarchedMetaballs({
  camera,
  sources: blobs,
  sceneTexture: o0.display.texture, // stable targets: set once, never re-point
  rimTexture: o1.display.texture,
  smoothing: 0.3,
  quadZ: 3.0, // quad ~1m in front of the start camera, always nearer than the blobs
  refractionStrength: 0.26,
  fresnelStrength: 0.9,
  fresnelBase: 0.5,
  rimStrength: 0.35,
});
scene.add(metaballs.mesh);

// ---- the jack panel ---------------------------------------------------------------
rack.add("/room/bpm", bindKey(conductor, "bpm"), { min: 60, max: 160, unit: "bpm" });
rack.add("/room/swing", bindKey(conductor, "swing"), { min: 0, max: 0.6 });
rack.add("/synth/flow", bindKey(ctrl, "flow"), { min: 2, max: 40 });
rack.add("/synth/melt", bindKey(ctrl, "melt"), { min: 0, max: 0.12 });
rack.add("/synth/hue", bindKey(ctrl, "hueDrift"), { min: 0, max: 0.05 });
rack.add("/synth/duck", bindKey(ctrl, "duck"), { min: 0, max: 1 });
rack.add("/balls/swirl", bindKey(swirl, "target"),
  { label: "swirl (spring target)", min: 0, max: 1.5, unit: "rad/s" });
rack.add("/balls/throb", bindKey(ctrl, "throb"), { min: 0, max: 0.6 });
rack.add("/balls/smooth", {
  get: () => metaballs.smoothing,
  set: (v) => metaballs.setSmoothing(v),
}, { min: 0.12, max: 0.55 });
rack.add("/balls/refract", bindUniform(metaballs.refractionStrength), { min: 0, max: 0.6 });
rack.add("/balls/rim", bindUniform(metaballs.rimStrength), { min: 0, max: 1 });
rack.add("/balls/kick", {
  get: () => 0,
  set: (v) => { if (v >= 0.5) swirlBoost.kick(ctrl.kickSwirl); },
}, { min: 0, max: 1, type: "trigger" });

window.rack = rack;
window.synth = synth;
window.metaballs = metaballs;
window.backdrop = backdrop;

// ---- resize -----------------------------------------------------------------------
window.addEventListener("resize", () => {
  renderer.setSize(window.innerWidth, window.innerHeight);
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  sizeBackdrop();
});

// ---- loop -------------------------------------------------------------------------
const clock = new THREE.Clock();
renderer.setAnimationLoop(() => {
  const dt = Math.min(0.1, clock.getDelta());
  const t = clock.elapsedTime;

  conductor.update(dt);
  rack.update(dt); // the render loop is the ramp clock
  pump = conductor.pump(5);

  const spin = swirl.update(dt) + swirlBoost.update(dt);
  for (const b of blobs) {
    b.phase += spin * b.rate * dt;
    b.position.set(
      Math.cos(b.phase) * b.orbit,
      Math.sin(b.phase * 0.7 + b.bob) * 0.45,
      Math.sin(b.phase) * b.orbit * 0.35,
    );
    b.radius = b.base * (1 + ctrl.throb * pump);
  }

  synth.update(t); // hydra passes (offscreen; also ticks the dynamic args)
  metaballs.update();

  controls.update();
  renderer.render(scene, camera);
});

window.__ready = true;
