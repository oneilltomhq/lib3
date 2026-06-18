import { setup } from "../_shared/setup.js";
import { pass, uniform, mix, Fn } from "three/tsl";

// ============================================================================
// Scene Setup
// ============================================================================

const { THREE, renderer, camera: mainCamera, controls } = setup({ fov: 60 });
mainCamera.position.set(0, 1.5, 5);
controls.target.set(0, 1, 0);
controls.enableDamping = true;
controls.dampingFactor = 0.05;
controls.update();

// Main gallery scene
const mainScene = new THREE.Scene();
mainScene.background = new THREE.Color(0x222222);

// Portal destination scenes
const portalSceneA = new THREE.Scene();
portalSceneA.background = new THREE.Color(0x331100); // Warm

const portalSceneB = new THREE.Scene();
portalSceneB.background = new THREE.Color(0x001133); // Cool

// ============================================================================
// Additional Cameras for Portals
// ============================================================================

const portalCameraA = new THREE.PerspectiveCamera(
  60,
  window.innerWidth / window.innerHeight,
  0.1,
  100
);
portalCameraA.position.set(0, 2, 5);

const portalCameraB = new THREE.PerspectiveCamera(
  60,
  window.innerWidth / window.innerHeight,
  0.1,
  100
);
portalCameraB.position.set(0, 2, 5);

// ============================================================================
// Additional Controls for Portals
// ============================================================================

const controlsA = new THREE.OrbitControls(portalCameraA, renderer.domElement);
controlsA.target.set(0, 0, 0);
controlsA.enableDamping = true;
controlsA.dampingFactor = 0.05;
controlsA.enabled = false; // Start disabled

const controlsB = new THREE.OrbitControls(portalCameraB, renderer.domElement);
controlsB.target.set(0, 0, 0);
controlsB.enableDamping = true;
controlsB.dampingFactor = 0.05;
controlsB.enabled = false; // Start disabled

// ============================================================================
// PostProcessing Setup with TSL
// ============================================================================

const mainPass = pass(mainScene, mainCamera);
const portalPassA = pass(portalSceneA, portalCameraA);
const portalPassB = pass(portalSceneB, portalCameraB);

// Blend uniforms (0 = main scene, 1 = portal scene)
const blendToA = uniform(0);
const blendToB = uniform(0);

const postProcessing = new THREE.PostProcessing(renderer);

// Chain multiple scene blends using TSL mix()
postProcessing.outputNode = Fn(() => {
  let result = mainPass;
  result = mix(result, portalPassA, blendToA);
  result = mix(result, portalPassB, blendToB);
  return result;
})();

// ============================================================================
// Create Portal Doors in Main Scene
// ============================================================================

function createDoorFrame(color) {
  const group = new THREE.Group();

  // Door surface (clickable)
  const doorGeometry = new THREE.PlaneGeometry(1.5, 2.5);
  const doorMaterial = new THREE.MeshStandardMaterial({
    color: color,
    emissive: color,
    emissiveIntensity: 0.3,
    metalness: 0.1,
    roughness: 0.7,
  });
  const door = new THREE.Mesh(doorGeometry, doorMaterial);
  door.userData.isPortalDoor = true;
  group.add(door);

  // Frame around door
  const frameThickness = 0.08;
  const frameDepth = 0.15;
  const frameMaterial = new THREE.MeshStandardMaterial({
    color: 0x111111,
    metalness: 0.8,
    roughness: 0.2,
  });

  // Top, bottom, left, right frame pieces
  const topFrame = new THREE.Mesh(
    new THREE.BoxGeometry(1.5 + frameThickness * 2, frameThickness, frameDepth),
    frameMaterial
  );
  topFrame.position.set(0, 2.5 / 2 + frameThickness / 2, frameDepth / 2);

  const bottomFrame = new THREE.Mesh(
    new THREE.BoxGeometry(1.5 + frameThickness * 2, frameThickness, frameDepth),
    frameMaterial
  );
  bottomFrame.position.set(0, -2.5 / 2 - frameThickness / 2, frameDepth / 2);

  const leftFrame = new THREE.Mesh(
    new THREE.BoxGeometry(frameThickness, 2.5, frameDepth),
    frameMaterial
  );
  leftFrame.position.set(-1.5 / 2 - frameThickness / 2, 0, frameDepth / 2);

  const rightFrame = new THREE.Mesh(
    new THREE.BoxGeometry(frameThickness, 2.5, frameDepth),
    frameMaterial
  );
  rightFrame.position.set(1.5 / 2 + frameThickness / 2, 0, frameDepth / 2);

  group.add(topFrame, bottomFrame, leftFrame, rightFrame);
  group.door = door; // Store reference to clickable door

  return group;
}

const doorA = createDoorFrame(0xff3333); // Red portal
doorA.position.set(-2.5, 1.25, -3);
mainScene.add(doorA);

const doorB = createDoorFrame(0x3333ff); // Blue portal
doorB.position.set(2.5, 1.25, -3);
mainScene.add(doorB);

