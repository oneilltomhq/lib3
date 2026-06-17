/**
 * @module lightningEffects
 *
 * Ambient lightning family effects: sheet flash and charge glow.
 * These use their own simpler model, NOT forced through BoltGraph.
 *
 * - Sheet flash: hidden network + distributed glow lobes + scene exposure flash
 * - Charge glow: localized buildup, soft glow clusters, optional tendrils
 */

import * as THREE from 'three/webgpu';
import {
  uniform, Fn, vec3, vec4, float,
  normalize, exp, pow, saturate, sin, cos, mul, add, sub, time,
  positionGeometry, cameraPosition, modelWorldMatrixInverse,
} from 'three/tsl';

// ── Sheet Flash ─────────────────────────────────────────────────────────────

/**
 * Create a sheet flash effect. Renders as a translucent volume that
 * flashes with diffuse illumination — not a sharp bolt, but a broad
 * glow simulating intra-cloud lightning seen through cloud mass.
 *
 * @param {Object} [opts]
 * @param {THREE.Color} [opts.color]
 * @param {number} [opts.glowRadius]
 * @param {number} [opts.glowIntensity]
 * @param {number} [opts.flashDuration]
 * @param {number} [opts.flashFalloff]
 * @returns {{ mesh: THREE.Mesh, uniforms: Object, trigger: () => void, update: (dt: number) => boolean, dispose: () => void }}
 */
export function createSheetFlash(opts = {}) {
  const uColor = uniform(opts.color ?? new THREE.Color(0x8899cc), 'color');
  const uGlowRadius = uniform(opts.glowRadius ?? 0.35);
  const uGlowIntensity = uniform(opts.glowIntensity ?? 2.0);
  const uFlashDuration = uniform(opts.flashDuration ?? 0.15);
  const uFlashFalloff = uniform(opts.flashFalloff ?? 4.0);
  const uFlashProgress = uniform(0.0);
  const uActive = uniform(0.0);
  const uCenter = uniform(new THREE.Vector3(0, 0, 0), 'vec3');

  // Multiple glow lobes to simulate distributed hidden network
  const uLobe1 = uniform(new THREE.Vector3(0.1, 0.05, 0), 'vec3');
  const uLobe2 = uniform(new THREE.Vector3(-0.08, -0.03, 0.06), 'vec3');
  const uLobe3 = uniform(new THREE.Vector3(0.04, -0.07, -0.05), 'vec3');

  const material = new THREE.NodeMaterial();
  material.transparent = true;
  material.depthWrite = false;
  material.blending = THREE.AdditiveBlending;
  material.side = THREE.DoubleSide;

  material.colorNode = Fn(() => {
    const pos = positionGeometry;
    const center = uCenter;

    // Distance from center for each lobe
    const d0 = pos.sub(center).length();
    const d1 = pos.sub(center.add(uLobe1)).length();
    const d2 = pos.sub(center.add(uLobe2)).length();
    const d3 = pos.sub(center.add(uLobe3)).length();

    // Soft glow falloff for each lobe
    const negFalloff = uFlashFalloff.negate();
    const glow0 = exp(d0.div(uGlowRadius).mul(negFalloff));
    const glow1 = exp(d1.div(uGlowRadius.mul(0.7)).mul(negFalloff.mul(1.2)));
    const glow2 = exp(d2.div(uGlowRadius.mul(0.6)).mul(negFalloff.mul(1.5)));
    const glow3 = exp(d3.div(uGlowRadius.mul(0.5)).mul(negFalloff.mul(1.3)));

    // Combine lobes with varying weights
    const totalGlow = glow0.mul(1.0).add(glow1.mul(0.7)).add(glow2.mul(0.5)).add(glow3.mul(0.4));

    // Flash envelope: sharp rise, exponential decay
    const envelope = uActive.mul(
      saturate(float(1.0).sub(uFlashProgress)).pow(2.0)
    );

    const intensity = totalGlow.mul(envelope).mul(uGlowIntensity);
    const color = uColor.mul(intensity);
    const alpha = saturate(intensity.mul(0.6));

    return vec4(color, alpha);
  })();

  const geometry = new THREE.SphereGeometry(0.5, 16, 12);
  const mesh = new THREE.Mesh(geometry, material);
  mesh.frustumCulled = false;

  // State
  let flashTimer = 0;
  let isFlashing = false;

  function trigger(center) {
    flashTimer = 0;
    isFlashing = true;
    uActive.value = 1.0;
    uFlashProgress.value = 0.0;
    if (center) {
      uCenter.value.copy(center);
    }
    // Randomize lobe offsets for variety
    uLobe1.value.set(
      (Math.random() - 0.5) * 0.2,
      (Math.random() - 0.5) * 0.15,
      (Math.random() - 0.5) * 0.15,
    );
    uLobe2.value.set(
      (Math.random() - 0.5) * 0.18,
      (Math.random() - 0.5) * 0.12,
      (Math.random() - 0.5) * 0.18,
    );
    uLobe3.value.set(
      (Math.random() - 0.5) * 0.15,
      (Math.random() - 0.5) * 0.2,
      (Math.random() - 0.5) * 0.12,
    );
  }

  function update(dt) {
    if (!isFlashing) return false;
    flashTimer += dt;
    const duration = uFlashDuration.value;
    uFlashProgress.value = Math.min(1, flashTimer / duration);
    if (flashTimer >= duration) {
      isFlashing = false;
      uActive.value = 0.0;
      return false;
    }
    return true;
  }

  function dispose() {
    geometry.dispose();
    material.dispose();
  }

  return {
    mesh,
    uniforms: {
      color: uColor,
      glowRadius: uGlowRadius,
      glowIntensity: uGlowIntensity,
      flashDuration: uFlashDuration,
      flashFalloff: uFlashFalloff,
    },
    trigger,
    update,
    dispose,
  };
}

