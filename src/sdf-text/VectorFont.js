import * as opentypeNS from "opentype.js";

// opentype.js ships as UMD; the ESM interop surfaces the API on `default`.
const opentype = opentypeNS.default ?? opentypeNS;

/**
 * Parsed font with real typographic metrics and kerning — clean-room
 * counterpart to three-blocks TextBuilder's font layer.
 *
 * Metrics come straight from the font tables (OS/2 typo, hhea, hmtx, kern/GPOS)
 * via opentype.js — no hardcoded ascender/descender guesses.
 *
 * Note: opentype.js parses TrueType/OpenType/WOFF. WOFF2 (brotli) is NOT
 * supported; use a `.ttf`/`.otf`/`.woff` source.
 */
export class VectorFont {
  /**
   * @param {import('opentype.js').Font} font
   * @param {string} [src] Source URL/label for cache keying.
   */
  constructor(font, src = "") {
    this.font = font;
    this.src = src;
    this.unitsPerEm = font.unitsPerEm;

    const os2 = font.tables.os2;
    const hhea = font.tables.hhea;

    // Prefer OS/2 typographic metrics (the font designer's intended line
    // metrics); fall back to hhea, then opentype's own derived values.
    this.ascender =
      (os2 && os2.sTypoAscender) || (hhea && hhea.ascender) || font.ascender;
    this.descender =
      (os2 && os2.sTypoDescender) || (hhea && hhea.descender) || font.descender;
    this.lineGap =
      (os2 && os2.sTypoLineGap) || (hhea && hhea.lineGap) || 0;

    this.capHeight = (os2 && os2.sCapHeight) || 0;
    this.xHeight = (os2 && os2.sxHeight) || 0;

    /** @type {Map<string, import('opentype.js').Glyph | null>} */
    this._glyphCache = new Map();
  }

  /**
   * Load and parse a font from a URL, ArrayBuffer, or typed-array view.
   * @param {string | ArrayBuffer | ArrayBufferView} source
   * @returns {Promise<VectorFont>}
   */
  static async load(source) {
    let buffer;
    let src = "";
    if (source instanceof ArrayBuffer) {
      buffer = source;
    } else if (ArrayBuffer.isView(source)) {
      buffer = source.buffer.slice(
        source.byteOffset,
        source.byteOffset + source.byteLength,
      );
    } else {
      src = String(source);
      const res = await fetch(src);
      if (!res.ok) {
        throw new Error(`VectorFont: failed to fetch ${src}: ${res.status}`);
      }
      buffer = await res.arrayBuffer();
    }
    const font = opentype.parse(buffer);
    return new VectorFont(font, src);
  }

  /**
   * @param {string} char
   * @returns {import('opentype.js').Glyph | null}
   */
  glyphForChar(char) {
    let g = this._glyphCache.get(char);
    if (g === undefined) {
      g = this.font.charToGlyph(char) || null;
      this._glyphCache.set(char, g);
    }
    return g;
  }

  /** Horizontal advance (font units) for a character. */
  advanceWidth(char) {
    const g = this.glyphForChar(char);
    return g ? g.advanceWidth : 0;
  }

  /** Ink bounding box (font units, Y-up) or null for blank glyphs. */
  boundingBox(char) {
    const g = this.glyphForChar(char);
    if (!g) return null;
    const b = g.getBoundingBox();
    if (!(b.x2 > b.x1 && b.y2 > b.y1)) return null;
    return b;
  }

  /** Kerning adjustment (font units) between two adjacent characters. */
  kerning(leftChar, rightChar) {
    const l = this.glyphForChar(leftChar);
    const r = this.glyphForChar(rightChar);
    if (!l || !r) return 0;
    return this.font.getKerningValue(l, r);
  }
}
