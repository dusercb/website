// Colour tables for the film, cinema and aesthetic filters. Each is computed here from a short
// recipe (tone curves, hue-band shifts, a channel mix, split toning), not copied from any app.
// The table holds 33 steps per channel as 33 slices of 33 × 33 side by side, blue picking the slice
// (sampled by lutColor() in gl.js).
//
// Recipe steps, applied in order:
//   curve: [[x, y], …]           a tone curve for all three channels (monotone through the points)
//   r / g / b: [[x, y], …]       a curve for one channel
//   mix: [[rr, rg, rb], [gr, gg, gb], [br, bg, bb]]   a channel mix
//   warm: k                      cooler (−) or warmer (+)
//   hue: [[centre°, width°, shift°, saturation ×, lightness +], …]   adjust one band of hues
//   sat: k                       saturation ×
//   split: [[r, g, b] shadows, [r, g, b] highlights, amount]   tints where 0.5 means none
//   fade: k                      lifted blacks
//   mono: [wr, wg, wb]           black and white with these channel weights

export const LUT_N = 33;

// Monotone cubic through the points (Fritsch–Carlson), so curves never overshoot.
function curveFn(pts) {
  const n = pts.length, xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  const d = [], m = new Array(n);
  for (let i = 0; i < n - 1; i++) d.push((ys[i + 1] - ys[i]) / (xs[i + 1] - xs[i]));
  m[0] = d[0];
  m[n - 1] = d[n - 2];
  for (let i = 1; i < n - 1; i++) m[i] = d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2;
  for (let i = 0; i < n - 1; i++) {
    if (!d[i]) {
      m[i] = m[i + 1] = 0;
      continue;
    }
    const a = m[i] / d[i], b = m[i + 1] / d[i], h = a * a + b * b;
    if (h > 9) {
      const t = 3 / Math.sqrt(h);
      m[i] = t * a * d[i];
      m[i + 1] = t * b * d[i];
    }
  }
  return (x) => {
    if (x <= xs[0]) return ys[0];
    if (x >= xs[n - 1]) return ys[n - 1];
    let i = 0;
    while (x > xs[i + 1]) i++;
    const h = xs[i + 1] - xs[i], t = (x - xs[i]) / h, t2 = t * t, t3 = t2 * t;
    return (2 * t3 - 3 * t2 + 1) * ys[i] + (t3 - 2 * t2 + t) * h * m[i] + (-2 * t3 + 3 * t2) * ys[i + 1] + (t3 - t2) * h * m[i + 1];
  };
}

const clamp01 = (x) => Math.min(1, Math.max(0, x));
const luma = (c) => 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2];

function rgbToHsl([r, g, b]) {
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2;
  if (mx === mn) return [0, 0, l];
  const d = mx - mn, s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
  const h = mx === r ? (g - b) / d + (g < b ? 6 : 0) : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h * 60, s, l];
}

function hslToRgb([h, s, l]) {
  if (!s) return [l, l, l];
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q;
  const f = (t) => {
    t = ((t % 1) + 1) % 1;
    return t < 1 / 6 ? p + (q - p) * 6 * t : t < 0.5 ? q : t < 2 / 3 ? p + (q - p) * (2 / 3 - t) * 6 : p;
  };
  return [f(h / 360 + 1 / 3), f(h / 360), f(h / 360 - 1 / 3)];
}

// One recipe as a function of a colour.
function compile(recipe) {
  const steps = recipe.map((op) => {
    const [k, v] = Object.entries(op)[0];
    if (k === 'curve') {
      const f = curveFn(v);
      return (c) => c.map(f);
    }
    if (k === 'r' || k === 'g' || k === 'b') {
      const f = curveFn(v), ch = 'rgb'.indexOf(k);
      return (c) => c.map((x, i) => (i === ch ? f(x) : x));
    }
    if (k === 'mix') return (c) => v.map((row) => row[0] * c[0] + row[1] * c[1] + row[2] * c[2]);
    if (k === 'warm') return (c) => [c[0] * (1 + 0.09 * v), c[1], c[2] * (1 - 0.09 * v)];
    if (k === 'sat') return (c) => { const l = luma(c); return c.map((x) => l + (x - l) * v); };
    if (k === 'fade') return (c) => c.map((x) => x * (1 - 0.14 * v) + 0.07 * v);
    if (k === 'mono') return (c) => { const l = v[0] * c[0] + v[1] * c[1] + v[2] * c[2]; return [l, l, l]; };
    if (k === 'split') {
      const [sh, hi, amt] = v;
      return (c) => {
        const l = luma(c), ws = (1 - Math.min(1, l / 0.55)) ** 2, wh = Math.max(0, (l - 0.45) / 0.55) ** 2;
        return c.map((x, i) => x + ((sh[i] - 0.5) * ws + (hi[i] - 0.5) * wh) * amt);
      };
    }
    if (k === 'hue') {
      return (c) => {
        const hsl = rgbToHsl(c.map(clamp01));
        if (hsl[1] < 0.02) return c;
        let [h, s, l] = hsl;
        let dh = 0, ks = 1, dl = 0;
        for (const [centre, width, shift, sat, light] of v) {
          const dist = Math.abs(((h - centre + 540) % 360) - 180);
          if (dist >= width) continue;
          const w = (1 - dist / width) ** 2 * Math.min(1, s * 3);
          dh += shift * w;
          ks *= 1 + (sat - 1) * w;
          dl += (light || 0) * w;
        }
        return hslToRgb([(h + dh + 360) % 360, clamp01(s * ks), clamp01(l + dl)]);
      };
    }
    throw new Error(`Unknown colour step ${k}`);
  });
  return (c) => steps.reduce((x, f) => f(x).map(clamp01), c);
}

const cache = new Map();

// RGBA bytes for a (33 × 33) × 33 texture.
export function buildLut(id, recipe) {
  if (cache.has(id)) return cache.get(id);
  const f = compile(recipe), N = LUT_N, out = new Uint8Array(N * N * N * 4);
  for (let b = 0; b < N; b++) {
    for (let g = 0; g < N; g++) {
      for (let r = 0; r < N; r++) {
        const c = f([r / (N - 1), g / (N - 1), b / (N - 1)]);
        const i = (g * N * N + b * N + r) * 4;
        out[i] = Math.round(c[0] * 255);
        out[i + 1] = Math.round(c[1] * 255);
        out[i + 2] = Math.round(c[2] * 255);
        out[i + 3] = 255;
      }
    }
  }
  cache.set(id, out);
  return out;
}
