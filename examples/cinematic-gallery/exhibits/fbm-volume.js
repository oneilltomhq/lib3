// Ember — the anisotropic-fbm-volume piece, pinned to Tom's "ember" preset,
// as an actual volume floating in the room. A compute pass bakes ridged fBm
// into a 128³ storage texture (re-baked at BAKE_HZ so `evolve` churns), then
// a front-to-back emission/absorption march renders the box. Raymarch cost
// scales with pixels covered, so distance is its own level-of-detail.
// Shader lifted from examples/anisotropic-fbm-volume/main.js — promote it to
// src/ when a third consumer appears.

import {
  Break,
  Fn,
  If,
  Loop,
  abs,
  cameraPosition,
  cos,
  dot,
  float,
  fract,
  instanceIndex,
  int,
  max,
  min,
  mix,
  modelWorldMatrixInverse,
  positionGeometry,
  pow,
  screenUV,
  sin,
  smoothstep,
  texture3D,
  textureStore,
  uniform,
  varying,
  vec2,
  vec3,
  vec4,
} from "three/tsl";
import * as THREE from "three/webgpu";
import { Spring } from "../../../src/conductor.js";
import { simplexNoise3 } from "../../../src/index.js";

const SIZE = 128;
const OCTAVES = 5;
const BAKE_HZ = 20;
const BOX_SCALE = 1.15;

// Tom's "ember" find: thinned right out (density 7) and brightened so the
// sparse matter glows; evolve maxed for fast churn. Knobs only — framing is
// the visitor's business now.
const EMBER = {
  aniso: 2.3, swirl: 5.4, thresh: 0.42, gamma: 3.0, density: 7,
  intensity: 3.0, fade: 0.1, steps: 32, ridge: 0.75, gain: 0.42,
  domain: 3.5, evolve: 0.4,
};

const DRIFT = [
  { dir: [0.0, 0.2, 1.0], speed: 1.0 },
  { dir: [0.8, -0.3, -0.6], speed: 1.6 },
  { dir: [-0.6, 0.9, 0.3], speed: 2.3 },
  { dir: [0.4, -1.0, 0.5], speed: 3.1 },
  { dir: [-0.9, 0.1, -0.8], speed: 4.0 },
];

// rhythm: smoke doesn't hit — it breathes. Churn rate rides the phrase arc
// (calm at the head, boiling by the end, release), and a soft intensity
// thump lands once a bar, springing back down slowly.
const VOICE = { steps: 4, hits: 1 };
const DANCE = { churn: [0.5, 2.0], thump: 0.9, pump: 0.2 }; // smoke ducks gently

