// Flubber, route A: keep the sphere sources, destroy the sphere READ.
//
// The bally look of metaballs is the field, not the pipeline: each source IS
// a sphere SDF, so each lobe reads as a sphere. Here the field is wrapped
// (RaymarchedMetaballs { wrapSdf }) with two treatments:
//
//   domain warp  — p is bent by vec3 noise before the spheres are measured;
//                  lobes grow pseudopods and dents, silhouettes stop closing
//   displacement — scalar noise rides the surface: chop, gristle
//
// Ten small sources at high smoothing merge into one mass; the conductor
// kicks the warp amount so the blob convulses on hits instead of pulsing
// like a balloon. The wrapped field is not a true SDF anymore — near the
// surface it marches at 0.72 safety; far away it falls back to the plain
// sphere field minus the warp bound, so empty space costs no noise.

import * as THREE from "three/webgpu";
import { float, If, texture, uniform, vec3, mx_noise_float, mx_noise_vec3 } from "three/tsl";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { HydraSynth } from "../../src/hydra/index.js";
import { RaymarchedMetaballs } from "../../src/metaballs.js";
import { Conductor, Spring } from "../../src/conductor.js";
import { Rack, bindKey, bindUniform, connectRackBridge, localStorageAdapter } from "../../src/rack.js";

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
const rack = new Rack({ storage: localStorageAdapter("flubberWarpRack") });

const ctrl = {
  // wall: the synth backdrop. 0.5 (default): a fixed stage flat — orbit past
  // its edge and there's honest void behind. 1: follows the camera (always a
  // full frame, never any void). 0: hidden. Refraction is scene-true in all.
  wall: 0.5,
  warp: 0.3, // resting domain-warp amount (world units of bend)
  warpKick: 0.5, // extra warp per accented hit (spring, settles back)
  chop: 0.045, // surface displacement amplitude
  breathe: 0.1, // radius pump depth (kept small — throb is the balloon look)
};
let pump = 0;

// ---- hydra backdrop + rim ----------------------------------------------------------
const synth = new HydraSynth({ renderer, width: 1024, height: 576, outputs: 2, display: true });
const { osc, voronoi, src, o0, o1 } = synth.api;

osc(7, 0.05, 1.4)
  .rotate(0.6, 0.01)
  .modulate(src(o0).scale(1.03).rotate(-0.003), 0.05)
  .colorama(0.0009)
  .saturate(0.7)
  .contrast(1.1)
  .brightness(() => -0.1 * (1 - pump))
  .out(o0);

voronoi(5, 0.18, 0.6).color(0.55, 1.15, 0.8).contrast(1.4).out(o1);

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

// ---- grab pass ----------------------------------------------------------------------
// the glass refracts what is ACTUALLY rendered behind it: each frame the scene
// (minus the glass) is drawn into this target, and the marcher samples it at
// screenUV — so orbiting can't shear the ball interior off the backdrop
const grabRT = new THREE.RenderTarget(1, 1);
function sizeGrab() {
  const dpr = renderer.getPixelRatio();
  grabRT.setSize(window.innerWidth * dpr, window.innerHeight * dpr);
}
sizeGrab();

// ---- sources: a tight school, not an orrery ----------------------------------------
// many small radii + high smoothing = one connected mass with transient necks;
// no blob is ever readable alone
const BLOBS = 10;
const blobs = Array.from({ length: BLOBS }, (_, i) => ({
  position: new THREE.Vector3(),
  radius: 0.15,
  base: 0.12 + 0.07 * ((i * 2.39996) % 1),
  orbit: 0.25 + 0.55 * ((i * 1.61803) % 1),
  phase: (i / BLOBS) * Math.PI * 2,
  rate: 0.6 + 0.5 * ((i * 0.7548) % 1),
  drift: i * 2.7, // independent slow wander — motion never fully freezes
}));

const swirl = new Spring({ value: 0.35, target: 0.35, freq: 0.5, zeta: 1.0 });
const warpKick = new Spring({ value: 0, target: 0, freq: 0.9, zeta: 0.6 }); // rings a little

conductor.voice({
  steps: 8, hits: 3,
  onHit({ accent }) { warpKick.kick(ctrl.warpKick * accent); },
});

// ---- the warped field ---------------------------------------------------------------
const uTime = uniform(0);
const uWarp = uniform(ctrl.warp);
const uWarpFreq = uniform(1.7);
const uChop = uniform(ctrl.chop);
const uChopFreq = uniform(5.0);

const WARP_MAX = 0.9; // rack ceiling for warp+kick; bounds padding must cover it

