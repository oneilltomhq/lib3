# Spine Lab — the physics, in synthesis terms

Everything in this lab is one idea wearing three costumes:

> **A damped spring is a two-pole resonant lowpass filter.**

The same second-order equation your synth's filter section solves:

```
acceleration = −ω²·(position − target) − 2ζω·velocity        ω = 2πf
```

If you can reason about cutoff, resonance, and pinging a filter, you can
reason about every motion in this lab. There is no other physics here.

| Spring term | Synth term | What it does to motion |
|---|---|---|
| `freq` (f) | **cutoff** | how fast the thing can follow its target |
| `zeta` (ζ) | **1/Q — resonance** | ζ < 1 overshoots and rings; ζ = 1 lands exactly; ζ > 1 drags |
| `kick(v)` | **striking the filter** | velocity impulse — the 808 trick: ping it, let it ring |
| `target` | **input signal** | what it's chasing |

## The three layers (filters in series)

```
beat ──force──▶ HEAD ──pose──▶ CHAIN (16 in series) ──pose──▶ FLESH (1 per vertex, parallel)
```

1. **Head** — the kick is a *force*, not a keyframe. On every floor hit the
   head's springs get `kick()`ed: compress (swell), dip (lift), and a shove
   along the circle it's travelling. Between hits, *anticipation* raises the
   head into the next beat with an f³ envelope — a dancer lifting before the
   one.

2. **Chain** — 16 spring segments, each chasing the one above it. Filters in
   series: group delay accumulates, so the pulse arrives later, rounder, and
   lower down the tube — like flesh, because flesh IS a spring chain.

3. **Flesh** — every vertex is a mass on a spring anchored to its chain-posed
   target, with position + velocity persisting in GPU storage buffers
   (a compute kernel integrates all ~6k of them per frame). The vertex
   overshoots the pose and jiggles as it settles. The wireframe glows where
   vertex velocity is high — you see the momentum directly.

## Every knob, one sentence

| Knob | Synth reading |
|---|---|
| `/beat/bpm`, `/beat/swing` | the clock; swing displaces every off-step late |
| `/head/impulse` | how hard the kick pings the head filter |
| `/head/anticipate` | depth of the pre-beat rise envelope (f³ into the one) |
| `/head/epiSize` | master depth of the two position LFOs |
| `/head/epiBeats` | period of the slow orbit LFO, in beats |
| `/head/epiRatio` | frequency ratio of the counter-rotating second LFO (the epicycle) |
| `/chain/follow` | cutoff of the head's follow filter (Hz) |
| `/chain/lag` | tail cutoff as a fraction of head cutoff — how deep the pulse arrives late |
| `/chain/ring` | resonance of every chain filter (low = giegling wobble, high = ostgut snap) |
| `/flesh/amount` | dry/wet between raw chain pose and the per-vertex filtered pose |
| `/flesh/stiff` | cutoff of every vertex's filter (higher = tighter tracking) |
| `/flesh/damp` | damping of the vertex filters (lower = jigglier) |
| `/arc/depth` | slow automation lane: energy builds through the phrase, snaps back at the head — the drop |

## The resonance incident (worth knowing)

A driven, underdamped filter blows up when the drive frequency lands on its
cutoff — self-oscillation. The first giegling preset did exactly that: the
geometric lag falloff put mid-chain cutoffs (~0.14 Hz) on top of the orbit
LFO (~0.16 Hz) with high Q, and the middle of the tube span out flat while
the ends stayed calm. That failure is the model working: if the motion can
self-oscillate like a filter, it's because it *is* one. `lag` is now the
tail/head speed ratio spread evenly, which keeps every segment's cutoff away
from the LFO band — but push `ring` low and `follow` near the orbit rate and
you can find the scream again on purpose.
