// Knot Boom: the spring lives IN the geometry.
//
// knot-morph-lab drives transforms — the whole rigid knot pops/dips on the
// kick, a spring UNDER the shape. Here the shape itself is the instrument:
// every vertex of the torus knot carries a damped spring, coupled to its
// grid neighbours — a Klein-Gordon field on the tube surface, stepped on the
// GPU. Each kick strikes ONE point; the boom radiates through the body as a
// wave, every vertex rings back on its own stiffness, and because the tube
// is a closed loop the pulse laps itself — a delay line made of geometry.
//
// Two compute passes per substep (leapfrog, race-free):
//   passV — v += (c²·lap(u) − w₀²·u − γ·v)·dt + kick·gauss(strike)
//           (reads neighbour u, writes only own v)
//   passU — u += v·dt   (own cell only)
// The mesh's positionNode reads the field and displaces along the normal;
// the whole-object roll/spin stays a cheap JS transform on top.

import * as THREE from "three/webgpu";
import {
  color,
  exp,
  float,
  Fn,
  instancedArray,
  instanceIndex,
  mix,
  normalLocal,
  positionLocal,
  storage,
  uniform,
  vertexIndex,
} from "three/tsl";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { knotMorphPosition } from "../../src/knotMorph.js";
import { Conductor } from "../../src/conductor.js";
import { Rack, bindKey, localStorageAdapter } from "../../src/rack.js";

if (!navigator.gpu) throw new Error("WebGPU unavailable");

// ---- sliders (0..1, real ranges live in the loop mapping) --------------------
const P = {
  boom: { value: 0.8 }, // kick strength — velocity injected at the strike point
  speed: { value: 0.5 }, // wave speed — how fast the boom travels through the body
  stiff: { value: 0.35 }, // per-vertex spring — local ring-back frequency
  damp: { value: 0.35 }, // field damping — how long the body rings
  morph: { value: 1.0 }, // CYCLE × base (2,3)→(3,5) blend, grid-locked, whole body
  mboom: { value: 0.7 }, // field → morph: the wave SHOVES the local blend toward (3,5)
  bump: { value: 0.35 }, // field → flesh: raw displacement along the normal
  glow: { value: 0.7 }, // crest glow — the wave shows in brightness too
  walk: { value: 0.3 }, // strike point walks the loop per hit (golden-ratio steps)
  duck: { value: 0.6 }, // PULSE × brightness (sidechain, straight time)
  spin: { value: 0.5 }, // CYCLE × yaw (turntable)
  roll: { value: 0.2 }, // CYCLE × tilt (nutation on the 2-beat loop)
};

const MORPH_BEATS = 8; // grid-locked base-morph cycle length

// field grid — TorusKnotGeometry segment counts; the field lives on the
// logical TUB×RAD torus (see below)
const TUB = 96;
const RAD = 18;
const CELLS = TUB * RAD;

const FIXED = {
  bpm: 120,
  scale: 0.42,
  wobble: 0.16, // slow aimless sway underneath
  loopBeats: 2,
  kick: 9, // velocity injection at boom=1, accent=1
  sigma: TUB * 0.023, // strike gaussian width (cells — fixed fraction of the loop)
};

// ---- field: one spring per grid cell -----------------------------------------
// TorusKnotGeometry(_,_,TUB,RAD) vertices form a (TUB+1)×(RAD+1) grid with the
// last row/column duplicating the first (the seam). The field lives on the
// logical TUB×RAD torus; seam vertices read the same cell, so it can't tear.
const fU = instancedArray(CELLS, "float"); // displacement along the normal
const fV = instancedArray(CELLS, "float"); // its velocity

const uSimDt = uniform(0);
const uC2 = uniform(0); // wave speed² (cells²/s²)
const uStiff2 = uniform(0); // w₀² — the per-vertex spring
const uDamp = uniform(3);
const uKick = uniform(0); // velocity injection this substep
const uStrikeT = uniform(0); // strike centre, tube cells
const uStrikeR = uniform(0); // strike centre, ring cells

const cellT = instanceIndex.div(RAD);
const cellR = instanceIndex.mod(RAD);

