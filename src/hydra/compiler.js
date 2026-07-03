// The Hydra chain idiom over TSL. A chain reads outside-in
// (osc(10).rotate(0.4).modulate(src(o0), 0.02)) but compiles to a deferred
// closure (st:vec2 node) -> vec4 node, with coord transforms composed into the
// uv BEFORE the source evaluates — the same compositional algorithm as
// hydra-synth's generateGlsl(), emitting a TSL node graph instead of a string.
//
// No global state: chains carry an optional `env` ({ defaultOut }) given to
// them by whoever built the source api (usually a HydraSynth), so multiple
// synths coexist.

import { uniform, uv, vec4 } from "three/tsl";
import { BASE_TRANSFORMS } from "./transforms.js";

const registry = { ...BASE_TRANSFORMS };

/**
 * The chain object (Hydra's GlslSource). Every chained method just pushes a
 * transform; nothing is evaluated until .out() / compile().
 */
export class TslSource {
  constructor(def, args = [], env = null) {
    this.transforms = [];
    this.env = env;
    if (def) this.transforms.push({ def, args });
  }

  out(output) {
    const target = output || this.env?.defaultOut;
    if (!target) throw new Error("hydra: .out() needs an output (no default in this env)");
    target.setChain(this);
    return this;
  }
}

function attachChainMethod(name, def) {
  TslSource.prototype[name] = function (...args) {
    this.transforms.push({ def, args });
    return this;
  };
}
for (const [name, def] of Object.entries(registry)) {
  if (def.type !== "src") attachChainMethod(name, def);
}

/**
 * Add a transform to the shared vocabulary — how lib3 nodes (or anything
 * TSL) join hydra chains. def = { type, defaults, fn } (types as in
 * transforms.js). Non-src transforms become chainable immediately; src
 * transforms appear in apis created after registration.
 */
export function registerTransform(name, def) {
  registry[name] = def;
  if (def.type !== "src") attachChainMethod(name, def);
}

/** Introspection: name -> { type, arity } for every registered transform. */
export function getTransforms() {
  return Object.fromEntries(
    Object.entries(registry).map(([name, def]) => [
      name, { type: def.type, defaults: [...def.defaults] },
    ]),
  );
}

// numbers/functions become uniforms (live-tweakable, no recompile); functions
// are recorded in `store` as [uniformNode, fn] so callers update them per-frame.
function resolveArg(a, store) {
  if (typeof a === "number") return uniform(a);
  if (typeof a === "function") { const u = uniform(a(0)); store.push([u, a]); return u; }
  return a; // already a node or an Output (for src)
}

/**
 * Compile a chain to a closure (st:vec2 node) -> vec4 node. `store` collects
 * [uniform, fn] pairs for function-valued args (update per frame with t).
 */
export function compile(source, store) {
  let color = () => vec4(0, 0, 0, 1);
  for (const tr of source.transforms) {
    const prev = color;
    const def = tr.def;
    const scalars = (offset) => def.defaults.map((d, i) => resolveArg(tr.args[i + offset] ?? d, store));

    if (def.type === "src") {
      if (def.srcArg) { const out = tr.args[0]; color = (st) => def.fn(st, out); }
      else { const a = scalars(0); color = (st) => def.fn(st, ...a); }
    } else if (def.type === "coord") {
      const a = scalars(0); color = (st) => prev(def.fn(st, ...a));
    } else if (def.type === "color") {
      const a = scalars(0); color = (st) => def.fn(prev(st), ...a);
    } else if (def.type === "combine") {
      const other = compile(tr.args[0], store); const a = scalars(1);
      color = (st) => def.fn(prev(st), other(st), ...a);
    } else if (def.type === "combineCoord") {
      const other = compile(tr.args[0], store); const a = scalars(1);
      color = (st) => prev(def.fn(st, other(st), ...a));
    }
  }
  return color;
}

/**
 * Compile a chain straight to a colorNode for ANY node material — hydra
 * patches as surface textures, no synth required. Returns { node, updaters };
 * tick function-valued args with `for (const [u, fn] of updaters) u.value = fn(t)`.
 */
export function chainColorNode(chain, st = uv()) {
  const updaters = [];
  const node = compile(chain, updaters)(st);
  return { node, updaters };
}

/**
 * Build the Hydra-style source api (osc, noise, ..., src) bound to `env`
 * ({ defaultOut }) so chains know where .out() lands. Outputs (o0..) are the
 * caller's to add — see HydraSynth.
 */
export function createSourceApi(env = null) {
  const api = {};
  for (const [name, def] of Object.entries(registry)) {
    if (def.type === "src") api[name] = (...args) => new TslSource(def, args, env);
  }
  return api;
}
