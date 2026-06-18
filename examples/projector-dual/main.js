import { setup } from "../_shared/setup.js";
import atlasURL from "@videos/atlas-demo-3x.mp4";
import buildxURL from "@videos/buildx-demo-5x.mp4";
import diffuseURL from "@textures/plastered_stone_wall_diff_4k.jpg?url";
import normalURL from "@textures/plastered_stone_wall_nor_gl_4k.exr?url";
import roughnessURL from "@textures/plastered_stone_wall_rough_4k.exr?url";
import { TransformControls } from "three/addons/controls/TransformControls.js";
import { Inspector } from "three/addons/inspector/Inspector.js";
import { EXRLoader } from "three/addons/loaders/EXRLoader.js";
import { gaussianBlur } from "three/addons/tsl/display/GaussianBlurNode.js";
import { bayer16 } from "three/addons/tsl/math/Bayer.js";
import {
  abs,
  float,
  Fn,
  instanceIndex,
  mx_noise_vec3,
  pass,
  screenCoordinate,
  screenUV,
  sin,
  smoothstep,
  texture3D,
  textureStore,
  time,
  uniform,
  vec3,
  vec4,
} from "three/tsl";

// Phase 1: No passes/compute/morphs

// --- Renderer / Scene / Camera ---
const { THREE, renderer, scene, camera, controls } = setup({ fov: 50 });
camera.position.set(6, 3, 10);
controls.target.set(0, 2, 0);
controls.update();

renderer.toneMapping = THREE.NeutralToneMapping;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.inspector = new Inspector();
scene.background = new THREE.Color(0x0);

// --- Ground + Wall ---
const floorMat = new THREE.MeshStandardNodeMaterial({ color: 0x111111 });
const floor = new THREE.Mesh(new THREE.PlaneGeometry(40, 40), floorMat);
floor.rotation.x = -Math.PI / 2;
floor.position.y = 0;
floor.receiveShadow = true;
scene.add(floor);

// Wall at z=0 for projector visualization
const wallMat = new THREE.MeshStandardMaterial({
  color: 0x808080,
  roughness: 1.0,
  metalness: 0.0,
});
const wall = new THREE.Mesh(new THREE.BoxGeometry(30, 15, 0.5), wallMat);
wall.position.set(0, 7.5, 0); // Position at z=0
wall.receiveShadow = true;
wall.castShadow = true;
// Use double-sided shadowing to reduce leaks on thin geometry
wall.material.shadowSide = THREE.DoubleSide;
scene.add(wall);

// Apply plastered stone wall textures
(() => {
  const textureLoader = new THREE.TextureLoader();
  const exrLoader = new EXRLoader();

  // Helper to configure tiling consistently
  function setupTiling(t) {
    t.wrapS = THREE.RepeatWrapping;
    t.wrapT = THREE.RepeatWrapping;
    t.anisotropy = 8;
    t.repeat.set(4, 2);
  }

  // Albedo (sRGB)
  textureLoader.load(diffuseURL, (map) => {
    map.colorSpace = THREE.SRGBColorSpace;
    setupTiling(map);
    wall.material.map = map;
    wall.material.needsUpdate = true;
  });

  // Normal (linear EXR)
  exrLoader.load(normalURL, (normalMap) => {
    setupTiling(normalMap);
    wall.material.normalMap = normalMap;
    wall.material.normalScale = new THREE.Vector2(1, 1);
    wall.material.needsUpdate = true;
  });

  // Roughness (linear EXR)
  exrLoader.load(roughnessURL, (roughnessMap) => {
    setupTiling(roughnessMap);
    wall.material.roughnessMap = roughnessMap;
    wall.material.roughness = 1.0;
    wall.material.needsUpdate = true;
  });
})();

// Helpers for spatial orientation
const grid = new THREE.GridHelper(40, 40, 0x666666, 0x333333);
grid.position.y = 0.001; // avoid z-fighting with floor
scene.add(grid);