const passV = Fn(() => {
  const t = cellT.toVar();
  const r = cellR.toVar();
  const u = fU.element(instanceIndex);
  const v = fV.element(instanceIndex);

  const tL = t.add(TUB - 1).mod(TUB);
  const tR = t.add(1).mod(TUB);
  const rD = r.add(RAD - 1).mod(RAD);
  const rU = r.add(1).mod(RAD);
  const lap = fU
    .element(tL.mul(RAD).add(r))
    .add(fU.element(tR.mul(RAD).add(r)))
    .add(fU.element(t.mul(RAD).add(rD)))
    .add(fU.element(t.mul(RAD).add(rU)))
    .sub(u.mul(4));

  // wrapped grid distance to the strike; ring axis weighted ×2 (it's the
  // short way round) so the wavefront leaves the strike roughly circular
  const dT0 = t.toFloat().sub(uStrikeT).abs();
  const dT = dT0.min(float(TUB).sub(dT0));
  const dR0 = r.toFloat().sub(uStrikeR).abs();
  const dR = dR0.min(float(RAD).sub(dR0)).mul(2);
  const gauss = exp(
    dT.mul(dT).add(dR.mul(dR)).div(-2 * FIXED.sigma * FIXED.sigma)
  );

  const acc = lap.mul(uC2).sub(u.mul(uStiff2)).sub(v.mul(uDamp));
  v.addAssign(acc.mul(uSimDt).add(gauss.mul(uKick)));
})().compute(CELLS);

const passU = Fn(() => {
  fU.element(instanceIndex).addAssign(
    fV.element(instanceIndex).mul(uSimDt)
  );
})().compute(CELLS);

// ---- stage --------------------------------------------------------------------
const renderer = new THREE.WebGPURenderer({
  canvas: document.getElementById("canvas"),
  antialias: true,
});
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setClearColor(0x000000);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.12;
await renderer.init();

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(
  60,
  window.innerWidth / window.innerHeight,
  0.02,
  100
);
camera.position.set(0, 0.15, 1.35);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.minDistance = 0.05;
controls.target.set(0, 0, 0);

// ---- the struck, morphing knot ---------------------------------------------------
const geo = new THREE.TorusKnotGeometry(1, 0.4, TUB, RAD, 2, 3);
const targetGeo = new THREE.TorusKnotGeometry(1, 0.4, TUB, RAD, 3, 5);
geo.setAttribute(
  "targetPosition",
  new THREE.BufferAttribute(targetGeo.getAttribute("position").array, 3)
);

const WIRE_COLORS = { start: 0x1fb8ff, target: 0x49ffa0 }; // (2,3) → (3,5)

const uDuck = uniform(1);
const uGlow = uniform(0);
const uMix = uniform(0); // base morph blend (grid-locked cycle, JS-computed)
const uMorphBoom = uniform(0); // field → local morph shove
const uBump = uniform(0); // field → normal displacement

// vertex → logical cell (seam row/column folds back onto cell 0).
// separate read-only VIEW over the same buffer — toReadOnly() mutates the
// node it's called on, and the compute passes still need fU writable
const fURead = storage(fU.value, "float", CELLS).toReadOnly();
const vT = vertexIndex.div(RAD + 1).mod(TUB);
const vR = vertexIndex.mod(RAD + 1).mod(RAD);
const fieldU = fURead.element(vT.mul(RAD).add(vR));

const mat = new THREE.MeshBasicNodeMaterial({
  wireframe: true,
  transparent: true,
  blending: THREE.AdditiveBlending,
  depthWrite: false,
});
// the boom carries the MORPH through the body: local blend = slow whole-body
// cycle + the wave's shove toward (3,5). where the front passes, the knot IS
// the other knot for a moment, then rings back. bump adds raw flesh on top.
const mixNode = uMix.add(fieldU.mul(uMorphBoom)).clamp(0, 1);
mat.positionNode = knotMorphPosition({ mixFactor: mixNode }).add(
  normalLocal.mul(fieldU.mul(uBump))
);
// blue→green tracks the local morph (the front shows as colour change);
// crests flash hot white on top as the boom passes
const hot = fieldU.abs().mul(uGlow).clamp(0, 1);
mat.colorNode = mix(color(WIRE_COLORS.start), color(WIRE_COLORS.target), mixNode)
  .add(color(0xeaffff).mul(hot.mul(0.7)))
  .mul(hot.mul(1.1).add(0.16))
  .mul(uDuck);

const mesh = new THREE.Mesh(geo, mat);
mesh.scale.setScalar(FIXED.scale);
scene.add(mesh);

// ---- rhythm ---------------------------------------------------------------------
const conductor = new Conductor({ bpm: FIXED.bpm });
let pendingKick = 0;
let strikeT = 0;
let strikeR = 0;

