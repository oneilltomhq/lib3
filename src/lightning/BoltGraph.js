/**
 * @module BoltGraph
 *
 * Data model for channel lightning. All positions in unit-cube [0,1]³.
 * The graph is a tree of nodes connected by segments. Generation is
 * deterministic given a seed — same seed produces the same graph.
 *
 * This module is consumed by renderers (LightningRibbon) and generators
 * (generateBolt). Renderers do NOT know generator internals.
 */

/**
 * Seeded PRNG (Mulberry32). Returns a function that produces [0,1) floats.
 * @param {number} seed
 * @returns {() => number}
 */
export function createRNG(seed) {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Create an empty BoltGraph.
 * @param {number} seed
 * @returns {BoltGraph}
 */
export function createBoltGraph(seed) {
  return {
    nodes: [],
    segments: [],
    bounds: {
      min: { x: Infinity, y: Infinity, z: Infinity },
      max: { x: -Infinity, y: -Infinity, z: -Infinity },
    },
    seed,
  };
}

/**
 * Add a node to the graph and update bounds.
 * @param {BoltGraph} graph
 * @param {{ id: string, position: { x: number, y: number, z: number }, parentId?: string }} node
 */
export function addNode(graph, node) {
  graph.nodes.push(node);
  const p = node.position;
  graph.bounds.min.x = Math.min(graph.bounds.min.x, p.x);
  graph.bounds.min.y = Math.min(graph.bounds.min.y, p.y);
  graph.bounds.min.z = Math.min(graph.bounds.min.z, p.z);
  graph.bounds.max.x = Math.max(graph.bounds.max.x, p.x);
  graph.bounds.max.y = Math.max(graph.bounds.max.y, p.y);
  graph.bounds.max.z = Math.max(graph.bounds.max.z, p.z);
}

/**
 * Add a segment to the graph. Validates non-zero length.
 * @param {BoltGraph} graph
 * @param {{ a: string, b: string, intensity: number, radius: number, branchDepth: number, phaseOffset: number }} segment
 */
export function addSegment(graph, segment) {
  const na = graph.nodes.find((n) => n.id === segment.a);
  const nb = graph.nodes.find((n) => n.id === segment.b);
  if (na && nb) {
    const dx = nb.position.x - na.position.x;
    const dy = nb.position.y - na.position.y;
    const dz = nb.position.z - na.position.z;
    if (dx * dx + dy * dy + dz * dz < 1e-12) return; // skip zero-length
  }
  graph.segments.push(segment);
}

/**
 * Get node by id.
 * @param {BoltGraph} graph
 * @param {string} id
 * @returns {{ id: string, position: { x: number, y: number, z: number }, parentId?: string } | undefined}
 */
export function getNode(graph, id) {
  return graph.nodes.find((n) => n.id === id);
}
