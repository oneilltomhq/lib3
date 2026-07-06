// Flubber, route B: no spheres anywhere. The shape is EMERGENT.
//
// Three GPU passes per frame:
//
//   sim    (compute, per particle) — 128 particles advected by vec3 noise,
//          spring-pulled to the origin, swirled, kicked radially by the
//          conductor. Positions/velocities persist in storage buffers.
//   splat  (compute, per voxel)    — each 64³ voxel sums a compact-support
//          kernel over all particles into a Storage3DTexture. Density, not
//          geometry: no primitive survives to be recognized.
//   march  (fragment)              — fixed-step march through the box,
//          isosurface where density crosses uIso, gradient normal, then the
//          same glass read as the metaballs (refract backdrop, fresnel, rim).
//
// Why compute instead of warping the sphere field (../flubber-warp): the
// expensive stuff (noise, kernels) is paid per PARTICLE and per VOXEL, once —
// the march just does trilinear taps. Particle count and behavior scale
// without touching the fragment shader, and the mass can tear apart and
// re-merge, which a smooth-min of spheres never does.

import * as THREE from "three/webgpu";
import {
  Break,
  cameraPosition,
  clamp,
  Discard,
  float,
  Fn,
  If,
  instancedArray,
  instanceIndex,
  Loop,
  mx_noise_vec3,
  normalize,
  positionWorld,
  screenSize,
  screenUV,
  texture,
  texture3D,
  textureStore,
  uniform,
  vec2,
  vec3,
  vec4,
} from "three/tsl";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { HydraSynth } from "../../src/hydra/index.js";
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
const rack = new Rack({ storage: localStorageAdapter("flubberComputeRack") });

const ctrl = {
  kick: 5, // radial force per accented hit (decays exponentially)
};
let pump = 0;
let kickEnv = 0;

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

// ---- pass 1: particle sim -----------------------------------------------------------
const N = 128;
const BOUND = 1.4; // half-extent of the density box (world units)

const initPositions = new Float32Array(N * 3);
for (let i = 0; i < N; i++) {
  // random-ish ball, radius ~0.7
  const r = 0.7 * Math.cbrt(Math.random());
  const a = Math.random() * Math.PI * 2;
  const z = Math.random() * 2 - 1;
  const s = Math.sqrt(1 - z * z);
  initPositions[i * 3 + 0] = r * s * Math.cos(a);
  initPositions[i * 3 + 1] = r * z;
  initPositions[i * 3 + 2] = r * s * Math.sin(a);
}
const pPos = instancedArray(initPositions, "vec3");
const pVel = instancedArray(N, "vec3");

const uDt = uniform(0);
const uT = uniform(0);
const uFlowFreq = uniform(1.9);
const uFlowAmt = uniform(5.2); // noise advection force — must WIN against cohesion or the mass stays a bean
const uCohesion = uniform(1.4); // spring to origin — what re-merges the mass
const uSwirl = uniform(0.9); // tangential force around y
const uKick = uniform(0); // radial force, spiked by the conductor
const uDamp = uniform(1.5);

const simParticles = Fn(() => {
  const pos = pPos.element(instanceIndex);
  const vel = pVel.element(instanceIndex);

  const flow = mx_noise_vec3(
    pos.mul(uFlowFreq).add(vec3(0, uT.mul(0.25), uT.mul(0.11)))
  ).mul(uFlowAmt);
  // cohesion stiffens quadratically with distance — noise can stretch the
  // mass, never fling a particle out of the box
  const stiffen = pos.dot(pos).mul(3).add(1);
  const pull = pos.mul(uCohesion.mul(stiffen).negate());
  const swirlF = vec3(pos.z.negate(), 0, pos.x).mul(uSwirl);
  const out = normalize(pos.add(vec3(0.013, 0.021, 0.017))).mul(uKick);

  vel.addAssign(flow.add(pull).add(swirlF).add(out).mul(uDt));
  vel.mulAssign(clamp(float(1).sub(uDamp.mul(uDt)), 0, 1));
  pos.addAssign(vel.mul(uDt));
})().compute(N);

// ---- pass 2: splat density into a 3D texture ----------------------------------------
const GRID = 64;
const volume = new THREE.Storage3DTexture(GRID, GRID, GRID);
volume.generateMipmaps = false;
volume.magFilter = THREE.LinearFilter;
volume.minFilter = THREE.LinearFilter;
volume.name = "flubberDensity";

const uBlobR = uniform(0.26); // particle influence radius — small enough that clusters read, not a hull

const splatDensity = Fn(() => {
  const id = instanceIndex;
  const x = id.mod(GRID);
  const y = id.div(GRID).mod(GRID);
  const z = id.div(GRID * GRID);

  const wp = vec3(x, y, z)
    .add(0.5)
    .div(GRID)
    .sub(0.5)
    .mul(2 * BOUND);

  const r2max = uBlobR.mul(uBlobR);
  const dens = float(0).toVar();
  Loop(N, ({ i }) => {
    const dp = wp.sub(pPos.element(i));
    const w = clamp(float(1).sub(dp.dot(dp).div(r2max)), 0, 1);
    dens.addAssign(w.mul(w).mul(w)); // compact-support cubic falloff
  });

  textureStore(volume, vec3(x, y, z), vec4(dens, 0, 0, 1));
})().compute(GRID * GRID * GRID);

