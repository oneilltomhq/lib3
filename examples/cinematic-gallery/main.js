import { setup } from "../_shared/setup.js";
import headURL from "@assets/head256x256x109.zip?url";
import { unzipSync } from "three/addons/libs/fflate.module.js";
import { texture3D, uniform, pass, color, screenUV } from "three/tsl";
import { knotMorphPosition } from "../../src/knotMorph.js";
import {
  buildSphericalWaveCopyKernel,
  averageIntensityProjection,
} from "../../src/index.js";

// Choose cinematic aspect based on viewport orientation: 16:9 (landscape) or 9:16 (portrait)
function getCinematicAspect(w, h) {
  return w >= h ? 16 / 9 : 9 / 16;
}
let childAspect = getCinematicAspect(window.innerWidth, window.innerHeight);

// Parent (main) scene and camera
const { THREE, renderer, camera: parentCamera, controls } = setup({ fov: 60 });
parentCamera.position.set(0, 1.25, 2.5);
controls.update();

const parentScene = new THREE.Scene();

// Child A (offscreen) scene and camera - Raymarch Head
const childScene = new THREE.Scene();
const childCamera = new THREE.PerspectiveCamera(60, childAspect, 0.05, 1000);
childCamera.position.set(0.0, 0.0, 1.2);
childCamera.updateProjectionMatrix();

// Child B (offscreen) scene and camera - Knot Morph
const childScene2 = new THREE.Scene();
const childCamera2 = new THREE.PerspectiveCamera(60, childAspect, 0.05, 1000);
childCamera2.position.set(0, 0, 5);
childCamera2.updateProjectionMatrix();

renderer.setClearColor(0x000000);
controls.target.set(0, 1.0, 0);
controls.update();

// Helpers
function computeScreenDimensions(aspect, longSide) {
  const width = aspect >= 1 ? longSide : longSide * aspect;
  const height = aspect >= 1 ? longSide / aspect : longSide;
  return { width, height };
}

function createPortalPlane({
  width,
  height,
  scene,
  camera,
  uvMode = "screen",
}) {
  const geo = new THREE.PlaneGeometry(width, height);
  const mat = new THREE.MeshBasicNodeMaterial();
  mat.colorNode =
    uvMode === "screen"
      ? pass(scene, camera).context({ getUV: () => screenUV })
      : pass(scene, camera).getTextureNode();
  mat.transparent = false;
  const mesh = new THREE.Mesh(geo, mat);
  mesh.material.side = THREE.DoubleSide;
  mesh.renderOrder = 1;
  return mesh;
}

function createFrame({
  width,
  height,
  thickness = 0.06,
  depth = 0.05,
  material,
}) {
  const group = new THREE.Group();
  const horizLen = width + thickness * 2;
  const top = new THREE.Mesh(
    new THREE.BoxGeometry(horizLen, thickness, depth),
    material
  );
  const bot = new THREE.Mesh(
    new THREE.BoxGeometry(horizLen, thickness, depth),
    material
  );
  const left = new THREE.Mesh(
    new THREE.BoxGeometry(thickness, height, depth),
    material
  );
  const right = new THREE.Mesh(
    new THREE.BoxGeometry(thickness, height, depth),
    material
  );
  top.position.set(0, height / 2 + thickness / 2, depth / 2);
  bot.position.set(0, -height / 2 - thickness / 2, depth / 2);
  left.position.set(-width / 2 - thickness / 2, 0, depth / 2);
  right.position.set(width / 2 + thickness / 2, 0, depth / 2);
  group.add(top, bot, left, right);
  return group;
}

