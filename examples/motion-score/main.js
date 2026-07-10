// Motion Score — a motion-feel laboratory. The subject is the QUALITY of
// motion, not shading: a few hundred instanced spheres attracted to two
// partner wells orbiting a shared barycentre, choreographed by the Conductor
// into a phrase-long cycle that never stops:
//
//   ORBIT → build (gear-shift hits) → late BRAKE into a tight fast arc
//   (held tension) → CRASH release at the phrase head → clean fast exit.
//
// Temporal structure stolen from an ocean wave (build → curl → crash →
// disperse) and a race car (accelerate up through gears, brake hard and
// late, tight apex, fast exit). Ingredients:
//
//   1. ENERGY LEDGER per well — the phrase arc charges it, the crash spends
//      it. Well gravity/spin follow energy, not a fixed sine.
//   2. SLEW-LIMITED DRIVES (jerk cap) — well separation and gear follow
//      their targets through rate+accel-limited followers. S-curves only;
//      nothing pops, everything leans in and out.
//   3. SHIFT HITS — a euclidean voice cuts-and-re-engages the drive through
//      an underdamped Spring during the build. Gear (angular velocity)
//      climbs monotonically while the drive force saws. Subtle, textural.
//   4. CRASH TRANSFER — at the phrase head the stored energy converts from
//      coherent motion (orbital drive) into incoherent per-particle scatter,
//      then heavy damping mops it up while the next build starts.
//   5. RACING-LINE CONVERGENCE — R(phrase01): wide orbit most of the phrase,
//      sudden-but-jerk-limited late brake into a tight fast arc, clean exit.
//      Slow-in fast-out asymmetry a sine can't do.
//
// Three simultaneous time scales: per-particle noise grain (fast), shift
// hits (bar), convergence/crash (phrase). A third "drifter" well runs a
// half-tempo canon underneath.
//
// Physics is CPU-side on purpose — a few hundred spheres, and the lab is
// about force PROFILES, not throughput.

import * as THREE from "three/webgpu";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { Conductor, Spring, Slew } from "../../src/conductor.js";
import { slots } from "./techniques.js";

