import * as THREE from "three/webgpu";
import {
  Discard,
  Fn,
  If,
  Loop,
  PI,
  cameraPosition,
  clamp,
  color,
  float,
  hash,
  instanceIndex,
  instancedArray,
  length,
  mix,
  mod,
  normalize,
  positionWorld,
  screenUV,
  sin,
  cos,
  texture,
  uint,
  uniform,
  uniformArray,
  uv,
  vec3,
  vec4,
} from "three/tsl";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import {
  estimateSdfNormal,
  raymarchSdf,
} from "../../src/metaballs.js";

const MAX_SOURCES = 64;
const ATTRACTOR_COUNT = 3;

const canvas = document.getElementById("canvas");
const status = document.getElementById("status");
const readout = document.getElementById("readout");
const sourceCountSelect = document.getElementById("sourceCount");
const sourceCountValue = document.getElementById("sourceCountValue");
const massSlider = document.getElementById("mass");
const massValue = document.getElementById("massValue");
const spinSlider = document.getElementById("spin");
const spinValue = document.getElementById("spinValue");
const dampingSlider = document.getElementById("damping");
const dampingValue = document.getElementById("dampingValue");
const speedSlider = document.getElementById("speed");
const speedValue = document.getElementById("speedValue");
const smoothingSlider = document.getElementById("smoothing");
const smoothingValue = document.getElementById("smoothingValue");
const markersButton = document.getElementById("markers");
const resetButton = document.getElementById("reset");

let renderer;
let controls;
let computeUpdate;
let computeInit;
let markerMesh;
let metaballMesh;
let backgroundPlate;
let backgroundTarget;
let markersVisible = false;
let lastFrame = 0;
let fps = 0;

const sourceCount = uniform(Number(sourceCountSelect.value), "int");
const attractorMass = uniform(Number(`1e${massSlider.value}`));
const particleGlobalMass = uniform(1e4);
const spinningStrength = uniform(Number(spinSlider.value));
const velocityDamping = uniform(Number(dampingSlider.value));
const maxSpeed = uniform(Number(speedSlider.value));
const smoothing = uniform(Number(smoothingSlider.value));
const timeScale = uniform(1);
const boundHalfExtent = uniform(5.5);
const sourceScale = uniform(1);
const tNear = uniform(0.5);
const tFar = uniform(20);
const hitThreshold = uniform(0.008);
const maxSteps = uniform(56, "int");
const gravityConstant = 6.67e-11;

const attractorPositions = uniformArray([
  new THREE.Vector3(-1, 0, 0),
  new THREE.Vector3(1, 0, -0.5),
  new THREE.Vector3(0, 0.5, 1),
]);
const attractorRotationAxes = uniformArray([
  new THREE.Vector3(0, 1, 0),
  new THREE.Vector3(0, 1, 0),
  new THREE.Vector3(1, 0, -0.5).normalize(),
]);
const attractorLength = uniform(ATTRACTOR_COUNT, "uint");

const sourceBuffer = instancedArray(MAX_SOURCES, "vec4");
const velocityBuffer = instancedArray(MAX_SOURCES, "vec3");
const radiusBuffer = instancedArray(MAX_SOURCES, "vec4");

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
  const backendLabel = renderer.backend?.isWebGPUBackend
    ? "WebGPU"
    : "WebGL fallback";

  const scene = new THREE.Scene();
  scene.background = null;

  const backgroundScene = new THREE.Scene();
  backgroundScene.background = new THREE.Color(0x07090d);

  const camera = new THREE.PerspectiveCamera(
    32,
    window.innerWidth / window.innerHeight,
    0.1,
    100
  );
  camera.position.set(9, 6.2, 16);
  camera.lookAt(0, 0, 0);

  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.enablePan = false;
  controls.minDistance = 10;
  controls.maxDistance = 30;

  backgroundTarget = new THREE.RenderTarget(window.innerWidth, window.innerHeight, {
    type: THREE.HalfFloatType,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
  });

  backgroundPlate = makeBackgroundPlate();
  backgroundScene.add(backgroundPlate);
  backgroundScene.add(new THREE.AmbientLight(0xffffff, 0.6));

  scene.add(new THREE.AmbientLight(0xffffff, 0.8));
  const key = new THREE.DirectionalLight(0xffffff, 1.8);
  key.position.set(2, 5, 4);
  scene.add(key);
  scene.add(makeAttractorHelpers());

  computeInit = makeInitCompute();
  computeUpdate = makeUpdateCompute();
  renderer.compute(computeInit);

  markerMesh = makeMarkerMesh();
  markerMesh.visible = markersVisible;
  scene.add(markerMesh);

  metaballMesh = makeMetaballMesh(backgroundTarget.texture);
  scene.add(metaballMesh);

  syncControls();
  window.addEventListener("resize", () => resize(camera));
  for (const input of [
    sourceCountSelect,
    massSlider,
    spinSlider,
    dampingSlider,
    speedSlider,
    smoothingSlider,
  ]) {
    input.addEventListener("input", syncControls);
  }
  resetButton.addEventListener("click", () => {
    renderer.compute(computeInit);
  });
  markersButton.addEventListener("click", () => {
    markersVisible = !markersVisible;
    markersButton.setAttribute("aria-pressed", String(markersVisible));
    markerMesh.visible = markersVisible;
  });

  renderer.setAnimationLoop((ms) => animate(ms, scene, backgroundScene, camera));
  resize(camera);
  status.textContent = renderer.backend?.isWebGPUBackend
    ? "WebGPU storage-buffer SDF path active. No CPU readback."
    : "WebGL fallback active. Use WebGPU browser for proof.";
  window.__gpuAttractorMetaballs = { renderer, backendLabel };
}

