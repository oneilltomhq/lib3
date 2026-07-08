// examples/lissajous-lightning/main.js
// LISSAJOUS LIGHTNING — the figure and the thunder are one source.
//
// Each strike picks a frequency ratio p:q. The BOLT is the lissajous figure
// of that ratio, crinkled into lightning by charge: midpoint displacement
// re-expressed as sin octaves along the beam (frequency doubles, amplitude
// halves — bolt.js's trick, folded into the TSL positionNode), flashing
// white-hot and restriking down the same channel like the storm capstone.
// The THUNDER is rendered FROM the same figure: its points, scaled into the
// sky, become the N-wave delay-sum sources (the figure's spatial spread IS
// the rumble's length), and two sub kicks hum the same p:q five octaves
// down, panned L|R, through the FDN room.
//
// The reflection closes both ways: the SCOPE layer draws the actual L/R
// thunder signal — during the rumble it traces the same p:q figure, smeared
// by the room — and the wet-bus RMS feeds back into the visual figure as
// tremble, ring texture and lift into 3D. However chaotic, the light moves
// at the thunder's frequency because it is the thunder.

import * as THREE from "three/webgpu";
import { uniform, float, vec2, vec3, mix, texture, vertexIndex } from "three/tsl";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import {
  lissajousAt,
  lissajousBrightness,
  beamSampleT,
  LISSAJOUS_DEFAULTS,
} from "../../src/lissajous.js";
import { Spring } from "../../src/conductor.js";
import { boltFlicker } from "../../src/bolt.js";
import { ThunderEngine } from "./audio.js";

const TAU = Math.PI * 2;

// ---- scene / renderer ----------------------------------------------------------
const canvas = document.getElementById("canvas");
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x04050a);
const camera = new THREE.PerspectiveCamera(60, 1, 0.01, 100);
camera.position.set(0, 0.1, 3.4);

const renderer = new THREE.WebGPURenderer({ canvas, antialias: true });
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;

// ---- audio ----------------------------------------------------------------------
const engine = new ThunderEngine();

// ---- layer 1: the bolt — a lissajous figure, charged --------------------------------
const BEAM_N = 4000;
const U = {};
for (const k in LISSAJOUS_DEFAULTS) U[k] = uniform(LISSAJOUS_DEFAULTS[k]);
U.freqX.value = 42; // 3:4 until the first strike chooses
U.freqY.value = 56;
U.detuneY.value = 0.06;
U.trace.value = 0.05;
U.scale.value = 1.35;
const time = uniform(0);

const uCharge = uniform(0.12); // crinkle amplitude — how much lightning the figure is
const uFlash = uniform(0);     // strike envelope — how bright the channel burns
const uSeed = uniform(7);      // the channel's character; new each stroke

const t = beamSampleT({ time, trace: U.trace, count: float(BEAM_N) });
const beamParams = { ...U, t, dt: U.trace.div(BEAM_N) };

const beamMat = new THREE.PointsNodeMaterial({
  blending: THREE.AdditiveBlending,
  transparent: true,
  depthWrite: false,
  depthTest: false,
  sizeAttenuation: false,
});
{
  const base = lissajousAt(beamParams);
  // fbm folded into the beam: sin octaves along the trace window, frequency
  // doubling and amplitude halving each level — the midpoint-displacement
  // spectrum, continuous. uSeed reseeds the crinkle per stroke.
  const w = t.sub(time).div(U.trace); // 0..1 along the beam
  let jag = vec3(0);
  let f = 19, a = 1;
  for (let k = 0; k < 5; k++) {
    const phX = w.mul(TAU * f).add(uSeed.mul(11.31 + k * 7.97));
    const phY = phX.add(uSeed.mul(5.23).add(2.09));
    const phZ = phX.add(uSeed.mul(3.71).add(4.37));
    jag = jag.add(vec3(phX.sin(), phY.sin(), phZ.sin()).mul(a));
    f *= 2.03; // not exactly 2 — keeps octaves from phase-locking into a wave
    a *= 0.55;
  }
  beamMat.positionNode = base.add(jag.mul(uCharge).mul(0.055)).mul(U.scale);

  // dwell glow of the underlying curve; the flash lifts cold blue to white-hot
  const bright = lissajousBrightness(beamParams);
  const flash01 = uFlash.clamp(0, 1);
  const cold = vec3(0.3, 0.5, 1.05);
  const hot = vec3(1.15, 1.2, 1.28);
  beamMat.colorNode = mix(cold, hot, flash01).mul(bright).mul(U.gain.add(uFlash.mul(5)));
}
beamMat.size = 5;

