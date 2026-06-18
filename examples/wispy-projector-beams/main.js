import { setup } from "../_shared/setup.js";
import {
  abs,
  negate,
  Fn,
  vec3,
  uniform,
  time,
  texture3D,
  pass,
  screenUV,
  screenCoordinate,
  dot,
  length,
  max,
  mul,
  add,
  sub,
  div,
  exp,
  float,
} from "three/tsl";
import { Inspector } from "three/addons/inspector/Inspector.js";
import { ImprovedNoise } from "three/addons/math/ImprovedNoise.js";
import { bayer16 } from "three/addons/tsl/math/Bayer.js";
import { gaussianBlur } from "three/addons/tsl/display/GaussianBlurNode.js";

// Constants
const LAYER_VOLUMETRIC = 10;

// === Renderer / Scene / Camera Setup ===
const { THREE, renderer, scene, camera, controls } = setup({ fov: 60 });
camera.position.set(8, 6, 12);
controls.target.set(0, 3, 0);
controls.maxDistance = 40;
controls.minDistance = 2;
controls.update();

renderer.toneMapping = THREE.NeutralToneMapping;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.inspector = new Inspector();
scene.background = new THREE.Color(0x0a0a0a);

// === Environment Setup ===
const floorGeometry = new THREE.PlaneGeometry(30, 30);
const floorMaterial = new THREE.MeshStandardNodeMaterial({
  color: 0x1a1a1a,
  roughness: 0.9,
  metalness: 0.1,
});
const floor = new THREE.Mesh(floorGeometry, floorMaterial);
floor.rotation.x = -Math.PI / 2;
floor.receiveShadow = true;
scene.add(floor);

// Back wall for projection
const wallGeometry = new THREE.BoxGeometry(30, 12, 0.5);
const wallMaterial = new THREE.MeshStandardNodeMaterial({
  color: 0x2a2a2a,
  roughness: 0.95,
  metalness: 0.0,
});
const backWall = new THREE.Mesh(wallGeometry, wallMaterial);
backWall.position.set(0, 6, -10);
backWall.receiveShadow = true;
scene.add(backWall);

// Side walls
const leftWall = new THREE.Mesh(wallGeometry, wallMaterial);
leftWall.rotation.y = Math.PI / 2;
leftWall.position.set(-15, 6, 5);
leftWall.receiveShadow = true;
scene.add(leftWall);

const rightWall = new THREE.Mesh(wallGeometry, wallMaterial);
rightWall.rotation.y = -Math.PI / 2;
rightWall.position.set(15, 6, 5);
rightWall.receiveShadow = true;
scene.add(rightWall);

// Scene objects for context
const sphereGeometry = new THREE.SphereGeometry(1, 32, 32);
const sphereMaterial = new THREE.MeshStandardNodeMaterial({
  color: 0x888888,
  roughness: 0.2,
  metalness: 0.8,
});
const sphere = new THREE.Mesh(sphereGeometry, sphereMaterial);
sphere.position.set(-3, 5, 0);
sphere.castShadow = true;
sphere.receiveShadow = true;
scene.add(sphere);

// === Ambient Lighting ===
const ambientLight = new THREE.AmbientLight(0x404040, 0.3);
scene.add(ambientLight);

// === Projector Light Setup ===
function createProjector() {
  const projectorRoot = new THREE.Group();
  projectorRoot.name = "WispyProjector";

  const projector = new THREE.ProjectorLight(0x00aaff, 100);
  projector.angle = Math.PI / 6; // 30 degrees
  projector.penumbra = 0.5;
  projector.decay = 2;
  projector.distance = 0; // infinite
  projector.castShadow = true;
  projector.shadow.mapSize.set(1024, 1024);
  projector.shadow.camera.near = 0.5;
  projector.shadow.camera.far = 30;
  projector.shadow.bias = -0.0015;
  projector.layers.enable(LAYER_VOLUMETRIC);

  // Position projector
  projectorRoot.position.set(0, 8, 8);
  projectorRoot.lookAt(0, 3, 0);

  // Helper cone for visualization
  const cone = new THREE.Mesh(
    new THREE.ConeGeometry(0.3, 0.8, 20),
    new THREE.MeshStandardMaterial({
      color: 0x00aaff,
      emissive: 0x00aaff,
      emissiveIntensity: 0.4,
    })
  );
  cone.rotation.x = Math.PI / 2;
  cone.position.z = 0.2;
  cone.castShadow = false;
  cone.receiveShadow = false;

  projectorRoot.add(projector);
  projector.add(cone);

  // Set target on the back wall
  const target = new THREE.Object3D();
  target.position.set(0, 3, -9.5);
  scene.add(target);
  projector.target = target;

  scene.add(projectorRoot);

  return { root: projectorRoot, projector, cone, target };
}

