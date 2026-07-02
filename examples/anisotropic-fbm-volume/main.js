// examples/anisotropic-fbm-volume/main.js
// The anisotropic-fbm-streaks shader, lifted into a real 3D volume.
//
// Architecture (and why it doesn't hit the old perf wall):
//   bake    — a compute pass writes ridged fBm into a 128³ Storage3DTexture
//             (~2M voxels × 5 simplex octaves — one GPU dispatch, re-run only
//             when a noise knob changes or `evolve` is churning).
//   sample  — the raymarch reads the texture: cheap trilinear fetches instead
//             of hundreds of live noise evaluations per pixel.
//   aniso   — applied at *sample time* by compressing the Y sample coordinate
//             (slow variation along an axis = features elongated along it), so
//             the isotropic bake serves every anisotropy for free: 1 = cloud
//             mass, 16 = combed filaments.
//
// Rendering is front-to-back emission/absorption (not an average): a density
// threshold decides what counts as matter, near filaments occlude far ones,
// an edge fade dissolves the volume before it reaches the box walls, and the
// ray start is jittered per-pixel to melt step banding. `evolve` scrolls each
// fBm octave in a different direction at a different speed, so the field
// genuinely churns instead of sliding.

import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import {
  Break,
  Fn,
  If,
  Loop,
  abs,
  cameraPosition,
  dot,
  float,
  fract,
  instanceIndex,
  int,
  max,
  min,
  mix,
  modelWorldMatrixInverse,
  positionGeometry,
  pow,
  screenUV,
  sin,
  smoothstep,
  texture3D,
  textureStore,
  uniform,
  varying,
  vec2,
  vec3,
  vec4,
} from "three/tsl";
import * as THREE from "three/webgpu";
import { simplexNoise3 } from "../../src/index.js";

const SIZE = 128;
const OCTAVES = 5;

// ---- scene / renderer ------------------------------------------------------------
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(
  60,
  window.innerWidth / window.innerHeight,
  0.1,
  100
);
camera.position.set(0.9, 0.5, 1.6);

const renderer = new THREE.WebGPURenderer({
  canvas: document.getElementById("canvas"),
  antialias: true,
});
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(window.devicePixelRatio);
renderer.setClearColor(0x000000);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.autoRotate = true;
controls.autoRotateSpeed = 0.6;

// ---- uniforms ----------------------------------------------------------------------
// Defaults are Tom's "ghost smoke" find (2026-07-02): big slow forms
// (domain 2), solid-cored wisps with soft skins (thresh .33 / density 16),
// and — counterintuitively — LOW steps: 32 steps + the ray jitter reads as
// soft film grain rather than banding, and carries much of the look.
// bake-side (changing these re-dispatches the compute)
const uRidge = uniform(0.68); // billow -> knife-edge
const uGain = uniform(0.44); // fBm spectral slope; 0.5 = 1/f
const uDomain = uniform(2.0); // noise scale inside the bake
const uEvolve = uniform(0.0); // churn phase; each octave drifts differently
// sample-side (free, per-frame)
const uAniso = uniform(2.6); // 1 = isotropic cloud, 16 = combed filaments
const uThresh = uniform(0.33); // below this is empty space, not matter
const uGamma = uniform(2.1); // density shaping above the threshold
const uDensity = uniform(16.0); // absorption strength (how solid matter is)
const uIntensity = uniform(2.6);
const uFade = uniform(0.12); // |coord| where the edge dissolve begins (wall = 0.5)
const uSteps = uniform(32);

// ---- bake: ridged fBm -> 128³ storage texture ---------------------------------------
const storageTexture = new THREE.Storage3DTexture(SIZE, SIZE, SIZE);
storageTexture.generateMipmaps = false;
storageTexture.minFilter = THREE.LinearFilter;
storageTexture.magFilter = THREE.LinearFilter;
storageTexture.name = "fbmVolume";

