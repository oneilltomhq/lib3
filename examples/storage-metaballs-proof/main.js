import * as THREE from "three/webgpu";
import {
  Discard,
  Fn,
  If,
  Loop,
  cameraPosition,
  clamp,
  color,
  cos,
  float,
  hash,
  instanceIndex,
  instancedArray,
  length,
  mix,
  normalize,
  positionWorld,
  screenUV,
  sin,
  texture,
  uint,
  uniform,
  vec3,
  vec4,
} from "three/tsl";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { estimateSdfNormal, raymarchSdf } from "../../src/metaballs.js";

const MAX_SOURCES = 64;

const canvas = document.getElementById("canvas");
const status = document.getElementById("status");
const readout = document.getElementById("readout");
const sourceCountSelect = document.getElementById("sourceCount");
const sourceCountValue = document.getElementById("sourceCountValue");
const markersButton = document.getElementById("markers");
const shapeButton = document.getElementById("shape");
const motionButton = document.getElementById("motion");
const resetButton = document.getElementById("reset");

let renderer;
let controls;
let camera;
let backgroundTarget;
let backgroundPlate;
let metaballMesh;
let markerMesh;
let computeUpdate;
let markersVisible = true;
let shapeVisible = true;
let motionEnabled = true;
let seedOffset = 1;
let lastFrame = 0;
let fps = 0;
let fpsSamples = [];
let sweepState = {
  running: false,
  results: [],
};

const sourceCount = uniform(Number(sourceCountSelect.value), "int");
const motionAmount = uniform(1);
const timeSeconds = uniform(0);
const seedUniform = uniform(seedOffset, "uint");
const sources = instancedArray(MAX_SOURCES, "vec4").setName(
  "MovingMetaballSources"
);
const sourceRadius = uniform(0.16);
const smoothing = uniform(0.075);
const hitThreshold = uniform(0.006);

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
  renderer.autoClear = false;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.75));
  renderer.setSize(window.innerWidth, window.innerHeight);
  await renderer.init();

  const scene = new THREE.Scene();
  scene.background = null;

  const backgroundScene = new THREE.Scene();
  backgroundScene.background = new THREE.Color(0x07090d);

  camera = new THREE.PerspectiveCamera(
    42,
    window.innerWidth / window.innerHeight,
    0.1,
    40
  );
  camera.position.set(0, 0.25, 5.2);
  camera.lookAt(0, 0, 0);

  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.enablePan = false;
  controls.minDistance = 3.4;
  controls.maxDistance = 10;

  backgroundTarget = new THREE.RenderTarget(window.innerWidth, window.innerHeight, {
    type: THREE.HalfFloatType,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
  });

  backgroundPlate = makeBackgroundPlate();
  backgroundScene.add(backgroundPlate);

  scene.add(new THREE.AmbientLight(0xffffff, 0.55));
  const key = new THREE.DirectionalLight(0xffffff, 2);
  key.position.set(2, 4, 4);
  scene.add(key);

  computeUpdate = makeUpdateSourcesCompute();
  renderer.compute(computeUpdate);

  metaballMesh = makeMetaballMesh(backgroundTarget.texture);
  scene.add(metaballMesh);

  markerMesh = makeMarkerMesh();
  scene.add(markerMesh);

  sourceCountSelect.addEventListener("input", syncControls);
  markersButton.addEventListener("click", () => {
    markersVisible = !markersVisible;
    markerMesh.visible = markersVisible;
    markersButton.setAttribute("aria-pressed", String(markersVisible));
  });
  shapeButton.addEventListener("click", () => {
    shapeVisible = !shapeVisible;
    metaballMesh.visible = shapeVisible;
    shapeButton.setAttribute("aria-pressed", String(shapeVisible));
  });
  motionButton.addEventListener("click", () => {
    motionEnabled = !motionEnabled;
    motionAmount.value = motionEnabled ? 1 : 0;
    motionButton.setAttribute("aria-pressed", String(motionEnabled));
    renderer.compute(computeUpdate);
  });
  resetButton.addEventListener("click", () => {
    seedOffset += 977;
    seedUniform.value = seedOffset;
    renderer.compute(computeUpdate);
  });

  window.addEventListener("resize", resize);
  renderer.setAnimationLoop((ms) => animate(ms, scene, backgroundScene));
  syncControls();
  resize();

  status.textContent = renderer.backend?.isWebGPUBackend
    ? "WebGPU active. Compute writes storage buffer; fragment SDF reads it."
    : "WebGL fallback active. Need WebGPU browser for storage-buffer proof.";

  window.__storageMetaballsProof = {
    renderer,
    sources,
    setSourceCount(count) {
      sourceCountSelect.value = String(count);
      syncControls();
    },
    getStats() {
      const sorted = [...fpsSamples].sort((a, b) => a - b);
      const median = sorted.length ? sorted[Math.floor(sorted.length * 0.5)] : 0;
      const avg =
        fpsSamples.reduce((total, value) => total + value, 0) /
        Math.max(1, fpsSamples.length);
      return {
        backend: renderer.backend?.isWebGPUBackend ? "WebGPU" : "fallback",
        sourceCount: sourceCount.value,
        motion: motionEnabled,
        fps: Math.round(fps),
        avgFps: Math.round(avg),
        medianFps: Math.round(median),
        samples: fpsSamples.length,
      };
    },
    resetStats() {
      resetStats();
    },
    startSweep(counts = [3, 8, 16, 32, 64], durationMs = 3000) {
      sweepState = {
        running: true,
        results: [],
        counts,
        durationMs,
        startedAt: performance.now(),
      };

      let index = 0;
      const runNext = () => {
        if (index > 0) {
          sweepState.results.push(this.getStats());
        }

        if (index >= counts.length) {
          sweepState.running = false;
          return;
        }

        this.setSourceCount(counts[index]);
        resetStats();
        index += 1;
        window.setTimeout(runNext, durationMs);
      };

      runNext();
    },
    getSweep() {
      return sweepState;
    },
  };
}