const metaballs = new RaymarchedMetaballs({
  camera,
  sources: blobs,
  sceneTexture: grabRT.texture,
  rimTexture: o1.display.texture,
  smoothing: 0.42,
  maxSteps: 56,
  quadZ: 2.8,
  boundsPadding: 0.6, // retightened every frame below to track the live warp
  refractionStrength: 0.3,
  fresnelStrength: 0.85,
  fresnelBase: 0.5,
  rimStrength: 0.4,
  // two-tier field: noise is expensive and only matters near the surface.
  // Far away, the plain sphere field minus the worst-case warp is a valid
  // (conservative) distance — full-length steps, zero noise. The warped
  // read runs only where the ray is already close.
  wrapSdf: (sdf) => (p) => {
    const d = float(0).toVar();
    const plain = sdf(p);
    // vec3 noise can move the measured point by ~1.6·amp across components;
    // chop lifts the surface by up to uChop
    const pad = uWarp.mul(1.6).add(uChop);
    If(plain.sub(pad).greaterThan(0.12), () => {
      d.assign(plain.sub(pad));
    }).Else(() => {
      const t = uTime;
      // domain warp: bend space, then measure the spheres in bent space
      const bent = p.add(
        mx_noise_vec3(p.mul(uWarpFreq).add(vec3(0, t.mul(0.22), t.mul(0.13))))
          .mul(uWarp)
      );
      // displacement: high-frequency chop riding the merged surface
      const chop = mx_noise_float(
        p.mul(uChopFreq).add(vec3(t.mul(-0.4), 0, t.mul(0.31)))
      ).mul(uChop);
      // warped field is not distance-true — march conservatively
      d.assign(sdf(bent).add(chop).mul(0.72));
    });
    return d;
  },
});
scene.add(metaballs.mesh);

// ---- jack panel ---------------------------------------------------------------------
rack.add("/room/bpm", bindKey(conductor, "bpm"), { min: 60, max: 160, unit: "bpm" });
rack.add("/room/wall", bindKey(ctrl, "wall"),
  { min: 0, max: 1, label: "wall: 0 hidden · 0.5 frozen · 1 follows" });
rack.add("/flub/warp", bindKey(ctrl, "warp"), { min: 0, max: 0.6 });
rack.add("/flub/kick", bindKey(ctrl, "warpKick"), { min: 0, max: 0.9, label: "warp per hit" });
rack.add("/flub/freq", bindUniform(uWarpFreq), { min: 0.4, max: 4 });
rack.add("/flub/chop", bindUniform(uChop), { min: 0, max: 0.09 });
rack.add("/flub/chopFreq", bindUniform(uChopFreq), { min: 2, max: 10 });
rack.add("/flub/smooth", {
  get: () => metaballs.smoothing,
  set: (v) => metaballs.setSmoothing(v),
}, { min: 0.2, max: 0.6 });
rack.add("/flub/swirl", bindKey(swirl, "target"), { min: 0, max: 1.2, unit: "rad/s" });
rack.add("/balls/refract", bindUniform(metaballs.refractionStrength), { min: 0, max: 0.6 });
rack.add("/balls/rim", bindUniform(metaballs.rimStrength), { min: 0, max: 1 });

if (new URLSearchParams(location.search).has("bridge")) connectRackBridge(rack);
window.rack = rack;
window.metaballs = metaballs;

// ---- resize -----------------------------------------------------------------------
window.addEventListener("resize", () => {
  renderer.setSize(window.innerWidth, window.innerHeight);
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  sizeGrab();
});

// ---- loop -------------------------------------------------------------------------
// one time base for everything: hydra, warp noise and the conductor all
// advance by the same clamped dt, so a hidden tab can't desync music from field
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

  uTime.value = elapsed;
  uWarp.value = Math.min(WARP_MAX, ctrl.warp + warpKick.update(dt));
  // quad bounds hug the CURRENT warp with a PRACTICAL noise bound (~1.0·amp,
  // not the shader's worst-case 1.6) — an extreme poke merely clips a
  // silhouette pixel at the quad edge, and the pixel savings on kicks are big
  metaballs.boundsPadding = 1.0 * uWarp.value + uChop.value + 0.12;

  const spin = swirl.update(dt);
  for (const b of blobs) {
    b.phase += spin * b.rate * dt;
    const wander = elapsed * 0.4 + b.drift;
    b.position.set(
      Math.cos(b.phase) * b.orbit + 0.18 * Math.sin(wander * 0.83),
      0.5 * Math.sin(b.phase * 0.7 + b.drift) + 0.14 * Math.sin(wander),
      Math.sin(b.phase) * b.orbit * 0.5,
    );
    b.radius = b.base * (1 + ctrl.breathe * pump);
  }

  synth.update(elapsed);
  metaballs.update();
  controls.update();
  backdrop.visible = ctrl.wall >= 0.25;
  if (ctrl.wall >= 0.75) placeBackdrop();

  // grab pass: everything but the glass, into the refraction source
  const glassVisible = metaballs.mesh.visible;
  metaballs.mesh.visible = false;
  renderer.setRenderTarget(grabRT);
  renderer.render(scene, camera);
  renderer.setRenderTarget(null);
  metaballs.mesh.visible = glassVisible;

  renderer.render(scene, camera);
  window.__ready = true; // after the first real frame, not before

  fpsFrames++;
  if (elapsed - fpsStamp >= 0.5) {
    fpsEl.textContent = `${(fpsFrames / (elapsed - fpsStamp)).toFixed(0)} fps`;
    fpsFrames = 0;
    fpsStamp = elapsed;
  }
});
