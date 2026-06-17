import * as THREE from "three/webgpu";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { BatchedText, Text } from "../../src/sdf-text/index.js";

const canvas = document.getElementById("canvas");
const glyphCountEl = document.getElementById("glyphCount");

const renderer = new THREE.WebGPURenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0b0d12);

const camera = new THREE.PerspectiveCamera(
  45,
  window.innerWidth / window.innerHeight,
  0.1,
  100,
);
camera.position.set(0, 0, 8);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.enablePan = false;

const batched = new BatchedText(128, 1, undefined, {
  fontFamily: "ui-monospace, monospace",
  outlineWidth: 0.035,
});
scene.add(batched);

const palette = [0x7dd3fc, 0xf472b6, 0xfbbf24, 0xa78bfa, 0x34d399];
const texts = [];
const message =
  "lib3 sdf-text: CPU atlas + GPU TSL instancing — add glyphs live!";

for (let i = 0; i < message.length; i++) {
  const t = new Text();
  t.text = message[i];
  t.fontSize = 0.55;
  t.color.set(palette[i % palette.length]);
  t.position.set((i - message.length / 2) * 0.38, 0, 0);
  t.scale.setScalar(t.fontSize);
  scene.add(t);
  batched.addText(t);
  texts.push(t);
}

const ticker = new Text();
ticker.text = "A";
ticker.fontSize = 0.9;
ticker.color.set(0xffffff);
ticker.position.set(0, -1.4, 0);
ticker.scale.setScalar(ticker.fontSize);
scene.add(ticker);
batched.addText(ticker);

const charset = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!?";
let tick = 0;

function resize() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h);
}

window.addEventListener("resize", resize);

async function animate() {
  requestAnimationFrame(animate);

  const t = performance.now() * 0.001;
  for (let i = 0; i < texts.length; i++) {
    texts[i].position.y = Math.sin(t * 1.4 + i * 0.35) * 0.12;
    texts[i].rotation.z = Math.sin(t * 0.8 + i) * 0.08;
    texts[i].updateMatrixWorld();
  }

  tick++;
  if (tick % 24 === 0) {
    ticker.text = charset[(tick / 24) % charset.length];
    ticker.updateMatrixWorld();
  }

  batched.sync();
  glyphCountEl.textContent = String(batched.atlas.glyphs.size);

  controls.update();
  await renderer.renderAsync(scene, camera);
}

await renderer.init();
animate();