const axes = new THREE.AxesHelper(2);
axes.position.y = 0.01;
scene.add(axes);

// --- Ambient + Fill light ---
scene.add(new THREE.AmbientLight(0xffffff, 0.4));
const key = new THREE.DirectionalLight(0xffffff, 0.5);
key.position.set(3, 6, 2);
key.castShadow = true;
scene.add(key);

// --- Projector Lights ---
const LAYER_VOLUMETRIC = 10;
function createProjector(name, colorHex, pos) {
  const root = new THREE.Group();
  root.name = name;

  const projector = new THREE.ProjectorLight(colorHex, 60);
  // Position the root so TransformControls attach at the correct place
  root.position.set(...pos);
  projector.angle = Math.PI / 8;
  projector.penumbra = 1;
  projector.decay = 0.5;
  projector.distance = 10; // infinite
  projector.castShadow = true;
  projector.shadow.mapSize.set(1024, 1024);
  projector.shadow.camera.near = 0.5;
  projector.shadow.camera.far = 30;
  projector.shadow.bias = -0.0015;
  projector.layers.enable(LAYER_VOLUMETRIC);

  // Helper mesh (cone) for picking + visualizing direction
  const cone = new THREE.Mesh(
    new THREE.ConeGeometry(0.2, 0.5, 20),
    new THREE.MeshStandardMaterial({
      color: colorHex,
      emissive: colorHex,
      emissiveIntensity: 1,
    })
  );
  cone.rotation.x = Math.PI / 2; // -Z forward
  cone.position.z = 0.15;
  cone.castShadow = false;
  cone.receiveShadow = false;
  cone.name = `${name}-gizmo`;

  root.add(projector);
  projector.add(cone);

  scene.add(root);
  return { root, projector, cone };
}

const projA = createProjector("Projector A", 0xffffff, [-6, 5, 6]);
const projB = createProjector("Projector B", 0xffffff, [6, 5, 6]);

// Function to calculate closest point on wall surface
function getClosestWallPoint(position) {
  // Wall dimensions and position
  const wallCenter = new THREE.Vector3(0, 7.5, 0);
  const wallWidth = 30;
  const wallHeight = 15;

  // Calculate closest point on wall rectangle (front face at z=0)
  const closest = new THREE.Vector3(
    Math.max(
      wallCenter.x - wallWidth / 2,
      Math.min(position.x, wallCenter.x + wallWidth / 2)
    ),
    Math.max(
      wallCenter.y - wallHeight / 2,
      Math.min(position.y, wallCenter.y + wallHeight / 2)
    ),
    wallCenter.z // Always on the wall surface (z=0)
  );

  return closest;
}

// Setup targets for projectors
function updateProjectorTargets() {
  const projAPos = projA.projector.getWorldPosition(new THREE.Vector3());
  const projBPos = projB.projector.getWorldPosition(new THREE.Vector3());

  projA.projector.target.position.copy(getClosestWallPoint(projAPos));
  projB.projector.target.position.copy(getClosestWallPoint(projBPos));
}

// Initialize targets and add them to scene
updateProjectorTargets();
scene.add(projA.projector.target);
scene.add(projB.projector.target);

// --- Simple dynamic content sources (Phase 1) ---
function makeCanvasTexture(draw) {
  const c = document.createElement("canvas");
  c.width = 512;
  c.height = 512;
  const ctx = c.getContext("2d");
  const tex = new THREE.CanvasTexture(c);
  tex.needsUpdate = true;
  return { ctx, canvas: c, texture: tex, draw };
}

const canvasA = makeCanvasTexture((ctx, t) => {
  const w = ctx.canvas.width,
    h = ctx.canvas.height;
  ctx.clearRect(0, 0, w, h);
  const g = ctx.createLinearGradient(0, 0, w, h);
  g.addColorStop(0, `hsl(${(t * 40) % 360}, 80%, 55%)`);
  g.addColorStop(1, `hsl(${(t * 40 + 180) % 360}, 80%, 45%)`);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
  // moving stripes
  ctx.globalCompositeOperation = "overlay";
  ctx.fillStyle = "rgba(255,255,255,0.25)";
  const k = (t * 2) % 1;
  for (let i = -1; i < 16; i++) {
    const x = ((i + k) / 16) * w;
    ctx.fillRect(x, 0, 8, h);
  }
  ctx.globalCompositeOperation = "source-over";
});

