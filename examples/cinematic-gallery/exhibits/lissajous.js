// Lissajous Beam — the 3D lissajous module's "sphere knot" preset hanging in
// the room: 3,500 additive points positioned and coloured entirely by the TSL
// nodes. Depth-tested so the room occludes it correctly, depth-write off so
// the beam self-accumulates.

import { float, uniform } from "three/tsl";
import * as THREE from "three/webgpu";
import {
  LISSAJOUS_DEFAULTS,
  LISSAJOUS_PRESETS,
  beamSampleT,
  lissajousAt,
  lissajousBeamColor,
} from "../../../src/lissajous.js";

const N = 3500;
const GROUP_SCALE = 0.45;

export async function createLissajousExhibit() {
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

  return {
    group,
    radius: knobs.scale * GROUP_SCALE * 1.2,
    update(dt) {
      time.value += dt;
    },
  };
}
