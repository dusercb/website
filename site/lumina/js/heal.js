// Blemish removal. A spot is replaced by a nearby patch of skin whose rim best matches the
// spot's surroundings; a plane fitted to the colour difference around the rim corrects shading
// so the patch lands without a seam. Auto mode finds dark or red bumps on the skin with a
// difference-of-blurs detector, at a scale normalised to the face width. The Clone Stamp at the
// end copies from a source point the person picks instead.

import { blurFloat } from './blur.js';

// Heals the spot at (x, y) with radius r, modifying `img` (ImageData) in place.
// `source` replays a previous edit exactly; otherwise `ok(x, y)` says where patches may come from.
// With `lighten` (automatic spots, which are always darker or redder than the skin) the patch keeps
// its colour but never ends darker than what it covers, as AirBrush's spot repair does, so a dark
// texture copied in can't leave a new mark. Returns the source centre used, or null.
export function healSpot(img, x, y, r, source, ok, lighten = false) {
  x = Math.round(x);
  y = Math.round(y);
  const R = Math.max(2, r);
  const src = source || findSource(img, x, y, R, ok) || findSource(img, x, y, R, null);
  if (!src) return null;
  applyPatch(img, x, y, src[0], src[1], R, lighten);
  return src;
}

function sample(img, x, y) {
  const { width: W, height: H, data } = img;
  const i = (Math.min(H - 1, Math.max(0, Math.round(y))) * W + Math.min(W - 1, Math.max(0, Math.round(x)))) * 4;
  return [data[i], data[i + 1], data[i + 2]];
}

const sq = (a, b) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;

function circle(n, r) {
  const pts = [];
  for (let k = 0; k < n; k++) {
    const a = (k / n) * Math.PI * 2;
    pts.push([Math.cos(a) * r, Math.sin(a) * r]);
  }
  return pts;
}

function findSource(img, x, y, R, ok) {
  const { width: W, height: H } = img;
  const ring = circle(24, R * 1.3);
  const inner = [[0, 0], ...circle(12, R * 0.6)];
  const dest = ring.map(([u, v]) => sample(img, x + u, y + v));
  const margin = R * 1.5;
  let best = null, bestCost = Infinity;
  for (const reach of [2.8, 3.6]) {
    for (const [cu, cv] of circle(16, R * reach)) {
      const sx = Math.round(x + cu), sy = Math.round(y + cv);
      if (sx < margin || sy < margin || sx > W - 1 - margin || sy > H - 1 - margin) continue;
      if (ok && !ok(sx, sy)) continue;
      let cost = 0;
      ring.forEach(([u, v], i) => { cost += sq(sample(img, sx + u, sy + v), dest[i]); });
      // Prefer smooth patches: copying a spot onto a spot does not help.
      const vals = inner.map(([u, v]) => sample(img, sx + u, sy + v));
      const mean = [0, 1, 2].map((c) => vals.reduce((s, p) => s + p[c], 0) / vals.length);
      const spread = vals.reduce((s, p) => s + sq(p, mean), 0) / vals.length;
      cost = (cost / ring.length + 2 * spread) * (reach > 3 ? 1.15 : 1);
      if (cost < bestCost) {
        bestCost = cost;
        best = [sx, sy];
      }
    }
  }
  return best;
}

