// Flubber, route B: no spheres anywhere. The shape is EMERGENT.
//
// The three GPU passes (sim → splat → march) now live in the library as
// FlubberField (../../src/flubber.js). This example is just the MUSICAL wiring:
// a hydra backdrop, a conductor, and a stack of drivers that push the mass —
// noise advection, cohesion, swirl, and a conductor-spiked radial kick. The
// site (oneilltom.com) drives the same substrate with gravity wells instead;
// neither copies the other.
//
// Why compute instead of warping the sphere field (../flubber-warp): the
// expensive stuff (noise, kernels) is paid per PARTICLE and per VOXEL, once —
// the march just does trilinear taps. Particle count and behavior scale
// without touching the fragment shader, and the mass can tear apart and
// re-merge, which a smooth-min of spheres never does.

import * as THREE from "three/webgpu";
import { texture } from "three/tsl";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { HydraSynth } from "../../src/hydra/index.js";
import { Conductor, Spring } from "../../src/conductor.js";
import { Rack, bindKey, bindUniform, connectRackBridge, localStorageAdapter } from "../../src/rack.js";
import {
  FlubberField,
  noiseFlowDriver,
  cohesionDriver,
  swirlDriver,
  kickDriver,
} from "../../src/flubber.js";

const canvas = document.getElementById("view");
if (!navigator.gpu) {
  document.getElementById("fail").style.display = "grid";
  throw new Error("WebGPU unavailable");
}
const renderer = new THREE.WebGPURenderer({ canvas, antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
await renderer.init();

// ---- musical time -----------------------------------------------------------------
const conductor = new Conductor({ bpm: 116, swing: 0.06 });
const rack = new Rack({ storage: localStorageAdapter("flubberComputeRack") });

const ctrl = {
  // wall: the synth backdrop. 0.5 (default): a fixed stage flat — orbit past
  // its edge and there's honest void behind. 1: follows the camera (always a
  // full frame, never any void). 0: hidden. Refraction is scene-true in all.
  wall: 0.5,
  kick: 5, // radial force per accented hit (decays exponentially)
};
let pump = 0;

// ---- hydra backdrop + rim ----------------------------------------------------------
const synth = new HydraSynth({ renderer, width: 1024, height: 576, outputs: 2, display: true });
const { osc, voronoi, src, o0, o1 } = synth.api;

osc(6, 0.04, 1.3)
  .rotate(-0.4, 0.012)
  .modulate(src(o0).scale(1.028).rotate(0.004), 0.05)
  .colorama(0.001)
  .saturate(0.72)
  .contrast(1.12)
  .brightness(() => -0.1 * (1 - pump))
  .out(o0);

voronoi(4, 0.2, 0.5).color(1.4, 0.7, 0.4).contrast(1.5).out(o1);

// ---- scene ------------------------------------------------------------------------
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(
  60, window.innerWidth / window.innerHeight, 0.1, 100);
camera.position.set(0, 0.1, 4);

const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.minDistance = 2.4;
controls.maxDistance = 6;

// backdrop: a camera-facing wall re-placed every frame a fixed depth beyond
// the origin — orbiting can never look past its edge into void
const BACKDROP_DEPTH = 2.4;
const backdropMat = new THREE.MeshBasicNodeMaterial();
backdropMat.colorNode = texture(o0.display.texture);
const backdrop = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), backdropMat);
scene.add(backdrop);
function placeBackdrop() {
  const camDist = camera.position.length();
  const span = camDist + BACKDROP_DEPTH;
  backdrop.position.copy(camera.position).multiplyScalar(-BACKDROP_DEPTH / camDist);
  backdrop.quaternion.copy(camera.quaternion);
  const h = 2 * span * Math.tan((camera.fov * Math.PI) / 360) * 1.15;
  backdrop.scale.set(h * camera.aspect, h, 1);
}
placeBackdrop();

// ---- refraction source: grab pass ---------------------------------------------------
// the glass refracts what is ACTUALLY rendered behind it — each frame the scene
// minus the glass is drawn here, sampled at screenUV, so orbiting can't shear
// the blob interior off the backdrop
const grabRT = new THREE.RenderTarget(1, 1);
function sizeGrab() {
  const dpr = renderer.getPixelRatio();
  grabRT.setSize(window.innerWidth * dpr, window.innerHeight * dpr);
}
sizeGrab();

// ---- the flubber substrate (sim → splat → march) lives in the library ---------------
// drivers push the mass: noise advection (must WIN against cohesion or the mass
// stays a bean), a quadratically-stiffening spring back to the origin, a swirl
// around y (spring-smoothed by the conductor), and a radial kick per accent.
const N = 128;
const BOUND = 1.4; // half-extent of the density box (world units)

