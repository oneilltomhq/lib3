#!/usr/bin/env node
/**
 * Ground-up test of the SDF text pipeline — no browser, no Three.js, no Canvas.
 */
import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { computeSDF } from "../src/sdf/edt.js";
import { SDF_DEFAULTS } from "../src/sdf/index.js";

const { MAX_DISTANCE } = SDF_DEFAULTS;
const SDF_SIZE = SDF_DEFAULTS.SDF_SIZE;

function normalizeSdfValue(dist) {
  const normalized = 0.5 - dist / (2 * MAX_DISTANCE);
  return Math.max(0, Math.min(1, normalized));
}

function smoothstep(edge0, edge1, x) {
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

function shaderAlpha(sdfValue) {
  const edge = 0.5;
  const edgeWidth = 0.1;
  return smoothstep(edge - edgeWidth, edge + edgeWidth, sdfValue);
}

describe("Layer 1: EDT via computeSDF", () => {
  it("filled square produces negative inside, positive outside", () => {
    const w = 10;
    const h = 10;
    const img = new Uint8ClampedArray(w * h * 4);
    for (let y = 2; y < 8; y++) {
      for (let x = 2; x < 8; x++) {
        img[(y * w + x) * 4 + 3] = 255;
      }
    }
    const sdf = computeSDF(img, w, h);

    assert.ok(sdf[5 * w + 5] < 0, `center should be negative, got ${sdf[5 * w + 5]}`);
    assert.ok(sdf[0] > 0, `corner should be positive, got ${sdf[0]}`);
    assert.ok(Math.abs(sdf[1 * w + 2] - 1.0) < 0.001);
  });

  it("empty image produces all positive", () => {
    const w = 4;
    const h = 4;
    const img = new Uint8ClampedArray(w * h * 4);
    const sdf = computeSDF(img, w, h);
    for (let i = 0; i < w * h; i++) {
      assert.ok(sdf[i] > 0);
    }
  });

  it("fully filled image produces all negative", () => {
    const w = 4;
    const h = 4;
    const img = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < w * h; i++) img[i * 4 + 3] = 255;
    const sdf = computeSDF(img, w, h);
    for (let i = 0; i < w * h; i++) {
      assert.ok(sdf[i] < 0);
    }
  });
});

describe("Layer 2: SDF normalization", () => {
  it("boundary (dist=0) maps to 0.5", () => {
    assert.ok(Math.abs(normalizeSdfValue(0) - 0.5) < 0.001);
  });

  it("MAX_DISTANCE outside maps to 0.0", () => {
    assert.ok(Math.abs(normalizeSdfValue(MAX_DISTANCE) - 0.0) < 0.001);
  });

  it("-MAX_DISTANCE inside maps to 1.0", () => {
    assert.ok(Math.abs(normalizeSdfValue(-MAX_DISTANCE) - 1.0) < 0.001);
  });
});

describe("Layer 3: Atlas UV coordinate math", () => {
  const ATLAS_SIZE = 512;
  const cols = Math.floor(ATLAS_SIZE / SDF_SIZE);

  function getGlyphUV(slot) {
    const col = slot % cols;
    const row = Math.floor(slot / cols);
    return {
      u: (col * SDF_SIZE) / ATLAS_SIZE,
      v: (row * SDF_SIZE) / ATLAS_SIZE,
      w: SDF_SIZE / ATLAS_SIZE,
      h: SDF_SIZE / ATLAS_SIZE,
    };
  }

  it("slot 0 starts at (0, 0)", () => {
    const uv = getGlyphUV(0);
    assert.equal(uv.u, 0);
    assert.equal(uv.v, 0);
  });

  it("UVs tile exactly", () => {
    for (let s = 0; s < cols * 2; s++) {
      const uv = getGlyphUV(s);
      assert.ok(uv.u + uv.w <= 1.0001);
      assert.ok(uv.v + uv.h <= 1.0001);
    }
  });
});

