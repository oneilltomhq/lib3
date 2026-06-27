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

// Example TSL function (add your own here)
export function exampleTSLFunction(input) {
  const myUniform = uniform(1.0, "float"); // This will get auto-GUI in demos via the plugin
  return input.mul(myUniform); // Simple example
}

// Knot morph nodes moved to their own module to avoid auto-including the uniform
// export * from './knotMorph.js';

// Re-export from other files, e.g.:
// export * from './myOtherFunction.js';

export { SmokeVolume } from "./fluidSim.js";
export { VolumeSmokeNodeMaterial } from "./smokeMaterial.js";
export { ComputeMipAwareBlueNoise } from "./blueNoise.js";
export { createThunderNode, createThunderStateMachine, THUNDER_PRESETS } from './thunder.js';
export {
  lissajousAt,
  lissajousBrightness,
  lissajousBeamColor,
  beamSampleT,
  LISSAJOUS_DEFAULTS,
  LISSAJOUS_PRESETS,
  LISSAJOUS_JOURNEY,
} from './lissajous.js';
