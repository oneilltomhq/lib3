/**
 * Lightning Lab — lib3 example
 *
 * Standalone lightning effects demo. No cloud/smoke imports.
 * Demonstrates channel lightning (leader, return stroke, forked, crawler)
 * and ambient effects (sheet flash, charge glow).
 */
import * as THREE from 'three/webgpu';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { Inspector } from 'three/addons/inspector/Inspector.js';

import { LightningController } from '../../src/lightning/LightningController.js';
import { createSheetFlash, createChargeGlow } from '../../src/lightning/lightningEffects.js';

// ── Renderer ────────────────────────────────────────────────────────────────

const canvas = document.getElementById('canvas');
const renderer = new THREE.WebGPURenderer({ canvas, antialias: true });
renderer.setPixelRatio(window.devicePixelRatio);
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.inspector = new Inspector();
await renderer.init();

// ── Scene ───────────────────────────────────────────────────────────────────

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x060610);

const camera = new THREE.PerspectiveCamera(55, window.innerWidth / window.innerHeight, 0.1, 100);
camera.position.set(0, 0.5, 3);

const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 0, 0);
controls.update();

const clock = new THREE.Clock();

// ── Stage ───────────────────────────────────────────────────────────────────

// Dark neutral stage: subtle ground plane + wireframe reference box
const groundGeo = new THREE.PlaneGeometry(6, 6);
const groundMat = new THREE.MeshBasicMaterial({ color: 0x0a0a14 });
const ground = new THREE.Mesh(groundGeo, groundMat);
ground.rotation.x = -Math.PI / 2;
ground.position.y = -0.5;
scene.add(ground);

// Wireframe box showing the unit-cube [-0.5, 0.5]³ where lightning is generated
const wireGeo = new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1));
const wire = new THREE.LineSegments(wireGeo, new THREE.LineBasicMaterial({ color: 0x222244, transparent: true, opacity: 0.3 }));
scene.add(wire);

// Subtle ambient
const ambient = new THREE.AmbientLight(0x111122, 0.5);
scene.add(ambient);

// ── Lightning Controller ────────────────────────────────────────────────────

const lightning = new LightningController(scene);

// ── Ambient Effects ─────────────────────────────────────────────────────────

const sheetFlash = createSheetFlash({
  color: new THREE.Color(0x8899cc),
  glowRadius: 0.35,
  glowIntensity: 2.0,
  flashDuration: 0.15,
  flashFalloff: 4.0,
});
sheetFlash.mesh.scale.set(2, 2, 2);
scene.add(sheetFlash.mesh);

const chargeGlow = createChargeGlow({
  color: new THREE.Color(0x4466aa),
  glowRadius: 0.25,
  glowIntensity: 1.5,
  pulseSpeed: 2.0,
});
chargeGlow.mesh.scale.set(1.5, 1.5, 1.5);
scene.add(chargeGlow.mesh);

// ── Parameters ──────────────────────────────────────────────────────────────

const params = {
  // Type
  type: 'forked', // current preset

  // Generation
  segments: 28,
  jitter: 0.16,
  branchDepth: 3,
  forkProbability: 0.35,
  branchLength: 5,
  taperRate: 0.35,
  lateralBias: 0.0,

  // Rendering
  coreWidth: 0.008,
  haloWidth: 0.04,
  coreIntensity: 3.0,
  haloIntensity: 1.2,
  coreColor: 0xeef4ff,
  haloColor: 0x6688ff,
  flickerFrequency: 30.0,
  flickerDepth: 0.3,

  // Timing
  leaderSpeed: 3.0,
  strokeDuration: 0.12,
  restrikeCount: 2,
  restrikeInterval: 0.08,
  fadeRate: 2.0,

  // Ambient
  sheetGlowRadius: 0.35,
  sheetGlowIntensity: 2.0,
  sheetFlashDuration: 0.15,
  sheetFlashFalloff: 4.0,
  chargeGlowColor: 0x4466aa,
  chargeGlowRadius: 0.25,
  chargeGlowIntensity: 1.5,

  // Seed
  seed: 42,
  autoSeed: true,
};

