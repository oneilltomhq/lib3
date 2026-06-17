import * as THREE from "three/webgpu";
import {
  texture,
  uv,
  smoothstep,
  attribute,
  Fn,
  vec4,
  float,
  select,
  fwidth,
  max,
  uniform,
} from "three/tsl";
import { FontAtlas } from "./FontAtlas.js";

/**
 * Instanced SDF text renderer. Atlas SDFs are built on CPU when glyphs are
 * first requested; fragment shading uses TSL with screen-space fwidth() AA.
 */
export class BatchedText extends THREE.InstancedMesh {
  constructor(maxCount, _maxChars, _baseMaterial, options = {}) {
    const plane = new THREE.PlaneGeometry(1, 1);
    const material = new THREE.NodeMaterial();
    material.transparent = true;
    material.depthWrite = false;
    material.side = THREE.DoubleSide;

    super(plane, material, maxCount);

    this.outlineWidth = options.outlineWidth ?? 0.03;
    this.atlas = new FontAtlas(
      options.fontFamily,
      options.fontSize,
      options.atlasSize,
    );
    this.texts = new Array(maxCount).fill(null);
    this.count_ = 0;

    this.glyphUVArray = new Float32Array(maxCount * 4);
    this.colorArray = new Float32Array(maxCount * 3);

    this.glyphUVAttr = new THREE.InstancedBufferAttribute(this.glyphUVArray, 4);
    this.glyphUVAttr.setUsage(THREE.DynamicDrawUsage);
    this.geometry.setAttribute("aGlyphUV", this.glyphUVAttr);

    this.colorAttr = new THREE.InstancedBufferAttribute(this.colorArray, 3);
    this.colorAttr.setUsage(THREE.DynamicDrawUsage);
    this.geometry.setAttribute("aColor", this.colorAttr);

    this.buildMaterial(material);
  }

  buildMaterial(material) {
    const sdfTex = texture(this.atlas.texture);
    const aGlyphUV = attribute("aGlyphUV", "vec4");
    const aColor = attribute("aColor", "vec3");
    const outlineWidth = uniform(this.outlineWidth);

    const quadUV = uv();
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
    const alpha = select(
      isBlank,
      float(0),
      max(fillAlpha, outlineOnly),
    );

    material.colorNode = Fn(() => vec4(aColor, alpha))();
  }

  addText(text) {
    const id = this.count_++;
    this.texts[id] = text;
    this.count = this.count_;

    this.setMatrixAt(id, text.matrixWorld);

    const c = text.color;
    this.colorArray[id * 3] = c.r;
    this.colorArray[id * 3 + 1] = c.g;
    this.colorArray[id * 3 + 2] = c.b;

    return id;
  }

  setColorAt(id, color) {
    this.colorArray[id * 3] = color.r;
    this.colorArray[id * 3 + 1] = color.g;
    this.colorArray[id * 3 + 2] = color.b;
    this.colorAttr.needsUpdate = true;
  }

  sync(callback, _renderer) {
    const chars = new Set();
    for (let i = 0; i < this.count_; i++) {
      const t = this.texts[i];
      if (t && t.text && t.text !== " ") {
        chars.add(t.text);
      }
    }
    this.atlas.ensureGlyphs(chars);

    for (let i = 0; i < this.count_; i++) {
      const t = this.texts[i];
      if (!t) continue;

      this.setMatrixAt(i, t.matrixWorld);

      if (t.text && t.text !== " ") {
        const m = this.atlas.getGlyph(t.text);
        this.glyphUVArray[i * 4] = m.u;
        this.glyphUVArray[i * 4 + 1] = m.v;
        this.glyphUVArray[i * 4 + 2] = m.w;
        this.glyphUVArray[i * 4 + 3] = m.h;
      } else {
        this.glyphUVArray[i * 4] = 0;
        this.glyphUVArray[i * 4 + 1] = 0;
        this.glyphUVArray[i * 4 + 2] = 0;
        this.glyphUVArray[i * 4 + 3] = 0;
      }
    }

    this.glyphUVAttr.needsUpdate = true;
    this.colorAttr.needsUpdate = true;
    if (this.instanceMatrix) this.instanceMatrix.needsUpdate = true;

    if (callback) callback();
  }
}