const noise = noiseFlowDriver({ freq: 1.9, amt: 5.2 });
const cohesion = cohesionDriver({ strength: 1.4, stiffen: 3 }); // spring to origin (box centre)
const swirlDrv = swirlDriver({ strength: 0.9 });
const kick = kickDriver({ decay: 7 });

const flubber = new FlubberField({
  renderer,
  camera,
  drivers: [noise, cohesion, swirlDrv, kick],
  sceneTexture: grabRT.texture,
  rimTexture: o1.display.texture,
  count: N,
  grid: 64,
  center: new THREE.Vector3(0, 0, 0),
  half: new THREE.Vector3(BOUND, BOUND, BOUND),
  radius: 0.26, // uniform influence radius — small enough that clusters read, not a hull
  damp: 1.5,
  speedCap: 1e6, // effectively uncapped, as the original example was
  iso: 0.6,
  refract: 0.3,
  fresnelStrength: 0.85,
  fresnelBase: 0.5,
  rimStrength: 0.4,
  marchSteps: 80,
});
const marchMesh = flubber.mesh; // the loop toggles its visibility for the grab pass
scene.add(marchMesh);

// ---- conductor → physics ------------------------------------------------------------
const swirl = new Spring({ value: 0.9, target: 0.9, freq: 0.5, zeta: 1.0 });
conductor.voice({
  steps: 8, hits: 3,
  onHit({ accent }) { kick.add(ctrl.kick * accent); },
});

// ---- jack panel ---------------------------------------------------------------------
rack.add("/room/bpm", bindKey(conductor, "bpm"), { min: 60, max: 160, unit: "bpm" });
rack.add("/room/wall", bindKey(ctrl, "wall"),
  { min: 0, max: 1, label: "wall: 0 hidden · 0.5 frozen · 1 follows" });
rack.add("/flub/flow", bindUniform(noise.uniforms.uAmt), { min: 0, max: 8 });
rack.add("/flub/flowFreq", bindUniform(noise.uniforms.uFreq), { min: 0.4, max: 4 });
rack.add("/flub/cohesion", bindUniform(cohesion.uniforms.uStr), { min: 0.5, max: 6 });
rack.add("/flub/swirl", bindKey(swirl, "target"), { min: 0, max: 3 });
rack.add("/flub/kick", bindKey(ctrl, "kick"), { min: 0, max: 12 });
rack.add("/flub/blobR", bindUniform(flubber.u.uRadiusScale),
  { min: 0.7, max: 1.9, label: "blobR: scale on baked kernel radius" });
rack.add("/flub/iso", bindUniform(flubber.u.uIso), { min: 0.3, max: 1.6 });
rack.add("/balls/refract", bindUniform(flubber.u.uRefract), { min: 0, max: 0.6 });
rack.add("/balls/rim", bindUniform(flubber.u.uRimStrength), { min: 0, max: 1 });

if (new URLSearchParams(location.search).has("bridge")) connectRackBridge(rack);
window.rack = rack;

// ---- resize -----------------------------------------------------------------------
window.addEventListener("resize", () => {
  renderer.setSize(window.innerWidth, window.innerHeight);
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  sizeGrab();
});

// ---- loop -------------------------------------------------------------------------
// one clamped dt drives hydra, sim and conductor — hidden tabs can't desync them
let elapsed = 0;
const clock = new THREE.Clock();
const fpsEl = document.getElementById("fps");
let fpsFrames = 0;
let fpsStamp = 0;
renderer.setAnimationLoop(() => {
  const dt = Math.min(0.1, clock.getDelta());
  elapsed += dt;

  conductor.update(dt);
  rack.update(dt);
  pump = conductor.pump(5);

  // conductor-smoothed swirl → the swirl driver's live strength
  swirlDrv.uniforms.uStr.value = swirl.update(dt);
  // one call: decays the kick envelope, runs sim + splat compute passes
  flubber.update(dt, elapsed);

  synth.update(elapsed);
  controls.update();
  backdrop.visible = ctrl.wall >= 0.25;
  if (ctrl.wall >= 0.75) placeBackdrop();

  // grab pass: everything but the glass, into the refraction source
  marchMesh.visible = false;
  renderer.setRenderTarget(grabRT);
  renderer.render(scene, camera);
  renderer.setRenderTarget(null);
  marchMesh.visible = true;

  renderer.render(scene, camera);
  window.__ready = true;

  fpsFrames++;
  if (elapsed - fpsStamp >= 0.5) {
    fpsEl.textContent = `${(fpsFrames / (elapsed - fpsStamp)).toFixed(0)} fps`;
    fpsFrames = 0;
    fpsStamp = elapsed;
  }
});
