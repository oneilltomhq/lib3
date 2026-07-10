// examples/verlet-clapper/main.js
// VERLET CLAPPER — shaft dynamics as the signature of the piece.
//
// A wandering anchor (slow lissajous, supernatural) drives a verlet chain
// with bending stiffness (reactive, material). The product is the TIP: lag,
// S-curves, whip-crack overshoot — organic acceleration no hand-authored
// curve gives. Everything downstream inherits it:
//
//   CPU  chain (~15 points, costs nothing)      →  tipPos / tipVel / |tipAccel|
//   GPU  swarm (flubber proxy, one compute)     ←  uniforms, per frame
//
// The swarm doesn't chase a point — it chases a ring buffer of recent tip
// positions (each particle picks its own lag), smeared along tipVel. Lag =
// body. And when |tipAccel| spikes past threshold — the whip-crack — the
// DISCHARGE fires: the swarm blows outward, the shaft burns white. Free
// choreography, physically motivated: nobody scheduled the flash, the
// material did.
//
// The two dials that matter: BEND (weak = whip, strong = rod) and solver
// ITERATIONS (more = stiffer, snappier). Everything else is seasoning.

import * as THREE from "three/webgpu";
import {
  Fn, uniform, uniformArray, instancedArray, instanceIndex,
  attribute, float, int, vec3, mix, hash, vertexIndex,
} from "three/tsl";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { VerletChain, TipProbe } from "./verlet.js";

const TAU = Math.PI * 2;

// ---- scene / renderer ---------------------------------------------------------
const canvas = document.getElementById("canvas");
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x04050a);
const camera = new THREE.PerspectiveCamera(60, 1, 0.01, 100);
camera.position.set(0.5, 0.1, 4.1);

const renderer = new THREE.WebGPURenderer({ canvas, antialias: true });
const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, -0.1, 0);
controls.enableDamping = true;

// ---- the shaft -----------------------------------------------------------------
const ANCHOR = new THREE.Vector3(0, 0.6, 0);
const chain = new VerletChain({ points: 12, length: 1.7 });
const probe = new TipProbe({ smooth: 40 });
probe.reset(chain.tip());

const P = {
  wanderRate: 1.0, // playback speed of the anchor's lissajous
  wanderSize: 0.45,
  pull: 9, // swarm spring toward its trail target
  smear: 0.55, // how far tipVel stretches the target kernel
  jitter: 1.1,
  threshold: 0.55, // discharge: normalized |tipAccel| trip point
};

// anchor wander: slow 3-axis lissajous at near-irrational ratios — never
// repeats convincingly, reads as intent rather than orbit
let wanderT = 0;
function wanderInto(out) {
  const r = P.wanderSize;
  out.set(
    ANCHOR.x + Math.sin(TAU * 0.110 * wanderT) * r,
    ANCHOR.y + Math.sin(TAU * 0.073 * wanderT + 1.7) * r * 0.45,
    ANCHOR.z + Math.sin(TAU * 0.157 * wanderT + 4.1) * r * 0.8
  );
}

// the crack: a fast out-and-back stroke overlaid on the anchor. The reversal
// is what loads the shaft — bend constraints store the turn, the tip unloads.
let flick = null;
function crack() {
  flick = { t: 0, dur: 0.34, amp: 0.65 + Math.random() * 0.25, th: Math.random() * TAU };
}
function flickInto(out) {
  if (!flick) return;
  const u = flick.t / flick.dur;
  if (u >= 1) { flick = null; return; }
  const s = Math.sin(Math.PI * u) * flick.amp;
  out.x += Math.cos(flick.th) * s;
  out.y -= 0.55 * s;
  out.z += Math.sin(flick.th) * s;
}
window.__crack = crack;

// ---- shaft rendering: spline through the joints, coloured by stored energy -------
const SAMPLES = 384;
const MAX_P = 40;
const _v = new THREE.Vector3();

function additivePointsMat() {
  return new THREE.PointsNodeMaterial({
    blending: THREE.AdditiveBlending,
    transparent: true,
    depthWrite: false,
    depthTest: false,
    sizeAttenuation: false,
  });
}

const uFlash = uniform(0); // discharge envelope, shared by shaft + swarm
const uTipHeat = uniform(0); // normalized |tipAccel|, 0..1

