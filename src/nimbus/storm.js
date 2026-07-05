/**
 * @module nimbus/storm
 *
 * Storm director — the conductor that makes the nimbus feel alive.
 *
 * Drives three things every frame:
 *  1. Intracloud flicker: random pockets inside the volume pulse with
 *     stuttering sheet-lightning bursts (flash lights 0..N-2).
 *  2. Cloud-to-ground strikes: generates a bolt, crawls a stepped leader
 *     down over ~90 ms, fires the return stroke (channel blast + in-cloud
 *     flash at the channel origin + ground light + sky lift), then a few
 *     dart-leader restrikes with decaying energy.
 *  3. Scene coupling: exposes `groundLightIntensity`, `skyFlash` and the
 *     strike point so the host scene can light terrain / sky.
 *
 * All randomness is seeded per-strike; `strike(seed)` forces a
 * deterministic strike (useful for tests/captures).
 */

import * as THREE from 'three/webgpu';
import { generateBoltPaths } from './bolt.js';

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class StormDirector {
  /**
   * @param {object} opts
   * @param {import('./cloudMaterial.js').NimbusCloudMaterial} opts.cloudMaterial
   * @param {import('./bolt.js').LightningBoltMesh} opts.bolt
   * @param {THREE.Object3D} opts.cloudMesh — the unit-cube cloud volume mesh (world transform read)
   * @param {(x:number,y:number,z:number)=>number} [opts.densitySample] — analytic bake sampler (uvw space), used to place pockets inside actual cloud matter
   * @param {number} [opts.groundY=0]
   * @param {number} [opts.strikeIntervalMin=3.5]
   * @param {number} [opts.strikeIntervalMax=8]
   * @param {number} [opts.flickerRate=0.8] — intracloud bursts per second
   */
  constructor({
    cloudMaterial,
    bolt,
    cloudMesh,
    densitySample = null,
    groundY = 0,
    strikeIntervalMin = 3.5,
    strikeIntervalMax = 8,
    flickerRate = 0.8,
  }) {
    this.cloudMaterial = cloudMaterial;
    this.bolt = bolt;
    this.cloudMesh = cloudMesh;
    this.densitySample = densitySample;
    this.groundY = groundY;
    this.strikeIntervalMin = strikeIntervalMin;
    this.strikeIntervalMax = strikeIntervalMax;
    this.flickerRate = flickerRate;

    this.time = 0;
    this.rng = mulberry32(0xbeef);

    /** When true, `update` is a no-op (freeze for captures/debug). */
    this.paused = false;

    // Outputs for the host scene.
    this.groundLightIntensity = 0;
    this.skyFlash = 0;
    this.strikePoint = new THREE.Vector3();

    // Intracloud pockets: all flash lights except the last (strike channel).
    const lights = cloudMaterial.flashLights;
    this.pockets = lights.slice(0, Math.max(0, lights.length - 1)).map((light) => ({
      light,
      energy: 0,
      pulsesLeft: 0,
      pulseTimer: 0,
      decay: 8,
    }));
    this.strikeLight = lights[lights.length - 1];

    // Strike state machine.
    this.phase = 'idle'; // idle | leader | stroke
    this.phaseT = 0;
    this.strokes = [];   // scheduled return strokes {at, energy}
    this.strikeTimer = 2.0 + this.rng() * 2.0;
    this._strikeSeed = 1;

    this._tmp = new THREE.Vector3();
  }

  /** Pick a uvw point inside actual cloud matter (rejection sample). */
  _pocketUVW(rng, yMin, yMax) {
    const p = this._tmp;
    for (let i = 0; i < 24; i++) {
      p.set(0.25 + rng() * 0.5, yMin + rng() * (yMax - yMin), 0.25 + rng() * 0.5);
      if (!this.densitySample || this.densitySample(p.x, p.y, p.z) > 0.12) return p;
    }
    return p.set(0.5, (yMin + yMax) / 2, 0.5);
  }

  /** uvw [0,1]³ → world position via the cloud mesh transform. */
  _uvwToWorld(uvw, out) {
    out.set(uvw.x - 0.5, uvw.y - 0.5, uvw.z - 0.5);
    return this.cloudMesh.localToWorld(out);
  }

  /** Force a cloud-to-ground strike now. Deterministic for a given seed. */
  strike(seed = (Math.random() * 1e9) | 0) {
    this._strikeSeed = seed;
    const rng = mulberry32(seed);

    // Channel origin: low in the cloud, inside matter.
    const originUVW = this._pocketUVW(rng, 0.2, 0.38).clone();
    const startWorld = this._uvwToWorld(originUVW, new THREE.Vector3());

    // Strike point: below origin with lateral wander.
    const wander = 0.18 * this.cloudMesh.scale.x;
    const endWorld = new THREE.Vector3(
      startWorld.x + (rng() * 2 - 1) * wander,
      this.groundY,
      startWorld.z + (rng() * 2 - 1) * wander,
    );

    // Style roll: no two strikes should share a silhouette.
    const styleRoll = rng();
    let style;
    if (styleRoll < 0.22) {
      // Clean single channel, barely branched.
      style = {
        roughness: 0.08 + rng() * 0.04, branchChance: 0.03 + rng() * 0.04,
        branchSpread: 0.5, maxDepth: 2, bend: 0.25 + rng() * 0.25, forkChance: 0,
      };
    } else if (styleRoll < 0.6) {
      // Classic branched strike.
      style = {
        roughness: 0.10 + rng() * 0.05, branchChance: 0.09 + rng() * 0.07,
        branchSpread: 0.5 + rng() * 0.6, maxDepth: 3, bend: 0.35 + rng() * 0.35,
        forkChance: 0.15,
      };
    } else if (styleRoll < 0.85) {
      // Gnarled crawler: dense splayed branching.
      style = {
        roughness: 0.13 + rng() * 0.06, branchChance: 0.16 + rng() * 0.08,
        branchSpread: 0.8 + rng() * 0.5, maxDepth: 3, bend: 0.6 + rng() * 0.4,
        forkChance: 0.2, branchDecay: 0.55,
      };
    } else {
      // Big fork: two full ground terminations.
      style = {
        roughness: 0.11 + rng() * 0.05, branchChance: 0.08 + rng() * 0.08,
        branchSpread: 0.6 + rng() * 0.5, maxDepth: 2, bend: 0.4 + rng() * 0.3,
        forkChance: 1,
      };
    }

    const height = startWorld.y - endWorld.y;
    const paths = generateBoltPaths({
      seed: seed ^ 0x9e3779b9,
      start: startWorld,
      end: endWorld,
      offsetDecay: 0.45 + rng() * 0.2,
      width: height * 0.04,
      ...style,
    });
    this.bolt.setPaths(paths);
    this.bolt.mesh.visible = true;

    this.strikePoint.copy(endWorld);
    this._channelUVW = originUVW;

    // Leader phase.
    this.phase = 'leader';
    this.phaseT = 0;
    this.leaderDuration = 0.07 + rng() * 0.05;

    // Schedule return strokes: main + 1-3 restrikes.
    this.strokes = [{ at: this.leaderDuration, energy: 1 }];
    let at = this.leaderDuration;
    const restrikes = 1 + Math.floor(rng() * 3);
    let energy = 1;
    for (let i = 0; i < restrikes; i++) {
      at += 0.09 + rng() * 0.14;
      energy *= 0.45 + rng() * 0.25;
      this.strokes.push({ at, energy });
    }
    this.strokeEnvelope = 0;

    this.strikeTimer =
      this.strikeIntervalMin + this.rng() * (this.strikeIntervalMax - this.strikeIntervalMin);
  }

  /** Kick one intracloud flicker burst in a random pocket. */
  _startFlicker(pocket) {
    const rng = this.rng;
    const uvw = this._pocketUVW(rng, 0.35, 0.75);
    pocket.light.position.value.copy(uvw);
    pocket.pulsesLeft = 2 + Math.floor(rng() * 4);
    pocket.pulseTimer = 0;
    pocket.decay = 10 + rng() * 14;
    pocket.strength = 3 + rng() * 6;
  }

  /**
   * Advance the storm. Call once per frame.
   * @param {number} dt — seconds
   */
  update(dt) {
    if (this.paused) return;
    this.time += dt;
    const rng = this.rng;

    // ── Intracloud flicker pockets ──
    for (const pocket of this.pockets) {
      if (pocket.pulsesLeft <= 0 && pocket.energy < 0.01 && rng() < this.flickerRate * dt / this.pockets.length) {
        this._startFlicker(pocket);
      }
      if (pocket.pulsesLeft > 0) {
        pocket.pulseTimer -= dt;
        if (pocket.pulseTimer <= 0) {
          pocket.energy = pocket.strength * (0.5 + rng() * 0.5);
          pocket.pulseTimer = 0.03 + rng() * 0.09;
          pocket.pulsesLeft--;
          // Pocket drifts slightly between pulses — sheet lightning crawl.
          pocket.light.position.value.x += (rng() - 0.5) * 0.08;
          pocket.light.position.value.y += (rng() - 0.5) * 0.05;
          pocket.light.position.value.z += (rng() - 0.5) * 0.08;
        }
      }
      pocket.energy *= Math.exp(-dt * pocket.decay);
      pocket.light.intensity.value = pocket.energy;
    }

    // ── Strike scheduling ──
    if (this.phase === 'idle') {
      this.strikeTimer -= dt;
      if (this.strikeTimer <= 0) this.strike((this.rng() * 1e9) | 0);
    }

    // ── Strike state machine ──
    if (this.phase !== 'idle') {
      this.phaseT += dt;
      const u = this.bolt.uniforms;

      if (this.phase === 'leader') {
        const p = Math.min(1, this.phaseT / this.leaderDuration);
        // Stepped leader: advances in stutters, dim channel, hot tip.
        const stutter = 0.75 + 0.25 * Math.sin(this.phaseT * 210) * Math.sin(this.phaseT * 83);
        u.progress.value = p * stutter > u.progress.value ? p * stutter : u.progress.value;
        u.intensity.value = 0.5;
        u.leaderGlow.value = 2.5;
        if (this.phaseT >= this.leaderDuration) {
          this.phase = 'stroke';
        }
      }

      if (this.phase === 'stroke') {
        u.progress.value = 1.05;
        u.leaderGlow.value = 0;

        // Sum of scheduled stroke envelopes (sharp attack, exp decay).
        let env = 0;
        for (const s of this.strokes) {
          const dtS = this.phaseT - s.at;
          if (dtS >= 0) env += s.energy * Math.exp(-dtS * 22) * (0.7 + 0.3 * Math.sin(dtS * 320));
        }
        this.strokeEnvelope = Math.max(env, 0);
        // No floor: the channel goes dark between restrikes, like the real thing.
        u.intensity.value = this.strokeEnvelope * 9;

        const last = this.strokes[this.strokes.length - 1];
        if (this.phaseT > last.at + 0.45) {
          this.phase = 'idle';
          this.bolt.mesh.visible = false;
          u.intensity.value = 0;
          this.strokeEnvelope = 0;
        }
      }

      // Channel-origin flash light inside the cloud + scene coupling.
      const e = this.phase === 'leader' ? 0.15 : this.strokeEnvelope;
      this.strikeLight.position.value.copy(this._channelUVW);
      this.strikeLight.intensity.value = e * 35;
      this.groundLightIntensity = this.phase === 'stroke' ? this.strokeEnvelope : 0;
      this.skyFlash = Math.min(1, this.strokeEnvelope * 0.8);
    } else {
      this.strikeLight.intensity.value *= Math.exp(-dt * 12);
      this.groundLightIntensity *= Math.exp(-dt * 12);
      this.skyFlash *= Math.exp(-dt * 10);
    }
  }
}