conductor.voice({
  steps: 4,
  hits: 4,
  onHit({ accent }) {
    pendingKick += FIXED.kick * P.boom.value * accent;
    // the strike walks the loop in golden-ratio steps — no two consecutive
    // booms enter at the same door unless walk is zeroed
    strikeT = (strikeT + P.walk.value * TUB * 0.382) % TUB;
    strikeR = (strikeR + P.walk.value * RAD * 0.382) % RAD;
  },
});

// ---- rack + panel -----------------------------------------------------------------
const rack = new Rack({ storage: localStorageAdapter("knotBoomRack") });
rack.add("/room/bpm", bindKey(conductor, "bpm"), { min: 60, max: 160, unit: "bpm" });

const paramsEl = document.getElementById("params");
for (const label in P) {
  const row = document.createElement("div");
  row.className = "row";
  row.innerHTML = `<label>${label}</label>`;
  const inp = document.createElement("input");
  inp.type = "range";
  inp.min = 0;
  inp.max = 1;
  inp.step = 0.01;
  inp.value = P[label].value;
  const val = document.createElement("span");
  val.className = "val";
  val.textContent = (+P[label].value).toFixed(2);
  inp.addEventListener("input", () => {
    rack.set(`/p/${label}`, +inp.value, 0, "human");
  });
  row.append(inp, val);
  paramsEl.appendChild(row);
  rack.add(`/p/${label}`, {
    get: () => P[label].value,
    set: (v) => {
      P[label].value = v;
      inp.value = v;
      val.textContent = (+v).toFixed(2);
    },
  }, { min: 0, max: 1 });
}
window.rack = rack;

// ---- resize -----------------------------------------------------------------------
window.addEventListener("resize", () => {
  renderer.setSize(window.innerWidth, window.innerHeight);
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
});

// ---- loop -------------------------------------------------------------------------
const SUB = 6; // field substeps per frame (CFL: c·dt/SUB must stay < 1 cell)
const clock = new THREE.Clock();
const beatEl = document.getElementById("beat");
const readoutEl = document.getElementById("readout");

renderer.setAnimationLoop(() => {
  const dt = Math.min(1 / 30, clock.getDelta());
  const elapsed = clock.elapsedTime;

  conductor.update(dt);
  rack.update(dt);
  const pump = conductor.pump(5);

  // slider → physics mapping
  uC2.value = (P.speed.value * TUB * 0.6) ** 2; // cells/s ∝ loop size — same feel at any resolution
  uStiff2.value = (P.stiff.value * 24) ** 2;
  uDamp.value = 0.4 + P.damp.value * 7;
  uGlow.value = P.glow.value * 8;
  // base morph swings the FULL 0→1 over MORPH_BEATS (cos dwells at the two
  // recognizable knots; the 0.5 midpoint blend is mush, pass through it) —
  // the morph slider narrows the swing around 0.5. field shoves on top.
  uMix.value =
    0.5 -
    0.5 *
      P.morph.value *
      Math.cos((conductor.beat * 2 * Math.PI) / MORPH_BEATS);
  uMorphBoom.value = P.mboom.value * 2.5;
  uBump.value = P.bump.value * 1.5;
  uDuck.value = 1 - P.duck.value * 0.6 * (1 - pump);
  uStrikeT.value = strikeT;
  uStrikeR.value = strikeR;

  uSimDt.value = dt / SUB;
  uKick.value = pendingKick / SUB; // injection spread across the substeps
  pendingKick = 0;
  for (let s = 0; s < SUB; s++) {
    renderer.compute(passV);
    renderer.compute(passU);
  }
  uKick.value = 0;

  // the whole-object roll: turntable yaw + nutation on the groove loop —
  // transforms carry the CYCLE, the field carries the PULSE
  const loop = (conductor.beat * 2 * Math.PI) / FIXED.loopBeats;
  mesh.rotation.y += P.spin.value * 0.8 * dt;
  const roll = P.roll.value * 0.35;
  mesh.rotation.x =
    Math.sin(elapsed * 0.21) * FIXED.wobble + Math.sin(loop) * roll;
  mesh.rotation.z =
    Math.sin(elapsed * 0.13 + 1.7) * FIXED.wobble * 0.6 +
    Math.cos(loop) * roll * 0.8;

  beatEl.style.opacity = 0.15 + 0.85 * pump;
  readoutEl.textContent = `${conductor.bpm}bpm · four on the floor · ${TUB}×${RAD} spring field`;

  controls.update();
  renderer.render(scene, camera);
  window.__ready = true;
});