function makeInitCompute() {
  const seedA = uint(Math.floor(Math.random() * 0xffffff));
  const seedB = uint(Math.floor(Math.random() * 0xffffff));
  const seedC = uint(Math.floor(Math.random() * 0xffffff));
  const seedD = uint(Math.floor(Math.random() * 0xffffff));

  const sphericalToVec3 = Fn(([phi, theta]) => {
    const sinPhiRadius = sin(phi);
    return vec3(
      sinPhiRadius.mul(sin(theta)),
      cos(phi),
      sinPhiRadius.mul(cos(theta))
    );
  });

  const init = Fn(() => {
    const source = sourceBuffer.element(instanceIndex);
    const velocity = velocityBuffer.element(instanceIndex);
    const radiusPacked = radiusBuffer.element(instanceIndex);

    const basePosition = vec3(
      hash(instanceIndex.add(seedA)),
      hash(instanceIndex.add(seedB)),
      hash(instanceIndex.add(seedC))
    ).sub(0.5).mul(vec3(4.8, 1.6, 4.8));
    const radius = hash(instanceIndex.add(seedC)).remap(0.16, 0.32);
    source.assign(vec4(basePosition.x, basePosition.y, basePosition.z, 1));
    radiusPacked.assign(vec4(radius, radius, radius, radius));

    const phi = hash(instanceIndex.add(seedB)).mul(PI).mul(2);
    const theta = hash(instanceIndex.add(seedD)).mul(PI);
    velocity.assign(sphericalToVec3(phi, theta).mul(0.08));

  });

  return init().compute(MAX_SOURCES).setName("Init Attractor Metaballs");
}

function makeUpdateCompute() {
  const particleMassMultiplier = hash(instanceIndex.add(uint(0x6d2b79))).remap(0.25, 1).toVar();
  const particleMass = particleMassMultiplier.mul(particleGlobalMass).toVar();

  const update = Fn(() => {
    const delta = float(1 / 60).mul(timeScale).toVar();
    const source = sourceBuffer.element(instanceIndex);
    const position = source.xyz.toVar();
    const velocity = velocityBuffer.element(instanceIndex);
    const force = vec3(0).toVar();

    Loop(attractorLength, ({ i }) => {
      const attractorPosition = attractorPositions.element(i);
      const attractorRotationAxis = attractorRotationAxes.element(i);
      const toAttractor = attractorPosition.sub(position);
      const distance = toAttractor.length().max(0.08);
      const direction = toAttractor.normalize();

      const gravityStrength = attractorMass
        .mul(particleMass)
        .mul(gravityConstant)
        .div(distance.pow(2))
        .toVar();
      force.addAssign(direction.mul(gravityStrength));

      const spinningForce = attractorRotationAxis
        .mul(gravityStrength)
        .mul(spinningStrength);
      force.addAssign(spinningForce.cross(toAttractor));
    });

    velocity.addAssign(force.mul(delta));
    const speed = velocity.length();
    If(speed.greaterThan(maxSpeed), () => {
      velocity.assign(velocity.normalize().mul(maxSpeed));
    });
    velocity.mulAssign(velocityDamping.oneMinus());
    position.addAssign(velocity.mul(delta));

    const halfHalfExtent = boundHalfExtent.div(2).toVar();
    position.assign(mod(position.add(halfHalfExtent), boundHalfExtent).sub(halfHalfExtent));
    source.assign(vec4(position.x, position.y, position.z, source.w));
  });

  return update().compute(MAX_SOURCES).setName("Update Attractor Metaballs");
}

