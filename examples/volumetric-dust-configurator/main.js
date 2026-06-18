import { setup } from "../_shared/setup.js";
import {
  Fn,
  vec3,
  uniform,
  time,
  texture3D,
  pass,
  screenUV,
  screenCoordinate,
  instancedArray,
  instanceIndex,
  hash,
  float,
  If,
  shapeCircle,
  positionWorld,
} from "three/tsl";
import { Inspector } from "three/addons/inspector/Inspector.js";
import { ImprovedNoise } from "three/addons/math/ImprovedNoise.js";
import { bayer16 } from "three/addons/tsl/math/Bayer.js";
import { gaussianBlur } from "three/addons/tsl/display/GaussianBlurNode.js";

// === Constants ===
const LAYER_VOLUMETRIC = 10;

// === Renderer / Scene / Camera Setup ===
const { THREE, renderer, scene, camera, controls } = setup({ fov: 60 });
camera.position.set(8, 6, 12);
controls.target.set(0, 3, 0);
controls.maxDistance = 40;
controls.minDistance = 2;
controls.update();

renderer.toneMapping = THREE.NeutralToneMapping;
renderer.toneMappingExposure = 1.2;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.inspector = new Inspector();
scene.background = new THREE.Color(0x0a0a0a);

// === Room Environment ===
// Floor
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

// Back Wall
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

// Side Walls
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

// === Scene Objects ===
// Pedestal
const pedestalGeometry = new THREE.BoxGeometry(2, 4, 2);
const pedestalMaterial = new THREE.MeshStandardNodeMaterial({
  color: 0x4a4a4a,
  roughness: 0.6,
  metalness: 0.3,
});
const pedestal = new THREE.Mesh(pedestalGeometry, pedestalMaterial);
pedestal.position.set(-3, 2, 0);
pedestal.castShadow = true;
pedestal.receiveShadow = true;
scene.add(pedestal);

// Sphere on pedestal
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

// Torus knot
const torusKnotGeometry = new THREE.TorusKnotGeometry(1.2, 0.4, 128, 16);
const torusKnotMaterial = new THREE.MeshStandardNodeMaterial({
  color: 0x666666,
  roughness: 0.4,
  metalness: 0.6,
});
const torusKnot = new THREE.Mesh(torusKnotGeometry, torusKnotMaterial);
torusKnot.position.set(3, 3, 0);
torusKnot.castShadow = true;
torusKnot.receiveShadow = true;
scene.add(torusKnot);

// === Ambient Light ===
const ambientLight = new THREE.AmbientLight(0x404040, 0.3);
scene.add(ambientLight);

// === Spot Light ===
const spotLight = new THREE.SpotLight(0xffffff, 80);
spotLight.position.set(5, 10, 8);
spotLight.angle = Math.PI / 6;
spotLight.penumbra = 0.5;
spotLight.decay = 2;
spotLight.distance = 0;
spotLight.castShadow = true;
spotLight.shadow.mapSize.width = 1024;
spotLight.shadow.mapSize.height = 1024;
spotLight.shadow.camera.near = 1;
spotLight.shadow.camera.far = 30;
spotLight.shadow.bias = -0.002;
spotLight.layers.enable(LAYER_VOLUMETRIC);
scene.add(spotLight);
scene.add(spotLight.target);
spotLight.target.position.set(0, 0, 0);

// Spot light helper (small sphere)
const spotLightHelper = new THREE.Mesh(
  new THREE.SphereGeometry(0.2, 16, 16),
  new THREE.MeshBasicMaterial({ color: 0xffffff })
);
spotLightHelper.position.copy(spotLight.position);
scene.add(spotLightHelper);

