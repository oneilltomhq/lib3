// Flubber, arc: lightning as CONDUCTOR, not glass as obstacle. The liquid mass
// (the compute substrate from ../flubber-compute) is struck by a DIRECTOR that
// fires volleys of discharges — 2-4 in fast succession (reads as parallel),
// then a long silence. Each strike deposits charge into the particles it hits;
// FlubberField splats that charge through the SAME density kernels, so the glow
// pools where blobs merge and conducts across the necks between them.
//
// Slice 2+ replaces the "strike a target sphere" stub with real bolt geometry
// (midpoint displacement) splatted into the emission volume along the path.

import * as THREE from "three/webgpu";
import { texture } from "three/tsl";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { HydraSynth } from "../../src/hydra/index.js";
import {
  FlubberField,
  noiseFlowDriver,
  cohesionDriver,
  swirlDriver,
  burstDriver,
} from "../../src/flubber.js";
import { makeBolt, boltFlicker } from "../../src/bolt.js";

const canvas = document.getElementById("view");
if (!navigator.gpu) {
  document.getElementById("fail").style.display = "grid";
  throw new Error("WebGPU unavailable");
}
const renderer = new THREE.WebGPURenderer({ canvas, antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
await renderer.init();

// ---- hydra backdrop + rim ----------------------------------------------------------
const synth = new HydraSynth({ renderer, width: 1024, height: 576, outputs: 2, display: true });
const { osc, voronoi, src, o0, o1 } = synth.api;

// a DARK, slow storm-cloud backdrop — deep enough that the additive bolt
// strokes (and the interior glow) pop like lightning against night. Still has
// enough colour/structure for the glass to refract.
osc(5, 0.03, 0.9)
  .rotate(-0.3, 0.01)
  .modulate(src(o0).scale(1.02).rotate(0.003), 0.04)
  .colorama(0.001)
  .saturate(0.6)
  .contrast(1.0)
  .brightness(-0.9) // a near-black storm so the additive arcs read as lightning
  .out(o0);

// cold electric rim accent
voronoi(5, 0.25, 0.4).color(0.5, 0.8, 1.4).contrast(1.6).out(o1);

// ---- scene ------------------------------------------------------------------------
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(
  60, window.innerWidth / window.innerHeight, 0.1, 100);
camera.position.set(0, 0.35, 4.6);

const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.minDistance = 2.4;
controls.maxDistance = 6;

// backdrop: a camera-facing wall a fixed depth beyond the origin
const BACKDROP_DEPTH = 2.4;
const backdropMat = new THREE.MeshBasicNodeMaterial();
backdropMat.colorNode = texture(o0.display.texture);
const backdrop = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), backdropMat);
scene.add(backdrop);
function placeBackdrop() {
  const camDist = camera.position.length();
  const span = camDist + BACKDROP_DEPTH;
  backdrop.position.copy(camera.position).multiplyScalar(-BACKDROP_DEPTH / camDist);
  backdrop.quaternion.copy(camera.quaternion);
  const h = 2 * span * Math.tan((camera.fov * Math.PI) / 360) * 1.15;
  backdrop.scale.set(h * camera.aspect, h, 1);
}
placeBackdrop();

// ---- refraction grab pass ----------------------------------------------------------
const grabRT = new THREE.RenderTarget(1, 1);
function sizeGrab() {
  const dpr = renderer.getPixelRatio();
  grabRT.setSize(window.innerWidth * dpr, window.innerHeight * dpr);
}
sizeGrab();

// ---- the flubber substrate (sim → splat → march) -----------------------------------
const BOUND = 1.4;
const COUNT = 128;
const noise = noiseFlowDriver({ freq: 1.9, amt: 5.2 });
const cohesion = cohesionDriver({ strength: 1.4, stiffen: 3 });
const swirlDrv = swirlDriver({ strength: 0.6 });
const burst = burstDriver({ decay: 9 }); // surge arcs recoil the liquid physically

const flubber = new FlubberField({
  renderer,
  camera,
  drivers: [noise, cohesion, swirlDrv, burst],
  sceneTexture: grabRT.texture,
  rimTexture: o1.display.texture,
  count: COUNT,
  grid: 64,
  center: new THREE.Vector3(0, 0, 0),
  half: new THREE.Vector3(BOUND, BOUND, BOUND),
  radius: 0.26,
  damp: 1.5,
  speedCap: 1e6,
  iso: 0.6,
  refract: 0.3,
  fresnelStrength: 0.85,
  fresnelBase: 0.5,
  rimStrength: 0.4,
  marchSteps: 80,
  // arc look: cold electric blue-white charge. Kept moderate so the glow stays
  // a lit VESSEL (surface detail intact), not a blown-out white blob that the
  // additive bolt strokes would vanish into.
  emitColor: [0.4, 0.6, 1.0], // deep electric blue — dim enough that hot arc cores pop
  emitGain: 0.9,
  emitFloor: 0.02,   // a low simmer between arcs — lit vessel, not a blown-white blob
  chargeDecay: 3.4,  // τ≈0.29s — veins flash crisp then sink back into the floor
});
const marchMesh = flubber.mesh;
scene.add(marchMesh);

