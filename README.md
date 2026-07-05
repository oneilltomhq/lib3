# @oneilltom/lib3

Composable TSL (Three.js Shading Language) nodes and utilities for Three.js
WebGPU. A collection of reusable shader building blocks for waves, morphing,
raymarching, and procedural effects.

## Features

- 🌊 **Wave Displacement** - Spherical wave displacement with simplex noise
  modulation
- 🔀 **Mesh Morphing** - Smooth position-based geometry morphing
- 🎯 **Raymarching** - Adaptive raymarching and volumetric rendering utilities
- ⚡ **Thunder Lightning** - Volumetric contained-lightning with fluid-driven filaments
- 🫧 **Metaballs** - Smooth-min SDF globules rendered with TSL raymarching
- 🔤 **SDF Text** - CPU glyph atlas + GPU instanced TSL text rendering
- 📺 **Hydra Chains** - Hydra video-synth patching idiom compiled to TSL, with
  feedback outputs and a transform registry lib3 nodes can join
- 🧩 **Composable** - Pure TSL nodes that compose naturally with Three.js WebGPU
- 📦 **Tree-shakeable** - Modular exports for optimal bundle size
- 🎨 **Example Gallery** - 13+ interactive examples showcasing different
  techniques

## Installation

```bash
pnpm add @oneilltom/lib3
```

Or with npm:

```bash
npm install @oneilltom/lib3
```

**Requirements:**

- Three.js >= 0.180.0 with WebGPU support
- Modern browser with WebGPU support

## Quick Start

```javascript
import * as THREE from "three/webgpu";
import { sphericalWaveDisplacement } from "@oneilltom/lib3/waves";
import { float, vec3 } from "three/tsl";

// Create material with wave displacement
const material = new THREE.MeshStandardNodeMaterial();
material.positionNode = sphericalWaveDisplacement({
  pos: positionGeometry,
  phase: float(time),
  waveAmplitude: float(0.2),
  noiseScale: float(1.0),
  noiseAmplitude: float(0.5),
  center: vec3(0, 0, 0),
});

const mesh = new THREE.Mesh(geometry, material);
scene.add(mesh);
```

## API Reference

### Waves (`@oneilltom/lib3/waves`)

#### `sphericalWaveDisplacement(options)`

Creates spherical wave displacement with noise modulation.

**Parameters:**

- `pos` - vec3: Position in local/object space
- `phase` - float: Animation phase (typically time-based)
- `waveAmplitude` - float: Base wave amplitude (default: 0.2)
- `noiseScale` - float: Scale of noise modulation (default: 1.0)
- `noiseAmplitude` - float: Amplitude of noise effect (default: 0.5)
- `center` - vec3: Center point of spherical waves (default: vec3(0))

**Returns:** vec3 displacement

#### `displacedTexCoord(options)`

Compute displaced sampling coordinates for texture space [0,1]³.

**Parameters:**

- `texCoord` - vec3: Original texture coordinate
- `phase`, `waveAmplitude`, `noiseScale`, `noiseAmplitude` - Same as above
- `scale` - float: Displacement scale factor (default: 0.1)

**Returns:** vec3 displaced coordinate

#### `buildSphericalWaveCopyKernel(options)`

Build a compute shader kernel for 3D texture displacement.

**Parameters:**

- `width`, `height`, `depth` - numbers: Texture dimensions
- `storageTexture` - StorageTextureNode: Output texture
- `sourceTextureNode` - TextureNode: Input texture
- `waveAmplitude`, `noiseScale`, `noiseAmplitude`, `phase` - uniforms
- `intensityScale` - uniform: Intensity multiplier (default: 1.0)

#### `simplexNoise3(v)`

High-quality 3D simplex noise function.

**Parameters:**

- `v` - vec3: Input position

**Returns:** float in [-1, 1]

### Morphing (`@oneilltom/lib3/knotMorph`)

#### `knotMorphPosition(options)`

Interpolate between geometry positions.

**Parameters:**

- `mixFactor` - float: Blend factor [0,1] (default: 0)

**Returns:** vec3 morphed position

**Usage:**

```javascript
// Add target positions as attribute
geometry.setAttribute(
  "targetPosition",
  new THREE.BufferAttribute(targetPositions, 3)
);

material.positionNode = knotMorphPosition({
  mixFactor: float(animationValue),
});
```

### Thunder (`@oneilltom/lib3/thunder`)

Volumetric contained-lightning effect driven by fluid simulation fields.

#### `createThunderNode(options)`

Creates a TSL raymarching node that renders lightning filaments inside a unit box.

**Parameters:**