const canvasB = makeCanvasTexture((ctx, t) => {
  const w = ctx.canvas.width,
    h = ctx.canvas.height;
  ctx.clearRect(0, 0, w, h);
  // radial pulsating ring
  const cx = w / 2,
    cy = h / 2;
  const radius = Math.abs(Math.sin(t * 1.2)) * 0.4 + 0.2;
  const grd = ctx.createRadialGradient(cx, cy, 0, cx, cy, Math.min(w, h) * 0.5);
  grd.addColorStop(0, "rgba(30,200,255,1)");
  grd.addColorStop(radius, "rgba(30,200,255,0.3)");
  grd.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = grd;
  ctx.fillRect(0, 0, w, h);
});

// --- HTMLVideoElement-backed textures ---
function makeVideoTexture(url) {
  const video = document.createElement("video");
  video.src = url;
  video.preload = "auto";
  video.crossOrigin = "anonymous";
  video.loop = true;
  video.muted = true; // allow autoplay
  video.playsInline = true;
  video.autoplay = true;

  const tex = new THREE.VideoTexture(video);
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  tex.colorSpace = THREE.SRGBColorSpace;
  return { video, texture: tex };
}

const videoAtlas = makeVideoTexture(atlasURL);
const videoBuildx = makeVideoTexture(buildxURL);

function ensureVideoPlayback() {
  const tryPlay = (v) => v.play && v.play().catch(() => {});
  tryPlay(videoAtlas.video);
  tryPlay(videoBuildx.video);
}

function setProjectorContent(projector, type) {
  projector.colorNode = null;
  if (type === "canvasA") {
    projector.map = canvasA.texture;
  } else if (type === "canvasB") {
    projector.map = canvasB.texture;
  } else if (type === "videoAtlas") {
    projector.map = videoAtlas.texture;
  } else if (type === "videoBuildx") {
    projector.map = videoBuildx.texture;
  } else if (type === "procedural") {
    // simple animated stripes via TSL using projectorUV length
    projector.colorNode = Fn(([projectorUV]) => {
      const u = projectorUV.x.mul(20.0);
      const band = abs(sin(u));
      const c = vec3(band, band.mul(0.5), band.mul(0.1));
      return c;
    });
    projector.map = null;
  } else {
    projector.map = null;
  }
}

setProjectorContent(projA.projector, "videoAtlas");
setProjectorContent(projB.projector, "videoBuildx");

// --- TransformControls + selection ---
const tControls = new TransformControls(camera, renderer.domElement);
scene.add(tControls.getHelper());
tControls.setSpace("local");
tControls.setSize(0.9);

let selected = null;

tControls.addEventListener("dragging-changed", (e) => {
  controls.enabled = !e.value;
});

window.addEventListener("keydown", (e) => {
  if (e.code === "KeyW") tControls.setMode("translate");
  if (e.code === "KeyE") tControls.setMode("rotate");
  if (e.code === "KeyR") tControls.setMode("scale");
});

const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();

function pick(e) {
  const rect = renderer.domElement.getBoundingClientRect();
  pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
  pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
  raycaster.setFromCamera(pointer, camera);
  const candidates = [projA.projector, projB.projector].map(
    (p) => p.children[0]
  );
  const intersects = raycaster.intersectObjects(candidates, true);
  if (intersects.length) {
    const cone = intersects[0].object;
    const pr = cone.parent; // projector
    const root = pr.parent; // group
    selected = root;
    tControls.attach(root);
  }
}

renderer.domElement.addEventListener("pointerdown", pick);

