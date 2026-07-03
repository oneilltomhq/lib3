// Knot Morph — Rhythm Lab, primitives edition. The clock is pinned (120bpm,
// four on the floor, scale 0.40, centred weave); the panel is nine ISOLATED
// motion primitives, all zeroed. Protocol: raise one, feel it against the
// beat, judge it, zero it, move on — compose only from the survivors.
//
// Full instrument (euclidean voices, springs, every raw param) lives in git
// history; controls return once the primitives are validated.

import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import {
  color,
  mix,
  modelWorldMatrix,
  normalView,
  positionView,
  positionViewDirection,
  uniform,
  uv,
  vec4,
} from "three/tsl";
import * as THREE from "three/webgpu";
import { Conductor } from "../../src/conductor.js";
import { knotMorphPosition } from "../../src/knotMorph.js";
import { Rack, bindKey, localStorageAdapter } from "../../src/rack.js";

const WIRE_COLORS = { start: 0x1fb8ff, target: 0x49ffa0 }; // (2,3) → (3,5)

// ---- the primitives ---------------------------------------------------------
// Nine isolated motion channels, every one normalized 0–1 and defaulting to
// ZERO. Protocol: raise ONE, feel it against the beat, judge it, zero it,
// move on. Compose only from the survivors. Each slider's real-world range
// lives in the loop mapping below.
// defaults = Tom's end-of-night find (2026-07-03); ⌀ zero all to taste singles
const P = {
  duck: { value: 0.86 }, // PULSE × brightness
  pop: { value: 0.6 }, // PULSE × scale
  squash: { value: 0.85 }, // PULSE × shape (anisotropic)
  punch: { value: 0.74 }, // PULSE × camera (fov punch-in)
  orbit: { value: 1.0 }, // CYCLE × position (one loop per 2 beats)
  roll: { value: 0 }, // CYCLE × tilt (axis nutation, same loop)
  spin: { value: 1.0 }, // CYCLE × yaw (free-running turntable)
  morph: { value: 1.0 }, // CYCLE × geometry, uniform (whole knot breathes as one)
  travel: { value: 0.47 }, // CYCLE × geometry, traveling (a morph FRONT winds along the tube)
};

// ---- everything pinned (Tom's find 2 look, macro-era simplifications) ------
const FIXED = {
  bpm: 120,
  sharp: 5, // kick decay
  attack: 0.05, // body attack (s)
  scale: 0.4,
  offset: 0,
  loopBeats: 2, // groove circle = one loop per 2 beats
  pumpOrbit: 0.6, // kick widens the groove circle
  wobble: 0.18, // slow aimless sway underneath everything
  fadeIn: 0.27,
  fadeOut: 0.76,
  muteLo: 0.15,
  muteHi: 0.5,
  wireBase: 0.09,
  wireFres: 0.07,
};

const MORPH_BEATS = 8; // grid-locked morph cycle length

// ---- stage ------------------------------------------------------------------
const renderer = new THREE.WebGPURenderer({
  canvas: document.getElementById("canvas"),
  antialias: true,
});
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setClearColor(0x000000);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.12;

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

// ---- the windowed knot --------------------------------------------------------
const startGeo = new THREE.TorusKnotGeometry(1, 0.4, 128, 32, 2, 3);
const targetGeo = new THREE.TorusKnotGeometry(1, 0.4, 128, 32, 3, 5);
startGeo.setAttribute(
  "targetPosition",
  new THREE.BufferAttribute(targetGeo.getAttribute("position").array, 3)
);

const uCenter = uniform(new THREE.Vector3());
const uDuck = uniform(1);

// spatial morph: per-vertex blend = midpoint + uniform wave + traveling wave.
// uv.x runs along the tube (a closed loop), so the traveling term must wrap
// an integer number of times or the seam tears.
const uPhase = uniform(0); // grid-locked morph phase (radians)
const uMorphD = uniform(0); // depth of the uniform (everywhere-at-once) wave
const uTravelD = uniform(0); // depth of the traveling front
const WAVES = 2; // wavefront wraps around the tube
const wUniform = uPhase.cos().mul(-0.5).add(0.5);
const wTravel = uPhase
  .sub(uv().x.mul(Math.PI * 2 * WAVES))
  .cos()
  .mul(-0.5)
  .add(0.5);
