import { setup } from "../_shared/setup.js";
import headURL from "@assets/head256x256x109.zip?url";
import { Inspector } from "three/addons/inspector/Inspector.js";
import { unzipSync } from "three/addons/libs/fflate.module.js";
import { RaymarchingBox } from "three/addons/tsl/utils/Raymarching.js";
import {
  Fn,
  texture3D,
  uniform,
  vec3,
  vec4,
  float,
  instanceIndex,
  textureStore,
} from "three/tsl";

const { THREE, renderer, scene, camera, loop } = setup({ fov: 75 });
camera.position.z = 3;
renderer.setClearColor(0x000000);
renderer.inspector = new Inspector();
new THREE.FileLoader()
  .setResponseType("arraybuffer")
  .load(headURL, async function (data) {
    const zip = unzipSync(new Uint8Array(data));
    const array = new Uint8Array(zip["head256x256x109"].buffer);

    const width = 256;
    const height = 256;
    const depth = 109;

    // Source texture (sampled in compute)
    const sourceTexture = new THREE.Data3DTexture(array, width, height, depth);
    sourceTexture.format = THREE.RedFormat;
    sourceTexture.minFilter = THREE.LinearFilter;
    sourceTexture.magFilter = THREE.LinearFilter;
    sourceTexture.unpackAlignment = 1;
    sourceTexture.needsUpdate = true;

    // Destination storage texture (raymarched in material)
    const storageTexture = new THREE.Storage3DTexture(width, height, depth);
    storageTexture.generateMipmaps = false;
    storageTexture.name = "head";

    // Compute: upload Data3DTexture -> Storage3DTexture
    const uploadVolume = Fn(({ storageTexture, source }) => {
      const id = instanceIndex;

      const x = id.mod(width);
      const y = id.div(width).mod(height);
      const z = id.div(width * height);

      const fx = float(x).add(0.5).div(width);
      const fy = float(y).add(0.5).div(height);
      const fz = float(z).add(0.5).div(depth);

      const s = source.sample(vec3(fx, fy, fz));

      textureStore(storageTexture, vec3(x, y, z), vec4(s.r, 0.0, 0.0, 1.0));
    });

    const computeNode = uploadVolume({
      storageTexture,
      source: texture3D(sourceTexture, null, 0),
    })
      .compute(width * height * depth)
      .setName("uploadHead3D");

    await renderer.init();
    await renderer.computeAsync(computeNode);

    // Shader for Average Intensity Projection (AIP)

    const averageIntensityProjection = Fn(
      ({ texture, steps, intensityScale = float(1.0) }) => {
        const finalColor = vec4(0).toVar();
        const intensitySum = float(0).toVar();
        const sampleCount = float(0).toVar();

        RaymarchingBox(steps, ({ positionRay }) => {
          // Sample the texture at the current position using trilinear interpolation
          const samplePos = positionRay.add(0.5);
          const mapValue = texture.sample(samplePos).r;

          // Accumulate intensity values
          intensitySum.addAssign(mapValue);
          sampleCount.addAssign(1);
        });

        // Compute the average intensity
        const averageIntensity = intensitySum.div(sampleCount);

        // Apply intensity scaling and map to visible range
        const scaledIntensity = averageIntensity.mul(intensityScale);

        // Set as final color
        finalColor.rgb.assign(vec3(scaledIntensity));
        finalColor.a.assign(1);

        return finalColor;
      }
    );

    const steps = uniform(100);
    const intensityScale = uniform(2.0);

    const material = new THREE.NodeMaterial();
    material.colorNode = averageIntensityProjection({
      texture: texture3D(storageTexture, null, 0),
      steps,
      intensityScale,
    });
    material.side = THREE.BackSide;
    material.transparent = true;

    const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), material);
    mesh.scale.set(1, -1, depth / width);
    scene.add(mesh);

    // Inspector GUI
    const gui = renderer.inspector.createParameters("Raymarch Head (Compute)");
    gui.add(steps, "value", 1, 150, 1).name("steps");
    gui.add(intensityScale, "value", 0.1, 5.0, 0.1).name("intensityScale");

    // Start animation loop
    loop();
  });