// === Point Light ===
const pointLight = new THREE.PointLight(0xff8844, 50, 100);
pointLight.position.set(-5, 5, 5);
pointLight.castShadow = true;
pointLight.shadow.mapSize.width = 512;
pointLight.shadow.mapSize.height = 512;
pointLight.shadow.camera.near = 0.5;
pointLight.shadow.camera.far = 30;
pointLight.layers.enable(LAYER_VOLUMETRIC);
scene.add(pointLight);

// Point light helper
const pointLightHelper = new THREE.Mesh(
  new THREE.SphereGeometry(0.2, 16, 16),
  new THREE.MeshBasicMaterial({ color: 0xff8844 })
);
pointLightHelper.position.copy(pointLight.position);
scene.add(pointLightHelper);

// === Directional Light (simulating window light) ===
const directionalLight = new THREE.DirectionalLight(0x88ccff, 3);
directionalLight.position.set(-8, 10, -5);
directionalLight.castShadow = true;
directionalLight.shadow.mapSize.width = 1024;
directionalLight.shadow.mapSize.height = 1024;
directionalLight.shadow.camera.left = -15;
directionalLight.shadow.camera.right = 15;
directionalLight.shadow.camera.top = 15;
directionalLight.shadow.camera.bottom = -15;
directionalLight.shadow.camera.near = 0.5;
directionalLight.shadow.camera.far = 50;
directionalLight.shadow.bias = -0.001;
directionalLight.layers.enable(LAYER_VOLUMETRIC);
scene.add(directionalLight);