function makeUpdateSourcesCompute() {
  return Fn(() => {
    const source = sources.element(instanceIndex);
    const id = instanceIndex.add(seedUniform);

    const lane = float(instanceIndex.mod(uint(3)));
    const row = float(instanceIndex.div(uint(3)).mod(uint(3)));
    const layer = float(instanceIndex.div(uint(9)).mod(uint(8)));
    const base = vec3(
      lane.sub(1).mul(0.72),
      row.sub(1).mul(0.48),
      layer.sub(3.5).mul(0.07).add(hash(id.add(uint(23))).remap(-0.035, 0.035))
    );
    const phase = hash(id.add(uint(97))).mul(6.2831853);
    const orbit = hash(id.add(uint(211))).remap(0.025, 0.08);
    const speed = hash(id.add(uint(419))).remap(0.55, 1.45);
    const t = timeSeconds.mul(speed).add(phase);
    const wobble = vec3(
      cos(t).mul(orbit),
      sin(t.mul(1.21)).mul(orbit.mul(0.8)),
      sin(t.mul(0.73)).mul(orbit.mul(1.1))
    ).mul(motionAmount);
    const radius = hash(id.add(uint(631))).remap(0.13, 0.19);

    source.assign(vec4(base.add(wobble), radius));
  })().compute(MAX_SOURCES).setName("Update Moving Metaball Sources");
}

function makeMetaballMesh(sceneTexture) {
  const material = new THREE.MeshBasicNodeMaterial();
  material.transparent = true;
  material.depthWrite = false;
  material.depthTest = false;

  const backgroundTexture = texture(sceneTexture);
  const sdf = Fn(([p]) => storageMetaballSdf(p));

  material.colorNode = Fn(() => {
    const ro = cameraPosition;
    const rd = normalize(positionWorld.sub(cameraPosition));
    const oc = ro;
    const b = oc.dot(rd);
    const c = oc.dot(oc).sub(8.5);
    const h = b.mul(b).sub(c);

    If(h.lessThan(0), () => {
      Discard();
    });

    const march = raymarchSdf({
      sdf,
      rayOrigin: ro,
      rayDirection: rd,
      tNear: float(0.1),
      tFar: float(12),
      maxSteps: 80,
      threshold: hitThreshold,
    });

    If(march.hit.not(), () => {
      Discard();
    });

    const n = estimateSdfNormal({ sdf, p: march.p, epsilon: 0.018 });
    const light = normalize(vec3(0.45, 0.75, 0.5));
    const diffuse = n.dot(light).max(0).mul(0.55).add(0.2);
    const fresnel = rd.dot(n).abs().oneMinus().pow(2.4);
    const refracted = backgroundTexture.sample(screenUV.add(n.xy.mul(-0.045))).xyz;
    const body = mix(vec3(0.18, 0.65, 0.95), vec3(0.92, 1.0, 0.84), diffuse);
    const rim = mix(vec3(1.0, 0.76, 0.45), vec3(0.52, 0.9, 1.0), diffuse);

    return refracted.mul(0.25).add(body.mul(0.78)).add(rim.mul(fresnel.mul(0.7)));
  })();

  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), material);
  mesh.frustumCulled = false;
  mesh.renderOrder = 5;
  return mesh;
}

