/**
 * @module LightningRibbon
 *
 * Geometry builder + TSL material for rendering BoltGraph channel lightning
 * as camera-facing ribbon strips with core + halo glow.
 *
 * Consumes a BoltGraph without knowing generator internals.
 * Uses Three.js WebGPU + TSL for the material.
 */

import * as THREE from 'three/webgpu';
import {
  uniform, Fn, vec3, vec4, float, attribute,
  cameraPosition, modelWorldMatrix, modelWorldMatrixInverse,
  normalize, cross, dot, abs, mix, exp, pow, saturate, sin, mul,
  positionLocal, time,
} from 'three/tsl';
import { getNode } from './BoltGraph.js';

// ── Geometry ────────────────────────────────────────────────────────────────

/**
 * Build ribbon geometry from a BoltGraph. Each segment becomes a camera-facing
 * quad strip. The geometry includes custom attributes for intensity, radius,
 * branch depth, and phase offset so the shader can modulate appearance.
 *
 * @param {import('./BoltGraph.js').BoltGraph} graph
 * @param {Object} [opts]
 * @param {number} [opts.coreWidth=0.008]
 * @param {number} [opts.haloWidth=0.04]
 * @returns {THREE.BufferGeometry}
 */
export function buildRibbonGeometry(graph, opts = {}) {
  const coreWidth = opts.coreWidth ?? 0.008;
  const haloWidth = opts.haloWidth ?? 0.04;

  const positions = [];
  const normals = [];
  const uvs = [];
  const intensities = [];
  const radii = [];
  const branchDepths = [];
  const phaseOffsets = [];
  const indices = [];

  let vertexOffset = 0;

  for (const seg of graph.segments) {
    const na = getNode(graph, seg.a);
    const nb = getNode(graph, seg.b);
    if (!na || !nb) continue;

    const pa = na.position;
    const pb = nb.position;

    // Map from [0,1]³ to [-0.5, 0.5]³ local space
    const ax = pa.x - 0.5, ay = pa.y - 0.5, az = pa.z - 0.5;
    const bx = pb.x - 0.5, by = pb.y - 0.5, bz = pb.z - 0.5;

    // Direction along segment
    const dx = bx - ax, dy = by - ay, dz = bz - az;
    const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (len < 1e-6) continue;

    // Use a fixed up vector for consistent ribbon orientation
    // The actual camera-facing is done in the shader
    const upX = 0, upY = 0, upZ = 1;
    // Cross product: dir × up
    let nx = dy * upZ - dz * upY;
    let ny = dz * upX - dx * upZ;
    let nz = dx * upY - dy * upX;
    let nLen = Math.sqrt(nx * nx + ny * ny + nz * nz);
    if (nLen < 1e-6) {
      // Fallback perpendicular
      nx = 1; ny = 0; nz = 0;
      nLen = 1;
    }
    nx /= nLen; ny /= nLen; nz /= nLen;

    const totalWidth = (coreWidth + haloWidth) * seg.radius;

    // 4 vertices per segment: 2 at start, 2 at end (extruded along normal)
    // Left-start, right-start, left-end, right-end
    positions.push(
      ax - nx * totalWidth, ay - ny * totalWidth, az - nz * totalWidth,
      ax + nx * totalWidth, ay + ny * totalWidth, az + nz * totalWidth,
      bx - nx * totalWidth, by - ny * totalWidth, bz - nz * totalWidth,
      bx + nx * totalWidth, by + ny * totalWidth, bz + nz * totalWidth,
    );

    normals.push(
      nx, ny, nz,
      nx, ny, nz,
      nx, ny, nz,
      nx, ny, nz,
    );

    uvs.push(
      0, 0,
      1, 0,
      0, 1,
      1, 1,
    );

    const intVal = seg.intensity;
    const radVal = seg.radius;
    const bdVal = seg.branchDepth;
    const poVal = seg.phaseOffset;

    for (let i = 0; i < 4; i++) {
      intensities.push(intVal);
      radii.push(radVal);
      branchDepths.push(bdVal);
      phaseOffsets.push(poVal);
    }

    indices.push(
      vertexOffset, vertexOffset + 1, vertexOffset + 2,
      vertexOffset + 1, vertexOffset + 3, vertexOffset + 2,
    );
    vertexOffset += 4;
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setAttribute('aIntensity', new THREE.Float32BufferAttribute(intensities, 1));
  geometry.setAttribute('aRadius', new THREE.Float32BufferAttribute(radii, 1));
  geometry.setAttribute('aBranchDepth', new THREE.Float32BufferAttribute(branchDepths, 1));
  geometry.setAttribute('aPhaseOffset', new THREE.Float32BufferAttribute(phaseOffsets, 1));
  geometry.setIndex(indices);

  return geometry;
}

// ── Material ────────────────────────────────────────────────────────────────

/**
 * Create the TSL ribbon material for lightning bolts.
 *
 * @param {Object} [opts]
 * @param {THREE.Color} [opts.coreColor]
 * @param {THREE.Color} [opts.haloColor]
 * @param {number} [opts.coreIntensity]
 * @param {number} [opts.haloIntensity]
 * @param {number} [opts.flickerFrequency]
 * @param {number} [opts.flickerDepth]
 * @returns {{ material: THREE.NodeMaterial, uniforms: Object }}
 */
export function createRibbonMaterial(opts = {}) {
  const uCoreColor = uniform(opts.coreColor ?? new THREE.Color(0xeef4ff), 'color');
  const uHaloColor = uniform(opts.haloColor ?? new THREE.Color(0x6688ff), 'color');
  const uCoreIntensity = uniform(opts.coreIntensity ?? 3.0);
  const uHaloIntensity = uniform(opts.haloIntensity ?? 1.2);
  const uFlickerFreq = uniform(opts.flickerFrequency ?? 30.0);
  const uFlickerDepth = uniform(opts.flickerDepth ?? 0.3);
  const uReveal = uniform(1.0); // 0→1 for leader propagation
  const uBrightness = uniform(1.0); // overall brightness multiplier
  const uFade = uniform(1.0); // 1→0 for fade out

  const material = new THREE.NodeMaterial();
  material.transparent = true;
  material.depthWrite = false;
  material.blending = THREE.AdditiveBlending;
  material.side = THREE.DoubleSide;

  const colorNode = Fn(() => {
    const uv = attribute('uv', 'vec2');
    const intensity = attribute('aIntensity', 'float');
    const branchDepth = attribute('aBranchDepth', 'float');
    const phaseOffset = attribute('aPhaseOffset', 'float');

    // Cross-section profile: bright core, falloff to halo
    const centerDist = abs(uv.x.sub(0.5)).mul(2.0); // 0 at center, 1 at edge

    // Core: sharp bright center
    const coreFalloff = float(1.0).sub(centerDist).pow(4.0);
    const core = coreFalloff.mul(uCoreIntensity);

    // Halo: softer outer glow
    const haloFalloff = exp(centerDist.mul(-3.0));
    const halo = haloFalloff.mul(uHaloIntensity);

    // Reveal mask (for leader progressive propagation)
    const revealMask = saturate(uReveal.sub(phaseOffset).mul(8.0));

    // Flicker
    const flicker = float(1.0).sub(
      uFlickerDepth.mul(
        sin(time.mul(uFlickerFreq).add(phaseOffset.mul(20.0))).mul(0.5).add(0.5)
      )
    );

    // Branch depth dimming
    const depthDim = pow(float(0.6), branchDepth);

    // Final color blend
    const coreContrib = uCoreColor.mul(core);
    const haloContrib = uHaloColor.mul(halo);
    const color = coreContrib.add(haloContrib);

    const totalIntensity = intensity.mul(depthDim).mul(flicker).mul(revealMask).mul(uBrightness).mul(uFade);
    const alpha = saturate(core.add(halo).mul(0.8)).mul(totalIntensity);

    return vec4(color.mul(totalIntensity), alpha);
  })();

  material.colorNode = colorNode;

  const uniforms = {
    coreColor: uCoreColor,
    haloColor: uHaloColor,
    coreIntensity: uCoreIntensity,
    haloIntensity: uHaloIntensity,
    flickerFrequency: uFlickerFreq,
    flickerDepth: uFlickerDepth,
    reveal: uReveal,
    brightness: uBrightness,
    fade: uFade,
  };

  return { material, uniforms };
}

// ── Mesh factory ────────────────────────────────────────────────────────────

/**
 * Create a complete lightning ribbon mesh from a BoltGraph.
 *
 * @param {import('./BoltGraph.js').BoltGraph} graph
 * @param {Object} [materialOpts] - Options for createRibbonMaterial
 * @param {Object} [geometryOpts] - Options for buildRibbonGeometry
 * @returns {{ mesh: THREE.Mesh, uniforms: Object, geometry: THREE.BufferGeometry, material: THREE.NodeMaterial }}
 */
export function createLightningMesh(graph, materialOpts = {}, geometryOpts = {}) {
  const geometry = buildRibbonGeometry(graph, geometryOpts);
  const { material, uniforms } = createRibbonMaterial(materialOpts);

  const mesh = new THREE.Mesh(geometry, material);
  mesh.frustumCulled = false;

  return { mesh, uniforms, geometry, material };
}
