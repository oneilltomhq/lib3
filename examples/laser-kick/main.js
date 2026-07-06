// examples/laser-kick/main.js
// A reverberating kick drum, seen through a lissajous laser — two
// representations of the same sound sharing one additive-points look:
//
//   scope — the true XY oscilloscope: left channel drives x, right drives y,
//           straight off the master bus. The dry kick is mono, so each hit
//           stabs a diagonal line; the FDN reverb decorrelates L from R, so
//           the tail blooms into a 2D cloud and collapses as it decays.
//   beam  — the parametric lissajous figure from src/lissajous.js, played by
//           the rhythm: every kick hits Springs (gain / zoom / detune) from
//           src/conductor.js, the sidechain pump ducks it between beats, and
//           the wet-bus RMS lifts the figure into ring texture and 3D as the
//           reverb tail rings.

import * as THREE from "three/webgpu";
import { uniform, float, vec2, vec3, texture, vertexIndex } from "three/tsl";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import {
  lissajousAt,
  lissajousBeamColor,
  beamSampleT,
  LISSAJOUS_DEFAULTS,
} from "../../src/lissajous.js";
import { Spring } from "../../src/conductor.js";
import { KickEngine } from "./audio.js";

// ---- scene / renderer ----------------------------------------------------------
const canvas = document.getElementById("canvas");
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x05060a);
const camera = new THREE.PerspectiveCamera(60, 1, 0.01, 100);
camera.position.set(0, 0, 3.2);

const renderer = new THREE.WebGPURenderer({ canvas, antialias: true });
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;

// ---- audio ----------------------------------------------------------------------
const engine = new KickEngine();

// ---- layer 1: XY scope of the actual signal -------------------------------------
const SCOPE_N = 2048;
const scopeData = new Float32Array(SCOPE_N * 4);
const scopeTex = new THREE.DataTexture(scopeData, SCOPE_N, 1, THREE.RGBAFormat, THREE.FloatType);
scopeTex.magFilter = scopeTex.minFilter = THREE.NearestFilter;
scopeTex.needsUpdate = true;

const uScopeScale = uniform(1.35);
const uScopeGain = uniform(1.2);
const uScopeColor = uniform(new THREE.Color(0.22, 1.0, 0.75));

const scopeMat = new THREE.PointsNodeMaterial({
  blending: THREE.AdditiveBlending,
  transparent: true,
  depthWrite: false,
  depthTest: false,
  sizeAttenuation: false,
});
{
  const u = float(vertexIndex).add(0.5).div(SCOPE_N);
  const s = texture(scopeTex, vec2(u, 0.5));
  scopeMat.positionNode = vec3(s.r, s.g, 0).mul(uScopeScale);
  // galvo dwell: bright where the beam moves slowly; recency ramp fades the
  // oldest samples so the trace has a head and a tail
  const sPrev = texture(scopeTex, vec2(u.sub(1 / SCOPE_N), 0.5));
  const speed = s.xy.sub(sPrev.xy).length().add(2e-4);
  const bright = float(0.004).div(speed).min(2).mul(u.pow(1.5)).mul(uScopeGain);
  scopeMat.colorNode = vec3(uScopeColor).mul(bright);
}
scopeMat.size = 3;

const scopeGeo = new THREE.BufferGeometry();
scopeGeo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(SCOPE_N * 3), 3));
const scopePoints = new THREE.Points(scopeGeo, scopeMat);
scene.add(scopePoints);

// ---- layer 2: parametric beam, played by the rhythm ------------------------------
const BEAM_N = 3500;
const U = {};
for (const k in LISSAJOUS_DEFAULTS) U[k] = uniform(LISSAJOUS_DEFAULTS[k]);
U.freqX.value = 60;
U.freqY.value = 80;
U.detuneY.value = 0.12;
U.hue.value = 0.58;
U.gain.value = 0.45;
U.trace.value = 0.045;
U.scale.value = 1.35;
const time = uniform(0);

