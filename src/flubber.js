// Flubber — a metaball surface where the shape is EMERGENT (no primitives).
// Route B: particles live in GPU storage, splat a density field into a 3D
// texture, and a fragment march finds the isosurface. The mass can tear apart
// and re-merge, which a smooth-min of spheres never does.
//
// Three GPU passes per frame:
//   sim    (compute, per particle) — N particles integrated in storage buffers.
//          The FORCES are supplied by pluggable DRIVERS (see below), so the
//          same substrate serves the site's gravity wells and the example's
//          musical noise-advection without either copying the other.
//   splat  (compute, per voxel)    — each GRID³ voxel sums a compact-support
//          kernel over all particles into a Storage3DTexture. R = density,
//          GBA = analytic world-space density gradient (→ smooth normals).
//   march  (fragment)              — fixed-step march + binary-search hit
//          refine, gradient normal, then a glass read: refract the scene
//          behind (aspect-correct), fresnel, rim.
//
// A DRIVER is a small object { uniforms?, force?(ctx), update?(dt, t), ... }.
//   force(ctx) returns a TSL vec3 ACCELERATION (pre-dt); the field sums every
//   driver's force, integrates once (vel += Σforce·dt), damps, speed-caps and
//   advances position. ctx = { pos, vel, index, center, bMin, bMax, size,
//   uT, uDt } where pos/vel are the storage element vars and center/bMin/bMax/
//   size are TSL vec3s for the density box. update(dt, t) runs each frame on
//   the CPU to push host state (moving wells, decaying impulses) into uniforms.
//
// Built-in drivers below cover both consumers: wellDriver + noiseFlowDriver +
// cohesionDriver + burstDriver (the site), and noiseFlowDriver + cohesionDriver
// + swirlDriver + kickDriver (the musical example).

import {
	Storage3DTexture, LinearFilter, HalfFloatType, BoxGeometry, Mesh,
	MeshBasicNodeMaterial, BackSide, Vector3,
} from 'three/webgpu';
import {
	Break, cameraPosition, clamp, Discard, float, Fn, hash, If, instancedArray,
	instanceIndex, Loop, mx_noise_vec3, normalize, positionWorld, screenSize,
	screenUV, smoothstep, texture, texture3D, textureStore, uniform, vec2, vec3, vec4,
} from 'three/tsl';

// ============================================================================
// Drivers — composable force sources. Each returns { force, update?, ... }.
// ============================================================================

/**
 * Gravity + tangential spin from a set of moving attractor wells. Inverse-square
 * gravity with softening (no singularity slingshots) plus a spin force around
 * each well's axis (spiral arms, not circles). Per-particle mass varies via a
 * stable hash so the field has size variety.
 *
 * @param {Object} o
 * @param {Array}  o.wells  host-updated wells; each { p:Vector3, axis:Vector3, gm:number, sm:number, mood?:number }
 * @param {number} [o.count=3]  wells to read (unrolled in JS)
 * @param {number} [o.grav=2.6] G·M base scale
 * @param {number} [o.spin=1.4] spin force vs gravity
 * @param {number} [o.soft=0.24] softening radius
 */
export function wellDriver({ wells, count = 3, grav = 2.6, spin = 1.4, soft = 0.24 }) {
	const SOFT2 = soft * soft;
	const uPos = Array.from({ length: count }, () => uniform(new Vector3()));
	const uAxis = Array.from({ length: count }, () => uniform(new Vector3()));
	const uG = Array.from({ length: count }, () => uniform(0)); // grav·gm·mood
	const uSpin = Array.from({ length: count }, () => uniform(0)); // spin·sm
	return {
		uniforms: { uPos, uAxis, uG, uSpin },
		force({ pos, index }) {
			const acc = vec3(0).toVar();
			const pull = hash(index).mul(0.5).add(0.75); // per-particle mass
			for (let w = 0; w < count; w++) {
				const to = uPos[w].sub(pos); // NOT normalized (spin wants full vec)
				const d2 = to.dot(to).add(SOFT2);
				const g = uG[w].mul(pull).div(d2);
				acc.addAssign(to.mul(g.div(d2.sqrt())));               // inverse-square gravity
				acc.addAssign(uAxis[w].cross(to).mul(g.mul(uSpin[w]))); // tangential spin
			}
			return acc;
		},
		update() {
			for (let i = 0; i < count; i++) {
				const w = wells[i];
				uPos[i].value.copy(w.p);
				uAxis[i].value.copy(w.axis);
				uG[i].value = grav * w.gm * (w.mood ?? 1);
				uSpin[i].value = spin * w.sm;
			}
		},
	};
}

