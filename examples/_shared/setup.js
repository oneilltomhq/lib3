// examples/_shared/setup.js
import * as THREE from "three/webgpu";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

export function setup({ fov = 60 } = {}) {
  const canvas = document.getElementById("canvas");
  const renderer = new THREE.WebGPURenderer({ canvas, antialias: true });
  renderer.setPixelRatio(devicePixelRatio);
  renderer.setSize(innerWidth, innerHeight);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(fov, innerWidth / innerHeight, 0.1, 1000);
  const controls = new OrbitControls(camera, renderer.domElement);

  function resize() {
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(innerWidth, innerHeight);
  }
  addEventListener("resize", resize);

  function loop(fn) {
    renderer.setAnimationLoop((t) => {
      controls.update();
      fn?.(t / 1000, renderer, scene, camera);
      renderer.render(scene, camera);
    });
  }

  return { THREE, renderer, scene, camera, controls, loop };
}