// ---- targeting: arcs live INSIDE the medium ------------------------------------------
// The electricity doesn't come from the sky — it discharges THROUGH the liquid,
// jumping between particle clusters. We read the particle positions back off the
// GPU every few frames and pick both endpoints from ACTUAL liquid, so every arc
// is a filament threading the mass, guaranteed to land on globules at both ends.
let parts = null;          // Float32Array of last-known particle positions
let pStride = 3;           // floats per particle in the storage buffer (3, maybe padded to 4)
let rbBusy = false;
async function readParticles() {
  if (rbBusy) return;
  rbBusy = true;
  try {
    const buf = await renderer.getArrayBufferAsync(flubber.pPos.value);
    const arr = new Float32Array(buf);
    pStride = Math.max(3, Math.round(arr.length / COUNT)); // detect vec3 vs padded vec4
    parts = arr;
  } catch (e) { /* buffer not ready on the very first frames */ }
  rbBusy = false;
}
const _a = new THREE.Vector3(), _b = new THREE.Vector3();
function particle(i, out) {
  const o = i * pStride;
  return out.set(parts[o], parts[o + 1], parts[o + 2]);
}
// two particles separated by [minD, maxD] → an arc that jumps globule-to-globule
// through the mass. Returns null until the first readback lands.
function pickArc(minD, maxD) {
  if (!parts) return null;
  const n = (parts.length / pStride) | 0;
  const i = (Math.random() * n) | 0;
  particle(i, _a);
  for (let t = 0; t < 16; t++) {
    const j = (Math.random() * n) | 0;
    if (j === i) continue;
    particle(j, _b);
    const d = _a.distanceTo(_b);
    if (d >= minD && d <= maxD) return { from: _a.clone(), to: _b.clone() };
  }
  return null;
}

// ---- arcs: seeded midpoint-displacement filaments THROUGH the liquid ----------------
const bolts = []; // live arcs, drawn on the 2D overlay and aged each frame

// deposit charge along a path so the whole CHANNEL lights, not just the ends —
// the electricity is IN the medium, glowing the liquid it threads through.
function chargePath(pts, r, amt) {
  flubber.injectCharge(pts[0].clone(), r, amt);
  flubber.injectCharge(pts[pts.length - 1].clone(), r, amt);
  const mid = pts[(pts.length / 2) | 0];
  if (mid) flubber.injectCharge(mid.clone(), r * 0.8, amt * 0.7);
}

// a micro-arc: short, dim, ephemeral. Dozens fire per second — the constant
// crackle of a charged conductor discharging across its own necks.
function spawnMicro() {
  const arc = pickArc(0.18, 0.6);
  if (!arc) return;
  const bolt = makeBolt({
    from: arc.from, to: arc.to,
    seed: (Math.random() * 1e9) | 0,
    levels: 4 + ((Math.random() * 2) | 0),      // 4-5 (short segments crinkle)
    roughness: 0.16 + Math.random() * 0.12,     // 0.16-0.28 — jittery
    decay: 0.5 + Math.random() * 0.12,
    branchP: 0.05 + Math.random() * 0.1,
    maxDepth: 1,
  });
  bolt.age = 0;
  bolt.life = 0.09 + Math.random() * 0.11;      // 90-200ms flicker
  bolt.intensity = 0.85;
  bolts.push(bolt);
  chargePath(bolt.paths[0].pts, 0.16, 0.7);
}

// a surge: a long, bright arc spanning the mass, plus a physical recoil where it
// lands. The occasional big discharge that punctuates the crackle.
function spawnSurge() {
  const arc = pickArc(0.55, 1.3);
  if (!arc) return;
  const bolt = makeBolt({
    from: arc.from, to: arc.to,
    seed: (Math.random() * 1e9) | 0,
    levels: 6 + ((Math.random() * 3) | 0),      // 6-8
    roughness: 0.1 + Math.random() * 0.1,
    decay: 0.5 + Math.random() * 0.12,
    branchP: 0.1 + Math.random() * 0.12,
    maxDepth: 2,
  });
  bolt.age = 0;
  bolt.life = 0.12 + Math.random() * 0.1;       // 120-220ms
  bolt.intensity = 1;
  bolts.push(bolt);
  chargePath(bolt.paths[0].pts, 0.28, 1.9);
  burst.trigger(arc.to, 0.6, 7); // the liquid kicks where the surge terminates
}

window.__strike = spawnSurge;
window.__boltCount = () => bolts.length;

