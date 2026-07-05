/**
 * @module nimbus/cloudMaterial
 *
 * Volumetric storm-cloud raymarching material (Three.js WebGPU / TSL).
 *
 * Renders a baked density field inside a unit cube [−0.5, +0.5]³:
 *  - Beer-Lambert extinction with short shadow march toward the moon/sun
 *  - Henyey-Greenstein phase for silver-lining
 *  - height-graded ambient (sky above, dark below)
 *  - powder darkening in thick cores
 *  - N internal point "flash" lights (lightning) with a cheap occlusion
 *    sample toward each light, so flashes reveal cloud structure
 *
 * Mesh MUST be a unit cube scaled via its world matrix. Renders BackSide.
 */

import * as THREE from 'three/webgpu';
import {
  uniform, varying, vec2, vec3, vec4, float, int, Fn, Loop, Break, If,
  texture3D, positionGeometry, modelWorldMatrixInverse, cameraPosition,
  normalize, min, max, dot, exp, pow, mix, saturate, smoothstep, fract, sin,
  screenCoordinate,
} from 'three/tsl';

const TRANSMITTANCE_CUTOFF = float(0.015);

/** Ray–AABB intersection for the unit box. Returns vec2(tNear, tFar). */
const hitBox = /*@__PURE__*/ Fn(({ orig, dir }) => {
  const invDir = dir.reciprocal();
  const t0 = vec3(-0.5).sub(orig).mul(invDir);
  const t1 = vec3(0.5).sub(orig).mul(invDir);
  const tMin = min(t0, t1);
  const tMax = max(t0, t1);
  return vec2(max(tMin.x, max(tMin.y, tMin.z)), min(tMax.x, min(tMax.y, tMax.z)));
});

const henyeyGreenstein = /*@__PURE__*/ Fn(({ cosTheta, g }) => {
  const g2 = g.mul(g);
  return float(0.0795774715)
    .mul(float(1.0).sub(g2))
    .div(pow(float(1.0).add(g2).sub(g.mul(2.0).mul(cosTheta)), 1.5).add(1e-4));
});

/**
 * Storm-cloud volume material.
 *
 * Flash lights are exposed via `material.flashLights` — an array of
 * `{ position: uniform(vec3 in uvw space), color: uniform(color), intensity: uniform(float) }`
 * driven externally (see storm.js).
 */
export class NimbusCloudMaterial extends THREE.NodeMaterial {
  static get type() { return 'NimbusCloudMaterial'; }

  /**
   * @param {object} opts
   * @param {THREE.Data3DTexture} opts.densityTexture — baked cloud density (.r)
   * @param {THREE.Data3DTexture} [opts.detailTexture] — tiling detail noise (see bakeDetailNoiseTexture); adds close-range wisp/clump structure
   * @param {number} [opts.flashLightCount=3]
   * @param {object} [opts.*] — see uniforms below
   */
  constructor(opts = {}) {
    super();

    this.isNimbusCloudMaterial = true;
    this.transparent = true;
    this.depthWrite = false;
    this.side = THREE.BackSide;
    this.forceSinglePass = true;

    this._densityTex = texture3D(opts.densityTexture, null, 0);
    this._detailTex = opts.detailTexture ? texture3D(opts.detailTexture, null, 0) : null;

    const u = (v, fallback) => (v != null && v.isNode ? v : uniform(v != null ? v : fallback));

    this.uSteps          = u(opts.steps, 110);
    this.uDensityScale   = u(opts.densityScale, 34.0);
    this.uSunDir         = u(opts.sunDir, new THREE.Vector3(-0.4, 0.75, 0.5));
    this.uSunColor       = u(opts.sunColor, new THREE.Color(0.5, 0.58, 0.85));
    this.uSunStrength    = u(opts.sunStrength, 0.75);
    this.uShadowSteps    = u(opts.shadowSteps, 5);
    this.uShadowLength   = u(opts.shadowLength, 0.28);
    this.uAmbientTop     = u(opts.ambientTop, new THREE.Color(0.07, 0.08, 0.125));
    this.uAmbientBottom  = u(opts.ambientBottom, new THREE.Color(0.008, 0.009, 0.016));
    this.uAnisotropy     = u(opts.anisotropy, 0.45);
    this.uPowder         = u(opts.powder, 0.6);
    this.uFlashFalloff   = u(opts.flashFalloff, 42.0);  // 1/radius² scale for flash lights
    this.uFlashOcclusion = u(opts.flashOcclusion, 9.0); // density occlusion between light & sample
    this.uDetailScale    = u(opts.detailScale, 3.5);    // detail tiles per volume
    this.uDetailStrength = u(opts.detailStrength, 0.65);
    this.uWind           = u(opts.wind, new THREE.Vector3(0.02, -0.006, 0.014));
    this.uTime           = u(opts.time, 0);             // advance per frame for detail drift

    // Internal flash lights (fixed count, unrolled in the shader).
    const count = opts.flashLightCount ?? 3;
    this.flashLights = [];
    for (let i = 0; i < count; i++) {
      this.flashLights.push({
        position: uniform(new THREE.Vector3(0.5, 0.5, 0.5)),
        color: uniform(new THREE.Color(0.72, 0.78, 1.0)),
        intensity: uniform(0),
      });
    }

    this.outputNode = this._buildNode();
  }