function makeMetaballMesh(sceneTexture) {
  const material = new THREE.MeshBasicNodeMaterial();
  material.transparent = true;
  material.depthWrite = false;
  material.depthTest = false;

  const backgroundTexture = texture(sceneTexture);
  const sdf = Fn(([p]) => gpuSmoothMinSphereSdf(p));
  const marchScene = () => {
    const ro = cameraPosition;
    const rd = normalize(positionWorld.sub(cameraPosition));
    return raymarchSdf({
      sdf,
      rayOrigin: ro,
      rayDirection: rd,
      tNear,
      tFar,
      maxSteps,
      threshold: hitThreshold,
    });
  };

  material.colorNode = Fn(() => {
    const ro = cameraPosition;
    const rd = normalize(positionWorld.sub(cameraPosition));
    const march = marchScene();

    If(march.hit.not(), () => {
      Discard();
    });

    const n = estimateSdfNormal({
      sdf,
      p: march.p,
      epsilon: 0.025,
    });
    const fresnel = rd.dot(n).abs().oneMinus().pow(2);
    const light = normalize(vec3(0.35, 0.78, 0.52));
    const diffuse = n.dot(light).max(0).mul(0.55).add(0.18);
    const rim = fresnel.mul(0.85);
    const refracted = backgroundTexture
      .sample(screenUV.add(n.xy.mul(-0.055)))
      .xyz;
    const body = mix(vec3(0.15, 0.6, 0.95), vec3(0.7, 1.0, 0.92), diffuse);
    const rimTint = mix(vec3(0.95, 0.76, 0.48), vec3(0.55, 0.85, 1.0), diffuse);
    return refracted.mul(0.32).add(body.mul(0.72)).add(rimTint.mul(rim));
  })();
  material.opacityNode = Fn(() => marchScene().hit.select(float(1), float(0)))();

  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), material);
  mesh.frustumCulled = false;
  mesh.renderOrder = 5;
  return mesh;
}

function gpuSmoothMinSphereSdf(p) {
  const d = float(20).toVar();

  Loop(sourceCount, ({ i }) => {
    const source = sourceBuffer.element(i);
    const radius = radiusBuffer.element(i).x.mul(sourceScale);
    const di = length(p.sub(source.xyz)).sub(radius);
    const h = clamp(di.sub(d).div(smoothing).mul(0.5).add(0.5), 0, 1);
    d.assign(mix(di, d, h).sub(h.mul(h.oneMinus()).mul(smoothing)));
  });

  return d;
}

function makeMarkerMesh() {
  const markerTexture = makeMarkerTexture();
  const material = new THREE.SpriteNodeMaterial({
    transparent: true,
    depthWrite: false,
    depthTest: false,
    blending: THREE.AdditiveBlending,
  });

  const sourceAttribute = sourceBuffer.toAttribute();
  const radiusAttribute = radiusBuffer.toAttribute();
  material.positionNode = sourceAttribute.xyz;
  material.scaleNode = radiusAttribute.x.mul(0.2);
  material.colorNode = Fn(() => {
    const velocity = velocityBuffer.toAttribute();
    const speedMix = velocity.length().div(maxSpeed).smoothstep(0, 0.7);
    const mask = texture(markerTexture).sample(uv()).a;
    return vec4(mix(color("#7cc8ff"), color("#ff9c5d"), speedMix), mask.mul(0.72));
  })();

  const mesh = new THREE.InstancedMesh(
    new THREE.PlaneGeometry(1, 1),
    material,
    MAX_SOURCES
  );
  mesh.count = Number(sourceCountSelect.value);
  mesh.frustumCulled = false;
  mesh.renderOrder = 10;
  return mesh;
}

