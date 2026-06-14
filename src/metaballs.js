import * as THREE from "three/webgpu";
import {
  bool,
  Break,
  cameraPosition,
  clamp,
  Discard,
  float,
  Fn,
  If,
  int,
  length,
  Loop,
  mix,
  normalize,
  positionWorld,
  screenUV,
  texture,
  uniform,
  uniformArray,
  vec3,
} from "three/tsl";

const DEFAULT_INITIAL_DISTANCE = 20;
const DEFAULT_SMOOTHING = 0.3;
const DEFAULT_MAX_STEPS = 56;
const DEFAULT_HIT_THRESHOLD = 0.012;
const DEFAULT_NORMAL_EPSILON = 0.02;

export const METABALL_DEBUG_MODES = Object.freeze({
  BEAUTY: "beauty",
  BACKGROUND: "background",
  REFRACTED: "refracted",
  MASK: "mask",
  NORMAL: "normal",
  DEPTH: "depth",
  STEPS: "steps",
  FRESNEL: "fresnel",
  RIM: "rim",
});

const METABALL_DEBUG_MODE_VALUES = Object.freeze({
  [METABALL_DEBUG_MODES.BEAUTY]: 0,
  [METABALL_DEBUG_MODES.BACKGROUND]: 1,
  [METABALL_DEBUG_MODES.REFRACTED]: 2,
  [METABALL_DEBUG_MODES.MASK]: 3,
  [METABALL_DEBUG_MODES.NORMAL]: 4,
  [METABALL_DEBUG_MODES.DEPTH]: 5,
  [METABALL_DEBUG_MODES.STEPS]: 6,
  [METABALL_DEBUG_MODES.FRESNEL]: 7,
  [METABALL_DEBUG_MODES.RIM]: 8,
});

/**
 * Smooth-min sphere SDF over a fixed-size array of sphere centers and radii.
 *
 * @param {Object} opts
 * @param {Node<vec3>} opts.p
 * @param {UniformArrayNode<vec3>} opts.positions
 * @param {UniformArrayNode<float>} opts.radii
 * @param {number} opts.count
 * @param {Node<float>|number} [opts.smoothing]
 * @param {Node<float>|number} [opts.initialDistance]
 * @returns {Node<float>}
 */
export const smoothMinSphereSdf = ({
  p,
  positions,
  radii,
  count,
  smoothing = DEFAULT_SMOOTHING,
  initialDistance = DEFAULT_INITIAL_DISTANCE,
}) => {
  const k = smoothing && smoothing.isNode ? smoothing : float(smoothing);
  const initial =
    initialDistance && initialDistance.isNode
      ? initialDistance
      : float(initialDistance);
  const d = initial.toVar();

  Loop(count, ({ i }) => {
    const di = length(p.sub(positions.element(i))).sub(radii.element(i));
    const h = clamp(di.sub(d).div(k).mul(0.5).add(0.5), 0, 1);
    d.assign(mix(di, d, h).sub(h.mul(h.oneMinus()).mul(k)));
  });

  return d;
};

/**
 * Estimate a normal from an SDF function using central differences.
 *
 * @param {Object} opts
 * @param {(p: Node<vec3>) => Node<float>} opts.sdf
 * @param {Node<vec3>} opts.p
 * @param {number} [opts.epsilon]
 * @returns {Node<vec3>}
 */
export const estimateSdfNormal = ({
  sdf,
  p,
  epsilon = DEFAULT_NORMAL_EPSILON,
}) => {
  const e = epsilon;

  return normalize(
    vec3(
      sdf(p.add(vec3(e, 0, 0))).sub(sdf(p.sub(vec3(e, 0, 0)))),
      sdf(p.add(vec3(0, e, 0))).sub(sdf(p.sub(vec3(0, e, 0)))),
      sdf(p.add(vec3(0, 0, e))).sub(sdf(p.sub(vec3(0, 0, e))))
    )
  );
};

/**
 * Sphere-trace an SDF between tNear and tFar.
 *
 * @param {Object} opts
 * @param {(p: Node<vec3>) => Node<float>} opts.sdf
 * @param {Node<vec3>} opts.rayOrigin
 * @param {Node<vec3>} opts.rayDirection
 * @param {Node<float>} opts.tNear
 * @param {Node<float>} opts.tFar
 * @param {number|Node<int>} [opts.maxSteps]
 * @param {number|Node<float>} [opts.threshold]
 * @returns {{ hit: Node<bool>, t: Node<float>, p: Node<vec3>, steps: Node<float>, lastDistance: Node<float> }}
 */