let nextSeed = 42;

// ── Strike Trigger ──────────────────────────────────────────────────────────

function triggerStrike(startPos, endPos) {
  const seed = params.autoSeed ? nextSeed++ : params.seed;

  if (params.type === 'sheetFlash') {
    sheetFlash.trigger(startPos ? new THREE.Vector3(startPos.x - 0.5, startPos.y - 0.5, startPos.z - 0.5) : undefined);
    return;
  }

  if (params.type === 'chargeGlow') {
    const center = startPos
      ? new THREE.Vector3(startPos.x - 0.5, startPos.y - 0.5, startPos.z - 0.5)
      : new THREE.Vector3(0, 0, 0);
    chargeGlow.setCenter(center);
    chargeGlow.setActive(true);
    // Auto-deactivate after 2 seconds
    setTimeout(() => chargeGlow.setActive(false), 2000);
    return;
  }

  const start = startPos ?? { x: 0.5, y: 0.95, z: 0.5 };
  const end = endPos ?? { x: 0.5, y: 0.05, z: 0.5 };

  lightning.trigger({
    preset: params.type,
    seed,
    start,
    end,
    leaderSpeed: params.leaderSpeed,
    strokeDuration: params.strokeDuration,
    restrikeCount: params.restrikeCount,
    restrikeInterval: params.restrikeInterval,
    fadeRate: params.fadeRate,
    generationOpts: {
      segments: params.segments,
      jitter: params.jitter,
      branchDepth: params.branchDepth,
      forkProbability: params.forkProbability,
      branchLength: params.branchLength,
      taperRate: params.taperRate,
      lateralBias: params.lateralBias,
    },
    materialOpts: {
      coreColor: new THREE.Color(params.coreColor),
      haloColor: new THREE.Color(params.haloColor),
      coreIntensity: params.coreIntensity,
      haloIntensity: params.haloIntensity,
      flickerFrequency: params.flickerFrequency,
      flickerDepth: params.flickerDepth,
    },
    geometryOpts: {
      coreWidth: params.coreWidth,
      haloWidth: params.haloWidth,
    },
  });
}

// ── Click to Strike ─────────────────────────────────────────────────────────

const raycaster = new THREE.Raycaster();
const mouse = new THREE.Vector2();

canvas.addEventListener('click', (e) => {
  const rect = canvas.getBoundingClientRect();
  mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
  mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;

  raycaster.setFromCamera(mouse, camera);

  // Intersect with the wireframe box area
  const boxMesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
  boxMesh.visible = false;
  const hits = raycaster.intersectObject(boxMesh);

  if (hits.length > 0) {
    const p = hits[0].point;
    // Map from [-0.5, 0.5] local to [0,1] unit cube
    const unitPos = {
      x: Math.max(0, Math.min(1, p.x + 0.5)),
      y: Math.max(0, Math.min(1, p.y + 0.5)),
      z: Math.max(0, Math.min(1, p.z + 0.5)),
    };
    // Strike from top to click point
    const startPos = { x: unitPos.x + (Math.random() - 0.5) * 0.1, y: 0.95, z: unitPos.z };
    triggerStrike(startPos, unitPos);
  } else {
    // Fallback: strike at default position
    triggerStrike();
  }
});

// ── GUI ─────────────────────────────────────────────────────────────────────

const gui = renderer.inspector.createParameters('Lightning Lab');

// Type selector
const typeFolder = gui.addFolder('Type');
typeFolder.add(params, 'type', ['leader', 'returnStroke', 'forked', 'crawler', 'sheetFlash', 'chargeGlow']).name('lightning type');
typeFolder.add({ trigger: () => triggerStrike() }, 'trigger').name('⚡ Trigger Strike');

