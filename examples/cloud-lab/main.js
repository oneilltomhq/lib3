/**
 * Cloud Lab — Standalone volumetric storm cloud example.
 *
 * Wires SmokeVolume + VolumeSmokeNodeMaterial + ComputeMipAwareBlueNoise
 * directly — no wrapper class, no lightning imports.
 * All parameters exposed via inspector GUI.
 */
import * as THREE from 'three/webgpu';
import { uniform } from 'three/tsl';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { Inspector } from 'three/addons/inspector/Inspector.js';

import { SmokeVolume } from '../../src/fluidSim.js';
import { VolumeSmokeNodeMaterial } from '../../src/smokeMaterial.js';
import { ComputeMipAwareBlueNoise } from '../../src/blueNoise.js';

// === Renderer ===
const canvas = document.getElementById('canvas');
const renderer = new THREE.WebGPURenderer({ canvas, antialias: true });
renderer.setPixelRatio(window.devicePixelRatio);
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.inspector = new Inspector();
await renderer.init();

// === Scene + Camera ===
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(55, window.innerWidth / window.innerHeight, 0.1, 1000);
camera.position.set(0, 3, 15);
new OrbitControls(camera, renderer.domElement);

const clock = new THREE.Clock();

// === Fluid simulation ===
const fluid = new SmokeVolume({
  simRes: 64,
  dyeRes: 96,
  iterations: 40,
  densityDissipation: 0.995,
  velocityDissipation: 0.985,
  pressureDissipation: 0.98,
  curlStrength: 6,
  pressureFactor: 1 / 6,
  radius: 0.2,
  useBoundaries: true,
  neighborStride: 1,
  speedFactor: 1,
  buoyancyStrength: 0,
});

// === Blue noise ===
const blueNoise = new ComputeMipAwareBlueNoise(128, 128);
const blueNoiseTex = blueNoise.init(renderer);

// === Smoke material ===
const dyeTexelSize = uniform(new THREE.Vector3(
  1 / fluid.dyeRes, 1 / fluid.dyeRes, 1 / fluid.dyeRes
), 'vec3');

const material = new VolumeSmokeNodeMaterial({
  densityTexture: fluid.getDensityTexture3D(),
  velocityTexture: fluid.getVelocityTexture3D(),
  curlTexture: fluid.getCurlTexture3D(),
  pressureTexture: fluid.getPressureTexture3D(),
  divergenceTexture: fluid.getDivergenceTexture3D(),
  dyeTexelSize,
  steps: 120,
  lightDir: new THREE.Vector3(-0.35, 0.9, 0.4),
  baseColor: new THREE.Color(0x1f232b),
  highlightColor: new THREE.Color(0x97a3b5),
  lightColor: new THREE.Color(0xf4f7ff),
  ambientLight: 0.65,
  lightStrength: 1.45,
  rimStrength: 0.9,
  densityBoost: 6.65,
  absorption: 17.1,
  curlInfluence: 0.6,
  velocityInfluence: 0.6,
  pressureInfluence: 0.4,
  divergenceInfluence: 0.0,
  brightness: 0.35,
  blueNoiseTexture: blueNoiseTex,
  anisotropy: 0.6,
  shadowSteps: 6,
  shadowIntensity: 0.7,
  adaptiveStepThreshold: 0.05,
});

// === Mesh ===
const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), material);
mesh.scale.set(10, 10, 10);
mesh.frustumCulled = false;
scene.add(mesh);

// Wireframe debug box
const wireGeo = new THREE.EdgesGeometry(new THREE.BoxGeometry(10, 10, 10));
const wire = new THREE.LineSegments(wireGeo, new THREE.LineBasicMaterial({ color: 0xffffff }));
scene.add(wire);

// === Ambient cloud seeding ===
// Continuous programmatic splats to build and sustain cloud density
// without any pointer interaction.
let seedTime = 0;

