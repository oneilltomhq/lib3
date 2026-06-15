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
const FIELD_CAGE_MODE = "field-cages";

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
const fieldCages = createFieldCages(sources);
fieldCages.lines.renderOrder = 30;
scene.add(fieldCages.lines);

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

  metaballs.setSmoothing(smoothing);
  fieldCages.smoothing = smoothing;
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

function createFieldCages(cageSources) {
  const longitudeCount = 12;
  const latitudeCount = 7;
  const anchors = [];
  const colors = [];
  const palette = [
    new THREE.Color(0xff9abc),
    new THREE.Color(0x9cf5ff),
    new THREE.Color(0xffe19a),
  ];

  const pushVertex = (sourceIndex, normal) => {
    anchors.push({ sourceIndex, normal: normal.clone().normalize() });
    colors.push(palette[sourceIndex % palette.length]);
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
  const colorValues = new Float32Array(colors.length * 3);
  colors.forEach((color, index) => {
    color.toArray(colorValues, index * 3);
  });

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    "position",
    new THREE.BufferAttribute(positions, 3).setUsage(THREE.DynamicDrawUsage)
  );
  geometry.setAttribute("color", new THREE.BufferAttribute(colorValues, 3));

  const material = new THREE.LineBasicMaterial({
    vertexColors: true,
    transparent: true,
    opacity: 0.95,
    depthTest: false,
    depthWrite: false,
  });
  const lines = new THREE.LineSegments(geometry, material);
  lines.frustumCulled = false;

  return {
    anchors,
    lines,
    positions,
    smoothing: Number(smoothingSlider.value),
  };
}

function updateFieldCages(cages) {
  const p = new THREE.Vector3();
  const projected = new THREE.Vector3();

  cages.anchors.forEach((anchor, index) => {
    const source = sources[anchor.sourceIndex];
    projected
      .copy(source.position)
      .addScaledVector(anchor.normal, source.radius);

    projectToMetaballSurface(projected, anchor.normal, cages.smoothing);
    p.copy(projected);
    p.toArray(cages.positions, index * 3);
  });

  cages.lines.geometry.attributes.position.needsUpdate = true;
}

function projectToMetaballSurface(point, fallbackNormal, smoothing) {
  const normal = projectToMetaballSurface.normal;

  for (let i = 0; i < 5; i++) {
    const distance = smoothMinDistance(point, smoothing);
    if (Math.abs(distance) < 0.002) break;

    estimateFieldNormal(point, smoothing, normal);
    if (normal.lengthSq() < 0.0001) {
      normal.copy(fallbackNormal);
    }

    point.addScaledVector(normal.normalize(), -distance);
  }
}
projectToMetaballSurface.normal = new THREE.Vector3();

function smoothMinDistance(point, smoothing) {
  return smoothMinDistanceAt(point.x, point.y, point.z, smoothing);
}

function smoothMinDistanceAt(x, y, z, smoothing) {
  let distance = 20;

  for (const source of sources) {
    const dx = x - source.position.x;
    const dy = y - source.position.y;
    const dz = z - source.position.z;
    const next = Math.hypot(dx, dy, dz) - source.radius;
    const h = THREE.MathUtils.clamp((next - distance) / smoothing * 0.5 + 0.5, 0, 1);
    distance = THREE.MathUtils.lerp(next, distance, h) - h * (1 - h) * smoothing;
  }

  return distance;
}

function estimateFieldNormal(point, smoothing, target) {
  const epsilon = 0.025;
  return target.set(
    smoothMinDistanceAt(point.x + epsilon, point.y, point.z, smoothing) -
      smoothMinDistanceAt(point.x - epsilon, point.y, point.z, smoothing),
    smoothMinDistanceAt(point.x, point.y + epsilon, point.z, smoothing) -
      smoothMinDistanceAt(point.x, point.y - epsilon, point.z, smoothing),
    smoothMinDistanceAt(point.x, point.y, point.z + epsilon, smoothing) -
      smoothMinDistanceAt(point.x, point.y, point.z - epsilon, smoothing)
  );
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
  updateFieldCages(fieldCages);
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
