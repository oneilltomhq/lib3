import test from "node:test";
import assert from "node:assert/strict";
import { createGraph } from "../src/circuit/graph.js";

test("tap: set() writes the value and returns it so taps inline", () => {
  const g = createGraph();
  const n = g.tap("stretch", { label: "stretch", min: 0, max: 8 });
  assert.equal(n.value, 0, "init defaults to 0");
  const returned = n.set(3.5);
  assert.equal(returned, 3.5, "set returns v for inline use");
  assert.equal(n.value, 3.5, "value written");
  assert.equal(g.get("stretch").value, 3.5, "same node by id");
});

test("tap: init seeds the starting value; spec fields carry through", () => {
  const g = createGraph();
  const n = g.tap("phi", {
    label: "orbit", unit: "°", init: 90,
    inputs: [{ from: "echo" }], knobs: ["/eye/period"],
    fmt: (v) => `φ ${Math.round(v)}°`,
  });
  assert.equal(n.kind, "tap");
  assert.equal(n.value, 90);
  assert.equal(n.label, "orbit");
  assert.equal(n.unit, "°");
  assert.deepEqual(n.inputs, [{ from: "echo" }]);
  assert.deepEqual(n.knobs, ["/eye/period"]);
  assert.equal(n.fmt(90), "φ 90°");
});

test("tap: label defaults to id, inputs/knobs default empty", () => {
  const g = createGraph();
  const n = g.tap("bare");
  assert.equal(n.label, "bare");
  assert.deepEqual(n.inputs, []);
  assert.deepEqual(n.knobs, []);
  assert.equal(n.caption, undefined);
});

test("vec: holds a Vector3-like by reference, live through the ref", () => {
  const g = createGraph();
  const ref = { x: 1, y: 2, z: 3 };
  const n = g.vec("tip.a", ref);
  assert.equal(n.kind, "vec");
  assert.equal(n.value, ref, "held by reference, not copied");
  ref.x = 9;
  assert.equal(n.value.x, 9, "mutations to the ref show through the node");
  assert.equal(n.fmt(ref), "9.00,2.00,3.00", "default vec formatter");
});

test("vec: a supplied fmt overrides the default", () => {
  const g = createGraph();
  const ref = { x: 0, y: 0, z: 0 };
  const n = g.vec("anchor", ref, { fmt: (v) => `@${v.y}` });
  assert.equal(n.fmt(ref), "@0");
});

test("nodes/get: registration order preserved, lookup by id", () => {
  const g = createGraph();
  g.tap("a");
  g.vec("b", { x: 0, y: 0, z: 0 });
  g.tap("c");
  assert.deepEqual(g.nodes().map((n) => n.id), ["a", "b", "c"], "insertion order");
  assert.equal(g.get("b").kind, "vec");
  assert.equal(g.get("missing"), undefined, "unknown id → undefined");
});
