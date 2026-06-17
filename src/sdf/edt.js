// 1D Euclidean Distance Transform (Felzenszwalb & Huttenlocher)
// Computes squared distances; caller takes sqrt if needed.

const INF = 1e20;

export function edt1d(f, d, v, z, n) {
  v[0] = 0;
  z[0] = -INF;
  z[1] = INF;
  let k = 0;

  for (let q = 1; q < n; q++) {
    let s;
    do {
      const r = v[k];
      s = (f[q] - f[r] + q * q - r * r) / (2 * q - 2 * r);
      if (s > z[k]) break;
      k--;
    } while (k >= 0);
    k++;
    v[k] = q;
    z[k] = s;
    z[k + 1] = INF;
  }

  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++;
    const dx = q - v[k];
    d[q] = dx * dx + f[v[k]];
  }
}

/**
 * Compute a signed distance field from a binary alpha image.
 * Returns Float64Array of signed distances (negative = inside).
 */
export function computeSDF(
  imageData,
  width,
  height,
  alphaThreshold = 128,
) {
  const size = width * height;
  const outside = new Float64Array(size);
  const inside = new Float64Array(size);

  for (let i = 0; i < size; i++) {
    const a = imageData[i * 4 + 3];
    if (a >= alphaThreshold) {
      outside[i] = 0;
      inside[i] = INF;
    } else {
      outside[i] = INF;
      inside[i] = 0;
    }
  }

  edt2d(outside, width, height);
  edt2d(inside, width, height);

  const sdf = new Float64Array(size);
  for (let i = 0; i < size; i++) {
    sdf[i] = Math.sqrt(outside[i]) - Math.sqrt(inside[i]);
  }
  return sdf;
}

function edt2d(grid, width, height) {
  const maxDim = Math.max(width, height);
  const f = new Float64Array(maxDim);
  const d = new Float64Array(maxDim);
  const v = new Int32Array(maxDim);
  const z = new Float64Array(maxDim + 1);

  for (let x = 0; x < width; x++) {
    for (let y = 0; y < height; y++) f[y] = grid[y * width + x];
    edt1d(f, d, v, z, height);
    for (let y = 0; y < height; y++) grid[y * width + x] = d[y];
  }

  for (let y = 0; y < height; y++) {
    const offset = y * width;
    for (let x = 0; x < width; x++) f[x] = grid[offset + x];
    edt1d(f, d, v, z, width);
    for (let x = 0; x < width; x++) grid[offset + x] = d[x];
  }
}
