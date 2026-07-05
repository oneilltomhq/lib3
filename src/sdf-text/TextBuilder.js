/**
 * Synchronous text layout — clean-room counterpart to three-blocks TextBuilder.
 * Uses canvas metrics for glyph advances and bounding boxes (no troika/worker).
 */

/** Canvas metrics below ~6px are unreliable; measure at this size and scale. */
const MEASURE_FONT_PX = 64;

const _measureCanvas =
  typeof OffscreenCanvas !== "undefined" ? new OffscreenCanvas(8, 8) : null;

function getMeasureCtx(fontFamily, fontWeight, fontStyle) {
  if (!_measureCanvas) return null;
  const ctx = _measureCanvas.getContext("2d");
  ctx.font = `${fontStyle} ${fontWeight} ${MEASURE_FONT_PX}px ${fontFamily}`;
  return ctx;
}

function parseLineHeight(lineHeight, fontSize) {
  if (lineHeight === "normal") return fontSize * 1.2;
  const n = parseFloat(lineHeight);
  return Number.isFinite(n) ? n * fontSize : fontSize * 1.2;
}

function resolveAnchor(anchor, extent, axis) {
  if (typeof anchor === "number") return -anchor;
  if (axis === "x") {
    if (anchor === "left") return 0;
    if (anchor === "center") return -extent * 0.5;
    if (anchor === "right") return -extent;
  } else {
    if (anchor === "top") return -extent;
    if (anchor === "middle" || anchor === "center") return -extent * 0.5;
    if (anchor === "bottom") return 0;
  }
  return 0;
}

function breakLines(text, maxWidth, ctx, letterSpacing, scale) {
  if (!Number.isFinite(maxWidth) || maxWidth <= 0) {
    return text.split("\n");
  }

  const paragraphs = text.split("\n");
  const lines = [];

  for (const paragraph of paragraphs) {
    if (paragraph === "") {
      lines.push("");
      continue;
    }

    let line = "";
    let lineWidth = 0;
    const words = paragraph.split(/(\s+)/);

    for (const word of words) {
      const test = line + word;
      const w = measureRunWidth(ctx, test, letterSpacing, scale);
      if (line && w > maxWidth) {
        lines.push(line);
        line = word.trimStart();
        lineWidth = measureRunWidth(ctx, line, letterSpacing, scale);
      } else {
        line = test;
        lineWidth = w;
      }
    }
  if (line.length > 0 || paragraph === "") lines.push(line);
  }

  return lines.length ? lines : [""];
}

function measureRunWidth(ctx, str, letterSpacing, scale) {
  if (!str) return 0;
  if (!ctx) return str.length * 0.6 * scale;
  let w = 0;
  for (let i = 0; i < str.length; i++) {
    w += ctx.measureText(str[i]).width * scale;
    if (i < str.length - 1) w += letterSpacing;
  }
  return w;
}

/**
 * Layout a string into per-glyph axis-aligned bounds in text-local space (Y-up).
 *
 * @param {object} params
 * @param {string} params.text
 * @param {number} [params.fontSize]
 * @param {string} [params.fontFamily]
 * @param {string} [params.fontWeight]
 * @param {string} [params.fontStyle]
 * @param {number} [params.letterSpacing]
 * @param {string|number} [params.lineHeight]
 * @param {number|string} [params.anchorX]
 * @param {number|string} [params.anchorY]
 * @param {string} [params.textAlign]
 * @param {number} [params.maxWidth]
 * @returns {import('./TextBuilder.js').TextRenderInfo}
 */