// Generation
const genFolder = gui.addFolder('Generation');
genFolder.add(params, 'segments', 8, 48, 1).name('segments');
genFolder.add(params, 'jitter', 0.0, 0.5, 0.01).name('jitter');
genFolder.add(params, 'branchDepth', 0, 5, 1).name('branch depth');
genFolder.add(params, 'forkProbability', 0.0, 0.8, 0.01).name('fork probability');
genFolder.add(params, 'branchLength', 1, 10, 1).name('branch length');
genFolder.add(params, 'taperRate', 0.0, 0.8, 0.01).name('taper rate');
genFolder.add(params, 'lateralBias', 0.0, 0.5, 0.01).name('lateral bias');

// Rendering
const renderFolder = gui.addFolder('Rendering');
renderFolder.add(params, 'coreWidth', 0.001, 0.03, 0.001).name('core width');
renderFolder.add(params, 'haloWidth', 0.005, 0.1, 0.005).name('halo width');
renderFolder.add(params, 'coreIntensity', 0.5, 8.0, 0.1).name('core intensity');
renderFolder.add(params, 'haloIntensity', 0.2, 4.0, 0.1).name('halo intensity');
renderFolder.addColor(params, 'coreColor').name('core color');
renderFolder.addColor(params, 'haloColor').name('halo color');
renderFolder.add(params, 'flickerFrequency', 5, 80, 1).name('flicker freq');
renderFolder.add(params, 'flickerDepth', 0.0, 0.8, 0.01).name('flicker depth');

// Timing
const timingFolder = gui.addFolder('Timing');
timingFolder.add(params, 'leaderSpeed', 0.5, 10.0, 0.1).name('leader speed');
timingFolder.add(params, 'strokeDuration', 0.02, 0.5, 0.01).name('stroke duration');
timingFolder.add(params, 'restrikeCount', 0, 6, 1).name('re-strike count');
timingFolder.add(params, 'restrikeInterval', 0.02, 0.3, 0.01).name('re-strike interval');
timingFolder.add(params, 'fadeRate', 0.5, 8.0, 0.1).name('fade rate');

// Ambient
const ambientFolder = gui.addFolder('Ambient');
ambientFolder.add(params, 'sheetGlowRadius', 0.1, 0.8, 0.01).name('sheet glow radius').onChange((v) => {
  sheetFlash.uniforms.glowRadius.value = v;
});
ambientFolder.add(params, 'sheetGlowIntensity', 0.5, 5.0, 0.1).name('sheet intensity').onChange((v) => {
  sheetFlash.uniforms.glowIntensity.value = v;
});
ambientFolder.add(params, 'sheetFlashDuration', 0.05, 0.5, 0.01).name('flash duration').onChange((v) => {
  sheetFlash.uniforms.flashDuration.value = v;
});
ambientFolder.add(params, 'sheetFlashFalloff', 1.0, 10.0, 0.1).name('flash falloff').onChange((v) => {
  sheetFlash.uniforms.flashFalloff.value = v;
});
ambientFolder.addColor(params, 'chargeGlowColor').name('charge color').onChange((v) => {
  chargeGlow.uniforms.color.value.setHex(v);
});
ambientFolder.add(params, 'chargeGlowRadius', 0.1, 0.6, 0.01).name('charge radius').onChange((v) => {
  chargeGlow.uniforms.glowRadius.value = v;
});
ambientFolder.add(params, 'chargeGlowIntensity', 0.5, 4.0, 0.1).name('charge intensity').onChange((v) => {
  chargeGlow.uniforms.glowIntensity.value = v;
});

// Seed
const seedFolder = gui.addFolder('Seed');
seedFolder.add(params, 'seed', 0, 9999, 1).name('seed');
seedFolder.add(params, 'autoSeed').name('auto-increment seed');

// ── Resize ──────────────────────────────────────────────────────────────────

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// ── Animate ─────────────────────────────────────────────────────────────────

renderer.setAnimationLoop(() => {
  const dt = Math.min(0.1, clock.getDelta());

  lightning.update(dt);
  sheetFlash.update(dt);
  chargeGlow.update(dt);

  controls.update();
  renderer.render(scene, camera);
});
