import * as THREE from "three/webgpu";
import { attribute, Fn, int, Loop, normalize } from "three/tsl";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import {
  estimateSdfNormal,
  METABALL_DEBUG_MODES,
  RaymarchedMetaballs,
  smoothMinSphereSdf,
} from "../../src/metaballs.js";

const canvas = document.getElementById("canvas");
const modeButtons = document.getElementById("modeButtons");
const readout = document.getElementById("readout");
const fpsMeter = document.getElementById("fpsMeter");
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
const danceSpeedSlider = document.getElementById("danceSpeedSlider");
const danceSpeedValue = document.getElementById("danceSpeedValue");
const danceViolenceSlider = document.getElementById("danceViolenceSlider");
const danceViolenceValue = document.getElementById("danceViolenceValue");
const dancePulseSlider = document.getElementById("dancePulseSlider");
const dancePulseValue = document.getElementById("dancePulseValue");
const FIELD_CAGE_MODE = "field-cages";
let currentMode = FIELD_CAGE_MODE;

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
const markerMaterial = makeMarkerMaterial();

const sources = Array.from({ length: 18 }, (_, i) => {
  const baseRadius = 0.14 + Math.pow((i % 6) / 5, 1.5) * 0.34;
  return {
    position: new THREE.Vector3(),
    radius: baseRadius,
    baseRadius,
    phase: i * 0.73,
    lane: i % 3,
  };
});