// --- GUI via Inspector ---
const gui = renderer.inspector.createParameters("Projectors");

function addProjectorGUI(label, proj, initialType) {
  const folder = gui.addFolder(label);
  const params = {
    content: initialType,
    color: proj.projector.color.getHex(),
    intensity: proj.projector.intensity,
    distance: proj.projector.distance,
    angle: proj.projector.angle,
    penumbra: proj.projector.penumbra,
    decay: proj.projector.decay,
    focus: proj.projector.shadow.focus,
    shadows: true,
  };

  folder
    .add(params, "content", [
      "none",
      "canvasA",
      "canvasB",
      "videoAtlas",
      "videoBuildx",
      "procedural",
    ])
    .onChange((v) => setProjectorContent(proj.projector, v));
  folder
    .addColor(params, "color")
    .onChange((v) => proj.projector.color.setHex(v));
  folder
    .add(params, "intensity", 0, 500)
    .onChange((v) => (proj.projector.intensity = v));
  folder
    .add(params, "distance", 0, 50)
    .onChange((v) => (proj.projector.distance = v));
  folder
    .add(params, "angle", 0, Math.PI / 3)
    .onChange((v) => (proj.projector.angle = v));
  folder
    .add(params, "penumbra", 0, 1)
    .onChange((v) => (proj.projector.penumbra = v));
  folder.add(params, "decay", 1, 2).onChange((v) => (proj.projector.decay = v));
  folder
    .add(params, "focus", 0, 1)
    .onChange((v) => (proj.projector.shadow.focus = v));
  folder.add(params, "shadows").onChange((v) => {
    renderer.shadowMap.enabled = v;
    scene.traverse((child) => {
      if (child.material) child.material.needsUpdate = true;
    });
  });
}

addProjectorGUI("Projector A", projA, "videoAtlas");
addProjectorGUI("Projector B", projB, "videoBuildx");

// --- Volumetric Medium (Compute-generated Cloud) ---
let postProcessing;
let computeNode;

// Create compute shader for cloud generation
function createCloudTexture() {
  const size = 200;

  const computeCloud = Fn(({ storageTexture }) => {
    const scale = float(0.05);
    const id = instanceIndex;

    const x = id.mod(size);
    const y = id.div(size).mod(size);
    const z = id.div(size * size);

    const coord3d = vec3(x, y, z);
    const centered = coord3d.sub(size / 2).div(size);
    const d = float(1.0).sub(centered.length());

    const noiseCoord = coord3d.mul(scale.div(1.5)).add(time);

    const noise = mx_noise_vec3(noiseCoord).toConst("noise");

    const data = noise.mul(d).mul(d).toConst("data");

    textureStore(storageTexture, vec3(x, y, z), vec4(vec3(data.x), 1.0));
  });

  const storageTexture = new THREE.Storage3DTexture(size, size, size);
  storageTexture.generateMipmaps = false;
  storageTexture.name = "cloud";

  computeNode = computeCloud({ storageTexture })
    .compute(size * size * size)
    .setName("computeCloud");

  return storageTexture;
}

const volumetricLayer = new THREE.Layers();
volumetricLayer.disableAll();
volumetricLayer.enable(LAYER_VOLUMETRIC);

const densityTex3D = createCloudTexture();

// Material parameters - VolumeNodeMaterial supports lights
const densityScale = uniform(0.5);
const range = uniform(0.1);
const threshold = uniform(0.08);

const volumetricMaterial = new THREE.VolumeNodeMaterial();
volumetricMaterial.steps = 100;
volumetricMaterial.offsetNode = bayer16(screenCoordinate);

// Scattering function that samples the compute-generated cloud texture
volumetricMaterial.scatteringNode = Fn(({ positionRay }) => {
  // Normalize position to [0,1] for texture sampling
  // The volume box will be 40x20x30, so we need to scale appropriately
  const boxSize = vec3(40, 20, 30);
  const uvw = positionRay.div(boxSize).add(0.5);

  const mapValue = texture3D(densityTex3D, uvw, 0).r;

  // Apply threshold and smoothing
  const density = smoothstep(
    threshold.sub(range),
    threshold.add(range),
    mapValue
  );

  return density.mul(densityScale);
});

