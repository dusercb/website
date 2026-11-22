// Relight: lighting computed on the phone. A rough 3D shape of the subject (the silhouette
// inflated into a rounded body, a dome for the head and the face mesh's own depth) gives surface
// normals, and each preset lights them softly, in linear light and relative to what a surface
// facing the camera already gets, with gentle limits so a face never splits into a hard lit half
// and a dark half. Presets follow AirBrush's Relight list (evidence/README.md §5); the looks are ours.

import { blurFloat } from './blur.js';
import { TRIANGLES } from './facemesh-data.js';

// lights: up to two { dir: [x right, y down, z toward the camera] (null: Custom's light, which
//   you drag), col: colour, i: strength }.
// wrap: how far light wraps round the form (soft) · fill: light already in the photo, which keeps
//   shadows open (fillCol tints it) · exp, bg: subject and background exposure in stops ·
// grad: how much the background brightens toward the light · spill: how much the lights' colours
//   wash the background · tint, tintAmt: background colour · rim: extra edge light · sheen: soft
//   skin highlight · lift: opens shadows already in the photo · haze: glow from the light ·
// rays, water: light patterns · catch: eye catchlight ('ring' or 'dot') · grade: colour tweaks
//   (see gradeUniforms in main.js) · leak: film light leak · sat: how strongly the subject takes
//   the lights' colour (1 = fully).
export const RELIGHT_PRESETS = [
  { id: 'none', name: 'Off', group: 'studio' },
  {
    id: 'custom', name: 'Custom', group: 'studio', lights: [{ dir: null, col: [1, 0.98, 0.95], i: 1 }],
    wrap: 0.5, fill: 0.55, exp: 0.12, bg: -0.25, grad: 0.5, sheen: 0.12, lift: 0.15, catch: 'dot',
  },
  {
    id: 'studio1', name: 'Studio 1', group: 'studio', lights: [{ dir: [0, -0.12, 1], col: [1, 1, 1], i: 1 }],
    wrap: 0.45, fill: 0.5, exp: 0.3, bg: -0.35, grad: 0, sheen: 0.1, lift: 0.4, catch: 'ring', grade: { vibrance: 0.08 },
  },
  {
    id: 'studio2', name: 'Studio 2', group: 'studio', lights: [{ dir: [-0.72, -0.55, 0.45], col: [1, 0.97, 0.92], i: 1 }],
    wrap: 0.3, fill: 0.36, exp: 0.12, bg: -0.55, grad: 0.6, sheen: 0.12, lift: 0.1, catch: 'dot',
  },
  {
    id: 'studio3', name: 'Studio 3', group: 'studio', lights: [{ dir: [0, -0.82, 0.58], col: [1, 1, 1], i: 1 }],
    wrap: 0.4, fill: 0.45, exp: 0.15, bg: -0.35, grad: 0.3, sheen: 0.15, lift: 0.15, catch: 'dot',
  },
  {
    id: 'side', name: 'Sidelight', group: 'studio', lights: [{ dir: [-1, -0.12, 0.2], col: [1, 0.97, 0.93], i: 1 }],
    wrap: 0.25, fill: 0.3, exp: 0.05, bg: -0.6, grad: 0.8, rim: 0.15, sheen: 0.08,
  },
  {
    id: 'back', name: 'Backlight', group: 'studio', lights: [{ dir: [0.3, -0.55, -0.78], col: [1, 0.88, 0.7], i: 1.3 }],
    wrap: 0.1, fill: 0.7, exp: -0.25, bg: 0.6, grad: 0.4, tint: [1, 0.92, 0.8], tintAmt: 0.35, rim: 0.9, lift: 0.3, haze: 0.6,
    grade: { contrast: -0.08 },
  },
  {
    id: 'flash', name: 'Flash', group: 'studio', lights: [{ dir: [0, -0.05, 1], col: [0.97, 0.99, 1], i: 1 }],
    wrap: 0.05, fill: 0.55, exp: 0.4, bg: -0.75, sheen: 0.25, lift: 0.3,
    grade: { contrast: 0.12, vibrance: 0.12, vignette: 0.25, temperature: -0.05 },
  },
  { id: 'deglare', name: 'DeGlare', group: 'studio', deglare: 1 },
  {
    id: 'neon', name: 'Neon', group: 'studio',
    lights: [{ dir: [-0.85, -0.25, 0.45], col: [1, 0.42, 0.85], i: 1 }, { dir: [0.9, -0.15, 0.4], col: [0.4, 0.55, 1], i: 0.5 }],
    wrap: 0.45, fill: 0.45, exp: -0.05, bg: -1.1, grad: 0.3, spill: 0.55, tint: [0.45, 0.3, 0.8], tintAmt: 0.3, rim: 0.35, sat: 0.7,
    grade: { contrast: 0.08 },
  },
  {
    id: 'techni', name: 'Technicolor', group: 'studio',
    lights: [{ dir: [-0.9, -0.2, 0.4], col: [1, 0.36, 0.5], i: 0.9 }, { dir: [0.9, -0.2, 0.4], col: [0.32, 0.8, 1], i: 0.9 }],
    wrap: 0.45, fill: 0.42, exp: -0.05, bg: -1.1, grad: 0.2, spill: 0.6, rim: 0.35, sat: 0.7,
  },
  {
    id: 'sunlit', name: 'Sunlit', group: 'scene', lights: [{ dir: [0.65, -0.55, 0.5], col: [1, 0.82, 0.58], i: 1.15 }],
    wrap: 0.4, fill: 0.5, fillCol: [1, 0.95, 0.88], exp: 0.15, bg: 0.15, grad: 0.5, tint: [1, 0.9, 0.75], tintAmt: 0.3,
    haze: 0.3, rays: 0.3, sheen: 0.12, grade: { temperature: 0.12 },
  },
  {
    id: 'beach', name: 'Beach Day', group: 'scene', lights: [{ dir: [0.2, -0.75, 0.6], col: [1, 0.97, 0.9], i: 0.9 }],
    wrap: 0.7, fill: 0.75, exp: 0.3, bg: 0.3, grad: 0.2, tint: [0.92, 1, 1.04], tintAmt: 0.4, lift: 0.35, haze: 0.15,
    grade: { vibrance: 0.25, temperature: 0.06 },
  },
  {
    id: 'indigo', name: 'Indigo', group: 'scene', lights: [{ dir: [-0.6, -0.35, 0.7], col: [0.55, 0.62, 1], i: 1 }],
    wrap: 0.45, fill: 0.5, exp: -0.1, bg: -0.7, grad: 0.4, spill: 0.5, tint: [0.45, 0.5, 1], tintAmt: 0.6, rim: 0.25, sat: 0.55,
    grade: { temperature: -0.1, contrast: 0.06 },
  },
  {
    id: 'softbox', name: 'Soft Box', group: 'scene',
    lights: [{ dir: [-0.55, -0.35, 0.76], col: [1, 0.99, 0.97], i: 1 }, { dir: [0.6, -0.1, 0.8], col: [1, 1, 1], i: 0.3 }],
    wrap: 0.85, fill: 0.55, exp: 0.2, bg: -0.25, grad: 0.3, sheen: 0.1, lift: 0.25, catch: 'dot',
  },
  {
    id: 'rays', name: 'Rays', group: 'scene', lights: [{ dir: [0.6, -0.65, 0.45], col: [1, 0.86, 0.62], i: 1.05 }],
    wrap: 0.35, fill: 0.45, exp: 0.05, bg: -0.15, grad: 0.5, tint: [1, 0.92, 0.8], tintAmt: 0.2, rays: 0.9, haze: 0.3,
    grade: { temperature: 0.08, contrast: 0.05 },
  },
  {
    id: 'water', name: 'Water', group: 'scene', lights: [{ dir: [0.15, -0.85, 0.5], col: [0.75, 0.95, 1], i: 0.9 }],
    wrap: 0.5, fill: 0.5, exp: 0, bg: -0.25, grad: 0.3, tint: [0.75, 0.95, 1], tintAmt: 0.45, water: 0.8,
    grade: { temperature: -0.12 },
  },
  {
    id: 'peel', name: 'Peel Film', group: 'scene', lights: [{ dir: [-0.5, -0.5, 0.7], col: [1, 0.93, 0.85], i: 1 }],
    wrap: 0.7, fill: 0.6, exp: 0.1, bg: 0, grad: 0.3, lift: 0.3, leak: 0.35,
    grade: { fade: 0.55, contrast: -0.12, saturation: -0.15, temperature: 0.08, grain: 0.25, vignette: 0.15 },
  },
];

