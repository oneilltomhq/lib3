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
  /**
   * opts.display: also blit each frame into a STABLE third target exposed as
   * `displayNode` / `display.texture`. A 3D scene that composites an output
   * (walls, refraction sources) must sample the display, never the ping-pong
   * pair — on WebGPU, sampling a buffer that is also a feedback attachment in
   * the same frame invalidates the pass.
   */
  constructor(width, height, { display = false } = {}) {
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
    if (display) {
      this.display = mk();
      this.displayNode = texture(this.display.texture); // stable — safe to composite
      this._blitMat = new MeshBasicNodeMaterial();
      this._blitMat.colorNode = this.texNode;
      this._blitQuad = new QuadMesh(this._blitMat);
    }
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
    if (this.display) {
      renderer.setRenderTarget(this.display);
      this._blitQuad.render(renderer);
    }
  }

  dispose() {
    this.read.dispose();
    this.write.dispose();
    this.material.dispose();
    this.display?.dispose();
    this._blitMat?.dispose();
  }
}
