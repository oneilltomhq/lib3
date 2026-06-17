import * as THREE from "three/webgpu";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { RaymarchingBox } from "three/addons/tsl/utils/Raymarching.js";
import {
  Break,
  Fn,
  If,
  Loop,
  clamp,
  cos,
  float,
  hash,
  instanceIndex,
  int,
  length,
  mix,
  sin,
  smoothstep,
  texture3D,
  textureStore,
  uint,
  uniform,
  vec3,
  vec4,
} from "three/tsl";

const GRID_SIZE = 48;
const MAX_SOURCES = 512;
const TAU = 6.2831853;

const canvas = document.getElementById("canvas");
const status = document.getElementById("status");
const readout = document.getElementById("readout");
const sourceCountSelect = document.getElementById("sourceCount");
const sourceCountValue = document.getElementById("sourceCountValue");
const motionButton = document.getElementById("motion");
const resetButton = document.getElementById("reset");

let renderer;
let camera;
let scene;
let controls;
let computeDensity;
let lastFrame = 0;
let fps = 0;
let seedOffset = 11;
let motionEnabled = true;

const sourceCount = uniform(Number(sourceCountSelect.value), "int");
const timeSeconds = uniform(0);
const motionAmount = uniform(1);
const seedUniform = uniform(seedOffset, "uint");
const densityThreshold = uniform(0.18);
const densityRange = uniform(0.16);
const opacity = uniform(0.16);
const steps = uniform(92);

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
  await renderer.init();

  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x07090d);

  camera = new THREE.PerspectiveCamera(
    48,
    window.innerWidth / window.innerHeight,
    0.1,
    40
  );
  camera.position.set(0, 0.2, 4.2);

  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.target.set(0, 0, 0);
  controls.minDistance = 2.2;
  controls.maxDistance = 9;

  scene.add(makeGrid());
  scene.add(new THREE.AmbientLight(0xffffff, 0.7));

  const densityTexture = new THREE.Storage3DTexture(
    GRID_SIZE,
    GRID_SIZE,
    GRID_SIZE
  );
  densityTexture.name = "MetaballDensityGrid";
  densityTexture.generateMipmaps = false;

  computeDensity = makeDensityCompute(densityTexture);
  await renderer.computeAsync(computeDensity);

  const volume = makeVolumeMesh(densityTexture);
  scene.add(volume);

  sourceCountSelect.addEventListener("input", syncControls);
  motionButton.addEventListener("click", () => {
    motionEnabled = !motionEnabled;
    motionAmount.value = motionEnabled ? 1 : 0;
    motionButton.setAttribute("aria-pressed", String(motionEnabled));
    renderer.compute(computeDensity);
  });
  resetButton.addEventListener("click", () => {
    seedOffset += 977;
    seedUniform.value = seedOffset;
    renderer.compute(computeDensity);
  });
  window.addEventListener("resize", resize);

  renderer.setAnimationLoop(animate);
  resize();
  syncControls();

  status.textContent = renderer.backend?.isWebGPUBackend
    ? "WebGPU active. Compute builds density grid; fragment raymarch samples texture."
    : "WebGL fallback active. Need WebGPU browser for compute texture proof.";

  window.__volumeMetaballsProof = {
    renderer,
    densityTexture,
    setSourceCount(count) {
      sourceCountSelect.value = String(count);
      syncControls();
    },
    getStats() {
      return {
        backend: renderer.backend?.isWebGPUBackend ? "WebGPU" : "fallback",
        gridSize: GRID_SIZE,
        sourceCount: sourceCount.value,
        motion: motionEnabled,
        fps: Math.round(fps),
      };
    },
  };
}

