# sdf-text typography — parked follow-ups

Reference, not a work queue. These are the deferred tiers after the v0.4.0
typography work (vector-SDF text path, font-ready atlas invalidation, canvas
resolution bump). None blocks current use; each is scoped here so the decision
and cost are recorded for whenever a real requirement surfaces.

Current state as of v0.4.0: canvas path (any system font, no assets) is the
default; opt-in vector path (`font:` URL) gives real font metrics + kerning via
opentype.js, bundled as an on-demand chunk. What the vector path does NOT yet do
is everything below.

## 1. GSUB ligatures / BiDi — script support

- **What:** GSUB = OpenType glyph substitution (ligatures like "fi"; Arabic/Indic
  positional shaping). BiDi = Unicode bidirectional algorithm for mixing RTL
  (Hebrew/Arabic) with LTR in one string. Current pipeline is one char → one
  glyph, left-to-right, kern pairs only.
- **What breaks today:** Latin ligatures render as separate letters (cosmetic).
  Hebrew renders reversed. Arabic renders as disconnected letter blobs —
  genuinely unreadable, not just ugly.
- **Cost:** Biggest item. Honest fix is HarfBuzz-wasm (~1MB) for shaping + a BiDi
  lib, and TextBuilder learning about runs/direction. Week-plus.
- **Verdict:** Pure function of audience. Latin/European: skip indefinitely.
  Any Arabic/Hebrew/Indic requirement: mandatory, nothing partial works.

## 2. Worker offload for SDF generation

- **What:** First appearance of a glyph rasterizes its outline at 256px + runs
  the EDT, synchronously on the main thread. A few ms/glyph; cached after.
- **What breaks today:** First render of a fresh scene with ~40 unique glyphs =
  one visible frame hitch (~50-150ms). Invisible for trickle-in text (chat).
- **Cost:** Moderate. Move raster+EDT to a Web Worker; glyphs arrive async, atlas
  fills in, text pops from blank to rendered. Async re-sync plumbing is the
  fiddly part. Couple of days.
- **Verdict:** Measure before building. Only worth it if a real scene-load jank
  shows up in a profile.

## 3. Atlas growth / eviction for CJK

- **What:** Atlas is a fixed 1024px texture, 64px tiles = 256 glyph slots. Slot
  257 warns and renders broken. Latin+digits+punct ≈ 100 glyphs. CJK uses
  thousands.
- **Cost:** Two routes — grow the texture (2048px = 1024 slots but 16MB float32,
  memory gets real) or LRU eviction (recycle offscreen glyph slots, needs
  refcounting from BatchedText members). Eviction is the right design; few days.
  Separate/harder: emoji are color glyphs, fundamentally don't fit monochrome SDF
  — different project entirely.
- **Verdict:** Only with a concrete CJK requirement. English/European UI never
  touches 256 slots.

## 4. WOFF2 support

- **What:** Modern webfont format (Brotli-compressed, ~30% smaller than WOFF).
  opentype.js can't read it (no Brotli), so the `font:` option needs
  TTF/OTF/WOFF today.
- **Cost:** Smallest item. Detect `wOF2` magic bytes in `VectorFont.load`,
  decompress to TTF via a wasm Brotli decoder (~200KB, lazy-loaded only when a
  woff2 font actually appears), feed the existing parser. ~a day.
- **Verdict:** We bundle our own font files, so we can just choose TTF and never
  hit this. Do it lazily the first time a woff2-only font shows up.

## Suggested priority when one surfaces

WOFF2 (cheapest) → worker offload (perf, only after profiling) → CJK atlas
growth → GSUB/BiDi (biggest, only meaningful with a real non-Latin requirement).