// Colour-correction plane d(u, v) = a + b·u + c·v fitted to the rim difference between the spot
// and the source patch. The rim samples that disagree most (an eyelash or hair crossing the rim)
// are dropped first, so they cannot darken the whole patch.
function fitCorrection(img, x, y, sx, sy, Rc) {
  const lum = (d) => 0.299 * d[0] + 0.587 * d[1] + 0.114 * d[2];
  const rim = circle(32, 1).map(([u, v]) => {
    const d = sample(img, x + u * Rc, y + v * Rc), s = sample(img, sx + u * Rc, sy + v * Rc);
    return { u, v, d: [d[0] - s[0], d[1] - s[1], d[2] - s[2]] };
  });
  const med = rim.map((q) => lum(q.d)).sort((a, b) => a - b)[rim.length >> 1];
  const dev = (q) => Math.abs(lum(q.d) - med);
  const cutoff = rim.map(dev).sort((a, b) => a - b)[Math.floor(rim.length * 0.65)];
  const kept = rim.filter((q) => dev(q) <= cutoff);
  // Normal equations for basis [1, u, v], solved with Cramer's rule.
  const A = [[0, 0, 0], [0, 0, 0], [0, 0, 0]], B = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (const q of kept) {
    const f = [1, q.u, q.v];
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) A[i][j] += f[i] * f[j];
      for (let c = 0; c < 3; c++) B[c][i] += f[i] * q.d[c];
    }
  }
  const det3 = (m) =>
    m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) -
    m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) +
    m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
  const D = det3(A);
  return B.map((b) => {
    if (Math.abs(D) < 1e-6) return [b[0] / Math.max(kept.length, 1), 0, 0];
    const sol = [0, 1, 2].map((k) => det3(A.map((row, i) => row.map((v, j) => (j === k ? b[i] : v)))) / D);
    return [sol[0], Math.max(-40, Math.min(40, sol[1])), Math.max(-40, Math.min(40, sol[2]))];
  });
}

function applyPatch(img, x, y, sx, sy, R, lighten) {
  const { width: W, height: H, data } = img;
  const Ro = R * 1.35, Rc = R * 1.3;
  const coef = fitCorrection(img, x, y, sx, sy, Rc);
  const x0 = Math.max(0, Math.floor(x - Ro)), x1 = Math.min(W - 1, Math.ceil(x + Ro));
  const y0 = Math.max(0, Math.floor(y - Ro)), y1 = Math.min(H - 1, Math.ceil(y + Ro));
  const bw = x1 - x0 + 1;
  // Snapshot the source block first: source and destination may overlap slightly.
  const block = new Float32Array(bw * (y1 - y0 + 1) * 3);
  for (let py = y0; py <= y1; py++) {
    for (let px = x0; px <= x1; px++) {
      const s = sample(img, px + sx - x, py + sy - y);
      const k = ((py - y0) * bw + (px - x0)) * 3;
      block[k] = s[0];
      block[k + 1] = s[1];
      block[k + 2] = s[2];
    }
  }
  for (let py = y0; py <= y1; py++) {
    for (let px = x0; px <= x1; px++) {
      const u = px - x, v = py - y;
      const d = Math.hypot(u, v);
      if (d > Ro) continue;
      const t = Math.min(1, Math.max(0, (Ro - d) / (Ro - R * 0.55)));
      const a = t * t * (3 - 2 * t);
      const i = (py * W + px) * 4, k = ((py - y0) * bw + (px - x0)) * 3;
      const out = [0, 1, 2].map((c) => block[k + c] + coef[c][0] + coef[c][1] * (u / Rc) + coef[c][2] * (v / Rc));
      if (lighten) {
        const lo = 0.299 * out[0] + 0.587 * out[1] + 0.114 * out[2], ld = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
        if (lo < ld) for (let c = 0; c < 3; c++) out[c] *= ld / Math.max(lo, 1);
      }
      for (let c = 0; c < 3; c++) data[i + c] = data[i + c] + (out[c] - data[i + c]) * a;
    }
  }
}