function makeMarkerTexture() {
  const size = 64;
  const c = document.createElement("canvas");
  c.width = size;
  c.height = size;
  const ctx = c.getContext("2d");
  const g = ctx.createRadialGradient(32, 32, 2, 32, 32, 30);
  g.addColorStop(0, "rgba(255,255,255,1)");
  g.addColorStop(0.48, "rgba(255,255,255,0.72)");
  g.addColorStop(0.72, "rgba(255,255,255,0.16)");
  g.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(32, 32, 31, 0, Math.PI * 2);
  ctx.fill();

  const textureValue = new THREE.CanvasTexture(c);
  textureValue.colorSpace = THREE.SRGBColorSpace;
  return textureValue;
}

function makeAttractorHelpers() {
  const group = new THREE.Group();
  const ringGeometry = new THREE.RingGeometry(0.36, 0.38, 40, 1, 0, Math.PI * 1.5);
  const arrowGeometry = new THREE.ConeGeometry(0.06, 0.22, 12);
  const material = new THREE.MeshBasicMaterial({
    color: 0xffffff,
    transparent: true,
    opacity: 0.55,
    side: THREE.DoubleSide,
  });

  for (let i = 0; i < ATTRACTOR_COUNT; i++) {
    const reference = new THREE.Object3D();
    reference.position.copy(attractorPositions.array[i]);
    reference.quaternion.setFromUnitVectors(
      new THREE.Vector3(0, 1, 0),
      attractorRotationAxes.array[i]
    );

    const ring = new THREE.Mesh(ringGeometry, material);
    ring.rotation.x = -Math.PI * 0.5;
    reference.add(ring);

    const arrow = new THREE.Mesh(arrowGeometry, material);
    arrow.position.x = 0.38;
    arrow.position.z = 0.08;
    arrow.rotation.x = Math.PI * 0.5;
    reference.add(arrow);

    group.add(reference);
  }

  return group;
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
  g.addColorStop(0, "#101923");
  g.addColorStop(0.5, "#12201b");
  g.addColorStop(1, "#241722");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);

  ctx.strokeStyle = "rgba(255,255,255,0.12)";
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
  attractorMass.value = Number(`1e${massSlider.value}`);
  spinningStrength.value = Number(spinSlider.value);
  velocityDamping.value = Number(dampingSlider.value);
  maxSpeed.value = Number(speedSlider.value);
  smoothing.value = Number(smoothingSlider.value);

  if (markerMesh) {
    markerMesh.count = count;
  }

  sourceCountValue.textContent = String(count);
  massValue.textContent = `1e${massSlider.value}`;
  spinValue.textContent = spinningStrength.value.toFixed(2);
  dampingValue.textContent = velocityDamping.value.toFixed(3);
  speedValue.textContent = maxSpeed.value.toFixed(1);
  smoothingValue.textContent = smoothing.value.toFixed(2);
}

function animate(ms, scene, backgroundScene, camera) {
  controls.update();
  renderer.compute(computeUpdate);
  fitViewportQuad(camera, metaballMesh, 2.5);
  fitViewportQuad(camera, backgroundPlate, 12);

  renderer.setRenderTarget(backgroundTarget);
  renderer.clear();
  renderer.render(backgroundScene, camera);

  renderer.setRenderTarget(null);
  renderer.clear();
  renderer.render(backgroundScene, camera);
  renderer.clearDepth();
  renderer.render(scene, camera);

  if (lastFrame > 0) {
    const instant = 1000 / Math.max(1, ms - lastFrame);
    fps = fps === 0 ? instant : THREE.MathUtils.lerp(fps, instant, 0.08);
  }
  lastFrame = ms;
  readout.textContent = `${sourceCount.value} GPU sources | markers ${markersVisible ? "on" : "off"} | ${Math.round(fps)} fps`;
}

function fitViewportQuad(camera, mesh, distance) {
  const halfH = Math.tan(THREE.MathUtils.degToRad(camera.fov * 0.5)) * distance;
  const halfW = halfH * camera.aspect;
  const forward = new THREE.Vector3();

  camera.updateMatrixWorld();
  camera.getWorldDirection(forward);
  mesh.position.copy(camera.position).addScaledVector(forward, distance);
  mesh.quaternion.copy(camera.quaternion);
  mesh.scale.set(halfW * 2, halfH * 2, 1);
}

function resize(camera) {
  const width = window.innerWidth;
  const height = window.innerHeight;

  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.75));
  renderer.setSize(width, height);
  backgroundTarget.setSize(width, height);

  camera.aspect = width / height;
  camera.updateProjectionMatrix();
}