let curve = new THREE.CatmullRomCurve3(chain.pos, false, "catmullrom", 0.5);

const shaftGeo = new THREE.BufferGeometry();
shaftGeo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(SAMPLES * 3), 3));
shaftGeo.setAttribute("color", new THREE.BufferAttribute(new Float32Array(SAMPLES * 3), 3));
const shaftMat = additivePointsMat();
shaftMat.colorNode = attribute("color", "vec3").mul(uFlash.mul(2.2).add(0.7));
shaftMat.size = 5;
const shaft = new THREE.Points(shaftGeo, shaftMat);

const jointGeo = new THREE.BufferGeometry();
jointGeo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(MAX_P * 3), 3));
jointGeo.setAttribute("color", new THREE.BufferAttribute(new Float32Array(MAX_P * 3), 3));
const jointMat = additivePointsMat();
jointMat.colorNode = attribute("color", "vec3").mul(uFlash.mul(2).add(0.8));
jointMat.size = 8;
const joints = new THREE.Points(jointGeo, jointMat);

// the clapper: one fat point, glowing with |tipAccel|
const tipGeo = new THREE.BufferGeometry();
tipGeo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(3), 3));
const tipMat = additivePointsMat();
tipMat.colorNode = mix(vec3(0.35, 0.5, 1.1), vec3(1.25, 1.25, 1.35), uTipHeat.add(uFlash).clamp(0, 1))
  .mul(uTipHeat.mul(1.6).add(0.7));
tipMat.size = 16;
const tipPoint = new THREE.Points(tipGeo, tipMat);

// tip trail: the signature, drawn. Oldest → dimmest.
const TRAIL_N = 180;
const trailArr = new Float32Array(TRAIL_N * 3);
const trailGeo = new THREE.BufferGeometry();
trailGeo.setAttribute("position", new THREE.BufferAttribute(trailArr, 3));
{
  const fade = new Float32Array(TRAIL_N * 3);
  for (let i = 0; i < TRAIL_N; i++) {
    const a = Math.pow(i / (TRAIL_N - 1), 2.2);
    fade[i * 3] = 0.3 * a; fade[i * 3 + 1] = 0.45 * a; fade[i * 3 + 2] = 1.0 * a;
  }
  trailGeo.setAttribute("color", new THREE.BufferAttribute(fade, 3));
}
const trailMat = additivePointsMat();
trailMat.colorNode = attribute("color", "vec3").mul(1.3);
trailMat.size = 3;
const trail = new THREE.Points(trailGeo, trailMat);

const shaftGroup = new THREE.Group();
shaftGroup.add(shaft, joints, tipPoint, trail);
scene.add(shaftGroup);

function refreshShaftGeometry() {
  curve = new THREE.CatmullRomCurve3(chain.pos, false, "catmullrom", 0.5);
  jointGeo.setDrawRange(0, chain.points);
  // park the trail on the new tip so it doesn't streak across the rebuild
  const t = chain.tip();
  for (let i = 0; i < TRAIL_N; i++) trailArr.set([t.x, t.y, t.z], i * 3);
}
refreshShaftGeometry();

const COLD = new THREE.Color(0.16, 0.3, 0.85);
const HOT = new THREE.Color(1.2, 1.22, 1.3);
const _c = new THREE.Color();

