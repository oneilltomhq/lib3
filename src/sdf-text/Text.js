import * as THREE from "three/webgpu";

export class Text extends THREE.Object3D {
  text = "";
  fontSize = 1;
  color = new THREE.Color(0xffffff);
}