// Likely blemishes on one face: [{x, y, r}] in image pixels, strongest first.
// `mask` is the strict spot mask (mw × mh, 8-bit) that excludes features, nostrils and edges.
export function findSpots(img, face, mask, mw, mh, limit = 40) {
  const { width: W, height: H, data } = img;
  const s = Math.min(1, 360 / face.fw);
  const x0 = Math.max(0, Math.floor(face.box[0])), y0 = Math.max(0, Math.floor(face.box[1]));
  const x1 = Math.min(W - 1, Math.ceil(face.box[2])), y1 = Math.min(H - 1, Math.ceil(face.box[3]));
  const w = Math.max(16, Math.round((x1 - x0) * s)), h = Math.max(16, Math.round((y1 - y0) * s));
  const Y = new Float32Array(w * h), Cr = new Float32Array(w * h), M = new Float32Array(w * h);
  const step = Math.max(1, Math.round(1 / s));
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      const cx = x0 + i / s, cy = y0 + j / s;
      let ys = 0, crs = 0, n = 0;
      for (let dy = 0; dy < step; dy++) {
        for (let dx = 0; dx < step; dx++) {
          const px = Math.min(W - 1, Math.round(cx + dx)), py = Math.min(H - 1, Math.round(cy + dy));
          const k = (py * W + px) * 4;
          const r = data[k] / 255, g = data[k + 1] / 255, b = data[k + 2] / 255;
          const yy = 0.299 * r + 0.587 * g + 0.114 * b;
          ys += yy;
          crs += (r - yy) * 0.713;
          n++;
        }
      }
      const k = j * w + i;
      Y[k] = ys / n;
      Cr[k] = crs / n;
      const mx = Math.min(mw - 1, Math.round(((cx + step / 2) * mw) / W)), my = Math.min(mh - 1, Math.round(((cy + step / 2) * mh) / H));
      M[k] = mask[my * mw + mx] / 255;
    }
  }
  const Ys = blurFloat(Float32Array.from(Y), w, h, 1, 2);
  const Yl = blurFloat(Float32Array.from(Y), w, h, 6, 3);
  const Cs = blurFloat(Float32Array.from(Cr), w, h, 1, 2);
  const Cl = blurFloat(Float32Array.from(Cr), w, h, 6, 3);
  const score = new Float32Array(w * h);
  let sum = 0, sum2 = 0, n = 0;
  for (let k = 0; k < w * h; k++) {
    if (M[k] < 0.75) continue;
    const v = Yl[k] - Ys[k] + 0.9 * Math.max(0, Cs[k] - Cl[k]);
    score[k] = v;
    sum += v;
    sum2 += v * v;
    n++;
  }
  if (n < 200) return [];
  const mean = sum / n, sd = Math.sqrt(Math.max(sum2 / n - mean * mean, 1e-8));
  const T = Math.max(0.028, mean + 3 * sd);
  const cands = [];
  for (let j = 3; j < h - 3; j++) {
    for (let i = 3; i < w - 3; i++) {
      const v = score[j * w + i];
      if (v < T) continue;
      let peak = true;
      for (let dj = -2; dj <= 2 && peak; dj++) {
        for (let di = -2; di <= 2; di++) {
          if ((di || dj) && score[(j + dj) * w + i + di] > v) { peak = false; break; }
        }
      }
      if (peak) cands.push({ i, j, v });
    }
  }
  cands.sort((a, b) => b.v - a.v);
  const spots = [];
  for (const c of cands) {
    // A mark that is darker but hardly redder than the skin round it (a mole, a freckle) is left
    // alone, as AirBrush's mole detector leaves moles; a tap still heals one.
    const k = c.j * w + c.i, dark = Yl[k] - Ys[k];
    if (dark > 0.04 && Math.max(0, Cs[k] - Cl[k]) < 0.3 * dark) continue;
    // Extent along four axes (each the sum of two opposite directions). Blemishes are round;
    // wrinkles and creases are long, so skip anything much longer than it is wide.
    const reach = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]].map(([dx, dy]) => {
      let r = 1;
      while (r < 10) {
        const ii = c.i + dx * r, jj = c.j + dy * r;
        if (ii < 0 || jj < 0 || ii >= w || jj >= h || score[jj * w + ii] < T * 0.4) break;
        r++;
      }
      return r * (dx && dy ? Math.SQRT2 : 1);
    });
    const axes = [reach[0] + reach[1], reach[2] + reach[3], reach[4] + reach[5], reach[6] + reach[7]];
    if (Math.max(...axes) > 2.2 * Math.min(...axes)) continue;
    const rsum = reach.reduce((a, b) => a + b, 0);
    const x = x0 + (c.i + 0.5) / s, y = y0 + (c.j + 0.5) / s, r = (rsum / 8 + 1.2) / s;
    if (spots.some((p) => Math.hypot(p.x - x, p.y - y) < (p.r + r) * 0.9)) continue;
    spots.push({ x, y, r });
    if (spots.length >= limit) break;
  }
  return spots;
}

