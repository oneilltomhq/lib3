/**
 * @module nimbus/bolt
 *
 * CPU lightning-channel generation + camera-facing ribbon mesh.
 *
 * `generateBoltPaths` builds a jagged main channel (midpoint displacement)
 * with recursive branches. Every point carries a normalized reveal
 * parameter `t` (0 at origin, 1 at the tip) so the shader can animate a
 * stepped-leader sweep, then blast the whole channel on return stroke.
 *
 * `LightningBoltMesh` renders the paths as additive, view-aligned ribbons
 * with a hot core, driven by `progress` / `intensity` / `leaderGlow` uniforms.
 */

import * as THREE from 'three/webgpu';
import {
  uniform, attribute, Fn, float, vec3, vec4,
  positionGeometry, modelWorldMatrixInverse, cameraPosition,
  normalize, cross, exp, abs, smoothstep, saturate,
} from 'three/tsl';

// ─── Path generation ─────────────────────────────────────────────────────────

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Random unit vector roughly perpendicular to `dir`. */
function randPerp(rng, dir, out) {
  const v = out.set(rng() * 2 - 1, rng() * 2 - 1, rng() * 2 - 1);
  v.addScaledVector(dir, -v.dot(dir));
  if (v.lengthSq() < 1e-6) v.set(dir.y, -dir.x, dir.z * 0.5 + 0.1);
  return v.normalize();
}

/** Midpoint-displacement over a control polyline. */
function displaceChannel(rng, controls, subdivisions, roughness, offsetDecay) {
  let pts = controls.map((p) => p.clone());
  const dir = new THREE.Vector3();
  const perp = new THREE.Vector3();
  let length = 0;
  for (let i = 1; i < pts.length; i++) length += pts[i].distanceTo(pts[i - 1]);
  let offset = length * roughness;

  for (let s = 0; s < subdivisions; s++) {
    const next = [pts[0]];
    for (let i = 0; i < pts.length - 1; i++) {
      const p0 = pts[i], p1 = pts[i + 1];
      const mid = p0.clone().add(p1).multiplyScalar(0.5);
      dir.subVectors(p1, p0).normalize();
      randPerp(rng, dir, perp);
      mid.addScaledVector(perp, (rng() * 2 - 1) * offset);
      next.push(mid, p1);
    }
    pts = next;
    offset *= offsetDecay;
  }
  return pts;
}

/**
 * Generate lightning channel polylines.
 *
 * @param {object} opts
 * @param {number} opts.seed
 * @param {THREE.Vector3} opts.start — channel origin (cloud base)
 * @param {THREE.Vector3} opts.end   — strike point (ground)
 * Macro shape is controlled per-strike: `bend` wanders the main channel
 * horizontally through waypoints, `branchSpread` sets how far branches
 * splay from the channel direction, `forkChance` can split the trunk into
 * a second full ground termination. Vary these per strike (see storm.js)
 * so no two bolts share a silhouette.
 *
 * @param {number} [opts.subdivisions=8]
 * @param {number} [opts.roughness=0.14]      — lateral jag as fraction of length
 * @param {number} [opts.offsetDecay=0.55]    — jag falloff per subdivision (higher = gnarlier)
 * @param {number} [opts.bend=0.5]            — horizontal wander of the main channel
 * @param {number} [opts.branchChance=0.12]   — per interior point
 * @param {number} [opts.branchSpread=0.8]    — lateral splay of branch directions
 * @param {number} [opts.branchDecay=0.55]    — length/brightness falloff per depth
 * @param {number} [opts.maxDepth=3]
 * @param {number} [opts.forkChance=0]        — chance of a second ground termination
 * @param {number} [opts.width=1]             — main channel ribbon half-width (world)
 * @returns {Array<{points: THREE.Vector3[], t: number[], width: number, bright: number}>}
 */