const markers = sources.map((source, i) => {
  const marker = new THREE.Mesh(
    markerGeometry,
    markerMaterial
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
  smoothing: 0.7,
  refractionStrength: 0,
  fresnelBase: 1,
  fresnelStrength: 0,
  rimStrength: 0,
  quadZ: 2.35,
});
scene.add(metaballs.mesh);

const fieldCages = createFieldCages(sources, metaballs);
fieldCages.lines.renderOrder = 30;
scene.add(fieldCages.lines);

const debugModes = [
  [METABALL_DEBUG_MODES.MASK, "shape"],
  [FIELD_CAGE_MODE, "field cages"],
  [METABALL_DEBUG_MODES.REFRACTED, "refraction"],
];

const explanations = {
  [METABALL_DEBUG_MODES.MASK]:
    "Shape: the raymarched SDF is visible as a solid mask over the same background texture that the shader can sample.",
  [FIELD_CAGE_MODE]:
    "Field cages: source sphere wire vertices are projected through the combined smooth-min SDF, then drawn over the refracted surface.",
  [METABALL_DEBUG_MODES.REFRACTED]:
    "Refraction: the same SDF surface estimates a normal and uses it to offset the background texture lookup.",
};

const stackLabels = {
  [METABALL_DEBUG_MODES.MASK]: "SDF sources -> raymarched shape",
  [FIELD_CAGE_MODE]: "background -> refracted surface -> projected cage lines",
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
  metaballs.setDebugMode(
    mode === FIELD_CAGE_MODE ? METABALL_DEBUG_MODES.REFRACTED : mode
  );
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
  const danceSpeed = Number(danceSpeedSlider.value);
  const danceViolence = Number(danceViolenceSlider.value);
  const dancePulse = Number(dancePulseSlider.value);

  metaballs.setSmoothing(smoothing);
  fieldCages.smoothing = smoothing;
  metaballs.refractionStrength.value = refraction;
  metaballs.maxSteps.value = steps;
  floorMaterial.map = backgroundTextures[backgroundPattern.value];
  floorMaterial.needsUpdate = true;

  smoothingValue.textContent = smoothing.toFixed(2);
  refractionValue.textContent = refraction.toFixed(2);
  stepsValue.textContent = String(steps);
  danceSpeedValue.textContent = danceSpeed.toFixed(2);
  danceViolenceValue.textContent = danceViolence.toFixed(2);
  dancePulseValue.textContent = dancePulse.toFixed(2);
}

[
  smoothingSlider,
  refractionSlider,
  stepsSlider,
  danceSpeedSlider,
  danceViolenceSlider,
  dancePulseSlider,
].forEach((input) => {
  input.addEventListener("input", syncControls);
});

[sourcesToggle, backgroundPattern].forEach((input) => {
  input.addEventListener("input", syncControls);
});

setDebugMode(FIELD_CAGE_MODE);
syncControls();

function updateSources(time) {
  const danceSpeed = Number(danceSpeedSlider.value);
  const danceViolence = Number(danceViolenceSlider.value);
  const dancePulse = Number(dancePulseSlider.value);
  const frameTime = updateSources.frameTime ?? time;
  const deltaTime = Math.min(0.05, Math.max(0, time - frameTime));
  updateSources.frameTime = time;
  updateSources.motionTime = (updateSources.motionTime ?? time) + deltaTime * danceSpeed;
  const motionTime = updateSources.motionTime;

  for (let i = 0; i < sources.length; i++) {
    const source = sources[i];
    const lane = source.lane - 1;
    const t = motionTime * (1.25 + source.lane * 0.28) + source.phase;
    const boil = motionTime * (3.2 + (i % 5) * 0.17) + source.phase * 1.7;
    const snap = Math.sin(boil * 1.9 + i) * Math.cos(boil * 0.73);
    const swirl = 0.4 + danceViolence * 0.85;
    const churn = danceViolence * 0.45;

    source.position.set(
      Math.sin(t * 1.17) * swirl +
        Math.sin(boil * 2.1 + lane) * churn +
        lane * 0.22 +
        snap * danceViolence * 0.2,
      Math.sin(t * 1.73 + lane) * (0.32 + danceViolence * 0.5) +
        Math.cos(boil * 2.6 + i * 0.31) * churn,
      Math.cos(t * 1.31 + i * 0.11) * (0.25 + danceViolence * 0.37) +
        Math.sin(boil * 1.43 + lane * 1.9) * danceViolence * 0.38
    );
    source.radius = source.baseRadius *
      (0.86 + Math.sin(boil * 2.4 + i) * dancePulse * 0.14);

    markers[i].position.copy(source.position);
    markers[i].scale.setScalar(source.radius);
    markers[i].rotation.set(t * 1.7, boil * 1.2, t * 1.1 + snap);
  }
}

function createFieldCages(cageSources, metaballField) {
  const longitudeCount = 12;
  const latitudeCount = 7;
  const anchors = [];

  const pushVertex = (sourceIndex, normal) => {
    anchors.push({ sourceIndex, normal: normal.clone().normalize() });
  };

  const pushSegment = (sourceIndex, a, b) => {
    pushVertex(sourceIndex, a);
    pushVertex(sourceIndex, b);
  };

  for (let sourceIndex = 0; sourceIndex < cageSources.length; sourceIndex++) {
    for (let lat = 1; lat < latitudeCount; lat++) {
      const theta = (lat / latitudeCount) * Math.PI;
      const y = Math.cos(theta);
      const ringRadius = Math.sin(theta);

      for (let lon = 0; lon < longitudeCount; lon++) {
        const a = (lon / longitudeCount) * Math.PI * 2;
        const b = ((lon + 1) / longitudeCount) * Math.PI * 2;
        pushSegment(
          sourceIndex,
          new THREE.Vector3(Math.cos(a) * ringRadius, y, Math.sin(a) * ringRadius),
          new THREE.Vector3(Math.cos(b) * ringRadius, y, Math.sin(b) * ringRadius)
        );
      }
    }

    for (let lon = 0; lon < longitudeCount; lon++) {
      const phi = (lon / longitudeCount) * Math.PI * 2;

      for (let lat = 0; lat < latitudeCount; lat++) {
        const a = (lat / latitudeCount) * Math.PI;
        const b = ((lat + 1) / latitudeCount) * Math.PI;
        pushSegment(
          sourceIndex,
          new THREE.Vector3(Math.cos(phi) * Math.sin(a), Math.cos(a), Math.sin(phi) * Math.sin(a)),
          new THREE.Vector3(Math.cos(phi) * Math.sin(b), Math.cos(b), Math.sin(phi) * Math.sin(b))
        );
      }
    }
  }

  const positions = new Float32Array(anchors.length * 3);
  const normals = new Float32Array(anchors.length * 3);
  const sourceIndices = new Float32Array(anchors.length);
  anchors.forEach((anchor, index) => {
    anchor.normal.toArray(positions, index * 3);
    anchor.normal.toArray(normals, index * 3);
    sourceIndices[index] = anchor.sourceIndex;
  });

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute("anchorNormal", new THREE.BufferAttribute(normals, 3));
  geometry.setAttribute("sourceIndex", new THREE.BufferAttribute(sourceIndices, 1));

  const material = makeFieldCageMaterial(metaballField);
  const lines = new THREE.LineSegments(geometry, material);
  lines.frustumCulled = false;

  return {
    anchors,
    lines,
    smoothing: Number(smoothingSlider.value),
  };
}

function makeFieldCageMaterial(metaballField) {
  const material = new THREE.LineBasicNodeMaterial({
    color: 0xffffff,
    transparent: true,
    opacity: 0.95,
    depthTest: false,
    depthWrite: false,
  });

  const sdf = Fn(([p]) =>
    smoothMinSphereSdf({
      p,
      positions: metaballField.positions,
      radii: metaballField.radii,
      count: metaballField.count,
      smoothing: metaballField.smoothingUniform,
    })
  );

  material.positionNode = Fn(() => {
    const sourceIndex = int(attribute("sourceIndex", "float"));
    const anchorNormal = normalize(attribute("anchorNormal", "vec3"));
    const point = metaballField.positions
      .element(sourceIndex)
      .add(anchorNormal.mul(metaballField.radii.element(sourceIndex)))
      .toVar();

    Loop(5, () => {
      const distance = sdf(point);
      const normal = estimateSdfNormal({
        sdf,
        p: point,
        epsilon: 0.025,
      });
      point.addAssign(normalize(normal).mul(distance.negate()));
    });

    return point;
  })();

  return material;
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

function makeMarkerMaterial() {
  return new THREE.MeshBasicMaterial({
    color: 0xffffff,
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

let lastFrameMilliseconds = 0;
let smoothedFps = 0;

renderer.setAnimationLoop((milliseconds) => {
  const time = milliseconds / 1000;
  if (lastFrameMilliseconds > 0) {
    const instantFps = 1000 / Math.max(1, milliseconds - lastFrameMilliseconds);
    smoothedFps = smoothedFps === 0
      ? instantFps
      : THREE.MathUtils.lerp(smoothedFps, instantFps, 0.08);
    fpsMeter.textContent = `${Math.round(smoothedFps)} fps`;
  }
  lastFrameMilliseconds = milliseconds;

  controls.update();
  updateSources(time);
  markers.forEach((marker) => {
    marker.visible = sourcesToggle.checked;
  });
  fieldCages.lines.visible = currentMode === FIELD_CAGE_MODE;
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
