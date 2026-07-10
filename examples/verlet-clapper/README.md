# Verlet Clapper — the physics, explicated

One idea: **the tip trajectory is the signature of the whole piece.**
Everything downstream (flubber deformation, lightning timing, murmuration)
inherits its character, so the shaft dynamics ARE the piece. This lab is the
shaft, alone, with every dial exposed.

## The model: verlet chain with bending stiffness

```
anchor (driven, lissajous wander)
  ● — ● — ● — ● — ● — ●●● (tip, heavy)
```

A point in a verlet sim has no velocity variable. Velocity is *implicit* in
the gap between where it is and where it was:

```
next = pos + (pos − prev)·drag + accel·h²
```

Move a point and you have changed its velocity — which is why constraints
(which only ever move points) produce physically plausible motion for free.
That is the whole trick, and it is why this is ~40 lines instead of an
engine dependency. Rigid-body engines (Rapier, cannon) model a soft rod as a
chain of rigid bodies with stiff joints — a solver-fighting stack. Fifteen
points and two constraint loops do it better.

Two constraint families, solved by repeated relaxation:

| Constraint | Pair | Rest | What it is |
|---|---|---|---|
| distance | `i, i+1` | `seg` | the rod's length — never soft, k = 1 |
| bending | `i, i+2` | `2·seg` | **the material** — k = `bend` |

The bending constraint is nothing exotic: "stay far from your second
neighbour." When a joint folds, `i` and `i+2` get closer than `2·seg`; the
constraint pushes them apart; the rod straightens. Its violation is *stored
spring energy* — the shaft glows white where that shortfall is large, so you
can watch energy load and travel.

## The two dials of character

| Dial | Weak | Strong |
|---|---|---|
| `bend stiffness` | whip / rubber | stiff rod with subtle flex |
| `iterations` | loose, floppy, laggy | stiff, snappy |

`iterations` stiffens because each solver pass re-applies every constraint —
more passes converge harder toward the rest shape per step. These two
parameters are most of what "material" means here. Everything else
(tip mass, drag, gravity) is seasoning.

**Tip mass** enters only through constraint weighting: a pair splits its
correction by inverse mass, so a heavy tip concedes little and the light
shaft wraps around it. That asymmetry is the bell-clapper feel.

## The slingshot (why this is generative)

Swing reverses → shaft bends → bend constraints violate (energy stored) →
constraints unload → tip snaps through. Whip-crack overshoot, lag, S-curves:
rich, organic acceleration patterns no hand-authored curve gives. Press
**crack the whip** (a fast out-and-back stroke on the anchor — the *reversal*
is what loads the shaft) and watch the energy glow travel down and dump into
the tip.

Two layers multiply:

```
anchor wander (slow lissajous — supernatural, intent)
   × shaft dynamics (reactive — material, weight)
   = tip motion with intent AND weight
```

## The bridge to GPU (thin and clean)

The CPU sim is ~15 points; it costs nothing. Per frame, the whole handoff is
uniforms:

| Uniform | Use downstream |
|---|---|
| `uTip` | attraction well centre; discharge origin |
| `uTipVel` | smears the target kernel — the flubber drags *and* anticipates |
| `uTrail[16]` | ring buffer of recent tip positions — each particle chases its own lag. **Lag = body**, not point |
| `uTipHeat` | normalized `\|tipAccel\|` — the tip's effort, visible |
| `uFlash` | discharge envelope |

The discharge is the payoff: a spike in `|tipAccel|` (the whip-crack) trips a
threshold and the swarm blows outward while the shaft burns white. Nobody
scheduled that flash — the material produced it. Free choreography,
physically motivated. The meter in the panel plots the normalized signal
against the trip line so you can see exactly which motion fires it.

Normalization: `aN = |a| / (|a| + K)` maps any acceleration scale to 0..1,
so the threshold slider means the same thing for a floppy whip and a heavy
clapper.

## Presets, read as materials

| Preset | bend | iter | tip mass | reading |
|---|---|---|---|---|
| whip | 0.04 | 8 | 2 | no material memory; pure transport; cracks easily |
| hose | 0.30 | 12 | 4 | rubber; lazy S-curves; occasional crack |
| rod | 0.92 | 34 | 5 | stiff with subtle flex; tip tracks anchor |
| clapper | 0.70 | 22 | 18 | heavy pendulum in a stiff shaft; slow, weighty, big unloads |

Boids sub-lattices slot in later without touching any of this: the tip well
stays a shared force; murmuration is local rules on top.