const proj = createProjector();

// === 3D Noise Texture for Wispy Effects ===
function createWispyNoiseTexture3D() {
  const size = 64;
  const data = new Uint8Array(size * size * size);

  const perlin = new ImprovedNoise();
  const scale = 4;

  let i = 0;
  for (let z = 0; z < size; z++) {
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const nx = (x / size) * scale;
        const ny = (y / size) * scale;
        const nz = (z / size) * scale;

        // Multi-octave noise for wispy turbulence
        let noiseValue = 0;
        noiseValue += perlin.noise(nx, ny, nz) * 1.0;
        noiseValue += perlin.noise(nx * 2, ny * 2, nz * 2) * 0.5;
        noiseValue += perlin.noise(nx * 4, ny * 4, nz * 4) * 0.25;
        noiseValue += perlin.noise(nx * 8, ny * 8, nz * 8) * 0.125;
        noiseValue /= 1.875; // Normalize

        // Map to 0-255 range
        data[i] = Math.floor((noiseValue + 1) * 127.5);
        i++;
      }
    }
  }

  const texture = new THREE.Data3DTexture(data, size, size, size);
  texture.format = THREE.RedFormat;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.wrapR = THREE.RepeatWrapping;
  texture.unpackAlignment = 1;
  texture.needsUpdate = true;

  return texture;
}

const wispyNoiseTexture3D = createWispyNoiseTexture3D();

// === Volumetric Material with Wispy Beams ===
const densityStrength = uniform(0.8);
const noiseScale = uniform(5.0);
const animationSpeed = uniform(0.2);
const beamFalloff = uniform(0.1);

// Projector uniforms
const projectorPosition = uniform(
  proj.projector.getWorldPosition(new THREE.Vector3())
);
const projectorDirection = uniform(
  new THREE.Vector3(0, 0, -1)
    .applyQuaternion(proj.projector.getWorldQuaternion(new THREE.Quaternion()))
    .normalize()
);
const projectorAngle = uniform(Math.cos(proj.projector.angle / 2));
const projectorColor = uniform(new THREE.Color(0x00aaff));

const volumetricMaterial = new THREE.VolumeNodeMaterial();
volumetricMaterial.steps = 32;
volumetricMaterial.offsetNode = bayer16(screenCoordinate);

// Wispy density function with turbulence
function turbulence(pos, octaves = 4) {
  let value = float(0.0);
  let amplitude = float(1.0);
  let frequency = float(1.0);

  for (let i = 0; i < octaves; i++) {
    const noiseSample = texture3D(
      wispyNoiseTexture3D,
      pos.mul(frequency).mod(1),
      0
    ).r;
    value = add(value, mul(amplitude, abs(noiseSample)));
    amplitude = mul(amplitude, 0.5);
    frequency = mul(frequency, 2.0);
  }
  return value;
}

// Wispy density field - only returns density, lighting is handled by the volumetric model
volumetricMaterial.scatteringNode = Fn(({ positionRay }) => {
  // Check if sample point is inside projector cone
  const toLight = sub(projectorPosition, positionRay);
  const distToLight = length(toLight);
  const lightDir = div(toLight, distToLight);
  const cosTheta = dot(lightDir, projectorDirection);
  const inCone = float(cosTheta).greaterThan(projectorAngle);

  // Return density only if inside cone
  return inCone.select(
    (() => {
      const animatedPos = add(positionRay, mul(time, animationSpeed));
      const noise = turbulence(mul(animatedPos, noiseScale));

      // Create wispy density with threshold for irregular shapes
      const baseDensity = max(float(0.0), sub(noise, 0.3)).mul(densityStrength);

      // Exponential falloff along beam length
      const falloff = exp(mul(negate(beamFalloff), distToLight));

      return mul(baseDensity, falloff);
    })(),
    float(0.0)
  );
});

