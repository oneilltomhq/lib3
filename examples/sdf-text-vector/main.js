import * as THREE from "three/webgpu";
import { BatchedText, Text } from "../../src/sdf-text/index.js";

// ?mode=vector (default) renders SDFs from real font outlines; ?mode=canvas
// renders the legacy canvas-raster path. Same strings/camera/sizes either way,
// so screenshots of the two modes are directly comparable.
const params = new URLSearchParams(location.search);
const mode = params.get("mode") === "canvas" ? "canvas" : "vector";
document.getElementById("mode").textContent = mode;

const fontURL = new URL(
  "../assets/fonts/Roboto-Regular.ttf",
  import.meta.url,
).href;

const canvasEl = document.getElementById("canvas");
const W = window.innerWidth;
const H = window.innerHeight;

const renderer = new THREE.WebGPURenderer({ canvas: canvasEl, antialias: true });
renderer.setPixelRatio(1);
renderer.setSize(W, H);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0b0d12);

// Orthographic camera: view height = 8 world units over the canvas height, so
// pixels-per-world-unit = H/8. At H=800 that's 100 px/unit → fontSize 0.12 ≈
// 12px text, fontSize 1.2 ≈ 120px text.
const viewH = 8;
const aspect = W / H;
const viewW = viewH * aspect;
const camera = new THREE.OrthographicCamera(
  -viewW / 2,
  viewW / 2,
  viewH / 2,
  -viewH / 2,
  -10,
  10,
);
camera.position.z = 5;

const options =
  mode === "vector"
    ? { font: fontURL, outlineWidth: 0.04 }
    : { fontFamily: "ui-monospace, monospace", outlineWidth: 0.04 };

const batched = new BatchedText(8, 2048, undefined, options);
scene.add(batched);

const KERN_STR = "Kerning: AV To Wa AW LT";
const BIG_STR = "AVToWa";

function makeText(str, fontSize, x, y, color, align = "left") {
  const t = new Text();
  t.text = str;
  t.fontSize = fontSize;
  t.anchorX = align;
  t.anchorY = "middle";
  t.color.set(color);
  t.position.set(x, y, 0);
  scene.add(t);
  batched.addText(t);
  return t;
}

// Small (~12px) and large (~120px) samples, same content in both modes.
makeText(KERN_STR, 0.12, 0, 3.2, 0x9ae6b4, "center");
makeText(KERN_STR, 0.12, 0, 2.4, 0xffffff, "center");
makeText(BIG_STR, 1.2, 0, -0.2, 0x7dd3fc, "center");
makeText("Roboto", 0.6, 0, -2.6, 0xf472b6, "center");

async function main() {
  await renderer.init();
  await batched.ready; // wait for font parse (vector mode); resolved immediately for canvas
  batched.sync();
  await renderer.renderAsync(scene, camera);
  // A second sync+render: in vector mode the first sync rasterizes the atlas;
  // render once more so the DataTexture upload is visible.
  batched.sync();
  await renderer.renderAsync(scene, camera);
  window.__ready = true;
}

main();
