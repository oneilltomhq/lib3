import { setup } from "../_shared/setup.js";
import { texture, uniform, sin, time, uv, vec3, Fn } from "three/tsl";
import { RectAreaLightTexturesLib } from "three/addons/lights/RectAreaLightTexturesLib.js";

let rectLight1, rectLight2;
let videoTexture, canvas2d, ctx;

init();

async function init() {
  const { THREE, renderer, scene, camera, controls } = setup({ fov: 60 });
  camera.position.set(0, 3, 8);
  controls.target.set(0, 1, 0);
  controls.update();

  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.2;
  scene.background = new THREE.Color(0x111111);

  // Initialize WebGPU backend
  await renderer.init();

  // Initialize RectAreaLight textures for WebGPU
  THREE.RectAreaLightNode.setLTC(RectAreaLightTexturesLib.init());

  // Create a procedural video texture using canvas
  createProceduralVideoTexture();

  // Create RectAreaLight #1 with video texture as colorNode
  const lightWidth = 4;
  const lightHeight = 3;

  rectLight1 = new THREE.RectAreaLight(0xffffff, 5, lightWidth, lightHeight);
  rectLight1.position.set(-3, 3, 0);
  rectLight1.lookAt(0, 0, 0);

  // THIS IS THE KEY: Set colorNode to use the video texture!
  // The texture will be sampled at the center (0.5, 0.5) by default
  // We can also create a more complex sampling pattern using TSL
  const centerUV = vec3(0.5, 0.5, 0);
  rectLight1.colorNode = texture(videoTexture, centerUV).mul(uniform(3)); // Multiply for intensity

  scene.add(rectLight1);

  // Create visual representation of the light
  const lightPlaneGeo = new THREE.PlaneGeometry(lightWidth, lightHeight);
  const lightPlaneMat = new THREE.MeshBasicNodeMaterial();
  lightPlaneMat.colorNode = texture(videoTexture).mul(2);
  lightPlaneMat.side = THREE.DoubleSide;

  const lightPlaneMesh = new THREE.Mesh(lightPlaneGeo, lightPlaneMat);
  rectLight1.add(lightPlaneMesh);

  // Create RectAreaLight #2 with animated procedural colorNode
  rectLight2 = new THREE.RectAreaLight(0xffffff, 3, 4, 3);
  rectLight2.position.set(3, 3, 0);
  rectLight2.lookAt(0, 0, 0);

  // Create a procedural animated color using TSL nodes
  const animatedColor = Fn(() => {
    const t = time.mul(0.5);
    const r = sin(t).mul(0.5).add(0.5);
    const g = sin(t.add(2.0)).mul(0.5).add(0.5);
    const b = sin(t.add(4.0)).mul(0.5).add(0.5);
    return vec3(r, g, b).mul(2.0);
  })();

  rectLight2.colorNode = animatedColor;

  scene.add(rectLight2);

  // Visual representation for rectLight2
  const lightPlane2Mat = new THREE.MeshBasicNodeMaterial();
  lightPlane2Mat.colorNode = animatedColor;
  lightPlane2Mat.side = THREE.DoubleSide;

  const lightPlane2Mesh = new THREE.Mesh(lightPlaneGeo.clone(), lightPlane2Mat);
  rectLight2.add(lightPlane2Mesh);

  // Create floor
  const floorGeo = new THREE.BoxGeometry(20, 0.1, 20);
  const floorMat = new THREE.MeshStandardMaterial({
    color: 0x808080,
    roughness: 0.3,
    metalness: 0.1,
  });
  const floor = new THREE.Mesh(floorGeo, floorMat);
  floor.position.y = -0.05;
  scene.add(floor);

  // Create some objects to be lit
  const sphereGeo = new THREE.SphereGeometry(0.5, 32, 32);
  const sphereMat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.2,
    metalness: 0.8,
  });

  for (let i = 0; i < 5; i++) {
    const sphere = new THREE.Mesh(sphereGeo, sphereMat);
    const angle = (i / 5) * Math.PI * 2;
    const radius = 2;
    sphere.position.set(
      Math.cos(angle) * radius,
      0.5,
      Math.sin(angle) * radius
    );
    scene.add(sphere);
  }

  // Create a central cube
  const cubeGeo = new THREE.BoxGeometry(1, 1, 1);
  const cubeMat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.4,
    metalness: 0.6,
  });
  const cube = new THREE.Mesh(cubeGeo, cubeMat);
  cube.position.y = 0.5;
  scene.add(cube);

  // Back wall
  const wallGeo = new THREE.PlaneGeometry(20, 10);
  const wallMat = new THREE.MeshStandardMaterial({
    color: 0x404040,
    roughness: 0.8,
    metalness: 0.1,
  });
  const wall = new THREE.Mesh(wallGeo, wallMat);
  wall.position.set(0, 5, -5);
  scene.add(wall);

  // Start animation loop after renderer is initialized
  animate();

  function animate() {
    requestAnimationFrame(animate);

    // Update procedural texture
    updateProceduralTexture();

    // Rotate lights slightly
    rectLight1.rotation.y = Math.sin(performance.now() * 0.0005) * 0.3;
    rectLight2.rotation.y = Math.cos(performance.now() * 0.0003) * 0.3;

    controls.update();
    renderer.render(scene, camera);
  }
}

function createProceduralVideoTexture() {
  // Create a canvas for procedural animation
  const width = 512;
  const height = 512;

  canvas2d = document.createElement("canvas");
  canvas2d.width = width;
  canvas2d.height = height;
  ctx = canvas2d.getContext("2d");

  // Create CanvasTexture
  videoTexture = new THREE.CanvasTexture(canvas2d);
  videoTexture.minFilter = THREE.LinearFilter;
  videoTexture.magFilter = THREE.LinearFilter;
}

function updateProceduralTexture() {
  const width = canvas2d.width;
  const height = canvas2d.height;
  const t = performance.now() * 0.001;

  // Create animated gradient pattern
  const imageData = ctx.createImageData(width, height);
  const data = imageData.data;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4;

      const nx = x / width - 0.5;
      const ny = y / height - 0.5;
      const dist = Math.sqrt(nx * nx + ny * ny);
      const angle = Math.atan2(ny, nx);

      // Create swirling pattern
      const r = Math.sin(dist * 10 - t * 2 + angle * 3) * 0.5 + 0.5;
      const g = Math.sin(dist * 8 - t * 1.5 + angle * 2) * 0.5 + 0.5;
      const b = Math.sin(dist * 12 - t * 2.5 + angle * 4) * 0.5 + 0.5;

      data[idx] = r * 255;
      data[idx + 1] = g * 255;
      data[idx + 2] = b * 255;
      data[idx + 3] = 255;
    }
  }

  ctx.putImageData(imageData, 0, 0);
  videoTexture.needsUpdate = true;
}
