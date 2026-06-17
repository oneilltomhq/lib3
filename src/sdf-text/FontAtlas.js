import * as THREE from "three/webgpu";
import { computeSDF } from "../sdf/edt.js";

const GLYPH_SIZE = 64;
const SDF_SIZE = 32;
const SDF_PADDING = 4;
const MAX_DISTANCE = 8;

export class FontAtlas {
  cellSize = SDF_SIZE;

  constructor(
    fontFamily = "monospace",
    fontSize = GLYPH_SIZE - SDF_PADDING * 2,
    atlasSize = 512,
  ) {
    this.fontFamily = fontFamily;
    this.fontSize = fontSize;
    this.canvas = new OffscreenCanvas(GLYPH_SIZE, GLYPH_SIZE);
    this.ctx = this.canvas.getContext("2d", { willReadFrequently: true });
    this.glyphs = new Map();
    this.cols = Math.floor(atlasSize / SDF_SIZE);
    this.rows = this.cols;
    this.atlasData = new Float32Array(atlasSize * atlasSize);
    this.nextSlot = 0;

    this.texture = new THREE.DataTexture(
      this.atlasData,
      atlasSize,
      atlasSize,
      THREE.RedFormat,
      THREE.FloatType,
    );
    this.texture.minFilter = THREE.LinearFilter;
    this.texture.magFilter = THREE.LinearFilter;
    this.texture.needsUpdate = true;
  }

  get atlasSize() {
    return this.cols * SDF_SIZE;
  }

  getGlyph(char) {
    let metrics = this.glyphs.get(char);
    if (metrics) return metrics;
    metrics = this.rasterizeGlyph(char);
    this.glyphs.set(char, metrics);
    this.texture.needsUpdate = true;
    return metrics;
  }

  hasGlyph(char) {
    return this.glyphs.has(char);
  }

  ensureGlyphs(chars) {
    let added = false;
    for (const ch of chars) {
      if (!this.glyphs.has(ch)) {
        this.getGlyph(ch);
        added = true;
      }
    }
    return added;
  }

  rasterizeGlyph(char) {
    const slot = this.nextSlot++;
    const col = slot % this.cols;
    const row = Math.floor(slot / this.cols);
    const atlasW = this.atlasSize;

    const ctx = this.ctx;
    ctx.clearRect(0, 0, GLYPH_SIZE, GLYPH_SIZE);
    ctx.fillStyle = "white";
    ctx.font = `${this.fontSize}px ${this.fontFamily}`;
    ctx.textBaseline = "middle";
    ctx.textAlign = "center";
    ctx.fillText(char, GLYPH_SIZE / 2, GLYPH_SIZE / 2);

    const imgData = ctx.getImageData(0, 0, GLYPH_SIZE, GLYPH_SIZE);
    const sdfHiRes = computeSDF(imgData.data, GLYPH_SIZE, GLYPH_SIZE);

    const scaleX = GLYPH_SIZE / SDF_SIZE;
    const scaleY = GLYPH_SIZE / SDF_SIZE;

    for (let sy = 0; sy < SDF_SIZE; sy++) {
      for (let sx = 0; sx < SDF_SIZE; sx++) {
        const srcX = Math.min(Math.floor((sx + 0.5) * scaleX), GLYPH_SIZE - 1);
        const srcY = Math.min(Math.floor((sy + 0.5) * scaleY), GLYPH_SIZE - 1);
        const dist = sdfHiRes[srcY * GLYPH_SIZE + srcX];

        const normalized = 0.5 - dist / (2 * MAX_DISTANCE);
        const clamped = Math.max(0, Math.min(1, normalized));

        const atlasX = col * SDF_SIZE + sx;
        const atlasY = row * SDF_SIZE + sy;
        this.atlasData[atlasY * atlasW + atlasX] = clamped;
      }
    }

    return {
      u: (col * SDF_SIZE) / atlasW,
      v: (row * SDF_SIZE) / atlasW,
      w: SDF_SIZE / atlasW,
      h: SDF_SIZE / atlasW,
    };
  }
}
