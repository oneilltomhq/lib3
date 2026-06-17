/**
 * @module generateBolt
 *
 * Bolt graph generators with preset strategies for channel lightning.
 * Each preset produces a BoltGraph with deterministic output given a seed.
 *
 * Presets: leader, returnStroke, forked, crawler
 */

import { createBoltGraph, addNode, addSegment, createRNG } from './BoltGraph.js';

/**
 * Clamp value to [0,1] unit cube range.
 */
function clamp01(v) {
  return Math.max(0, Math.min(1, v));
}

/**
 * Generate a basic lightning channel (trunk) with jitter.
 * Used as foundation for leader and return stroke.
 *
 * @param {Object} opts
 * @param {number} opts.seed
 * @param {{ x: number, y: number, z: number }} opts.start
 * @param {{ x: number, y: number, z: number }} opts.end
 * @param {number} opts.segments - number of segments along trunk
 * @param {number} opts.jitter - lateral displacement magnitude
 * @param {number} opts.branchDepth - max branch depth
 * @param {number} opts.forkProbability - probability of forking at each node
 * @param {number} opts.branchLength - segments per branch
 * @param {number} opts.taperRate - intensity falloff per branch depth
 * @param {number} [opts.lateralBias] - bias toward lateral wandering (crawler)
 * @returns {import('./BoltGraph.js').BoltGraph}
 */
function generateChannel(opts) {
  const {
    seed, start, end, segments, jitter, branchDepth,
    forkProbability, branchLength, taperRate, lateralBias = 0,
  } = opts;

  const rng = createRNG(seed);
  const graph = createBoltGraph(seed);
  let nodeCounter = 0;

  function makeId() {
    return `n${nodeCounter++}`;
  }

  function lerp(a, b, t) {
    return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t };
  }

  // Build trunk
  const trunkNodes = [];
  for (let i = 0; i <= segments; i++) {
    const t = i / segments;
    const base = lerp(start, end, t);

    // Add jitter (less at endpoints)
    const edgeFade = Math.sin(t * Math.PI); // 0 at ends, 1 at middle
    const jitterScale = jitter * edgeFade;
    const pos = {
      x: clamp01(base.x + (rng() - 0.5) * jitterScale + (rng() - 0.5) * lateralBias * edgeFade),
      y: clamp01(base.y + (rng() - 0.5) * jitterScale * 0.3),
      z: clamp01(base.z + (rng() - 0.5) * jitterScale),
    };

    const id = makeId();
    const parentId = i > 0 ? trunkNodes[i - 1].id : undefined;
    const node = { id, position: pos, parentId };
    addNode(graph, node);
    trunkNodes.push(node);

    if (i > 0) {
      addSegment(graph, {
        a: trunkNodes[i - 1].id,
        b: id,
        intensity: 1.0,
        radius: 1.0,
        branchDepth: 0,
        phaseOffset: t,
      });
    }
  }

  // Branch generation (recursive)
  function growBranch(parentNode, direction, depth, segCount, parentPhase) {
    if (depth >= branchDepth) return;

    const intensityScale = Math.pow(1 - taperRate, depth + 1);
    const radiusScale = Math.pow(0.7, depth + 1);
    let prevNode = parentNode;

    for (let i = 0; i < segCount; i++) {
      const t = (i + 1) / segCount;
      const drift = jitter * 0.6 * Math.pow(0.7, depth);
      const pos = {
        x: clamp01(prevNode.position.x + direction.x * 0.03 + (rng() - 0.5) * drift),
        y: clamp01(prevNode.position.y + direction.y * 0.03 + (rng() - 0.5) * drift * 0.3),
        z: clamp01(prevNode.position.z + direction.z * 0.03 + (rng() - 0.5) * drift),
      };

      const id = makeId();
      const node = { id, position: pos, parentId: prevNode.id };
      addNode(graph, node);

      addSegment(graph, {
        a: prevNode.id,
        b: id,
        intensity: intensityScale * (1 - t * 0.5),
        radius: radiusScale * (1 - t * 0.4),
        branchDepth: depth + 1,
        phaseOffset: parentPhase + t * 0.1,
      });

      // Sub-branches
      if (rng() < forkProbability * 0.5 && depth + 1 < branchDepth) {
        const subDir = {
          x: (rng() - 0.5) * 2,
          y: direction.y * 0.5 + (rng() - 0.5),
          z: (rng() - 0.5) * 2,
        };
        growBranch(node, subDir, depth + 1, Math.max(2, Math.floor(segCount * 0.5)), parentPhase + t * 0.1);
      }

      prevNode = node;
    }
  }

  // Generate branches from trunk
  for (let i = 2; i < trunkNodes.length - 1; i++) {
    if (rng() < forkProbability) {
      const t = i / trunkNodes.length;
      const dir = {
        x: (rng() - 0.5) * 2 + lateralBias * (rng() - 0.5),
        y: (end.y - start.y) * 0.3 + (rng() - 0.5),
        z: (rng() - 0.5) * 2,
      };
      growBranch(trunkNodes[i], dir, 0, Math.max(2, branchLength), t);
    }
  }

  return graph;
}