// per-octave drift directions/speeds: decorrelating the octaves over time is
// what makes `evolve` a churn (the field morphs) rather than a slide
const DRIFT = [
  { dir: [0.0, 0.2, 1.0], speed: 1.0 },
  { dir: [0.8, -0.3, -0.6], speed: 1.6 },
  { dir: [-0.6, 0.9, 0.3], speed: 2.3 },
  { dir: [0.4, -1.0, 0.5], speed: 3.1 },
  { dir: [-0.9, 0.1, -0.8], speed: 4.0 },
];

const ridged = Fn(({ x }) => float(1.0).sub(abs(x).mul(2.0).sub(1.0).abs()));

const bake = Fn(() => {
  const id = instanceIndex;
  const x = id.mod(SIZE);
  const y = id.div(SIZE).mod(SIZE);
  const z = id.div(SIZE * SIZE);

  // voxel centre in [-0.5, 0.5]³, then into the noise domain
  const p = vec3(float(x), float(y), float(z)).add(0.5).div(SIZE).sub(0.5);
  const q = p.mul(uDomain);

  // ridged fBm, unrolled so each octave gets its own drift vector; the
  // amplitude normalizer is gain-dependent, so it accumulates as a node too
  let sum = float(0.0);
  let ampSum = float(0.0);
  let amp = float(1.0);
  let freq = 1.0;
  for (let o = 0; o < OCTAVES; o++) {
    const { dir, speed } = DRIFT[o];
    const off = vec3(...dir).mul(uEvolve.mul(speed));
    const n = simplexNoise3({ v: q.mul(freq).add(off) });
    const r = mix(abs(n), ridged({ x: n }), uRidge);
    sum = sum.add(r.mul(amp));
    ampSum = ampSum.add(amp);
    amp = amp.mul(uGain);
    freq *= 2.0;
  }

  textureStore(storageTexture, vec3(x, y, z), vec4(sum.div(ampSum), 0, 0, 1));
});

const bakeNode = bake().compute(SIZE ** 3).setName("bakeFbmVolume");
let bakeDirty = false; // set by knobs; consumed in the render loop

// ---- render: front-to-back emission/absorption march --------------------------------
const tex = texture3D(storageTexture, null, 0);

const volumeColor = Fn(() => {
  // ray in the box's local space (the unit-cube trick from src/raymarch.js)
  const vOrigin = varying(
    vec3(modelWorldMatrixInverse.mul(vec4(cameraPosition, 1.0)))
  );
  const vDirection = varying(positionGeometry.sub(vOrigin));
  const rayDir = vDirection.normalize();

  // slab intersection with the unit box
  const invDir = rayDir.reciprocal();
  const tmin = vec3(-0.5).sub(vOrigin).mul(invDir);
  const tmax = vec3(0.5).sub(vOrigin).mul(invDir);
  const tlo = min(tmin, tmax);
  const thi = max(tmin, tmax);
  const t0 = max(max(tlo.x, max(tlo.y, tlo.z)), 0.0);
  const t1 = min(thi.x, min(thi.y, thi.z));
  t0.greaterThanEqual(t1).discard();

  const stepLen = t1.sub(t0).div(uSteps);
  // per-pixel jitter of the ray start melts step banding into grain
  const jitter = fract(
    sin(dot(screenUV, vec2(12.9898, 78.233))).mul(43758.5453)
  );
  const t = float(t0.add(stepLen.mul(jitter))).toVar();

  const light = float(0.0).toVar(); // accumulated emission
  const trans = float(1.0).toVar(); // remaining transmittance

  Loop({ type: "int", start: int(0), end: int(uSteps) }, () => {
    If(t.greaterThan(t1), () => Break());
    const p = vOrigin.add(rayDir.mul(t));

    // anisotropy: compress the Y sample coordinate so the field varies slowly
    // along Y -> filaments comb out along the vertical. Coordinates only ever
    // shrink toward the texture's middle slab, so no wrapping seams.
    const q = p.mul(vec3(1.0, float(1.0).div(uAniso), 1.0)).add(0.5);
    const v = tex.sample(q).r;

    // threshold decides what is matter; gamma shapes it; the edge fade
    // dissolves density before it can touch the box walls
    const fade = smoothstep(0.5, uFade, abs(p.x))
      .mul(smoothstep(0.5, uFade, abs(p.y)))
      .mul(smoothstep(0.5, uFade, abs(p.z)));
    const d = pow(smoothstep(uThresh, 1.0, v), uGamma).mul(fade);

    // front-to-back compositing: near filaments occlude far ones
    const a = d.mul(uDensity).mul(stepLen).clamp(0.0, 1.0);
    light.addAssign(trans.mul(a));
    trans.mulAssign(float(1.0).sub(a));
    If(trans.lessThan(0.02), () => Break());

    t.addAssign(stepLen);
  });

  const out = light.mul(uIntensity);
  return vec4(vec3(out), light.clamp(0.0, 1.0));
});