const beamGeo = new THREE.BufferGeometry();
beamGeo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(BEAM_N * 3), 3));
const beamPoints = new THREE.Points(beamGeo, beamMat);
scene.add(beamPoints);

// ---- layer 2: the scope — the thunder, seen -----------------------------------------
const SCOPE_N = 2048;
const scopeData = new Float32Array(SCOPE_N * 4);
const scopeTex = new THREE.DataTexture(scopeData, SCOPE_N, 1, THREE.RGBAFormat, THREE.FloatType);
scopeTex.magFilter = scopeTex.minFilter = THREE.NearestFilter;
scopeTex.needsUpdate = true;

const uScopeScale = uniform(1.35);
const uScopeGain = uniform(1.1);

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
  const sPrev = texture(scopeTex, vec2(u.sub(1 / SCOPE_N), 0.5));
  const speed = s.xy.sub(sPrev.xy).length().add(2e-4);
  const bright = float(0.004).div(speed).min(2).mul(u.pow(1.5)).mul(uScopeGain);
  scopeMat.colorNode = vec3(0.45, 0.55, 1.0).mul(bright);
}
scopeMat.size = 3;

const scopeGeo = new THREE.BufferGeometry();
scopeGeo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(SCOPE_N * 3), 3));
const scopePoints = new THREE.Points(scopeGeo, scopeMat);
scene.add(scopePoints);

// ---- strike director ------------------------------------------------------------------
// Storm scheduling on a figure: pick a ratio, flash, go dark, restrike down
// the same channel with less energy — each stroke firing its own thunder.
const RATIOS = [[1, 2], [2, 3], [3, 4], [3, 5], [4, 5], [5, 6], [5, 7]];

const zoomSpring = new Spring({ value: 1.35, freq: 2.0, zeta: 0.22 });
const detuneSpring = new Spring({ value: 0.06, freq: 1.4, zeta: 0.18 });

let strike = null;
let nextStrike = 1.6;
let activity = 1.0;
let react = 0.7;
let wetSmooth = 0;

// JS mirror of the base curve (no crinkle) — the audio's N-wave sources. One
// closure of the figure: t over a full period of the shared base frequency.
function sampleFigure(n, B) {
  const fx = U.freqX.value, fy = U.freqY.value + U.detuneY.value, fz = U.freqZ.value;
  const phX = U.phaseX.value;
  const az = Math.max(U.ampZ.value, 0.35); // give the sound depth even when flat
  const k = U.inset.value * U.scale.value;
  const pts = [];
  for (let i = 0; i < n; i++) {
    const tt = i / n / B;
    pts.push([
      Math.sin(TAU * fx * tt + phX) * k,
      Math.sin(TAU * fy * tt) * k,
      Math.sin(TAU * fz * tt) * az * k,
    ]);
  }
  return pts;
}

function fireAudio(s) {
  s.thunderDelay = engine.strike(sampleFigure(48, s.B), s.ratio, s.energy);
}

function spawnStrike() {
  const [p, q] = RATIOS[(Math.random() * RATIOS.length) | 0];
  const B = 12 + Math.random() * 7; // beam-space Hz per ratio unit
  U.freqX.value = B * p;
  U.freqY.value = B * q;
  U.freqZ.value = B * Math.max(1, q - p); // z hums the difference tone
  U.phaseX.value = Math.random() * TAU;
  uSeed.value = Math.random() * 100;
  strike = {
    t: 0, phase: "flash", energy: 1, life: 0.45,
    restrikes: 1 + ((Math.random() * 3) | 0),
    darkDur: 0, ratio: { p, q }, B,
  };
  fireAudio(strike);
  zoomSpring.kick(1.1 * react);
  detuneSpring.kick(2.2 * react);
}

window.__strike = spawnStrike;
window.__engine = engine;

canvas.addEventListener("pointerdown", (e) => { if (e.button === 0) spawnStrike(); });
window.addEventListener("keydown", (e) => { if (e.key === "l") spawnStrike(); });

// ---- UI --------------------------------------------------------------------------
const $ = (id) => document.getElementById(id);

