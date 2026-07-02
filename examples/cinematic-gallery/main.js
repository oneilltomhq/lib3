// examples/cinematic-gallery/main.js
// The gallery room: real 3D pieces stand on plinths, screen-native pieces
// hang as framed TVs — both built from the exhibit registry. The camera walks
// between authored poses; screens re-render on a budget granted by where the
// visitor is looking, while in-room objects pace their own compute and pay
// raymarch cost only for the pixels they cover.
//
//   space        next exhibit        shift+space   previous
//   1–5          jump to exhibit     esc           overview
//   click piece  focus it            drag          free orbit

import { color, normalView, uv } from "three/tsl";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import * as THREE from "three/webgpu";
import { BatchedText, Text } from "../../src/sdf-text/index.js";
import { EXHIBITS } from "./exhibits.js";
import {
  CameraRig,
  ExhibitRunner,
  computeScreenDimensions,
  createFrame,
  createScreenMesh,
  fitToPlane,
  fitToSphere,
} from "./gallery.js";

const SCREEN_ASPECT = 16 / 9;
const SCREEN_LONG_SIDE = 1.7;
const EXHIBIT_Y = 1.3; // centre height of screens and floating objects
const PLINTH = { w: 0.5, h: 0.55 };
const ARC_RADIUS = 3.6;
const ARC_SPREAD = (112 * Math.PI) / 180;
const TV_RT = { width: 1600, height: 900 };

// Render rates (Hz) granted to SCREENS by the budget manager; in-room objects
// render with the parent scene every frame. Focused = every frame.
const RATES = { ambient: 20, idle: 8 };

// Museum lighting: the room is dark and the pools of light are the
// composition. One warm halogen spot hangs over each piece.
const LIGHT = {
  color: 0xffe3c0,
  height: 3.9,
  angle: 0.3,
  penumbra: 0.6,
  decay: 1.6, // tighter pools — neighbours shouldn't merge into one wash
  intensity: 30,
  coneOpacity: 0.02, // faked volumetric shaft; 0 to remove the beams
  coneRadius: 0.7, // beam sits inside the light cone, not filling it
};

// Museum-label lecterns: an sdf-text plaque on a post in front of each plinth
const PLAQUE = {
  w: 0.62,
  h: 0.42,
  y: 0.52, // top of the post = bottom hinge of the plate
  standOff: 0.55, // metres from the plinth centre toward the room centre
  tilt: -0.42, // lectern lean — face tips up toward standing eye height
};

const hudCaption = document.getElementById("caption");
const hudTitle = document.getElementById("caption-title");
const hudPlaque = document.getElementById("caption-plaque");
const hudLoading = document.getElementById("loading");

// ---- renderer / parent scene ---------------------------------------------------
const renderer = new THREE.WebGPURenderer({
  canvas: document.getElementById("canvas"),
  antialias: true,
});
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setClearColor(0x000000);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.12;

const parentScene = new THREE.Scene();
const parentCamera = new THREE.PerspectiveCamera(
  60,
  window.innerWidth / window.innerHeight,
  0.1,
  1000
);
parentCamera.position.set(0, 1.6, 4.8);

const controls = new OrbitControls(parentCamera, renderer.domElement);
controls.target.set(0, 1.15, -0.8);
controls.update();

const rig = new CameraRig(parentCamera, controls);

// ---- the room --------------------------------------------------------------------
// A polished dark floor and almost no fill light: distance fades to black on
// its own, and each piece stands in its own pool of halogen.
const floor = new THREE.Mesh(
  new THREE.PlaneGeometry(30, 30),
  new THREE.MeshStandardMaterial({
    color: 0x17171b,
    roughness: 0.32,
    metalness: 0.08,
  })
);
floor.rotation.x = -Math.PI / 2;
parentScene.add(floor);

parentScene.add(new THREE.AmbientLight(0xffffff, 0.05));
const fill = new THREE.DirectionalLight(0x93a4c4, 0.12);
fill.position.set(0, 3, 6);
parentScene.add(fill);

// Faked volumetric shaft under each lamp, in the projector-beams language:
// brightest at the source, dissolving before the floor, vanishing at the
// silhouette edges.
const coneMat = new THREE.MeshBasicNodeMaterial({
  transparent: true,
  blending: THREE.AdditiveBlending,
  depthWrite: false,
  side: THREE.DoubleSide,
});
{
  const v = uv().y;
  const shaft = v.smoothstep(0.0, 0.45).mul(v.mul(0.8).add(0.2));
  const core = normalView.z.abs().pow(1.6);
  coneMat.colorNode = color(LIGHT.color).mul(
    shaft.mul(core).mul(LIGHT.coneOpacity)
  );
}

