import * as THREE from "three/webgpu";
import { computeSDF } from "../sdf/edt.js";

// Vector glyph outlines are resolution-independent, so rasterize each glyph at
// high res, run the EDT, then downsample into a generous atlas tile. Tile is
// bigger than the canvas-raster path's 32px cells since there's no quality cost.
const TILE = 64; // atlas tile size, texels
const RASTER = 256; // supersampled rasterization size, px
const PAD_FRAC = 0.18; // ink padding within the raster, so the SDF halo fits
const MAX_DISTANCE = RASTER * 0.125; // encoded distance span, raster px (~32)

/**
 * Single-channel Float32 SDF atlas built from real font outlines (Path2D fill +
 * EDT), drop-in for {@link FontAtlas}: same `getGlyph`/`ensureGlyphs`/`.texture`
 * surface, so the existing {@link BatchedText} material samples it unchanged.
 *
 * The font is supplied after construction via {@link setFont} because font
 * loading is async; glyphs requested before the font arrives are treated blank.
 */
export class VectorFontAtlas {
  cellSize = TILE;

  /**
   * @param {object} [options]
   * @param {number} [options.atlasSize=1024]
   */
  constructor(options = {}) {
    const atlasSize = options.atlasSize ?? 1024;
    /** @type {import('./VectorFont.js').VectorFont | null} */
    this.font = null;

    this.canvas = new OffscreenCanvas(RASTER, RASTER);
    this.ctx = this.canvas.getContext("2d", { willReadFrequently: true });

    this.glyphs = new Map();
    this.cols = Math.floor(atlasSize / TILE);
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
    return this.cols * TILE;
  }

  /**
   * Attach the parsed font. Clears any glyphs rasterized while it was absent so
   * they get regenerated with real outlines on the next request.
   * @param {import('./VectorFont.js').VectorFont} font
   */
  setFont(font) {
    if (this.font === font) return;
    this.font = font;
    this.reset();
  }

  reset() {
    this.glyphs.clear();
    this.nextSlot = 0;
    this.atlasData.fill(0);
    this.texture.needsUpdate = true;
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

  getGlyph(char) {
    let metrics = this.glyphs.get(char);
    if (metrics) return metrics;
    metrics = this.rasterizeGlyph(char);
    this.glyphs.set(char, metrics);
    this.texture.needsUpdate = true;
    return metrics;
  }

  /** Build a Path2D from an opentype path's commands under an affine map. */
  _buildPath2D(commands, offX, offY, s, minX, minY) {
    const p = new Path2D();
    const mx = (x) => offX + (x - minX) * s;
    const my = (y) => offY + (y - minY) * s;
    for (const c of commands) {
      switch (c.type) {
        case "M":
          p.moveTo(mx(c.x), my(c.y));
          break;
        case "L":
          p.lineTo(mx(c.x), my(c.y));
          break;
        case "C":
          p.bezierCurveTo(
            mx(c.x1),
            my(c.y1),
            mx(c.x2),
            my(c.y2),
            mx(c.x),
            my(c.y),
          );
          break;
        case "Q":
          p.quadraticCurveTo(mx(c.x1), my(c.y1), mx(c.x), my(c.y));
          break;
        case "Z":
          p.closePath();
          break;
      }
    }
    return p;
  }

  rasterizeGlyph(char) {
    const slot = this.nextSlot++;
    const col = slot % this.cols;
    const row = Math.floor(slot / this.cols);
    const atlasW = this.atlasSize;
    const ctx = this.ctx;

    ctx.clearRect(0, 0, RASTER, RASTER);

    let viewBox = [0, 0, 0, 0];
    const glyph = this.font ? this.font.glyphForChar(char) : null;

    if (glyph) {
      // Path in a y-down coordinate system (opentype getPath flips to screen
      // space), scaled 1:1 with font units via fontSize == unitsPerEm.
      const path = glyph.getPath(0, 0, this.font.unitsPerEm);
      const pb = path.getBoundingBox();
      const gw = pb.x2 - pb.x1;
      const gh = pb.y2 - pb.y1;

      if (gw > 0 && gh > 0) {
        const avail = RASTER - 2 * (RASTER * PAD_FRAC);
        const s = avail / Math.max(gw, gh);
        const rw = gw * s;
        const rh = gh * s;
        const offX = (RASTER - rw) / 2;
        const offY = (RASTER - rh) / 2;

        const p2d = this._buildPath2D(
          path.commands,
          offX,
          offY,
          s,
          pb.x1,
          pb.y1,
        );
        ctx.fillStyle = "white";
        ctx.fill(p2d);

        viewBox = [
          offX / RASTER,
          offY / RASTER,
          (offX + rw) / RASTER,
          (offY + rh) / RASTER,
        ];
      }
    }

    const imgData = ctx.getImageData(0, 0, RASTER, RASTER);
    const sdfHiRes = computeSDF(imgData.data, RASTER, RASTER);

    const scale = RASTER / TILE;
    for (let sy = 0; sy < TILE; sy++) {
      for (let sx = 0; sx < TILE; sx++) {
        const srcX = Math.min(Math.floor((sx + 0.5) * scale), RASTER - 1);
        const srcY = Math.min(Math.floor((sy + 0.5) * scale), RASTER - 1);
        const dist = sdfHiRes[srcY * RASTER + srcX];

        // Linear encoding: 0.5 at the edge, >0.5 inside, <0.5 outside.
        const normalized = 0.5 - dist / (2 * MAX_DISTANCE);
        const clamped = normalized < 0 ? 0 : normalized > 1 ? 1 : normalized;

        const atlasX = col * TILE + sx;
        const atlasY = row * TILE + sy;
        this.atlasData[atlasY * atlasW + atlasX] = clamped;
      }
    }

    return {
      u: (col * TILE) / atlasW,
      v: (row * TILE) / atlasW,
      w: TILE / atlasW,
      h: TILE / atlasW,
      viewBox,
    };
  }
}
