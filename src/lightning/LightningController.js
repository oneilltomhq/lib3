/**
 * @module LightningController
 *
 * Timing / flicker / state machine for channel lightning.
 *
 * Lifecycle: IDLE → LEADER → STROKE → RESTRIKE → FADE → IDLE
 *
 * - Leader: progressive reveal (0→1) over leaderDuration
 * - Stroke: full brightness return stroke flash
 * - Re-strike: repeats the stroke N times with intervals
 * - Fade: brightness ramps down
 */

import { generateLeader, generateReturnStroke, generateForked, generateCrawler, presets } from './generateBolt.js';
import { createLightningMesh } from './LightningRibbon.js';

/** @enum {string} */
const Phase = {
  IDLE: 'idle',
  LEADER: 'leader',
  STROKE: 'stroke',
  RESTRIKE: 'restrike',
  FADE: 'fade',
};

/**
 * @typedef {Object} StrikeConfig
 * @property {string} preset - 'leader' | 'returnStroke' | 'forked' | 'crawler'
 * @property {number} seed
 * @property {{ x: number, y: number, z: number }} start
 * @property {{ x: number, y: number, z: number }} end
 * @property {number} leaderSpeed - reveal units per second (1.0 = full bolt in 1s)
 * @property {number} strokeDuration - seconds the bright return stroke lasts
 * @property {number} restrikeCount - number of re-strikes after initial stroke
 * @property {number} restrikeInterval - seconds between re-strikes
 * @property {number} fadeRate - fade speed (units per second)
 * @property {Object} [generationOpts] - extra opts passed to generator
 * @property {Object} [materialOpts] - extra opts passed to ribbon material
 * @property {Object} [geometryOpts] - extra opts passed to ribbon geometry
 */

/**
 * A single managed lightning strike with lifecycle state machine.
 */
export class LightningStrike {
  /**
   * @param {import('three').Scene} scene
   * @param {StrikeConfig} config
   */
  constructor(scene, config) {
    this.scene = scene;
    this.config = config;
    this.phase = Phase.IDLE;
    this.phaseTime = 0;
    this.restrikesDone = 0;
    this.restrikeTimer = 0;
    this.mesh = null;
    this.uniforms = null;
    this.geometry = null;
    this.material = null;
    this.disposed = false;

    this._spawn();
  }

  _spawn() {
    const cfg = this.config;
    const generator = presets[cfg.preset] || presets.leader;

    const genOpts = {
      seed: cfg.seed,
      start: cfg.start,
      end: cfg.end,
      ...(cfg.generationOpts || {}),
    };

    const graph = generator(genOpts);

    const result = createLightningMesh(graph, cfg.materialOpts, cfg.geometryOpts);
    this.mesh = result.mesh;
    this.uniforms = result.uniforms;
    this.geometry = result.geometry;
    this.material = result.material;

    // Start with leader phase
    this.uniforms.reveal.value = 0;
    this.uniforms.brightness.value = 0.4; // dim leader
    this.uniforms.fade.value = 1.0;
    this.phase = Phase.LEADER;
    this.phaseTime = 0;

    this.scene.add(this.mesh);
  }

  /**
   * Update the strike state machine.
   * @param {number} dt - delta time in seconds
   * @returns {boolean} true if still active, false if done
   */
  update(dt) {
    if (this.disposed) return false;

    this.phaseTime += dt;

    switch (this.phase) {
      case Phase.LEADER: {
        const reveal = this.phaseTime * this.config.leaderSpeed;
        this.uniforms.reveal.value = Math.min(1, reveal);
        // Dim leader brightness with subtle variation
        this.uniforms.brightness.value = 0.35 + Math.sin(this.phaseTime * 40) * 0.05;
        if (reveal >= 1.0) {
          this.phase = Phase.STROKE;
          this.phaseTime = 0;
        }
        break;
      }

      case Phase.STROKE: {
        // Bright return stroke flash
        const t = this.phaseTime / this.config.strokeDuration;
        // Sharp attack, slight decay
        const envelope = t < 0.1 ? t / 0.1 : 1.0 - (t - 0.1) * 0.3;
        this.uniforms.brightness.value = Math.max(0.5, Math.min(3.0, envelope * 2.5));
        this.uniforms.reveal.value = 1.0;
        if (this.phaseTime >= this.config.strokeDuration) {
          if (this.config.restrikeCount > 0) {
            this.phase = Phase.RESTRIKE;
            this.restrikesDone = 0;
            this.restrikeTimer = 0;
          } else {
            this.phase = Phase.FADE;
          }
          this.phaseTime = 0;
        }
        break;
      }

      case Phase.RESTRIKE: {
        this.restrikeTimer += dt;
        // Brief flash on each re-strike
        const inFlash = this.restrikeTimer < this.config.strokeDuration * 0.6;
        if (inFlash) {
          const ft = this.restrikeTimer / (this.config.strokeDuration * 0.6);
          this.uniforms.brightness.value = 1.5 + Math.sin(ft * Math.PI) * 1.0;
        } else {
          this.uniforms.brightness.value = 0.2;
        }

        if (this.restrikeTimer >= this.config.restrikeInterval) {
          this.restrikeTimer = 0;
          this.restrikesDone++;
          if (this.restrikesDone >= this.config.restrikeCount) {
            this.phase = Phase.FADE;
            this.phaseTime = 0;
          }
        }
        break;
      }

      case Phase.FADE: {
        const fade = 1.0 - this.phaseTime * this.config.fadeRate;
        this.uniforms.fade.value = Math.max(0, fade);
        this.uniforms.brightness.value = Math.max(0, 0.3 * fade);
        if (fade <= 0) {
          this.dispose();
          return false;
        }
        break;
      }

      case Phase.IDLE:
        return false;
    }

    return true;
  }

  /**
   * Dispose all GPU resources.
   */
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.phase = Phase.IDLE;
    if (this.mesh) {
      this.scene.remove(this.mesh);
    }
    if (this.geometry) {
      this.geometry.dispose();
    }
    if (this.material) {
      this.material.dispose();
    }
    this.mesh = null;
    this.geometry = null;
    this.material = null;
    this.uniforms = null;
  }
}

/**
 * Manages multiple simultaneous lightning strikes.
 */
export class LightningController {
  /**
   * @param {import('three').Scene} scene
   */
  constructor(scene) {
    this.scene = scene;
    /** @type {LightningStrike[]} */
    this.strikes = [];
  }

  /**
   * Trigger a new lightning strike.
   * @param {StrikeConfig} config
   * @returns {LightningStrike}
   */
  trigger(config) {
    const strike = new LightningStrike(this.scene, config);
    this.strikes.push(strike);
    return strike;
  }

  /**
   * Update all active strikes.
   * @param {number} dt - delta time in seconds
   */
  update(dt) {
    for (let i = this.strikes.length - 1; i >= 0; i--) {
      const alive = this.strikes[i].update(dt);
      if (!alive) {
        this.strikes.splice(i, 1);
      }
    }
  }

  /**
   * Get count of currently active strikes.
   * @returns {number}
   */
  get activeCount() {
    return this.strikes.length;
  }

  /**
   * Dispose all strikes and clean up.
   */
  dispose() {
    for (const strike of this.strikes) {
      strike.dispose();
    }
    this.strikes.length = 0;
  }
}