const norm3 = (v) => { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; };
const norm2 = (v) => { const l = Math.hypot(v[0], v[1]) || 1; return [v[0] / l, v[1] / l]; };
const luma = (c) => 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2];
const linear = (c) => c.map((v) => Math.max(0, v) ** 2.2);
// A colour scaled to luminance 1, so a light's colour and its strength stay separate.
const unit = (c) => { const l = luma(c) || 1; return c.map((v) => v / l); };

function rgbToHsv([r, g, b]) {
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  let h = 0;
  if (d) h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [(h * 60 + 360) % 360, mx ? d / mx : 0, mx];
}

function hsvToRgb([h, s, v]) {
  const f = (n) => { const k = (n + h / 60) % 6; return v - v * s * Math.max(0, Math.min(k, 4 - k, 1)); };
  return [f(5), f(3), f(1)];
}

// Light colour after the Hue slider (−1…1): white lights warm (+) or cool (−); coloured lights rotate.
function hueShift(col, hue) {
  if (!hue) return col;
  const [h, s, v] = rgbToHsv(col);
  if (s < 0.15) return hsvToRgb([hue > 0 ? 32 : 215, Math.min(0.6, Math.abs(hue) * 0.6), v]);
  return hsvToRgb([(h + hue * 180 + 360) % 360, s, v]);
}

