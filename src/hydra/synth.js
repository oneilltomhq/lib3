// The Hydra runtime: N feedback outputs + the patch api, driven by an
// INJECTED renderer (lib3 modules never own one). Caller creates and inits
// the WebGPURenderer, then:
//
//   const synth = new HydraSynth({ renderer, width: 960, height: 540 });
//   const { osc, src, o0 } = synth.api;
//   osc(10).rotate(0.4).modulate(src(o0).scale(1.04), 0.02).out(o0);
//   ...per frame: synth.update(t); // offscreen passes only
//   ...or synth.tick(t);           // update + blit display output to canvas

import { Scene, Mesh, PlaneGeometry, MeshBasicNodeMaterial, QuadMesh } from "three/webgpu";
import { texture } from "three/tsl";
import { createSourceApi } from "./compiler.js";
import { HydraOutput } from "./output.js";

export class HydraSynth {
  constructor({ renderer, width = 1280, height = 720, outputs = 4 } = {}) {
    if (!renderer) throw new Error("HydraSynth needs a renderer (create + init it yourself)");
    this.renderer = renderer;
    this.width = width;
    this.height = height;

    this.outputs = [];
    for (let i = 0; i < outputs; i++) this.outputs.push(new HydraOutput(width, height));
    this.defaultOut = this.outputs[0]; // what bare .out() targets
    this.display = this.outputs[0];    // what present() blits

    // screen blit (Hydra's classic fullscreen view)
    this.screenTex = texture(this.display.read.texture);
    this.screenMat = new MeshBasicNodeMaterial();
    this.screenMat.colorNode = this.screenTex;
    this.screenQuad = new QuadMesh(this.screenMat);

    // Hydra-style api: sources bound to this synth + o0..oN + render
    const api = createSourceApi(this);
    this.outputs.forEach((o, i) => api["o" + i] = o);
    api.render = (o) => { this.display = o || this.outputs[0]; };
    this.api = api;
  }

  get backend() { return this.renderer.backend?.isWebGPUBackend ? "WebGPU" : "WebGL"; }

  // returns the generated shader source (WGSL on WebGPU, GLSL on WebGL)
  async getShader(output = this.display) {
    const scene = new Scene();
    const mesh = new Mesh(new PlaneGeometry(2, 2), output.material);
    scene.add(mesh);
    const { vertexShader, fragmentShader } =
      await this.renderer.debug.getShaderAsync(scene, output.quad.camera, mesh);
    return { vertexShader, fragmentShader };
  }

  // run all patch passes offscreen (uniform updates, ping-pong, swap) without
  // presenting — for callers that composite the outputs into their own scene
  update(tSeconds) {
    for (const out of this.outputs) out.updateUniforms(tSeconds);
    for (const out of this.outputs) out.render(this.renderer);
  }

  // blit the display output to the canvas
  present() {
    this.screenTex.value = this.display.read.texture;
    this.renderer.setRenderTarget(null);
    this.screenQuad.render(this.renderer);
  }

  tick(tSeconds) {
    this.update(tSeconds);
    this.present();
  }

  dispose() {
    for (const out of this.outputs) out.dispose();
    this.screenMat.dispose();
  }
}