function makeDensityCompute(densityTexture) {
  return Fn(() => {
    const id = instanceIndex;
    const x = id.mod(GRID_SIZE);
    const y = id.div(GRID_SIZE).mod(GRID_SIZE);
    const z = id.div(GRID_SIZE * GRID_SIZE);
    const uvw = vec3(x, y, z).add(0.5).div(GRID_SIZE);
    const p = uvw.sub(0.5).mul(2.35);
    const density = float(0).toVar();

    Loop(sourceCount, ({ i }) => {
      const sourceIndex = uint(i).add(seedUniform);
      const lane = float(i.mod(int(16)));
      const row = float(i.div(int(16)).mod(int(16)));
      const layer = float(i.div(int(256)));
      const base = vec3(
        lane.sub(7.5).mul(0.13),
        row.sub(7.5).mul(0.13),
        layer.sub(0.5).mul(0.45)
      );
      const phase = hash(sourceIndex.add(uint(19))).mul(TAU);
      const speed = hash(sourceIndex.add(uint(47))).remap(0.25, 1.15);
      const orbit = hash(sourceIndex.add(uint(89))).remap(0.02, 0.12);
      const t = timeSeconds.mul(speed).add(phase);
      const center = base.add(
        vec3(
          cos(t).mul(orbit),
          sin(t.mul(1.31)).mul(orbit),
          sin(t.mul(0.77)).mul(orbit.mul(1.4))
        ).mul(motionAmount)
      );
      const radius = hash(sourceIndex.add(uint(131))).remap(0.095, 0.16);
      const d = length(p.sub(center));
      const influence = float(1)
        .sub(d.div(radius))
        .max(0)
        .pow(2.4)
        .mul(0.85);

      density.addAssign(influence);
    });

    const shell = float(1).sub(length(p).sub(1.15).max(0).mul(3)).max(0);
    textureStore(
      densityTexture,
      vec3(x, y, z),
      vec4(density.mul(shell).min(1), 0, 0, 1)
    );
  })()
    .compute(GRID_SIZE * GRID_SIZE * GRID_SIZE)
    .setName("Compute Metaball Density Grid");
}

function makeVolumeMesh(densityTexture) {
  const densityNode = texture3D(densityTexture, null, 0);
  const material = new THREE.NodeMaterial();
  material.transparent = true;
  material.depthWrite = false;
  material.side = THREE.BackSide;
  material.colorNode = Fn(() => {
    const finalColor = vec4(0).toVar();
    RaymarchingBox(steps, ({ positionRay }) => {
      const uvw = positionRay.add(0.5);
      const sample = densityNode.sample(uvw).r;
      const alpha = smoothstep(
        densityThreshold.sub(densityRange),
        densityThreshold.add(densityRange),
        sample
      ).mul(opacity);
      const shade = densityNode
        .sample(uvw.add(vec3(0.018, 0.012, -0.01)))
        .r.sub(densityNode.sample(uvw.sub(vec3(0.018, 0.012, -0.01))).r)
        .mul(1.8)
        .add(0.55)
        .clamp(0, 1);
      const col = mix(vec3(0.32, 0.78, 1.0), vec3(1.0, 0.73, 0.38), shade.mul(0.38));

      finalColor.rgb.addAssign(finalColor.a.oneMinus().mul(alpha).mul(col));
      finalColor.a.addAssign(finalColor.a.oneMinus().mul(alpha));

      If(finalColor.a.greaterThanEqual(0.96), () => {
        Break();
      });
    });

    return finalColor;
  })();

  const mesh = new THREE.Mesh(new THREE.BoxGeometry(2.35, 2.35, 2.35), material);
  mesh.renderOrder = 5;
  return mesh;
}

function makeGrid() {
  const grid = new THREE.GridHelper(5, 20, 0x385468, 0x1b2a32);
  grid.position.y = -1.35;
  return grid;
}

function syncControls() {
  sourceCount.value = Number(sourceCountSelect.value);
  sourceCountValue.textContent = String(sourceCount.value);
}

function animate() {
  const now = performance.now();
  timeSeconds.value = now * 0.001;
  controls.update();
  if (motionEnabled) {
    renderer.compute(computeDensity);
  }
  renderer.render(scene, camera);
}

function resize() {
  const width = window.innerWidth;
  const height = window.innerHeight;

  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
  renderer.setSize(width, height);

  camera.aspect = width / height;
  camera.updateProjectionMatrix();
}