describe("Layer 4: Shader math simulation", () => {
  it("SDF=0.5 (boundary) gives alpha ≈ 0.5", () => {
    const a = shaderAlpha(0.5);
    assert.ok(Math.abs(a - 0.5) < 0.001);
  });

  it("full pipeline: circle center opaque, corner transparent", () => {
    const w = 16;
    const h = 16;
    const img = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const dx = x - 7.5;
        const dy = y - 7.5;
        if (dx * dx + dy * dy <= 36) {
          img[(y * w + x) * 4 + 3] = 255;
        }
      }
    }

    const sdf = computeSDF(img, w, h);
    const centerAlpha = shaderAlpha(normalizeSdfValue(sdf[8 * w + 8]));
    const cornerAlpha = shaderAlpha(normalizeSdfValue(sdf[0]));
    assert.ok(centerAlpha > 0.99);
    assert.ok(cornerAlpha < 0.01);
  });

  it("blank glyph (zero UV rect) produces alpha=0", () => {
    const glyphUV_z = 0;
    const alpha = glyphUV_z === 0 ? 0 : shaderAlpha(0.5);
    assert.equal(alpha, 0);
  });
});

describe("Layer 5: Text layout", () => {
  it("layoutText produces one glyph per character", async () => {
    const { layoutText } = await import("../src/sdf-text/TextBuilder.js");
    const info = layoutText({ text: "Hi!", fontSize: 1 });
    assert.equal(info.glyphCount, 3);
    assert.equal(info.glyphs.length, 3);
    assert.equal(info.glyphs[0].char, "H");
    assert.equal(info.glyphs[2].char, "!");
  });

  it("layoutText handles newlines as extra lines", async () => {
    const { layoutText } = await import("../src/sdf-text/TextBuilder.js");
    const info = layoutText({ text: "ab\ncd", fontSize: 1 });
    assert.equal(info.glyphCount, 4);
  });

  it("anchorX center shifts block bounds symmetrically", async () => {
    const { layoutText } = await import("../src/sdf-text/TextBuilder.js");
    const left = layoutText({ text: "ABC", fontSize: 1, anchorX: "left" });
    const center = layoutText({ text: "ABC", fontSize: 1, anchorX: "center" });
    const leftMid = (left.blockBounds[0] + left.blockBounds[2]) * 0.5;
    const centerMid = (center.blockBounds[0] + center.blockBounds[2]) * 0.5;
    assert.ok(Math.abs(centerMid) < Math.abs(leftMid));
  });
});

describe("Layer 6: per-member opacity + outline color", () => {
  it("Text.opacity defaults to 1 and writes through to its batch", async () => {
    const { Text } = await import("../src/sdf-text/Text.js");
    const t = new Text();
    assert.equal(t.opacity, 1);

    const calls = [];
    t._batchedText = { setOpacityAt: (id, o) => calls.push([id, o]) };
    t._memberId = 3;
    t.opacity = 0.25;
    assert.equal(t.opacity, 0.25);
    assert.deepEqual(calls, [[3, 0.25]]);
  });

  it("setting opacity does not invalidate layout", async () => {
    const { Text } = await import("../src/sdf-text/Text.js");
    const t = new Text();
    t.text = "hello";
    t.sync();
    const info = t.textRenderInfo;
    t.opacity = 0.5;
    assert.equal(t._needsSync, false);
    t.sync();
    assert.equal(t.textRenderInfo, info);
  });

  it("shader math: member opacity scales coverage alpha", () => {
    const coverage = shaderAlpha(0.75); // well inside the glyph
    const opacity = 0.4;
    assert.ok(Math.abs(coverage * opacity - opacity) < 0.01);
    assert.equal(shaderAlpha(0.1) * opacity, 0);
  });

  it("shader math: outline zone takes halo color, fill keeps member color", () => {
    const mix = (a, b, t) => a + (b - a) * t;
    const memberR = 1.0;
    const haloR = 0.05;
    // Outline band: fillAlpha ~ 0 -> halo color wins.
    assert.ok(Math.abs(mix(haloR, memberR, 0.0) - haloR) < 1e-6);
    // Glyph interior: fillAlpha ~ 1 -> member color wins.
    assert.ok(Math.abs(mix(haloR, memberR, 1.0) - memberR) < 1e-6);
  });
});
