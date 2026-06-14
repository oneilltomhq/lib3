import * as THREE from "three/webgpu";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import {
  METABALL_DEBUG_MODES,
  RaymarchedMetaballs,
} from "../../src/metaballs.js";

const canvas = document.getElementById("canvas");
const modeButtons = document.getElementById("modeButtons");
const readout = document.getElementById("readout");
const explain = document.getElementById("explain");
const stackReadout = document.getElementById("stackReadout");
const sourcesToggle = document.getElementById("sourcesToggle");
const backgroundPattern = document.getElementById("backgroundPattern");
const smoothingSlider = document.getElementById("smoothingSlider");
const smoothingValue = document.getElementById("smoothingValue");
const refractionSlider = document.getElementById("refractionSlider");
const refractionValue = document.getElementById("refractionValue");
const stepsSlider = document.getElementById("stepsSlider");
const stepsValue = document.getElementById("stepsValue");
let currentMode = METABALL_DEBUG_MODES.MASK;

const renderer = new THREE.WebGPURenderer({ canvas, antialias: true });
renderer.autoClear = false;
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.75));
renderer.setSize(window.innerWidth, window.innerHeight);

const scene = new THREE.Scene();
scene.background = null;

const camera = new THREE.PerspectiveCamera(
  42,
  window.innerWidth / window.innerHeight,
  0.1,
  50
);
camera.position.set(0, 0.2, 6);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.enablePan = false;
controls.minDistance = 4;
controls.maxDistance = 20;

const keyLight = new THREE.DirectionalLight(0xffffff, 3);
keyLight.position.set(-3, 4, 5);
scene.add(keyLight);
scene.add(new THREE.AmbientLight(0xaab2ff, 0.45));

const backgroundScene = new THREE.Scene();
backgroundScene.background = new THREE.Color(0x08090b);
backgroundScene.add(keyLight.clone());
backgroundScene.add(new THREE.AmbientLight(0xaab2ff, 0.45));

const targetOptions = {
  type: THREE.HalfFloatType,
  minFilter: THREE.LinearFilter,
  magFilter: THREE.LinearFilter,
};
const backgroundTarget = new THREE.RenderTarget(
  window.innerWidth,
  window.innerHeight,
  targetOptions
);

const backgroundTextures = {
  plain: makeBackgroundTexture("plain"),
  grid: makeBackgroundTexture("grid"),
  stripes: makeBackgroundTexture("stripes"),
};
const floorMaterial = new THREE.MeshBasicMaterial({
  map: backgroundTextures[backgroundPattern.value],
});
const floor = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), floorMaterial);
backgroundScene.add(floor);

const markerGeometry = new THREE.IcosahedronGeometry(1, 2);
const markerMaterials = [
  makeMarkerMaterial(0xff7aa8),
  makeMarkerMaterial(0x7af0ff),
  makeMarkerMaterial(0xffdc7a),
];

const sources = Array.from({ length: 18 }, (_, i) => ({
  position: new THREE.Vector3(),
  radius: 0.14 + Math.pow((i % 6) / 5, 1.5) * 0.34,
  phase: i * 0.73,
  lane: i % 3,
}));

const markers = sources.map((source, i) => {
  const marker = new THREE.Mesh(
    markerGeometry,
    markerMaterials[i % markerMaterials.length]
  );
  marker.renderOrder = 20;
  marker.scale.setScalar(source.radius);
  scene.add(marker);
  return marker;
});

const metaballs = new RaymarchedMetaballs({
  camera,
  sources,
  sceneTexture: backgroundTarget.texture,
  rimTexture: backgroundTarget.texture,
  smoothing: 0.34,
  refractionStrength: 0.2,
  fresnelBase: 1,
  fresnelStrength: 0,
  rimStrength: 0,
  quadZ: 2.35,
});
scene.add(metaballs.mesh);

const debugModes = [
  [METABALL_DEBUG_MODES.MASK, "shape"],
  [METABALL_DEBUG_MODES.REFRACTED, "refraction"],
];

const explanations = {
  [METABALL_DEBUG_MODES.MASK]:
    "Shape: the raymarched SDF is visible as a solid mask over the same background texture that the shader can sample.",
  [METABALL_DEBUG_MODES.REFRACTED]:
    "Refraction: the same SDF surface estimates a normal and uses it to offset the background texture lookup.",
};

const stackLabels = {
  [METABALL_DEBUG_MODES.MASK]: "SDF sources -> raymarched shape",
  [METABALL_DEBUG_MODES.REFRACTED]: "SDF shape -> normal -> background offset",
};

for (const [mode, label] of debugModes) {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = label;
  button.dataset.mode = mode;
  button.addEventListener("click", () => setDebugMode(mode));
  modeButtons.append(button);
}