function addExhibitLight(x, z) {
  const spot = new THREE.SpotLight(
    LIGHT.color,
    LIGHT.intensity,
    LIGHT.height * 2.2,
    LIGHT.angle,
    LIGHT.penumbra,
    LIGHT.decay
  );
  spot.position.set(x, LIGHT.height, z);
  spot.target.position.set(x, 0, z);
  parentScene.add(spot, spot.target);

  if (LIGHT.coneOpacity > 0) {
    const baseRadius = Math.tan(LIGHT.angle) * LIGHT.height * LIGHT.coneRadius;
    const cone = new THREE.Mesh(
      new THREE.CylinderGeometry(0.05, baseRadius, LIGHT.height, 32, 1, true),
      coneMat
    );
    cone.position.set(x, LIGHT.height / 2, z);
    parentScene.add(cone);
  }
}

// ---- build exhibits from the registry --------------------------------------------
const { width: screenW, height: screenH } = computeScreenDimensions(
  SCREEN_ASPECT,
  SCREEN_LONG_SIDE
);
const frameMat = new THREE.MeshStandardMaterial({
  color: 0x222222,
  roughness: 1,
});
const plinthMat = new THREE.MeshStandardMaterial({
  color: 0x1a1a1f,
  roughness: 0.5,
  metalness: 0.2,
});
const plaqueMat = new THREE.MeshStandardMaterial({
  color: 0x0e0e12,
  roughness: 0.45,
  metalness: 0.3,
});

// One glyph pool for every label in the room — the plaques are lib3 too
// (sdf-text: canvas-rasterized glyphs, EDT distance fields, instanced quads).
const plaqueText = new BatchedText(16, 2048, undefined, {
  fontFamily: "ui-monospace, Menlo, monospace",
  outlineWidth: 0,
});
plaqueText.frustumCulled = false;
parentScene.add(plaqueText);

function addPlaque(entry, x, z) {
  const dir = new THREE.Vector3(-x, 0, -z).normalize();
  const stand = new THREE.Group();
  stand.position.set(
    x + dir.x * PLAQUE.standOff,
    0,
    z + dir.z * PLAQUE.standOff
  );
  stand.rotation.y = Math.atan2(dir.x, dir.z);
  parentScene.add(stand);

  const post = new THREE.Mesh(
    new THREE.BoxGeometry(0.04, PLAQUE.y, 0.04),
    plaqueMat
  );
  post.position.y = PLAQUE.y / 2;
  stand.add(post);

  const tilt = new THREE.Group();
  tilt.position.y = PLAQUE.y;
  tilt.rotation.x = PLAQUE.tilt;
  stand.add(tilt);

  const plate = new THREE.Mesh(
    new THREE.BoxGeometry(PLAQUE.w, PLAQUE.h, 0.016),
    plaqueMat
  );
  plate.position.y = PLAQUE.h / 2 - 0.02;
  tilt.add(plate);

  const title = new Text();
  title.text = entry.title.toUpperCase();
  title.fontSize = 0.042;
  title.letterSpacing = 0.006; // world units, not ems — ~0.15em of tracking
  title.anchorX = "left";
  title.anchorY = "top";
  title.color.set(0xe8e8ec);
  title.position.set(-PLAQUE.w / 2 + 0.05, PLAQUE.h - 0.07, 0.013);
  tilt.add(title);
  plaqueText.addText(title);

  const body = new Text();
  body.text = entry.plaque;
  body.fontSize = 0.026;
  body.lineHeight = 1.5;
  body.maxWidth = PLAQUE.w - 0.1;
  body.anchorX = "left";
  body.anchorY = "top";
  body.color.set(0x8f8f98);
  body.position.set(-PLAQUE.w / 2 + 0.05, PLAQUE.h - 0.14, 0.013);
  tilt.add(body);
  plaqueText.addText(body);
}

// One item per registry entry, in order. Screens carry a runner (offscreen
// RT + budget); objects carry live content and a bounding sphere for framing.
const items = [];

// Temporary orientation check: ?fliptest replaces the registry with two
// screens (tv + portal) showing an up-arrow, cheap enough for software WebGPU.
function makeArrowExhibit({ aspect }) {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0xffffff);
  const camera = new THREE.PerspectiveCamera(60, aspect, 0.1, 10);
  camera.position.set(0, 0, 1);

  const cnv = document.createElement("canvas");
  cnv.width = 512;
  cnv.height = 288;
  const ctx = cnv.getContext("2d");
  ctx.fillStyle = "#ddd";
  ctx.fillRect(0, 0, 512, 288);
  ctx.fillStyle = "#c00";
  ctx.font = "bold 60px sans-serif";
  ctx.fillText("TOP", 20, 70);
  ctx.fillStyle = "#000";
  ctx.beginPath();
  ctx.moveTo(256, 30);
  ctx.lineTo(200, 140);
  ctx.lineTo(312, 140);
  ctx.closePath();
  ctx.fill();
  ctx.fillRect(240, 140, 32, 110);
  const tex = new THREE.CanvasTexture(cnv);
  tex.colorSpace = THREE.SRGBColorSpace;

  const h = 2 * Math.tan((camera.fov * Math.PI) / 360);
  const plane = new THREE.Mesh(
    new THREE.PlaneGeometry(h * aspect, h),
    new THREE.MeshBasicMaterial({ map: tex })
  );
  scene.add(plane);
  return Promise.resolve({ scene, camera });
}