// ── Presets ─────────────────────────────────────────────────────────────────

/**
 * Leader preset: progressive reveal, dim branching exploratory channel.
 * Fewer segments, moderate jitter, light branching.
 */
export function generateLeader(opts = {}) {
  return generateChannel({
    seed: opts.seed ?? 42,
    start: opts.start ?? { x: 0.5, y: 0.95, z: 0.5 },
    end: opts.end ?? { x: 0.5, y: 0.05, z: 0.5 },
    segments: opts.segments ?? 24,
    jitter: opts.jitter ?? 0.15,
    branchDepth: opts.branchDepth ?? 2,
    forkProbability: opts.forkProbability ?? 0.2,
    branchLength: opts.branchLength ?? 4,
    taperRate: opts.taperRate ?? 0.4,
    lateralBias: opts.lateralBias ?? 0,
  });
}

/**
 * Return stroke preset: bright discharge along established path.
 * Same structure as leader but higher intensity, used with brighter rendering.
 */
export function generateReturnStroke(opts = {}) {
  return generateChannel({
    seed: opts.seed ?? 42,
    start: opts.start ?? { x: 0.5, y: 0.95, z: 0.5 },
    end: opts.end ?? { x: 0.5, y: 0.05, z: 0.5 },
    segments: opts.segments ?? 24,
    jitter: opts.jitter ?? 0.12,
    branchDepth: opts.branchDepth ?? 2,
    forkProbability: opts.forkProbability ?? 0.15,
    branchLength: opts.branchLength ?? 3,
    taperRate: opts.taperRate ?? 0.3,
    lateralBias: opts.lateralBias ?? 0,
  });
}

/**
 * Forked ground preset: strong trunk + secondary branches + taper.
 * More segments, higher fork probability, deeper branches.
 */
export function generateForked(opts = {}) {
  return generateChannel({
    seed: opts.seed ?? 42,
    start: opts.start ?? { x: 0.5, y: 0.95, z: 0.5 },
    end: opts.end ?? { x: 0.5, y: 0.05, z: 0.5 },
    segments: opts.segments ?? 32,
    jitter: opts.jitter ?? 0.18,
    branchDepth: opts.branchDepth ?? 3,
    forkProbability: opts.forkProbability ?? 0.45,
    branchLength: opts.branchLength ?? 6,
    taperRate: opts.taperRate ?? 0.35,
    lateralBias: opts.lateralBias ?? 0,
  });
}

/**
 * Crawler preset: lateral wandering arc, many shallow branches, slower propagation.
 * Strong lateral bias, many segments, moderate branching.
 */
export function generateCrawler(opts = {}) {
  return generateChannel({
    seed: opts.seed ?? 42,
    start: opts.start ?? { x: 0.15, y: 0.7, z: 0.5 },
    end: opts.end ?? { x: 0.85, y: 0.65, z: 0.5 },
    segments: opts.segments ?? 36,
    jitter: opts.jitter ?? 0.22,
    branchDepth: opts.branchDepth ?? 2,
    forkProbability: opts.forkProbability ?? 0.35,
    branchLength: opts.branchLength ?? 5,
    taperRate: opts.taperRate ?? 0.45,
    lateralBias: opts.lateralBias ?? 0.15,
  });
}

/**
 * Map of preset name to generator function.
 */
export const presets = {
  leader: generateLeader,
  returnStroke: generateReturnStroke,
  forked: generateForked,
  crawler: generateCrawler,
};