// The shader's wrapped Lambert with a smooth terminator (see relight() in gl.js).
function lightAt(n, L, wrap) {
  const w = Math.min(1, Math.max(0, (n[0] * L[0] + n[1] * L[1] + n[2] * L[2] + wrap) / (1 + wrap)));
  return w * w * (3 - 2 * w);
}

// Shader settings for the current relight state ({ preset, bright, hue, soft, dir }).
// W, H: photo size, for placing the light and the catchlights.
export function relightUniforms(r, faces, W = 1, H = 1) {
  const p = RELIGHT_PRESETS.find((x) => x.id === r.preset) || RELIGHT_PRESETS[0];
  const off = { uRelight: 0, uDeglare: 0, uLift: 0, uHaze: 0 };
  if (p.id === 'none' || !faces.length) return { u: off, grade: {}, leak: 0 };
  if (p.deglare) return { u: { ...off, uDeglare: Math.max(0, 1 + r.bright) }, grade: {}, leak: 0 };
  const soft = r.soft || 0;
  const wrap = Math.min(1.6, (p.wrap || 0) + soft * 0.8);
  const lights = p.lights.map((l) => {
    const d = l.dir || [r.dir[0], r.dir[1], Math.sqrt(Math.max(0.04, 1 - r.dir[0] ** 2 - r.dir[1] ** 2))];
    return { dir: norm3(d), col: unit(linear(hueShift(l.col, r.hue))).map((c) => c * l.i) };
  });
  const L1 = lights[1] || { dir: [0, 0, 1], col: [0, 0, 0] };
  const fill = (p.fill ?? 0.5) + soft * 0.3;
  const fillCol = unit(linear(p.fillCol || [1, 1, 1]));
  // Light reaching a surface that faces the camera: shading is measured against it.
  const front = [0, 0, 1];
  const ref = luma([0, 1, 2].map((k) => fill * fillCol[k] + lights.reduce((s, l) => s + l.col[k] * lightAt(front, l.dir, wrap), 0)));

  const f = faces[0];
  const aspect = W / H;
  const key = [f.center[0] / H, f.center[1] / H];            // subject centre; units of photo height
  const k0 = norm2([lights[0].dir[0], lights[0].dir[1]]);
  const lightPos = [key[0] + k0[0] * 0.8, key[1] + k0[1] * 0.8];
  const wash = (l) => unit(linear(hueShift(l, r.hue)));
  const eyes = [f.eyeR, f.eyeL];
  // No catchlight on a closed eye; it would sit on the lid.
  const irisR = eyes.map((e) => (e.h / e.w > 0.18 ? e.irisR : 0));
  return {
    u: {
      uRelight: 1,
      uDeglare: 0,
      uL0: lights[0].dir, uC0: lights[0].col, uL1: L1.dir, uC1: L1.col,
      uWrap: wrap,
      uFill: fill, uFillCol: fillCol, uRef: Math.max(1e-3, ref),
      uSubjExp: (p.exp || 0) + r.bright * 0.75,
      uBgExp: (p.bg || 0) + r.bright * 0.35,
      uBgGrad: p.grad || 0,
      uSpill: p.spill || 0,
      uWash0: wash(p.lights[0].col), uWash1: wash((p.lights[1] || p.lights[0]).col),
      uBgTint: p.tint ? wash(p.tint) : [1, 1, 1], uBgTintAmt: p.tintAmt || 0,
      uKeyDir: k0,
      uSideDir: lights[1] ? norm2([L1.dir[0] - lights[0].dir[0], L1.dir[1] - lights[0].dir[1]]) : [1, 0],
      uKeyC: key, uLightUv: lightPos, uAspect: aspect,
      uRim: p.rim || 0,
      uSheen: (p.sheen || 0) * (1 - soft * 0.6),
      uSat: p.sat ?? 1,
      uLift: p.lift || 0,
      uHaze: p.haze || 0,
      uRays: p.rays || 0,
      uWater: p.water || 0, uWaterScale: H / (f.fw * 0.3),
      uCatch: p.catch === 'ring' ? 1 : p.catch === 'dot' ? 2 : 0,
      uIris: [f.eyeR.iris[0], f.eyeR.iris[1], f.eyeL.iris[0], f.eyeL.iris[1]],
      uIrisR: irisR,
      uLidY: [f.P[159][1], f.P[386][1]],      // upper lids
    },
    grade: p.grade || {},
    leak: p.leak || 0,
  };
}

