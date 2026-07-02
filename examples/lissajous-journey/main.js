// examples/lissajous-journey/main.js
// The journey demo: builds on the lissajous-lab beam (a single line of additive
// points positioned and coloured entirely by the TSL nodes, 3D-capable — drag
// to orbit) and adds the Journey panel on top.
//
// A journey plays a *tour* of sweet spots, interpolating every parameter from
// one stop to the next so you watch the figure morph (frequency changes writhe
// through the in-between ratios before locking). Play the curated default reel,
// or capture/reorder/export your own stops to author one. The tour state
// machine is the generic driver in src/journey.js. No afterglow persistence
// yet (Phase 2). The plain lab (no journey) lives in lissajous-lab.

import * as THREE from "three/webgpu";
import { uniform, float } from "three/tsl";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import {
  lissajousAt,
  lissajousBeamColor,
  beamSampleT,
  LISSAJOUS_DEFAULTS,
  LISSAJOUS_PRESETS,
  LISSAJOUS_CHANNELS,
  LISSAJOUS_JOURNEY,
  cameraPosition,
  cameraToSpherical,
  resolveLissajousStop,
  resolveLissajousJourney,
} from "../../src/lissajous.js";
import { createJourneyDriver } from "../../src/journey.js";

const HOLD_DRIFT = 0.08; // rad/s of idle orbit while parked, so a held figure still has parallax

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

// ---- state: base patch ------------------------------------------------------------
// `base` is the source of truth — sliders, presets and journey legs all write it;
// the render loop mirrors it into the uniforms.
const base = { ...LISSAJOUS_DEFAULTS };

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

// ---- state helpers -------------------------------------------------------------
// snapshot/apply work on the *base* patch in plain {key: number} space so
// presets, journeys and the capture button all speak the same language.
// (Uniforms are written from base+modulation in the render loop, never here.)
function snapshot() {
  return { ...base };
}
function applyValues(values, reflect = true) {
  for (const k in values) {
    if (!(k in base)) continue;
    base[k] = values[k];
    if (reflect && inputs[k]) {
      inputs[k].inp.value = values[k];
      inputs[k].v.textContent = (+values[k]).toFixed(2);
    }
  }
}
// Camera lives in the same spherical terms a stop's `camera` block uses, so the
// autopilot, capture, and manual orbit all speak one language. snapshot reads the
// live OrbitControls pose; apply flies the camera to a pose (controls.update()
// then round-trips it cleanly, keeping damping intact).
function snapshotCamera() {
  return cameraToSpherical(
    [camera.position.x, camera.position.y, camera.position.z],
    [controls.target.x, controls.target.y, controls.target.z]
  );
}
function applyCamera(pose) {
  const [x, y, z] = cameraPosition(pose);
  camera.position.set(x, y, z);
  controls.target.set(pose.target[0], pose.target[1], pose.target[2]);
}

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
    inp.min = min; inp.max = max; inp.step = step; inp.value = base[key];
    const v = document.createElement("span");
    v.className = "val";
    v.textContent = (+base[key]).toFixed(2);
    inp.addEventListener("input", () => {
      base[key] = +inp.value;
      v.textContent = (+inp.value).toFixed(2);
      clearActivePreset();    // diverged from any named preset
      if (driver.playing) stopJourney(); // grabbing the wheel turns off autopilot
    });
    row.appendChild(inp); row.appendChild(v); g.appendChild(row);
    inputs[key] = { inp, v };
  }
  controlsEl.appendChild(g);
}

// ---- UI: presets ---------------------------------------------------------------
const pbox = document.getElementById("presets");
const presetButtons = [];
function clearActivePreset() {
  for (const btn of presetButtons) btn.classList.remove("active");
}
for (const name of Object.keys(LISSAJOUS_PRESETS)) {
  const b = document.createElement("button");
  b.textContent = name;
  b.onclick = () => {
    if (driver.playing) stopJourney();
    applyValues({ ...LISSAJOUS_DEFAULTS, ...LISSAJOUS_PRESETS[name] });
    clearActivePreset();
    b.classList.add("active");
  };
  presetButtons.push(b);
  pbox.appendChild(b);
}

// ---- UI + driver: journey ------------------------------------------------------
let journey = resolveLissajousJourney(LISSAJOUS_JOURNEY);
let captureCount = 0;

