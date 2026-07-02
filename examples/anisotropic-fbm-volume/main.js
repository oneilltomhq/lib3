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
  cos,
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
// close enough that the box fills the frame (~0.9 out, 60° FOV): the good
// looks want to be seen from near-inside, not admired from across the room
camera.position.set(0.45, 0.25, 0.75);

const renderer = new THREE.WebGPURenderer({
  canvas: document.getElementById("canvas"),
  antialias: true,
});
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(window.devicePixelRatio);
renderer.setClearColor(0x000000);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;

// ---- auto-orbit: elliptical, non-uniform-speed camera drift --------------------------
// A flat circular auto-rotate reads as mechanical. Earth's orbit isn't a
// circle — it's an ellipse (eccentricity e != 0, sun off-centre at a focus),
// and it sweeps faster near perihelion than aphelion (Kepler's second law:
// equal areas in equal time). We steal both, plus a slow inclination bob so
// the path isn't pinned to one flat plane either. Solved properly (Kepler's
// equation via Newton's method) rather than faked with a sine, so the
// speed-up/slow-down is the real thing, not an approximation of it.
const orbit = {
  active: true,
  center: new THREE.Vector3(0, 0, 0),
  a: camera.position.length(), // semi-major axis, from the starting distance
  e: 0.3, // eccentricity: 0 = circle, closer to 1 = elongated. enough that the
  // faster-near-perihelion sweep is legible, small enough the volume stays framed
  incline: 0.4, // radians, tilt of the orbital plane
  bobAmp: 0.15, // extra vertical bob, layered on top of the tilt
  bobFreq: 2.7, // bob cycles per orbit (non-integer -> the path never repeats flat)
  period: 28, // seconds per orbit at mean motion
  M: 0, // mean anomaly; advances linearly with time
};
let orbitBlend = 0; // 0..1 ease back in after manual interaction, so resuming doesn't snap

function keplerE(M, e) {
  // Newton's method solve of Kepler's equation M = E - e*sin(E)
  let E = M;
  for (let i = 0; i < 5; i++) E -= (E - e * Math.sin(E) - M) / (1 - e * Math.cos(E));
  return E;
}

function orbitPosition() {
  const { a, e, incline, bobAmp, bobFreq, M, center } = orbit;
  const E = keplerE(M, e);
  const bAxis = a * Math.sqrt(1 - e * e);
  const x = a * (Math.cos(E) - e); // the volume sits at the ellipse's focus, not its centre
  const zFlat = bAxis * Math.sin(E);
  const y = zFlat * Math.sin(incline) + bobAmp * Math.sin(M * bobFreq);
  const z = zFlat * Math.cos(incline);
  return new THREE.Vector3(center.x + x, center.y + y, center.z + z);
}

// pause while the user drags/zooms, resume a couple seconds after they let go
let resumeTimer = null;
controls.addEventListener("start", () => {
  orbit.active = false;
  clearTimeout(resumeTimer);
});
controls.addEventListener("end", () => {
  clearTimeout(resumeTimer);
  resumeTimer = setTimeout(() => {
    orbit.a = camera.position.distanceTo(orbit.center); // pick up from wherever they left it
    orbitBlend = 0;
    orbit.active = true;
  }, 2000);
});
const orbitToggle = document.getElementById("orbitToggle");
orbitToggle?.addEventListener("change", () => {
  clearTimeout(resumeTimer);
  if (orbitToggle.checked) {
    orbit.a = camera.position.distanceTo(orbit.center);
    orbitBlend = 0;
  }
  orbit.active = orbitToggle.checked;
});

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
const uSwirl = uniform(0.0); // radians of twist per unit height: 0 = straight
// comb, ~6 = one full turn top-to-bottom — the grain becomes helical, so the
// filaments wind around the core and there's no dead viewing angle
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

    // swirl: rotate the sample point around Y by an angle proportional to its
    // height (a screw transform). A straight vertical filament's preimage
    // under this map is a helix, so the comb direction itself curves.
    // (Rotated corners can sample past the texture edge; the edge fade has
    // already killed density out there, so clamp artifacts stay invisible.)
    const ang = uSwirl.mul(p.y);
    const c = cos(ang);
    const s = sin(ang);
    const pr = vec3(
      p.x.mul(c).sub(p.z.mul(s)),
      p.y,
      p.x.mul(s).add(p.z.mul(c))
    );
    // anisotropy: compress the (twisted) Y sample coordinate so the field
    // varies slowly along the grain -> filaments comb out along it.
    const q = pr.mul(vec3(1.0, float(1.0).div(uAniso), 1.0)).add(0.5);
    const v = tex.sample(q).r;

    // threshold decides what is matter; gamma shapes it; the edge fade
    // dissolves density before it can touch the box walls. Clamp the fade
    // start below the wall: smoothstep(0.5, 0.5, x) is undefined (division by
    // zero) and blanks the whole volume when the slider hits 0.5 exactly.
    const fadeStart = uFade.min(0.495);
    const fade = smoothstep(0.5, fadeStart, abs(p.x))
      .mul(smoothstep(0.5, fadeStart, abs(p.y)))
      .mul(smoothstep(0.5, fadeStart, abs(p.z)));
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
  ["swirl", uSwirl, 0, 12, 0.1, false],
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
const inputs = {};
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
  inputs[label] = { inp, val, target };
}

