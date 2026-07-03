// An output buffer with ping-pong render targets — the framebuffer feedback
// that makes Hydra Hydra. Owns no renderer: render(renderer) borrows one, so
// an Output slots into any host loop (a HydraSynth, an ExhibitRunner, a raw
// rAF loop).

import {
  RenderTarget, MeshBasicNodeMaterial, QuadMesh,
  HalfFloatType, LinearFilter, ClampToEdgeWrapping,
} from "three/webgpu";
import { texture, uv } from "three/tsl";
import { compile } from "./compiler.js";

export class HydraOutput {
  constructor(width, height) {
    const mk = () => new RenderTarget(width, height, {
      type: HalfFloatType, minFilter: LinearFilter, magFilter: LinearFilter,
      wrapS: ClampToEdgeWrapping, wrapT: ClampToEdgeWrapping, depthBuffer: false,
    });
    this.read = mk();
    this.write = mk();
    this.texNode = texture(this.read.texture); // what src(oN) samples; value swaps each frame
    this.material = new MeshBasicNodeMaterial();
    this.quad = new QuadMesh(this.material);
    this.updaters = [];
    this.hasChain = false;
  }

  setChain(source) {
    const store = [];
    const colorFn = compile(source, store);
    this.updaters = store;
    this.material.colorNode = colorFn(uv());
    this.material.needsUpdate = true;
    this.hasChain = true;
  }

  // tick function-valued args (dynamic params written as t => ...)
  updateUniforms(t) {
    for (const [u, fn] of this.updaters) u.value = fn(t);
  }

  // render one pass into the write target, swap, re-point feedback
  render(renderer) {
    if (!this.hasChain) return;
    renderer.setRenderTarget(this.write);
    this.quad.render(renderer);
    const tmp = this.read; this.read = this.write; this.write = tmp;
    this.texNode.value = this.read.texture;
  }

  dispose() {
    this.read.dispose();
    this.write.dispose();
    this.material.dispose();
  }
}
