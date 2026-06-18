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

const message =
  "lib3 sdf-text: whole-string layout + batched glyph instancing";

const batched = new BatchedText(8, 256, undefined, {
  fontFamily: "ui-monospace, monospace",
  outlineWidth: 0.035,
});
scene.add(batched);

const headline = new Text();
headline.text = message;
headline.fontSize = 0.14;
headline.anchorX = "center";
headline.anchorY = "middle";
headline.color.set(0x7dd3fc);
headline.position.set(0, 0.4, 0);
scene.add(headline);
batched.addText(headline);

const palette = [0xf472b6, 0xfbbf24, 0xa78bfa, 0x34d399];
const subtitles = [];
for (let i = 0; i < 4; i++) {
  const t = new Text();
  t.text = `label ${i + 1}`;
  t.fontSize = 0.14;
  t.anchorX = "center";
  t.color.set(palette[i]);
  t.position.set((i - 1.5) * 1.6, -0.8, 0);
  scene.add(t);
  batched.addText(t);
  subtitles.push(t);
}

const ticker = new Text();
ticker.text = "A";
ticker.fontSize = 0.2;
ticker.anchorX = "center";
ticker.color.set(0xffffff);
ticker.position.set(0, -1.4, 0);
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
  for (let i = 0; i < subtitles.length; i++) {
    subtitles[i].position.y = -0.8 + Math.sin(t * 1.4 + i * 0.35) * 0.12;
    subtitles[i].updateMatrixWorld();
    batched.setMatrixAt(i + 1, subtitles[i].matrixWorld);
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
batched.sync();
animate();
