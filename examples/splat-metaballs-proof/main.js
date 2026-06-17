import * as THREE from "three/webgpu";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import {
  Fn,
  cos,
  float,
  hash,
  instanceIndex,
  instancedArray,
  length,
  mix,
  sin,
  smoothstep,
  uint,
  uniform,
  uv,
  vec3,
  vec4,
} from "three/tsl";

const MAX_SOURCES = 1024;
const TAU = 6.2831853;

const canvas = document.getElementById("canvas");
const status = document.getElementById("status");
const readout = document.getElementById("readout");
const sourceCountSelect = document.getElementById("sourceCount");
const sourceCountValue = document.getElementById("sourceCountValue");
const motionButton = document.getElementById("motion");

let renderer;
let scene;
let camera;
let controls;
let splats;
let computeSources;
let motionEnabled = false;
let lastFrame = 0;
let fps = 0;

const sourceCount = uniform(Number(sourceCountSelect.value), "int");
const timeSeconds = uniform(0);
const motionAmount = uniform(0);
const sources = instancedArray(MAX_SOURCES, "vec4").setName("SplatSources");

window.addEventListener("error", (event) => {
  status.textContent = `Runtime error: ${event.message}`;
});
window.addEventListener("unhandledrejection", (event) => {
  status.textContent = `Runtime error: ${event.reason?.message ?? event.reason}`;
});

init().catch((error) => {
  status.textContent = `Init failed: ${error.message}`;
  console.error(error);
});

async function init() {
  renderer = new THREE.WebGPURenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setClearColor(0x07090d, 1);
  await renderer.init();

  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x07090d);

  camera = new THREE.PerspectiveCamera(
    48,
    window.innerWidth / window.innerHeight,
    0.1,
    80
  );
  camera.position.set(0, 0.6, 7.2);

  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.target.set(0, 0, 0);
  controls.minDistance = 3;
  controls.maxDistance = 15;

  scene.add(new THREE.GridHelper(9, 24, 0x385468, 0x1b2a32));
  scene.add(new THREE.AmbientLight(0xffffff, 0.7));

  computeSources = makeSourceCompute();
  await renderer.computeAsync(computeSources);

  splats = makeSplats();
  scene.add(splats);

  sourceCountSelect.addEventListener("input", syncControls);
  motionButton.addEventListener("click", () => {
    motionEnabled = !motionEnabled;
    motionAmount.value = motionEnabled ? 1 : 0;
    motionButton.setAttribute("aria-pressed", String(motionEnabled));
    renderer.compute(computeSources);
  });
  window.addEventListener("resize", resize);

  syncControls();
  resize();
  renderer.setAnimationLoop(animate);

  status.textContent = renderer.backend?.isWebGPUBackend
    ? "WebGPU active. Compute updates storage buffer; instanced splats read it as attributes."
    : "WebGL fallback active. Need WebGPU browser for storage-buffer proof.";

  window.__splatMetaballsProof = {
    renderer,
    sources,
    setSourceCount(count) {
      sourceCountSelect.value = String(count);
      syncControls();
    },
    getStats() {
      return {
        backend: renderer.backend?.isWebGPUBackend ? "WebGPU" : "fallback",
        sourceCount: sourceCount.value,
        motion: motionEnabled,
        fps: Math.round(fps),
      };
    },
  };
}

function makeSourceCompute() {
  return Fn(() => {
    const source = sources.element(instanceIndex);
    const lane = float(instanceIndex.mod(uint(32)));
    const row = float(instanceIndex.div(uint(32)).mod(uint(32)));
    const id = instanceIndex;
    const base = vec3(
      lane.sub(15.5).mul(0.14),
      row.sub(15.5).mul(0.1),
      hash(id.add(uint(17))).sub(0.5).mul(1.8)
    );
    const phase = hash(id.add(uint(41))).mul(TAU);
    const speed = hash(id.add(uint(73))).remap(0.25, 1.5);
    const orbit = hash(id.add(uint(101))).remap(0.015, 0.09);
    const t = timeSeconds.mul(speed).add(phase);
    const wobble = vec3(
      cos(t).mul(orbit),
      sin(t.mul(1.37)).mul(orbit),
      sin(t.mul(0.83)).mul(orbit.mul(2.2))
    ).mul(motionAmount);
    const radius = hash(id.add(uint(149))).remap(0.035, 0.065);

    source.assign(vec4(base.add(wobble), radius));
  })().compute(MAX_SOURCES).setName("Update Splat Sources");
}

function makeSplats() {
  const material = new THREE.SpriteNodeMaterial({
    transparent: true,
    depthWrite: false,
    depthTest: false,
    blending: THREE.NormalBlending,
  });
  const source = sources.toAttribute();
  const local = uv().sub(0.5);
  const r = length(local).mul(2);
  const core = smoothstep(1, 0, r);
  const glow = smoothstep(1, 0, r).pow(2.2);
  const tint = mix(vec3(0.45, 0.84, 1.0), vec3(1.0, 0.82, 0.54), hash(instanceIndex).mul(0.55));

  material.positionNode = source.xyz;
  material.scaleNode = source.w.mul(0.35);
  material.colorNode = tint.mul(core.mul(0.06).add(glow.mul(0.08)));
  material.opacityNode = glow.mul(0.015);

  const mesh = new THREE.InstancedMesh(
    new THREE.PlaneGeometry(1, 1),
    material,
    MAX_SOURCES
  );
  mesh.frustumCulled = false;
  return mesh;
}

function syncControls() {
  const count = Number(sourceCountSelect.value);
  sourceCount.value = count;
  sourceCountValue.textContent = String(count);
  if (splats) splats.count = count;
}

function animate() {
  const now = performance.now();
  timeSeconds.value = now * 0.001;
  controls.update();
  if (motionEnabled) renderer.compute(computeSources);
  renderer.render(scene, camera);

  if (lastFrame > 0) {
    const instant = 1000 / Math.max(1, now - lastFrame);
    fps = fps === 0 ? instant : THREE.MathUtils.lerp(fps, instant, 0.08);
  }
  lastFrame = now;

  readout.textContent = `${sourceCount.value} GPU splats | motion ${
    motionEnabled ? "on" : "off"
  } | ${Math.round(fps)} fps`;
}

function resize() {
  const width = window.innerWidth;
  const height = window.innerHeight;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
  renderer.setSize(width, height);
  camera.aspect = width / height;
  camera.updateProjectionMatrix();
}
