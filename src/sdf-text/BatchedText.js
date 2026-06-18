import * as THREE from "three/webgpu";
import {
  texture,
  uv,
  smoothstep,
  attribute,
  Fn,
  vec3,
  vec4,
  float,
  select,
  fwidth,
  max,
  uniform,
  mix,
} from "three/tsl";
import { FontAtlas } from "./FontAtlas.js";

/** Fraction of each glyph's ink size to grow the quad + sampled sub-rect by,
 * so the outline/AA halo around the ink isn't clipped at the ink bbox. */
const GLYPH_QUAD_PAD = 0.12;

/**
 * Instanced SDF text renderer. Each {@link Text} member expands to N glyph quads on
 * {@link sync} — matching @three-blocks/core BatchedText packing semantics.
 */
export class BatchedText extends THREE.InstancedMesh {
  /**
   * @param {number} [maxTextCount=64]
   * @param {number} [maxGlyphCount=1024]
   * @param {THREE.Material} [_baseMaterial]
   * @param {object} [options]
   */
  constructor(maxTextCount = 64, maxGlyphCount = 1024, _baseMaterial, options = {}) {
    const plane = new THREE.PlaneGeometry(1, 1);
    const material = new THREE.NodeMaterial();
    material.transparent = true;
    material.depthWrite = false;
    material.side = THREE.DoubleSide;

    super(plane, material, maxGlyphCount);

    this.outlineWidth = options.outlineWidth ?? 0.03;
    this.atlas = new FontAtlas(
      options.fontFamily,
      options.fontSize,
      options.atlasSize,
    );

    this._maxTextCount = maxTextCount;
    this._maxGlyphCount = maxGlyphCount;
    /** @type {(import('./Text.js').Text | null)[]} */
    this._members = new Array(maxTextCount).fill(null);
    this._memberCount = 0;
    /** @type {{ glyphStart: number, glyphCount: number }[]} */
    this._memberGlyphs = new Array(maxTextCount);
    this._glyphCount = 0;

    this.glyphUVArray = new Float32Array(maxGlyphCount * 4);
    this.glyphBoundsArray = new Float32Array(maxGlyphCount * 4);
    this.colorArray = new Float32Array(maxGlyphCount * 3);

    this.glyphUVAttr = new THREE.InstancedBufferAttribute(this.glyphUVArray, 4);
    this.glyphUVAttr.setUsage(THREE.DynamicDrawUsage);
    this.geometry.setAttribute("aGlyphUV", this.glyphUVAttr);

    this.glyphBoundsAttr = new THREE.InstancedBufferAttribute(
      this.glyphBoundsArray,
      4,
    );
    this.glyphBoundsAttr.setUsage(THREE.DynamicDrawUsage);
    this.geometry.setAttribute("aGlyphBounds", this.glyphBoundsAttr);

    this.colorAttr = new THREE.InstancedBufferAttribute(this.colorArray, 3);
    this.colorAttr.setUsage(THREE.DynamicDrawUsage);
    this.geometry.setAttribute("aColor", this.colorAttr);

    this.buildMaterial(material);
    this.count = 0;
  }

  /** Number of registered {@link Text} members. */
  get memberCount() {
    return this._memberCount;
  }

  buildMaterial(material) {
    const sdfTex = texture(this.atlas.texture);
    const aGlyphUV = attribute("aGlyphUV", "vec4");
    const aGlyphBounds = attribute("aGlyphBounds", "vec4");
    const aColor = attribute("aColor", "vec3");
    const outlineWidth = uniform(this.outlineWidth);

    const quadUV = uv();
    material.positionNode = Fn(() => {
      const st = quadUV;
      return vec3(
        mix(aGlyphBounds.x, aGlyphBounds.z, st.x),
        mix(aGlyphBounds.y, aGlyphBounds.w, st.y),
        float(0),
      );
    })();

    const atlasUV = vec4(
      aGlyphUV.x.add(quadUV.x.mul(aGlyphUV.z)),
      aGlyphUV.y.add(float(1).sub(quadUV.y).mul(aGlyphUV.w)),
      0,
      0,
    );

    const sdfValue = sdfTex.sample(atlasUV.xy).r;
    const edge = float(0.5);
    const aaWidth = fwidth(sdfValue).mul(0.5);

    const fillAlpha = smoothstep(
      edge.sub(aaWidth),
      edge.add(aaWidth),
      sdfValue,
    );

    const outlineEdge = edge.sub(outlineWidth);
    const outlineAlpha = smoothstep(
      outlineEdge.sub(aaWidth),
      outlineEdge.add(aaWidth),
      sdfValue,
    );
    const outlineOnly = max(outlineAlpha.sub(fillAlpha), float(0));

    const isBlank = aGlyphUV.z.equal(float(0));
    const alpha = select(isBlank, float(0), max(fillAlpha, outlineOnly));

    material.colorNode = Fn(() => vec4(aColor, alpha))();
  }

