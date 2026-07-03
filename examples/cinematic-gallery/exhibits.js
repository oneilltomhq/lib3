// examples/cinematic-gallery/exhibits.js
// The registry: what stands in the gallery. Pure data + factories — the room
// (main.js) decides layout, the runners (gallery.js) decide render budget.
//
//   mode  "object" — the real thing in the room, on a plinth; raymarch cost
//                    scales with pixels covered, so distance is its own LOD
//         "tv"     — offscreen render glued to a framed plane (for
//                    screen-native pieces, and films later)
//         "portal" — offscreen render sampled in screen space, a window
//   plaque — museum-label copy; HTML caption today, sdf-text plaque later

import { createFbmVolumeExhibit } from "./exhibits/fbm-volume.js";
import { createHeadExhibit } from "./exhibits/head.js";
import { createKnotExhibit } from "./exhibits/knot.js";
import { createLissajousExhibit } from "./exhibits/lissajous.js";
import { createMetaballsExhibit } from "./exhibits/metaballs.js";

export const EXHIBITS = [
  {
    id: "lissajous",
    title: "Lissajous Beam",
    plaque:
      "A 3D Lissajous figure drawn as a beam of 3,500 additive points, positioned and coloured entirely on the GPU — the sphere-knot preset, with ring modulation available in the standalone lab.",
    mode: "object",
    focusMargin: 1.5,
    make: createLissajousExhibit,
  },
  {
    id: "head",
    title: "Wave Head",
    plaque:
      "A 256×256×109 CT skull displaced by a spherical wave in a compute kernel, then raymarched as an average-intensity projection — a translucent volume you can walk around.",
    mode: "object",
    focusMargin: 1.35,
    make: createHeadExhibit,
  },
  {
    id: "fbm-volume",
    title: "Anisotropic fBm",
    plaque:
      "Ridged fBm baked into a 128³ texture by a compute pass and raymarched front-to-back with sample-time anisotropy and helical swirl. The field genuinely churns: every octave drifts in its own direction at its own speed. Shown in the ember preset. Step close — it is authored to be seen from near-inside.",
    mode: "object",
    focusMargin: 0.9,
    make: createFbmVolumeExhibit,
  },
  {
    id: "knot",
    title: "Knot Morph",
    plaque:
      "Torus-knot vertices carry their (3,5) counterpart as a second attribute; the vertex stage mixes between the two curves, so the morph costs nothing but a lerp. Step inside — strands mute within arm's reach and dim with depth, and the weave morphs around you.",
    mode: "object",
    focusMargin: 0.3, // camera lands at margin ≈ 1 × bounding sphere; well below 1 = inside
    make: createKnotExhibit,
  },
  {
    id: "metaballs",
    title: "Metaballs",
    plaque:
      "Smooth-min SDF spheres sphere-traced inside a glass box. The surface normal refracts a live render of the room behind it, and the hit depth is written back to the depth buffer so the glass composites truthfully with its neighbours.",
    mode: "object",
    focusMargin: 1.15,
    make: createMetaballsExhibit,
  },
];
