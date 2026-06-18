import { setup } from "../_shared/setup.js";
import headURL from "@assets/head256x256x109.zip?url";
import { Inspector } from "three/addons/inspector/Inspector.js";
import { unzipSync } from "three/addons/libs/fflate.module.js";
import { texture3D, uniform } from "three/tsl";
import {
  buildSphericalWaveCopyKernel,
  averageIntensityProjection,
} from "../../src/index.js";

const { THREE, renderer, scene, camera } = setup({ fov: 75 });
camera.position.z = 1;
renderer.setClearColor(0x000000);
renderer.inspector = new Inspector();

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
    const waveAmplitude = uniform(1.32);
    const waveSpeed = uniform(2);
    const noiseScale = uniform(2.5);
    const noiseAmplitude = uniform(1.22);
    const intensityScale = uniform(0.22);
    const displacementScale = uniform(0.01);
    const timeUniform = uniform(0.0);
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
      displacementScale,
      phase: phaseUniform,
    });

    const computeNode = waveKernel()
      .compute(width * height * depth)
      .setName("copyHead3DDisplaced");

    await renderer.init();
    await renderer.computeAsync(computeNode);

    const steps = uniform(4);
    const intensityScaleView = uniform(1);

    const material = new THREE.NodeMaterial();
    material.colorNode = averageIntensityProjection({
      texture: texture3D(storageTexture, null, 0),
      steps,
      intensityScale: intensityScaleView,
    });
    material.side = THREE.BackSide;
    material.transparent = true;

    const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), material);
    mesh.scale.set(1, -1, depth / width);
    scene.add(mesh);

    // Inspector GUI
    const gui = renderer.inspector.createParameters("Wave Displacement");
    gui.add(waveAmplitude, "value", 0.0, 2.0, 0.02).name("waveAmplitude");
    gui.add(waveSpeed, "value", 0.0, 5.0, 0.05).name("waveSpeed");
    gui.add(noiseScale, "value", 0.1, 4.0, 0.04).name("noiseScale");
    gui.add(noiseAmplitude, "value", 0.0, 2.0, 0.02).name("noiseAmplitude");
    gui
      .add(displacementScale, "value", 0.0, 0.2, 0.005)
      .name("displacementScale");
    gui
      .add(intensityScale, "value", 0.0, 2.0, 0.02)
      .name("intensityScale (compute)");
    gui.add(steps, "value", 1, 5, 0.05).name("steps");
    gui
      .add(intensityScaleView, "value", 0.1, 5.0, 0.1)
      .name("intensityScale (view)");

    let lastTime = performance.now() * 0.001;
    let accum = 0;
    const computeInterval = 1 / 30; // 30 Hz compute
    renderer.setAnimationLoop(async () => {
      const now = performance.now() * 0.001;
      const dt = Math.min(0.1, now - lastTime); // clamp to avoid spikes
      lastTime = now;
      timeUniform.value = now;

      // Integrate phase with real dt
      phaseUniform.value += waveSpeed.value * dt;

      // Throttle compute to 30Hz
      accum += dt;
      if (accum >= computeInterval) {
        accum -= computeInterval;
        await renderer.computeAsync(computeNode);
      }

      renderer.render(scene, camera);
    });
  });
