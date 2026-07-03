// Knot Morph — torus-knot vertices carry their (3,5) counterpart as a second
// attribute; the vertex stage mixes between the two curves while the knot
// turns on its plinth.
//
// The exhibit is a fixed spherical window (WINDOW_FADE, measured from the
// exhibit's centre in world space — the fbm volume's wall-fade move, sphere
// instead of box). The weave itself is scaled up and offset so the strand
// band passes through the window's centre: what you see is a crop into the
// thick of the morph, not the whole knot from outside. Zoom the piece by
// pushing WEAVE.scale — the window, plinth footprint, and focus pose never
// change. A small camera-distance mute keeps wires off your eyes when the
// focus pose (exhibits.js focusMargin) steps you inside.

import {
  color,
  mix,
  modelWorldMatrix,
  normalView,
  positionView,
  positionViewDirection,
  uniform,
  vec4,
} from "three/tsl";
import * as THREE from "three/webgpu";
import { Spring } from "../../../src/conductor.js";
import { knotMorphPosition } from "../../../src/knotMorph.js";

// weave-local: the strand band sits at xz radius ~0.5–1.5, tube ±0.4, so an
// offset of ~1.0·scale puts the band's midline through the exhibit centre.
// wobble nods the weave on a second axis so the same gap never parks in the
// window — the crop wanders less to one side as the wall of strands turns.
const WEAVE = { scale: 1.15, offset: 0.95, spin: 0.3, wobble: 0.18 };
const WIRE_COLORS = { start: 0x1fb8ff, target: 0x49ffa0 }; // (2,3) → (3,5)
const WINDOW_FADE = [0.5, 0.72]; // world radius from exhibit centre: full → gone
const NEAR_MUTE = [0.15, 0.5]; // camera distance (m): silent → full

// rhythm: tresillo voice (3 hits over 8 steps), mapped to MOMENTUM, never to
// pose — the dancer's body keeps moving and the beat pushes it. Morph phase
// rolls forever; hits surge its speed (downbeat hardest) and the surge
// decays back to a slow base roll. Spin gets the same treatment, and the
// wobble sway deepens through each phrase.
const VOICE = { steps: 8, hits: 3 };
const DANCE = {
  rollRate: 0.35, // rad/s base morph roll (full cycle ~18s unpushed)
  surge: 1.6, // morph-speed kick per accented hit
  spinKick: 0.5,
  swayGrow: 1.2, // how much phrase tension deepens the wobble
  pump: 0.4, // wire brightness ducking to the room kick
};

export async function createKnotExhibit({ conductor } = {}) {
  const startGeo = new THREE.TorusKnotGeometry(1, 0.4, 128, 32, 2, 3);
  const targetGeo = new THREE.TorusKnotGeometry(1, 0.4, 128, 32, 3, 5);
  startGeo.setAttribute(
    "targetPosition",
    new THREE.BufferAttribute(targetGeo.getAttribute("position").array, 3)
  );

  const uMix = uniform(0);
  const uCenter = uniform(new THREE.Vector3());
  const uDuck = uniform(1); // room-kick brightness pump

  const wireMat = new THREE.MeshBasicNodeMaterial({
    wireframe: true,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  wireMat.positionNode = knotMorphPosition({ mixFactor: uMix });

  // spherical window measured from the exhibit centre in world space, so the
  // weave can be any size or offset behind it
  const worldPos = modelWorldMatrix.mul(
    vec4(knotMorphPosition({ mixFactor: uMix }), 1.0)
  ).xyz;
  const windowed = worldPos
    .sub(uCenter)
    .length()
    .smoothstep(WINDOW_FADE[0], WINDOW_FADE[1])
    .oneMinus();
  const nearMute = positionView
    .length()
    .smoothstep(NEAR_MUTE[0], NEAR_MUTE[1]);
  const fres = normalView
    .dot(positionViewDirection)
    .abs()
    .oneMinus()
    .pow(1.5);
  wireMat.colorNode = mix(
    color(WIRE_COLORS.start),
    color(WIRE_COLORS.target),
    uMix
  ).mul(windowed.mul(nearMute).mul(fres.mul(0.25).add(0.18)).mul(uDuck));

  const mesh = new THREE.Mesh(startGeo, wireMat);
  mesh.scale.setScalar(WEAVE.scale);
  mesh.position.x = WEAVE.offset * WEAVE.scale;

  const group = new THREE.Group();
  group.add(mesh);

  // rate springs: value is a SPEED that beats kick and decay pulls home
  const rollRate = new Spring({
    value: DANCE.rollRate,
    target: DANCE.rollRate,
    freq: 0.6,
    zeta: 1.0,
  });
  const spinBoost = new Spring({ value: 0, target: 0, freq: 0.7, zeta: 0.9 });
  let rollPhase = 0;

  conductor?.voice({
    ...VOICE,
    onHit({ accent }) {
      rollRate.kick(DANCE.surge * accent);
      spinBoost.kick(DANCE.spinKick * accent);
    },
  });

  return {
    group,
    // the window IS the exhibit's extent — framing and the hit proxy key off
    // it, so WEAVE.scale can grow without touching the room
    radius: WINDOW_FADE[1],
    update(dt, elapsed) {
      let sway = WEAVE.wobble;
      if (conductor) {
        // phase never stops; beats only change how hard it rolls
        rollPhase += Math.max(0.05, rollRate.update(dt)) * dt;
        uMix.value = 0.5 - 0.5 * Math.cos(rollPhase);
        mesh.rotation.y += (WEAVE.spin + spinBoost.update(dt)) * dt;
        sway *= 1 + DANCE.swayGrow * conductor.phrase01;
        uDuck.value = 1 - DANCE.pump * (1 - conductor.pump());
      } else {
        uMix.value = Math.abs(Math.sin(elapsed * 0.5));
        mesh.rotation.y += WEAVE.spin * dt;
      }
      mesh.rotation.x = Math.sin(elapsed * 0.21) * sway;
      mesh.rotation.z = Math.sin(elapsed * 0.13 + 1.7) * sway * 0.6;
      group.getWorldPosition(uCenter.value);
    },
  };
}