- `densityTexture` - Data3DTexture: Fluid density texture
- `pressureTexture` - Data3DTexture: Fluid pressure texture
- `curlTexture` - Data3DTexture: Fluid curl texture
- `preset` - object: Initial uniform values (default: `THUNDER_PRESETS['Contained Cocoon']`)

**Returns:** `{ node, uniforms }` — the TSL node and all thunder uniforms

#### `createThunderStateMachine(uniforms, config?)`

Creates the JS state machine that drives charge build-up and stochastic flash discharge.

**Parameters:**

- `uniforms` - object: The uniforms returned by `createThunderNode`
- `config` - object: Optional preset config (default: Contained Cocoon)

**Returns:** `{ update(dt), triggerFlash(), setPreset(name) }`

#### `THUNDER_PRESETS`

Named parameter presets: `'Contained Cocoon'`, `'Silent Pressure'`, `'Caged Arc Storm'`, `'Overcharged Core'`

**Usage:**

```javascript
import { createThunderNode, createThunderStateMachine } from "@oneilltom/lib3/thunder";

const { node, uniforms } = createThunderNode({
  densityTexture: fluid.getDensityTexture3D(),
  pressureTexture: fluid.getPressureTexture3D(),
  curlTexture: fluid.getCurlTexture3D(),
});

const thunder = createThunderStateMachine(uniforms);
thunder.setPreset('Caged Arc Storm');

// In animation loop:
thunder.update(deltaTime);
```

### Raymarching (`@oneilltom/lib3`)

#### `adaptiveRaymarch(maxSteps, callback, threshold)`

Adaptive distance-field raymarching within a unit box [-0.5, 0.5]³.

**Parameters:**

- `maxSteps` - int: Maximum raymarch iterations
- `callback` - Function: `({ positionRay, maxStep }) => delta` distance function
- `threshold` - float: Hit detection threshold (default: 0.001)

**Returns:** Object with `{ positionRay, t, bounds, hit }`

#### `averageIntensityProjection(options)`

Average intensity projection for volumetric rendering.

**Parameters:**

- `texture` - Texture3DNode: 3D volume texture
- `steps` - int: Number of samples
- `intensityScale` - float: Intensity multiplier (default: 1.0)

**Returns:** vec4 color

### Metaballs (`@oneilltom/lib3/metaballs`)

#### `RaymarchedMetaballs(options)`

Creates a fitted screen-space quad that raymarches smooth-min sphere SDF
sources. Source positions and radii are synced from CPU objects each frame.
The renderer works in four stages: source spheres define signed distances,
smooth-min blends those distances, sphere tracing finds the surface along the
camera ray, and the hit normal drives refraction/fresnel shading.

**Parameters:**

- `camera` - PerspectiveCamera used for ray origin and quad fitting
- `sources` - Array of `{ position, radius }` objects
- `sceneTexture` - Texture sampled for refracted surface color
- `rimTexture` - Optional texture sampled for fresnel rim highlights
- `smoothing` - Smooth-min blend radius (default: 0.3)
- `maxSteps` - Maximum sphere-tracing iterations (default: 56)
- `hitThreshold` - Distance threshold for accepting a ray hit
- `debugMode` - One of `METABALL_DEBUG_MODES` (default: `BEAUTY`)
- `quadDistance` - Camera-space distance for the screen-facing proxy quad

**Usage:**

```javascript
import {
  METABALL_DEBUG_MODES,
  RaymarchedMetaballs,
} from "@oneilltom/lib3/metaballs";

const metaballs = new RaymarchedMetaballs({
  camera,
  sources,
  sceneTexture: previousFrameTarget.texture,
});

scene.add(metaballs.mesh);
metaballs.setDebugMode(METABALL_DEBUG_MODES.NORMAL);

function animate() {
  metaballs.update();
  renderer.render(scene, camera);
}
```

**Debug modes:**

- `BEAUTY` - final refracted/fresnel material
- `BACKGROUND` - raw scene texture sample before SDF shading
- `REFRACTED` - normal-offset scene texture sample before fresnel/rim
- `MASK` - ray hit mask
- `NORMAL` - encoded SDF normal
- `DEPTH` - hit distance within the fitted ray interval
- `STEPS` - sphere-tracing iteration heatmap
- `FRESNEL` - grazing-angle rim term
- `RIM` - rim texture contribution after fresnel and rim strength

#### `smoothMinSphereSdf(options)`

Builds a smooth-min sphere SDF node from uniform position/radius arrays.

#### `estimateSdfNormal(options)`

Estimates an SDF normal with central differences.

#### `raymarchSdf(options)`