export function generateBoltPaths({
  seed = 1,
  start,
  end,
  subdivisions = 8,
  roughness = 0.14,
  offsetDecay = 0.55,
  bend = 0.5,
  branchChance = 0.12,
  branchSpread = 0.8,
  branchDecay = 0.55,
  maxDepth = 3,
  forkChance = 0,
  width = 1,
} = {}) {
  const rng = mulberry32((seed * 2654435761) >>> 0);
  const paths = [];
  const height = Math.abs(start.y - end.y) || start.distanceTo(end);

  function addChannel(controls, depth, tStart, tSpan, bright, widthScale) {
    const subs = Math.max(3, subdivisions - depth * 2);
    const pts = displaceChannel(rng, controls, subs, roughness * (1 + depth * 0.35), offsetDecay);

    // Arc-length parameterization → reveal t.
    const cum = [0];
    for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + pts[i].distanceTo(pts[i - 1]));
    const total = cum[cum.length - 1] || 1;
    const t = cum.map((c) => Math.min(1, tStart + (c / total) * tSpan));

    paths.push({
      points: pts,
      t,
      width: width * widthScale * Math.pow(0.55, depth),
      bright,
    });

    if (depth >= maxDepth) return { pts, t };

    // Branches splay off interior points.
    const chanDir = new THREE.Vector3()
      .subVectors(controls[controls.length - 1], controls[0]).normalize();
    const perp = new THREE.Vector3();
    for (let i = 2; i < pts.length - 2; i++) {
      if (rng() > branchChance) continue;
      const frac = i / (pts.length - 1);
      const remaining = total * (1 - frac);
      const len = remaining * (0.25 + rng() * 0.4) * branchDecay;
      if (len < total * 0.04) continue;

      randPerp(rng, chanDir, perp);
      const bDir = chanDir.clone()
        .addScaledVector(perp, branchSpread * (0.4 + rng() * 0.9))
        .normalize();
      // Gravity bias: branches trend downward like real streamers.
      bDir.y -= 0.3 * branchSpread;
      bDir.normalize();
      const bEnd = pts[i].clone().addScaledVector(bDir, len);
      addChannel(
        [pts[i], bEnd], depth + 1,
        t[i], tSpan * (len / total) * 1.2,
        bright * branchDecay, 1,
      );
    }
    return { pts, t };
  }

  // Main channel wanders through horizontal waypoints before displacement.
  const controls = [start.clone()];
  for (let k = 1; k <= 2; k++) {
    const p = start.clone().lerp(end, k / 3);
    const ang = rng() * Math.PI * 2;
    const r = bend * height * 0.22 * (0.5 + rng());
    p.x += Math.cos(ang) * r;
    p.z += Math.sin(ang) * r;
    controls.push(p);
  }
  controls.push(end.clone());

  const trunk = addChannel(controls, 0, 0, 1, 1, 1);

  // Major fork: a second, full-weight channel to its own ground point.
  if (rng() < forkChance) {
    const i = Math.floor(trunk.pts.length * (0.3 + rng() * 0.35));
    const p = trunk.pts[i];
    const ang = rng() * Math.PI * 2;
    const r = height * (0.25 + rng() * 0.35);
    const end2 = new THREE.Vector3(end.x + Math.cos(ang) * r, end.y, end.z + Math.sin(ang) * r);
    addChannel([p, p.clone().lerp(end2, 0.5), end2], 0, trunk.t[i], 1 - trunk.t[i], 0.9, 0.8);
  }

  return paths;
}

// ─── Ribbon mesh ─────────────────────────────────────────────────────────────

/**
 * Additive view-aligned ribbon mesh for bolt paths.
 *
 * Uniforms:
 *  - progress   — leader tip position along t ∈ [0, 1.05]
 *  - intensity  — overall channel brightness (return stroke ≫ leader)
 *  - leaderGlow — extra brightness at the advancing tip
 */