// ---- presets: the taste archive -----------------------------------------------------
// Config points for the future transition/path work — shader knobs ONLY. Camera
// framing is deliberately a separate concern (it belongs to the higher waypoint
// layer, not to a params preset). ＋ capture snapshots the current knobs;
// ⧉ export copies all presets as JSON to the clipboard/console.
const PRESETS = {
  "ghost smoke": {
    aniso: 2.6, swirl: 0, thresh: 0.33, gamma: 2.1, density: 16,
    intensity: 2.6, fade: 0.12, steps: 32, ridge: 0.68, gain: 0.44,
    domain: 2, evolve: 0.21,
  },
  "silk veil": {
    aniso: 8.8, swirl: 2.7, thresh: 0.11, gamma: 3.35, density: 14.5,
    intensity: 1.1, fade: 0.04, steps: 32, ridge: 0.68, gain: 0.44,
    domain: 3.5, evolve: 0.21,
  },
  // Fable's proposed third: the sparse/wound corner the other two don't reach.
  // High thresh empties space so matter reads as distinct spiralling tendrils;
  // full swirl winds them; sharper ridge makes them filamentary. Completes a
  // swirl arc 0 -> 2.7 -> 9 for the coming 3-way transitions. thresh is the
  // most extrapolated knob — if it comes out too empty/black, drop it toward
  // 0.36; too full, raise toward 0.48.
  vortex: {
    aniso: 6.0, swirl: 9.0, thresh: 0.42, gamma: 3.0, density: 20,
    intensity: 2.0, fade: 0.10, steps: 32, ridge: 0.75, gain: 0.42,
    domain: 3.5, evolve: 0.21,
  },
  // Tom's find, descended from vortex but thinned right out (density 7 — below
  // anything the others reach, so it's not on the line between them) and
  // brightened (intensity 3) so the sparse matter glows; evolve maxed for fast
  // churn. Authored to be seen from near-inside, but that framing is the
  // camera's business, not the preset's — presets are shader knobs only.
  ember: {
    aniso: 2.3, swirl: 5.4, thresh: 0.42, gamma: 3.0, density: 7,
    intensity: 3.0, fade: 0.1, steps: 32, ridge: 0.75, gain: 0.42,
    domain: 3.5, evolve: 0.4,
  },
};

// presets are shader knobs only — camera framing is a separate concern (kept
// for the future waypoint layer, not baked into a params preset)
function snapshotParams() {
  const s = {};
  for (const label in inputs) s[label] = +inputs[label].target.value;
  return s;
}

function applyParams(p) {
  for (const label in inputs) {
    if (p[label] === undefined) continue;
    const { inp, val, target } = inputs[label];
    target.value = p[label];
    inp.value = p[label];
    val.textContent = (+p[label]).toFixed(2);
  }
  bakeDirty = true; // cheap, and covers any bake-side keys that changed
}

const presetsEl = document.getElementById("presets");
let captureCount = 0;
function addPresetButton(name) {
  const b = document.createElement("button");
  b.textContent = name;
  b.onclick = () => applyParams(PRESETS[name]);
  presetsEl.insertBefore(b, capBtn);
}
const capBtn = document.createElement("button");
capBtn.className = "op";
capBtn.textContent = "＋ capture";
const expBtn = document.createElement("button");
expBtn.className = "op";
expBtn.textContent = "⧉ export";
presetsEl.append(capBtn, expBtn);
for (const name in PRESETS) addPresetButton(name);
capBtn.onclick = () => {
  const name = `capture ${++captureCount}`;
  PRESETS[name] = snapshotParams();
  addPresetButton(name);
};
expBtn.onclick = () => {
  const text = JSON.stringify(PRESETS, null, 2);
  console.log("[fbm-volume presets]\n" + text);
  navigator.clipboard?.writeText(text).catch(() => {});
};

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

    if (orbit.active) {
      orbit.M += (dt * Math.PI * 2) / orbit.period;
      orbitBlend = Math.min(1, orbitBlend + dt / 1.2); // ease in over ~1.2s, no hard snap
      camera.position.lerp(orbitPosition(), orbitBlend);
      camera.lookAt(orbit.center);
    }
    controls.update();
    renderer.render(scene, camera);
  });
});
