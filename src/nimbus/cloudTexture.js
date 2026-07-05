/**
 * @module nimbus/cloudTexture
 *
 * CPU-baked procedural cumulonimbus density field.
 *
 * Sculpts a storm cloud into a single-channel Data3DTexture:
 * a cluster of vertically-developed tower ellipsoids, eroded by
 * fractal value noise, billowed by inverted Worley noise, with a
 * ragged noise-cut base and a soft anvil spread near the top.
 *
 * Bake once at startup; the volume is static and lighting/motion
 * are done in the shader.
 */

import * as THREE from 'three/webgpu';

// ─── Seeded RNG ──────────────────────────────────────────────────────────────

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Integer lattice hash → [0,1)
function hash3(ix, iy, iz, seed) {
  let h = (ix * 374761393 + iy * 668265263 + iz * 2147483647 + seed * 144665) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

function smootherstep(t) {
  return t * t * (3 - 2 * t);
}

// ─── Value noise + fbm ───────────────────────────────────────────────────────

function valueNoise(x, y, z, seed) {
  const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z);
  const fx = x - ix, fy = y - iy, fz = z - iz;
  const u = smootherstep(fx), v = smootherstep(fy), w = smootherstep(fz);

  const n000 = hash3(ix, iy, iz, seed),         n100 = hash3(ix + 1, iy, iz, seed);
  const n010 = hash3(ix, iy + 1, iz, seed),     n110 = hash3(ix + 1, iy + 1, iz, seed);
  const n001 = hash3(ix, iy, iz + 1, seed),     n101 = hash3(ix + 1, iy, iz + 1, seed);
  const n011 = hash3(ix, iy + 1, iz + 1, seed), n111 = hash3(ix + 1, iy + 1, iz + 1, seed);

  const nx00 = n000 + (n100 - n000) * u;
  const nx10 = n010 + (n110 - n010) * u;
  const nx01 = n001 + (n101 - n001) * u;
  const nx11 = n011 + (n111 - n011) * u;
  const nxy0 = nx00 + (nx10 - nx00) * v;
  const nxy1 = nx01 + (nx11 - nx01) * v;
  return nxy0 + (nxy1 - nxy0) * w;
}

function fbm(x, y, z, octaves, seed) {
  let sum = 0, amp = 0.5, freq = 1, norm = 0;
  for (let o = 0; o < octaves; o++) {
    sum += valueNoise(x * freq, y * freq, z * freq, seed + o * 101) * amp;
    norm += amp;
    amp *= 0.5;
    freq *= 2.02;
  }
  return sum / norm;
}

// ─── Worley (cellular) noise, F1 ─────────────────────────────────────────────

function worleyF1(x, y, z, seed) {
  const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z);
  let minD2 = 8;
  for (let dz = -1; dz <= 1; dz++) {
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const cx = ix + dx, cy = iy + dy, cz = iz + dz;
        const fx = cx + hash3(cx, cy, cz, seed);
        const fy = cy + hash3(cx, cy, cz, seed + 51);
        const fz = cz + hash3(cx, cy, cz, seed + 97);
        const ddx = fx - x, ddy = fy - y, ddz = fz - z;
        const d2 = ddx * ddx + ddy * ddy + ddz * ddz;
        if (d2 < minD2) minD2 = d2;
      }
    }
  }
  return Math.min(1, Math.sqrt(minD2));
}

// ─── Tiling (wrapped) noise — for the repeatable detail texture ──────────────

function valueNoiseWrapped(x, y, z, period, seed) {
  const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z);
  const fx = x - ix, fy = y - iy, fz = z - iz;
  const u = smootherstep(fx), v = smootherstep(fy), w = smootherstep(fz);
  const h = (a, b, c) =>
    hash3(((a % period) + period) % period, ((b % period) + period) % period, ((c % period) + period) % period, seed);

  const n000 = h(ix, iy, iz),         n100 = h(ix + 1, iy, iz);
  const n010 = h(ix, iy + 1, iz),     n110 = h(ix + 1, iy + 1, iz);
  const n001 = h(ix, iy, iz + 1),     n101 = h(ix + 1, iy, iz + 1);
  const n011 = h(ix, iy + 1, iz + 1), n111 = h(ix + 1, iy + 1, iz + 1);

  const nx00 = n000 + (n100 - n000) * u;
  const nx10 = n010 + (n110 - n010) * u;
  const nx01 = n001 + (n101 - n001) * u;
  const nx11 = n011 + (n111 - n011) * u;
  const nxy0 = nx00 + (nx10 - nx00) * v;
  const nxy1 = nx01 + (nx11 - nx01) * v;
  return nxy0 + (nxy1 - nxy0) * w;
}