// Load volumetric dataset and set up compute + child scene volume render
new THREE.FileLoader()
  .setResponseType("arraybuffer")
  .load(headURL, async function (data) {
    const zip = unzipSync(new Uint8Array(data));
    const array = new Uint8Array(zip["head256x256x109"].buffer);

    const width = 256;
    const height = 256;
    const depth = 109;

    // Source texture
    const sourceTexture = new THREE.Data3DTexture(array, width, height, depth);
    sourceTexture.format = THREE.RedFormat;
    sourceTexture.minFilter = THREE.LinearFilter;
    sourceTexture.magFilter = THREE.LinearFilter;
    sourceTexture.unpackAlignment = 1;
    sourceTexture.needsUpdate = true;

    // Destination storage texture
    const storageTexture = new THREE.Storage3DTexture(width, height, depth);
    storageTexture.generateMipmaps = false;
    storageTexture.name = "headWave";

    // Uniforms for wave compute
    const waveAmplitude = uniform(0.5);
    const waveSpeed = uniform(2);
    const noiseScale = uniform(0.64);
    const noiseAmplitude = uniform(0.6);
    const intensityScale = uniform(0.25);
    const phaseUniform = uniform(0.0);

    // Build compute kernel once, feed uniforms each frame
    const waveKernel = buildSphericalWaveCopyKernel({
      width,
      height,
      depth,
      storageTexture,
      sourceTextureNode: texture3D(sourceTexture, null, 0),
      waveAmplitude,
      noiseScale,
      noiseAmplitude,
      intensityScale,
      phase: phaseUniform,
    });

    const computeNode = waveKernel()
      .compute(width * height * depth)
      .setName("copyHead3DDisplaced");

    await renderer.init();
    await renderer.computeAsync(computeNode);

    // Raymarch material in child scene
    const steps = uniform(4);
    const intensityScaleView = uniform(0.2);

    const childMaterial = new THREE.NodeMaterial();
    childMaterial.colorNode = averageIntensityProjection({
      texture: texture3D(storageTexture, null, 0),
      steps,
      intensityScale: intensityScaleView,
    });
    childMaterial.side = THREE.BackSide;
    childMaterial.transparent = true;

    const childMesh = new THREE.Mesh(
      new THREE.BoxGeometry(1, 1, 1),
      childMaterial
    );
    childMesh.scale.set(1, -1, depth / width);
    childScene.add(childMesh);

    // Screen and frame creation via helpers
    const longSide = 1.6;
    const { width: initialWidth, height: initialHeight } =
      computeScreenDimensions(childAspect, longSide);

    const screen = createPortalPlane({
      width: initialWidth,
      height: initialHeight,
      scene: childScene,
      camera: childCamera,
      uvMode: "screen",
    });
    screen.position.set(0, 1.0, 0);
    parentScene.add(screen);

    const frameDepth = 0.05;
    const frameThickness = 0.06;
    const frameMat = new THREE.MeshStandardMaterial({
      color: 0x222222,
      roughness: 1,
    });
    let frameGroup = createFrame({
      width: initialWidth,
      height: initialHeight,
      thickness: frameThickness,
      depth: frameDepth,
      material: frameMat,
    });
    frameGroup.position.copy(screen.position);
    parentScene.add(frameGroup);

    const screen2 = createPortalPlane({
      width: initialWidth,
      height: initialHeight,
      scene: childScene2,
      camera: childCamera2,
      uvMode: "mesh",
    });
    screen2.position.set(2.0, 1.0, 0);
    parentScene.add(screen2);

    let frameGroup2 = createFrame({
      width: initialWidth,
      height: initialHeight,
      thickness: frameThickness,
      depth: frameDepth,
      material: frameMat,
    });
    frameGroup2.position.copy(screen2.position);
    parentScene.add(frameGroup2);

    // Camera state management (default, fit to screen A, fit to screen B)
    const defaultCamPos = parentCamera.position.clone();
    const defaultTarget = controls.target.clone();

    function fitToPlane(mesh, options = {}) {
      const { cover = false, overscan = 1.02 } = options; // cover=true = fill like CSS background-size: cover
      const params = mesh.geometry.parameters || { width: 1, height: 1 };
      const rectWidth = (params.width || 1) * (mesh.scale?.x || 1);
      const rectHeight = (params.height || 1) * (mesh.scale?.y || 1);

      const center = new THREE.Vector3();
      mesh.getWorldPosition(center);

      const normal = new THREE.Vector3(0, 0, 1);
      const q = new THREE.Quaternion();
      mesh.getWorldQuaternion(q);
      normal.applyQuaternion(q);

      const vFov = (parentCamera.fov * Math.PI) / 180;
      const fovH = 2 * Math.atan(Math.tan(vFov / 2) * parentCamera.aspect);
      const distH = rectHeight / 2 / Math.tan(vFov / 2);
      const distW = rectWidth / 2 / Math.tan(fovH / 2);
      // contain (fit): max; cover (fill): min
      let distance = cover ? Math.min(distH, distW) : Math.max(distH, distW);
      // For cover, move slightly closer to ensure no border shows; for contain, a tiny margin could be applied if desired
      distance = cover ? distance / overscan : distance;

      // Place the camera on the same side of the plane as it currently is to avoid flips
      const toCamera = new THREE.Vector3().subVectors(
        parentCamera.position,
        center
      );
      const side = Math.sign(toCamera.dot(normal)) || 1; // +1 if in front (along normal), -1 if behind
      const position = new THREE.Vector3()
        .copy(center)
        .addScaledVector(normal, side * distance);
      const target = center.clone();
      return { position, target };
    }

    let camAnim = null;
    // Easing function for camera transitions (snappy, natural feel)
    function easeOutCubic(x) {
      return 1 - Math.pow(1 - x, 3);
    }

    function animateCameraTo({ position, target }, duration = 0.5) {
      camAnim = {
        t: 0,
        duration,
        ease: easeOutCubic,
        fromPos: parentCamera.position.clone(),
        toPos: position.clone(),
        fromTarget: controls.target.clone(),
        toTarget: target.clone(),
      };
    }

    const camStates = [
      () => ({ position: defaultCamPos, target: defaultTarget }),
      () => fitToPlane(screen, { cover: true, overscan: 1.06 }),
      () => fitToPlane(screen2, { cover: true, overscan: 1.06 }),
    ];

    function setCameraState(index) {
      const state = camStates[index % camStates.length]();
      animateCameraTo(state);
    }

    let cameraStateIndex = 0; // 0 default, 1 screen A, 2 screen B
    function cycleCameraState() {
      cameraStateIndex = (cameraStateIndex + 1) % 3;
      setCameraState(cameraStateIndex);
    }
    function cycleCameraStateBackward() {
      cameraStateIndex = (cameraStateIndex + 3 - 1) % 3;
      setCameraState(cameraStateIndex);
    }

    // Input binding: spacebar to cycle; shift+space to cycle backward
    window.addEventListener("keydown", (e) => {
      if (e.code === "Space") {
        e.preventDefault();
        if (e.shiftKey) cycleCameraStateBackward();
        else cycleCameraState();
      }
    });

    // Child B: Knot morph content
    const startGeo = new THREE.TorusKnotGeometry(1, 0.4, 128, 32, 2, 3);
    const targetGeo = new THREE.TorusKnotGeometry(1, 0.4, 128, 32, 3, 5);
    const targetPositions = targetGeo.getAttribute("position").array;
    startGeo.setAttribute(
      "targetPosition",
      new THREE.BufferAttribute(targetPositions, 3)
    );
    const knotMat = new THREE.MeshBasicNodeMaterial({
      wireframe: true,
      transparent: true,
    });
    knotMat.positionNode = knotMorphPosition();
    knotMat.colorNode = color(0x00ff00);
    const knotMesh = new THREE.Mesh(startGeo, knotMat);
    childScene2.add(knotMesh);

    // Fit knot inside childCamera2 frustum and center it
    startGeo.computeBoundingSphere();
    const knotRadius = startGeo.boundingSphere?.radius || 1.5;
    const vFov = (childCamera2.fov * Math.PI) / 180;
    const fitHeightDistance = knotRadius / Math.tan(vFov / 2);
    const fitWidthDistance = (knotRadius * childAspect) / Math.tan(vFov / 2);
    const distance = Math.max(fitHeightDistance, fitWidthDistance) * 1.2; // margin
    childCamera2.position.set(0, 0, distance);
    childCamera2.lookAt(0, 0, 0);

    // Simple cinema-like stand for context
    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(6, 6),
      new THREE.MeshStandardMaterial({ color: 0x111111, roughness: 1 })
    );
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = 0;
    parentScene.add(floor);

    const light = new THREE.DirectionalLight(0xffffff, 1.0);
    light.position.set(1, 2, 1);
    parentScene.add(light);
    parentScene.add(new THREE.AmbientLight(0xffffff, 0.2));

    // Animate child camera along a spiral around the head
    let lastTime = performance.now() * 0.001;
    let accum = 0;
    const computeInterval = 1 / 30; // 30 Hz compute
    let computeInFlight = false;

    renderer.setAnimationLoop(async () => {
      const now = performance.now() * 0.001;
      const dt = Math.min(0.1, now - lastTime);
      lastTime = now;

      // Integrate phase with real dt
      phaseUniform.value += waveSpeed.value * dt;

      // Throttle compute to ~30Hz
      accum += dt;
      if (accum >= computeInterval && !computeInFlight) {
        accum -= computeInterval;
        computeInFlight = true;
        await renderer.computeAsync(computeNode).finally(() => {
          computeInFlight = false;
        });
      }

      // Spiral motion for child camera
      const radius = 1.25;
      const angularSpeed = 0.4; // rad/s
      const elevationSpeed = 0.15; // cycles/s
      const angle = now * angularSpeed;
      const y = Math.sin(now * elevationSpeed) * 0.2;
      childCamera.position.set(
        Math.cos(angle) * radius,
        y,
        Math.sin(angle) * radius
      );
      childCamera.lookAt(0, 0, 0);

      // Child B animation (knot morph)
      const mixFactor = Math.abs(Math.sin(now * 0.5));
      knotMat.positionNode = knotMorphPosition({ mixFactor });
      knotMesh.rotation.y += 0.01;

      // Camera animation LERP (position and target)
      if (camAnim) {
        camAnim.t += dt / camAnim.duration;
        const a = Math.min(1, camAnim.t);
        const e = camAnim.ease ? camAnim.ease(a) : a;
        parentCamera.position.lerpVectors(camAnim.fromPos, camAnim.toPos, e);
        controls.target.lerpVectors(camAnim.fromTarget, camAnim.toTarget, e);
        if (a >= 1) camAnim = null;
      }

      // Render parent scene with user controls
      controls.update();
      renderer.render(parentScene, parentCamera);
    });

    // Update layout for aspect/orientation changes
    function updateLayout() {
      childAspect = getCinematicAspect(window.innerWidth, window.innerHeight);

      const dims = computeScreenDimensions(childAspect, longSide);
      const newWidth = dims.width;
      const newHeight = dims.height;

      // Update child cameras
      childCamera.aspect = childAspect;
      childCamera.updateProjectionMatrix();
      childCamera2.aspect = childAspect;
      childCamera2.updateProjectionMatrix();

      // Update portal screens by scaling relative to initial geometry size
      screen.scale.set(newWidth / initialWidth, newHeight / initialHeight, 1);
      screen2.scale.set(newWidth / initialWidth, newHeight / initialHeight, 1);

      // Rebuild frames to keep thickness/depth consistent
      parentScene.remove(frameGroup);
      frameGroup = createFrame({
        width: newWidth,
        height: newHeight,
        thickness: frameThickness,
        depth: frameDepth,
        material: frameMat,
      });
      frameGroup.position.copy(screen.position);
      parentScene.add(frameGroup);

      parentScene.remove(frameGroup2);
      frameGroup2 = createFrame({
        width: newWidth,
        height: newHeight,
        thickness: frameThickness,
        depth: frameDepth,
        material: frameMat,
      });
      frameGroup2.position.copy(screen2.position);
      parentScene.add(frameGroup2);

      // Re-fit knot camera distance for new aspect
      const vFov = (childCamera2.fov * Math.PI) / 180;
      const fitH = knotRadius / Math.tan(vFov / 2);
      const fitW = (knotRadius * childAspect) / Math.tan(vFov / 2);
      const dist = Math.max(fitH, fitW) * 1.2;
      childCamera2.position.set(0, 0, dist);
      childCamera2.lookAt(0, 0, 0);
    }

    // Additional resize handling for layout updates
    window.addEventListener("resize", updateLayout);
  });
