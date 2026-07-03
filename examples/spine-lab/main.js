// Spine Lab — first principles for the dancing geometry. NOTHING here maps a
// clock to a position. Motion exists only as integrated dynamics, three
// layers of derivation deep, because that's how a body dances to techno:
//
//   layer 1 — the HEAD (JS): the kick is a FORCE. Anticipation builds into
//             the beat, the hit drops and compresses, an epicycle (slow orbit
//             + counter-circle) gives the circling; a phrase-long energy ramp
//             builds and snaps back at the head — the drop.
//   layer 2 — the CHAIN (JS): 16 spring segments, each chasing the one above
//             it. Lag, overshoot and swing accumulate downward — the pulse
//             arrives late and rung, like flesh, not like a phase offset.
//   layer 3 — the FLESH (GPU compute): every vertex is a mass on a spring
//             anchored to its chain-posed target, with persistent position +
//             velocity in storage buffers. It overshoots the pose, jiggles as
//             it settles, glows where it moves.
//
// Rack over everything (window.rack, ?bridge for terminal driving). Presets:
// giegling (loose, behind the beat) / ilian (tight, driving).

import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import {
  color,
  float,
  Fn,
  instancedArray,
  instanceIndex,
  mix,
  positionGeometry,
  uniform,
  uniformArray,
  vec3,
  vertexIndex,
} from "three/tsl";
import * as THREE from "three/webgpu";
import { Conductor, Spring } from "../../src/conductor.js";
import { Rack, bindKey, connectRackBridge, localStorageAdapter } from "../../src/rack.js";

const K = 16; // chain segments
const HEIGHT = 2.4; // tube height (head at the bottom — the kick comes up through the floor)
const WIRE_COLORS = { head: 0x1fb8ff, tail: 0x49ffa0 };

// ---- control state (all rack-addressable, all PHYSICAL) --------------------------
const ctrl = {
  impulse: 0.5, // kick force into the head
  anticipate: 0.35, // pre-beat build into the one
  epiSize: 0.35, // orbit radius
  epiBeats: 8, // beats per orbit
  epiRatio: 3, // counter-circle speed ratio (the epicycle)
  follow: 2.2, // head-follow spring frequency (Hz)
  lag: 0.82, // per-segment frequency falloff — how deep the pulse arrives late
  ring: 0.35, // damping ratio: <1 rings (giegling), →1 tight (ostgut)
  fleshAmt: 1, // 0 = raw skeleton pose (A/B the flesh live)
  stiff: 30, // flesh spring to pose
  fleshDamp: 4.5,
  arc: 0.4, // phrase energy ramp depth (builds, snaps back at the head)
};

// ---- stage ------------------------------------------------------------------------
const renderer = new THREE.WebGPURenderer({
  canvas: document.getElementById("canvas"),
  antialias: true,
});
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setClearColor(0x000000);
renderer.toneMapping = THREE.ACESFilmicToneMapping;

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(
  55, window.innerWidth / window.innerHeight, 0.02, 100);
camera.position.set(0, 0.3, 3.4);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.target.set(0, 0, 0);

// ---- the chain: springs all the way down ------------------------------------------
// per segment: x, z (lateral), swell (radial), lift (vertical). Head springs
// chase the epicycle + kick; every other segment chases the one above it.
const mkSprings = (value = 0) =>
  Array.from({ length: K }, () => new Spring({ value, target: value }));
const sx = mkSprings(0);
const sz = mkSprings(0);
const sw = mkSprings(1);
const sy = mkSprings(0);

const conductor = new Conductor({ bpm: 124, swing: 0.08 });
let energy = 1;

conductor.voice({
  steps: 4, hits: 4, // the floor
  onHit({ accent }) {
    const punch = ctrl.impulse * (0.5 + 0.5 * energy) * accent;
    sw[0].kick(-punch * 4.5); // the drop: head compresses...
    sy[0].kick(-punch * 1.6); // ...and dips
    // ...and gets shoved along the circle it is travelling (tangent punch)
    const a = orbitAngle();
    sx[0].kick(-Math.sin(a) * punch * 1.2);
    sz[0].kick(Math.cos(a) * punch * 1.2);
  },
});

function orbitAngle() {
  return (conductor.beat * 2 * Math.PI) / Math.max(1, ctrl.epiBeats);
}

// ---- skeleton pose (TSL, shared by the render path and the flesh kernel) ----------
const segs = uniformArray(Array.from({ length: K }, () => new THREE.Vector4(0, 0, 1, 0)));

