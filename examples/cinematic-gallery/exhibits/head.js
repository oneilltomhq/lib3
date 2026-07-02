// Wave Head — the raymarch-head-wave-displacement piece as a ghost in the
// room. A 256×256×109 CT skull is displaced by a spherical wave in a compute
// kernel (throttled to COMPUTE_HZ), then rendered as an average-intensity
// projection: a translucent hologram the visitor walks around.

import headURL from "@assets/head256x256x109.zip?url";
import { unzipSync } from "three/addons/libs/fflate.module.js";
import { texture3D, uniform } from "three/tsl";
import * as THREE from "three/webgpu";
import {
  buildSphericalWaveCopyKernel,
  averageIntensityProjection,
} from "../../../src/index.js";

const COMPUTE_HZ = 30;
const BOX_SCALE = 1.15;

export async function createHeadExhibit() {
  const data = await new Promise((resolve, reject) => {
    new THREE.FileLoader()
      .setResponseType("arraybuffer")
      .load(headURL, resolve, undefined, reject);
  });
  const zip = unzipSync(new Uint8Array(data));
  const array = new Uint8Array(zip["head256x256x109"].buffer);

  const width = 256;
  const height = 256;
  const depth = 109;

  const sourceTexture = new THREE.Data3DTexture(array, width, height, depth);
  sourceTexture.format = THREE.RedFormat;
  sourceTexture.minFilter = THREE.LinearFilter;
  sourceTexture.magFilter = THREE.LinearFilter;
  sourceTexture.unpackAlignment = 1;
  sourceTexture.needsUpdate = true;

  const storageTexture = new THREE.Storage3DTexture(width, height, depth);
  storageTexture.generateMipmaps = false;
  storageTexture.name = "headWave";

  const waveAmplitude = uniform(0.5);
  const waveSpeed = uniform(2);
  const noiseScale = uniform(0.64);
  const noiseAmplitude = uniform(0.6);
  const intensityScale = uniform(0.25);
  const phaseUniform = uniform(0.0);

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

  const material = new THREE.NodeMaterial();
  material.colorNode = averageIntensityProjection({
    texture: texture3D(storageTexture, null, 0),
    steps: uniform(4),
    intensityScale: uniform(0.2),
  });
  material.side = THREE.BackSide;
  material.transparent = true;
  material.depthWrite = false; // shares a room with other transparents now

  const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), material);
  mesh.scale.set(BOX_SCALE, -BOX_SCALE, BOX_SCALE * (depth / width));

  const group = new THREE.Group();
  group.add(mesh);

  let computeAccum = Infinity; // force a compute on the first frame

  return {
    group,
    radius: (BOX_SCALE * Math.sqrt(2 + (depth / width) ** 2)) / 2,
    update(dt) {
      phaseUniform.value += waveSpeed.value * dt;
      computeAccum += dt;
      group.rotation.y += 0.25 * dt; // slow turntable
    },
    compute(renderer) {
      if (computeAccum < 1 / COMPUTE_HZ) return;
      computeAccum = 0;
      renderer.compute(computeNode);
    },
  };
}