export function layoutText(params) {
  const {
    text = "",
    fontSize = 1,
    fontFamily = "monospace",
    fontWeight = "normal",
    fontStyle = "normal",
    letterSpacing = 0,
    lineHeight = "normal",
    anchorX = 0,
    anchorY = 0,
    textAlign = "left",
    maxWidth = Infinity,
  } = params;

  const ctx = getMeasureCtx(fontFamily, fontWeight, fontStyle);
  const scale = fontSize / MEASURE_FONT_PX;
  const lineAdvance = parseLineHeight(lineHeight, fontSize);
  const lines = breakLines(text, maxWidth, ctx, letterSpacing, scale);

  /** @type {{ char: string, bounds: number[] }[]} */
  const glyphs = [];
  let blockMinX = Infinity;
  let blockMinY = Infinity;
  let blockMaxX = -Infinity;
  let blockMaxY = -Infinity;

  let baselineY = 0;

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const line = lines[lineIndex];
    const lineWidth = ctx ? measureRunWidth(ctx, line, letterSpacing, scale) : 0;

    let alignOffset = 0;
    if (textAlign === "center") alignOffset = (maxWidth - lineWidth) * 0.5;
    else if (textAlign === "right") alignOffset = maxWidth - lineWidth;

    let penX = alignOffset;

    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      const metrics = ctx?.measureText(ch);
      const charWidth = (metrics?.width ?? MEASURE_FONT_PX * 0.6) * scale;
      const advance = charWidth + letterSpacing;

      let minX;
      let maxX;
      let minY;
      let maxY;

      if (metrics && ch !== " ") {
        // True ink bounding box (matches the atlas glyph ink), so the quad and the
        // sampled atlas sub-rect describe the same shape — no per-glyph stretching.
        const left = (metrics.actualBoundingBoxLeft ?? 0) * scale;
        const right =
          (metrics.actualBoundingBoxRight ?? metrics.width) * scale;
        const ascent =
          (metrics.actualBoundingBoxAscent ?? MEASURE_FONT_PX * 0.8) * scale;
        const descent =
          (metrics.actualBoundingBoxDescent ?? MEASURE_FONT_PX * 0.2) * scale;
        minX = penX - left;
        maxX = penX + right;
        minY = baselineY - descent;
        maxY = baselineY + ascent;
      } else {
        minX = penX;
        maxX = penX + charWidth;
        minY = baselineY - fontSize * 0.2;
        maxY = baselineY + fontSize * 0.8;
      }

      glyphs.push({ char: ch, bounds: [minX, minY, maxX, maxY] });

      blockMinX = Math.min(blockMinX, minX);
      blockMinY = Math.min(blockMinY, minY);
      blockMaxX = Math.max(blockMaxX, maxX);
      blockMaxY = Math.max(blockMaxY, maxY);

      penX += advance;
    }

    baselineY -= lineAdvance;
  }

  if (!glyphs.length) {
    blockMinX = blockMinY = blockMaxX = blockMaxY = 0;
  }

  const blockWidth = blockMaxX - blockMinX;
  const blockHeight = blockMaxY - blockMinY;
  const offsetX = resolveAnchor(anchorX, blockWidth, "x") - blockMinX;
  const offsetY = resolveAnchor(anchorY, blockHeight, "y") - blockMinY;

  const glyphBounds = new Float32Array(glyphs.length * 4);
  for (let i = 0; i < glyphs.length; i++) {
    const b = glyphs[i].bounds;
    glyphBounds[i * 4] = b[0] + offsetX;
    glyphBounds[i * 4 + 1] = b[1] + offsetY;
    glyphBounds[i * 4 + 2] = b[2] + offsetX;
    glyphBounds[i * 4 + 3] = b[3] + offsetY;
  }

  const anchoredMinX = blockMinX + offsetX;
  const anchoredMinY = blockMinY + offsetY;
  const anchoredMaxX = blockMaxX + offsetX;
  const anchoredMaxY = blockMaxY + offsetY;

  return {
    parameters: { ...params },
    glyphBounds,
    glyphs,
    glyphCount: glyphs.length,
    blockBounds: [anchoredMinX, anchoredMinY, anchoredMaxX, anchoredMaxY],
    visibleBounds: [anchoredMinX, anchoredMinY, anchoredMaxX, anchoredMaxY],
    lineHeight: lineAdvance,
    ascender: fontSize * 0.8,
    descender: -fontSize * 0.2,
  };
}

/** Empty layout result — used while a vector font is still loading. */
export function emptyRenderInfo(params = {}) {
  return {
    parameters: { ...params },
    glyphBounds: new Float32Array(0),
    glyphs: [],
    glyphCount: 0,
    blockBounds: [0, 0, 0, 0],
    visibleBounds: [0, 0, 0, 0],
    lineHeight: 0,
    ascender: 0,
    descender: 0,
  };
}

// ── Vector layout (real font metrics via VectorFont) ────────────────────────

function vecLineAdvance(lineHeight, font, fontSize) {
  const scale = fontSize / font.unitsPerEm;
  const natural = (font.ascender - font.descender + font.lineGap) * scale;
  if (lineHeight === "normal" || lineHeight == null) return natural;
  const n = parseFloat(lineHeight);
  return Number.isFinite(n) ? n * fontSize : natural;
}

/** Advance width of a run in text units, including kerning + letter spacing. */
function vecMeasureRun(font, str, letterSpacing, scale) {
  let w = 0;
  for (let i = 0; i < str.length; i++) {
    w += font.advanceWidth(str[i]) * scale;
    if (i < str.length - 1) {
      w += font.kerning(str[i], str[i + 1]) * scale + letterSpacing;
    }
  }
  return w;
}

function vecBreakLines(text, maxWidth, font, letterSpacing, scale) {
  if (!Number.isFinite(maxWidth) || maxWidth <= 0) return text.split("\n");

  const paragraphs = text.split("\n");
  const lines = [];

  for (const paragraph of paragraphs) {
    if (paragraph === "") {
      lines.push("");
      continue;
    }
    let line = "";
    const words = paragraph.split(/(\s+)/);
    for (const word of words) {
      const test = line + word;
      const w = vecMeasureRun(font, test, letterSpacing, scale);
      if (line && w > maxWidth) {
        lines.push(line);
        line = word.trimStart();
      } else {
        line = test;
      }
    }
    if (line.length > 0 || paragraph === "") lines.push(line);
  }

  return lines.length ? lines : [""];
}

