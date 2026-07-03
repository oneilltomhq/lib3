// examples/cinematic-gallery/gallery.js
// Gallery machinery: screen surfaces, frames, camera fitting, and the
// render-budget runner that decouples each exhibit's offscreen render rate
// from the parent frame rate. The parent loop always runs at full rate; each
// exhibit re-renders its target only when its scheduled interval has elapsed,
// so unfocused screens hold (or slowly refresh) their last frame instead of
// burning GPU every frame.

import * as THREE from "three/webgpu";
import { texture, screenUV, uv, vec2 } from "three/tsl";

// WebGPU render-target textures sample top-down while plane UVs run
// bottom-up, so TV screens need their V flipped (verified via ?fliptest).
const FLIP_TV_V = true;

export function computeScreenDimensions(aspect, longSide) {
  const width = aspect >= 1 ? longSide : longSide * aspect;
  const height = aspect >= 1 ? longSide / aspect : longSide;
  return { width, height };
}

// A screen plane whose surface shows an exhibit's render target.
//   tv     — the image is glued to the plane (a television)
//   portal — the image is sampled in screen space (a window into elsewhere)
export function createScreenMesh({ width, height, rtTexture, mode }) {
  const geo = new THREE.PlaneGeometry(width, height);
  const mat = new THREE.MeshBasicNodeMaterial();
  const u = uv();
  const tvUV = FLIP_TV_V ? vec2(u.x, u.y.oneMinus()) : u;
  mat.colorNode =
    mode === "portal" ? texture(rtTexture, screenUV) : texture(rtTexture, tvUV);
  const mesh = new THREE.Mesh(geo, mat);
  mesh.material.side = THREE.DoubleSide;
  mesh.renderOrder = 1;
  return mesh;
}

export function createFrame({
  width,
  height,
  thickness = 0.06,
  depth = 0.05,
  material,
}) {
  const group = new THREE.Group();
  const horizLen = width + thickness * 2;
  const top = new THREE.Mesh(
    new THREE.BoxGeometry(horizLen, thickness, depth),
    material
  );
  const bot = new THREE.Mesh(
    new THREE.BoxGeometry(horizLen, thickness, depth),
    material
  );
  const left = new THREE.Mesh(
    new THREE.BoxGeometry(thickness, height, depth),
    material
  );
  const right = new THREE.Mesh(
    new THREE.BoxGeometry(thickness, height, depth),
    material
  );
  top.position.set(0, height / 2 + thickness / 2, -depth / 2);
  bot.position.set(0, -height / 2 - thickness / 2, -depth / 2);
  left.position.set(-width / 2 - thickness / 2, 0, -depth / 2);
  right.position.set(width / 2 + thickness / 2, 0, -depth / 2);
  group.add(top, bot, left, right);
  return group;
}

// Camera pose that frames a screen plane, cover-style (fills the viewport).
export function fitToPlane(mesh, parentCamera, options = {}) {
  const { cover = true, overscan = 1.06 } = options;
  const params = mesh.geometry.parameters || { width: 1, height: 1 };
  const rectWidth = (params.width || 1) * (mesh.scale?.x || 1);
  const rectHeight = (params.height || 1) * (mesh.scale?.y || 1);

  const center = new THREE.Vector3();
  mesh.getWorldPosition(center);

  const normal = new THREE.Vector3(0, 0, 1);
  const q = new THREE.Quaternion();
  mesh.getWorldQuaternion(q);
  normal.applyQuaternion(q);

  const vFov = (parentCamera.fov * Math.PI) / 180;
  const fovH = 2 * Math.atan(Math.tan(vFov / 2) * parentCamera.aspect);
  const distH = rectHeight / 2 / Math.tan(vFov / 2);
  const distW = rectWidth / 2 / Math.tan(fovH / 2);
  let distance = cover ? Math.min(distH, distW) : Math.max(distH, distW);
  distance = cover ? distance / overscan : distance;

  // Stay on whichever side of the plane the camera already is, to avoid flips
  const toCamera = new THREE.Vector3().subVectors(
    parentCamera.position,
    center
  );
  const side = Math.sign(toCamera.dot(normal)) || 1;
  const position = new THREE.Vector3()
    .copy(center)
    .addScaledVector(normal, side * distance);
  return { position, target: center.clone() };
}

// Camera pose that frames an in-room object of a given bounding radius.
// margin < 1 steps inside the framing distance (for volumes that want to be
// seen from near-inside); the approach keeps the camera's current bearing.
export function fitToSphere(center, radius, parentCamera, { margin = 1.3 } = {}) {
  const vFov = (parentCamera.fov * Math.PI) / 180;
  const distance = (radius * margin) / Math.tan(vFov / 2);
  const dir = new THREE.Vector3().subVectors(parentCamera.position, center);
  dir.y *= 0.4; // shallow approach: stay near the object's eye level
  if (dir.lengthSq() < 1e-6) dir.set(0, 0, 1);
  dir.normalize();
  const position = center.clone().addScaledVector(dir, distance);
  position.y = Math.max(0.35, position.y);
  return { position, target: center.clone() };
}

function easeOutCubic(x) {
  return 1 - Math.pow(1 - x, 3);
}

// Eased flights between authored camera poses, layered over OrbitControls.
export class CameraRig {
  constructor(camera, controls) {
    this.camera = camera;
    this.controls = controls;
    this.anim = null;
  }

  flyTo({ position, target }, duration = 0.9) {
    this.anim = {
      t: 0,
      duration,
      fromPos: this.camera.position.clone(),
      toPos: position.clone(),
      fromTarget: this.controls.target.clone(),
      toTarget: target.clone(),
    };
  }

  update(dt) {
    if (!this.anim) return;
    this.anim.t += dt / this.anim.duration;
    const a = Math.min(1, this.anim.t);
    const e = easeOutCubic(a);
    this.camera.position.lerpVectors(this.anim.fromPos, this.anim.toPos, e);
    this.controls.target.lerpVectors(
      this.anim.fromTarget,
      this.anim.toTarget,
      e
    );
    if (a >= 1) this.anim = null;
  }
}

// Owns one exhibit's render target and decides, per parent frame, whether the
// exhibit is due a re-render at its currently granted rate.
export class ExhibitRunner {
  constructor({ entry, content, width, height }) {
    this.entry = entry;
    this.content = content;
    this.rt = new THREE.RenderTarget(width, height, {
      type: THREE.HalfFloatType,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
    });
    this.lastRenderAt = -Infinity;
    this.screenMesh = null; // assigned by the room builder
  }

  setSize(width, height) {
    this.rt.setSize(width, height);
  }

  // hz Infinity = every parent frame. A small epsilon keeps e.g. 30 Hz from
  // slipping to every-third-frame on a 60 Hz display.
  renderIfDue(renderer, now, hz) {
    const interval = hz === Infinity ? 0 : 1 / hz - 1e-3;
    if (now - this.lastRenderAt < interval) return;
    const dt = Math.min(
      0.34,
      this.lastRenderAt === -Infinity ? 0.016 : now - this.lastRenderAt
    );
    this.lastRenderAt = now;

    this.content.update?.(dt, now);
    if (this.content.render) {
      this.content.render(renderer, this.rt);
    } else {
      renderer.setRenderTarget(this.rt);
      renderer.render(this.content.scene, this.content.camera);
      renderer.setRenderTarget(null);
    }
  }
}