const urlParams = new URLSearchParams(location.search);
const skipIds = (urlParams.get("skip") || "").split(",").filter(Boolean);
const REGISTRY = urlParams.has("fliptest")
  ? [
      { id: "tv-test", title: "TV", plaque: "tv", mode: "tv", make: makeArrowExhibit },
      { id: "portal-test", title: "Portal", plaque: "portal", mode: "portal", make: makeArrowExhibit },
    ]
  : EXHIBITS.filter((e) => !skipIds.includes(e.id));

function portalSize() {
  const pr = Math.min(window.devicePixelRatio, 2);
  return {
    width: Math.floor(window.innerWidth * pr),
    height: Math.floor(window.innerHeight * pr),
  };
}

function arcPosition(i, n) {
  const angle = n === 1 ? 0 : (i / (n - 1) - 0.5) * ARC_SPREAD;
  return {
    x: Math.sin(angle) * ARC_RADIUS,
    z: -Math.cos(angle) * ARC_RADIUS,
  };
}

async function buildExhibits() {
  const n = REGISTRY.length;
  for (let i = 0; i < n; i++) {
    const entry = REGISTRY[i];
    hudLoading.textContent = `placing ${entry.title.toLowerCase()} — ${i + 1}/${n}`;

    const { x, z } = arcPosition(i, n);

    if (entry.mode === "object") {
      const content = await entry.make({});
      const center = new THREE.Vector3(x, EXHIBIT_Y, z);
      content.group.position.copy(center);
      parentScene.add(content.group);

      const plinth = new THREE.Mesh(
        new THREE.BoxGeometry(PLINTH.w, PLINTH.h, PLINTH.w),
        plinthMat
      );
      plinth.position.set(x, PLINTH.h / 2, z);
      parentScene.add(plinth);

      addExhibitLight(x, z);
      addPlaque(entry, x, z);

      // invisible raycast proxy so clicking points/volumes works
      const hitProxy = new THREE.Mesh(
        new THREE.SphereGeometry(content.radius, 12, 8),
        new THREE.MeshBasicMaterial({
          transparent: true,
          opacity: 0,
          depthWrite: false,
        })
      );
      hitProxy.position.copy(center);
      parentScene.add(hitProxy);

      items.push({ entry, kind: "object", content, center, hitMesh: hitProxy });
      continue;
    }

    // screens (tv / portal)
    const isPortal = entry.mode === "portal";
    const aspect = isPortal
      ? window.innerWidth / window.innerHeight
      : SCREEN_ASPECT;
    const content = await entry.make({ aspect });

    const size = isPortal ? portalSize() : TV_RT;
    const runner = new ExhibitRunner({
      entry,
      content,
      width: size.width,
      height: size.height,
    });

    const screen = createScreenMesh({
      width: screenW,
      height: screenH,
      rtTexture: runner.rt.texture,
      mode: entry.mode,
    });
    screen.position.set(x, EXHIBIT_Y, z);
    screen.lookAt(0, EXHIBIT_Y, 1.5);
    parentScene.add(screen);

    const frame = createFrame({
      width: screenW,
      height: screenH,
      material: frameMat,
    });
    frame.position.copy(screen.position);
    frame.quaternion.copy(screen.quaternion);
    parentScene.add(frame);

    addExhibitLight(x, z);
    addPlaque(entry, x, z);

    runner.screenMesh = screen;
    items.push({ entry, kind: "screen", runner, hitMesh: screen });
  }
}

// ---- focus / camera states --------------------------------------------------------
const overviewPose = {
  position: parentCamera.position.clone(),
  target: controls.target.clone(),
};
let focusedIndex = -1; // -1 = overview

function setFocus(index) {
  focusedIndex = index;
  if (index === -1) {
    rig.flyTo(overviewPose);
    hudCaption.classList.remove("visible");
    return;
  }
  const item = items[index];
  const pose =
    item.kind === "object"
      ? fitToSphere(item.center, item.content.radius, parentCamera, {
          margin: item.entry.focusMargin,
        })
      : fitToPlane(item.runner.screenMesh, parentCamera);
  rig.flyTo(pose);
  hudTitle.textContent = item.entry.title;
  hudPlaque.textContent = item.entry.plaque;
  hudCaption.classList.add("visible");
}

