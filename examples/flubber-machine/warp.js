// The `warp` source: domain-warped fbm nebula — q = fbm(p+t),
// r = fbm(p+2.2q+offsets±t), f = fbm(p+3r); dark base, warm/cool mid, pink
// filaments. Ported from the site's hydra-tsl.js, registered into lib3's
// shared hydra vocabulary (demo-local: the look bakes art decisions).
//
// Deliberately DROPPED from the site version (it served a text column this
// demo doesn't have): the right-side gating on the filaments and the
// left→right brightness ramp. The vignette stays — it is depth, not layout.
// Sweep at contract time and re-judge on the full frame.
import {
  float, vec2, vec3, vec4, mix, clamp, smoothstep, pow, dot, length, time,
  mx_noise_float,
} from "three/tsl";
import { registerTransform } from "../../src/hydra/index.js";

// five octaves of mx_noise remapped to [0,1], unrolled at compile time
const fbm2 = (p) => {
  let v = float(0), amp = float(0.5), pp = p;
  for (let i = 0; i < 5; i++) {
    v = v.add(amp.mul(mx_noise_float(vec3(pp, 0)).mul(0.5).add(0.5)));
    pp = pp.mul(2); amp = amp.mul(0.5);
  }
  return v;
};

// explicit call, not an import side effect — rollup tree-shakes a bare
// `import "./warp.js"` out of the production build and the source silently
// vanishes from the api
export const registerWarp = () => registerTransform("warp", {
  type: "src", defaults: [3.2, 0.34, 0.72, 0.5, 21, 1],
  fn: (st, scale, warm, cool, pink, seed, speed) => {
    const p = st.sub(0.5).mul(scale).add(seed);
    const tt = time.mul(0.06).mul(speed);
    const q = vec2(
      fbm2(p.add(tt)),
      fbm2(p.add(vec2(5.2, 1.3)).sub(tt.mul(0.8))));
    const pq = p.add(q.mul(2.2));
    const r = vec2(
      fbm2(pq.add(vec2(1.7, 9.2)).add(tt.mul(0.7))),
      fbm2(pq.add(vec2(8.3, 2.8)).sub(tt.mul(0.6))));
    const f = fbm2(p.add(r.mul(3)));
    const dark = vec3(0.045, 0.045, 0.06);
    const mid = vec3(warm, warm.mul(0.72), cool);
    let col = mix(dark, mid, clamp(f.mul(1.35), 0, 1));
    col = mix(col, vec3(cool.mul(0.9), warm.mul(0.66), cool),
      clamp(dot(r, r).mul(0.55), 0, 1));
    const fil = pow(clamp(f, 0, 1), 3);
    col = col.add(vec3(1.0, 0.72, 0.92).mul(fil).mul(pink));
    const vig = smoothstep(1.25, 0.35, length(st.sub(0.5)));
    col = col.mul(mix(0.7, 1.0, vig));
    return vec4(col, 1);
  },
});
