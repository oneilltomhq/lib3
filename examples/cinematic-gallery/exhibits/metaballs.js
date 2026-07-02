// Metaballs — smooth-min SDF spheres sphere-traced inside a real glass box in
// the room. The library's smoothMinSphereSdf / raymarchSdf / estimateSdfNormal
// do the field work in the box's local space; the surface normal refracts a
// live low-res render of the room (a pre-pass with this exhibit hidden), and
// the hit depth is written back so plinths and neighbours composite correctly.
// The depth write costs a second march of the same field — toggle WRITE_DEPTH
// off if that ever matters.

import {
  Discard,
  Fn,
  If,
  cameraNear,
  cameraFar,
  cameraPosition,
  cameraViewMatrix,
  float,
  max,
  min,
  modelWorldMatrix,
  modelWorldMatrixInverse,
  positionGeometry,
  screenUV,
  texture,
  uniform,
  uniformArray,
  varying,
  vec3,
  vec4,
  viewZToPerspectiveDepth,
} from "three/tsl";
import * as THREE from "three/webgpu";
import {
  estimateSdfNormal,
  raymarchSdf,
  smoothMinSphereSdf,
} from "../../../src/metaballs.js";

const BOX_SCALE = 1.3;
const COUNT = 12;
const MAX_STEPS = 48;
const WRITE_DEPTH = true;
const PREPASS = { width: 640, height: 360 };
const DANCE = { speed: 0.55, violence: 0.6, pulse: 0.5 };
// per-axis scale on the lab dance (whose raw amplitudes reach ~1.5 / 0.9 /
// 0.7); keeps |coord| + radius + smoothing bulge inside the 0.5 half-box
const AMP = { x: 0.21, y: 0.3, z: 0.35 };

const GLASS = {
  smoothing: 0.1,
  refraction: 0.25,
  fresnelBase: 0.55,
  fresnelStrength: 0.85,
  rimStrength: 0.45,
};

export async function createMetaballsExhibit() {
  const sources = Array.from({ length: COUNT }, (_, i) => {
    const baseRadius = 0.04 + Math.pow((i % 6) / 5, 1.5) * 0.05;
    return {
      position: new THREE.Vector3(),
      radius: baseRadius,
      baseRadius,
      phase: i * 0.73,
      lane: i % 3,
    };
  });

  const uPositions = uniformArray(sources.map((s) => s.position.clone()));
  const uRadii = uniformArray(sources.map((s) => s.radius), "float");
  const uSmoothing = uniform(GLASS.smoothing);
  const uRefraction = uniform(GLASS.refraction);

  const roomRT = new THREE.RenderTarget(PREPASS.width, PREPASS.height, {
    type: THREE.HalfFloatType,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
  });
  const roomTex = texture(roomRT.texture);

  const sdf = Fn(([p]) =>
    smoothMinSphereSdf({
      p,
      positions: uPositions,
      radii: uRadii,
      count: COUNT,
      smoothing: uSmoothing,
    })
  );

  // ray through the box in local space; returns the march result
  const marchBox = () => {
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

    const march = raymarchSdf({
      sdf,
      rayOrigin: vOrigin,
      rayDirection: rayDir,
      tNear: t0,
      tFar: t1,
      maxSteps: MAX_STEPS,
      threshold: 0.0025,
    });
    return { march, rayDir };
  };

  const material = new THREE.MeshBasicNodeMaterial();
  material.side = THREE.FrontSide; // the focus pose stays outside the glass
  material.depthWrite = true;

  material.colorNode = Fn(() => {
    const { march, rayDir } = marchBox();
    If(march.hit.not(), () => Discard());

    const n = estimateSdfNormal({ sdf, p: march.p, epsilon: 0.005 });
    // group doesn't rotate, so local n == world n; take it to view space so
    // the refraction offset tracks the visitor's orbit
    const nView = vec3(cameraViewMatrix.mul(vec4(n, 0.0)));

    const fres = rayDir.dot(n).abs().oneMinus().pow(2);
    const refracted = roomTex.sample(
      screenUV.add(nView.xy.mul(uRefraction.negate()))
    );
    const rim = roomTex.sample(screenUV);
    const beauty = refracted.rgb
      .mul(fres.mul(GLASS.fresnelStrength).add(GLASS.fresnelBase))
      .add(rim.rgb.mul(fres.mul(GLASS.rimStrength)));

    return vec4(beauty, 1.0);
  })();

  if (WRITE_DEPTH) {
    material.depthNode = Fn(() => {
      const { march } = marchBox();
      const world = vec3(modelWorldMatrix.mul(vec4(march.p, 1.0)));
      const viewZ = cameraViewMatrix.mul(vec4(world, 1.0)).z;
      return viewZToPerspectiveDepth(viewZ, cameraNear, cameraFar);
    })();
  }

  const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), material);
  mesh.scale.setScalar(BOX_SCALE);

  const group = new THREE.Group();
  group.add(mesh);

  let motionTime = 0;

  return {
    group,
    radius: (BOX_SCALE * Math.sqrt(3)) / 2,
    update(dt) {
      motionTime += dt * DANCE.speed;

      for (let i = 0; i < sources.length; i++) {
        const source = sources[i];
        const lane = source.lane - 1;
        const t = motionTime * (1.25 + source.lane * 0.28) + source.phase;
        const boil = motionTime * (3.2 + (i % 5) * 0.17) + source.phase * 1.7;
        const snap = Math.sin(boil * 1.9 + i) * Math.cos(boil * 0.73);
        const swirl = 0.4 + DANCE.violence * 0.85;
        const churn = DANCE.violence * 0.45;

        source.position.set(
          (Math.sin(t * 1.17) * swirl +
            Math.sin(boil * 2.1 + lane) * churn +
            lane * 0.22 +
            snap * DANCE.violence * 0.2) *
            AMP.x,
          (Math.sin(t * 1.73 + lane) * (0.32 + DANCE.violence * 0.5) +
            Math.cos(boil * 2.6 + i * 0.31) * churn) *
            AMP.y,
          (Math.cos(t * 1.31 + i * 0.11) * (0.25 + DANCE.violence * 0.37) +
            Math.sin(boil * 1.43 + lane * 1.9) * DANCE.violence * 0.38) *
            AMP.z,
        );
        source.radius =
          source.baseRadius *
          (0.86 + Math.sin(boil * 2.4 + i) * DANCE.pulse * 0.14);

        uPositions.array[i].copy(source.position);
        uRadii.array[i] = source.radius;
      }
    },
    // render the room without this exhibit; the glass refracts the result
    prepass(renderer, scene, camera) {
      group.visible = false;
      renderer.setRenderTarget(roomRT);
      renderer.render(scene, camera);
      renderer.setRenderTarget(null);
      group.visible = true;
    },
  };
}