const posePosition = /*@__PURE__*/ Fn(([p]) => {
  const t = p.y.div(HEIGHT).add(0.5).clamp(0, 1); // 0 head (bottom) → 1 tail
  const f = t.mul(K - 1);
  const i0 = f.floor().toInt();
  const i1 = i0.add(1).min(K - 1);
  const s = mix(segs.element(i0), segs.element(i1), f.fract());
  return vec3(p.x.mul(s.z).add(s.x), p.y.add(s.w), p.z.mul(s.z).add(s.y));
});

// ---- the flesh: per-vertex momentum in storage buffers -----------------------------
const geo = new THREE.CylinderGeometry(0.42, 0.42, HEIGHT, 56, 112, true);
const count = geo.attributes.position.count;

const basePos = instancedArray(geo.attributes.position.array, "vec3");
const fleshPos = instancedArray(count, "vec3");
const fleshVel = instancedArray(count, "vec3");

const uDt = uniform(0);
const uStiff = uniform(ctrl.stiff);
const uFleshDamp = uniform(ctrl.fleshDamp);
const uFleshAmt = uniform(ctrl.fleshAmt);

const initFlesh = Fn(() => {
  const p = basePos.element(instanceIndex);
  fleshPos.element(instanceIndex).assign(posePosition(p));
  fleshVel.element(instanceIndex).assign(vec3(0));
})().compute(count);

// semi-implicit Euler: spring to the chain-posed target, velocity persists —
// the vertex OVERSHOOTS the pose and rings, which is the whole point
const stepFlesh = Fn(() => {
  const target = posePosition(basePos.element(instanceIndex));
  const pos = fleshPos.element(instanceIndex);
  const vel = fleshVel.element(instanceIndex);
  const acc = target.sub(pos).mul(uStiff).sub(vel.mul(uFleshDamp));
  vel.addAssign(acc.mul(uDt));
  pos.addAssign(vel.mul(uDt));
})().compute(count);

// ---- material: wireframe, motion glows --------------------------------------------
const mat = new THREE.MeshBasicNodeMaterial({
  wireframe: true,
  transparent: true,
  blending: THREE.AdditiveBlending,
  depthWrite: false,
});
mat.positionNode = mix(
  posePosition(positionGeometry),
  fleshPos.element(vertexIndex),
  uFleshAmt,
);
const chainT = positionGeometry.y.div(HEIGHT).add(0.5).clamp(0, 1);
const velGlow = fleshVel.element(vertexIndex).length().mul(0.9).min(1.2).mul(uFleshAmt);
mat.colorNode = mix(color(WIRE_COLORS.head), color(WIRE_COLORS.tail), chainT)
  .mul(float(0.16).add(velGlow.mul(0.3)));

const mesh = new THREE.Mesh(geo, mat);
scene.add(mesh);

// ---- rack -------------------------------------------------------------------------
const rack = new Rack({ storage: localStorageAdapter("spineLabRack") });
rack.add("/beat/bpm", bindKey(conductor, "bpm"), { min: 60, max: 160, unit: "bpm" });
rack.add("/beat/swing", bindKey(conductor, "swing"), { min: 0, max: 0.6 });
rack.add("/head/impulse", bindKey(ctrl, "impulse"), { min: 0, max: 1 });
rack.add("/head/anticipate", bindKey(ctrl, "anticipate"), { min: 0, max: 1 });
rack.add("/head/epiSize", bindKey(ctrl, "epiSize"), { min: 0, max: 1 });
rack.add("/head/epiBeats", bindKey(ctrl, "epiBeats"), { min: 1, max: 16, step: 1 });
rack.add("/head/epiRatio", bindKey(ctrl, "epiRatio"), { min: 0, max: 6 });
rack.add("/chain/follow", bindKey(ctrl, "follow"), { min: 0.5, max: 8, unit: "Hz" });
rack.add("/chain/lag", bindKey(ctrl, "lag"), { min: 0.5, max: 1 });
rack.add("/chain/ring", bindKey(ctrl, "ring"), { min: 0.1, max: 1.2 });
rack.add("/flesh/amount", bindKey(ctrl, "fleshAmt"), { min: 0, max: 1 });
rack.add("/flesh/stiff", bindKey(ctrl, "stiff"), { min: 4, max: 120 });
rack.add("/flesh/damp", bindKey(ctrl, "fleshDamp"), { min: 0.5, max: 12 });
rack.add("/arc/depth", bindKey(ctrl, "arc"), { min: 0, max: 1 });
if (new URLSearchParams(location.search).has("bridge")) connectRackBridge(rack);
window.rack = rack;