const mixNode = wUniform
  .sub(0.5)
  .mul(uMorphD)
  .add(wTravel.sub(0.5).mul(uTravelD))
  .add(0.5)
  .clamp(0, 1);

const wireMat = new THREE.MeshBasicNodeMaterial({
  wireframe: true,
  transparent: true,
  blending: THREE.AdditiveBlending,
  depthWrite: false,
});
wireMat.positionNode = knotMorphPosition({ mixFactor: mixNode });

const worldPos = modelWorldMatrix.mul(
  vec4(knotMorphPosition({ mixFactor: mixNode }), 1.0)
).xyz;
const windowed = worldPos
  .sub(uCenter)
  .length()
  .smoothstep(FIXED.fadeIn, FIXED.fadeOut)
  .oneMinus();
const nearMute = positionView
  .length()
  .smoothstep(FIXED.muteLo, FIXED.muteHi);
const fres = normalView.dot(positionViewDirection).abs().oneMinus().pow(1.5);
wireMat.colorNode = mix(
  color(WIRE_COLORS.start),
  color(WIRE_COLORS.target),
  mixNode // spatial: the front shows in colour too, cyan→green as it passes
).mul(
  windowed
    .mul(nearMute)
    .mul(fres.mul(FIXED.wireFres).add(FIXED.wireBase))
    .mul(uDuck)
);

const mesh = new THREE.Mesh(startGeo, wireMat);
scene.add(mesh);

// ---- rhythm -------------------------------------------------------------------
const conductor = new Conductor({ bpm: FIXED.bpm });
let bodyPump = 0;

// ---- rack: the lab as an instrument ---------------------------------------------
// Every primitive is addressable (window.rack). Slider drags dispatch through
// the same recorded channel as agent calls, so a hand-tuned exploration is a
// SESSION — replayable, liftable at any moment into a snapshot. Load a
// recorded performance with ?session=<name> (examples ship in ./sessions/).
const rack = new Rack({ storage: localStorageAdapter("knotRhythmLabRack") });
rack.add("/room/bpm", bindKey(conductor, "bpm"), { min: 60, max: 160, unit: "bpm" });

// ---- panel: one flat row per primitive, all zeroed --------------------------------
const paramsEl = document.getElementById("params");
const inputs = {};
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
  inputs[label] = { inp, val };

  // rack writes land in P and echo back into the slider UI
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

// ---- presets (macro space) -------------------------------------------------------
const STORE_KEY = "knot-rhythm-lab-macro-presets";
const PRESETS = {};
try {
  Object.assign(PRESETS, JSON.parse(localStorage.getItem(STORE_KEY) ?? "{}"));
} catch {
  /* corrupt store — ignore */
}
const persist = () => localStorage.setItem(STORE_KEY, JSON.stringify(PRESETS));

function currentValues() {
  const out = {};
  for (const label in P) out[label] = +P[label].value.toFixed(2);
  return out;
}

function applyPreset(p) {
  for (const label in P) {
    const v = p[label] ?? 0;
    P[label].value = v;
    inputs[label].inp.value = v;
    inputs[label].val.textContent = (+v).toFixed(2);
  }
}