  _buildNode() {
    const densityTex = this._densityTex;
    const detailTex = this._detailTex;
    const {
      uSteps, uDensityScale, uSunDir, uSunColor, uSunStrength, uShadowSteps,
      uShadowLength, uAmbientTop, uAmbientBottom, uAnisotropy, uPowder,
      uFlashFalloff, uFlashOcclusion, uDetailScale, uDetailStrength, uWind, uTime,
    } = this;
    const flashLights = this.flashLights;

    const sampleDensity = /*@__PURE__*/ Fn(({ uvw }) => {
      return densityTex.sample(uvw).r;
    });

    // Tiling detail samples (fract keeps wrapping sampler-independent).
    // Two octaves: coarse billow structure + fine close-range grain.
    const sampleDetail = detailTex
      ? /*@__PURE__*/ Fn(({ uvw }) => {
          return detailTex.sample(fract(uvw.mul(uDetailScale).add(uWind.mul(uTime))));
        })
      : null;
    const sampleDetailFine = detailTex
      ? /*@__PURE__*/ Fn(({ uvw }) => {
          return detailTex.sample(fract(uvw.mul(uDetailScale.mul(3.1)).add(uWind.mul(uTime).mul(1.7))));
        })
      : null;

    // Short march toward the sun for self-shadowing.
    const shadowMarch = /*@__PURE__*/ Fn(({ samplePos, sunDirN }) => {
      const occ = float(0.0).toVar();
      const stepLen = uShadowLength.div(uShadowSteps);
      Loop(int(8), ({ i }) => {
        If(float(i).greaterThanEqual(uShadowSteps), () => { Break(); });
        const p = samplePos.add(sunDirN.mul(float(i).add(0.75).mul(stepLen)));
        const uvw = saturate(p.add(0.5));
        occ.addAssign(sampleDensity({ uvw }).mul(stepLen));
      });
      return exp(occ.mul(uDensityScale).mul(-0.9));
    });

    return Fn(() => {
      const localCamPos = varying(vec3(modelWorldMatrixInverse.mul(vec4(cameraPosition, 1.0))));
      const vDirection = varying(positionGeometry.sub(localCamPos));
      const rayDir = normalize(vDirection);

      const bounds = vec2(hitBox({ orig: localCamPos, dir: rayDir })).toVar();
      bounds.x.greaterThan(bounds.y).discard();
      bounds.assign(vec2(max(bounds.x, 0.0), bounds.y));

      const spanLen = bounds.y.sub(bounds.x);
      const stepSize = spanLen.div(uSteps);

      // Screen-space hash jitter to break banding.
      const jitter = fract(
        sin(dot(screenCoordinate.xy, vec2(12.9898, 78.233))).mul(43758.5453)
      );

      const sunDirN = normalize(uSunDir);
      const cosTheta = dot(rayDir, sunDirN);
      const phase = henyeyGreenstein({ cosTheta, g: uAnisotropy });

      const accum = vec3(0).toVar();
      const transmittance = float(1).toVar();

      const positionRay = vec3(
        localCamPos.add(rayDir.mul(bounds.x.add(stepSize.mul(jitter))))
      ).toVar();

      Loop({ type: 'float', start: float(0), end: uSteps, update: 1 }, () => {
        const uvw = saturate(positionRay.add(0.5));

        // Coarse bake, eroded into wisps at the edges and clumped in the
        // interior by tiling detail noise.
        const base = sampleDensity({ uvw }).toVar();
        const density = base.toVar();
        let detailAO = null;
        if (sampleDetail) {
          const det = sampleDetail({ uvw });
          const fine = sampleDetailFine({ uvw });
          const wisp = det.r.mul(0.45).add(det.g.mul(0.35)).add(fine.g.mul(0.2));
          const edge = float(1.0).sub(saturate(base.mul(2.4)));
          const eroded = base.sub(wisp.mul(uDetailStrength).mul(edge.mul(0.75).add(0.25)));
          density.assign(saturate(eroded.mul(det.b.mul(0.5).add(0.75))));
          // Fake self-occlusion: billow crevices (low Worley) darken. This
          // carries the close-range structure — pure density modulation
          // washes out once the volume saturates.
          detailAO = saturate(det.g.mul(0.5).add(det.b.mul(0.25)).add(0.3))
            .mul(saturate(fine.b.mul(0.55).add(0.6)));
        }

        If(density.greaterThan(0.004), () => {
          const extinction = density.mul(uDensityScale);

          // ── Sun / moon ──
          const shadow = shadowMarch({ samplePos: positionRay, sunDirN });
          const powder = float(1.0).sub(exp(extinction.mul(-1.6))).mul(uPowder)
            .add(float(1.0).sub(uPowder));
          const sun = uSunColor.mul(uSunStrength).mul(shadow).mul(powder)
            .mul(phase.mul(5.0).add(0.3));

          // ── Height-graded ambient ──
          const ambient = mix(uAmbientBottom, uAmbientTop, smoothstep(0.0, 1.0, uvw.y));

          const lit = sun.add(ambient).toVar();
          if (detailAO) lit.mulAssign(detailAO);

          // ── Internal flash lights ──
          for (const L of flashLights) {
            const toL = L.position.sub(uvw);
            const dist2 = dot(toL, toL);
            const atten = L.intensity.div(dist2.mul(uFlashFalloff).add(1.0));
            // One occlusion tap halfway to the light, scaled by distance so
            // it approximates Beer-Lambert along the path: nearby samples
            // stay hot, matter across the cloud dims without being crushed.
            const midUvw = saturate(uvw.add(toL.mul(0.5)));
            const occ = exp(
              sampleDensity({ uvw: midUvw }).mul(dist2.sqrt()).mul(uFlashOcclusion).negate()
            );
            const flash = L.color.mul(atten.mul(occ));
            lit.addAssign(detailAO ? flash.mul(detailAO) : flash);
          }

          // ── Beer-Lambert integration ──
          const stepExtinction = extinction.mul(stepSize);
          const alpha = float(1.0).sub(exp(stepExtinction.negate()));
          accum.addAssign(lit.mul(alpha.mul(transmittance)));
          transmittance.mulAssign(exp(stepExtinction.negate()));

          If(transmittance.lessThan(TRANSMITTANCE_CUTOFF), () => { Break(); });
        });

        positionRay.addAssign(rayDir.mul(stepSize));
      });

      const finalAlpha = saturate(float(1.0).sub(transmittance));
      return vec4(accum, finalAlpha);
    })();
  }
}
