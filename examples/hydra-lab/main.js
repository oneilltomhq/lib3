// Hydra Lab — the lib3 hydra module driven standalone. Pick a patch with the
// URL hash (#basic #feedback #kaleid #voronoi #registered), force the WebGL
// fallback with ?webgl=1. The renderer belongs to the page, not the synth.

import { WebGPURenderer } from "three/webgpu";
import { vec4, mix } from "three/tsl";
import { HydraSynth, registerTransform } from "../../src/hydra/index.js";
import { simplexNoise3 } from "../../src/waves.js";

const params = new URLSearchParams(location.search);
const forceWebGL = params.get("webgl") === "1";
const patchName = location.hash.slice(1) || "feedback";

const canvas = document.getElementById("view");
const hud = document.getElementById("hud");
const shaderEl = document.getElementById("shader");

// a lib3 node joining the hydra vocabulary — the registry in action
registerTransform("simplexTint", {
  type: "color", defaults: [3, 0.5], fn: (c, scale, amount) => {
    const n = simplexNoise3({ v: c.rgb.mul(scale) }).mul(0.5).add(0.5);
    return vec4(mix(c.rgb, c.rgb.mul(n), amount), c.a);
  },
});

const W = 960, H = 540;
const renderer = new WebGPURenderer({ canvas, forceWebGL });
renderer.setSize(W, H);
await renderer.init();

const synth = new HydraSynth({ renderer, width: W, height: H });
const { osc, noise, voronoi, src, o0 } = synth.api;
Object.assign(window, synth.api, { synth });

const patches = {
  basic: () => osc(20, 0.1, 0.8).rotate(0.5).out(o0),

  // ping-pong feedback: osc coords modulated by the *previous frame*
  // (zoomed 1.04), producing classic Hydra infinite-zoom melt
  feedback: () =>
    osc(10, 0.1, 1.0)
      .rotate(0.4)
      .modulate(src(o0).scale(1.04), 0.02)
      .out(o0),

  // feedback through a kaleidoscope, all 5 transform types in one chain
  kaleid: () =>
    noise(3.5, 0.1)
      .modulate(src(o0).scale(1.02).rotate(0.01), 0.025)
      .kaleid(6)
      .color(1.2, 0.8, 1.6)
      .contrast(1.3)
      .out(o0),

  // animated cellular noise cycled through HSV by colorama
  voronoi: () =>
    voronoi(7, 0.4, 0.3)
      .colorama(0.012)
      .modulate(src(o0).scale(1.01), 0.01)
      .out(o0),

  // the registered lib3 transform (simplexTint) inside a hydra chain,
  // plus a function-valued arg — live param, no recompile
  registered: () =>
    osc((t) => 8 + Math.sin(t * 0.3) * 5, 0.08, 0.9)
      .kaleid(5)
      .simplexTint(4, 0.8)
      .modulate(src(o0).rotate(0.005), 0.03)
      .out(o0),
};

(patches[patchName] || patches.feedback)();

let shaderSrc = "(shader unavailable)";
try {
  const { fragmentShader } = await synth.getShader(o0);
  shaderSrc = fragmentShader;
} catch (e) { shaderSrc = "getShader error: " + e.message; }
window.__shader = shaderSrc;
window.__backend = synth.backend;

const lang = synth.backend === "WebGPU" ? "WGSL" : "GLSL";
const names = Object.keys(patches).map((n) => n === patchName ? `[#${n}]` : `#${n}`).join(" ");
hud.textContent =
  `hydra-lab · backend: ${synth.backend} · ${names}\n` +
  `generated ${lang}: ${shaderSrc.split("\n").length} lines (bottom-left)`;
shaderEl.textContent = `// generated ${lang} (fragment) ↓\n` + shaderSrc;

const t0 = performance.now();
function loop() {
  synth.tick((performance.now() - t0) / 1000);
  requestAnimationFrame(loop);
}
loop();

window.addEventListener("hashchange", () => location.reload());
window.__ready = true;