/**
 * Layout a string using true font metrics: unitsPerEm scaling, advances from
 * hmtx, kerning from kern/GPOS pairs, and ascender/descender from OS-2/hhea.
 * Produces the same {@link TextRenderInfo} shape as {@link layoutText}, so
 * {@link BatchedText} consumes it unchanged.
 *
 * @param {object} params
 * @param {import('./VectorFont.js').VectorFont} params.font
 * @param {string} [params.text]
 * @param {number} [params.fontSize]
 * @param {number} [params.letterSpacing]
 * @param {string|number} [params.lineHeight]
 * @param {number|string} [params.anchorX]
 * @param {number|string} [params.anchorY]
 * @param {string} [params.textAlign]
 * @param {number} [params.maxWidth]
 * @returns {TextRenderInfo}
 */
export function layoutTextVector(params) {
  const {
    font,
    text = "",
    fontSize = 1,
    letterSpacing = 0,
    lineHeight = "normal",
    anchorX = 0,
    anchorY = 0,
    textAlign = "left",
    maxWidth = Infinity,
  } = params;

  if (!font) return emptyRenderInfo(params);

  const scale = fontSize / font.unitsPerEm;
  const ascender = font.ascender * scale;
  const descender = font.descender * scale;
  const lineAdvance = vecLineAdvance(lineHeight, font, fontSize);
  const lines = vecBreakLines(text, maxWidth, font, letterSpacing, scale);

  /** @type {{ char: string, bounds: number[] }[]} */
  const glyphs = [];
  let blockMinX = Infinity;
  let blockMinY = Infinity;
  let blockMaxX = -Infinity;
  let blockMaxY = -Infinity;

  let baselineY = 0;

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const line = lines[lineIndex];
    const lineWidth = vecMeasureRun(font, line, letterSpacing, scale);

    let alignOffset = 0;
    if (textAlign === "center") alignOffset = (maxWidth - lineWidth) * 0.5;
    else if (textAlign === "right") alignOffset = maxWidth - lineWidth;

    let penX = alignOffset;

    for (let i = 0; i < line.length; i++) {
      const ch = line[i];

      // Kerning tucks the current glyph toward the previous one.
      if (i > 0) penX += font.kerning(line[i - 1], ch) * scale;

      const advance = font.advanceWidth(ch) * scale;
      const bbox = ch === " " ? null : font.boundingBox(ch);

      let minX;
      let maxX;
      let minY;
      let maxY;

      if (bbox) {
        // True ink bounding box (Y-up), matching the atlas glyph's ink so the
        // quad and sampled sub-rect describe the same shape (no stretching).
        minX = penX + bbox.x1 * scale;
        maxX = penX + bbox.x2 * scale;
        minY = baselineY + bbox.y1 * scale;
        maxY = baselineY + bbox.y2 * scale;
      } else {
        minX = penX;
        maxX = penX + advance;
        minY = baselineY + descender;
        maxY = baselineY + ascender;
      }

      glyphs.push({ char: ch, bounds: [minX, minY, maxX, maxY] });

      blockMinX = Math.min(blockMinX, minX);
      blockMinY = Math.min(blockMinY, minY);
      blockMaxX = Math.max(blockMaxX, maxX);
      blockMaxY = Math.max(blockMaxY, maxY);

      penX += advance + letterSpacing;
    }

    baselineY -= lineAdvance;
  }

  if (!glyphs.length) {
    blockMinX = blockMinY = blockMaxX = blockMaxY = 0;
  }

  const blockWidth = blockMaxX - blockMinX;
  const blockHeight = blockMaxY - blockMinY;
  const offsetX = resolveAnchor(anchorX, blockWidth, "x") - blockMinX;
  const offsetY = resolveAnchor(anchorY, blockHeight, "y") - blockMinY;

  const glyphBounds = new Float32Array(glyphs.length * 4);
  for (let i = 0; i < glyphs.length; i++) {
    const b = glyphs[i].bounds;
    glyphBounds[i * 4] = b[0] + offsetX;
    glyphBounds[i * 4 + 1] = b[1] + offsetY;
    glyphBounds[i * 4 + 2] = b[2] + offsetX;
    glyphBounds[i * 4 + 3] = b[3] + offsetY;
  }

  const anchoredMinX = blockMinX + offsetX;
  const anchoredMinY = blockMinY + offsetY;
  const anchoredMaxX = blockMaxX + offsetX;
  const anchoredMaxY = blockMaxY + offsetY;

  return {
    parameters: { ...params },
    glyphBounds,
    glyphs,
    glyphCount: glyphs.length,
    blockBounds: [anchoredMinX, anchoredMinY, anchoredMaxX, anchoredMaxY],
    visibleBounds: [anchoredMinX, anchoredMinY, anchoredMaxX, anchoredMaxY],
    lineHeight: lineAdvance,
    ascender,
    descender,
  };
}

/**
 * @typedef {object} TextRenderInfo
 * @property {object} parameters
 * @property {Float32Array} glyphBounds
 * @property {{ char: string, bounds: number[] }[]} glyphs
 * @property {number} glyphCount
 * @property {number[]} blockBounds
 * @property {number[]} visibleBounds
 * @property {number} lineHeight
 * @property {number} ascender
 * @property {number} descender
 */