// === 3D Noise Texture Generation ===
function createDustTexture3D() {
  const size = 128;
  const data = new Uint8Array(size * size * size);

  const perlin = new ImprovedNoise();
  const scale = 8;
  const repeatFactor = 4.0;

  let i = 0;
  for (let z = 0; z < size; z++) {
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const nx = (x / size) * repeatFactor;
        const ny = (y / size) * repeatFactor;
        const nz = (z / size) * repeatFactor;

        // Multi-octave noise for realistic dust variation
        let noiseValue = 0;
        noiseValue += perlin.noise(nx * scale, ny * scale, nz * scale) * 1.0;
        noiseValue +=
          perlin.noise(nx * scale * 2, ny * scale * 2, nz * scale * 2) * 0.5;
        noiseValue +=
          perlin.noise(nx * scale * 4, ny * scale * 4, nz * scale * 4) * 0.25;
        noiseValue /= 1.75; // Normalize

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

const dustTexture3D = createDustTexture3D();

// === Volumetric Material Setup ===
const densityMultiplier = uniform(0.8);
const noiseScale = uniform(0.08);
const animationSpeed = uniform(0.005);

const volumetricMaterial = new THREE.VolumeNodeMaterial();
volumetricMaterial.steps = 20;
volumetricMaterial.offsetNode = bayer16(screenCoordinate);

// Realistic dust scattering function
volumetricMaterial.scatteringNode = Fn(({ positionRay }) => {
  // Slow-moving multi-octave noise for realistic dust
  const timeScaled = vec3(
    time.mul(animationSpeed),
    time.mul(animationSpeed.mul(0.6)),
    time.mul(animationSpeed.mul(1.4))
  );

  // Sample noise at multiple scales
  const baseScale = noiseScale;
  const dust1 = texture3D(
    dustTexture3D,
    positionRay.add(timeScaled).mul(baseScale).mod(1),
    0
  ).r;

  const dust2 = texture3D(
    dustTexture3D,
    positionRay.add(timeScaled.mul(0.5)).mul(baseScale.mul(2.0)).mod(1),
    0
  ).r;

  const dust3 = texture3D(
    dustTexture3D,
    positionRay.add(timeScaled.mul(0.3)).mul(baseScale.mul(4.0)).mod(1),
    0
  ).r;

  // Combine octaves - multiply creates sparse, realistic distribution
  const density = dust1.mul(dust2).mul(dust3).pow(1.5);

  return densityMultiplier.mul(density);
});

// Create volumetric mesh (large box filling the room)
const volumetricBox = new THREE.Mesh(
  new THREE.BoxGeometry(28, 11, 28),
  volumetricMaterial
);
volumetricBox.position.set(0, 5.5, 0);
volumetricBox.receiveShadow = true;
volumetricBox.layers.disableAll();
volumetricBox.layers.enable(LAYER_VOLUMETRIC);
scene.add(volumetricBox);

// === Floating Dust Particles ===
const dustParticleCount = 10000;

// Create storage buffers for particle data
const particlePositions = instancedArray(dustParticleCount, "vec3");
const particleVelocities = instancedArray(dustParticleCount, "vec3");
const particleData = instancedArray(dustParticleCount, "vec4");

// Initialize particles
const computeInitParticles = Fn(() => {
  const position = particlePositions.element(instanceIndex);
  const velocity = particleVelocities.element(instanceIndex);
  const data = particleData.element(instanceIndex);

  const randX = hash(instanceIndex);
  const randY = hash(instanceIndex.add(1000));
  const randZ = hash(instanceIndex.add(2000));

  position.x = randX.mul(28).add(-14);
  position.y = randY.mul(11);
  position.z = randZ.mul(28).add(-14);

  velocity.x = hash(instanceIndex.add(3000)).sub(0.5).mul(0.01);
  velocity.y = hash(instanceIndex.add(4000)).sub(0.5).mul(0.005);
  velocity.z = hash(instanceIndex.add(5000)).sub(0.5).mul(0.01);

  data.x = hash(instanceIndex.add(6000)).mul(0.5).add(0.5);
  data.y = randX;
})()
  .compute(dustParticleCount)
  .setName("Init Dust Particles");

// Update particles
const computeUpdateParticles = Fn(() => {
  const position = particlePositions.element(instanceIndex);
  const velocity = particleVelocities.element(instanceIndex);
  const data = particleData.element(instanceIndex);

  const t = time.mul(0.5);
  const phaseOffset = data.y.mul(10);

  const driftX = t.add(phaseOffset).sin().mul(0.002);
  const driftZ = t.add(phaseOffset).cos().mul(0.002);

  velocity.x = velocity.x.mul(0.98).add(driftX);
  velocity.z = velocity.z.mul(0.98).add(driftZ);
  velocity.y = velocity.y.mul(0.99).add(-0.001);

  position.addAssign(velocity);

  If(position.y.lessThan(0), () => {
    position.y = float(11);
  });

  If(position.x.lessThan(-14).or(position.x.greaterThan(14)), () => {
    position.x = position.x.mul(-1).mul(0.9);
  });

  If(position.z.lessThan(-14).or(position.z.greaterThan(14)), () => {
    position.z = position.z.mul(-1).mul(0.9);
  });
});

const computeDustParticles =
  computeUpdateParticles().compute(dustParticleCount);

// Create particle material
const dustParticleMaterial = new THREE.SpriteNodeMaterial();
dustParticleMaterial.depthWrite = false;
dustParticleMaterial.transparent = true;
dustParticleMaterial.blending = THREE.AdditiveBlending;
dustParticleMaterial.positionNode = particlePositions.toAttribute();
dustParticleMaterial.scaleNode = particleData.toAttribute().x.mul(0.03);

// Light-reactive color
const spotLightPos = uniform(spotLight.position);
const spotLightTarget = uniform(spotLight.target.position);
const pointLightPos = uniform(pointLight.position);

dustParticleMaterial.colorNode = Fn(() => {
  const worldPos = positionWorld;

  // Spotlight beam detection
  const toLight = worldPos.sub(spotLightPos);
  const lightDir = spotLightTarget.sub(spotLightPos).normalize();
  const projectionLength = toLight.dot(lightDir).max(0);
  const projectedPoint = spotLightPos.add(lightDir.mul(projectionLength));
  const distToRay = worldPos.sub(projectedPoint).length();

  const inSpotBeam = float(1).sub(distToRay.div(2.5)).max(0).pow(2.5).mul(3.0);

  // Point light influence
  const distToPoint = worldPos.sub(pointLightPos).length();
  const pointLightInfluence = float(1)
    .sub(distToPoint.div(12))
    .max(0)
    .pow(2)
    .mul(1.5);

  const spotColor = vec3(1.0, 1.0, 1.0);
  const pointColor = vec3(1.0, 0.53, 0.27);

  const finalColor = spotColor
    .mul(inSpotBeam)
    .add(pointColor.mul(pointLightInfluence));

  // Higher ambient so particles are always visible
  return finalColor.add(vec3(0.08));
})();

dustParticleMaterial.opacityNode = shapeCircle().mul(0.6);

const dustParticles = new THREE.Sprite(dustParticleMaterial);
dustParticles.count = dustParticleCount;
dustParticles.frustumCulled = false;
scene.add(dustParticles);

// Initialize
renderer.computeAsync(computeInitParticles);

// === Post-Processing Setup ===
const postProcessing = new THREE.PostProcessing(renderer);

// Volumetric layer
const volumetricLayer = new THREE.Layers();
volumetricLayer.disableAll();
volumetricLayer.enable(LAYER_VOLUMETRIC);

// Scene pass with depth
const scenePass = pass(scene, camera);
const sceneDepth = scenePass.getTextureNode("depth");

// Apply depth occlusion to volumetric material
volumetricMaterial.depthNode = sceneDepth.sample(screenUV);

// Volumetric pass
const volumetricPass = pass(scene, camera, { depthBuffer: false });
volumetricPass.name = "Volumetric Lighting";
volumetricPass.setLayers(volumetricLayer);
volumetricPass.setResolutionScale(0.4);

// Denoising
const denoiseStrength = uniform(0.7);
const blurredVolumetricPass = gaussianBlur(volumetricPass, denoiseStrength);

// Compositing
const volumetricIntensity = uniform(1.2);
let useBlur = true;

function updateComposition() {
  const volumetric = useBlur ? blurredVolumetricPass : volumetricPass;
  const scenePassColor = scenePass.add(volumetric.mul(volumetricIntensity));
  postProcessing.outputNode = scenePassColor;
  postProcessing.needsUpdate = true;
}

updateComposition();

// === GUI Setup ===
const gui = renderer.inspector.createParameters("Volumetric Dust Configurator");

// --- Volumetric Quality ---
const qualityFolder = gui.addFolder("Volumetric Quality");
qualityFolder
  .add(volumetricMaterial, "steps", 8, 64, 1)
  .name("ray march steps");

const qualityParams = {
  resolution: volumetricPass.getResolutionScale(),
};
qualityFolder
  .add(qualityParams, "resolution", 0.1, 1.0, 0.05)
  .onChange((value) => {
    volumetricPass.setResolutionScale(value);
  });

qualityFolder
  .add(denoiseStrength, "value", 0, 1, 0.05)
  .name("denoise strength");

const denoiseParams = { enabled: true };
qualityFolder
  .add(denoiseParams, "enabled")
  .name("denoise enabled")
  .onChange((value) => {
    useBlur = value;
    updateComposition();
  });

// --- Dust Appearance ---
const dustFolder = gui.addFolder("Dust Appearance");
dustFolder.add(densityMultiplier, "value", 0.1, 3.0, 0.05).name("density");
dustFolder.add(noiseScale, "value", 0.02, 0.2, 0.01).name("noise scale");
dustFolder.add(animationSpeed, "value", 0, 0.02, 0.001).name("animation speed");
dustFolder.add(volumetricIntensity, "value", 0, 3.0, 0.1).name("intensity");

// --- Spot Light ---
const spotFolder = gui.addFolder("Spot Light");
const spotParams = {
  enabled: true,
  color: spotLight.color.getHex(),
};
spotFolder.add(spotParams, "enabled").onChange((value) => {
  spotLight.visible = value;
  spotLightHelper.visible = value;
});
spotFolder.addColor(spotParams, "color").onChange((value) => {
  spotLight.color.setHex(value);
  spotLightHelper.material.color.setHex(value);
});
spotFolder.add(spotLight, "intensity", 0, 200, 5).name("intensity");
spotFolder.add(spotLight, "angle", 0, Math.PI / 3, 0.01).name("angle");
spotFolder.add(spotLight, "penumbra", 0, 1, 0.05).name("penumbra");
spotFolder.add(spotLight, "decay", 1, 2, 0.1).name("decay");

// --- Point Light ---
const pointFolder = gui.addFolder("Point Light");
const pointParams = {
  enabled: true,
  color: pointLight.color.getHex(),
};
pointFolder.add(pointParams, "enabled").onChange((value) => {
  pointLight.visible = value;
  pointLightHelper.visible = value;
});
pointFolder.addColor(pointParams, "color").onChange((value) => {
  pointLight.color.setHex(value);
  pointLightHelper.material.color.setHex(value);
});
pointFolder.add(pointLight, "intensity", 0, 150, 5).name("intensity");
pointFolder.add(pointLight, "distance", 0, 100, 5).name("distance");
pointFolder.add(pointLight, "decay", 1, 2, 0.1).name("decay");

// --- Directional Light ---
const dirFolder = gui.addFolder("Directional Light (Window)");
const dirParams = {
  enabled: true,
  color: directionalLight.color.getHex(),
};
dirFolder.add(dirParams, "enabled").onChange((value) => {
  directionalLight.visible = value;
});
dirFolder.addColor(dirParams, "color").onChange((value) => {
  directionalLight.color.setHex(value);
});
dirFolder.add(directionalLight, "intensity", 0, 10, 0.5).name("intensity");

// --- Dust Particles ---
const particlesFolder = gui.addFolder("Dust Particles");
const particleParams = {
  enabled: true,
  particleOpacity: 0.6,
  particleSize: 0.03,
};
particlesFolder.add(particleParams, "enabled").onChange((value) => {
  dustParticles.visible = value;
});
particlesFolder
  .add(particleParams, "particleOpacity", 0, 1, 0.05)
  .name("opacity")
  .onChange((value) => {
    dustParticleMaterial.opacityNode = shapeCircle().mul(value);
    dustParticleMaterial.needsUpdate = true;
  });
particlesFolder
  .add(particleParams, "particleSize", 0.01, 0.1, 0.01)
  .name("size")
  .onChange((value) => {
    dustParticleMaterial.scaleNode = particleData.toAttribute().x.mul(value);
    dustParticleMaterial.needsUpdate = true;
  });

// --- Scene Options ---
const sceneFolder = gui.addFolder("Scene Options");
const sceneParams = {
  shadows: true,
  backgroundColor: scene.background.getHex(),
  resetCamera: () => {
    camera.position.set(8, 6, 12);
    controls.target.set(0, 3, 0);
    controls.update();
  },
};
sceneFolder.add(sceneParams, "shadows").onChange((value) => {
  renderer.shadowMap.enabled = value;
  scene.traverse((obj) => {
    if (obj.material) obj.material.needsUpdate = true;
  });
});
sceneFolder.addColor(sceneParams, "backgroundColor").onChange((value) => {
  scene.background.setHex(value);
});
sceneFolder.add(sceneParams, "resetCamera").name("reset camera");

// === Animation Loop ===
renderer.setAnimationLoop(() => {
  // Animate objects slightly
  torusKnot.rotation.y += 0.005;
  torusKnot.rotation.x += 0.002;

  // Update light helpers
  spotLightHelper.position.copy(spotLight.position);
  pointLightHelper.position.copy(pointLight.position);

  // Update dust particles
  renderer.compute(computeDustParticles);

  // Render
  postProcessing.render();
});