// ---- pass 3: march the isosurface ---------------------------------------------------
const uIso = uniform(0.6);
const uRefract = uniform(0.3);
const uFresnelStrength = uniform(0.85);
const uFresnelBase = uniform(0.5);
const uRimStrength = uniform(0.4);
const MARCH_STEPS = 80;

const densityTex = texture3D(volume, null, 0);
// grab pass: the glass refracts what is ACTUALLY rendered behind it — each
// frame the scene minus the glass is drawn here, sampled at screenUV, so
// orbiting can't shear the blob interior off the backdrop
const grabRT = new THREE.RenderTarget(1, 1);
function sizeGrab() {
  const dpr = renderer.getPixelRatio();
  grabRT.setSize(window.innerWidth * dpr, window.innerHeight * dpr);
}
sizeGrab();
const sceneTex = texture(grabRT.texture);
const rimTex = texture(o1.display.texture);

const densityAt = (p) => densityTex.sample(p.div(2 * BOUND).add(0.5)).r;

const marchMat = new THREE.MeshBasicNodeMaterial();
marchMat.transparent = true;
marchMat.depthWrite = false;
marchMat.side = THREE.BackSide; // back faces: rays exist even at close orbit

marchMat.colorNode = Fn(() => {
  const ro = cameraPosition;
  const rd = normalize(positionWorld.sub(cameraPosition));

  // slab intersection with the density box
  const inv = vec3(1).div(rd);
  const tA = vec3(-BOUND).sub(ro).mul(inv);
  const tB = vec3(BOUND).sub(ro).mul(inv);
  const tLo = tA.min(tB);
  const tHi = tA.max(tB);
  const tNear = tLo.x.max(tLo.y).max(tLo.z).max(0);
  const tFar = tHi.x.min(tHi.y).min(tHi.z);
  If(tFar.lessThanEqual(tNear), () => Discard());

  const stepLen = tFar.sub(tNear).div(MARCH_STEPS);
  const t = tNear.toVar();
  const prev = float(0).toVar();
  const tHit = float(-1).toVar();

  Loop(MARCH_STEPS, () => {
    const d = densityAt(ro.add(rd.mul(t)));
    If(d.greaterThanEqual(uIso), () => {
      // linear refine between the last two samples
      const f = uIso.sub(prev).div(d.sub(prev).max(1e-4));
      tHit.assign(t.sub(stepLen.mul(float(1).sub(f))));
      Break();
    });
    prev.assign(d);
    t.addAssign(stepLen);
  });

  If(tHit.lessThan(0), () => Discard());

  const p = ro.add(rd.mul(tHit));
  const e = (2 * BOUND) / GRID; // one voxel
  const n = normalize(
    vec3(
      densityAt(p.sub(vec3(e, 0, 0))).sub(densityAt(p.add(vec3(e, 0, 0)))),
      densityAt(p.sub(vec3(0, e, 0))).sub(densityAt(p.add(vec3(0, e, 0)))),
      densityAt(p.sub(vec3(0, 0, e))).sub(densityAt(p.add(vec3(0, 0, e))))
    )
  );

  // same glass read as RaymarchedMetaballs
  const fres = rd.dot(n).abs().oneMinus().pow(2);
  // aspect-corrected offset: equal normals shift equal PIXELS, not UV
  const refractOffset = n.xy
    .mul(vec2(screenSize.y.div(screenSize.x), 1))
    .mul(uRefract.negate());
  const refracted = sceneTex.sample(screenUV.add(refractOffset));
  const rim = rimTex.sample(screenUV).mul(fres.mul(uRimStrength));
  return refracted.mul(fres.mul(uFresnelStrength).add(uFresnelBase)).add(rim);
})();

const marchMesh = new THREE.Mesh(
  new THREE.BoxGeometry(2 * BOUND, 2 * BOUND, 2 * BOUND), marchMat);
marchMesh.frustumCulled = false;
scene.add(marchMesh);

// ---- conductor → physics ------------------------------------------------------------
const swirl = new Spring({ value: 0.9, target: 0.9, freq: 0.5, zeta: 1.0 });
conductor.voice({
  steps: 8, hits: 3,
  onHit({ accent }) { kickEnv += ctrl.kick * accent; },
});

// ---- jack panel ---------------------------------------------------------------------
rack.add("/room/bpm", bindKey(conductor, "bpm"), { min: 60, max: 160, unit: "bpm" });
rack.add("/flub/flow", bindUniform(uFlowAmt), { min: 0, max: 8 });
rack.add("/flub/flowFreq", bindUniform(uFlowFreq), { min: 0.4, max: 4 });
rack.add("/flub/cohesion", bindUniform(uCohesion), { min: 0.5, max: 6 });
rack.add("/flub/swirl", bindKey(swirl, "target"), { min: 0, max: 3 });
rack.add("/flub/kick", bindKey(ctrl, "kick"), { min: 0, max: 12 });
rack.add("/flub/blobR", bindUniform(uBlobR), { min: 0.18, max: 0.5 });
rack.add("/flub/iso", bindUniform(uIso), { min: 0.3, max: 1.6 });
rack.add("/balls/refract", bindUniform(uRefract), { min: 0, max: 0.6 });
rack.add("/balls/rim", bindUniform(uRimStrength), { min: 0, max: 1 });

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

  kickEnv *= Math.exp(-7 * dt);
  uKick.value = kickEnv;
  uSwirl.value = swirl.update(dt);
  uDt.value = dt;
  uT.value = elapsed;

  renderer.compute(simParticles);
  renderer.compute(splatDensity);

  synth.update(elapsed);
  controls.update();
  placeBackdrop();

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