function drawShaft() {
  const n = chain.points;
  const posA = shaftGeo.attributes.position.array;
  const colA = shaftGeo.attributes.color.array;
  // joint energies once, then lerped along the spline
  const energy = [];
  for (let i = 0; i < n; i++) {
    const e = Math.min(1, chain.bendEnergy(i) * 6); // gain: subtle flex still reads
    energy.push(Math.pow(e, 0.6));
  }
  for (let s = 0; s < SAMPLES; s++) {
    const t = s / (SAMPLES - 1);
    curve.getPoint(t, _v);
    posA[s * 3] = _v.x; posA[s * 3 + 1] = _v.y; posA[s * 3 + 2] = _v.z;
    const f = t * (n - 1);
    const i = Math.min(n - 2, f | 0);
    const e = energy[i] + (energy[i + 1] - energy[i]) * (f - i);
    _c.copy(COLD).lerp(HOT, e);
    colA[s * 3] = _c.r; colA[s * 3 + 1] = _c.g; colA[s * 3 + 2] = _c.b;
  }
  shaftGeo.attributes.position.needsUpdate = true;
  shaftGeo.attributes.color.needsUpdate = true;

  const jp = jointGeo.attributes.position.array;
  const jc = jointGeo.attributes.color.array;
  for (let i = 0; i < n; i++) {
    const p = chain.pos[i];
    jp[i * 3] = p.x; jp[i * 3 + 1] = p.y; jp[i * 3 + 2] = p.z;
    _c.copy(COLD).lerp(HOT, energy[i]);
    jc[i * 3] = _c.r; jc[i * 3 + 1] = _c.g; jc[i * 3 + 2] = _c.b;
  }
  jointGeo.attributes.position.needsUpdate = true;
  jointGeo.attributes.color.needsUpdate = true;

  const tip = chain.tip();
  tipGeo.attributes.position.array.set([tip.x, tip.y, tip.z]);
  tipGeo.attributes.position.needsUpdate = true;

  trailArr.copyWithin(0, 3);
  trailArr.set([tip.x, tip.y, tip.z], (TRAIL_N - 1) * 3);
  trailGeo.attributes.position.needsUpdate = true;
}

// ---- the swarm: GPU flubber proxy ------------------------------------------------
// The whole CPU→GPU bridge is these uniforms — a tiny sim driving a big one.
const COUNT = 6144;
const TRAIL_K = 16;

const uTip = uniform(new THREE.Vector3());
const uTipVel = uniform(new THREE.Vector3());
const uTrail = uniformArray(
  Array.from({ length: TRAIL_K }, () => new THREE.Vector3()), "vec3");
const uDt = uniform(0);
const uTime = uniform(0);
const uPull = uniform(P.pull);
const uSmear = uniform(P.smear);
const uJitter = uniform(P.jitter);

const sPos = instancedArray(COUNT, "vec3");
const sVel = instancedArray(COUNT, "vec3");

const swarmInit = Fn(() => {
  const p = sPos.element(instanceIndex);
  p.assign(vec3(
    hash(instanceIndex).sub(0.5),
    hash(instanceIndex.add(1)).sub(0.5),
    hash(instanceIndex.add(2)).sub(0.5)
  ).mul(2.2));
  sVel.element(instanceIndex).assign(vec3(0));
})().compute(COUNT);

const swarmStep = Fn(() => {
  const p = sPos.element(instanceIndex);
  const v = sVel.element(instanceIndex);
  const h1 = hash(instanceIndex);
  const h2 = hash(instanceIndex.add(101));
  const h3 = hash(instanceIndex.add(20233));

  // each particle chases its own memory of the tip (lag = body, not point),
  // smeared along tipVel — behind drags, ahead anticipates
  const trailPt = uTrail.element(int(h1.mul(TRAIL_K - 0.01)));
  const target = trailPt
    .add(uTipVel.mul(uSmear.mul(h2.mul(1.5).sub(0.25))))
    .add(vec3(h1.sub(0.5), h2.sub(0.5), h3.sub(0.5)).mul(0.24));

  v.addAssign(target.sub(p).mul(uPull).mul(uDt));

  // simmer: cheap per-particle wander
  const ph = uTime.mul(1.9).add(h3.mul(TAU * 4));
  v.addAssign(vec3(ph.sin(), ph.mul(1.31).add(2.1).sin(), ph.mul(0.73).add(4.2).sin())
    .mul(uJitter).mul(h2.mul(0.8).add(0.2)).mul(uDt));

  // DISCHARGE: whip-crack blows the body outward from the tip
  const fromTip = p.sub(uTip);
  const d = fromTip.length().add(0.2);
  v.addAssign(fromTip.div(d).mul(uFlash.mul(uFlash)).mul(uDt.mul(46)).div(d));

  v.mulAssign(uDt.mul(-3.2).exp());
  p.addAssign(v.mul(uDt));
})().compute(COUNT);

// render side reads by vertexIndex: Points draw vertices, not instances
const swarmMat = additivePointsMat();
swarmMat.positionNode = sPos.element(vertexIndex);
{
  const speed = sVel.element(vertexIndex).length();
  const heat = speed.mul(0.3).clamp(0, 1).add(uFlash).clamp(0, 1);
  swarmMat.colorNode = mix(vec3(0.1, 0.16, 0.5), vec3(0.85, 0.9, 1.2), heat)
    .mul(uFlash.mul(1.6).add(0.5));
}
swarmMat.size = 2.5;
const swarmGeo = new THREE.BufferGeometry();
swarmGeo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(COUNT * 3), 3));
const swarm = new THREE.Points(swarmGeo, swarmMat);
scene.add(swarm);

