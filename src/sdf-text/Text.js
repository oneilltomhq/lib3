import * as THREE from "three/webgpu";
import {
  layoutText,
  layoutTextVector,
  emptyRenderInfo,
} from "./TextBuilder.js";

const LAYOUT_DEFAULTS = {
  text: "",
  fontSize: 1,
  fontFamily: "monospace",
  fontWeight: "normal",
  fontStyle: "normal",
  letterSpacing: 0,
  lineHeight: "normal",
  anchorX: 0,
  anchorY: 0,
  textAlign: "left",
  maxWidth: Infinity,
};

/**
 * SDF text member — layout via {@link layoutText}, render through {@link BatchedText}.
 * API surface aligned with @three-blocks/core Text (layout + sync), without troika/Mesh.
 */
export class Text extends THREE.Object3D {
  color = new THREE.Color(0xffffff);

  _opacity = 1;
  _needsSync = true;
  _textRenderInfo = null;
  _batchedText = null;
  _memberId = -1;

  /** Vector-outline mode: layout uses real font metrics instead of canvas.
   * Both are set by the owning {@link BatchedText}. */
  _vectorMode = false;
  /** @type {import('./VectorFont.js').VectorFont | null} */
  _vectorFont = null;

  constructor() {
    super();
    for (const [key, value] of Object.entries(LAYOUT_DEFAULTS)) {
      this[`_${key}`] = value;
    }
  }

  /** @type {import('./TextBuilder.js').TextRenderInfo | null} */
  get textRenderInfo() {
    return this._textRenderInfo;
  }

  /** Whole-text opacity (0..1). Doesn't trigger re-layout; writes through to
   * the owning {@link BatchedText}'s per-glyph opacity attribute when batched. */
  get opacity() {
    return this._opacity;
  }

  set opacity(value) {
    if (this._opacity === value) return;
    this._opacity = value;
    if (this._batchedText && this._memberId >= 0) {
      this._batchedText.setOpacityAt(this._memberId, value);
    }
  }

  /**
   * Layout glyphs and mark ready for batched rendering.
   * @param {Function} [callback]
   * @param {THREE.WebGPURenderer} [_renderer]
   */
  sync(callback, _renderer) {
    if (!this._needsSync && this._textRenderInfo) {
      callback?.();
      return;
    }

    const params = {
      text: this.text,
      fontSize: this.fontSize,
      fontFamily: this.fontFamily,
      fontWeight: this.fontWeight,
      fontStyle: this.fontStyle,
      letterSpacing: this.letterSpacing,
      lineHeight: this.lineHeight,
      anchorX: this.anchorX,
      anchorY: this.anchorY,
      textAlign: this.textAlign,
      maxWidth: this.maxWidth,
    };

    if (this._vectorMode) {
      if (!this._vectorFont) {
        // Font still loading — stay dirty so we re-layout once it arrives.
        this._textRenderInfo = emptyRenderInfo(params);
        callback?.();
        return;
      }
      this._textRenderInfo = layoutTextVector({
        ...params,
        font: this._vectorFont,
      });
    } else {
      this._textRenderInfo = layoutText(params);
    }

    this._needsSync = false;
    callback?.();
  }
}

for (const key of Object.keys(LAYOUT_DEFAULTS)) {
  Object.defineProperty(Text.prototype, key, {
    get() {
      return this[`_${key}`];
    },
    set(value) {
      if (this[`_${key}`] !== value) {
        this[`_${key}`] = value;
        this._needsSync = true;
      }
    },
  });
}
