// src/index.js
import { uniform, attribute, mix, Fn, positionGeometry } from "three/tsl"; // Example import
export {
  sphericalWaveDisplacement,
  displacedTexCoord,
  buildSphericalWaveCopyKernel,
  simplexNoise3,
} from "./waves.js";
export { knotMorphPosition } from "./knotMorph.js";
export { adaptiveRaymarch, averageIntensityProjection } from "./raymarch.js";
export {
  METABALL_DEBUG_MODES,
  smoothMinSphereSdf,
  estimateSdfNormal,
  raymarchSdf,
  RaymarchedMetaballs,
} from "./metaballs.js";
// Generic journey machinery (the lissajous block below re-exports the shared
// camera helpers; lissajous's key-based lerpChannel keeps that name here — the
// spec-based generic lives on the ./journey subpath).
export {
  lerpValues,
  EASES,
  resolveStop,
  resolveJourney,
  lfo,
  drift,
  modulate,
  createJourneyDriver,
} from "./journey.js";

// Example TSL function (add your own here)
export function exampleTSLFunction(input) {
  const myUniform = uniform(1.0, "float"); // This will get auto-GUI in demos via the plugin
  return input.mul(myUniform); // Simple example
}

// Knot morph nodes moved to their own module to avoid auto-including the uniform
// export * from './knotMorph.js';

// Re-export from other files, e.g.:
// export * from './myOtherFunction.js';

export { Rack, bindUniform, bindKey, localStorageAdapter } from "./rack.js";

export {
  TslSource,
  registerTransform,
  getTransforms,
  compile as compileHydraChain,
  chainColorNode,
  createSourceApi,
  HydraOutput,
  HydraSynth,
} from "./hydra/index.js";

export { SmokeVolume } from "./fluidSim.js";
export { VolumeSmokeNodeMaterial } from "./smokeMaterial.js";
export { ComputeMipAwareBlueNoise } from "./blueNoise.js";
export { createThunderNode, createThunderStateMachine, THUNDER_PRESETS } from './thunder.js';
export {
  bakeCumulonimbusTexture,
  bakeDetailNoiseTexture,
  NimbusCloudMaterial,
  generateBoltPaths,
  LightningBoltMesh,
  StormDirector,
} from './nimbus/index.js';
export {
  lissajousAt,
  lissajousBrightness,
  lissajousBeamColor,
  beamSampleT,
  LISSAJOUS_DEFAULTS,
  LISSAJOUS_PRESETS,
  LISSAJOUS_JOURNEY,
  LISSAJOUS_CHANNELS,
  LISSAJOUS_CAMERA_DEFAULT,
  lerpChannel,
  lerpLissajous,
  cameraPosition,
  cameraToSpherical,
  lerpCamera,
  resolveLissajousStop,
  resolveLissajousJourney,
} from './lissajous.js';