// ============================================================================
// Main Scene Environment
// ============================================================================

// Floor
const floorGeometry = new THREE.PlaneGeometry(15, 15);
const floorMaterial = new THREE.MeshStandardMaterial({
  color: 0x333333,
  roughness: 0.8,
  metalness: 0.2,
});
const floor = new THREE.Mesh(floorGeometry, floorMaterial);
floor.rotation.x = -Math.PI / 2;
floor.receiveShadow = true;
mainScene.add(floor);

// Lighting
const ambientLight = new THREE.AmbientLight(0xffffff, 0.4);
mainScene.add(ambientLight);

const directionalLight = new THREE.DirectionalLight(0xffffff, 1.5);
directionalLight.position.set(5, 8, 3);
directionalLight.castShadow = true;
mainScene.add(directionalLight);

// Add some context objects in main scene
const pillarGeometry = new THREE.CylinderGeometry(0.3, 0.3, 3, 16);
const pillarMaterial = new THREE.MeshStandardMaterial({
  color: 0x666666,
  roughness: 0.7,
  metalness: 0.3,
});

const pillarLeft = new THREE.Mesh(pillarGeometry, pillarMaterial);
pillarLeft.position.set(-4, 1.5, -1);
mainScene.add(pillarLeft);

const pillarRight = new THREE.Mesh(pillarGeometry, pillarMaterial);
pillarRight.position.set(4, 1.5, -1);
mainScene.add(pillarRight);

// ============================================================================
// Portal Scene A Content (Warm/Red World)
// ============================================================================

const portalLightA = new THREE.PointLight(0xff6633, 2, 50);
portalLightA.position.set(0, 5, 0);
portalSceneA.add(portalLightA);

portalSceneA.add(new THREE.AmbientLight(0xff3333, 0.3));

// Random cubes in warm world
for (let i = 0; i < 15; i++) {
  const size = Math.random() * 0.5 + 0.3;
  const cubeGeometry = new THREE.BoxGeometry(size, size, size);
  const cubeMaterial = new THREE.MeshStandardMaterial({
    color: new THREE.Color().setHSL(Math.random() * 0.1, 0.8, 0.5), // Red-orange hues
    roughness: 0.7,
    metalness: 0.3,
  });
  const cube = new THREE.Mesh(cubeGeometry, cubeMaterial);

  cube.position.set(
    (Math.random() - 0.5) * 8,
    Math.random() * 3 + 0.5,
    (Math.random() - 0.5) * 8
  );
  cube.rotation.set(
    Math.random() * Math.PI,
    Math.random() * Math.PI,
    Math.random() * Math.PI
  );

  portalSceneA.add(cube);
}

// ============================================================================
// Portal Scene B Content (Cool/Blue World)
// ============================================================================

const portalLightB = new THREE.DirectionalLight(0x3366ff, 2);
portalLightB.position.set(-3, 5, 3);
portalSceneB.add(portalLightB);

portalSceneB.add(new THREE.AmbientLight(0x3333ff, 0.3));

// Random spheres in cool world
for (let i = 0; i < 15; i++) {
  const radius = Math.random() * 0.3 + 0.2;
  const sphereGeometry = new THREE.SphereGeometry(radius, 16, 16);
  const sphereMaterial = new THREE.MeshStandardMaterial({
    color: new THREE.Color().setHSL(0.6 + Math.random() * 0.1, 0.8, 0.5), // Blue-cyan hues
    roughness: 0.5,
    metalness: 0.5,
  });
  const sphere = new THREE.Mesh(sphereGeometry, sphereMaterial);

  sphere.position.set(
    (Math.random() - 0.5) * 8,
    Math.random() * 3 + 0.5,
    (Math.random() - 0.5) * 8
  );

  portalSceneB.add(sphere);
}

// ============================================================================
// Camera Animation System
// ============================================================================

let cameraState = "main"; // 'main', 'portalA', 'portalB'
let isAnimating = false;

const defaultCameraPos = mainCamera.position.clone();
const defaultCameraTarget = controls.target.clone();

// Easing function for smooth transitions
function easeOutCubic(x) {
  return 1 - Math.pow(1 - x, 3);
}

let camAnim = null;

function animateCameraTo({ position, target, onComplete }) {
  camAnim = {
    t: 0,
    duration: 1.5, // seconds
    ease: easeOutCubic,
    fromPos: mainCamera.position.clone(),
    toPos: position.clone(),
    fromTarget: controls.target.clone(),
    toTarget: target.clone(),
    onComplete: onComplete || (() => {}),
  };
  isAnimating = true;
  controls.enabled = false;
}