function seedCloud(dt) {
  seedTime += dt;

  // Inject 3-5 splats per frame from randomised positions inside the volume,
  // with gentle upward/outward forces to create turbulent cloud shapes.
  const splatCount = 3 + Math.floor(Math.random() * 3);
  for (let i = 0; i < splatCount; i++) {
    // Cluster density toward center with gaussian-ish distribution
    const cx = 0.5 + (Math.random() - 0.5) * 0.4;
    const cy = 0.4 + (Math.random() - 0.5) * 0.3;
    const cz = 0.5 + (Math.random() - 0.5) * 0.4;

    // Gentle swirling upward forces — buoyant turbulence
    const angle = seedTime * 0.3 + i * 2.1;
    const fx = Math.sin(angle) * 120;
    const fy = 60 + Math.random() * 80;
    const fz = Math.cos(angle) * 120;

    fluid.addSplat(cx, cy, cz, fx, fy, fz);
  }
}

// === GUI ===
const gui = renderer.inspector.createParameters('Cloud Lab');

// -- Simulation folder --
const simFolder = gui.addFolder('Simulation');
simFolder.add(fluid.densityDissipation, 'value', 0.9, 1.0, 0.001).name('densityDissipation');
simFolder.add(fluid.velocityDissipation, 'value', 0.9, 1.0, 0.001).name('velocityDissipation');
simFolder.add(fluid.pressureDissipation, 'value', 0.9, 1.0, 0.001).name('pressureDissipation');
simFolder.add(fluid.curlStrength, 'value', 0, 40, 0.5).name('curlStrength');
simFolder.add(fluid.buoyancyStrength, 'value', 0, 5, 0.1).name('buoyancyStrength');
simFolder.add(fluid.pressureFactor, 'value', 0, 1, 0.01).name('pressureFactor');

const simParams = { iterations: fluid.iterations };
simFolder.add(simParams, 'iterations', 1, 80, 1).onChange((v) => { fluid.iterations = v; });

// -- Rendering folder --
const renderFolder = gui.addFolder('Rendering');
renderFolder.add(material._steps, 'value', 16, 256, 1).name('steps');
renderFolder.add(material._absorption, 'value', 0, 40, 0.1).name('absorption');
renderFolder.add(material._densityBoost, 'value', 0, 20, 0.05).name('densityBoost');
renderFolder.add(material._ambientLight, 'value', 0, 2, 0.01).name('ambientLight');
renderFolder.add(material._lightStrength, 'value', 0, 5, 0.01).name('lightStrength');
renderFolder.add(material._rimStrength, 'value', 0, 3, 0.01).name('rimStrength');
renderFolder.add(material._brightness, 'value', 0, 2, 0.01).name('brightness');
renderFolder.add(material._anisotropy, 'value', -1, 1, 0.01).name('anisotropy');
renderFolder.add(material._shadowSteps, 'value', 1, 16, 1).name('shadowSteps');
renderFolder.add(material._shadowIntensity, 'value', 0, 2, 0.01).name('shadowIntensity');
renderFolder.add(material._adaptiveStepThreshold, 'value', 0, 0.5, 0.005).name('adaptiveStepThreshold');

// -- Colors folder --
const colorFolder = gui.addFolder('Colors');
const colorParams = {
  baseColor: material._baseColor.value.getHex(),
  highlightColor: material._highlightColor.value.getHex(),
  lightColor: material._lightColor.value.getHex(),
};
colorFolder.addColor(colorParams, 'baseColor').onChange((v) => { material._baseColor.value.setHex(v); });
colorFolder.addColor(colorParams, 'highlightColor').onChange((v) => { material._highlightColor.value.setHex(v); });
colorFolder.addColor(colorParams, 'lightColor').onChange((v) => { material._lightColor.value.setHex(v); });

// -- Light direction folder --
const lightDirFolder = gui.addFolder('Light Direction');
lightDirFolder.add(material._lightDir.value, 'x', -1, 1, 0.01).name('lightDir.x');
lightDirFolder.add(material._lightDir.value, 'y', -1, 1, 0.01).name('lightDir.y');
lightDirFolder.add(material._lightDir.value, 'z', -1, 1, 0.01).name('lightDir.z');

// === Resize ===
window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// === Animate ===
renderer.setAnimationLoop(() => {
  const dt = Math.min(0.1, clock.getDelta());
  seedCloud(dt);
  fluid.step(renderer);
  renderer.render(scene, camera);
});
