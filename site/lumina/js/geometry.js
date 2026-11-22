// Crop, straighten, perspective and lens correction. Nothing is resampled until export: the
// final shader maps each output pixel back to the photo through one homography (rotation by
// quarter turns, flips, perspective, straighten and the zoom that keeps the corners filled)
// after undoing radial lens distortion. Tools keep working in photo pixels; touches are mapped
// back through the same function.
//
// State: { rot (quarter turns clockwise), flipH, flipV, angle (degrees), persV, persH, lens (−1…1),
//          rect: [x, y, w, h] of the frame kept, aspect }
// Stretch (Body › Stretch) lengthens one horizontal band of the frame, so the picture gets taller:
// { amt 0…1, y0, y1 } with the band in 0–1 of the frame's height.

export const NO_CROP = { rot: 0, flipH: false, flipV: false, angle: 0, persV: 0, persH: 0, lens: 0, rect: [0, 0, 1, 1], aspect: 'free' };

export const ASPECTS = [
  { id: 'free', name: 'Free' }, { id: 'original', name: 'Original' }, { id: '1:1', name: '1:1' }, { id: '4:5', name: '4:5' },
  { id: '3:4', name: '3:4' }, { id: '2:3', name: '2:3' }, { id: '9:16', name: '9:16' }, { id: '16:9', name: '16:9' },
  { id: '3:2', name: '3:2' }, { id: '4:3', name: '4:3' },
];

export const isIdentity = (g) => !g || (!g.rot && !g.flipH && !g.flipV && !g.angle && !g.persV && !g.persH && !g.lens &&
  g.rect[0] === 0 && g.rect[1] === 0 && g.rect[2] === 1 && g.rect[3] === 1);

// The rotated frame before cropping, in pixels.
export const frameSize = (g, W, H) => (g.rot % 2 ? [H, W] : [W, H]);

const mul = (a, b) => {
  const r = new Array(9).fill(0);
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) for (let k = 0; k < 3; k++) r[i * 3 + j] += a[i * 3 + k] * b[k * 3 + j];
  return r;
};

function invert(m) {
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
  const det = a * A + b * B + c * C || 1e-12;
  return [A, -(b * i - c * h), b * f - c * e, B, a * i - c * g, -(a * f - c * d), C, -(a * h - b * g), a * e - b * d].map((v) => v / det);
}

const apply = (m, x, y) => {
  const X = m[0] * x + m[1] * y + m[2], Y = m[3] * x + m[4] * y + m[5], Z = m[6] * x + m[7] * y + m[8];
  return [X / Z, Y / Z];
};

// Row-major matrix taking centred frame pixels (after lens correction) to centred photo pixels.
function matrix(g, Wf, Hf, zoom) {
  const t = (-g.angle * Math.PI) / 180;
  const R = [Math.cos(t), -Math.sin(t), 0, Math.sin(t), Math.cos(t), 0, 0, 0, 1];
  const S = [1 / zoom, 0, 0, 0, 1 / zoom, 0, 0, 0, 1];
  const P = [1, 0, 0, 0, 1, 0, (g.persH * 0.35) / (Wf / 2), (g.persV * 0.35) / (Hf / 2), 1];
  // Frame → photo orientation: undo the flips, then the quarter turns.
  const F = [g.flipH ? -1 : 1, 0, 0, 0, g.flipV ? -1 : 1, 0, 0, 0, 1];
  const turns = ((g.rot % 4) + 4) % 4;
  const Q = [[1, 0, 0, 1], [0, 1, -1, 0], [-1, 0, 0, -1], [0, -1, 1, 0]][turns];
  const A = [Q[0], Q[1], 0, Q[2], Q[3], 0, 0, 0, 1];
  return mul(A, mul(F, mul(P, mul(S, R))));
}

function lensOut(f, k, half) {
  const rn = Math.hypot(f[0], f[1]) / half;
  const s = 1 + k * rn * rn;
  return [f[0] * s, f[1] * s];
}