// Distance (in cells) from each inside cell to the nearest outside one. The frame's edge doesn't
// count as outside: a body cut off by the frame carries on past it.
function distanceInside(inside, w, h) {
  const d = new Float32Array(w * h);
  for (let i = 0; i < d.length; i++) d[i] = inside[i] ? 1e9 : 0;
  const D = Math.SQRT2;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!d[i]) continue;
      let v = d[i];
      if (x > 0) v = Math.min(v, d[i - 1] + 1);
      if (y > 0) {
        v = Math.min(v, d[i - w] + 1);
        if (x > 0) v = Math.min(v, d[i - w - 1] + D);
        if (x < w - 1) v = Math.min(v, d[i - w + 1] + D);
      }
      d[i] = v;
    }
  }
  for (let y = h - 1; y >= 0; y--) {
    for (let x = w - 1; x >= 0; x--) {
      const i = y * w + x;
      if (!d[i]) continue;
      let v = d[i];
      if (x < w - 1) v = Math.min(v, d[i + 1] + 1);
      if (y < h - 1) {
        v = Math.min(v, d[i + w] + 1);
        if (x < w - 1) v = Math.min(v, d[i + w + 1] + D);
        if (x > 0) v = Math.min(v, d[i + w - 1] + D);
      }
      d[i] = v;
    }
  }
  return d;
}

const OVAL = [10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288, 397, 365, 379, 378, 400, 377, 152, 148, 176, 149, 150, 136, 172, 58, 132, 93, 234, 127, 162, 21, 54, 103, 67, 109];