// ---- 2D overlay: project the world-space bolt polylines and stroke them -------------
// additive halo + hot core, exactly the notebook's look (rung-3 §06), but the
// endpoints are projected from the 3D scene so the arcs stay pinned to the glass.
const boltCanvas = document.getElementById("bolts");
const bctx = boltCanvas.getContext("2d");
function sizeBolts() {
  const dpr = Math.min(window.devicePixelRatio, 2);
  boltCanvas.width = Math.round(window.innerWidth * dpr);
  boltCanvas.height = Math.round(window.innerHeight * dpr);
  bctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
sizeBolts();
const _p = new THREE.Vector3();
function project(v, W, H) {
  _p.copy(v).project(camera);
  return [(_p.x * 0.5 + 0.5) * W, (-_p.y * 0.5 + 0.5) * H];
}
function drawBolts(dt) {
  const W = window.innerWidth, H = window.innerHeight;
  bctx.clearRect(0, 0, W, H);
  if (!bolts.length) return;
  bctx.globalCompositeOperation = "lighter";
  bctx.lineJoin = "round";
  bctx.lineCap = "round";
  for (let b = bolts.length - 1; b >= 0; b--) {
    const bolt = bolts[b];
    bolt.age += dt;
    const env = boltFlicker(bolt.age, bolt.life) * (bolt.intensity ?? 1);
    if (env <= 0) { bolts.splice(b, 1); continue; }
    for (const path of bolt.paths) {
      const pr = path.pts.map((v) => project(v, W, H));
      // wide cold-blue halo → hot near-white core, matching the charge glow
      for (const [color, alpha, width] of [
        ["rgba(120,180,255,1)", 0.22 * path.bright * env, 13 * path.width],
        ["rgba(180,215,255,1)", 0.5 * path.bright * env, 4.5 * path.width],
        ["rgba(240,248,255,1)", 1.0 * path.bright * env, 1.8 * path.width],
      ]) {
        bctx.strokeStyle = color;
        bctx.globalAlpha = Math.min(1, alpha);
        bctx.lineWidth = width;
        bctx.beginPath();
        bctx.moveTo(pr[0][0], pr[0][1]);
        for (let i = 1; i < pr.length; i++) bctx.lineTo(pr[i][0], pr[i][1]);
        bctx.stroke();
      }
    }
  }
  bctx.globalAlpha = 1;
  bctx.globalCompositeOperation = "source-over";
}

// ---- emitter: perpetual discharge ----------------------------------------------------
// The medium is always live. Micro-arcs crackle continuously across the necks;
// surges punctuate them now and then. No long silence — the electricity never
// stops flowing through the liquid.
let microTimer = 0, surgeTimer = 0.8;
function emit(dt) {
  microTimer -= dt;
  while (microTimer <= 0) {
    const burstN = 2 + ((Math.random() * 3) | 0); // 2-4 filaments at once
    for (let i = 0; i < burstN; i++) spawnMicro();
    microTimer += 0.025 + Math.random() * 0.04;   // ~15-40 crackles/sec
  }
  surgeTimer -= dt;
  if (surgeTimer <= 0) {
    spawnSurge();
    surgeTimer = 0.5 + Math.random() * 1.3;        // a big one every ~0.5-1.8s
  }
}
let emitterOn = true;

// ---- input --------------------------------------------------------------------------
// click = a manual surge; "d" toggles the auto-emitter; "l" one surge
canvas.addEventListener("pointerdown", (e) => { if (e.button === 0) spawnSurge(); });
window.addEventListener("keydown", (e) => {
  if (e.key === "l") spawnSurge();
  if (e.key === "d") emitterOn = !emitterOn;
});

window.addEventListener("resize", () => {
  renderer.setSize(window.innerWidth, window.innerHeight);
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  sizeGrab();
  sizeBolts();
});

// ---- loop ---------------------------------------------------------------------------
let elapsed = 0, frame = 0;
const clock = new THREE.Clock();
const fpsEl = document.getElementById("fps");
let fpsFrames = 0, fpsStamp = 0;
renderer.setAnimationLoop(() => {
  const dt = Math.min(0.1, clock.getDelta());
  elapsed += dt;

  if (emitterOn) emit(dt);
  flubber.update(dt, elapsed);

  // refresh particle positions off the GPU a few times a second (async, cheap) —
  // the arc emitter reads these to pick endpoints on live liquid
  frame++;
  if (frame % 6 === 0) readParticles();

  synth.update(elapsed);
  controls.update();

  // grab pass: everything but the glass, into the refraction source
  marchMesh.visible = false;
  renderer.setRenderTarget(grabRT);
  renderer.render(scene, camera);
  renderer.setRenderTarget(null);
  marchMesh.visible = true;

  renderer.render(scene, camera);
  drawBolts(dt);
  window.__ready = true;

  fpsFrames++;
  if (elapsed - fpsStamp >= 0.5) {
    fpsEl.textContent = `${(fpsFrames / (elapsed - fpsStamp)).toFixed(0)} fps`;
    fpsFrames = 0;
    fpsStamp = elapsed;
  }
});