// ---------- Clone Stamp ----------

// Copies a soft disc from (x + dx, y + dy) of `snap` (the photo as it was before the stroke, so a
// stroke never copies its own paint) onto (x, y). Returns the changed rectangle.
// f, Stamp's Feather (0 hard … 1 soft), sets where the dab starts to fade; 0.4 is the original edge.
export const STAMP_FEATHER = 0.4;
function cloneDab(img, snap, x, y, r, dx, dy, f = STAMP_FEATHER) {
  const { width: W, height: H, data } = img;
  const core = 0.85 - 0.75 * f;
  const x0 = Math.max(0, Math.floor(x - r)), x1 = Math.min(W - 1, Math.ceil(x + r));
  const y0 = Math.max(0, Math.floor(y - r)), y1 = Math.min(H - 1, Math.ceil(y + r));
  for (let py = y0; py <= y1; py++) {
    for (let px = x0; px <= x1; px++) {
      const d = Math.hypot(px - x, py - y) / r;
      if (d >= 1) continue;
      const t = Math.max(0, (d - core) / (1 - core));
      const w = 0.85 * (1 - t * t * (3 - 2 * t));
      const sx = Math.round(px + dx), sy = Math.round(py + dy);
      if (sx < 0 || sy < 0 || sx >= W || sy >= H) continue;
      const i = (py * W + px) * 4, j = (sy * W + sx) * 4;
      for (let c = 0; c < 3; c++) data[i + c] += (snap[j + c] - data[i + c]) * w;
    }
  }
  return [x0, y0, x1, y1];
}

// A stroke { r, p: [x0, y0, …], dx, dy, f } painted dab by dab: begin() then extend() per point, the
// same live and when replayed, so undo and redo reproduce it exactly. Each call returns the
// rectangle it changed as [x, y, w, h].
export function cloneBegin(img, s) {
  const st = { snap: new Uint8ClampedArray(img.data), x: s.p[0], y: s.p[1] };
  return { st, rect: rectOf([cloneDab(img, st.snap, st.x, st.y, s.r, s.dx, s.dy, s.f)]) };
}

export function cloneExtend(img, s, st, x, y) {
  const step = Math.max(1, s.r * 0.25);
  const n = Math.floor(Math.hypot(x - st.x, y - st.y) / step);
  if (!n) return null;
  const rects = [];
  for (let k = 1; k <= n; k++) rects.push(cloneDab(img, st.snap, st.x + ((x - st.x) * k) / n, st.y + ((y - st.y) * k) / n, s.r, s.dx, s.dy, s.f));
  st.x = x;
  st.y = y;
  return rectOf(rects);
}

export function cloneStroke(img, s) {
  const { st } = cloneBegin(img, s);
  for (let i = 2; i < s.p.length; i += 2) cloneExtend(img, s, st, s.p[i], s.p[i + 1]);
}

function rectOf(rs) {
  const x0 = Math.min(...rs.map((r) => r[0])), y0 = Math.min(...rs.map((r) => r[1]));
  const x1 = Math.max(...rs.map((r) => r[2])), y1 = Math.max(...rs.map((r) => r[3]));
  return [x0, y0, x1 - x0 + 1, y1 - y0 + 1];
}