const t = beamSampleT({ time, trace: U.trace, count: float(BEAM_N) });
const beamParams = { ...U, t, dt: U.trace.div(BEAM_N) };

const beamMat = new THREE.PointsNodeMaterial({
  blending: THREE.AdditiveBlending,
  transparent: true,
  depthWrite: false,
  depthTest: false,
  sizeAttenuation: false,
});
beamMat.positionNode = lissajousAt(beamParams).mul(U.scale);
beamMat.colorNode = lissajousBeamColor(beamParams);

const beamGeo = new THREE.BufferGeometry();
beamGeo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(BEAM_N * 3), 3));
const beamPoints = new THREE.Points(beamGeo, beamMat);
scene.add(beamPoints);

// ---- rhythm → physics -------------------------------------------------------------
// Springs turn each scheduled hit into motion that settles, instead of a jump.
const BEAM_BASE = { gain: 0.45, scale: 1.35, detuneY: 0.12 };
const gainSpring = new Spring({ value: BEAM_BASE.gain, freq: 3.2, zeta: 0.3 });
const zoomSpring = new Spring({ value: BEAM_BASE.scale, freq: 2.2, zeta: 0.25 });
const detuneSpring = new Spring({ value: BEAM_BASE.detuneY, freq: 1.6, zeta: 0.2 });

let react = 0.7; // one knob for how hard the beam listens
let pump = 0; // sidechain envelope: 1 on each real kick, exp decay
let wetSmooth = 0; // smoothed reverb-tail energy

// ---- UI --------------------------------------------------------------------------
const $ = (id) => document.getElementById(id);

const playBtn = $("play");
playBtn.addEventListener("click", () => {
  if (engine.playing) {
    engine.stop();
    playBtn.textContent = "play";
    playBtn.classList.remove("on");
  } else {
    engine.start();
    playBtn.textContent = "stop";
    playBtn.classList.add("on");
  }
});

let mode = "both";
for (const m of ["scope", "beam", "both"]) {
  $(`mode-${m}`).addEventListener("click", () => {
    mode = m;
    scopePoints.visible = m !== "beam";
    beamPoints.visible = m !== "scope";
    for (const n of ["scope", "beam", "both"])
      $(`mode-${n}`).classList.toggle("on", n === m);
  });
}

// [key, label, min, max, step, get, set]
const SPECS = [
  ["clock", [
    ["bpm", "bpm", 70, 170, 1, () => engine.params.bpm, (v) => (engine.params.bpm = v)],
    ["hits", "hits / 16", 1, 16, 1, () => engine.params.hits, (v) => { engine.params.hits = v; engine.setPattern(); }],
    ["rotate", "rotate", 0, 15, 1, () => engine.params.rotate, (v) => { engine.params.rotate = v; engine.setPattern(); }],
    ["swing", "swing", 0, 0.6, 0.01, () => engine.params.swing, (v) => (engine.params.swing = v)],
  ]],
  ["kick voice", [
    ["pitchHi", "pitch hi (Hz)", 60, 300, 1, () => engine.params.pitchHi, (v) => { engine.params.pitchHi = v; engine.rebuildKick(); }],
    ["pitchLo", "pitch lo (Hz)", 30, 80, 1, () => engine.params.pitchLo, (v) => { engine.params.pitchLo = v; engine.rebuildKick(); }],
    ["pitchDecay", "pitch drop", 5, 120, 1, () => engine.params.pitchDecay, (v) => { engine.params.pitchDecay = v; engine.rebuildKick(); }],
    ["ampDecay", "amp decay", 4, 60, 0.5, () => engine.params.ampDecay, (v) => { engine.params.ampDecay = v; engine.rebuildKick(); }],
    ["level", "level", 0, 1, 0.01, () => engine.params.level, (v) => (engine.params.level = v)],
  ]],
  ["room (FDN reverb)", [
    ["size", "room size", 0.5, 3, 0.05, () => engine.params.size, (v) => { engine.params.size = v; engine.rebuildIRSoon(); }],
    ["rt60", "RT60 (s)", 0.3, 6, 0.05, () => engine.params.rt60, (v) => { engine.params.rt60 = v; engine.rebuildIRSoon(); }],
    ["damp", "damping", 0, 0.95, 0.01, () => engine.params.damp, (v) => { engine.params.damp = v; engine.rebuildIRSoon(); }],
    ["wet", "wet", 0, 1, 0.01, () => engine.params.wet, (v) => engine.setWet(v)],
  ]],
  ["laser", [
    ["scopeScale", "scope zoom", 0.4, 3, 0.05, () => uScopeScale.value, (v) => (uScopeScale.value = v)],
    ["scopeGain", "scope gain", 0.1, 3, 0.05, () => uScopeGain.value, (v) => (uScopeGain.value = v)],
    ["hue", "beam hue", 0, 1, 0.001, () => U.hue.value, (v) => (U.hue.value = v)],
    ["trace", "beam trace", 0.005, 0.15, 0.001, () => U.trace.value, (v) => (U.trace.value = v)],
    ["react", "beam react", 0, 1, 0.01, () => react, (v) => (react = v)],
  ]],
];