const presetsEl = document.getElementById("presets");
function renderPresets() {
  presetsEl.innerHTML = "";
  for (const name in PRESETS) {
    const b = document.createElement("button");
    b.textContent = name;
    b.title = "click: load · shift+click: overwrite · ✕: delete";
    const del = document.createElement("span");
    del.textContent = " ✕";
    del.style.color = "var(--dim)";
    b.appendChild(del);
    b.addEventListener("click", (e) => {
      if (e.target === del) {
        if (confirm(`delete "${name}"?`)) {
          delete PRESETS[name];
          persist();
          renderPresets();
        }
        return;
      }
      if (e.shiftKey) {
        PRESETS[name] = currentValues();
        persist();
        console.log(`"${name}" overwritten:`, JSON.stringify(PRESETS[name]));
        return;
      }
      applyPreset(PRESETS[name]);
    });
    presetsEl.appendChild(b);
  }
  const cap = document.createElement("button");
  cap.className = "op";
  cap.textContent = "＋ capture";
  cap.addEventListener("click", () => {
    const name = prompt("preset name?", `find ${Object.keys(PRESETS).length + 1}`);
    if (!name) return;
    PRESETS[name] = currentValues();
    persist();
    renderPresets();
    console.log(`"${name}":`, JSON.stringify(PRESETS[name]));
  });
  presetsEl.appendChild(cap);
  const zero = document.createElement("button");
  zero.className = "op";
  zero.textContent = "⌀ zero all";
  zero.addEventListener("click", () => applyPreset({}));
  presetsEl.appendChild(zero);
  const exp = document.createElement("button");
  exp.className = "op";
  exp.textContent = "⧉ export";
  exp.addEventListener("click", () => {
    const json = JSON.stringify(PRESETS, null, 2);
    console.log(json);
    navigator.clipboard?.writeText(json);
  });
  presetsEl.appendChild(exp);
}
renderPresets();

// ---- loop -------------------------------------------------------------------------
const beatEl = document.getElementById("beat");
const readoutEl = document.getElementById("readout");
const clock = new THREE.Clock();

window.addEventListener("resize", () => {
  renderer.setSize(window.innerWidth, window.innerHeight);
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
});

renderer.init().then(() => {
  // replay a recorded performance: ?session=build-up (&speed=2 to skim)
  const q = new URLSearchParams(location.search);
  const sessionName = q.get("session");
  if (sessionName) {
    fetch(`./sessions/${sessionName}.json`)
      .then((r) => r.json())
      .then((s) => rack.replay(s, Number(q.get("speed")) || 1))
      .catch((e) => console.warn(`session "${sessionName}":`, e.message));
  }

  renderer.setAnimationLoop(() => {
    const dt = Math.min(0.1, clock.getDelta());
    const elapsed = clock.elapsedTime;

    conductor.update(dt);
    rack.update(dt); // the render loop is the ramp clock
    const pump = conductor.pump(FIXED.sharp);
    bodyPump += (pump - bodyPump) * Math.min(1, dt / FIXED.attack);

    // each primitive maps its 0–1 slider to a real range, independently —
    // no crosstalk, so one raised slider = one isolated principle
    uDuck.value = 1 - P.duck.value * 0.7 * (1 - pump);

    const loop = (conductor.beat * 2 * Math.PI) / FIXED.loopBeats;
    const orbitR =
      P.orbit.value *
      0.1 *
      (1 - FIXED.pumpOrbit + FIXED.pumpOrbit * bodyPump);

    const base = FIXED.scale * (1 + P.pop.value * 0.2 * bodyPump);
    const sq = P.squash.value * 0.18 * bodyPump;
    mesh.scale.set(base * (1 + sq * 0.5), base * (1 - sq), base * (1 + sq * 0.5));
    mesh.position.x = Math.cos(loop) * orbitR;
    mesh.position.z = Math.sin(loop) * orbitR * 0.7;
    mesh.position.y = Math.sin(loop * 2) * orbitR * 0.35;

    // morph phase locked to the grid; depths feed the spatial mix node
    uPhase.value = (conductor.beat * 2 * Math.PI) / MORPH_BEATS;
    uMorphD.value = P.morph.value;
    uTravelD.value = P.travel.value;
    mesh.rotation.y += P.spin.value * 0.8 * dt;

    // axis nutation on the groove loop over the slow aimless sway
    const roll = P.roll.value * 0.3;
    mesh.rotation.x =
      Math.sin(elapsed * 0.21) * FIXED.wobble + Math.sin(loop) * roll;
    mesh.rotation.z =
      Math.sin(elapsed * 0.13 + 1.7) * FIXED.wobble * 0.6 +
      Math.cos(loop) * roll * 0.8;

    camera.fov = 60 - P.punch.value * 6 * bodyPump;
    camera.updateProjectionMatrix();

    beatEl.style.opacity = 0.15 + 0.85 * pump;
    readoutEl.textContent = `120bpm · four on the floor · morph ${MORPH_BEATS} beats`;

    controls.update();
    renderer.render(scene, camera);
  });
});
