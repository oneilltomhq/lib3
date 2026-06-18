import * as THREE from "three/webgpu";
import { layoutText } from "./TextBuilder.js";

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

  _needsSync = true;
  _textRenderInfo = null;
  _batchedText = null;

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

    this._textRenderInfo = layoutText({
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
    });

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