Sphere-traces an SDF over a configurable ray interval. Returns hit state, hit
position, ray distance, step count, and final sampled distance.

### SDF (`@oneilltom/lib3/sdf`)

#### `computeSDF(imageData, width, height, alphaThreshold?)`

Felzenszwalb Euclidean distance transform on CPU. Returns signed distances
(negative inside glyph, positive outside).

#### `SDF_DEFAULTS`

Glyph atlas tuning constants (`GLYPH_SIZE`, `SDF_SIZE`, `MAX_DISTANCE`, etc.).

### SDF Text (`@oneilltom/lib3/sdf-text`)

Atlas SDFs are computed on CPU when glyphs are first requested; rendering uses
WebGPU TSL with instanced draws and `fwidth()` screen-space anti-aliasing.

#### `FontAtlas`

Rasterizes glyphs via `OffscreenCanvas`, runs `computeSDF`, uploads a
`DataTexture` float atlas.

#### `Text`

Layout member with `text`, `fontSize`, `anchorX`/`anchorY`, `letterSpacing`,
`maxWidth` (word-boundary wrapping), `opacity`, and `sync()`. Assign a full
string — layout expands to per-glyph bounds (clean-room counterpart to
`@three-blocks/core` Text layout API). Set `fontFamily` to the same family
the batch atlas rasterizes, or glyph ink gets stretched to mismatched
metrics (layout defaults to `monospace`).

#### `BatchedText`

Instanced mesh renderer. Each `addText(text)` member expands to N glyph quads
on `sync()`. Use `setMatrixAt(memberId, matrix)` for position-only updates,
`setColorAt(memberId, color)` / `setOpacityAt(memberId, o)` for per-member
styling without a re-sync. Options: `outlineWidth`, `outlineColor` (contrast
halo behind the fill; defaults to the fill color), `fontFamily`, `fontSize`,
`atlasSize`.

```javascript
import { BatchedText, Text } from "@oneilltom/lib3/sdf-text";

const batched = new BatchedText(64, 1024, undefined, {
  outlineWidth: 0.03,
  outlineColor: 0x05060a, // dark halo for legibility over bright scenes
});
scene.add(batched);

const label = new Text();
label.text = "Hello World";
label.fontSize = 1;
label.anchorX = "center";
label.anchorY = "middle";
scene.add(label);
batched.addText(label);

function animate() {
  label.updateMatrixWorld();
  batched.setMatrixAt(0, label.matrixWorld);
  batched.sync(); // only required when text content changes
  renderer.render(scene, camera);
}
```

### Hydra (`@oneilltom/lib3/hydra`)

The Hydra livecoding idiom over TSL: chains read outside-in
(`osc(10).rotate(0.4).modulate(src(o0), 0.02)`) and compile to a deferred
`(st) → vec4` node graph — coord transforms compose into the uv *before* the
source evaluates, same algorithm as hydra-synth's `generateGlsl()` but
emitting TSL instead of GLSL strings. Runs on WebGPU (WGSL) with automatic
WebGL (GLSL) fallback. Numeric args become live uniforms; function args
(`t => ...`) update per frame without recompile.

#### `HydraSynth({ renderer, width?, height?, outputs? })`

The runtime: N ping-pong feedback outputs plus the patch api. The renderer is
injected — create and init it yourself. `synth.api` exposes `osc, noise,
voronoi, gradient, solid, shape, src, o0..oN, render`. Per frame call
`synth.update(t)` (offscreen passes only, composite `oN.texNode` into your own
scene) or `synth.tick(t)` (update + fullscreen blit).

```javascript
import { WebGPURenderer } from "three/webgpu";
import { HydraSynth } from "@oneilltom/lib3/hydra";

const renderer = new WebGPURenderer({ canvas });
await renderer.init();
const synth = new HydraSynth({ renderer, width: 960, height: 540 });
const { osc, src, o0 } = synth.api;
osc(10, 0.1, 1).rotate(0.4).modulate(src(o0).scale(1.04), 0.02).out(o0);
// rAF: synth.tick(t)
```

#### `chainColorNode(chain, st?)`

Compile a chain straight to a colorNode for any node material — hydra patches
as surface textures, no synth required. Returns `{ node, updaters }`.

#### `registerTransform(name, { type, defaults, fn })`

Add a transform to the vocabulary (types: `src`, `coord`, `color`, `combine`,
`combineCoord`) — how lib3 nodes join hydra chains. `getTransforms()` lists
the registry.

#### `HydraOutput(width, height)`

A standalone ping-pong feedback buffer: `setChain(chain)`,
`updateUniforms(t)`, `render(renderer)`, `texNode` to sample. Slots into any
host loop (e.g. an exhibit runner).

