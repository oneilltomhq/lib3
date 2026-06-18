import { animate, utils } from "animejs";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { Inspector } from "three/addons/inspector/Inspector.js";
import {
  Fn,
  Loop,
  abs,
  clamp,
  float,
  mix,
  time,
  uniform,
  uv,
  vec3,
  vec4,
} from "three/tsl";
import * as THREE from "three/webgpu";
import { simplexNoise3 } from "../../src/index.js";

// Scene setup
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(
  60,
  window.innerWidth / window.innerHeight,
  0.1,
  1000
);
camera.position.set(0, 0, 2.2);

const renderer = new THREE.WebGPURenderer({
  canvas: document.getElementById("canvas"),
  antialias: true,
});
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(window.devicePixelRatio);
renderer.setClearColor(0x000000);
renderer.inspector = new Inspector();
new OrbitControls(camera, renderer.domElement);

// Inspector: open by default and dock to the right with dynamic width
// - Panel width: up to 500px, but leave at least 500px for the canvas
// - Applies on load and resize
const profiler = renderer.inspector.profiler;

// Inject CSS overrides to dock the inspector to the right side
(() => {
  const style = document.createElement("style");
  style.textContent = `
    #profiler-panel {
      top: 0; bottom: 0; right: 0; left: auto;
      width: 360px; height: auto;
      transform: translateX(100%);
      border-top: none;
      border-left: 2px solid var(--profiler-border);
    }
    #profiler-panel.visible { transform: translateX(0); }
    .panel-resizer { display: none; }
  `;
  document.head.appendChild(style);
})();

function computeInspectorWidth() {
  const full = window.innerWidth;
  // Ensure at least 500px for canvas; inspector max 500px
  return Math.max(0, Math.min(500, full - 500));
}

function layoutTogglePosition() {
  const panel = profiler.panel;
  const inspectorWidth = computeInspectorWidth();
  const isVisible = panel.classList.contains("visible");
  // Keep FPS toggle always visible and above panel
  profiler.toggleButton.style.zIndex = "1002";
  profiler.toggleButton.style.right =
    (isVisible ? inspectorWidth + 15 : 15) + "px";
}

function layoutWithInspector(open = true) {
  // Attach inspector shell to the same parent as the canvas if not already
  const shell = renderer.inspector.domElement;
  const parent = renderer.domElement.parentElement || document.body;
  if (shell.parentElement === null) parent.appendChild(shell);

  const panel = profiler.panel;
  const inspectorWidth = computeInspectorWidth();

  // Open panel by default
  if (open) panel.classList.add("visible");

  panel.style.width = inspectorWidth + "px";

  const canvasWidth = Math.max(1, window.innerWidth - inspectorWidth);
  renderer.domElement.style.width = canvasWidth + "px";
  renderer.setSize(canvasWidth, window.innerHeight);

  camera.aspect = canvasWidth / window.innerHeight;
  camera.updateProjectionMatrix();

  layoutTogglePosition();
}

// Initial layout: open inspector and size canvas accordingly
layoutWithInspector(true);

// Keep FPS button visible even when panel is open
(() => {
  const origToggle = profiler.togglePanel.bind(profiler);
  profiler.togglePanel = () => {
    origToggle();
    profiler.toggleButton.classList.remove("hidden");
    layoutTogglePosition();
  };
})();

// Controls - define uniforms outside the shader function so Inspector can access them
const scaleX = uniform(0.25);
const scaleY = uniform(4.0);
const integrateSamples = uniform(12);
const ridgedSharpness = uniform(0.85);
const warpStrength = uniform(0.15);
const fbmLacunarity = uniform(2.0);
const fbmGain = uniform(0.5);
const animate_shader = uniform(1);

// TSL shader that generates anisotropic ridged fBm with vertical streak integration
const streakTextureTSL = Fn(() => {
  const uv0 = uv();

  // Aspect fix: scale X by aspect so isotropic base maps to screen space
  const aspect = float(window.innerWidth / window.innerHeight);

  // Prepare anisotropic domain: stretch Y, compress X
  const baseP = vec3(
    uv0.x.mul(scaleX).mul(aspect),
    uv0.y.mul(scaleY),
    time.mul(animate_shader.mul(0.1))
  ).toVar();

  // Domain warp (mostly X) to introduce curvy drips and clumps
  const warpNoise = simplexNoise3({ v: baseP.mul(0.6) });
  baseP.x.addAssign(warpNoise.mul(warpStrength));

  // Ridged fBm helper
  const ridged = Fn(({ x }) => float(1.0).sub(abs(x).mul(2.0).sub(1.0).abs()));

  const fbmRidged = Fn(({ p }) => {
    const octaves = 5;
    const sum = float(0.0).toVar();
    const amp = float(1.0).toVar();
    const maxAmp = float(0.0).toVar();
    const freq = float(1.0).toVar();

    Loop(octaves, ({ i }) => {
      const n = simplexNoise3({ v: p.mul(freq) });
      const r = mix(abs(n), ridged({ x: n }), ridgedSharpness);
      sum.addAssign(r.mul(amp));
      maxAmp.addAssign(amp);
      amp.mulAssign(fbmGain);
      freq.mulAssign(fbmLacunarity);
    });

    return sum.div(maxAmp);
  });

  // Integrate upwards along Y to create vertical streaks (one-direction blur)
  const accum = float(0.0).toVar();
  const weightSum = float(0.0).toVar();
  const invSamples = float(1.0).div(integrateSamples);

  Loop(integrateSamples, ({ i }) => {
    const t = float(i).mul(invSamples);
    const weight = float(1.0).sub(t); // heavier near current row
    const p = vec3(baseP.x, baseP.y.add(t.mul(0.35)), baseP.z);
    const v = fbmRidged({ p });
    accum.addAssign(v.mul(weight));
    weightSum.addAssign(weight);
  });

  const gray = clamp(accum.div(weightSum), 0, 1);
  // Contrast and slight lift for readability
  const outV = clamp(gray.mul(1.35).add(0.02), 0, 1);
  return vec4(outV, outV, outV, 1.0);
});

