import test from "node:test";
import assert from "node:assert/strict";

import {
  TslSource,
  registerTransform,
  getTransforms,
  compile,
  chainColorNode,
  createSourceApi,
} from "../src/hydra/compiler.js";
import { HydraOutput } from "../src/hydra/output.js";
import { vec4, uv } from "three/tsl";

test("chains defer: methods push transforms, nothing evaluates", () => {
  const { osc } = createSourceApi();
  const chain = osc(10, 0.1).rotate(0.4).contrast(1.5);
  assert.equal(chain.transforms.length, 3);
  assert.deepEqual(chain.transforms.map((t) => t.def.type), ["src", "coord", "color"]);
});

test("compile returns a closure producing a TSL node", () => {
  const { osc, noise } = createSourceApi();
  const store = [];
  const colorFn = compile(osc(10).modulate(noise(3), 0.1).kaleid(4), store);
  const node = colorFn(uv());
  assert.ok(node && node.isNode, "expected a TSL node");
});

test("function-valued args become uniforms tracked in store", () => {
  const { osc } = createSourceApi();
  const store = [];
  const freq = (t) => 10 + Math.sin(t) * 5;
  compile(osc(freq), store)(uv());
  assert.equal(store.length, 1);
  const [u, fn] = store[0];
  assert.equal(u.value, freq(0));
  u.value = fn(Math.PI / 2);
  assert.ok(Math.abs(u.value - 15) < 1e-9);
});

test("registerTransform: non-src becomes chainable, src joins new apis", () => {
  registerTransform("halfBright", {
    type: "color", defaults: [0.5], fn: (c, amount) => vec4(c.rgb.mul(amount), c.a),
  });
  registerTransform("flat", {
    type: "src", defaults: [0.25], fn: (st, v) => vec4(v, v, v, 1),
  });
  const api = createSourceApi();
  assert.ok(typeof api.flat === "function", "src transform in new api");
  const chain = api.flat().halfBright();
  assert.equal(chain.transforms.length, 2);
  assert.ok(compile(chain, [])(uv()).isNode);
  const meta = getTransforms();
  assert.equal(meta.halfBright.type, "color");
  assert.equal(meta.flat.type, "src");
});

test("chainColorNode compiles a chain for arbitrary materials", () => {
  const { gradient } = createSourceApi();
  const { node, updaters } = chainColorNode(gradient((t) => t * 0.1));
  assert.ok(node.isNode);
  assert.equal(updaters.length, 1);
});

test("no shared globals: .out() routes per-env, bare .out() without env throws", () => {
  const envA = { defaultOut: new HydraOutput(8, 8) };
  const envB = { defaultOut: new HydraOutput(8, 8) };
  const apiA = createSourceApi(envA);
  const apiB = createSourceApi(envB);
  apiA.osc(5).out();
  assert.equal(envA.defaultOut.hasChain, true);
  assert.equal(envB.defaultOut.hasChain, false);
  apiB.noise(2).out();
  assert.equal(envB.defaultOut.hasChain, true);
  assert.throws(() => new TslSource(null).out(), /needs an output/);
});

// TSL drift canary: every base transform compiles against the pinned three
test("all base transforms compile in one chain", () => {
  const { voronoi, gradient, solid, shape, noise, osc } = createSourceApi();
  const chain = voronoi(5, 0.3, 0.3)
    .colorama(0.01).hue(0.4).saturate(2).posterize(3, 0.6).thresh(0.5, 0.04)
    .invert(1).shift(0.5).brightness(0.1).contrast(1.2).color(1, 0.8, 1.2)
    .pixelate(20, 20).scroll(0.1, 0.1, 0, 0).kaleid(4).scale(1.5).rotate(0.4)
    .add(gradient(0.1)).mult(solid(1, 0, 0)).blend(shape(5, 0.3, 0.01))
    .diff(noise(3)).layer(osc(20)).mask(gradient(0))
    .modulate(gradient(0), 0.1).modulateScale(gradient(0), 1, 1)
    .modulateRotate(gradient(0), 1, 0).modulateKaleid(gradient(0), 4);
  assert.ok(compile(chain, [])(uv()).isNode);
});

test("feedback: src(output) samples the output's texNode", () => {
  const out = new HydraOutput(8, 8);
  const { osc, src } = createSourceApi({ defaultOut: out });
  const chain = osc(10).modulate(src(out).scale(1.04), 0.02);
  const node = compile(chain, [])(uv());
  assert.ok(node.isNode);
});