// ── Charge Glow ─────────────────────────────────────────────────────────────

/**
 * Create a charge glow effect. Localized soft glow clusters that
 * represent electrical charge buildup. Subtle, pulsing emission
 * without requiring a full channel bolt.
 *
 * @param {Object} [opts]
 * @param {THREE.Color} [opts.color]
 * @param {number} [opts.glowRadius]
 * @param {number} [opts.glowIntensity]
 * @param {number} [opts.pulseSpeed]
 * @returns {{ mesh: THREE.Mesh, uniforms: Object, setActive: (active: boolean) => void, update: (dt: number) => void, dispose: () => void }}
 */
export function createChargeGlow(opts = {}) {
  const uColor = uniform(opts.color ?? new THREE.Color(0x4466aa), 'color');
  const uGlowRadius = uniform(opts.glowRadius ?? 0.25);
  const uGlowIntensity = uniform(opts.glowIntensity ?? 1.5);
  const uPulseSpeed = uniform(opts.pulseSpeed ?? 2.0);
  const uActive = uniform(0.0);
  const uCenter = uniform(new THREE.Vector3(0, 0, 0), 'vec3');

  const material = new THREE.NodeMaterial();
  material.transparent = true;
  material.depthWrite = false;
  material.blending = THREE.AdditiveBlending;
  material.side = THREE.DoubleSide;

  material.colorNode = Fn(() => {
    const pos = positionGeometry;
    const d = pos.sub(uCenter).length();

    // Soft radial falloff
    const falloff = exp(d.div(uGlowRadius).mul(-3.0));

    // Pulsing
    const pulse = sin(time.mul(uPulseSpeed)).mul(0.3).add(0.7);
    // Secondary slow pulse for organic feel
    const pulse2 = sin(time.mul(uPulseSpeed.mul(0.37)).add(1.7)).mul(0.15).add(0.85);

    const intensity = falloff.mul(uActive).mul(uGlowIntensity).mul(pulse).mul(pulse2);
    const color = uColor.mul(intensity);
    const alpha = saturate(intensity.mul(0.5));

    return vec4(color, alpha);
  })();

  const geometry = new THREE.SphereGeometry(0.4, 12, 8);
  const mesh = new THREE.Mesh(geometry, material);
  mesh.frustumCulled = false;

  let active = false;
  let rampTarget = 0;
  let currentRamp = 0;

  function setActive(val) {
    active = val;
    rampTarget = val ? 1.0 : 0.0;
  }

  function setCenter(center) {
    uCenter.value.copy(center);
  }

  function update(dt) {
    // Smooth ramp
    currentRamp += (rampTarget - currentRamp) * Math.min(1, dt * 4);
    uActive.value = currentRamp;
  }

  function dispose() {
    geometry.dispose();
    material.dispose();
  }

  return {
    mesh,
    uniforms: {
      color: uColor,
      glowRadius: uGlowRadius,
      glowIntensity: uGlowIntensity,
      pulseSpeed: uPulseSpeed,
    },
    setActive,
    setCenter,
    update,
    dispose,
  };
}