const material = new THREE.NodeMaterial();
material.colorNode = volumeColor();
material.side = THREE.BackSide;
material.transparent = true;

const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), material);
scene.add(mesh);

// ---- panel -------------------------------------------------------------------------
// [label, target, min, max, step, rebake]
const evolveSpeed = { value: 0.21 };
const PARAMS = [
  ["aniso", uAniso, 1, 16, 0.1, false],
  ["thresh", uThresh, 0, 0.8, 0.01, false],
  ["gamma", uGamma, 0.5, 5, 0.05, false],
  ["density", uDensity, 1, 40, 0.5, false],
  ["intensity", uIntensity, 0.1, 4, 0.05, false],
  ["fade", uFade, 0, 0.5, 0.01, false],
  ["steps", uSteps, 16, 160, 1, false],
  ["ridge", uRidge, 0, 1, 0.01, true],
  ["gain", uGain, 0.3, 0.8, 0.01, true],
  ["domain", uDomain, 2, 8, 0.1, true],
  ["evolve", evolveSpeed, 0, 0.4, 0.01, false],
];

const paramsEl = document.getElementById("params");
for (const [label, target, min, max, step, rebake] of PARAMS) {
  const row = document.createElement("div");
  row.className = "row";
  row.innerHTML = `<label>${label}</label>`;
  const inp = document.createElement("input");
  inp.type = "range";
  inp.min = min; inp.max = max; inp.step = step; inp.value = target.value;
  const val = document.createElement("span");
  val.className = "val";
  val.textContent = (+target.value).toFixed(2);
  inp.addEventListener("input", () => {
    target.value = +inp.value;
    val.textContent = (+inp.value).toFixed(2);
    if (rebake) bakeDirty = true;
  });
  row.append(inp, val);
  paramsEl.appendChild(row);
}

// ---- resize + loop --------------------------------------------------------------------
function onResize() {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
}
window.addEventListener("resize", onResize);

const fpsEl = document.getElementById("fps");
let frames = 0;
let fpsClock = 0;

const clock = new THREE.Clock();

renderer.init().then(async () => {
  await renderer.computeAsync(bakeNode);
  renderer.setAnimationLoop(() => {
    const dt = Math.min(0.05, clock.getDelta());

    if (evolveSpeed.value > 0) {
      uEvolve.value += dt * evolveSpeed.value;
      bakeDirty = true; // per-frame re-bake: the churn experiment
    }
    if (bakeDirty) {
      renderer.compute(bakeNode);
      bakeDirty = false;
    }

    frames++;
    fpsClock += dt;
    if (fpsClock >= 1) {
      fpsEl.textContent = `${Math.round(frames / fpsClock)} fps`;
      frames = 0;
      fpsClock = 0;
    }

    controls.update();
    renderer.render(scene, camera);
  });
});
