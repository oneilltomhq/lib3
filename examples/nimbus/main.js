/**
 * Nimbus — lib3 example
 *
 * Volumetric cumulonimbus at night with intracloud sheet lightning and
 * cloud-to-ground strikes. Baked procedural cloud, TSL raymarch material
 * with internal flash lights, CPU bolt ribbons, storm director, bloom.
 */
import * as THREE from 'three/webgpu';
import { uniform, Fn, vec3, vec4, float, positionLocal, positionWorld, normalize, mix, smoothstep, pass, mx_noise_float } from 'three/tsl';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';

import { bakeCumulonimbusTexture, bakeDetailNoiseTexture } from '../../src/nimbus/cloudTexture.js';
import { NimbusCloudMaterial } from '../../src/nimbus/cloudMaterial.js';
import { LightningBoltMesh } from '../../src/nimbus/bolt.js';
import { StormDirector } from '../../src/nimbus/storm.js';

const container = document.getElementById('container');
const errorEl = document.getElementById('error');

try {
  await init();
} catch (e) {
  errorEl.style.display = 'block';
  errorEl.textContent = e.message + '\n\n' + e.stack;
  throw e;
}

async function init() {
  const renderer = new THREE.WebGPURenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  container.appendChild(renderer.domElement);
  await renderer.init();

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(58, window.innerWidth / window.innerHeight, 0.1, 500);
  camera.position.set(2, 3.5, 30);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(0, 11, 0);
  controls.maxPolarAngle = Math.PI * 0.52;
  controls.update();

  // ── Camera modes ───────────────────────────────────────────────────────────
  // 'amidst' — drifting through the outer wisps at cloud-base height (default)
  // 'vista'  — the wide diorama with orbit controls
  let mode = 'amidst';
  let driftT = 0;
  const lookTarget = new THREE.Vector3();

  function setMode(next) {
    mode = next;
    controls.enabled = mode === 'vista';
    if (mode === 'vista') {
      camera.position.set(2, 3.5, 30);
      controls.target.set(0, 11, 0);
      controls.update();
    }
    const hint = document.getElementById('hint');
    if (hint) {
      hint.textContent = mode === 'amidst'
        ? 'click / space — strike · v — vista'
        : 'click / space — strike · v — amidst · drag — orbit';
    }
  }

  const timer = new THREE.Timer();

  // ── Sky dome: night gradient + flash lift ──────────────────────────────────
  const skyFlash = uniform(0);
  const skyMat = new THREE.NodeMaterial();
  skyMat.side = THREE.BackSide;
  skyMat.depthWrite = false;
  skyMat.colorNode = Fn(() => {
    const h = normalize(positionLocal).y;
    const horizon = vec3(0.045, 0.05, 0.085);
    const zenith = vec3(0.004, 0.005, 0.012);
    const sky = mix(horizon, zenith, smoothstep(float(-0.1), float(0.5), h));
    const flash = vec3(0.35, 0.4, 0.6).mul(skyFlash).mul(smoothstep(float(-0.2), float(0.35), h).oneMinus().mul(0.7).add(0.3));
    return vec4(sky.add(flash), 1);
  })();
  const skyMesh = new THREE.Mesh(new THREE.SphereGeometry(220, 32, 16), skyMat);
  scene.add(skyMesh);

  // ── Stars ──────────────────────────────────────────────────────────────────
  {
    const N = 900;
    const pos = new Float32Array(N * 3);
    for (let i = 0; i < N; i++) {
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.acos(Math.random() * 0.95);
      const r = 200;
      pos[i * 3] = r * Math.sin(phi) * Math.cos(theta);
      pos[i * 3 + 1] = r * Math.cos(phi) + 2;
      pos[i * 3 + 2] = r * Math.sin(phi) * Math.sin(theta);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const mat = new THREE.PointsMaterial({
      color: 0x9aa7c9, size: 0.55, sizeAttenuation: true,
      transparent: true, opacity: 0.85, depthWrite: false,
    });
    scene.add(new THREE.Points(geo, mat));
  }

  // ── Ground ─────────────────────────────────────────────────────────────────
  const groundMat = new THREE.MeshStandardNodeMaterial({ roughness: 0.55, metalness: 0.0 });
  groundMat.colorNode = Fn(() => {
    // Large-scale tonal patches + fine grain so the flash has terrain to reveal.
    const patches = mx_noise_float(positionWorld.xz.mul(0.05)).mul(0.5).add(0.5);
    const grain = mx_noise_float(positionWorld.xz.mul(0.6)).mul(0.5).add(0.5);
    return vec3(0.11, 0.12, 0.14).mul(patches.mul(0.55).add(0.45)).mul(grain.mul(0.4).add(0.7));
  })();
  const ground = new THREE.Mesh(new THREE.CircleGeometry(220, 64), groundMat);
  ground.rotation.x = -Math.PI / 2;
  scene.add(ground);

  // Dim moonlight so the ground isn't void-black between strikes.
  const moon = new THREE.DirectionalLight(0x46536e, 2.0);
  moon.position.set(-30, 50, 25);
  scene.add(moon);
  scene.add(new THREE.AmbientLight(0x0a0c14, 0.6));

  // Strike ground flash.
  const groundFlash = new THREE.PointLight(0xbcd2ff, 0, 60, 2.0);
  scene.add(groundFlash);

  // ── Cloud volume ───────────────────────────────────────────────────────────
  const bake = bakeCumulonimbusTexture({ size: 112, seed: 3 });
  const detailTexture = bakeDetailNoiseTexture({ size: 64, seed: 3 });

  const cloudMaterial = new NimbusCloudMaterial({
    densityTexture: bake.texture,
    detailTexture,
    steps: 110,
    flashLightCount: 3,
  });

  const cloudMesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), cloudMaterial);
  cloudMesh.scale.set(36, 18, 36);
  cloudMesh.position.set(0, 12, 0);
  cloudMesh.frustumCulled = false;
  cloudMesh.renderOrder = 2;
  scene.add(cloudMesh);
  cloudMesh.updateMatrixWorld();

  // ── Lightning bolt ─────────────────────────────────────────────────────────
  const bolt = new LightningBoltMesh();
  bolt.mesh.renderOrder = 1;
  scene.add(bolt.mesh);

  // ── Storm director ─────────────────────────────────────────────────────────
  const storm = new StormDirector({
    cloudMaterial,
    bolt,
    cloudMesh,
    densitySample: bake.sample,
    groundY: 0,
    strikeIntervalMin: 3.5,
    strikeIntervalMax: 8,
  });

  // ── Post: bloom ────────────────────────────────────────────────────────────
  const pipeline = new THREE.RenderPipeline(renderer);
  const scenePass = pass(scene, camera);
  const sceneColor = scenePass.getTextureNode();
  pipeline.outputNode = sceneColor.add(bloom(sceneColor, 0.5, 0.4, 1.15));

  // ── Interaction ────────────────────────────────────────────────────────────
  const forceStrike = (seed) => storm.strike(seed ?? ((Math.random() * 1e9) | 0));
  window.addEventListener('keydown', (e) => {
    if (e.code === 'Space') forceStrike();
    if (e.code === 'KeyV') setMode(mode === 'amidst' ? 'vista' : 'amidst');
  });
  renderer.domElement.addEventListener('pointerdown', (e) => { if (e.button === 0) forceStrike(); });

  // Debug / capture hook.
  window.__nimbus = { storm, strike: forceStrike, cloudMaterial, bolt, camera, controls, setMode };

  setMode(mode);

  // ── Resize ─────────────────────────────────────────────────────────────────
  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });

  // ── Animate ────────────────────────────────────────────────────────────────
  renderer.setAnimationLoop(() => {
    timer.update();
    const dt = Math.min(0.05, timer.getDelta());
    storm.update(dt);

    // Slow drift so the volume never reads as frozen.
    cloudMesh.rotation.y += dt * 0.012;
    cloudMesh.updateMatrixWorld();
    cloudMaterial.uTime.value += dt;

    skyFlash.value = storm.skyFlash;
    groundFlash.intensity = storm.groundLightIntensity * 250;
    if (storm.groundLightIntensity > 0.001) {
      groundFlash.position.set(storm.strikePoint.x, 2.5, storm.strikePoint.z);
    }

    if (mode === 'amidst') {
      // Drift through the outer wisps at cloud-base height, looking across
      // the interior toward where the strikes drop.
      driftT += dt;
      const a = driftT * 0.014 + 2.1;
      camera.position.set(
        Math.cos(a) * 13,
        9.2 + Math.sin(driftT * 0.05) * 1.2,
        Math.sin(a) * 13,
      );
      // Gaze across the interior, level enough to keep towers + sky in frame;
      // strikes still drop through the lower third.
      lookTarget.set(Math.cos(a + 0.95) * 4, 7.6, Math.sin(a + 0.95) * 4);

      // Return-stroke concussion: shake scaled by proximity to the strike.
      const dist = camera.position.distanceTo(storm.strikePoint);
      const shake = storm.strokeEnvelope * Math.min(1, 14 / (1 + dist)) * 0.35;
      if (shake > 0.001) {
        camera.position.x += Math.sin(driftT * 47.3) * shake;
        camera.position.y += Math.sin(driftT * 61.7 + 1.3) * shake;
        camera.position.z += Math.sin(driftT * 53.1 + 2.6) * shake;
      }
      camera.lookAt(lookTarget);
    } else {
      controls.update();
    }

    pipeline.render();
  });
}