  /**
   * Register a {@link Text} member. Returns member id, or -1 if at capacity.
   * @param {import('./Text.js').Text} text
   * @returns {number}
   */
  addText(text) {
    if (this._memberCount >= this._maxTextCount) return -1;

    const id = this._memberCount++;
    this._members[id] = text;
    text._batchedText = this;

    const c = text.color;
    this._memberGlyphs[id] = { glyphStart: 0, glyphCount: 0 };

    return id;
  }

  /**
   * @param {import('./Text.js').Text} text
   */
  removeText(text) {
    const id = this._members.indexOf(text);
    if (id < 0) return;

    this._members[id] = null;
    text._batchedText = null;

    if (id === this._memberCount - 1) {
      this._memberCount--;
    }
  }

  /**
   * @param {number} memberId
   * @returns {import('./Text.js').Text | null}
   */
  getTextAt(memberId) {
    return this._members[memberId] ?? null;
  }

  setColorAt(memberId, color) {
    const text = this._members[memberId];
    if (!text) return;

    if (color instanceof THREE.Color) {
      text.color.copy(color);
    } else {
      text.color.set(color);
    }

    const { glyphStart, glyphCount } = this._memberGlyphs[memberId] ?? {};
    if (!glyphCount) return;

    const c = text.color;
    for (let g = glyphStart; g < glyphStart + glyphCount; g++) {
      this.colorArray[g * 3] = c.r;
      this.colorArray[g * 3 + 1] = c.g;
      this.colorArray[g * 3 + 2] = c.b;
    }
    this.colorAttr.needsUpdate = true;
  }

  /**
   * Set member transform when {@code memberId} is a registered text member;
   * otherwise delegates to {@link THREE.InstancedMesh.setMatrixAt} (glyph instance).
   * @param {number} memberId
   * @param {THREE.Matrix4} matrix
   */
  setMatrixAt(memberId, matrix) {
    const text =
      memberId < this._memberCount ? this._members[memberId] : null;
    if (!text) {
      super.setMatrixAt(memberId, matrix);
      return this;
    }

    text.matrixWorld.copy(matrix);

    const info = text.textRenderInfo;
    const { glyphStart, glyphCount } = this._memberGlyphs[memberId] ?? {};
    if (!info || !glyphCount) return this;

    this._writeGlyphMatrices(text, info, glyphStart, glyphCount);
    if (this.instanceMatrix) this.instanceMatrix.needsUpdate = true;
    return this;
  }

  /**
   * @param {import('./Text.js').Text} text
   * @param {import('./TextBuilder.js').TextRenderInfo} info
   * @param {number} glyphStart
   * @param {number} glyphCount
   */
  _writeGlyphMatrices(text, info, glyphStart, glyphCount) {
    const world = text.matrixWorld;

    for (let g = 0; g < glyphCount; g++) {
      super.setMatrixAt(glyphStart + g, world);
    }
  }

