// examples/anisotropic-fbm-volume/main.js
// The anisotropic-fbm-streaks shader, lifted into a real 3D volume.
//
// Architecture (and why it doesn't hit the old perf wall):
//   bake    — a compute pass writes ridged fBm into a 128³ Storage3DTexture
//             (~2M voxels × 5 simplex octaves — one GPU dispatch, re-run only
//             when a noise knob changes or `evolve` scrolls the domain).
//   sample  — the raymarch reads the texture: cheap trilinear fetches instead
//             of hundreds of live noise evaluations per pixel.
//   aniso   — applied at *sample time* by compressing the Y sample coordinate
//             (slow variation along an axis = features elongated along it), so
//             the isotropic bake serves every anisotropy for free: 1 = cloud
//             mass, 16 = combed filaments. This is the demo's one meaningful
//             axis — it's the example's name.
//
// The 2D version faked depth by integrating the field along Y; here the
// raymarch *is* the integration, along the view ray, so the blurry-thread
// look emerges from actual accumulation — and you can orbit through it.

import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { RaymarchingBox } from "three/addons/tsl/utils/Raymarching.js";
import {
  Fn,
  Loop,
  abs,
  float,
  instanceIndex,
  mix,
  pow,
  texture3D,
  textureStore,
  uniform,
  vec3,
  vec4,
} from "three/tsl";
import * as THREE from "three/webgpu";
import { simplexNoise3 } from "../../src/index.js";

const SIZE = 128;

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
// bake-side (changing these re-dispatches the compute)
const uRidge = uniform(0.85); // billow -> knife-edge
const uGain = uniform(0.5); // fBm spectral slope; 0.5 = 1/f
const uDomain = uniform(4.0); // noise scale inside the bake
const uEvolve = uniform(0.0); // z-domain offset; animated = the volume churns
// sample-side (free, per-frame)
const uAniso = uniform(6.0); // 1 = isotropic cloud, 16 = combed filaments
const uGamma = uniform(2.2); // density shaping: lifts filaments out of the fog
const uIntensity = uniform(2.5);
const uSteps = uniform(96);

// ---- bake: ridged fBm -> 128³ storage texture ---------------------------------------
const storageTexture = new THREE.Storage3DTexture(SIZE, SIZE, SIZE);
storageTexture.generateMipmaps = false;
storageTexture.minFilter = THREE.LinearFilter;
storageTexture.magFilter = THREE.LinearFilter;
storageTexture.name = "fbmVolume";

const ridged = Fn(({ x }) => float(1.0).sub(abs(x).mul(2.0).sub(1.0).abs()));

const bake = Fn(() => {
  const id = instanceIndex;
  const x = id.mod(SIZE);
  const y = id.div(SIZE).mod(SIZE);
  const z = id.div(SIZE * SIZE);

  // voxel centre in [-0.5, 0.5]³, then into the noise domain
  const p = vec3(float(x), float(y), float(z)).add(0.5).div(SIZE).sub(0.5);
  const q = p.mul(uDomain).add(vec3(0.0, 0.0, uEvolve));

  // same ridged fBm as the 2D example
  const sum = float(0.0).toVar();
  const amp = float(1.0).toVar();
  const maxAmp = float(0.0).toVar();
  const freq = float(1.0).toVar();
  Loop(5, () => {
    const n = simplexNoise3({ v: q.mul(freq) });
    const r = mix(abs(n), ridged({ x: n }), uRidge);
    sum.addAssign(r.mul(amp));
    maxAmp.addAssign(amp);
    amp.mulAssign(uGain);
    freq.mulAssign(2.0);
  });

  textureStore(storageTexture, vec3(x, y, z), vec4(sum.div(maxAmp), 0, 0, 1));
});

const bakeNode = bake().compute(SIZE ** 3).setName("bakeFbmVolume");
let bakeDirty = false; // set by knobs; consumed in the render loop

// ---- render: raymarch the baked volume ----------------------------------------------
const tex = texture3D(storageTexture, null, 0);

const volumeColor = Fn(() => {
  const sum = float(0.0).toVar();
  const count = float(0.0).toVar();

  RaymarchingBox(uSteps, ({ positionRay }) => {
    // anisotropy: compress the Y sample coordinate so the field varies slowly
    // along Y -> filaments comb out along the vertical. Coordinates only ever
    // shrink toward the texture's middle slab, so no wrapping seams.
    const q = positionRay.mul(vec3(1.0, float(1.0).div(uAniso), 1.0)).add(0.5);
    const d = tex.sample(q).r;
    sum.addAssign(pow(d, uGamma));
    count.addAssign(1.0);
  });

  const v = sum.div(count).mul(uIntensity);
  return vec4(vec3(v), 1.0);
});

const material = new THREE.NodeMaterial();
material.colorNode = volumeColor();
material.side = THREE.BackSide;
material.transparent = true;

const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), material);
scene.add(mesh);

// ---- panel -------------------------------------------------------------------------
// [label, target, min, max, step, rebake]
const evolveSpeed = { value: 0.06 };
const PARAMS = [
  ["aniso", uAniso, 1, 16, 0.1, false],
  ["gamma", uGamma, 0.5, 5, 0.05, false],
  ["intensity", uIntensity, 0.1, 6, 0.05, false],
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