export const raymarchSdf = ({
  sdf,
  rayOrigin,
  rayDirection,
  tNear,
  tFar,
  maxSteps = DEFAULT_MAX_STEPS,
  threshold = DEFAULT_HIT_THRESHOLD,
}) => {
  const thresholdNode =
    threshold && threshold.isNode ? threshold : float(threshold);
  const t = float(0).toVar();
  const hit = bool(false).toVar();
  const steps = float(0).toVar();
  const lastDistance = float(0).toVar();

  t.assign(tNear);

  Loop(maxSteps, () => {
    const d = sdf(rayOrigin.add(rayDirection.mul(t)));
    lastDistance.assign(d);
    steps.addAssign(1);

    If(d.lessThan(thresholdNode), () => {
      hit.assign(true);
      Break();
    });

    t.addAssign(d);

    If(t.greaterThan(tFar), () => {
      Break();
    });
  });

  return {
    hit,
    t,
    p: rayOrigin.add(rayDirection.mul(t)),
    steps,
    lastDistance,
  };
};

/**
 * Screen-space raymarched metaballs backed by CPU-updated source positions.
 *
 * Sources are fixed at construction time and should expose either
 * `{ position, radius }`, `{ p, r }`, or `{ p, rr }`.
 */
export class RaymarchedMetaballs {
  /**
   * @param {Object} opts
   * @param {THREE.PerspectiveCamera} opts.camera
   * @param {Array<Object>} opts.sources
   * @param {THREE.Texture} [opts.sceneTexture]
   * @param {THREE.Texture} [opts.rimTexture]
   * @param {number} [opts.smoothing]
   * @param {number} [opts.maxSteps]
   * @param {number} [opts.hitThreshold]
   * @param {number} [opts.normalEpsilon]
   * @param {number} [opts.refractionStrength]
   * @param {number} [opts.fresnelStrength]
   * @param {number} [opts.fresnelBase]
   * @param {number} [opts.rimStrength]
   * @param {string} [opts.debugMode]
   * @param {number} [opts.quadDistance]
   * @param {number} [opts.quadZ]
   * @param {number} [opts.boundsPadding]
   */
  constructor({
    camera,
    sources,
    sceneTexture = RaymarchedMetaballs._makePixel(255, 255, 255, 255),
    rimTexture = RaymarchedMetaballs._makePixel(0, 0, 0, 255),
    smoothing = DEFAULT_SMOOTHING,
    maxSteps = DEFAULT_MAX_STEPS,
    hitThreshold = DEFAULT_HIT_THRESHOLD,
    normalEpsilon = DEFAULT_NORMAL_EPSILON,
    refractionStrength = 0.22,
    fresnelStrength = 0.85,
    fresnelBase = 0.55,
    rimStrength = 0.45,
    debugMode = METABALL_DEBUG_MODES.BEAUTY,
    quadDistance,
    quadZ = 2.4,
    boundsPadding = 0.1,
  } = {}) {
    if (!camera) {
      throw new Error("RaymarchedMetaballs requires a camera.");
    }

    if (!Array.isArray(sources) || sources.length === 0) {
      throw new Error("RaymarchedMetaballs requires at least one source.");
    }

    this.camera = camera;
    this.sources = sources;
    this.count = sources.length;
    this.smoothing = smoothing;
    this.quadDistance =
      quadDistance ?? Math.max(0.1, camera.position.z - quadZ);
    this.boundsPadding = boundsPadding;

    this.positions = uniformArray(
      sources.map((source) => RaymarchedMetaballs._sourcePosition(source).clone())
    );
    this.radii = uniformArray(
      sources.map((source) => RaymarchedMetaballs._sourceRadius(source)),
      "float"
    );
    this.smoothingUniform = uniform(smoothing);
    this.maxSteps = uniform(maxSteps);
    this.hitThreshold = uniform(hitThreshold);
    this.normalEpsilon = uniform(normalEpsilon);
    this.refractionStrength = uniform(refractionStrength);
    this.fresnelStrength = uniform(fresnelStrength);
    this.fresnelBase = uniform(fresnelBase);
    this.rimStrength = uniform(rimStrength);
    this.debugMode = debugMode;
    this.debugModeUniform = uniform(
      RaymarchedMetaballs._debugModeValue(debugMode),
      "int"
    );
    this.tNear = uniform(1);
    this.tFar = uniform(10);
    this._sceneTexture = texture(sceneTexture);
    this._rimTexture = texture(rimTexture);

    this.material = this._createMaterial();
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), this.material);
    this.mesh.frustumCulled = false;

    this._ndc = new THREE.Vector3();
    this._viewPosition = new THREE.Vector3();
    this._right = new THREE.Vector3();
    this._up = new THREE.Vector3();
    this._forward = new THREE.Vector3();
    this._center = new THREE.Vector3();
    this.update();
  }

  setSceneTexture(textureValue) {
    this._sceneTexture.value = textureValue;
  }

  setRimTexture(textureValue) {
    this._rimTexture.value = textureValue;
  }

  setDebugMode(mode) {
    this.debugMode = mode;
    this.debugModeUniform.value = RaymarchedMetaballs._debugModeValue(mode);
  }

  setSmoothing(value) {
    this.smoothing = value;
    this.smoothingUniform.value = value;
  }

  update() {
    let x0 = 2;
    let x1 = -2;
    let y0 = 2;
    let y1 = -2;
    let dNear = 1e9;
    let dFar = 0;

    for (let i = 0; i < this.count; i++) {
      const source = this.sources[i];
      const position = RaymarchedMetaballs._sourcePosition(source);
      const radius = RaymarchedMetaballs._sourceRadius(source);

      this.positions.array[i].copy(position);
      this.radii.array[i] = radius;

      const dist = this.camera.position.distanceTo(position);
      const margin = radius + this.smoothing + this.boundsPadding;
      dNear = Math.min(dNear, dist - margin);
      dFar = Math.max(dFar, dist + margin);

      this._viewPosition.copy(position).applyMatrix4(this.camera.matrixWorldInverse);
      const depth = -this._viewPosition.z;
      if (depth <= this.camera.near) continue;

      const halfH =
        Math.tan((this.camera.fov / 2) * Math.PI / 180) *
        depth;
      this._ndc.copy(position).project(this.camera);
      x0 = Math.min(x0, this._ndc.x - margin / (halfH * this.camera.aspect));
      x1 = Math.max(x1, this._ndc.x + margin / (halfH * this.camera.aspect));
      y0 = Math.min(y0, this._ndc.y - margin / halfH);
      y1 = Math.max(y1, this._ndc.y + margin / halfH);
    }

    this.tNear.value = Math.max(0.5, dNear);
    this.tFar.value = dFar;

    if (this.debugMode === METABALL_DEBUG_MODES.BACKGROUND) {
      this._fitViewportQuad();
      return;
    }

    x0 = Math.max(x0, -1.05);
    x1 = Math.min(x1, 1.05);
    y0 = Math.max(y0, -1.05);
    y1 = Math.min(y1, 1.05);

    this.mesh.visible = x1 > x0 && y1 > y0;
    if (!this.mesh.visible) return;

    const halfH =
      Math.tan((this.camera.fov / 2) * Math.PI / 180) *
      this.quadDistance;
    const halfW = halfH * this.camera.aspect;

    const centerX = (x0 + x1) / 2 * halfW;
    const centerY = (y0 + y1) / 2 * halfH;

    this.camera.updateMatrixWorld();
    this._right.setFromMatrixColumn(this.camera.matrixWorld, 0);
    this._up.setFromMatrixColumn(this.camera.matrixWorld, 1);
    this.camera.getWorldDirection(this._forward);

    this._center
      .copy(this.camera.position)
      .addScaledVector(this._forward, this.quadDistance)
      .addScaledVector(this._right, centerX)
      .addScaledVector(this._up, centerY);

    this.mesh.position.copy(this._center);
    this.mesh.quaternion.copy(this.camera.quaternion);
    this.mesh.scale.set((x1 - x0) * halfW, (y1 - y0) * halfH, 1);
  }

  _fitViewportQuad() {
    const halfH =
      Math.tan((this.camera.fov / 2) * Math.PI / 180) *
      this.quadDistance;
    const halfW = halfH * this.camera.aspect;

    this.camera.updateMatrixWorld();
    this.camera.getWorldDirection(this._forward);

    this.mesh.visible = true;
    this.mesh.position
      .copy(this.camera.position)
      .addScaledVector(this._forward, this.quadDistance);
    this.mesh.quaternion.copy(this.camera.quaternion);
    this.mesh.scale.set(halfW * 2, halfH * 2, 1);
  }

  dispose() {
    this.mesh.geometry.dispose();
    this.material.dispose();
  }

  _createMaterial() {
    const material = new THREE.MeshBasicNodeMaterial();
    material.transparent = true;
    material.depthWrite = false;

    const sdf = Fn(([p]) =>
      smoothMinSphereSdf({
        p,
        positions: this.positions,
        radii: this.radii,
        count: this.count,
        smoothing: this.smoothingUniform,
      })
    );

    material.colorNode = Fn(() => {
      const ro = cameraPosition;
      const rd = normalize(positionWorld.sub(cameraPosition));
      const march = raymarchSdf({
        sdf,
        rayOrigin: ro,
        rayDirection: rd,
        tNear: this.tNear,
        tFar: this.tFar,
        maxSteps: this.maxSteps,
        threshold: this.hitThreshold,
      });

      const mode = this.debugModeUniform;
      const backgroundSample = this._sceneTexture.sample(screenUV);

      If(
        march.hit
          .not()
          .and(
            mode.notEqual(
              int(METABALL_DEBUG_MODE_VALUES[METABALL_DEBUG_MODES.BACKGROUND])
            )
          ),
        () => {
          Discard();
        }
      );

      const n = estimateSdfNormal({
        sdf,
        p: march.p,
        epsilon: this.normalEpsilon,
      });
      const fres = rd.dot(n).abs().oneMinus().pow(2);
      const refracted = this._sceneTexture.sample(
        screenUV.add(n.xy.mul(this.refractionStrength.negate()))
      );
      const rim = this._rimTexture.sample(screenUV);
      const rimContribution = rim.mul(fres.mul(this.rimStrength));
      const beauty = refracted
        .mul(fres.mul(this.fresnelStrength).add(this.fresnelBase))
        .add(rimContribution);

      const color = beauty.toVar();
      const depthSpan = this.tFar.sub(this.tNear).max(0.0001);

      If(
        mode.equal(
          int(METABALL_DEBUG_MODE_VALUES[METABALL_DEBUG_MODES.BACKGROUND])
        ),
        () => {
          color.assign(backgroundSample);
        }
      );

      If(
        mode.equal(
          int(METABALL_DEBUG_MODE_VALUES[METABALL_DEBUG_MODES.REFRACTED])
        ),
        () => {
          color.assign(refracted);
        }
      );

      If(mode.equal(int(METABALL_DEBUG_MODE_VALUES[METABALL_DEBUG_MODES.MASK])), () => {
        color.assign(vec3(1));
      });

      If(mode.equal(int(METABALL_DEBUG_MODE_VALUES[METABALL_DEBUG_MODES.NORMAL])), () => {
        color.assign(n.mul(0.5).add(0.5));
      });

      If(mode.equal(int(METABALL_DEBUG_MODE_VALUES[METABALL_DEBUG_MODES.DEPTH])), () => {
        const depth = march.t.sub(this.tNear).div(depthSpan).clamp(0, 1);
        color.assign(vec3(depth, depth.mul(0.55).add(0.12), depth.oneMinus()));
      });

      If(mode.equal(int(METABALL_DEBUG_MODE_VALUES[METABALL_DEBUG_MODES.STEPS])), () => {
        const stepRatio = march.steps.div(float(this.maxSteps)).clamp(0, 1);
        color.assign(vec3(stepRatio, stepRatio.pow(2), stepRatio.oneMinus()));
      });

      If(mode.equal(int(METABALL_DEBUG_MODE_VALUES[METABALL_DEBUG_MODES.FRESNEL])), () => {
        color.assign(vec3(fres, fres.pow(2), fres.oneMinus().mul(0.2)));
      });

      If(mode.equal(int(METABALL_DEBUG_MODE_VALUES[METABALL_DEBUG_MODES.RIM])), () => {
        color.assign(rimContribution);
      });

      return color;
    })();

    return material;
  }

  static _sourcePosition(source) {
    return source.position || source.p;
  }

  static _sourceRadius(source) {
    return source.radius ?? source.rr ?? source.r;
  }

  static _debugModeValue(mode) {
    if (mode in METABALL_DEBUG_MODE_VALUES) {
      return METABALL_DEBUG_MODE_VALUES[mode];
    }

    throw new Error(`Unknown metaball debug mode: ${mode}`);
  }

  static _makePixel(r, g, b, a) {
    const textureValue = new THREE.DataTexture(
      new Uint8Array([r, g, b, a]),
      1,
      1,
      THREE.RGBAFormat
    );
    textureValue.needsUpdate = true;
    return textureValue;
  }
}