### Rack (`@oneilltom/lib3/rack`)

The control plane — a modular-synth jack panel for a scene's parameters. Pure
JS. A `Rack` owns a flat address space (`/knot/roll`); params bind to live
state (TSL uniforms via `bindUniform`, journey values via
`bindKey`/`addValues`, any get/set pair). Every mutation flows through one
recorded dispatch channel, so sessions replay exactly and any moment can be
lifted back out as a snapshot.

```javascript
import { Rack, bindUniform } from "@oneilltom/lib3/rack";

const rack = new Rack();
rack.add("/knot/roll", bindUniform(uRoll), { min: 0, max: 2, unit: "rad/s" });
// per frame: rack.update(dt) — the render loop is the ramp clock

await rack.set("/knot/roll", 1.2, 2000); // glide over 2s (linear, clamped)
rack.pulse("/knot/hit", 90);             // momentary trigger
rack.params(); rack.get(path);           // introspection
rack.snap("tuned"); await rack.apply("tuned"); // snapshots: the unit of keeping
rack.session(); await rack.replay(session, 2); // recorded stream, 2x replay
rack.lift(session, 410, "6m50s");        // config at a moment → snapshot
```

Path-matched values carry over when a scene rebuilds and re-adds its params.
`rack.handle(type, fn)` extends the command vocabulary; `localStorageAdapter`
persists snapshots in a page.

## Examples

The package includes 13+ examples demonstrating various techniques:

- **hello-world** - Basic TSL function usage
- **knot-morph** - Geometry morphing between torus knots
- **raymarch-head** - 3D medical data visualization
- **metaballs-lab** - Raymarched smooth-min globules
- **sdf-text-lab** - CPU atlas + GPU instanced SDF text
- **sdf-text-chat** - Chatroom-style message pool with throttled `sync()`
- **metaballs-explainer** - Step-by-step SDF and raymarching walkthrough
- **raymarch-head-wave-displacement** - Volumetric waves
- **portal-door-transition** - Portal effects
- **cinematic-gallery** - Lighting and materials showcase
- **wispy-projector-beams** - Volumetric light beams
- **anisotropic-fbm-streaks** - Procedural noise patterns
- And more...

### Running Examples

```bash
# Development server with example gallery
pnpm dev

# Build examples for deployment
pnpm build:examples
```

Navigate to `http://localhost:5173` to see the example gallery.

## Development

```bash
# Install dependencies
pnpm install

# Build library
pnpm build

# Development mode (examples)
pnpm dev
```

## Project Structure

```
lib3/
├── src/
│   ├── index.js         # Main exports
│   ├── waves.js         # Wave displacement functions
│   ├── knotMorph.js     # Morphing utilities
│   ├── raymarch.js      # Raymarching functions
│   ├── fluidSim.js      # SmokeVolume fluid simulation
│   ├── smokeMaterial.js  # Volumetric smoke material
│   ├── blueNoise.js     # Compute mip-aware blue noise
│   ├── thunder.js       # Contained thunder effect
│   ├── metaballs.js     # Smooth-min SDF globules
│   ├── sdf/             # CPU EDT helpers
│   └── sdf-text/        # Font atlas + batched TSL text
├── examples/            # Interactive examples
├── dist/                # Built library (published)
└── package.json
```

## Exports

The package provides multiple entry points for tree-shaking:

```javascript
// Main bundle (all utilities)
import { sphericalWaveDisplacement, knotMorphPosition } from "@oneilltom/lib3";

// Individual modules (smaller bundles)
import { sphericalWaveDisplacement } from "@oneilltom/lib3/waves";
import { knotMorphPosition } from "@oneilltom/lib3/knotMorph";
import { createThunderNode, THUNDER_PRESETS } from "@oneilltom/lib3/thunder";
import { RaymarchedMetaballs } from "@oneilltom/lib3/metaballs";
import { computeSDF } from "@oneilltom/lib3/sdf";
import { BatchedText } from "@oneilltom/lib3/sdf-text";
import { HydraSynth, chainColorNode } from "@oneilltom/lib3/hydra";
```

## WebGPU Compatibility

This library requires Three.js with WebGPU support. Import from `three/webgpu`:

```javascript
import * as THREE from "three/webgpu";
import /* TSL nodes */ "three/tsl";
```

Check browser compatibility: [WebGPU Status](https://caniuse.com/webgpu)

## License

MIT

## Contributing

Contributions are welcome! Please feel free to submit issues or pull requests.

## Repository

[github.com/oneilltomhq/lib3](https://github.com/oneilltomhq/lib3)
