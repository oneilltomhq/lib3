// examples/lissajous-lab/main.js
// Phase 1 demo for the lissajous module: a single beam of additive points,
// positioned and coloured entirely by the TSL nodes. 3D-capable — drag to
// orbit; switch on the Z axis (or the helix / sphere-knot presets) to leave
// the flat scope behind. No afterglow persistence yet (that's Phase 2).

import * as THREE from "three/webgpu";
import { uniform, float } from "three/tsl";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import {
  lissajousAt,
  lissajousBeamColor,
  beamSampleT,
  LISSAJOUS_DEFAULTS,
  LISSAJOUS_PRESETS,
} from "../../src/lissajous.js";

const N = 3500; // samples along the beam path

// ---- scene / renderer ----------------------------------------------------------
const canvas = document.getElementById("canvas");
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x05060a);
const camera = new THREE.PerspectiveCamera(60, 1, 0.01, 100);
camera.position.set(0, 0, 3.2);

const renderer = new THREE.WebGPURenderer({ canvas, antialias: true });
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;

// ---- uniforms (one per knob) ---------------------------------------------------
const U = {};
for (const k in LISSAJOUS_DEFAULTS) U[k] = uniform(LISSAJOUS_DEFAULTS[k]);
const time = uniform(0);

// ---- the beam: positions + colour come straight from the nodes -----------------
const positions = new Float32Array(N * 3); // placeholder; positionNode overrides
const geo = new THREE.BufferGeometry();
geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));

const t = beamSampleT({ time, trace: U.trace, count: float(N) });
const params = { ...U, t, dt: U.trace.div(N) };

const material = new THREE.PointsNodeMaterial({
  blending: THREE.AdditiveBlending,
  transparent: true,
  depthWrite: false,
  depthTest: false,
  sizeAttenuation: false,
});
material.positionNode = lissajousAt(params).mul(U.scale);
material.colorNode = lissajousBeamColor(params);

const points = new THREE.Points(geo, material);
scene.add(points);

// ---- UI: knob panel ------------------------------------------------------------
const SPECS = [
  ["1 · X / Y / Z mapping", [
    ["freqX", "X freq (Hz)", 1, 200, 0.5],
    ["freqY", "Y freq (Hz)", 1, 200, 0.5],
    ["freqZ", "Z freq (Hz)", 1, 200, 0.5],
    ["ampZ", "Z amount", 0, 1, 0.01],
  ]],
  ["2 · Lissajous tuning", [
    ["detuneY", "Y detune", -3, 3, 0.01],
    ["detuneZ", "Z detune", -3, 3, 0.01],
    ["phaseX", "X phase", 0, 6.283, 0.01],
    ["phaseZ", "Z phase", 0, 6.283, 0.01],
  ]],
  ["3 · Ring modulation", [
    ["ringFreq", "carrier (Hz)", 20, 2000, 1],
    ["ringDepth", "depth", 0, 1, 0.01],
  ]],
  ["4 · Rhythmic colour", [
    ["hue", "hue", 0, 1, 0.001],
    ["colorRate", "pulse (Hz)", 0.1, 12, 0.05],
    ["colorDepth", "pulse depth", 0, 1, 0.01],
  ]],
  ["5 · Positional offset", [
    ["driftRate", "drift (Hz)", 0.02, 2, 0.01],
    ["driftDepth", "drift depth", 0, 0.5, 0.005],
  ]],
  ["Beam / look", [
    ["trace", "beam trace", 0.005, 0.15, 0.001],
    ["gain", "intensity", 0.05, 2, 0.01],
    ["size", "beam width", 1, 16, 0.5],
    ["scale", "figure scale", 0.5, 2.5, 0.05],
  ]],
];

const controlsEl = document.getElementById("controls");
const inputs = {};
for (const [title, rows] of SPECS) {
  const g = document.createElement("div");
  g.className = "grp";
  g.innerHTML = `<h2>${title}</h2>`;
  for (const [key, label, min, max, step] of rows) {
    const row = document.createElement("div");
    row.className = "row";
    row.innerHTML = `<label>${label}</label>`;
    const inp = document.createElement("input");
    inp.type = "range";
    inp.min = min; inp.max = max; inp.step = step; inp.value = U[key].value;
    const v = document.createElement("span");
    v.className = "val";
    v.textContent = (+U[key].value).toFixed(2);
    inp.addEventListener("input", () => {
      U[key].value = +inp.value;
      v.textContent = (+inp.value).toFixed(2);
      clearActivePreset(); // any manual tweak diverges from the named preset
    });
    row.appendChild(inp); row.appendChild(v); g.appendChild(row);
    inputs[key] = { inp, v };
  }
  controlsEl.appendChild(g);
}

const pbox = document.getElementById("presets");
const presetButtons = [];
function clearActivePreset() {
  for (const btn of presetButtons) btn.classList.remove("active");
}
for (const name of Object.keys(LISSAJOUS_PRESETS)) {
  const b = document.createElement("button");
  b.textContent = name;
  b.onclick = () => {
    const preset = LISSAJOUS_PRESETS[name];
    for (const k in preset) if (U[k]) U[k].value = preset[k];
    for (const k in inputs) {
      inputs[k].inp.value = U[k].value;
      inputs[k].v.textContent = (+U[k].value).toFixed(2);
    }
    clearActivePreset();
    b.classList.add("active");
  };
  presetButtons.push(b);
  pbox.appendChild(b);
}

// ---- resize + loop -------------------------------------------------------------
function resize() {
  const r = canvas.parentElement.getBoundingClientRect();
  renderer.setSize(r.width, r.height, false);
  camera.aspect = r.width / r.height;
  camera.updateProjectionMatrix();
}
addEventListener("resize", resize);

const clock = new THREE.Clock();
function animate() {
  const d = Math.min(0.05, clock.getDelta());
  time.value += d;
  material.size = U.size.value;
  controls.update();
  renderer.render(scene, camera);
}

renderer.init().then(() => {
  resize();
  renderer.setAnimationLoop(animate);
});