// ---- discharge director ------------------------------------------------------------
// aN = |tipAccel| / (|tipAccel| + K): 0..1 whatever the units — thresholdable
const ACC_K = 25;
let flash = 0;
let refractory = 0;
let strikes = 0;

// ---- meter: |tipAccel| history + trip line -----------------------------------------
const meter = document.getElementById("meter");
const mctx = meter.getContext("2d");
const HIST_N = meter.width;
const hist = new Float32Array(HIST_N);
const flashHist = new Uint8Array(HIST_N);

function drawMeter(aN) {
  hist.copyWithin(0, 1); hist[HIST_N - 1] = aN;
  flashHist.copyWithin(0, 1); flashHist[HIST_N - 1] = flash > 0.9 ? 1 : 0;
  const w = meter.width, h = meter.height;
  mctx.clearRect(0, 0, w, h);
  mctx.strokeStyle = "#2a3350";
  mctx.beginPath();
  const ty = h - P.threshold * h;
  mctx.moveTo(0, ty); mctx.lineTo(w, ty); mctx.stroke();
  mctx.strokeStyle = "#8fb0ff";
  mctx.beginPath();
  for (let i = 0; i < HIST_N; i++) {
    const y = h - hist[i] * h;
    i ? mctx.lineTo(i, y) : mctx.moveTo(i, y);
  }
  mctx.stroke();
  mctx.fillStyle = "#ffffff";
  for (let i = 0; i < HIST_N; i++) if (flashHist[i]) mctx.fillRect(i, 0, 1, h);
}

// ---- UI -------------------------------------------------------------------------
const $ = (id) => document.getElementById(id);

$("crack").addEventListener("click", crack);
window.addEventListener("keydown", (e) => { if (e.key === "c") crack(); });
canvas.addEventListener("dblclick", crack);

// material presets: same chain, different constraint character
const PRESETS = {
  whip:    { points: 16, bend: 0.04, iterations: 8,  tipMass: 2,  drag: 0.998, gravity: 0.5 },
  hose:    { points: 12, bend: 0.3,  iterations: 12, tipMass: 4,  drag: 0.99,  gravity: 1.4 },
  rod:     { points: 10, bend: 0.92, iterations: 34, tipMass: 5,  drag: 0.985, gravity: 0.6 },
  clapper: { points: 8,  bend: 0.7,  iterations: 22, tipMass: 18, drag: 0.995, gravity: 2.4 },
};
function applyPreset(name) {
  Object.assign(chain, PRESETS[name]);
  rebuildChain();
  refreshUI();
  for (const n in PRESETS) $(`preset-${n}`).classList.toggle("on", n === name);
}
for (const n in PRESETS) $(`preset-${n}`).addEventListener("click", () => applyPreset(n));

for (const m of ["shaft", "swarm", "both"]) {
  $(`view-${m}`).addEventListener("click", () => {
    shaftGroup.visible = m !== "swarm";
    swarm.visible = m !== "shaft";
    for (const k of ["shaft", "swarm", "both"])
      $(`view-${k}`).classList.toggle("on", k === m);
  });
}

// re-hang from the anchor's CURRENT wander position — no teleport transient,
// no phantom discharge at t=0
const rebuildChain = () => {
  wanderInto(chain.anchor);
  chain.rebuild();
  probe.reset(chain.tip());
  refreshShaftGeometry();
  refractory = 0.5;
};

