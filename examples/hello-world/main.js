// examples/main.js
import { setup } from "../_shared/setup.js";
import { float } from "three/tsl";
import { exampleTSLFunction } from "../../src/index.js"; // Import locally from src/ for dev

const { THREE, scene, camera, loop } = setup({ fov: 75 });

// Use your TSL function in a material (uniforms will get auto-GUI)
const material = new THREE.MeshBasicNodeMaterial(); // Or whatever TSL material
material.colorNode = exampleTSLFunction(float(1.0));

const mesh = new THREE.Mesh(new THREE.BoxGeometry(), material);
scene.add(mesh);

// Start animation loop
loop();
