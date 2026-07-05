/**
 * @module nimbus
 *
 * Volumetric storm cloud + lightning for Three.js WebGPU / TSL.
 */

export { bakeCumulonimbusTexture, bakeDetailNoiseTexture } from './cloudTexture.js';
export { NimbusCloudMaterial } from './cloudMaterial.js';
export { generateBoltPaths, LightningBoltMesh } from './bolt.js';
export { StormDirector } from './storm.js';