const material = new THREE.MeshBasicNodeMaterial();
material.colorNode = streakTextureTSL();

const mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material);
scene.add(mesh);

// Inspector GUI with live updates - .listen() makes them track animated values!
const gui = renderer.inspector.createParameters("🎼 Orchestral Symphony");
gui.add(scaleX, "value", 0.1, 5.0, 0.1).name("scaleX").listen();
gui.add(scaleY, "value", 0.5, 10.0, 0.1).name("scaleY").listen();
gui.add(integrateSamples, "value", 1, 24, 1).name("integrateSamples").listen();
gui
  .add(ridgedSharpness, "value", 0.0, 1.0, 0.01)
  .name("ridgedSharpness")
  .listen();
gui.add(warpStrength, "value", 0.0, 2.0, 0.01).name("warpStrength").listen();
gui.add(fbmLacunarity, "value", 0.1, 4.0, 0.1).name("fbmLacunarity").listen();
gui.add(fbmGain, "value", 0.25, 1.0, 0.01).name("fbmGain").listen();
gui.add(animate_shader, "value", 0, 1, 1).name("animate");

// ═══════════════════════════════════════════════════════════════════
// 🎼 ORCHESTRAL SYMPHONY OF PARAMETER ANIMATIONS
// ═══════════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════════
// 🎵 MOVEMENT 1: The Slow Dance - Scale Parameters
// ═══════════════════════════════════════════════════════════════════
// scaleX and scaleY perform a slow, breathing waltz
// They move in counterpoint - when one expands, the other contracts

const scalePhase = { x: 0, y: Math.PI }; // Start in counterpoint

animate(scalePhase, {
  x: [0, Math.PI * 8], // Many cycles
  y: [Math.PI, Math.PI * 9],
  duration: 60000, // 1 minute full cycle
  ease: "linear",
  loop: true,
  onUpdate: () => {
    // scaleX: 0.1 to 2.0 with secondary modulation
    scaleX.value =
      0.8 + 0.7 * Math.sin(scalePhase.x) + 0.3 * Math.sin(scalePhase.x * 3);

    // scaleY: inverse relationship, 2.0 to 8.0
    scaleY.value =
      5.0 + 3.0 * Math.cos(scalePhase.y) + 1.0 * Math.cos(scalePhase.y * 2);
  },
});

// ═══════════════════════════════════════════════════════════════════
// 🎵 MOVEMENT 2: The Pulse - Ridged Sharpness
// ═══════════════════════════════════════════════════════════════════
// Sharp, rhythmic pulses that occasionally break into irregular patterns

let pulseMode = "regular";
const pulseState = { value: 0.85, intensity: 0 };

const switchPulseMode = () => {
  pulseMode = utils.random(0, 1) > 0.7 ? "irregular" : "regular";

  if (pulseMode === "regular") {
    // Regular breathing pulse
    animate(pulseState, {
      value: [0.3, 0.95, 0.3],
      duration: 8000,
      ease: "inOutCubic",
      onUpdate: () => {
        ridgedSharpness.value = pulseState.value;
      },
      onComplete: switchPulseMode,
    });
  } else {
    // Irregular staccato bursts
    const burstCount = Math.floor(utils.random(3, 8));
    let burstsDone = 0;

    const doBurst = () => {
      const target = utils.random(0.2, 0.98);
      animate(pulseState, {
        value: target,
        duration: utils.random(400, 1200),
        ease: utils.randomPick([
          "inOutQuad",
          "outElastic(1, .5)",
          "inOutBack(2)",
        ]),
        onUpdate: () => {
          ridgedSharpness.value = pulseState.value;
        },
        onComplete: () => {
          burstsDone++;
          if (burstsDone < burstCount) doBurst();
          else switchPulseMode();
        },
      });
    };
    doBurst();
  }
};
switchPulseMode();