export async function createFbmVolumeExhibit({ conductor } = {}) {
  const uRidge = uniform(EMBER.ridge);
  const uGain = uniform(EMBER.gain);
  const uDomain = uniform(EMBER.domain);
  const uEvolve = uniform(0.0);
  const uAniso = uniform(EMBER.aniso);
  const uSwirl = uniform(EMBER.swirl);
  const uThresh = uniform(EMBER.thresh);
  const uGamma = uniform(EMBER.gamma);
  const uDensity = uniform(EMBER.density);
  const uIntensity = uniform(EMBER.intensity);
  const uFade = uniform(EMBER.fade);
  const uSteps = uniform(EMBER.steps);

  const storageTexture = new THREE.Storage3DTexture(SIZE, SIZE, SIZE);
  storageTexture.generateMipmaps = false;
  storageTexture.minFilter = THREE.LinearFilter;
  storageTexture.magFilter = THREE.LinearFilter;
  storageTexture.name = "fbmVolumeEmber";

  const ridged = Fn(({ x }) => float(1.0).sub(abs(x).mul(2.0).sub(1.0).abs()));

  const bake = Fn(() => {
    const id = instanceIndex;
    const x = id.mod(SIZE);
    const y = id.div(SIZE).mod(SIZE);
    const z = id.div(SIZE * SIZE);

    const p = vec3(float(x), float(y), float(z)).add(0.5).div(SIZE).sub(0.5);
    const q = p.mul(uDomain);

    let sum = float(0.0);
    let ampSum = float(0.0);
    let amp = float(1.0);
    let freq = 1.0;
    for (let o = 0; o < OCTAVES; o++) {
      const { dir, speed } = DRIFT[o];
      const off = vec3(...dir).mul(uEvolve.mul(speed));
      const n = simplexNoise3({ v: q.mul(freq).add(off) });
      const r = mix(abs(n), ridged({ x: n }), uRidge);
      sum = sum.add(r.mul(amp));
      ampSum = ampSum.add(amp);
      amp = amp.mul(uGain);
      freq *= 2.0;
    }

    textureStore(storageTexture, vec3(x, y, z), vec4(sum.div(ampSum), 0, 0, 1));
  });

  const bakeNode = bake().compute(SIZE ** 3).setName("bakeFbmVolumeEmber");

  const tex = texture3D(storageTexture, null, 0);

  const volumeColor = Fn(() => {
    const vOrigin = varying(
      vec3(modelWorldMatrixInverse.mul(vec4(cameraPosition, 1.0)))
    );
    const vDirection = varying(positionGeometry.sub(vOrigin));
    const rayDir = vDirection.normalize();

    const invDir = rayDir.reciprocal();
    const tmin = vec3(-0.5).sub(vOrigin).mul(invDir);
    const tmax = vec3(0.5).sub(vOrigin).mul(invDir);
    const tlo = min(tmin, tmax);
    const thi = max(tmin, tmax);
    const t0 = max(max(tlo.x, max(tlo.y, tlo.z)), 0.0);
    const t1 = min(thi.x, min(thi.y, thi.z));
    t0.greaterThanEqual(t1).discard();

    const stepLen = t1.sub(t0).div(uSteps);
    const jitter = fract(
      sin(dot(screenUV, vec2(12.9898, 78.233))).mul(43758.5453)
    );
    const t = float(t0.add(stepLen.mul(jitter))).toVar();

    const light = float(0.0).toVar();
    const trans = float(1.0).toVar();

    Loop({ type: "int", start: int(0), end: int(uSteps) }, () => {
      If(t.greaterThan(t1), () => Break());
      const p = vOrigin.add(rayDir.mul(t));

      const ang = uSwirl.mul(p.y);
      const c = cos(ang);
      const s = sin(ang);
      const pr = vec3(
        p.x.mul(c).sub(p.z.mul(s)),
        p.y,
        p.x.mul(s).add(p.z.mul(c))
      );
      const q = pr.mul(vec3(1.0, float(1.0).div(uAniso), 1.0)).add(0.5);
      const v = tex.sample(q).r;

      // fade start clamped below the wall: smoothstep(0.5, 0.5, x) is
      // undefined and blanks the volume
      const fadeStart = uFade.min(0.495);
      const fade = smoothstep(0.5, fadeStart, abs(p.x))
        .mul(smoothstep(0.5, fadeStart, abs(p.y)))
        .mul(smoothstep(0.5, fadeStart, abs(p.z)));
      const d = pow(smoothstep(uThresh, 1.0, v), uGamma).mul(fade);

      const a = d.mul(uDensity).mul(stepLen).clamp(0.0, 1.0);
      light.addAssign(trans.mul(a));
      trans.mulAssign(float(1.0).sub(a));
      If(trans.lessThan(0.02), () => Break());

      t.addAssign(stepLen);
    });

    const out = light.mul(uIntensity);
    return vec4(vec3(out), light.clamp(0.0, 1.0));
  });

  const material = new THREE.NodeMaterial();
  material.colorNode = volumeColor();
  material.side = THREE.BackSide;
  material.transparent = true;
  material.depthWrite = false; // shares a room with other transparents now

  const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), material);
  mesh.scale.setScalar(BOX_SCALE);

  const group = new THREE.Group();
  group.add(mesh);

  let bakeAccum = Infinity; // force a bake on the first frame

  const thumpSpring = new Spring({
    value: EMBER.intensity,
    freq: 1.1,
    zeta: 0.8,
  });
  conductor?.voice({
    ...VOICE,
    onHit: ({ accent }) => thumpSpring.kick(DANCE.thump * accent),
  });

  return {
    group,
    radius: (BOX_SCALE * Math.sqrt(3)) / 2,
    update(dt) {
      if (conductor) {
        const [lo, hi] = DANCE.churn;
        uEvolve.value += dt * EMBER.evolve * (lo + (hi - lo) * conductor.phrase01);
        const duck = 1 - DANCE.pump * (1 - conductor.pump());
        uIntensity.value = thumpSpring.update(dt) * duck;
      } else {
        uEvolve.value += dt * EMBER.evolve;
      }
      bakeAccum += dt;
    },
    compute(renderer) {
      if (bakeAccum < 1 / BAKE_HZ) return;
      bakeAccum = 0;
      renderer.compute(bakeNode);
    },
  };
}