const soundBtn = $("sound");
soundBtn.addEventListener("click", () => {
  engine.ensureCtx();
  engine.ctx.resume();
  engine.enabled = !engine.enabled;
  soundBtn.textContent = engine.enabled ? "sound: on" : "sound: off";
  soundBtn.classList.toggle("on", engine.enabled);
});
$("strike").addEventListener("click", spawnStrike);

let mode = "both";
for (const m of ["bolt", "scope", "both"]) {
  $(`mode-${m}`).addEventListener("click", () => {
    mode = m;
    beamPoints.visible = m !== "scope";
    scopePoints.visible = m !== "bolt";
    for (const n of ["bolt", "scope", "both"])
      $(`mode-${n}`).classList.toggle("on", n === m);
  });
}

// [key, label, min, max, step, get, set]
const SPECS = [
  ["storm", [
    ["distance", "distance (km)", 0.2, 4, 0.05, () => engine.params.distanceKm, (v) => (engine.params.distanceKm = v)],
    ["activity", "activity", 0.25, 3, 0.05, () => activity, (v) => (activity = v)],
    ["react", "figure react", 0, 1, 0.01, () => react, (v) => (react = v)],
  ]],
  ["room (FDN reverb)", [
    ["size", "room size", 0.5, 3, 0.05, () => engine.params.size, (v) => { engine.params.size = v; engine.rebuildIRSoon(); }],
    ["rt60", "RT60 (s)", 0.5, 6.5, 0.05, () => engine.params.rt60, (v) => { engine.params.rt60 = v; engine.rebuildIRSoon(); }],
    ["damp", "damping", 0, 0.95, 0.01, () => engine.params.damp, (v) => { engine.params.damp = v; engine.rebuildIRSoon(); }],
    ["wet", "wet", 0, 1, 0.01, () => engine.params.wet, (v) => engine.setWet(v)],
    ["level", "level", 0, 1, 0.01, () => engine.params.level, (v) => (engine.params.level = v)],
  ]],
  ["beams", [
    ["trace", "bolt trace", 0.01, 0.15, 0.001, () => U.trace.value, (v) => (U.trace.value = v)],
    ["scopeScale", "scope zoom", 0.4, 3, 0.05, () => uScopeScale.value, (v) => (uScopeScale.value = v)],
    ["scopeGain", "scope gain", 0.1, 3, 0.05, () => uScopeGain.value, (v) => (uScopeGain.value = v)],
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

  // the thunder answers back: tail energy → tremble, texture, lift into 3D
  const rms = engine.wetRms();
  wetSmooth += (rms - wetSmooth) * Math.min(1, dt * 8);
  const tail = Math.min(1, wetSmooth * 7) * react;
  const simmer = 0.1 + tail * 0.55; // the rumble keeps the figure trembling
  U.ringDepth.value = tail * 0.28;  // texture, not shredding — the figure stays legible
  U.ampZ.value = Math.min(0.7, tail * 0.9);

  // strike state machine: flash → dark → restrike, storm-style
  if (strike) {
    const s = strike;
    s.t += dt;
    if (s.phase === "flash") {
      const env = boltFlicker(s.t, s.life) * s.energy;
      uFlash.value = env;
      uCharge.value = simmer + env * 2.4;
      if (s.t >= s.life) {
        if (s.restrikes-- > 0) {
          s.phase = "dark";
          s.t = 0;
          s.darkDur = 0.05 + Math.random() * 0.13;
        } else strike = null;
      }
    } else {
      uFlash.value = 0;
      uCharge.value = simmer;
      if (s.t >= s.darkDur) {
        s.energy *= 0.55;
        s.phase = "flash";
        s.t = 0;
        s.life = 0.3 + Math.random() * 0.2;
        uSeed.value += 3.7; // the channel re-crinkles a little each stroke
        fireAudio(s);
      }
    }
  } else {
    uFlash.value = tail * 0.25; // the rumble keeps a faint glow alive
    uCharge.value = simmer;
    nextStrike -= dt * activity;
    if (nextStrike <= 0) {
      spawnStrike();
      nextStrike = 4 + Math.random() * 5;
    }
  }

  U.gain.value = 0.3 + tail * 1.2;
  U.scale.value = zoomSpring.update(dt);
  U.detuneY.value = detuneSpring.update(dt);

  if (engine.fillScope(scopeData)) scopeTex.needsUpdate = true;

  controls.update();
  renderer.render(scene, camera);
  window.__ready = true;
}

renderer.init().then(() => {
  resize();
  renderer.setAnimationLoop(animate);
});
