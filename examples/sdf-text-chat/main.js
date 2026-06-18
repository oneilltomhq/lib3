import * as THREE from "three/webgpu";
import { BatchedText, Text } from "../../src/sdf-text/index.js";

const MAX_MESSAGES = 14;
const LINE_HEIGHT = 0.1;
const MARGIN_X = -2.85;
const MARGIN_Y = 1.55;
const SYNC_INTERVAL_MS = 80;
const STREAM_INTERVAL_MS = 45;

const NAMES = ["nova", "byte", "hex", "luna", "kit", "arc", "pip"];
const PHRASES = [
  "gpu instancing is one draw call",
  "sync only when strings change",
  "setMatrixAt for scroll, not sync",
  "atlas warms up per unique char",
  "throttle streaming updates ~10hz",
  "pool recycles Text slots",
  "sdf text scales cleanly",
  "batching many labels works well",
];

const COLORS = [0x7dd3fc, 0xf472b6, 0xfbbf24, 0xa78bfa, 0x34d399, 0xf87171];

const canvas = document.getElementById("canvas");
const atlasGlyphsEl = document.getElementById("atlasGlyphs");
const syncCountEl = document.getElementById("syncCount");
const pendingDirtyEl = document.getElementById("pendingDirty");
const poolSlotsEl = document.getElementById("poolSlots");

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
camera.position.set(0, 0, 6);

const batched = new BatchedText(MAX_MESSAGES + 1, 2048, undefined, {
  fontFamily: "ui-monospace, monospace",
  outlineWidth: 0.03,
});
scene.add(batched);

batched.atlas.ensureGlyphs(
  `${NAMES.join("")} ${PHRASES.join("")}▸█:abcdefghijklmnopqrstuvwxyz0123456789`,
);

/** @type {{ text: Text, memberId: number }[]} */
const pool = [];
for (let i = 0; i < MAX_MESSAGES; i++) {
  const t = new Text();
  t.text = "";
  t.fontSize = 0.065;
  t.anchorX = "left";
  t.anchorY = "top";
  t.maxWidth = 5.6;
  t.color.set(COLORS[i % COLORS.length]);
  scene.add(t);
  pool.push({ text: t, memberId: batched.addText(t) });
}

const live = new Text();
live.text = "";
live.fontSize = 0.065;
live.anchorX = "left";
live.anchorY = "top";
live.maxWidth = 5.6;
live.color.set(0xffffff);
scene.add(live);
const liveMemberId = batched.addText(live);

/** @type {{ name: string, body: string, color: number }[]} */
const messages = [];

let dirty = false;
let syncCount = 0;
let lastSyncAt = 0;

let streamTarget = "";
let streamName = "";
let streamColor = 0xffffff;
let streamIndex = 0;
let lastStreamAt = 0;
let nextMessageAt = performance.now() + 1200;

function slotY(index) {
  return MARGIN_Y - (MAX_MESSAGES - 1 - index) * LINE_HEIGHT;
}

function markDirty() {
  dirty = true;
}

function maybeSync(now) {
  if (!dirty || now - lastSyncAt < SYNC_INTERVAL_MS) return;
  batched.sync();
  syncCount++;
  dirty = false;
  lastSyncAt = now;
}

function layoutMessages() {
  const visible = messages.slice(-MAX_MESSAGES);
  for (let i = 0; i < MAX_MESSAGES; i++) {
    const slot = pool[i];
    const msg = visible[i];
    if (msg) {
      slot.text.text = `${msg.name}: ${msg.body}`;
      slot.text.color.set(msg.color);
    } else {
      slot.text.text = "";
    }
  }
  markDirty();
}

function queueMessage() {
  streamName = NAMES[(Math.random() * NAMES.length) | 0];
  streamColor = COLORS[(Math.random() * COLORS.length) | 0];
  streamTarget = PHRASES[(Math.random() * PHRASES.length) | 0];
  streamIndex = 0;
  live.color.set(streamColor);
}

function tickStream(now) {
  if (!streamTarget) return;
  if (now - lastStreamAt < STREAM_INTERVAL_MS) return;
  lastStreamAt = now;

  if (streamIndex < streamTarget.length) {
    const chunk = 1 + ((Math.random() * 2) | 0);
    streamIndex = Math.min(streamTarget.length, streamIndex + chunk);
    live.text = `▸ ${streamName}: ${streamTarget.slice(0, streamIndex)}█`;
    markDirty();
    return;
  }

  messages.push({
    name: streamName,
    body: streamTarget,
    color: streamColor,
  });
  streamTarget = "";
  live.text = "";
  layoutMessages();

  nextMessageAt = now + 900 + Math.random() * 1400;
}

function updateTransforms() {
  for (let i = 0; i < MAX_MESSAGES; i++) {
    const slot = pool[i];
    slot.text.position.set(MARGIN_X, slotY(i), 0);
    slot.text.updateMatrixWorld();
    batched.setMatrixAt(slot.memberId, slot.text.matrixWorld);
  }

  live.position.set(MARGIN_X, slotY(MAX_MESSAGES - 1) - LINE_HEIGHT * 1.35, 0);
  live.updateMatrixWorld();
  batched.setMatrixAt(liveMemberId, live.matrixWorld);
}

function resize() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h);
}

window.addEventListener("resize", resize);

async function animate(now) {
  requestAnimationFrame(animate);

  if (!streamTarget && now >= nextMessageAt) {
    queueMessage();
  }
  tickStream(now);
  updateTransforms();
  maybeSync(now);

  atlasGlyphsEl.textContent = String(batched.atlas.glyphs.size);
  syncCountEl.textContent = String(syncCount);
  pendingDirtyEl.textContent = dirty ? "yes" : "no";
  poolSlotsEl.textContent = String(Math.min(messages.length, MAX_MESSAGES));

  await renderer.renderAsync(scene, camera);
}

await renderer.init();
updateTransforms();
batched.sync();
syncCount++;
requestAnimationFrame(animate);