// [label, min, max, step, get, set]
const SPECS = [
  ["material (the two dials + seasoning)", [
    ["bend stiffness", 0, 1, 0.01, () => chain.bend, (v) => (chain.bend = v)],
    ["iterations", 1, 40, 1, () => chain.iterations, (v) => (chain.iterations = v | 0)],
    ["tip mass", 1, 30, 0.5, () => chain.tipMass, (v) => chain.setTipMass(v)],
    ["points", 4, 24, 1, () => chain.points, (v) => { chain.points = v | 0; rebuildChain(); }],
    ["drag", 0.95, 1, 0.001, () => chain.drag, (v) => (chain.drag = v)],
    ["gravity", 0, 4, 0.05, () => chain.gravity, (v) => (chain.gravity = v)],
  ]],
  ["anchor (the supernatural layer)", [
    ["wander rate", 0, 3, 0.01, () => P.wanderRate, (v) => (P.wanderRate = v)],
    ["wander size", 0, 1.2, 0.01, () => P.wanderSize, (v) => (P.wanderSize = v)],
  ]],
  ["swarm (flubber proxy)", [
    ["pull", 0, 20, 0.1, () => uPull.value, (v) => (uPull.value = v)],
    ["smear (tipVel)", 0, 1.5, 0.01, () => uSmear.value, (v) => (uSmear.value = v)],
    ["jitter", 0, 3, 0.05, () => uJitter.value, (v) => (uJitter.value = v)],
  ]],
  ["discharge", [
    ["threshold", 0.2, 0.95, 0.01, () => P.threshold, (v) => (P.threshold = v)],
  ]],
];

const uiRefreshers = [];
function refreshUI() { for (const f of uiRefreshers) f(); }

const controlsEl = $("controls");
for (const [title, rows] of SPECS) {
  const g = document.createElement("div");
  g.className = "grp";
  g.innerHTML = `<h2>${title}</h2>`;
  for (const [label, min, max, step, get, set] of rows) {
    const row = document.createElement("div");
    row.className = "row";
    row.innerHTML = `<label>${label}</label>`;
    const inp = document.createElement("input");
    inp.type = "range";
    inp.min = min; inp.max = max; inp.step = step; inp.value = get();
    const val = document.createElement("span");
    val.className = "val";
    const fmt = (x) => (+x).toFixed(step >= 1 ? 0 : step >= 0.01 ? 2 : 3);
    val.textContent = fmt(get());
    inp.addEventListener("input", () => { set(+inp.value); val.textContent = fmt(inp.value); });
    uiRefreshers.push(() => { inp.value = get(); val.textContent = fmt(get()); });
    row.appendChild(inp);
    row.appendChild(val);
    g.appendChild(row);
  }
  controlsEl.appendChild(g);
}
applyPreset("hose");

// ---- resize + loop ---------------------------------------------------------------
function resize() {
  const r = canvas.parentElement.getBoundingClientRect();
  renderer.setSize(r.width, r.height, false);
  camera.aspect = r.width / r.height;
  camera.updateProjectionMatrix();
}
addEventListener("resize", resize);

const H = 1 / 240; // fixed sim step: derivatives stay clean at any frame rate
let simAcc = 0;
const clock = new THREE.Clock();

function animate() {
  const dt = Math.min(0.05, clock.getDelta());
  uTime.value += dt;

  // CPU shaft, substepped
  simAcc += dt;
  while (simAcc >= H) {
    simAcc -= H;
    wanderT += H * P.wanderRate;
    wanderInto(chain.anchor);
    if (flick) { flick.t += H; flickInto(chain.anchor); }
    chain.step(H);
    probe.feed(chain.tip(), H);
  }

  // tip signals → uniforms (the whole bridge)
  const aN = probe.accMag / (probe.accMag + ACC_K);
  uTipHeat.value = aN;
  uTip.value.copy(chain.tip());
  uTipVel.value.copy(probe.vel);
  for (let k = 0; k < TRAIL_K; k++) {
    const i = Math.max(0, TRAIL_N - 1 - k * 8) * 3;
    uTrail.array[k].set(trailArr[i], trailArr[i + 1], trailArr[i + 2]);
  }

  // discharge: |tipAccel| spike = whip-crack = flash
  refractory -= dt;
  if (aN > P.threshold && refractory <= 0) {
    flash = 1;
    refractory = 0.35;
    strikes++;
    $("strikes").textContent = `discharges: ${strikes}`;
  }
  flash *= Math.exp(-6 * dt);
  uFlash.value = flash;

  drawShaft();
  drawMeter(aN);

  uDt.value = dt;
  renderer.compute(swarmStep);

  controls.update();
  renderer.render(scene, camera);
  window.__ready = true;
}

renderer.init().then(() => {
  resize();
  renderer.compute(swarmInit);
  renderer.setAnimationLoop(animate);
});
