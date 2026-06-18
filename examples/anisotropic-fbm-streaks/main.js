import { setup } from "../_shared/setup.js";
import { Inspector } from "three/addons/inspector/Inspector.js";
import {
  Fn,
  Loop,
  abs,
  clamp,
  float,
  mix,
  time,
  uniform,
  uv,
  vec3,
  vec4,
} from "three/tsl";
import { simplexNoise3 } from "../../src/index.js";

// Scene setup
const { THREE, renderer, scene, camera, loop } = setup({ fov: 60 });
camera.position.set(0, 0, 2.2);
renderer.setClearColor(0x000000);
renderer.inspector = new Inspector();

// Controls - define uniforms outside the shader function so Inspector can access them
const scaleX = uniform(0.25);
const scaleY = uniform(4.0);
const integrateSamples = uniform(12);
const ridgedSharpness = uniform(0.85);
const warpStrength = uniform(0.15);
const fbmLacunarity = uniform(2.0);
const fbmGain = uniform(0.5);
const animate = uniform(1);

// TSL shader that generates anisotropic ridged fBm with vertical streak integration
const streakTextureTSL = Fn(() => {
  const uv0 = uv();

  // Aspect fix: scale X by aspect so isotropic base maps to screen space
  const aspect = float(window.innerWidth / window.innerHeight);

  // Prepare anisotropic domain: stretch Y, compress X
  const baseP = vec3(
    uv0.x.mul(scaleX).mul(aspect),
    uv0.y.mul(scaleY),
    time.mul(animate.mul(0.1))
  ).toVar();

  // Domain warp (mostly X) to introduce curvy drips and clumps
  const warpNoise = simplexNoise3({ v: baseP.mul(0.6) });
  baseP.x.addAssign(warpNoise.mul(warpStrength));

  // Ridged fBm helper
  const ridged = Fn(({ x }) => float(1.0).sub(abs(x).mul(2.0).sub(1.0).abs()));

  const fbmRidged = Fn(({ p }) => {
    const octaves = 5;
    const sum = float(0.0).toVar();
    const amp = float(1.0).toVar();
    const maxAmp = float(0.0).toVar();
    const freq = float(1.0).toVar();

    Loop(octaves, ({ i }) => {
      const n = simplexNoise3({ v: p.mul(freq) });
      const r = mix(abs(n), ridged({ x: n }), ridgedSharpness);
      sum.addAssign(r.mul(amp));
      maxAmp.addAssign(amp);
      amp.mulAssign(fbmGain);
      freq.mulAssign(fbmLacunarity);
    });

    return sum.div(maxAmp);
  });

  // Integrate upwards along Y to create vertical streaks (one-direction blur)
  const accum = float(0.0).toVar();
  const weightSum = float(0.0).toVar();
  const invSamples = float(1.0).div(integrateSamples);

  Loop(integrateSamples, ({ i }) => {
    const t = float(i).mul(invSamples);
    const weight = float(1.0).sub(t); // heavier near current row
    const p = vec3(baseP.x, baseP.y.add(t.mul(0.35)), baseP.z);
    const v = fbmRidged({ p });
    accum.addAssign(v.mul(weight));
    weightSum.addAssign(weight);
  });

  const gray = clamp(accum.div(weightSum), 0, 1);
  // Contrast and slight lift for readability
  const outV = clamp(gray.mul(1.35).add(0.02), 0, 1);
  return vec4(outV, outV, outV, 1.0);
});

const material = new THREE.MeshBasicNodeMaterial();
material.colorNode = streakTextureTSL();

const mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material);
scene.add(mesh);

// Inspector GUI
const gui = renderer.inspector.createParameters("Anisotropic FBM Streaks");
gui.add(scaleX, "value", 0.1, 5.0, 0.1).name("scaleX");
gui.add(scaleY, "value", 0.5, 10.0, 0.1).name("scaleY");
gui.add(integrateSamples, "value", 1, 24, 1).name("integrateSamples");
gui.add(ridgedSharpness, "value", 0.0, 1.0, 0.01).name("ridgedSharpness");
gui.add(warpStrength, "value", 0.0, 2.0, 0.01).name("warpStrength");
gui.add(fbmLacunarity, "value", 0.1, 4.0, 0.1).name("fbmLacunarity");
gui.add(fbmGain, "value", 0.25, 1.0, 0.01).name("fbmGain");
gui.add(animate, "value", 0, 1, 1).name("animate");

loop();