// The arrangement autopilot (src/journey.js) flies `base` and the camera
// through the stops; grabbing the camera mid-leg hands it to you until the
// next stop. Modulation rides on top either way — see the render loop.
const driver = createJourneyDriver({
  stops: journey,
  channels: LISSAJOUS_CHANNELS,
  getBase: snapshot,
  setBase: (v) => applyValues(v, true),
  getCamera: snapshotCamera,
  setCamera: applyCamera,
  holdOrbit: HOLD_DRIFT,
  onStopChange: () => updateCurrent(),
});

function startJourney() {
  if (journey.length === 0) return;
  clearActivePreset();
  driver.stops = journey;
  driver.start();
  updateJourneyUI();
}
function stopJourney() {
  driver.stop();
  updateJourneyUI();
}
// Grabbing the camera during playback drops camera autopilot for the rest of this leg.
controls.addEventListener("start", () => driver.grabCamera());

// build the journey panel between the presets and the knobs
const jEl = document.createElement("div");
jEl.className = "grp";
jEl.innerHTML =
  `<h2>Journey <span class="hint">tour of sweet spots</span></h2>` +
  `<div class="jbar">` +
  `<button class="play">▶ Play</button>` +
  `<button class="capture">＋ capture</button>` +
  `<button class="export">⧉ export</button>` +
  `</div>` +
  `<div class="stops-head"><span style="flex:1">stop</span><span>hold</span><span>trans</span><span style="width:46px"></span></div>` +
  `<div class="stops"></div>`;
controlsEl.parentNode.insertBefore(jEl, controlsEl);

const playBtn = jEl.querySelector(".play");
const stopsEl = jEl.querySelector(".stops");
playBtn.onclick = () => (driver.playing ? stopJourney() : startJourney());
jEl.querySelector(".capture").onclick = () => {
  if (driver.playing) stopJourney();
  const prevCam = journey[journey.length - 1]?.camera;
  journey.push(resolveLissajousStop(
    { name: `capture ${++captureCount}`, values: snapshot(), camera: snapshotCamera(), hold: 2.5, transition: 3.0 },
    prevCam
  ));
  renderStops();
};
jEl.querySelector(".export").onclick = () => {
  const data = journey.map((s) => ({ values: s.values, camera: s.camera, hold: s.hold, transition: s.transition }));
  const text = JSON.stringify(data, null, 2);
  console.log("[lissajous journey]\n" + text);
  navigator.clipboard?.writeText(text).catch(() => {});
};

let stopRows = [];
function renderStops() {
  stopsEl.innerHTML = "";
  stopRows = journey.map((stop, i) => {
    const row = document.createElement("div");
    row.className = "stop";
    const nm = document.createElement("span");
    nm.className = "nm";
    nm.textContent = stop.name;
    nm.title = "preview this stop";
    nm.style.cursor = "pointer";
    nm.onclick = () => { if (driver.playing) stopJourney(); applyValues(stop.values); applyCamera(stop.camera); };

    const hold = numField(stop.hold, (val) => (stop.hold = val));
    const trans = numField(stop.transition.duration, (val) => (stop.transition.duration = val));

    const up = mini("▲", () => move(i, -1));
    const down = mini("▼", () => move(i, 1));
    const del = mini("✕", () => { journey.splice(i, 1); renderStops(); });

    row.append(nm, hold, trans, up, down, del);
    stopsEl.appendChild(row);
    return row;
  });
  updateCurrent();
}
function numField(value, onChange) {
  const inp = document.createElement("input");
  inp.type = "number";
  inp.min = 0; inp.step = 0.5; inp.value = value;
  inp.onchange = () => onChange(Math.max(0, +inp.value || 0));
  return inp;
}
function mini(label, onClick) {
  const b = document.createElement("button");
  b.className = "mini";
  b.textContent = label;
  b.onclick = onClick;
  return b;
}
function move(i, dir) {
  const j = i + dir;
  if (j < 0 || j >= journey.length) return;
  [journey[i], journey[j]] = [journey[j], journey[i]];
  if (driver.playing) stopJourney();
  renderStops();
}
function updateCurrent() {
  stopRows.forEach((row, i) =>
    row.classList.toggle("current", driver.playing && i === driver.index)
  );
}
function updateJourneyUI() {
  playBtn.textContent = driver.playing ? "⏸ Pause" : "▶ Play";
  playBtn.classList.toggle("on", driver.playing);
  updateCurrent();
}
renderStops();

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
  driver.update(d); // moves `base` (and camera) between stops
  for (const k in U) U[k].value = base[k];
  material.size = base.size;
  controls.update();
  renderer.render(scene, camera);
}

renderer.init().then(() => {
  resize();
  renderer.setAnimationLoop(animate);
});
