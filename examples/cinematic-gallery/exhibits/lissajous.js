// Lissajous Beam — the 3D lissajous module's "sphere knot" preset hanging in
// the room: 3,500 additive points positioned and coloured entirely by the TSL
// nodes. Depth-tested so the room occludes it correctly, depth-write off so
// the beam self-accumulates.

import { float, uniform } from "three/tsl";
import * as THREE from "three/webgpu";
import { Spring } from "../../../src/conductor.js";
import {
  LISSAJOUS_DEFAULTS,
  LISSAJOUS_PRESETS,
  beamSampleT,
  lissajousAt,
  lissajousBeamColor,
} from "../../../src/lissajous.js";

const N = 3500;
const GROUP_SCALE = 0.45;

// rhythm: quintillo voice (5 hits over 16). Hits kick the beam's gain —
// flash, ring, settle — and detune (the figure's precession rate, motion
// that IS the math) climbs through each phrase and releases at the head.
const VOICE = { steps: 16, hits: 5, rotate: 2 };
const DANCE = { gainKick: 0.55, detune: [0.03, 0.14], pump: 0.45 };

export async function createLissajousExhibit({ conductor } = {}) {
  const knobs = {
    ...LISSAJOUS_DEFAULTS,
    ...LISSAJOUS_PRESETS["sphere knot"],
    colorDepth: 0.5,
    driftDepth: 0.1,
    gain: 0.7,
  };
  const U = {};
  for (const k in knobs) U[k] = uniform(knobs[k]);
  const time = uniform(0);

  const geo = new THREE.BufferGeometry();
  geo.setAttribute(
    "position",
    new THREE.BufferAttribute(new Float32Array(N * 3), 3) // positionNode overrides
  );

  const t = beamSampleT({ time, trace: U.trace, count: float(N) });
  const params = { ...U, t, dt: U.trace.div(N) };

  const material = new THREE.PointsNodeMaterial({
    blending: THREE.AdditiveBlending,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    sizeAttenuation: false,
  });
  material.positionNode = lissajousAt(params).mul(U.scale);
  material.colorNode = lissajousBeamColor(params);
  material.size = knobs.size;

  const points = new THREE.Points(geo, material);
  points.frustumCulled = false; // geometry positions are GPU-generated
  points.scale.setScalar(GROUP_SCALE);

  const group = new THREE.Group();
  group.add(points);

  const gainSpring = new Spring({
    value: knobs.gain,
    freq: 2.8,
    zeta: 0.35,
  });
  conductor?.voice({
    ...VOICE,
    onHit: ({ accent }) => gainSpring.kick(DANCE.gainKick * accent),
  });

  return {
    group,
    radius: knobs.scale * GROUP_SCALE * 1.2,
    update(dt) {
      time.value += dt;
      if (conductor) {
        const duck = 1 - DANCE.pump * (1 - conductor.pump());
        U.gain.value = Math.max(0.1, gainSpring.update(dt)) * duck;
        const [lo, hi] = DANCE.detune;
        U.detuneY.value = lo + (hi - lo) * conductor.phrase01;
      }
    },
  };
}