/**
 * Noise advection — a vec3-noise flow field, desynced per axis in time so the
 * surface never crystallises. `uFreq`/`uAmt` exposed for live control.
 */
export function noiseFlowDriver({ freq = 1.2, amt = 0.4 } = {}) {
	const uFreq = uniform(freq);
	const uAmt = uniform(amt);
	return {
		uniforms: { uFreq, uAmt },
		force({ pos, uT }) {
			return mx_noise_vec3(
				pos.mul(uFreq).add(vec3(0, uT.mul(0.25), uT.mul(0.11)))
			).mul(uAmt);
		},
	};
}

/**
 * Cohesion — a spring pulling every particle toward a point (the density box
 * centre by default), stiffening quadratically with distance so noise/scatter
 * can stretch the mass but never fling a particle out.
 *
 * @param {number}  [o.strength=0.45]
 * @param {number}  [o.stiffen=0.6]  quadratic stiffening coefficient
 * @param {Vector3} [o.center]  spring target; defaults to the field's box centre
 */
export function cohesionDriver({ strength = 0.45, stiffen = 0.6, center = null } = {}) {
	const uStr = uniform(strength);
	return {
		uniforms: { uStr },
		force({ pos, center: boxCenter }) {
			const c = center ? vec3(center.x, center.y, center.z) : boxCenter;
			const rel = pos.sub(c);
			const st = rel.dot(rel).mul(stiffen).add(1);
			return rel.mul(uStr.mul(st)).negate();
		},
	};
}

/** Tangential swirl around the world Y axis. */
export function swirlDriver({ strength = 0.9 } = {}) {
	const uStr = uniform(strength);
	return {
		uniforms: { uStr },
		force({ pos }) { return vec3(pos.z.negate(), 0, pos.x).mul(uStr); },
	};
}

/**
 * Global radial kick from the origin — a magnitude you spike with .add() (e.g.
 * on a musical accent) that decays exponentially. Pushes the whole mass outward.
 */
export function kickDriver({ decay = 7 } = {}) {
	const uKick = uniform(0);
	let env = 0;
	return {
		uniforms: { uKick },
		force({ pos }) {
			return normalize(pos.add(vec3(0.013, 0.021, 0.017))).mul(uKick);
		},
		update(dt) { env *= Math.exp(-decay * dt); uKick.value = env; },
		/** add impulse to the kick envelope */
		add(amount) { env += amount; },
	};
}

/**
 * Point shockwave — a decaying radial kick away from a world point with a
 * finite radius falloff. Fire with .trigger(pos, radius, strength) on a click.
 */
export function burstDriver({ decay = 7 } = {}) {
	const uPos = uniform(new Vector3());
	const uStr = uniform(0);
	const uR = uniform(1.8);
	return {
		uniforms: { uPos, uStr, uR },
		force({ pos }) {
			const bto = pos.sub(uPos);
			const bd = bto.length();
			const bf = uStr.mul(clamp(float(1).sub(bd.div(uR)), 0, 1));
			return normalize(bto.add(vec3(1e-4))).mul(bf);
		},
		update(dt) { uStr.value *= Math.exp(-decay * dt); },
		trigger(worldPos, radius = 1.8, strength = 22) {
			uPos.value.copy(worldPos);
			uR.value = radius;
			uStr.value = strength;
		},
	};
}

// ============================================================================
// FlubberField — the substrate: storage sim + density splat + isosurface march.
// ============================================================================