  sync(callback, _renderer) {
    const chars = new Set();
    for (let m = 0; m < this._memberCount; m++) {
      const t = this._members[m];
      if (!t) continue;
      t.sync();
      const info = t.textRenderInfo;
      if (!info) continue;
      for (const g of info.glyphs) {
        if (g.char && g.char !== " ") chars.add(g.char);
      }
    }
    this.atlas.ensureGlyphs(chars);

    let glyphIndex = 0;
    const c = new THREE.Color();

    for (let m = 0; m < this._memberCount; m++) {
      const t = this._members[m];
      if (!t) continue;

      const info = t.textRenderInfo;
      if (!info) continue;

      const glyphStart = glyphIndex;
      const glyphCount = info.glyphCount;

      if (glyphIndex + glyphCount > this._maxGlyphCount) {
        console.warn(
          `BatchedText: maxGlyphCount (${this._maxGlyphCount}) exceeded; truncating.`,
        );
        break;
      }

      this._memberGlyphs[m] = { glyphStart, glyphCount };
      t.updateMatrixWorld();

      this._writeGlyphMatrices(t, info, glyphStart, glyphCount);

      c.copy(t.color);
      for (let g = 0; g < glyphCount; g++) {
        const gi = glyphStart + g;
        const glyph = info.glyphs[g];
        const bi = g * 4;

        if (glyph.char && glyph.char !== " ") {
          const uvRect = this.atlas.getGlyph(glyph.char);

          // Sample only the ink region of the atlas tile (the glyph is rasterized
          // centered in a padded cell). The quad is the ink box too, so ink maps
          // to ink 1:1 and glyphs aren't individually stretched.
          const vbRaw = uvRect.viewBox ?? [0, 0, 1, 1];
          const vb =
            vbRaw[2] > vbRaw[0] && vbRaw[3] > vbRaw[1]
              ? vbRaw
              : [0, 0, 1, 1];

          // Grow quad and sampled sub-rect by the SAME fraction of their own size
          // so the mapping stays ink↔ink, while revealing the SDF margin around the
          // ink that the outline/AA halo lives in (otherwise it gets clipped).
          const pad = GLYPH_QUAD_PAD;
          const bx0 = info.glyphBounds[bi];
          const by0 = info.glyphBounds[bi + 1];
          const bx1 = info.glyphBounds[bi + 2];
          const by1 = info.glyphBounds[bi + 3];
          const bw = bx1 - bx0;
          const bh = by1 - by0;
          this.glyphBoundsArray[gi * 4] = bx0 - bw * pad;
          this.glyphBoundsArray[gi * 4 + 1] = by0 - bh * pad;
          this.glyphBoundsArray[gi * 4 + 2] = bx1 + bw * pad;
          this.glyphBoundsArray[gi * 4 + 3] = by1 + bh * pad;

          const vbw = vb[2] - vb[0];
          const vbh = vb[3] - vb[1];
          const su0 = Math.max(0, vb[0] - vbw * pad);
          const sv0 = Math.max(0, vb[1] - vbh * pad);
          const su1 = Math.min(1, vb[2] + vbw * pad);
          const sv1 = Math.min(1, vb[3] + vbh * pad);

          this.glyphUVArray[gi * 4] = uvRect.u + su0 * uvRect.w;
          this.glyphUVArray[gi * 4 + 1] = uvRect.v + sv0 * uvRect.h;
          this.glyphUVArray[gi * 4 + 2] = (su1 - su0) * uvRect.w;
          this.glyphUVArray[gi * 4 + 3] = (sv1 - sv0) * uvRect.h;
        } else {
          this.glyphBoundsArray[gi * 4] = info.glyphBounds[bi];
          this.glyphBoundsArray[gi * 4 + 1] = info.glyphBounds[bi + 1];
          this.glyphBoundsArray[gi * 4 + 2] = info.glyphBounds[bi + 2];
          this.glyphBoundsArray[gi * 4 + 3] = info.glyphBounds[bi + 3];

          this.glyphUVArray[gi * 4] = 0;
          this.glyphUVArray[gi * 4 + 1] = 0;
          this.glyphUVArray[gi * 4 + 2] = 0;
          this.glyphUVArray[gi * 4 + 3] = 0;
        }

        this.colorArray[gi * 3] = c.r;
        this.colorArray[gi * 3 + 1] = c.g;
        this.colorArray[gi * 3 + 2] = c.b;

        glyphIndex++;
      }
    }

    this._glyphCount = glyphIndex;
    this.count = this._glyphCount;

    this.glyphUVAttr.needsUpdate = true;
    this.glyphBoundsAttr.needsUpdate = true;
    this.colorAttr.needsUpdate = true;
    if (this.instanceMatrix) this.instanceMatrix.needsUpdate = true;

    callback?.();
  }
}