function fbmWrapped(x, y, z, basePeriod, octaves, seed) {
  let sum = 0, amp = 0.5, freq = 1, norm = 0;
  for (let o = 0; o < octaves; o++) {
    const p = basePeriod * freq;
    sum += valueNoiseWrapped(x * p, y * p, z * p, p, seed + o * 101) * amp;
    norm += amp;
    amp *= 0.5;
    freq *= 2;
  }
  return sum / norm;
}

function worleyF1Wrapped(x, y, z, period, seed) {
  const px = x * period, py = y * period, pz = z * period;
  const ix = Math.floor(px), iy = Math.floor(py), iz = Math.floor(pz);
  const wrap = (v) => ((v % period) + period) % period;
  let minD2 = 8;
  for (let dz = -1; dz <= 1; dz++) {
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const cx = ix + dx, cy = iy + dy, cz = iz + dz;
        const wx = wrap(cx), wy = wrap(cy), wz = wrap(cz);
        const fx = cx + hash3(wx, wy, wz, seed);
        const fy = cy + hash3(wx, wy, wz, seed + 51);
        const fz = cz + hash3(wx, wy, wz, seed + 97);
        const ddx = fx - px, ddy = fy - py, ddz = fz - pz;
        const d2 = ddx * ddx + ddy * ddy + ddz * ddz;
        if (d2 < minD2) minD2 = d2;
      }
    }
  }
  return Math.min(1, Math.sqrt(minD2));
}

/**
 * Bake a seamlessly tiling 3D detail-noise texture.
 *
 * Channels: R = wrapped fbm, G = inverted wrapped Worley (billow),
 * B = higher-frequency inverted Worley. Sampled repeating at several times
 * the base-cloud frequency to give close-range wisp/clump structure that
 * the coarse cumulonimbus bake can't hold.
 *
 * @param {object} [options]
 * @param {number} [options.size=64]
 * @param {number} [options.seed=1]
 * @returns {THREE.Data3DTexture}
 */
export function bakeDetailNoiseTexture({ size = 64, seed = 1 } = {}) {
  const nSeed = (seed * 131 + 3) | 0;
  const data = new Uint8Array(size * size * size * 4);
  let i = 0;
  for (let zi = 0; zi < size; zi++) {
    for (let yi = 0; yi < size; yi++) {
      for (let xi = 0; xi < size; xi++, i += 4) {
        const x = (xi + 0.5) / size, y = (yi + 0.5) / size, z = (zi + 0.5) / size;
        const f = fbmWrapped(x, y, z, 4, 4, nSeed);
        const w1 = 1 - worleyF1Wrapped(x, y, z, 5, nSeed + 977);
        const w2 = 1 - worleyF1Wrapped(x, y, z, 9, nSeed + 1409);
        data[i] = Math.round(f * 255);
        data[i + 1] = Math.round(w1 * 255);
        data[i + 2] = Math.round(w2 * 255);
        data[i + 3] = 255;
      }
    }
  }

  const texture = new THREE.Data3DTexture(data, size, size, size);
  texture.format = THREE.RGBAFormat;
  texture.type = THREE.UnsignedByteType;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.wrapS = texture.wrapT = texture.wrapR = THREE.RepeatWrapping;
  texture.needsUpdate = true;
  return texture;
}

// ─── Cloud bake ──────────────────────────────────────────────────────────────

/**
 * Bake a cumulonimbus density field.
 *
 * Coordinates are normalized [0,1]³ with y up. The cloud occupies roughly
 * y ∈ [baseY, 1]; below baseY density is cut with a noisy ragged edge.
 *
 * @param {object} [options]
 * @param {number} [options.size=112]      — voxels per side
 * @param {number} [options.seed=1]        — bake seed
 * @param {number} [options.towers=7]      — number of tower ellipsoids
 * @param {number} [options.baseY=0.22]    — cloud base height
 * @param {number} [options.erosion=0.42]  — fbm edge erosion strength
 * @param {number} [options.billow=0.55]   — inverted-Worley cauliflower strength
 * @param {number} [options.anvil=0.25]    — top spread amount
 * @param {number} [options.coverage=1.0]  — overall density gain
 * @returns {{ texture: THREE.Data3DTexture, size: number, sample: (x:number,y:number,z:number)=>number }}
 */