function getPortalCameraPosition(doorGroup) {
  // Position camera close to the door, centered on it
  const doorPos = new THREE.Vector3();
  doorGroup.getWorldPosition(doorPos);

  const doorNormal = new THREE.Vector3(0, 0, 1);
  const doorQuaternion = new THREE.Quaternion();
  doorGroup.getWorldQuaternion(doorQuaternion);
  doorNormal.applyQuaternion(doorQuaternion);

  // Position camera 0.5 units in front of door
  const cameraPos = doorPos.clone().addScaledVector(doorNormal, 0.5);
  return { position: cameraPos, target: doorPos };
}

// ============================================================================
// Raycasting for Click Detection
// ============================================================================

const raycaster = new THREE.Raycaster();
const mouse = new THREE.Vector2();
const clickableDoors = [doorA.door, doorB.door];

window.addEventListener("click", (event) => {
  if (isAnimating) return; // Prevent clicks during animation

  // Convert mouse position to normalized device coordinates
  mouse.x = (event.clientX / window.innerWidth) * 2 - 1;
  mouse.y = -(event.clientY / window.innerHeight) * 2 + 1;

  raycaster.setFromCamera(mouse, mainCamera);
  const intersects = raycaster.intersectObjects(clickableDoors, false);

  if (intersects.length > 0) {
    const clickedDoor = intersects[0].object;

    // Determine which portal was clicked
    if (clickedDoor === doorA.door) {
      enterPortal("portalA", doorA);
    } else if (clickedDoor === doorB.door) {
      enterPortal("portalB", doorB);
    }
  }
});

function enterPortal(portal, doorGroup) {
  cameraState = portal;
  const camTarget = getPortalCameraPosition(doorGroup);

  animateCameraTo({
    ...camTarget,
    onComplete: () => {
      isAnimating = false;
      // Enable portal controls after transition
      if (portal === "portalA") {
        controls.enabled = false;
        controlsA.enabled = true;
      } else if (portal === "portalB") {
        controls.enabled = false;
        controlsB.enabled = true;
      }
    },
  });
}

function returnToMain() {
  if (cameraState === "main" || isAnimating) return;

  cameraState = "main";
  // Disable portal controls
  controlsA.enabled = false;
  controlsB.enabled = false;

  animateCameraTo({
    position: defaultCameraPos,
    target: defaultCameraTarget,
    onComplete: () => {
      isAnimating = false;
      controls.enabled = true;
    },
  });
}

// ESC key to return to main
window.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    returnToMain();
  }
});

// ============================================================================
// Animation Loop
// ============================================================================

let lastTime = performance.now() * 0.001;

renderer.setAnimationLoop(() => {
  const now = performance.now() * 0.001;
  const dt = Math.min(0.1, now - lastTime);
  lastTime = now;

  // Update camera animation
  if (camAnim) {
    camAnim.t += dt / camAnim.duration;
    const a = Math.min(1, camAnim.t);
    const e = camAnim.ease ? camAnim.ease(a) : a;

    mainCamera.position.lerpVectors(camAnim.fromPos, camAnim.toPos, e);
    controls.target.lerpVectors(camAnim.fromTarget, camAnim.toTarget, e);

    if (a >= 1) {
      camAnim.onComplete();
      camAnim = null;
    }
  }

  // Update blend values based on camera state and animation progress
  let targetBlendA = 0;
  let targetBlendB = 0;

  if (cameraState === "portalA") {
    // Start blending when camera animation is > 60% complete
    const animProgress = camAnim ? Math.min(1, camAnim.t) : 1;
    if (animProgress > 0.6) {
      // Remap 0.6-1.0 to 0.0-1.0
      targetBlendA = (animProgress - 0.6) / 0.4;
    }
  } else if (cameraState === "portalB") {
    const animProgress = camAnim ? Math.min(1, camAnim.t) : 1;
    if (animProgress > 0.6) {
      targetBlendB = (animProgress - 0.6) / 0.4;
    }
  }

  // Smooth blend uniform transitions
  blendToA.value = THREE.MathUtils.lerp(blendToA.value, targetBlendA, 0.08);
  blendToB.value = THREE.MathUtils.lerp(blendToB.value, targetBlendB, 0.08);

  // Animate portal scene objects
  portalSceneA.children.forEach((child) => {
    if (child.type === "Mesh" && child.geometry.type === "BoxGeometry") {
      child.rotation.x += 0.01;
      child.rotation.y += 0.01;
    }
  });

  portalSceneB.children.forEach((child) => {
    if (child.type === "Mesh" && child.geometry.type === "SphereGeometry") {
      child.position.y += Math.sin(now * 2 + child.position.x) * 0.002;
    }
  });

  // Update controls (only active when not animating)
  controls.update();
  controlsA.update();
  controlsB.update();

  // Render through PostProcessing
  postProcessing.render();
});

// ============================================================================
// Additional Resize Handler for Portal Cameras
// ============================================================================

window.addEventListener("resize", () => {
  const aspect = window.innerWidth / window.innerHeight;
  portalCameraA.aspect = aspect;
  portalCameraA.updateProjectionMatrix();
  portalCameraB.aspect = aspect;
  portalCameraB.updateProjectionMatrix();
});