// ═══════════════════════════════════════════════════════════════════
// 🎵 MOVEMENT 3: The Shimmer - Warp Strength
// ═══════════════════════════════════════════════════════════════════
// High frequency tremolo with slow amplitude modulation

const warpOsc = {
  phase: 0,
  amplitude: 0.5,
  frequency: 1.0,
};

// Fast oscillation
animate(warpOsc, {
  phase: [0, Math.PI * 40], // Many fast cycles
  duration: 20000,
  ease: "linear",
  loop: true,
});

// Slow amplitude breathing
animate(warpOsc, {
  amplitude: [0.2, 1.2, 0.2],
  duration: 25000,
  ease: "inOutQuad",
  loop: true,
});

// Frequency variation for shimmer
animate(warpOsc, {
  frequency: [0.8, 1.5, 0.8],
  duration: 18000,
  ease: "inOutSine",
  loop: true,
});

// Composite update
const updateWarp = () => {
  warpStrength.value =
    0.5 +
    0.4 * Math.sin(warpOsc.phase * warpOsc.frequency) * warpOsc.amplitude +
    0.15 * Math.sin(warpOsc.phase * 2.7) * (1 - warpOsc.amplitude * 0.3);
  requestAnimationFrame(updateWarp);
};
updateWarp();

// ═══════════════════════════════════════════════════════════════════
// 🎵 MOVEMENT 4: The Journey - FBM Parameters
// ═══════════════════════════════════════════════════════════════════
// Lacunarity and Gain explore parameter space together
// Creating evolving fractal textures

const fbmJourney = {
  lacunarity: 2.0,
  gain: 0.5,
  phase: 0,
  chaosFactor: 0,
};

// Main journey - circular path through parameter space
animate(fbmJourney, {
  phase: [0, Math.PI * 2],
  duration: 45000,
  ease: "linear",
  loop: true,
});

// Chaos injection - occasional disturbances
const injectChaos = () => {
  animate(fbmJourney, {
    chaosFactor: [0, utils.random(0.3, 0.7), 0],
    duration: utils.random(3000, 7000),
    ease: "inOutSine",
    onComplete: () => {
      setTimeout(injectChaos, utils.random(5000, 15000));
    },
  });
};
injectChaos();

// Update FBM parameters
const updateFBM = () => {
  // Lissajous-like curves for interesting paths
  const lacBase = 2.0 + 1.0 * Math.sin(fbmJourney.phase);
  const lacChaos = utils.random(-0.5, 0.5) * fbmJourney.chaosFactor;
  fbmLacunarity.value = Math.max(0.5, Math.min(3.5, lacBase + lacChaos));

  const gainBase = 0.5 + 0.3 * Math.cos(fbmJourney.phase * 1.618); // Golden ratio
  const gainChaos = utils.random(-0.2, 0.2) * fbmJourney.chaosFactor;
  fbmGain.value = Math.max(0.25, Math.min(0.95, gainBase + gainChaos));

  requestAnimationFrame(updateFBM);
};
updateFBM();

// ═══════════════════════════════════════════════════════════════════
// 🎵 MOVEMENT 5: The Cascade - Integrate Samples
// ═══════════════════════════════════════════════════════════════════
// Steps up and down in discrete rhythms, sometimes smooth, sometimes jagged

let cascadeDirection = 1;
const cascadeState = { value: 12 };

const doCascade = () => {
  const isSmooth = utils.random(0, 1) > 0.5;
  const steps = Math.floor(utils.random(2, 6));

  if (isSmooth) {
    // Smooth glide
    const target =
      cascadeDirection > 0 ? utils.random(16, 24) : utils.random(3, 10);

    animate(cascadeState, {
      value: target,
      duration: utils.random(5000, 10000),
      ease: "inOutQuad",
      onUpdate: () => {
        integrateSamples.value = Math.round(cascadeState.value);
      },
      onComplete: () => {
        cascadeDirection *= -1;
        setTimeout(doCascade, utils.random(2000, 5000));
      },
    });
  } else {
    // Stepwise cascade
    let stepsDone = 0;
    const doStep = () => {
      const delta = cascadeDirection * utils.random(2, 5);
      cascadeState.value = Math.max(
        2,
        Math.min(24, cascadeState.value + delta)
      );

      animate(cascadeState, {
        value: cascadeState.value,
        duration: utils.random(800, 1500),
        ease: utils.randomPick(["inQuad", "outQuad", "linear"]),
        onUpdate: () => {
          integrateSamples.value = Math.round(cascadeState.value);
        },
        onComplete: () => {
          stepsDone++;
          if (stepsDone < steps) {
            setTimeout(doStep, utils.random(200, 600));
          } else {
            cascadeDirection *= -1;
            setTimeout(doCascade, utils.random(3000, 7000));
          }
        },
      });
    };
    doStep();
  }
};
setTimeout(doCascade, 2000);

// ═══════════════════════════════════════════════════════════════════

function onResize() {
  layoutWithInspector(false);
}
window.addEventListener("resize", onResize);

renderer.setAnimationLoop(() => {
  renderer.render(scene, camera);
});