// two ends of the reference spectrum — feel the difference in the body
const PRESETS = {
  giegling: { "/head/impulse": 0.38, "/head/anticipate": 0.5, "/chain/follow": 1.6,
    "/chain/lag": 0.74, "/chain/ring": 0.22, "/flesh/stiff": 16, "/flesh/damp": 3,
    "/beat/swing": 0.22, "/beat/bpm": 118, "/head/epiBeats": 12, "/head/epiRatio": 2.2 },
  ilian: { "/head/impulse": 0.82, "/head/anticipate": 0.2, "/chain/follow": 3.6,
    "/chain/lag": 0.9, "/chain/ring": 0.55, "/flesh/stiff": 60, "/flesh/damp": 6,
    "/beat/swing": 0.05, "/beat/bpm": 132, "/head/epiBeats": 6, "/head/epiRatio": 4 },
};

// ---- panel: generated straight from the rack ---------------------------------------
const paramsEl = document.getElementById("params");
const sliders = new Map();
let currentGroup = null;
for (const p of rack.params()) {
  const group = p.path.split("/")[1];
  if (group !== currentGroup) {
    currentGroup = group;
    const h = document.createElement("h2");
    h.textContent = group;
    paramsEl.appendChild(h);
  }
  const row = document.createElement("div");
  row.className = "row";
  row.innerHTML = `<label>${p.label}</label>`;
  const inp = document.createElement("input");
  inp.type = "range";
  inp.min = p.min;
  inp.max = p.max;
  inp.step = p.step ?? (p.max - p.min) / 200;
  inp.value = p.value;
  const val = document.createElement("span");
  val.className = "val";
  val.textContent = (+p.value).toFixed(2);
  inp.addEventListener("input", () => {
    rack.set(p.path, +inp.value, 0, "human");
    val.textContent = (+inp.value).toFixed(2);
  });
  row.append(inp, val);
  paramsEl.appendChild(row);
  sliders.set(p.path, { inp, val });
}
// reflect external writes (agent/bridge/presets) into the panel
let dragging = false;
paramsEl.addEventListener("pointerdown", () => { dragging = true; });
window.addEventListener("pointerup", () => { dragging = false; });
setInterval(() => {
  if (dragging) return;
  for (const p of rack.params()) {
    const s = sliders.get(p.path);
    if (!s) continue;
    s.inp.value = p.value;
    s.val.textContent = (+p.value).toFixed(2);
  }
}, 120);

const presetsEl = document.getElementById("presets");
for (const name in PRESETS) {
  const b = document.createElement("button");
  b.textContent = name;
  b.addEventListener("click", () => {
    for (const [path, v] of Object.entries(PRESETS[name])) rack.set(path, v, 400, "human");
  });
  presetsEl.appendChild(b);
}

// ---- loop -------------------------------------------------------------------------
const beatEl = document.getElementById("beat");
const clock = new THREE.Clock();

window.addEventListener("resize", () => {
  renderer.setSize(window.innerWidth, window.innerHeight);
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
});

renderer.init().then(async () => {
  await renderer.computeAsync(initFlesh);

  renderer.setAnimationLoop(() => {
    const dt = Math.min(0.05, clock.getDelta());

    conductor.update(dt);
    rack.update(dt);

    // phrase energy: linear build, snap back at the phrase head — the drop
    energy = 1 - ctrl.arc + ctrl.arc * conductor.phrase01;

    // head targets: epicycle (orbit + counter-circle) scaled by energy,
    // anticipation building INTO the next kick (f³ — late, like a dancer)
    const a1 = orbitAngle();
    const a2 = -a1 * ctrl.epiRatio;
    const r1 = ctrl.epiSize * 0.55 * energy;
    const r2 = r1 * 0.45;
    sx[0].target = Math.cos(a1) * r1 + Math.cos(a2) * r2;
    sz[0].target = Math.sin(a1) * r1 + Math.sin(a2) * r2;
    const f = ((conductor.beat % 1) + 1) % 1;
    sy[0].target = ctrl.anticipate * 0.14 * f * f * f;
    sw[0].target = 1;

    // the chain: each segment chases the one above; frequency falls off with
    // lag so the pulse arrives later and softer the further it travels
    for (let k = 0; k < K; k++) {
      const freq = ctrl.follow * Math.pow(ctrl.lag, k);
      for (const springs of [sx, sz, sy, sw]) {
        const s = springs[k];
        s.freq = freq;
        s.zeta = ctrl.ring;
        if (k > 0) s.target = springs[k - 1].value;
        s.update(dt);
      }
      segs.array[k].set(sx[k].value, sz[k].value, sw[k].value, sy[k].value);
    }

    // the flesh: GPU integration toward the fresh pose
    uDt.value = Math.min(dt, 1 / 30);
    uStiff.value = ctrl.stiff;
    uFleshDamp.value = ctrl.fleshDamp;
    uFleshAmt.value = ctrl.fleshAmt;
    renderer.compute(stepFlesh);

    beatEl.style.opacity = 0.15 + 0.85 * conductor.pump(5);
    controls.update();
    renderer.render(scene, camera);
  });
});

window.__ready = true;