function insidePolygon(x, y, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

// The face mesh's own depth, drawn into cells: its triangles carry each landmark's depth
// (MediaPipe z, in photo pixels), and the holes at the eyes and mouth are filled from around them.
// Returns { h, cover } (h valid where cover is 1).
function faceDepth(f, nw, nh, cw, ch) {
  const h = new Float32Array(nw * nh).fill(-1e9), cover = new Float32Array(nw * nh);
  const px = (i) => [f.P[i][0] / cw - 0.5, f.P[i][1] / ch - 0.5];
  for (let t = 0; t < TRIANGLES.length; t += 3) {
    const ia = TRIANGLES[t], ib = TRIANGLES[t + 1], ic = TRIANGLES[t + 2];
    const [ax, ay] = px(ia), [bx, by] = px(ib), [cx, cy] = px(ic);
    const det = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
    if (Math.abs(det) < 1e-9) continue;
    const x0 = Math.max(0, Math.floor(Math.min(ax, bx, cx))), x1 = Math.min(nw - 1, Math.ceil(Math.max(ax, bx, cx)));
    const y0 = Math.max(0, Math.floor(Math.min(ay, by, cy))), y1 = Math.min(nh - 1, Math.ceil(Math.max(ay, by, cy)));
    const za = -f.Z[ia], zb = -f.Z[ib], zc = -f.Z[ic];
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const w0 = ((by - cy) * (x - cx) + (cx - bx) * (y - cy)) / det;
        const w1 = ((cy - ay) * (x - cx) + (ax - cx) * (y - cy)) / det;
        const w2 = 1 - w0 - w1;
        if (w0 < -1e-4 || w1 < -1e-4 || w2 < -1e-4) continue;
        const j = y * nw + x, z = w0 * za + w1 * zb + w2 * zc;
        if (z > h[j]) h[j] = z;
        cover[j] = 1;
      }
    }
  }
  // Fill the eye and mouth holes (inside the face's outline, not covered) by normalised blur.
  const poly = OVAL.map(px);
  const xs = poly.map((p) => p[0]), ys = poly.map((p) => p[1]);
  const bx0 = Math.max(0, Math.floor(Math.min(...xs))), bx1 = Math.min(nw - 1, Math.ceil(Math.max(...xs)));
  const by0 = Math.max(0, Math.floor(Math.min(...ys))), by1 = Math.min(nh - 1, Math.ceil(Math.max(...ys)));
  const num = new Float32Array(nw * nh), den = new Float32Array(nw * nh);
  for (let j = 0; j < num.length; j++) if (cover[j]) { num[j] = h[j]; den[j] = 1; }
  const r = Math.max(1, Math.round((f.fw * 0.06) / cw));
  blurFloat(num, nw, nh, r, 2);
  blurFloat(den, nw, nh, r, 2);
  for (let y = by0; y <= by1; y++) {
    for (let x = bx0; x <= bx1; x++) {
      const j = y * nw + x;
      if (!cover[j] && den[j] > 0.02 && insidePolygon(x, y, poly)) {
        h[j] = num[j] / den[j];
        cover[j] = 1;
      }
    }
  }
  return { h, cover };
}

