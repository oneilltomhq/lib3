// bolt.js — midpoint-displacement lightning, ported from the dynamics-notebook
// (rung-3 §06) and lifted into 3D. A straight segment is split at its midpoint,
// the midpoint shoved along a random perpendicular, the shove decayed, repeat:
// frequency doubles, amplitude decays — fbm folded into geometry. Branches
// splay off interior points with fewer octaves, dimmer and thinner.
//
// This module is PURE GEOMETRY + a seeded PRNG. Each strike takes a seed, so a
// volley of strikes with different seeds gives visibly different characters —
// one long and lazy, one jagged and dense — which is what reads as lightning.
// Rendering (2D projected strokes, ribbons, or a volumetric splat) is the
// caller's job; makeBolt just hands back polylines in world space.

import { Vector3 } from 'three/webgpu';

const TAU = Math.PI * 2;
const UP = new Vector3(0, 1, 0);
const RIGHT = new Vector3(1, 0, 0);

/** mulberry32 — a tiny seeded PRNG so a bolt is reproducible from its seed. */
function rng(seed) {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

// split each segment, shove the midpoint along a random 3D perpendicular (an
// arbitrary azimuth in the plane perpendicular to the segment), shrink, repeat.
function displace(a, b, levels, off, decay, rand) {
	let pts = [a, b];
	for (let s = 0; s < levels; s++) {
		const next = [pts[0]];
		for (let i = 0; i < pts.length - 1; i++) {
			const p = pts[i], q = pts[i + 1];
			const dir = q.clone().sub(p);
			const L = dir.length() || 1;
			dir.divideScalar(L);
			// two perpendiculars spanning the plane normal to the segment
			const ref = Math.abs(dir.y) < 0.9 ? UP : RIGHT;
			const perp1 = new Vector3().crossVectors(dir, ref).normalize();
			const perp2 = new Vector3().crossVectors(dir, perp1).normalize();
			const theta = rand() * TAU;         // random azimuth → full 3D crinkle
			const r = (rand() * 2 - 1) * off;
			const mid = p.clone().add(q).multiplyScalar(0.5)
				.addScaledVector(perp1, Math.cos(theta) * r)
				.addScaledVector(perp2, Math.sin(theta) * r);
			next.push(mid, q.clone());
		}
		pts = next;
		off *= decay;
	}
	return pts;
}

/**
 * Build a lightning bolt from `from` to `to` as a set of world-space polylines.
 *
 * @param {Object} o
 * @param {Vector3} o.from   strike entry (world)
 * @param {Vector3} o.to     terminus — the liquid it seeks (world)
 * @param {number} [o.levels=7]     midpoint-displacement levels (octaves)
 * @param {number} [o.roughness=0.14] base shove as a fraction of segment length
 * @param {number} [o.decay=0.55]   amplitude falloff per level
 * @param {number} [o.branchP=0.12] per-interior-point branch probability
 * @param {number} [o.maxDepth=2]   branch recursion depth
 * @param {number} [o.seed=1]       PRNG seed — the bolt's "character"
 * @returns {{ paths: Array<{ pts: Vector3[], bright: number, width: number }>, to: Vector3 }}
 */
export function makeBolt({
	from, to, levels = 7, roughness = 0.14, decay = 0.55,
	branchP = 0.12, maxDepth = 2, seed = 1,
}) {
	const rand = rng(seed);
	const paths = [];

	const addPath = (p0, p1, depth, bright) => {
		const seg = p0.distanceTo(p1);
		const lv = Math.max(2, levels - depth * 2);
		const pts = displace(p0, p1, lv, seg * roughness * (1 + depth * 0.3), decay, rand);
		paths.push({ pts, bright, width: Math.pow(0.55, depth) });
		if (depth >= maxDepth) return;

		const dir = p1.clone().sub(p0).normalize();
		for (let i = 2; i < pts.length - 2; i++) {
			if (rand() > branchP) continue;
			const frac = i / (pts.length - 1);
			const blen = seg * (1 - frac) * (0.3 + rand() * 0.3);
			if (blen < seg * 0.05) continue;
			// splay the branch off the main direction by a random angle around a
			// random perpendicular axis (3D fork, not a coplanar Y)
			const ref = Math.abs(dir.y) < 0.9 ? UP : RIGHT;
			const axis = new Vector3().crossVectors(dir, ref)
				.applyAxisAngle(dir, rand() * TAU).normalize();
			const ang = (rand() < 0.5 ? -1 : 1) * (0.35 + rand() * 0.55);
			const bdir = dir.clone().applyAxisAngle(axis, ang);
			addPath(pts[i].clone(), pts[i].clone().addScaledVector(bdir, blen),
				depth + 1, bright * 0.5);
		}
	};

	addPath(from.clone(), to.clone(), 0, 1);
	return { paths, to: to.clone() };
}

/**
 * Flicker envelope — two incommensurate sines that never quite repeat (the
 * notebook's channel shimmer), gated by a life fade. Feed it the bolt's age and
 * lifetime; multiply your stroke alpha by the result.
 */
export function boltFlicker(age, life) {
	const k = age / life;
	if (k >= 1) return 0;
	const shimmer = 0.78 + 0.22 * Math.sin(age * 62) * Math.sin(age * 148);
	// sharp attack, exponential-ish fade so the channel snaps on then decays
	const fade = k < 0.12 ? k / 0.12 : Math.pow(1 - (k - 0.12) / 0.88, 1.6);
	return shimmer * fade;
}