function storageMetaballSdf(p) {
  const d = float(20).toVar();

  Loop(sourceCount, ({ i }) => {
    const source = sources.element(i);
    const di = length(p.sub(source.xyz)).sub(sourceRadius);
    const h = clamp(di.sub(d).div(smoothing).mul(0.5).add(0.5), 0, 1);
    d.assign(mix(di, d, h).sub(h.mul(h.oneMinus()).mul(smoothing)));
  });

  return d;
}

function makeMarkerMesh() {
  const material = new THREE.SpriteNodeMaterial({
    transparent: true,
    depthWrite: false,
    depthTest: false,
  });
  const source = sources.toAttribute();
  material.positionNode = source.xyz;
  material.scaleNode = float(0.13);
  material.colorNode = vec4(color("#ff9c5d"), 1);

  const mesh = new THREE.InstancedMesh(
    new THREE.PlaneGeometry(1, 1),
    material,
    MAX_SOURCES
  );
  mesh.frustumCulled = false;
  mesh.renderOrder = 20;
  return mesh;
}

function makeBackgroundPlate() {
  const textureValue = makeGridTexture();
  const material = new THREE.MeshBasicMaterial({ map: textureValue });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), material);
  mesh.frustumCulled = false;
  return mesh;
}

function makeGridTexture() {
  const size = 512;
  const c = document.createElement("canvas");
  c.width = size;
  c.height = size;
  const ctx = c.getContext("2d");

  const g = ctx.createLinearGradient(0, 0, size, size);
  g.addColorStop(0, "#111722");
  g.addColorStop(0.5, "#102018");
  g.addColorStop(1, "#211622");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);

  ctx.strokeStyle = "rgba(255,255,255,0.13)";
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

  const textureValue = new THREE.CanvasTexture(c);
  textureValue.colorSpace = THREE.SRGBColorSpace;
  textureValue.wrapS = THREE.RepeatWrapping;
  textureValue.wrapT = THREE.RepeatWrapping;
  textureValue.repeat.set(2, 1.25);
  return textureValue;
}

function syncControls() {
  const count = Number(sourceCountSelect.value);
  sourceCount.value = count;
  sourceCountValue.textContent = String(count);
  resetStats();

  if (markerMesh) {
    markerMesh.count = count;
  }
}

function resetStats() {
  fpsSamples = [];
  fps = 0;
  lastFrame = 0;
}

function animate(_ms, scene, backgroundScene) {
  const now = performance.now();
  const seconds = now * 0.001;
  timeSeconds.value = seconds;

  controls.update();
  if (motionEnabled) {
    renderer.compute(computeUpdate);
  }
  fitViewportQuad(backgroundPlate, 10);
  fitViewportQuad(metaballMesh, 2.5);

  renderer.setRenderTarget(backgroundTarget);
  renderer.clear();
  renderer.render(backgroundScene, camera);

  renderer.setRenderTarget(null);
  renderer.clear();
  renderer.render(backgroundScene, camera);
  renderer.clearDepth();
  renderer.render(scene, camera);

  if (lastFrame > 0) {
    const instant = 1000 / Math.max(1, now - lastFrame);
    fps = fps === 0 ? instant : THREE.MathUtils.lerp(fps, instant, 0.08);
    fpsSamples.push(instant);
    if (fpsSamples.length > 180) {
      fpsSamples.shift();
    }
  }
  lastFrame = now;

  readout.textContent = `${sourceCount.value} GPU sources | motion ${
    motionEnabled ? "on" : "off"
  } | raymarch ${shapeVisible ? "on" : "off"} | ${Math.round(fps)} fps`;
}

function fitViewportQuad(mesh, distance) {
  const halfH = Math.tan(THREE.MathUtils.degToRad(camera.fov * 0.5)) * distance;
  const halfW = halfH * camera.aspect;
  const forward = new THREE.Vector3();

  camera.updateMatrixWorld();
  camera.getWorldDirection(forward);
  mesh.position.copy(camera.position).addScaledVector(forward, distance);
  mesh.quaternion.copy(camera.quaternion);
  mesh.scale.set(halfW * 2, halfH * 2, 1);
}

function resize() {
  const width = window.innerWidth;
  const height = window.innerHeight;

  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.75));
  renderer.setSize(width, height);
  backgroundTarget.setSize(width, height);

  camera.aspect = width / height;
  camera.updateProjectionMatrix();
}