export class LightningBoltMesh {
  /**
   * @param {object} [opts]
   * @param {THREE.Color} [opts.color]     — halo color
   * @param {THREE.Color} [opts.coreColor] — hot core color
   * @param {number} [opts.widthScale=1]
   */
  constructor({
    color = new THREE.Color(0.55, 0.65, 1.0),
    coreColor = new THREE.Color(1.0, 1.0, 1.0),
    widthScale = 1,
  } = {}) {
    this.uniforms = {
      progress: uniform(0),
      intensity: uniform(0),
      leaderGlow: uniform(0),
      widthScale: uniform(widthScale),
      color: uniform(color),
      coreColor: uniform(coreColor),
    };

    const material = new THREE.NodeMaterial();
    material.transparent = true;
    material.depthWrite = false;
    material.blending = THREE.AdditiveBlending;
    material.side = THREE.DoubleSide;

    const { progress, intensity, leaderGlow, widthScale: uWidth, color: uColor, coreColor: uCore } = this.uniforms;

    const aTangent = attribute('aTangent', 'vec3');
    const aSide = attribute('aSide', 'float');
    const aT = attribute('aT', 'float');
    const aWidth = attribute('aWidth', 'float');
    const aBright = attribute('aBright', 'float');

    material.positionNode = Fn(() => {
      const localCam = vec3(modelWorldMatrixInverse.mul(vec4(cameraPosition, 1.0)));
      const viewDir = normalize(positionGeometry.sub(localCam));
      const perp = normalize(cross(aTangent, viewDir));
      return positionGeometry.add(perp.mul(aSide.mul(aWidth).mul(uWidth)));
    })();

    material.colorNode = Fn(() => {
      // Leader sweep: visible where t < progress, soft edge at the tip.
      const reveal = smoothstep(progress, progress.sub(0.03), aT);
      // Advancing-tip hot spot while the leader crawls down.
      const tip = exp(abs(progress.sub(aT)).mul(-28.0)).mul(leaderGlow);
      // Cross-ribbon profile: hot core → colored halo (aSide ±1 at edges).
      const edge = abs(aSide);
      const halo = float(1.0).sub(edge).pow(2.5);
      const core = float(1.0).sub(edge).pow(9.0);

      const energy = reveal.mul(intensity).add(tip).mul(aBright);
      const rgb = uColor.mul(halo).mul(energy).mul(0.3)
        .add(uCore.mul(core).mul(energy));
      return vec4(rgb, saturate(halo.mul(saturate(energy))));
    })();

    this.material = material;
    this.mesh = new THREE.Mesh(new THREE.BufferGeometry(), material);
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
  }

  /**
   * Replace ribbon geometry with new bolt paths (from `generateBoltPaths`).
   * @param {Array} paths
   */
  setPaths(paths) {
    const positions = [], tangents = [], sides = [], ts = [], widths = [], brights = [], indices = [];
    let base = 0;

    for (const path of paths) {
      const { points, t, width, bright } = path;
      const n = points.length;
      const tangent = new THREE.Vector3();
      for (let i = 0; i < n; i++) {
        const prev = points[Math.max(0, i - 1)];
        const next = points[Math.min(n - 1, i + 1)];
        tangent.subVectors(next, prev).normalize();
        // Taper branch tips.
        const taper = 1 - Math.pow(i / (n - 1), 3) * 0.6;
        for (const side of [-1, 1]) {
          positions.push(points[i].x, points[i].y, points[i].z);
          tangents.push(tangent.x, tangent.y, tangent.z);
          sides.push(side);
          ts.push(t[i]);
          widths.push(width * taper);
          brights.push(bright);
        }
      }
      for (let i = 0; i < n - 1; i++) {
        const a = base + i * 2, b = a + 1, c = a + 2, d = a + 3;
        indices.push(a, b, c, b, d, c);
      }
      base += n * 2;
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geo.setAttribute('aTangent', new THREE.Float32BufferAttribute(tangents, 3));
    geo.setAttribute('aSide', new THREE.Float32BufferAttribute(sides, 1));
    geo.setAttribute('aT', new THREE.Float32BufferAttribute(ts, 1));
    geo.setAttribute('aWidth', new THREE.Float32BufferAttribute(widths, 1));
    geo.setAttribute('aBright', new THREE.Float32BufferAttribute(brights, 1));
    geo.setIndex(indices);

    this.mesh.geometry.dispose();
    this.mesh.geometry = geo;
  }

  dispose() {
    this.mesh.geometry.dispose();
    this.material.dispose();
  }
}