// Normal map at 1/6 of the photo: rgb = surface normal, a = how much is face (0–1).
// person: subject alpha at pw × ph (or null).
export function buildNormalMap(faces, W, H, person, pw, ph) {
  const nw = Math.max(24, Math.round(W / 6)), nh = Math.max(24, Math.round(H / 6));
  const cw = W / nw, ch = H / nh;
  const height = new Float32Array(nw * nh);
  const face = new Float32Array(nw * nh);
  const small = Math.min(nw, nh);

  // Body: the silhouette inflated, round at its edges (a quarter circle over about a tenth of the
  // frame) and gently domed across, so light falls off over the whole body, not in a band.
  if (person) {
    const m = new Float32Array(nw * nh), inside = new Uint8Array(nw * nh);
    for (let y = 0; y < nh; y++) {
      for (let x = 0; x < nw; x++) {
        const sx = Math.min(pw - 1, Math.floor(((x + 0.5) / nw) * pw)), sy = Math.min(ph - 1, Math.floor(((y + 0.5) / nh) * ph));
        const j = y * nw + x;
        m[j] = person[sy * pw + sx] / 255;
        inside[j] = m[j] > 0.5 ? 1 : 0;
      }
    }
    const d = distanceInside(inside, nw, nh);
    const R = Math.max(3, small * 0.11);
    const broadR = Math.max(4, Math.round(small * 0.22));
    const broad = blurFloat(Float32Array.from(m), nw, nh, broadR, 3);
    for (let i = 0; i < height.length; i++) {
      const t = Math.min(1, d[i] / R);
      height[i] = R * cw * Math.sqrt(1 - (1 - t) * (1 - t)) * 0.9 + broad[i] * broadR * cw * 0.45;
    }
  }

  for (const f of faces) {
    // Head: a dome a little larger than the face, centred above its middle (the skull's centre).
    const c = [(f.P[10][0] + f.P[152][0]) / 2 - f.yAxis[0] * f.fh * 0.06, (f.P[10][1] + f.P[152][1]) / 2 - f.yAxis[1] * f.fh * 0.06];
    const rx = f.fw * 0.62, ry = f.fh * 0.74, D = f.fw * 0.42;
    const dome = (x, y) => {
      const dx = x - c[0], dy = y - c[1];
      const u = (dx * f.xAxis[0] + dy * f.xAxis[1]) / rx, v = (dx * f.yAxis[0] + dy * f.yAxis[1]) / ry;
      const q = Math.max(0, 1 - u * u - v * v);
      return D * q * q;
    };
    const pad = Math.max(rx, ry);
    const x0 = Math.max(0, Math.floor((c[0] - pad) / cw)), x1 = Math.min(nw - 1, Math.ceil((c[0] + pad) / cw));
    const y0 = Math.max(0, Math.floor((c[1] - pad) / ch)), y1 = Math.min(nh - 1, Math.ceil((c[1] + pad) / ch));
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) height[y * nw + x] += dome((x + 0.5) * cw, (y + 0.5) * ch);
    }

    // Face: the mesh's depth replaces the dome inside the face. The difference between them, taken
    // all along the face's outline and spread smoothly inward, bends the mesh to meet the dome
    // everywhere on the outline, so the face's own features show without a step or ridge.
    if (!f.Z.some((z) => z !== 0)) {
      for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) face[y * nw + x] = Math.max(face[y * nw + x], Math.min(1, (dome((x + 0.5) * cw, (y + 0.5) * ch) / D) * 2.5));
      }
      continue;
    }
    const { h: hm, cover } = faceDepth(f, nw, nh, cw, ch);
    const band = Math.max(1, Math.round((f.fw * 0.08) / cw));
    const cb = blurFloat(Float32Array.from(cover), nw, nh, band, 2);
    const num = new Float32Array(nw * nh), den = new Float32Array(nw * nh);
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const j = y * nw + x;
        if (cover[j] && cb[j] < 0.72) {
          num[j] = height[j] - hm[j] * 0.9;
          den[j] = 1;
        }
      }
    }
    const spread = Math.max(2, Math.round((f.fw * 0.2) / cw));
    blurFloat(num, nw, nh, spread, 3);
    blurFloat(den, nw, nh, spread, 3);
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const j = y * nw + x;
        if (!cover[j] || den[j] < 1e-4) continue;
        const w = Math.min(1, Math.max(0, (cb[j] - 0.5) * 2.4));
        height[j] += w * (hm[j] * 0.9 + num[j] / den[j] - height[j]);
        face[j] = Math.max(face[j], w);
      }
    }
  }

  // Smooth away the mesh's facets and the cells' steps.
  blurFloat(height, nw, nh, 2, 2);
  const data = new Uint8Array(nw * nh * 4);
  for (let y = 0; y < nh; y++) {
    for (let x = 0; x < nw; x++) {
      const j = y * nw + x;
      const hx = (height[y * nw + Math.min(nw - 1, x + 1)] - height[y * nw + Math.max(0, x - 1)]) / (2 * cw);
      const hy = (height[Math.min(nh - 1, y + 1) * nw + x] - height[Math.max(0, y - 1) * nw + x]) / (2 * ch);
      const n = norm3([-hx, -hy, 1]);
      data[j * 4] = (n[0] * 0.5 + 0.5) * 255;
      data[j * 4 + 1] = (n[1] * 0.5 + 0.5) * 255;
      data[j * 4 + 2] = (n[2] * 0.5 + 0.5) * 255;
      data[j * 4 + 3] = face[j] * 255;
    }
  }
  return { data, nw, nh };
}