const volumetricBox = new THREE.Mesh(
  new THREE.BoxGeometry(40, 20, 30),
  volumetricMaterial
);
volumetricBox.position.set(0, 10, 0);
volumetricBox.receiveShadow = false;
volumetricBox.layers.disableAll();
volumetricBox.layers.enable(LAYER_VOLUMETRIC);
scene.add(volumetricBox);

// Post-processing setup for volumetric lighting compositing
postProcessing = new THREE.PostProcessing(renderer);

const volumetricIntensity = uniform(1.0);
const scenePass = pass(scene, camera);
const sceneDepth = scenePass.getTextureNode("depth");

// Connect the depth buffer to the volumetric material so it knows where solid objects are
volumetricMaterial.depthNode = sceneDepth.sample(screenUV);

const volumetricPass = pass(scene, camera, { depthBuffer: false });
volumetricPass.name = "Volumetric Lighting";
volumetricPass.setLayers(volumetricLayer);
volumetricPass.setResolutionScale(0.5);

const denoiseStrength = uniform(0.6);
let blurredVolumetricPass = gaussianBlur(volumetricPass, denoiseStrength);

let scenePassColor = scenePass.add(
  blurredVolumetricPass.mul(volumetricIntensity)
);
postProcessing.outputNode = scenePassColor;

// GUI for volumetrics
const volFolder = renderer.inspector.createParameters("Volumetrics");
const qualityParams = {
  resolution: volumetricPass.getResolutionScale(),
  denoise: true,
};
volFolder
  .add(qualityParams, "resolution", 0.1, 1)
  .onChange((v) => volumetricPass.setResolutionScale(v));
volFolder.add(volumetricMaterial, "steps", 10, 200, 1).name("step count");
volFolder.add(denoiseStrength, "value", 0, 1).name("denoise strength");
volFolder.add(qualityParams, "denoise").onChange((denoise) => {
  blurredVolumetricPass = gaussianBlur(volumetricPass, denoiseStrength);
  const volNode = denoise ? blurredVolumetricPass : volumetricPass;
  scenePassColor = scenePass.add(volNode.mul(volumetricIntensity));
  postProcessing.outputNode = scenePassColor;
  postProcessing.needsUpdate = true;
});
volFolder.add(volumetricIntensity, "value", 0, 5).name("intensity");
volFolder.add(densityScale, "value", 0, 2, 0.01).name("density scale");
volFolder.add(threshold, "value", 0, 1, 0.01).name("threshold");
volFolder.add(range, "value", 0, 1, 0.01).name("range");

// --- Initialize renderer and start animation ---
async function startAnimation() {
  await renderer.init();
  // try to start videos after renderer is ready; browsers may still require user gesture
  ensureVideoPlayback();
  await renderer.computeAsync(computeNode);

  let last = performance.now() * 0.001;

  renderer.setAnimationLoop(() => {
    const now = performance.now() * 0.001;
    const dt = Math.min(0.1, now - last);
    last = now;

    // Update projector targets to follow closest wall points
    updateProjectorTargets();

    // Update canvas textures
    canvasA.draw(canvasA.ctx, now);
    canvasA.texture.needsUpdate = true;
    canvasB.draw(canvasB.ctx, now);
    canvasB.texture.needsUpdate = true;

    // Update compute texture
    renderer.computeAsync(computeNode);

    if (postProcessing) {
      postProcessing.render();
    } else {
      renderer.render(scene, camera);
    }
  });
}

startAnimation();

// Ensure playback on first interaction if autoplay was blocked
renderer.domElement.addEventListener("pointerdown", function once() {
  ensureVideoPlayback();
  renderer.domElement.removeEventListener("pointerdown", once);
});
