// ---- the signal graph: named nodes for the circuitry --------------------
// Every named quantity in the sling writes through a node here at the
// moment it's computed. The imperative step() remains the single source of
// truth — its statement order IS the topological sort of this graph (the
// e1 doctrine: "the code is the linearization") — but the graph is honest:
// a tap write is the only output path a value has, so the overlay renders
// exactly what runs.
//
// A node may carry `knobs`: rack addresses folded INTO its box — the
// parameters that tune this node live where the node lives, not on some
// satellite rail.
//
// Zero dependencies, zero site knowledge — pure JS + Math.
export function createGraph() {
	const list = [];
	const byId = new Map();
	const def = (kind, id, spec = {}) => {
		const n = {
			kind, id,
			label: spec.label ?? id,     // human name for the overlay
			caption: spec.caption,       // plain-words phrase (e1 style)
			unit: spec.unit,
			min: spec.min,
			max: spec.max,
			inputs: spec.inputs ?? [],   // upstream node ids: [{ from }]
			knobs: spec.knobs ?? [],     // rack paths rendered inside this box
			value: spec.init ?? 0,
			fmt: spec.fmt,               // optional value formatter
		};
		list.push(n);
		byId.set(id, n);
		return n;
	};
	return {
		// tap: a named derived value — set() returns v so taps inline:
		//   const s = nStretch.set(...)
		tap: (id, spec) => Object.assign(def('tap', id, spec), {
			set(v) { this.value = v; return v; },
		}),
		// vec: a Vector3 held by reference (anchor, tip positions)
		vec: (id, ref, spec = {}) => def('vec', id, {
			...spec,
			init: ref,
			fmt: spec.fmt ?? ((v) => `${v.x.toFixed(2)},${v.y.toFixed(2)},${v.z.toFixed(2)}`),
		}),
		nodes: () => list,
		get: (id) => byId.get(id),
	};
}