export function bakeCumulonimbusTexture({
  size = 112,
  seed = 1,
  towers = 10,
  baseY = 0.22,
  erosion = 0.52,
  billow = 0.65,
  anvil = 0.35,
  coverage = 1.0,
} = {}) {
  const rng = mulberry32(seed * 7919 + 13);

  // Tower layout: one dominant central tower + satellites at mid height.
  const blobs = [];
  const mainR = 0.33 + rng() * 0.04;
  blobs.push({ x: 0.5, y: baseY + 0.32, z: 0.5, rx: mainR, ry: 0.46, rz: mainR * 0.92, w: 1.0 });
  for (let i = 1; i < towers; i++) {
    // Keep rad + r ≤ ~0.44 so satellites never clip the texture bounds.
    const ang = rng() * Math.PI * 2;
    const rad = 0.13 + rng() * 0.18;
    const r = 0.13 + rng() * 0.13;
    const h = 0.16 + rng() * 0.32;
    blobs.push({
      x: 0.5 + Math.cos(ang) * rad,
      y: baseY + h * 0.55,
      z: 0.5 + Math.sin(ang) * rad,
      rx: r, ry: h, rz: r,
      w: 0.5 + rng() * 0.45,
    });
  }

  const nSeed = (seed * 31 + 7) | 0;

  /** Analytic density sample in normalized [0,1]³ space. */
  function sample(x, y, z) {
    // Anvil: shear sample point outward near the top so the shape spreads.
    const topT = Math.max(0, (y - 0.62) / 0.38);
    const spread = 1 / (1 + anvil * topT * topT);
    const sx = 0.5 + (x - 0.5) * spread;
    const sz = 0.5 + (z - 0.5) * spread;

    // Metaball-style union of tower ellipsoids.
    let shape = 0;
    for (const b of blobs) {
      const dx = (sx - b.x) / b.rx, dy = (y - b.y) / b.ry, dz = (sz - b.z) / b.rz;
      const d2 = dx * dx + dy * dy + dz * dz;
      const f = Math.max(0, 1 - d2);
      shape = Math.max(shape, f * f * b.w);
    }
    if (shape <= 0.0005) return 0;

    // Erode edges with fbm; billow interiors with inverted Worley.
    const n = fbm(sx * 6.5, y * 6.5, sz * 6.5, 5, nSeed);
    const wor = 1 - worleyF1(sx * 11, y * 11, sz * 11, nSeed + 977);
    const worB = 1 - worleyF1(sx * 24, y * 24, sz * 24, nSeed + 1409);

    let d = shape - erosion * (1 - n) - 0.08;
    if (d <= 0) return 0;
    d *= 0.72 + billow * (wor * 0.75 + worB * 0.25);

    // Ragged, mostly-flat storm base.
    const baseCut = baseY + (n - 0.5) * 0.1;
    const baseFade = Math.min(1, Math.max(0, (y - baseCut) / 0.055));

    // Soft top fade so towers end in rounded caps, not a ceiling clip.
    const topFade = Math.min(1, Math.max(0, (0.985 - y) / 0.05));

    return Math.min(1, d * coverage * 3.2 * baseFade * baseFade * topFade);
  }

  // Bake to bytes.
  const data = new Uint8Array(size * size * size);
  let i = 0;
  for (let zi = 0; zi < size; zi++) {
    for (let yi = 0; yi < size; yi++) {
      for (let xi = 0; xi < size; xi++, i++) {
        const d = sample((xi + 0.5) / size, (yi + 0.5) / size, (zi + 0.5) / size);
        data[i] = Math.round(Math.min(1, Math.max(0, d)) * 255);
      }
    }
  }

  const texture = new THREE.Data3DTexture(data, size, size, size);
  texture.format = THREE.RedFormat;
  texture.type = THREE.UnsignedByteType;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.wrapS = texture.wrapT = texture.wrapR = THREE.ClampToEdgeWrapping;
  texture.unpackAlignment = 1;
  texture.needsUpdate = true;

  return { texture, size, sample };
}