// Everything the shader and the touch mapping need. full: the whole frame (while cropping).
export function geometry(g, W, H, { full = false, text = false, stretch = null } = {}) {
  g = g || NO_CROP;
  const [Wf, Hf] = frameSize(g, W, H);
  const s = stretch && stretch.amt > 0 ? 1 + stretch.amt * 0.35 : 1;
  const y0 = s > 1 ? stretch.y0 * Hf : 0, band = s > 1 ? Math.max(0, stretch.y1 - stretch.y0) * Hf : 0;
  const Hs = Hf + band * (s - 1);
  const half = 0.5 * Math.hypot(Wf, Hf);
  const lens = g.lens * 0.25;
  // The smallest zoom that keeps every edge of the frame inside the photo.
  const probe = [];
  for (const u of [-0.5, 0, 0.5]) for (const v of [-0.5, 0, 0.5]) if (u || v) probe.push([u * Wf, v * Hf]);
  const inside = (z) => {
    const m = matrix(g, Wf, Hf, z);
    return probe.every((p) => {
      const [x, y] = apply(m, ...lensOut(p, lens, half));
      return Math.abs(x) <= W / 2 + 0.5 && Math.abs(y) <= H / 2 + 0.5;
    });
  };
  let lo = 1, hi = 1;
  if (!inside(1)) {
    hi = 1.25;
    while (!inside(hi) && hi < 8) hi *= 1.25;
    for (let i = 0; i < 24; i++) {
      const mid = (lo + hi) / 2;
      if (inside(mid)) hi = mid;
      else lo = mid;
    }
  }
  const zoom = hi;
  const m = matrix(g, Wf, Hf, zoom);
  const crop = full ? [0, 0, 1, 1] : g.rect;
  const out = [Math.max(1, Math.round(crop[2] * Wf)), Math.max(1, Math.round(crop[3] * Hs))];
  // Column-major for uniformMatrix3fv.
  const colMajor = new Float32Array([m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]]);
  return { m: colMajor, rows: m, inv: invert(m), crop, frame: [Wf, Hf], st: [y0, band, s, Hs], lens, half, out, W, H, text };
}

// Stretched frame y → frame y, and back.
function unstretch(st, y) {
  const [y0, band, s] = st;
  if (s <= 1 || y <= y0) return y;
  return y < y0 + band * s ? y0 + (y - y0) / s : y - band * (s - 1);
}
function restretch(st, y) {
  const [y0, band, s] = st;
  if (s <= 1 || y <= y0) return y;
  return y < y0 + band ? y0 + (y - y0) * s : y + band * (s - 1);
}

// Output pixel → photo pixel.
export function toSource(geo, ox, oy) {
  const [Wf, Hf] = geo.frame, c = geo.crop;
  const fy = unstretch(geo.st, (c[1] + (oy / geo.out[1]) * c[3]) * geo.st[3]);
  const f = [(c[0] + (ox / geo.out[0]) * c[2] - 0.5) * Wf, fy - Hf / 2];
  const [x, y] = apply(geo.rows, ...lensOut(f, geo.lens, geo.half));
  return [x + geo.W / 2, y + geo.H / 2];
}

// Photo pixel → output pixel (the lens step is undone by a few fixed-point iterations).
export function toOutput(geo, sx, sy) {
  const [Wf, Hf] = geo.frame, c = geo.crop;
  const g = apply(geo.inv, sx - geo.W / 2, sy - geo.H / 2);
  let f = g;
  for (let i = 0; i < 8; i++) {
    const rn = Math.hypot(f[0], f[1]) / geo.half;
    const s = 1 + geo.lens * rn * rn;
    f = [g[0] / s, g[1] / s];
  }
  const ys = restretch(geo.st, f[1] + Hf / 2) / geo.st[3];
  return [((f[0] / Wf + 0.5 - c[0]) / c[2]) * geo.out[0], ((ys - c[1]) / c[3]) * geo.out[1]];
}

// Frame y (0–1, before stretching) of a photo point: where Stretch's band lines sit.
export function frameY(geo, sx, sy) {
  const [, Hf] = geo.frame;
  const g = apply(geo.inv, sx - geo.W / 2, sy - geo.H / 2);
  return (g[1] + Hf / 2) / Hf;
}

// How many photo pixels one output pixel covers (for brush sizes on screen).
export function sourceScale(geo) {
  const a = toSource(geo, geo.out[0] / 2, geo.out[1] / 2), b = toSource(geo, geo.out[0] / 2 + 10, geo.out[1] / 2);
  return Math.hypot(b[0] - a[0], b[1] - a[1]) / 10;
}

// The largest centred rect of an aspect ratio inside the frame (frame units).
export function aspectRect(aspect, Wf, Hf, W, H) {
  if (aspect === 'free') return [0, 0, 1, 1];
  const [a, b] = aspect === 'original' ? [W, H] : aspect.split(':').map(Number);
  const want = a / b;
  let w = 1, h = (Wf / want) / Hf;
  if (h > 1) {
    h = 1;
    w = (Hf * want) / Wf;
  }
  return [(1 - w) / 2, (1 - h) / 2, w, h];
}