const canvas = document.getElementById("view");
if (!navigator.gpu) {
  document.getElementById("fail").style.display = "grid";
  throw new Error("WebGPU unavailable");
}
const renderer = new THREE.WebGPURenderer({ canvas, antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
await renderer.init();

// ---- tuning ------------------------------------------------------------------------
const T = {
  bpm: 112,
  barsPerPhrase: 4,

  count: 360, // swarm size

  // wells
  rWide: 2.5, // orbit separation, most of the phrase
  rTight: 0.55, // held-tension separation near the phrase head
  brakeAt: 0.74, // phrase01 where the brake begins (LATE)
  grav: 4.2, // G·M base
  spin: 0.7, // tangential spin force vs gravity
  soft: 0.32, // gravity softening radius
  omegaBase: 0.6, // rad/s orbital drive at gear 1, wide R
  omegaMax: 7.0,
  keplerPow: 1.35, // omega ~ (rWide/R)^keplerPow — tight = fast arc

  // slew caps (the "expensive motion" ingredient)
  rCloseRate: 5.0, rCloseAccel: 16, // brake: sudden but jerk-limited
  rOpenRate: 3.2, rOpenAccel: 7, // exit: fast, slightly softer
  gearRate: 1.6, gearAccel: 5, // gear steps lean in, never pop

  // energy ledger
  chargeBase: 0.55, chargeRamp: 1.25, // dE ∝ (base + ramp·phrase01)·dphrase
  energyFloor: 0.14, // ostinato never fully dies

  // shift hits
  shiftKick: 8.5, // drive spring velocity cut per accent
  gearStep: 0.24, // gear target increment per shift
  shiftWindow: [0.06, 0.7], // phrase01 span where shifts fire

  // crash
  crashKick: 14, // drive cut at the head
  scatterBase: 2.2, scatterGain: 4.2, // per-particle impulse ∝ energy
  crashDamp: 4.6, crashDampTime: 0.85, // heavy mop-up window (s)
  damp: 1.15, // cruising damping (1/s)
  dampBlend: 6, // damping target approach rate (no pops)

  // swarm forces
  noiseAmt: 0.38, // per-particle grain (fast scale)
  cohesion: 0.1, stiffen: 0.3, // quadratic spring to origin — containment only;
  // wells must WIN or the swarm reads as one origin-centred blob, not two lobes
  speedCap: 9,

  // drifter well (half-tempo canon)
  drifterR: 3.0, drifterG: 0.55,
};

// ---- musical time -------------------------------------------------------------------
const conductor = new Conductor({ bpm: T.bpm, barsPerPhrase: T.barsPerPhrase });

// drive: 1.0 = engaged. Shift hits and the crash CUT it (negative velocity
// kick); the underdamped spring lurches back and settles. zeta<1 rings.
const drive = new Spring({ value: 1, target: 1, freq: 3.2, zeta: 0.35 });

// slew followers (rate + accel caps → S-curves, zero jerk pops)
const rSlew = new Slew({ value: T.rWide, maxRate: T.rCloseRate, maxAccel: T.rCloseAccel }); // well separation
const gearSlew = new Slew({ value: 1, maxRate: T.gearRate, maxAccel: T.gearAccel }); // orbital gear

// ---- state ---------------------------------------------------------------------------
const state = {
  theta: 0, // partner-pair orbital angle
  driftTheta: Math.PI * 0.3, // drifter canon angle
  gearTarget: 1,
  energy: [T.energyFloor, T.energyFloor], // per-well ledger
  dampNow: T.damp,
  crashTimer: 0,
  omega: 0,
  fx: {}, // per-fire technique scratch (cleared on technique switch)
};

// ---- recipe: one technique per slot (?crash=wall&recover=ride) ------------------------
const params = new URLSearchParams(location.search);
const recipe = {};
for (const [slot, techs] of Object.entries(slots)) {
  const want = params.get(slot);
  recipe[slot] = want && techs[want] ? want : Object.keys(techs)[0];
}
function setTechnique(slot, name) {
  if (!slots[slot]?.[name]) return;
  recipe[slot] = name;
  state.fx = {}; // kill any in-flight shell/flip from the old technique
  const url = new URL(location);
  url.searchParams.set(slot, name);
  history.replaceState(null, "", url);
  refreshPanel?.();
}
window.__setRecipe = setTechnique;

// wells: [partner A, partner B, drifter]
const wells = [
  { p: new THREE.Vector3(), g: 0, spin: T.spin },
  { p: new THREE.Vector3(), g: 0, spin: T.spin },
  { p: new THREE.Vector3(), g: 0, spin: T.spin * 0.5 },
];
const bary = new THREE.Vector3();

// context handed to every technique hook (arrays are filled in below)
const ctx = { T, state, wells, bary, drive, conductor, pos: null, vel: null, mass: null, N: 0 };

// ---- shift voice: gear changes during the build --------------------------------------
conductor.voice({
  steps: 8, hits: 3, bars: 1, // tresillo per bar
  window: T.shiftWindow, // shifts only during the build
  onHit({ accent }) {
    drive.kick(-T.shiftKick * accent); // cut...spring re-engages with a lurch
    state.gearTarget += T.gearStep * accent; // velocity climbs monotonically
  },
});

// ---- crash: phrase head. The ledger is spent HERE; what the energy converts
// into is the active crash technique's business.
conductor.onPhrase(() => {
  const e = (state.energy[0] + state.energy[1]) * 0.5;
  slots.crash[recipe.crash].fire(ctx, e);
  state.energy[0] = state.energy[1] = T.energyFloor; // ledger spent
  state.gearTarget = 1; // back to first gear
  state.crashTimer = T.crashDampTime; // release window (recover slot decides what it means)
});

// ---- swarm ----------------------------------------------------------------------------
const N = T.count;
const pos = new Float32Array(N * 3);
const vel = new Float32Array(N * 3);
const nzFreq = new Float32Array(N * 3); // per-particle noise grain
const nzPhase = new Float32Array(N * 3);
const mass = new Float32Array(N); // pull variation, like flubber's hash mass
Object.assign(ctx, { pos, vel, mass, N });

{
  // seedable LCG so runs are comparable while tuning
  let s = 1234567;
  const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  for (let i = 0; i < N; i++) {
    const a = rnd() * Math.PI * 2;
    const r = 0.9 + rnd() * 1.9;
    const z = (rnd() - 0.5) * 0.7;
    pos[i * 3] = Math.cos(a) * r;
    pos[i * 3 + 1] = Math.sin(a) * r;
    pos[i * 3 + 2] = z;
    // tangential start so the ostinato is already in motion
    const vt = 0.55 + rnd() * 0.4;
    vel[i * 3] = -Math.sin(a) * vt;
    vel[i * 3 + 1] = Math.cos(a) * vt;
    vel[i * 3 + 2] = (rnd() - 0.5) * 0.15;
    mass[i] = 0.75 + rnd() * 0.5;
    for (let k = 0; k < 3; k++) {
      nzFreq[i * 3 + k] = 2.5 + rnd() * 5.5; // fast grain: 2.5–8 rad/s
      nzPhase[i * 3 + k] = rnd() * Math.PI * 2;
    }
  }
}

// ---- scene -----------------------------------------------------------------------------
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x04050a);
const camera = new THREE.PerspectiveCamera(
  55, window.innerWidth / window.innerHeight, 0.1, 100);
camera.position.set(0, -1.2, 7.4);
camera.lookAt(0, 0, 0);
const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;

const sphereGeo = new THREE.SphereGeometry(0.042, 10, 8);
const sphereMat = new THREE.MeshBasicNodeMaterial();
const swarm = new THREE.InstancedMesh(sphereGeo, sphereMat, N);
swarm.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
const dummy = new THREE.Object3D();
const tint = new THREE.Color();
for (let i = 0; i < N; i++) swarm.setColorAt(i, tint.setRGB(0.5, 0.6, 0.7));
scene.add(swarm);

// faint well markers — choreography legibility, not decoration
const wellGeo = new THREE.SphereGeometry(0.09, 12, 10);
const wellMeshes = wells.map((w, i) => {
  const m = new THREE.Mesh(
    wellGeo,
    new THREE.MeshBasicNodeMaterial({
      color: i === 2 ? 0x2a3450 : 0x3a4a6a,
      transparent: true,
      opacity: 0.55,
    })
  );
  scene.add(m);
  return m;
});

// ---- headless inspection hook ----------------------------------------------------------
const score = {
  bpm: conductor.bpm,
  phraseBeats: conductor.phraseBeats,
  phraseSeconds: conductor.phraseSeconds,
  phrase01: 0,
  energy: state.energy,
  gear: 1,
  drive: 1,
  R: T.rWide,
  omega: 0,
  wells: wells.map(() => [0, 0, 0]),
  wellG: [0, 0, 0],
  stage: "orbit",
  meanSpeed: 0,
  tuning: T,
  recipe,
};
window.__score = score;

// ---- the choreography ---------------------------------------------------------------------
function updateScore(dt, t) {
  conductor.update(dt); // fires shift hits + the phrase-head crash
  const p = conductor.phrase01;

  // -- energy ledger: the phrase arc charges it -----------------------------------------
  const dPhrase = dt / conductor.phraseSeconds;
  const charge = (T.chargeBase + T.chargeRamp * p) * dPhrase;
  state.energy[0] = Math.min(1, state.energy[0] + charge);
  state.energy[1] = Math.min(1, state.energy[1] + charge * 0.92); // slight detune

  // -- damping: the recover technique decides what release means; blended, never stepped
  state.crashTimer = Math.max(0, state.crashTimer - dt);
  const dampTarget = slots.recover[recipe.recover].dampTarget(ctx);
  state.dampNow += (dampTarget - state.dampNow) * Math.min(1, T.dampBlend * dt);

  // -- drive spring (shift saw + crash cut live in its velocity) ------------------------
  const driveVal = Math.max(0.04, drive.update(dt));

  // -- racing line: R target steps late, the slew follower shapes the S-curve ----------
  const closing = p >= T.brakeAt;
  const rTarget = closing ? T.rTight : T.rWide;
  if (closing || rSlew.value < T.rWide - 0.01) {
    rSlew.maxRate = closing ? T.rCloseRate : T.rOpenRate;
    rSlew.maxAccel = closing ? T.rCloseAccel : T.rOpenAccel;
  }
  rSlew.target = rTarget;
  const R = rSlew.update(dt);

  // -- gear: slew toward the stepped target (lean in, no pop) ---------------------------
  gearSlew.target = state.gearTarget;
  const gear = gearSlew.update(dt);

  // -- partner orbit: tighter = faster arc (Kepler-flavoured), drive modulates ----------
  const omega = Math.min(
    T.omegaMax,
    T.omegaBase * gear * driveVal * Math.pow(T.rWide / Math.max(R, 0.2), T.keplerPow)
  );
  state.theta += omega * dt;
  state.omega = omega;

  // barycentre drifts slowly — held tension translates slowly, and the frame breathes
  bary.set(
    Math.sin(t * 0.13) * 0.3,
    Math.sin(t * 0.09 + 1.7) * 0.22,
    Math.sin(t * 0.07 + 0.6) * 0.12
  );

  const half = R * 0.5;
  const c = Math.cos(state.theta), sn = Math.sin(state.theta);
  const wob = Math.sin(state.theta * 0.5) * 0.18;
  wells[0].p.set(bary.x + c * half, bary.y + sn * half, bary.z + wob);
  wells[1].p.set(bary.x - c * half, bary.y - sn * half, bary.z - wob);
  wells[0].g = T.grav * (0.35 + 1.05 * state.energy[0]) * driveVal;
  wells[1].g = T.grav * (0.35 + 1.05 * state.energy[1]) * driveVal;

  // drifter: half-tempo canon, weak, wide — the slow underneath layer
  state.driftTheta += omega * 0.5 * dt * 0.6 + T.omegaBase * 0.25 * dt;
  wells[2].p.set(
    Math.cos(state.driftTheta) * T.drifterR,
    Math.sin(state.driftTheta) * T.drifterR * 0.75,
    Math.sin(state.driftTheta * 0.7) * 0.5
  );
  wells[2].g = T.drifterG * (0.5 + 0.5 * (state.energy[0] + state.energy[1]) * 0.5);

  // -- crash technique frame hook: runs after wells are set, before integration --------
  slots.crash[recipe.crash].frame?.(ctx, dt);

  // -- integrate the swarm ----------------------------------------------------------------
  const soft2 = T.soft * T.soft;
  const dampMul = Math.exp(-state.dampNow * dt);
  let speedSum = 0;
  for (let i = 0; i < N; i++) {
    const ix = i * 3, iy = ix + 1, iz = ix + 2;
    const px = pos[ix], py = pos[iy], pz = pos[iz];
    let ax = 0, ay = 0, az = 0;

    // wells: inverse-square gravity + tangential spin (z-axis)
    for (let w = 0; w < 3; w++) {
      const W = wells[w];
      const tx = W.p.x - px, ty = W.p.y - py, tz = W.p.z - pz;
      const d2 = tx * tx + ty * ty + tz * tz + soft2;
      const g = (W.g * mass[i]) / d2;
      const inv = g / Math.sqrt(d2);
      ax += tx * inv; ay += ty * inv; az += tz * inv;
      // axis(0,0,1) × to = (-ty, tx, 0)
      ax += -ty * g * W.spin; ay += tx * g * W.spin;
    }

    // per-particle grain: fast, cheap, always on (the smallest time scale)
    ax += Math.sin(nzFreq[ix] * t + nzPhase[ix]) * T.noiseAmt;
    ay += Math.sin(nzFreq[iy] * t + nzPhase[iy]) * T.noiseAmt;
    az += Math.sin(nzFreq[iz] * t + nzPhase[iz]) * T.noiseAmt * 0.5;

    // quadratically stiffening cohesion — scatter stretches, never escapes
    const r2 = px * px + py * py + pz * pz;
    const coh = T.cohesion * (1 + T.stiffen * r2);
    ax -= px * coh; ay -= py * coh; az -= pz * coh * 1.6; // flatten toward the plane

    vel[ix] = (vel[ix] + ax * dt) * dampMul;
    vel[iy] = (vel[iy] + ay * dt) * dampMul;
    vel[iz] = (vel[iz] + az * dt) * dampMul;

    const sp2 = vel[ix] * vel[ix] + vel[iy] * vel[iy] + vel[iz] * vel[iz];
    if (sp2 > T.speedCap * T.speedCap) {
      const f = T.speedCap / Math.sqrt(sp2);
      vel[ix] *= f; vel[iy] *= f; vel[iz] *= f;
    }
    pos[ix] += vel[ix] * dt;
    pos[iy] += vel[iy] * dt;
    pos[iz] += vel[iz] * dt;
    speedSum += Math.sqrt(sp2);
  }

  // -- inspection hook ---------------------------------------------------------------------
  score.phrase01 = p;
  score.gear = gear;
  score.drive = driveVal;
  score.R = R;
  score.omega = omega;
  score.meanSpeed = speedSum / N;
  for (let w = 0; w < 3; w++) {
    score.wells[w][0] = wells[w].p.x;
    score.wells[w][1] = wells[w].p.y;
    score.wells[w][2] = wells[w].p.z;
    score.wellG[w] = wells[w].g;
  }
  score.stage =
    state.crashTimer > 0 ? "release"
    : p < T.brakeAt ? (p < 0.35 ? "orbit" : "build")
    : p < 0.92 ? "brake"
    : "held";
}

// ---- control panel --------------------------------------------------------------------------
// Sliders write straight into T / the conductor — everything reads live.
// [label, get, set, min, max, step]
const knobs = [
  ["bpm", () => conductor.bpm, (v) => (conductor.bpm = v), 60, 160, 1],
  ["bars/phrase", () => conductor.barsPerPhrase, (v) => (conductor.barsPerPhrase = v), 1, 8, 1],
  ["swing", () => conductor.swing, (v) => (conductor.swing = v), 0, 0.6, 0.01],
  ["grav", () => T.grav, (v) => (T.grav = v), 0.5, 10, 0.1],
  ["spin", () => T.spin, (v) => (T.spin = v), 0, 1.5, 0.01],
  ["brake at", () => T.brakeAt, (v) => (T.brakeAt = v), 0.4, 0.95, 0.01],
  ["r tight", () => T.rTight, (v) => (T.rTight = v), 0.2, 2, 0.01],
  ["crash kick", () => T.crashKick, (v) => (T.crashKick = v), 0, 30, 0.5],
  ["impact gain", () => T.scatterGain, (v) => (T.scatterGain = v), 0, 10, 0.1],
  ["mop damp", () => T.crashDamp, (v) => (T.crashDamp = v), 0.5, 10, 0.1],
  ["mop time", () => T.crashDampTime, (v) => (T.crashDampTime = v), 0.1, 3, 0.05],
  ["cruise damp", () => T.damp, (v) => (T.damp = v), 0.2, 4, 0.05],
  ["gear step", () => T.gearStep, (v) => (T.gearStep = v), 0, 0.6, 0.01],
  ["drifter g", () => T.drifterG, (v) => (T.drifterG = v), 0, 2, 0.05],
  ["grain", () => T.noiseAmt, (v) => (T.noiseAmt = v), 0, 1.5, 0.01],
];

let refreshPanel;
{
  const panel = document.getElementById("panel");
  const techButtons = [];
  for (const [slot, techs] of Object.entries(slots)) {
    const h = document.createElement("h2");
    h.textContent = slot;
    panel.appendChild(h);
    const row = document.createElement("div");
    row.className = "tech";
    for (const [name, tech] of Object.entries(techs)) {
      const b = document.createElement("button");
      b.textContent = tech.label;
      b.onclick = () => setTechnique(slot, name);
      techButtons.push([b, slot, name]);
      row.appendChild(b);
    }
    panel.appendChild(row);
  }
  const h = document.createElement("h2");
  h.textContent = "tuning";
  panel.appendChild(h);
  for (const [label, get, set, min, max, step] of knobs) {
    const row = document.createElement("div");
    row.className = "row";
    const name = document.createElement("span");
    name.textContent = label;
    const input = document.createElement("input");
    Object.assign(input, { type: "range", min, max, step, value: get() });
    const val = document.createElement("span");
    val.textContent = String(get());
    input.oninput = () => {
      set(Number(input.value));
      val.textContent = input.value;
    };
    row.append(name, input, val);
    panel.appendChild(row);
  }
  const hint = document.createElement("div");
  hint.className = "hint";
  hint.textContent = "keys: 1–5 crash · r recover · h panel";
  panel.appendChild(hint);

  refreshPanel = () => {
    for (const [b, slot, name] of techButtons)
      b.classList.toggle("on", recipe[slot] === name);
  };
  refreshPanel();
}

window.addEventListener("keydown", (e) => {
  if (e.target instanceof HTMLInputElement) return;
  const crashNames = Object.keys(slots.crash);
  const i = "12345".indexOf(e.key);
  if (i >= 0 && crashNames[i]) setTechnique("crash", crashNames[i]);
  if (e.key === "r") {
    const names = Object.keys(slots.recover);
    setTechnique("recover", names[(names.indexOf(recipe.recover) + 1) % names.length]);
  }
  if (e.key === "h") {
    const panel = document.getElementById("panel");
    panel.style.display = panel.style.display === "none" ? "" : "none";
  }
});

// ---- render ---------------------------------------------------------------------------------
const stageName = document.getElementById("stage-name");
const stageMeta = document.getElementById("stage-meta");

function updateVisuals() {
  for (let i = 0; i < N; i++) {
    const ix = i * 3;
    dummy.position.set(pos[ix], pos[ix + 1], pos[ix + 2]);
    const sp = Math.sqrt(
      vel[ix] * vel[ix] + vel[ix + 1] * vel[ix + 1] + vel[ix + 2] * vel[ix + 2]);
    const s = 0.8 + mass[i] * 0.4;
    dummy.scale.setScalar(s);
    dummy.updateMatrix();
    swarm.setMatrixAt(i, dummy.matrix);
    // brightness rides speed — the crash reads as a flash of hot particles
    const b = Math.min(1.6, 0.3 + sp * 0.34);
    swarm.setColorAt(i, tint.setRGB(0.42 * b, 0.58 * b, 0.72 * b));
  }
  swarm.instanceMatrix.needsUpdate = true;
  swarm.instanceColor.needsUpdate = true;
  for (let w = 0; w < 3; w++) wellMeshes[w].position.copy(wells[w].p);
}

window.addEventListener("resize", () => {
  renderer.setSize(window.innerWidth, window.innerHeight);
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
});

let elapsed = 0;
const clock = new THREE.Clock();
let hudStamp = -1;
renderer.setAnimationLoop(() => {
  const dt = Math.min(0.05, clock.getDelta());
  elapsed += dt;
  updateScore(dt, elapsed);
  updateVisuals();
  controls.update();
  renderer.render(scene, camera);
  window.__ready = true;
  if (elapsed - hudStamp > 0.12) {
    hudStamp = elapsed;
    stageName.textContent = score.stage;
    stageMeta.textContent =
      `${recipe.crash}/${recipe.recover} · ` +
      `phrase ${score.phrase01.toFixed(2)} · R ${score.R.toFixed(2)} · ` +
      `gear ${score.gear.toFixed(2)} · e ${state.energy[0].toFixed(2)}`;
  }
});