export class FlubberField {
	/**
	 * @param {Object} o
	 * @param {THREE.WebGPURenderer} o.renderer
	 * @param {THREE.PerspectiveCamera} o.camera
	 * @param {Array<Object>} o.drivers   force sources (see module header)
	 * @param {THREE.Texture} o.sceneTexture  refraction source (scene behind glass)
	 * @param {THREE.Texture} o.rimTexture    additive rim accent
	 * @param {number} [o.count=160]   particle count
	 * @param {number} [o.grid=64]     density grid resolution (grid³ voxels)
	 * @param {Vector3} [o.center]     density box centre (world)
	 * @param {Vector3} [o.half]       density box half-extents (world)
	 * @param {number|{min,max,skew}} [o.radius]  per-particle kernel radius:
	 *        a constant, or a skewed range (a crowd of droplets, a few heavies)
	 * @param {number} [o.damp=0.6]      per-second exponential velocity damping
	 * @param {number} [o.speedCap=3.2]  soft speed governor (world units/s)
	 * @param {number} [o.iso=0.8]       isosurface density threshold
	 * @param {number} [o.refract=0.22]  glass refraction offset
	 * @param {number} [o.fresnelStrength=0.95]
	 * @param {number} [o.fresnelBase=0.48]
	 * @param {number} [o.rimStrength=0.24]
	 * @param {number} [o.marchSteps=110]
	 */
	constructor({
		renderer, camera, drivers = [], sceneTexture, rimTexture,
		count = 160,
		grid = 64,
		center = new Vector3(0.75, 0.0, 0.3),
		half = new Vector3(2.3, 1.6, 1.2),
		radius = { min: 0.22, max: 0.64, skew: 1.4 },
		damp = 0.6,
		speedCap = 3.2,
		iso = 0.8,
		refract = 0.22,
		fresnelStrength = 0.95,
		fresnelBase = 0.48,
		rimStrength = 0.24,
		marchSteps = 110,
		// charge / permeation (slice 1): per-particle charge that decays, splats
		// into an emission volume, and lights the isosurface from within.
		chargeDecay = 2.2,        // per-second exponential charge decay (τ≈0.45s)
		emitGain = 1.6,           // interior-glow output scale
		emitFloor = 0,            // ambient emission ∝ density — the medium glows at rest
		emitColor = [0.55, 1.0, 0.72], // charge emission colour (rgb, notebook green-white)
		innerSteps = 4,           // short march INTO the surface for the inner glow
	}) {
		this.renderer = renderer;
		this.camera = camera;
		this.drivers = drivers;
		this.count = count;
		this.grid = grid;
		this.center = center.clone();
		this.half = half.clone();

		const N = count;
		const GRID = grid;
		const INJ_K = 16; // simultaneous charge-injection points per frame
		const cx = center.x, cy = center.y, cz = center.z;
		const hx = half.x, hy = half.y, hz = half.z;
		// box AABB + per-axis size, baked as literals into the shaders
		const bMin = vec3(cx - hx, cy - hy, cz - hz);
		const bMax = vec3(cx + hx, cy + hy, cz + hz);
		const size = vec3(2 * hx, 2 * hy, 2 * hz);
		const centerNode = vec3(cx, cy, cz);

		// ---- storage substrate ------------------------------------------------
		// particles seeded in a ball near the box centre; kernel radius per the
		// radius spec — constant, or skewed so a few heavies join the crowd.
		const initPos = new Float32Array(N * 3);
		const initRad = new Float32Array(N);
		const radConst = typeof radius === 'number';
		const rMin = radConst ? radius : radius.min;
		const rSpan = radConst ? 0 : radius.max - radius.min;
		const rSkew = radConst ? 1 : (radius.skew ?? 1);
		for (let i = 0; i < N; i++) {
			const r = 0.7 * Math.cbrt(Math.random());
			const a = Math.random() * Math.PI * 2;
			const z = Math.random() * 2 - 1;
			const s = Math.sqrt(1 - z * z);
			initPos[i * 3 + 0] = cx + r * s * Math.cos(a);
			initPos[i * 3 + 1] = cy + r * z;
			initPos[i * 3 + 2] = cz + r * s * Math.sin(a);
			// neighbouring influence radii must overlap generously or the summed
			// field is lumpy — hence radii comfortably bigger than a droplet.
			initRad[i] = rMin + Math.pow(Math.random(), rSkew) * rSpan;
		}
		const pPos = instancedArray(initPos, 'vec3');
		const pVel = instancedArray(N, 'vec3');
		const pRad = instancedArray(initRad, 'float');
		const pCharge = instancedArray(N, 'float'); // per-particle charge, 0-init
		this.pPos = pPos; // exposed for readback (frame-continuity test)
		this.pRad = pRad;
		this.pCharge = pCharge;

		// ---- uniforms ---------------------------------------------------------
		const uDt = uniform(0);
		const uT = uniform(0);
		const uDamp = uniform(damp);
		const uSpeedCap = uniform(speedCap);
		const uRadiusScale = uniform(1); // live global scale on the baked per-particle radii
		// charge: decay rate + a one-shot injection sphere (set by strike(), zeroed
		// after each frame) + emission look controls.
		const uChargeDecay = uniform(chargeDecay);
		// up to INJ_K injection spheres per frame — a lightning channel deposits at
		// BOTH ends (plus interior taps), and many arcs fire at once. Unused slots
		// carry amt=0. Queue with injectCharge(); update() loads the slots.
		const uInjPos = Array.from({ length: INJ_K }, () => uniform(new Vector3()));
		const uInjR = Array.from({ length: INJ_K }, () => uniform(0.6));
		const uInjAmt = Array.from({ length: INJ_K }, () => uniform(0));
		const uEmitGain = uniform(emitGain);
		const uEmitFloor = uniform(emitFloor); // base glow ∝ density (live conductor at rest)
		const uEmitColor = uniform(new Vector3(emitColor[0], emitColor[1], emitColor[2]));
		this._pendingInj = []; // charge points queued this frame (consumed in update)
		this.u = {
			uDt, uT, uDamp, uSpeedCap, uRadiusScale,
			uChargeDecay, uInjPos, uInjR, uInjAmt, uEmitGain, uEmitFloor, uEmitColor,
		};

		// ---- pass 1: particle sim — sum driver forces, integrate --------------
		this.simCompute = Fn(() => {
			const pos = pPos.element(instanceIndex);
			const vel = pVel.element(instanceIndex);
			const ctx = {
				pos, vel, index: instanceIndex,
				center: centerNode, bMin, bMax, size, uT, uDt,
			};

			const acc = vec3(0).toVar();
			for (const d of drivers) {
				if (d.force) acc.addAssign(d.force(ctx));
			}
			vel.addAssign(acc.mul(uDt));

			vel.mulAssign(clamp(float(1).sub(uDamp.mul(uDt)), 0, 1));
			// soft speed governor
			const sp = vel.length();
			vel.mulAssign(clamp(uSpeedCap.div(sp.max(1e-4)), 0, 1));
			pos.addAssign(vel.mul(uDt));

			// charge: exp decay (dI/dt = −I/τ), then one-shot injection for any
			// particle inside the strike sphere — falloff so the hit blob lights
			// brightest at the contact point.
			const ch = pCharge.element(instanceIndex);
			ch.mulAssign(clamp(float(1).sub(uChargeDecay.mul(uDt)), 0, 1));
			for (let k = 0; k < INJ_K; k++) {
				const injD = pos.sub(uInjPos[k]).length();
				const injW = clamp(float(1).sub(injD.div(uInjR[k])), 0, 1);
				ch.addAssign(injW.mul(injW).mul(uInjAmt[k]));
			}
		})().compute(N);

		// ---- pass 2: splat density + analytic gradient into the 3D texture ----
		// R = density, GBA = world-space density gradient. HalfFloat keeps the
		// field continuous (8-bit quantization otherwise contours the surface).
		const volume = new Storage3DTexture(GRID, GRID, GRID);
		volume.type = HalfFloatType; // RGBA16Float — continuous density
		volume.generateMipmaps = false;
		volume.magFilter = LinearFilter;
		volume.minFilter = LinearFilter;
		volume.name = 'flubberDensity';
		this.volume = volume;

		// emission volume — charge splatted through the SAME kernels as density,
		// so glow pools where blobs merge and conducts across connecting necks.
		// R = emission; GBA unused. HalfFloat to match the density field's range.
		const emitVol = new Storage3DTexture(GRID, GRID, GRID);
		emitVol.type = HalfFloatType;
		emitVol.generateMipmaps = false;
		emitVol.magFilter = LinearFilter;
		emitVol.minFilter = LinearFilter;
		emitVol.name = 'flubberEmission';
		this.emitVol = emitVol;

		this.splatCompute = Fn(() => {
			const id = instanceIndex;
			const x = id.mod(GRID);
			const y = id.div(GRID).mod(GRID);
			const z = id.div(GRID * GRID);
			// voxel centre → world position inside the box AABB
			const wp = vec3(x, y, z).add(0.5).div(GRID).mul(size).add(bMin);

			const dens = float(0).toVar();
			const grad = vec3(0).toVar(); // analytic ∇density, world units
			const emit = float(0).toVar(); // Σ charge·kernel — same kernels as density
			Loop(N, ({ i }) => {
				const dp = wp.sub(pPos.element(i));
				const r = pRad.element(i).mul(uRadiusScale);
				const r2 = r.mul(r);
				const w = clamp(float(1).sub(dp.dot(dp).div(r2)), 0, 1);
				dens.addAssign(w.mul(w).mul(w)); // compact-support cubic falloff
				// ∇(w³) = 3w²·∇w = −6w²·dp/r² — smooth per particle, so the
				// trilinearly interpolated gradient is smooth too (unlike
				// finite differences of the C1-discontinuous density field)
				grad.addAssign(dp.mul(w.mul(w).mul(-6).div(r2)));
				emit.addAssign(w.mul(w).mul(pCharge.element(i)));
			});
			// ambient floor: a little base emission wherever the medium is, so the
			// liquid always simmers with charge (a live conductor even between arcs).
			emit.addAssign(dens.mul(uEmitFloor));
			// soft window: density → 0 just inside the box faces so the
			// isosurface never hard-clips against a face (no visible cube edge)
			const uvw = vec3(x, y, z).add(0.5).div(GRID); // 0..1 across the box
			const m = 0.07;
			const win = (u) => smoothstep(0, m, u).mul(smoothstep(0, m, u.oneMinus()));
			// d/du smoothstep(0,m,u) = 6t(1−t)/m with t = clamp(u/m, 0, 1)
			const sd = (u) => {
				const t = clamp(u.div(m), 0, 1);
				return t.mul(t.oneMinus()).mul(6 / m);
			};
			const winD = (u) => sd(u).mul(smoothstep(0, m, u.oneMinus()))
				.sub(smoothstep(0, m, u).mul(sd(u.oneMinus())));
			const wx = win(uvw.x), wy = win(uvw.y), wz = win(uvw.z);
			const fade = wx.mul(wy).mul(wz);
			// product rule: ∇(dens·fade) = fade·∇dens + dens·∇fade
			const gradFade = vec3(
				winD(uvw.x).mul(wy).mul(wz),
				winD(uvw.y).mul(wx).mul(wz),
				winD(uvw.z).mul(wx).mul(wy),
			).div(size);
			const gradOut = grad.mul(fade).add(gradFade.mul(dens));
			textureStore(volume, vec3(x, y, z), vec4(dens.mul(fade), gradOut));
			textureStore(emitVol, vec3(x, y, z), vec4(emit.mul(fade), 0, 0, 0));
		})().compute(GRID * GRID * GRID);

		// ---- pass 3: march the isosurface -------------------------------------
		const uIso = uniform(iso);
		const uRefract = uniform(refract);
		const uFresnelStrength = uniform(fresnelStrength);
		const uFresnelBase = uniform(fresnelBase);
		const uRimStrength = uniform(rimStrength);
		const MARCH_STEPS = marchSteps;
		Object.assign(this.u, { uIso, uRefract, uFresnelStrength, uFresnelBase, uRimStrength });

		const densityTex = texture3D(volume, null, 0);
		this._sceneTex = texture(sceneTexture);
		this._rimTex = texture(rimTexture);
		const sceneTex = this._sceneTex;
		const rimTex = this._rimTex;
		const emitTex = texture3D(emitVol, null, 0);
		// world point → density UVW inside the box. R = density, GBA = ∇density
		const fieldAt = (p) => densityTex.sample(p.sub(bMin).div(size));
		const densityAt = (p) => fieldAt(p).r;
		const emitAt = (p) => emitTex.sample(p.sub(bMin).div(size)).r;
		const INNER_STEP = Math.max(hx, hy, hz) * 0.03; // ~one blob-radius over 4 taps

		const mat = new MeshBasicNodeMaterial();
		mat.transparent = true;
		mat.depthWrite = false;
		mat.side = BackSide; // back faces: rays exist even when the camera is inside the box

		mat.colorNode = Fn(() => {
			const ro = cameraPosition;
			const rd = normalize(positionWorld.sub(cameraPosition));

			// slab intersection with the density box AABB
			const inv = vec3(1).div(rd);
			const tA = bMin.sub(ro).mul(inv);
			const tB = bMax.sub(ro).mul(inv);
			const tLo = tA.min(tB);
			const tHi = tA.max(tB);
			const tNear = tLo.x.max(tLo.y).max(tLo.z).max(0);
			const tFar = tHi.x.min(tHi.y).min(tHi.z);
			If(tFar.lessThanEqual(tNear), () => Discard());

			const stepLen = tFar.sub(tNear).div(MARCH_STEPS);
			const t = tNear.toVar();
			const tHit = float(-1).toVar();

			Loop(MARCH_STEPS, () => {
				const d = densityAt(ro.add(rd.mul(t)));
				If(d.greaterThanEqual(uIso), () => {
					// crossing bracketed in [t-stepLen, t]; binary-search the
					// isosurface — a single lerp leaves step-height contour
					// banding on grazing surfaces, bisection converges sub-step
					const lo = t.sub(stepLen).toVar();
					const hi = t.toVar();
					Loop(4, () => {
						const mid = lo.add(hi).mul(0.5);
						If(densityAt(ro.add(rd.mul(mid))).greaterThanEqual(uIso),
							() => { hi.assign(mid); }).Else(() => { lo.assign(mid); });
					});
					tHit.assign(lo.add(hi).mul(0.5));
					Break();
				});
				t.addAssign(stepLen);
			});
			If(tHit.lessThan(0), () => Discard());

			const p = ro.add(rd.mul(tHit));
			// normal from the splatted analytic gradient (GBA channels) — one
			// sample of a blend of per-particle smooth gradients, so no
			// finite-difference quantization and no trilinear-facet banding.
			// Gradient points into the mass; the outward normal is its negation.
			const n = normalize(fieldAt(p).gba.negate());

			const fres = rd.dot(n).abs().oneMinus().pow(2);
			// aspect-correct offset: equal normals shift equal PIXELS, not UV
			const refractOffset = n.xy
				.mul(vec2(screenSize.y.div(screenSize.x), 1))
				.mul(uRefract.negate());
			const refracted = sceneTex.sample(screenUV.add(refractOffset));
			const rim = rimTex.sample(screenUV).mul(fres.mul(uRimStrength));
			const base = refracted.mul(fres.mul(uFresnelStrength).add(uFresnelBase)).add(rim);

			// interior glow: a few short steps INTO the mass along the ray, summing
			// splatted emission. The globule lights from within (vessel of trapped
			// light), and the (1+fres) factor sets the rim on fire at grazing angles.
			const glow = float(0).toVar();
			const gp = p.toVar();
			Loop(innerSteps, () => {
				gp.addAssign(rd.mul(INNER_STEP));
				glow.addAssign(emitAt(gp));
			});
			glow.mulAssign(uEmitGain.div(innerSteps));
			const glowCol = uEmitColor.mul(glow).mul(fres.add(1));
			return vec4(base.rgb.add(glowCol), base.a);
		})();

		this.material = mat;
		this.mesh = new Mesh(new BoxGeometry(2 * hx, 2 * hy, 2 * hz), mat);
		this.mesh.position.set(cx, cy, cz);
		this.mesh.frustumCulled = false;
	}