function setDebugMode(mode) {
  currentMode = mode;
  metaballs.setDebugMode(mode);
  for (const button of modeButtons.children) {
    button.setAttribute("aria-pressed", String(button.dataset.mode === mode));
  }
  explain.textContent = explanations[mode];
  stackReadout.textContent = stackLabels[mode];
}

function syncControls() {
  const smoothing = Number(smoothingSlider.value);
  const refraction = Number(refractionSlider.value);
  const steps = Number(stepsSlider.value);

  metaballs.setSmoothing(smoothing);
  metaballs.refractionStrength.value = refraction;
  metaballs.maxSteps.value = steps;
  floorMaterial.map = backgroundTextures[backgroundPattern.value];
  floorMaterial.needsUpdate = true;

  smoothingValue.textContent = smoothing.toFixed(2);
  refractionValue.textContent = refraction.toFixed(2);
  stepsValue.textContent = String(steps);
}

[smoothingSlider, refractionSlider, stepsSlider].forEach((input) => {
  input.addEventListener("input", syncControls);
});

[sourcesToggle, backgroundPattern].forEach((input) => {
  input.addEventListener("input", syncControls);
});

setDebugMode(METABALL_DEBUG_MODES.MASK);
syncControls();

function updateSources(time) {
  for (let i = 0; i < sources.length; i++) {
    const source = sources[i];
    const lane = source.lane - 1;
    const t = time * (0.52 + source.lane * 0.09) + source.phase;

    source.position.set(
      0.45 + Math.sin(t * 0.91) * 1.35 + lane * 0.35,
      Math.sin(t * 1.31 + lane) * 0.85,
      Math.cos(t * 0.73 + i * 0.11) * 0.55
    );

    markers[i].position.copy(source.position);
    markers[i].rotation.set(t * 0.3, t * 0.5, t * 0.2);
  }
}

function resize() {
  const width = window.innerWidth;
  const height = window.innerHeight;

  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.75));
  renderer.setSize(width, height);
  backgroundTarget.setSize(width, height);

  camera.aspect = width / height;
  camera.position.z = camera.aspect < 0.75 ? 17 : 6;
  camera.updateProjectionMatrix();
}

window.addEventListener("resize", resize);
resize();

function fitBackgroundPlate() {
  const distance = 8;
  const halfH = Math.tan((camera.fov / 2) * Math.PI / 180) * distance;
  const halfW = halfH * camera.aspect;
  const forward = new THREE.Vector3();

  camera.updateMatrixWorld();
  camera.getWorldDirection(forward);
  floor.position.copy(camera.position).addScaledVector(forward, distance);
  floor.quaternion.copy(camera.quaternion);
  floor.scale.set(halfW * 2, halfH * 2, 1);
}

function makeMarkerMaterial(color) {
  return new THREE.MeshBasicMaterial({
    color,
    depthTest: false,
    depthWrite: false,
    opacity: 0.5,
    transparent: true,
    wireframe: true,
  });
}

function makeBackgroundTexture(pattern) {
  const size = 256;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#17202a";
  ctx.fillRect(0, 0, size, size);

  const gradient = ctx.createLinearGradient(0, 0, size, size);
  gradient.addColorStop(0, "rgba(43, 65, 89, 0.9)");
  gradient.addColorStop(0.5, "rgba(34, 51, 46, 0.9)");
  gradient.addColorStop(1, "rgba(68, 45, 58, 0.9)");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, size, size);

  if (pattern === "grid") {
    ctx.strokeStyle = "rgba(255,255,255,0.18)";
    ctx.lineWidth = 1;
    for (let i = 0; i <= size; i += 32) {
      ctx.beginPath();
      ctx.moveTo(i, 0);
      ctx.lineTo(i, size);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(0, i);
      ctx.lineTo(size, i);
      ctx.stroke();
    }
  }

  if (pattern === "stripes") {
    for (let i = -size; i < size * 2; i += 24) {
      ctx.fillStyle = "rgba(255,255,255,0.16)";
      ctx.fillRect(i, 0, 8, size);
    }
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(2, 1);
  return texture;
}

renderer.setAnimationLoop((milliseconds) => {
  const time = milliseconds / 1000;
  controls.update();
  updateSources(time);
  markers.forEach((marker) => {
    marker.visible = sourcesToggle.checked;
  });
  fitBackgroundPlate();
  metaballs.update();
  readout.textContent = `${sources.length} animated SDF sources`;

  renderer.setRenderTarget(backgroundTarget);
  renderer.clear();
  renderer.render(backgroundScene, camera);

  renderer.setRenderTarget(null);
  renderer.clear();
  renderer.render(backgroundScene, camera);
  renderer.clearDepth();

  renderer.render(scene, camera);
});
