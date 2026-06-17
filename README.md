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

## Examples

The package includes 13+ examples demonstrating various techniques:

- **hello-world** - Basic TSL function usage
- **knot-morph** - Geometry morphing between torus knots
- **raymarch-head** - 3D medical data visualization
- **metaballs-lab** - Raymarched smooth-min globules
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
│   └── metaballs.js     # Smooth-min SDF globules
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