const controlsEl = $("controls");
for (const [title, rows] of SPECS) {
  const g = document.createElement("div");
  g.className = "grp";
  g.innerHTML = `<h2>${title}</h2>`;
  for (const [key, label, min, max, step, get, set] of rows) {
    const row = document.createElement("div");
    row.className = "row";
    row.innerHTML = `<label>${label}</label>`;
    const inp = document.createElement("input");
    inp.type = "range";
    inp.min = min; inp.max = max; inp.step = step; inp.value = get();
    const v = document.createElement("span");
    v.className = "val";
    v.textContent = (+get()).toFixed(2);
    inp.addEventListener("input", () => {
      set(+inp.value);
      v.textContent = (+inp.value).toFixed(2);
    });
    row.appendChild(inp);
    row.appendChild(v);
    g.appendChild(row);
  }
  controlsEl.appendChild(g);
}

// ---- resize + loop -----------------------------------------------------------------
function resize() {
  const r = canvas.parentElement.getBoundingClientRect();
  renderer.setSize(r.width, r.height, false);
  camera.aspect = r.width / r.height;
  camera.updateProjectionMatrix();
}
addEventListener("resize", resize);

const clock = new THREE.Clock();
function animate() {
  const dt = Math.min(0.05, clock.getDelta());
  time.value += dt;

  engine.tick(); // book upcoming kicks at exact audio times

  for (const hit of engine.consumeHits()) {
    gainSpring.kick(1.4 * hit.accent * react);
    zoomSpring.kick(0.6 * hit.accent * react);
    detuneSpring.kick(2.5 * hit.accent * react);
    pump = 1;
  }
  pump *= Math.exp(-6 * dt);

  // reverb tail energy → ring texture + lift into 3D
  const rms = engine.wetRms();
  wetSmooth += (rms - wetSmooth) * Math.min(1, dt * 10);
  U.ringDepth.value = Math.min(0.6, wetSmooth * 6 * react);
  U.ampZ.value = Math.min(0.9, wetSmooth * 10 * react);

  const duck = 1 - 0.45 * react * (1 - pump);
  U.gain.value = Math.max(0.05, gainSpring.update(dt)) * duck;
  U.scale.value = zoomSpring.update(dt);
  U.detuneY.value = detuneSpring.update(dt);

  if (engine.fillScope(scopeData)) scopeTex.needsUpdate = true;

  beamMat.size = U.size.value;
  controls.update();
  renderer.render(scene, camera);
}

renderer.init().then(() => {
  resize();
  renderer.setAnimationLoop(animate);
});