	setSceneTexture(tex) { this._sceneTex.value = tex; }
	setRimTexture(tex) { this._rimTex.value = tex; }

	/**
	 * Queue a charge-injection sphere for the next update(). Many can be queued per
	 * frame — a whole bolt channel (both ends + interior taps) plus every other arc
	 * firing this frame. Up to INJ_K are applied; extras are dropped. Charge
	 * accumulates in pCharge and decays from there.
	 * @param {Vector3} worldPos
	 * @param {number} [radius=0.4]
	 * @param {number} [amount=1]
	 */
	injectCharge(worldPos, radius = 0.4, amount = 1) {
		this._pendingInj.push({ pos: worldPos, r: radius, amt: amount });
	}

	/** Back-compat single-point terminus (see injectCharge). */
	strike(worldPos, radius = 0.6, amount = 1) {
		this.injectCharge(worldPos, radius, amount);
	}

	// advance one frame: sync drivers, run the two compute passes. Must be called
	// BEFORE the scene render (the march samples the density texture).
	update(dt, t) {
		this.u.uDt.value = dt;
		this.u.uT.value = t;
		for (const d of this.drivers) {
			if (d.update) d.update(dt, t);
		}
		// load this frame's queued charge points into the injection slots
		const pend = this._pendingInj;
		const slots = this.u.uInjAmt.length;
		for (let k = 0; k < slots; k++) {
			const p = pend[k];
			this.u.uInjAmt[k].value = p ? p.amt : 0;
			if (p) {
				this.u.uInjPos[k].value.copy(p.pos);
				this.u.uInjR[k].value = p.r;
			}
		}
		this._pendingInj = [];
		this.renderer.compute(this.simCompute);
		this.renderer.compute(this.splatCompute);
	}
}