function cycleFocus(step) {
  // ... -1 -> 0 -> 1 -> ... -> n-1 -> -1 -> ...
  const n = items.length;
  const next = ((focusedIndex + 1 + step + n + 1) % (n + 1)) - 1;
  setFocus(next);
}

window.addEventListener("keydown", (e) => {
  if (e.code === "Space") {
    e.preventDefault();
    cycleFocus(e.shiftKey ? -1 : 1);
  } else if (e.code === "Escape") {
    setFocus(-1);
  } else if (/^Digit[1-9]$/.test(e.code)) {
    const i = Number(e.code.slice(5)) - 1;
    if (i < items.length) setFocus(i);
  }
});

// click a piece to focus it (ignore drags)
const raycaster = new THREE.Raycaster();
let downAt = null;
renderer.domElement.addEventListener("pointerdown", (e) => {
  downAt = { x: e.clientX, y: e.clientY };
});
renderer.domElement.addEventListener("pointerup", (e) => {
  if (!downAt) return;
  const moved = Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y);
  downAt = null;
  if (moved > 6) return;
  const ndc = new THREE.Vector2(
    (e.clientX / window.innerWidth) * 2 - 1,
    -(e.clientY / window.innerHeight) * 2 + 1
  );
  raycaster.setFromCamera(ndc, parentCamera);
  const hits = raycaster.intersectObjects(items.map((it) => it.hitMesh));
  if (hits.length === 0) return;
  const index = items.findIndex((it) => it.hitMesh === hits[0].object);
  if (index !== -1) setFocus(index);
});

// ---- resize -----------------------------------------------------------------------
window.addEventListener("resize", () => {
  renderer.setSize(window.innerWidth, window.innerHeight);
  parentCamera.aspect = window.innerWidth / window.innerHeight;
  parentCamera.updateProjectionMatrix();
  for (const item of items) {
    if (item.kind !== "screen" || item.entry.mode !== "portal") continue;
    const size = portalSize();
    item.runner.setSize(size.width, size.height);
    item.runner.content.setAspect?.(window.innerWidth / window.innerHeight);
  }
});

// ---- loop ------------------------------------------------------------------------
const clock = new THREE.Clock();

renderer.init().then(async () => {
  await buildExhibits();

  // plaques are static: lay out glyphs and bake their matrices once
  parentScene.updateMatrixWorld(true);
  plaqueText.sync();

  hudLoading.remove();

  // debug: ?plaquecam stands the camera at the first item's lectern
  if (urlParams.has("plaquecam") && items.length) {
    const c = items[0].center ?? items[0].hitMesh.position;
    const dir = new THREE.Vector3(-c.x, 0, -c.z).normalize();
    controls.target.set(
      c.x + dir.x * PLAQUE.standOff,
      PLAQUE.y + 0.18,
      c.z + dir.z * PLAQUE.standOff
    );
    parentCamera.position.set(
      c.x + dir.x * (PLAQUE.standOff + 0.85),
      1.05,
      c.z + dir.z * (PLAQUE.standOff + 0.85)
    );
    controls.update();
  }

  // deep-link an exhibit: ?focus=2 (1-based, matching the digit keys)
  const focusParam = new URLSearchParams(location.search).get("focus");
  if (focusParam !== null) {
    const i = Number(focusParam) - 1;
    if (i >= 0 && i < items.length) {
      setFocus(i);
      // &snap completes the flight instantly (headless verification renders
      // only the first frame, so an eased flight never lands on camera)
      if (urlParams.has("snap")) rig.update(999);
    }
  }

  renderer.setAnimationLoop(() => {
    const dt = Math.min(0.1, clock.getDelta());
    const now = clock.elapsedTime;

    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (item.kind === "object") {
        // in-room: motion every frame, GPU compute self-paced
        item.content.update?.(dt, now);
        item.content.compute?.(renderer);
      } else {
        const hz =
          focusedIndex === -1
            ? RATES.ambient
            : i === focusedIndex
              ? Infinity
              : RATES.idle;
        item.runner.renderIfDue(renderer, now, hz);
      }
    }

    rig.update(dt);
    controls.update();

    if (urlParams.has("camdebug")) {
      document.getElementById("help").textContent = `cam ${parentCamera.position
        .toArray()
        .map((v) => v.toFixed(2))
        .join(",")} tgt ${controls.target
        .toArray()
        .map((v) => v.toFixed(2))
        .join(",")} anim:${!!rig.anim} focused:${focusedIndex} t:${now.toFixed(1)}`;
    }

    // room pre-passes (e.g. the metaballs' refraction source) render with the
    // final camera transform, after all motion for this frame is settled
    for (const item of items) {
      if (item.kind === "object")
        item.content.prepass?.(renderer, parentScene, parentCamera);
    }

    renderer.render(parentScene, parentCamera);
  });
});