// Create volumetric mesh (beam volume)
const volumetricBox = new THREE.Mesh(
  new THREE.BoxGeometry(20, 12, 20),
  volumetricMaterial
);
volumetricBox.position.set(0, 6, 0);
volumetricBox.receiveShadow = true;
volumetricBox.layers.disableAll();
volumetricBox.layers.enable(LAYER_VOLUMETRIC);
scene.add(volumetricBox);

// === Post-Processing Setup ===
const postProcessing = new THREE.PostProcessing(renderer);

// Volumetric layer setup
const volumetricLayer = new THREE.Layers();
volumetricLayer.disableAll();
volumetricLayer.enable(LAYER_VOLUMETRIC);

// Scene pass
const scenePass = pass(scene, camera);
const sceneDepth = scenePass.getTextureNode("depth");
volumetricMaterial.depthNode = sceneDepth.sample(screenUV);

// Volumetric pass
const volumetricPass = pass(scene, camera, { depthBuffer: false });
volumetricPass.name = "Wispy Beams";
volumetricPass.setLayers(volumetricLayer);
volumetricPass.setResolutionScale(0.5);

// Denoising
const denoiseStrength = uniform(0.6);
const blurredVolumetricPass = gaussianBlur(volumetricPass, denoiseStrength);

// Compositing
const volumetricIntensity = uniform(1.0);
const scenePassColor = scenePass.add(
  blurredVolumetricPass.mul(volumetricIntensity)
);
postProcessing.outputNode = scenePassColor;

// === GUI Setup ===
const gui = renderer.inspector.createParameters("Wispy Projector Beams");

// Beam Appearance
const beamFolder = gui.addFolder("Beam Appearance");
beamFolder
  .add(densityStrength, "value", 0.1, 2.0, 0.05)
  .name("density strength");
beamFolder.add(noiseScale, "value", 1.0, 10.0, 0.5).name("noise scale");
beamFolder.add(animationSpeed, "value", 0.0, 1.0, 0.05).name("animation speed");
beamFolder.add(beamFalloff, "value", 0.0, 0.5, 0.01).name("beam falloff");

// Quality Settings
const qualityFolder = gui.addFolder("Quality");
qualityFolder
  .add(volumetricMaterial, "steps", 8, 64, 1)
  .name("ray march steps");
qualityFolder
  .add(denoiseStrength, "value", 0, 1, 0.05)
  .name("denoise strength");
qualityFolder.add(volumetricIntensity, "value", 0, 3.0, 0.1).name("intensity");

const qualityParams = {
  resolution: volumetricPass.getResolutionScale(),
};
qualityFolder
  .add(qualityParams, "resolution", 0.1, 1.0, 0.05)
  .onChange((value) => {
    volumetricPass.setResolutionScale(value);
  });

// Projector Settings
const projectorFolder = gui.addFolder("Projector");
const projectorParams = {
  color: proj.projector.color.getHex(),
  intensity: proj.projector.intensity,
  angle: proj.projector.angle,
  penumbra: proj.projector.penumbra,
};

projectorFolder.addColor(projectorParams, "color").onChange((value) => {
  proj.projector.color.setHex(value);
  projectorColor.value.setHex(value);
  proj.cone.material.emissive.setHex(value);
});

projectorFolder
  .add(projectorParams, "intensity", 0, 200, 5)
  .onChange((value) => {
    proj.projector.intensity = value;
  });

projectorFolder
  .add(projectorParams, "angle", 0, Math.PI / 3, 0.01)
  .onChange((value) => {
    proj.projector.angle = value;
    projectorAngle.value = Math.cos(value / 2);
  });

projectorFolder
  .add(projectorParams, "penumbra", 0, 1, 0.05)
  .onChange((value) => {
    proj.projector.penumbra = value;
  });

// === Animation Loop ===
renderer.setAnimationLoop(() => {
  // Update projector uniforms
  proj.projector.getWorldPosition(projectorPosition.value);
  new THREE.Vector3(0, 0, -1)
    .applyQuaternion(proj.projector.getWorldQuaternion(new THREE.Quaternion()))
    .normalize()
    .toArray(projectorDirection.value);

  // Animate sphere slightly
  sphere.rotation.y += 0.005;

  // Render
  postProcessing.render();
});
