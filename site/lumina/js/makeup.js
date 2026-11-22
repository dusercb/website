// Makeup geometry. Every part AirBrush lists (eyeshadow, eyeliner, eyelashes, freckles,
// contouring) becomes a soft mask drawn from the face landmarks; colour and strength are applied
// later in the retouch shader, so only a style change (liner shape, lash type) redraws these.

import { blurChannel } from './blur.js';

const EYES = [
  // upper lid and lower lid run outer corner → inner corner; brow lower edge runs outer → inner
  { upper: [33, 246, 161, 160, 159, 158, 157, 173, 133], lower: [33, 7, 163, 144, 145, 153, 154, 155, 133], brow: [46, 53, 52, 65, 55], browTop: 105, key: 'eyeR' },
  { upper: [263, 466, 388, 387, 386, 385, 384, 398, 362], lower: [263, 249, 390, 373, 374, 380, 381, 382, 362], brow: [276, 283, 282, 295, 285], browTop: 334, key: 'eyeL' },
];
const JAW = [[172, 136, 150, 149, 176, 148], [397, 365, 379, 378, 400, 377]];
const FOREHEAD = [21, 54, 103, 67, 109, 10, 338, 297, 332, 284, 251];
const BRIDGE = [168, 6, 197, 195, 5];

const lerp = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
const norm = (v) => { const l = Math.hypot(v[0], v[1]) || 1; return [v[0] / l, v[1] / l]; };

// Point at fraction t (0–1) along a polyline.
function along(pts, t) {
  const seg = [];
  let total = 0;
  for (let i = 1; i < pts.length; i++) {
    const d = Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    seg.push(d);
    total += d;
  }
  let want = t * total;
  for (let i = 0; i < seg.length; i++) {
    if (want <= seg[i] || i === seg.length - 1) return lerp(pts[i], pts[i + 1], seg[i] ? Math.min(1, want / seg[i]) : 0);
    want -= seg[i];
  }
  return pts[pts.length - 1];
}

// Unit normal of the polyline at fraction t, flipped to point away from `centre`.
function normalAt(pts, t, centre) {
  const a = along(pts, Math.max(0, t - 0.04)), b = along(pts, Math.min(1, t + 0.04));
  let n = norm([b[1] - a[1], -(b[0] - a[0])]);
  const p = along(pts, t);
  if ((p[0] - centre[0]) * n[0] + (p[1] - centre[1]) * n[1] < 0) n = [-n[0], -n[1]];
  return n;
}

function mulberry32(seed) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Returns { w3, h3, feat3, w4, h4, feat4 }:
// feat3 (scale 0.75) r eyeshadow, g eyeliner, b lashes, a freckles; feat4 (scale 0.5) r contour, g highlight.
export function buildMakeupMasks(faces, W, H, { linerStyle = 'classic', lashStyle = 'natural' } = {}) {
  const layer = (scale) => {
    const w = Math.max(1, Math.round(W * scale)), h = Math.max(1, Math.round(H * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    return { w, h, scale, canvas, ctx: canvas.getContext('2d', { willReadFrequently: true }) };
  };
  const channel = (L, draw, feather) => {
    const { ctx, w, h, scale } = L;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    ctx.fillStyle = ctx.strokeStyle = '#fff';
    ctx.lineJoin = ctx.lineCap = 'round';
    let fw = 1;
    faces.forEach((f, i) => {
      fw = Math.max(fw, f.fw);
      ctx.save();
      draw(ctx, f, i);
      ctx.restore();
    });
    const d = ctx.getImageData(0, 0, w, h).data;
    const a = new Uint8ClampedArray(w * h);
    for (let i = 0; i < a.length; i++) a[i] = d[i * 4 + 3];
    const r = Math.round(fw * feather * scale);
    return r >= 1 ? blurChannel(a, w, h, r) : a;
  };
  const poly = (ctx, pts) => {
    ctx.beginPath();
    pts.forEach((p, k) => (k ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1])));
    ctx.closePath();
  };
  const path = (ctx, pts) => {
    ctx.beginPath();
    pts.forEach((p, k) => (k ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1])));
  };
  const ellipse = (ctx, c, rx, ry, rot) => {
    ctx.beginPath();
    ctx.ellipse(c[0], c[1], Math.max(rx, 0.5), Math.max(ry, 0.5), rot, 0, Math.PI * 2);
    ctx.fill();
  };

  const L3 = layer(0.75);

  // Eyeshadow: the lid from lash line to about halfway up to the brow, swept out at the corner.
  const shadow = channel(L3, (ctx, f) => {
    for (const E of EYES) {
      const lid = E.upper.map((i) => f.P[i]);
      const brow = E.brow.map((i) => f.P[i]);
      const crease = lid.map((p, k) => lerp(p, along(brow, k / (lid.length - 1)), 0.55));
      const outer = lid[0], inner = lid[lid.length - 1];
      const out = norm([outer[0] - inner[0], outer[1] - inner[1]]);
      const e = f[E.key];
      const tip = [outer[0] + out[0] * e.w * 0.22 - f.yAxis[0] * e.w * 0.12, outer[1] + out[1] * e.w * 0.22 - f.yAxis[1] * e.w * 0.12];
      poly(ctx, [...lid, ...crease.slice().reverse(), tip]);
      ctx.fill();
    }
  }, 0.03);

  // Eyeliner along the upper lash line, thicker toward the outer corner; Wing adds a flick,
  // Smoky thickens it and lines the outer lower lid too.
  const style = { natural: [0.018, 0], classic: [0.035, 0], wing: [0.038, 0.32], smoky: [0.06, 0.12] }[linerStyle] || [0.035, 0];
  const liner = channel(L3, (ctx, f) => {
    for (const E of EYES) {
      const e = f[E.key];
      const lid = E.upper.map((i) => f.P[i]).reverse();          // inner → outer
      const top = [], n = 14;
      for (let k = 0; k <= n; k++) {
        const t = k / n, p = along(lid, t), nn = normalAt(lid, t, e.c);
        const w = e.w * style[0] * (0.35 + 0.65 * t);
        top.push([p[0] + nn[0] * w, p[1] + nn[1] * w]);
      }
      const outer = lid[lid.length - 1];
      const shape = [...Array.from({ length: n + 1 }, (_, k) => along(lid, k / n))];
      if (style[1]) {
        const out = norm([outer[0] - lid[0][0], outer[1] - lid[0][1]]);
        const dir = norm([out[0] - f.yAxis[0] * 0.55, out[1] - f.yAxis[1] * 0.55]);
        shape.push([outer[0] + dir[0] * e.w * style[1], outer[1] + dir[1] * e.w * style[1]]);
      }
      poly(ctx, [...shape, ...top.reverse()]);
      ctx.fill();
      if (linerStyle === 'smoky') {
        const low = E.lower.map((i) => f.P[i]).reverse();
        path(ctx, low.slice(Math.floor(low.length / 2)));
        ctx.lineWidth = e.w * 0.025;
        ctx.stroke();
      }
    }
  }, linerStyle === 'smoky' ? 0.012 : 0.0025);

  // Lashes: separate curved strands, tapered root to tip, longer and more swept toward the outer
  // corner, each a little different (fixed seed) so they read as hair rather than a band.
  const ls = { natural: [18, 1, 0.9], volume: [24, 1.15, 1.15], dramatic: [30, 1.35, 1.35] }[lashStyle] || [18, 1, 0.9];
  const lashes = channel(L3, (ctx, f, fi) => {
    const rnd = mulberry32(77 + fi);
    for (const E of EYES) {
      const e = f[E.key];
      const lid = E.upper.map((i) => f.P[i]).reverse();
      const inner = lid[0], outer = lid[lid.length - 1];
      const out = norm([outer[0] - inner[0], outer[1] - inner[1]]);
      const width = Math.max(0.7, e.w * 0.009 * ls[2]);
      for (let k = 0; k < ls[0]; k++) {
        const t = 0.1 + (0.9 * k) / (ls[0] - 1) + (rnd() - 0.5) * 0.02;
        const p = along(lid, Math.min(1, t)), nn = normalAt(lid, Math.min(1, t), e.c);
        const len = e.w * (0.06 + 0.12 * t) * ls[1] * (0.85 + rnd() * 0.3);
        const sweep = 0.15 + 0.6 * t + (rnd() - 0.5) * 0.15;
        const dir = norm([nn[0] + out[0] * sweep, nn[1] + out[1] * sweep]);
        const ctrl = [p[0] + nn[0] * len * 0.6, p[1] + nn[1] * len * 0.6], end = [p[0] + dir[0] * len, p[1] + dir[1] * len];
        // Root half thicker, tip half thinner and fainter: a tapered strand.
        for (const [a, b, w, alpha] of [[0, 0.55, 1, 0.95], [0.45, 1, 0.55, 0.7]]) {
          const pt = (s) => [(1 - s) ** 2 * p[0] + 2 * (1 - s) * s * ctrl[0] + s * s * end[0], (1 - s) ** 2 * p[1] + 2 * (1 - s) * s * ctrl[1] + s * s * end[1]];
          ctx.globalAlpha = alpha;
          ctx.lineWidth = width * w;
          ctx.beginPath();
          for (let q = 0; q <= 6; q++) {
            const s = a + ((b - a) * q) / 6, xy = pt(s);
            q ? ctx.lineTo(xy[0], xy[1]) : ctx.moveTo(xy[0], xy[1]);
          }
          ctx.stroke();
        }
        ctx.globalAlpha = 1;
      }
      if (lashStyle === 'dramatic') {
        const low = E.lower.map((i) => f.P[i]).reverse();
        ctx.lineWidth = Math.max(0.5, e.w * 0.007);
        for (let k = 0; k < 12; k++) {
          const t = 0.35 + (0.6 * k) / 11, p = along(low, t), nn = normalAt(low, t, e.c), len = e.w * 0.05;
          ctx.beginPath();
          ctx.moveTo(p[0], p[1]);
          ctx.lineTo(p[0] + nn[0] * len, p[1] + nn[1] * len);
          ctx.stroke();
        }
      }
    }
  }, 0);

  // Freckles: a fixed random scatter over the nose and upper cheeks (same every time).
  const freckles = channel(L3, (ctx, f, fi) => {
    const rnd = mulberry32(1234 + fi);
    const c = lerp(f.P[197], f.P[4], 0.3);
    const rx = f.fw * 0.36, ry = f.fw * 0.12;
    for (let k = 0, placed = 0; k < 900 && placed < 170; k++) {
      const u = rnd() * 2 - 1, v = rnd() * 2 - 1;
      const q = u * u + v * v;
      if (q > 1 || rnd() > 1 - 0.55 * q) continue;
      const p = [c[0] + f.xAxis[0] * u * rx + f.yAxis[0] * v * ry, c[1] + f.xAxis[1] * u * rx + f.yAxis[1] * v * ry];
      if ([f.eyeR, f.eyeL].some((e) => Math.hypot(p[0] - e.c[0], p[1] - e.c[1]) < e.w * 0.62)) continue;
      const r = f.fw * (0.0022 + rnd() * 0.0035);
      ctx.globalAlpha = 0.35 + rnd() * 0.55;
      const g = ctx.createRadialGradient(p[0], p[1], 0, p[0], p[1], r);
      g.addColorStop(0, '#fff');
      g.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(p[0], p[1], r, 0, Math.PI * 2);
      ctx.fill();
      placed++;
    }
  }, 0);

  const L4 = layer(0.5);

  // Contour: under the cheekbones, along the jaw, down the sides of the nose and at the hairline.
  const contour = channel(L4, (ctx, f) => {
    for (const [ear, corner] of [[93, 61], [323, 291]]) {
      const a = f.P[ear], b = f.P[corner];
      const c = lerp(a, b, 0.3);
      ellipse(ctx, [c[0] - f.yAxis[0] * f.fh * 0.02, c[1] - f.yAxis[1] * f.fh * 0.02], Math.hypot(b[0] - a[0], b[1] - a[1]) * 0.3, f.fw * 0.04, Math.atan2(b[1] - a[1], b[0] - a[0]));
    }
    ctx.lineWidth = f.fw * 0.06;
    for (const side of JAW) {
      path(ctx, side.map((i) => f.P[i]));
      ctx.stroke();
    }
    ctx.lineWidth = f.fw * 0.022;
    for (const s of [-1, 1]) {
      path(ctx, BRIDGE.map((i) => [f.P[i][0] + f.xAxis[0] * s * f.fw * 0.045, f.P[i][1] + f.xAxis[1] * s * f.fw * 0.045]));
      ctx.stroke();
    }
    ctx.lineWidth = f.fw * 0.07;
    path(ctx, FOREHEAD.map((i) => f.P[i]));
    ctx.stroke();
  }, 0.035);

  // Highlight: cheekbone tops, nose bridge, cupid's bow, chin and brow bone.
  const highlight = channel(L4, (ctx, f) => {
    for (const [e, side, E] of [[f.eyeR, -1, EYES[0]], [f.eyeL, 1, EYES[1]]]) {
      const c = [e.c[0] + f.yAxis[0] * e.w * 0.78 + f.xAxis[0] * side * e.w * 0.32, e.c[1] + f.yAxis[1] * e.w * 0.78 + f.xAxis[1] * side * e.w * 0.32];
      ellipse(ctx, c, e.w * 0.55, e.w * 0.17, f.roll - side * 0.35);
      const bone = lerp(f.P[E.upper[4]], f.P[E.browTop], 0.72);
      ellipse(ctx, bone, e.w * 0.26, e.w * 0.07, f.roll);
    }
    ctx.lineWidth = f.fw * 0.028;
    path(ctx, BRIDGE.slice(0, 4).map((i) => f.P[i]));
    ctx.stroke();
    const up = [-f.yAxis[0], -f.yAxis[1]];
    ellipse(ctx, [f.P[0][0] + up[0] * f.fh * 0.02, f.P[0][1] + up[1] * f.fh * 0.02], f.fw * 0.035, f.fw * 0.012, f.roll);
    ellipse(ctx, [f.P[152][0] + up[0] * f.fh * 0.05, f.P[152][1] + up[1] * f.fh * 0.05], f.fw * 0.05, f.fw * 0.03, f.roll);
  }, 0.025);

  for (const L of [L3, L4]) L.canvas.width = L.canvas.height = 0; // free now; iOS counts canvas memory until GC
  const feat3 = new Uint8Array(L3.w * L3.h * 4);
  for (let i = 0; i < L3.w * L3.h; i++) {
    feat3[i * 4] = shadow[i];
    feat3[i * 4 + 1] = liner[i];
    feat3[i * 4 + 2] = lashes[i];
    feat3[i * 4 + 3] = freckles[i];
  }
  const feat4 = new Uint8Array(L4.w * L4.h * 4);
  for (let i = 0; i < L4.w * L4.h; i++) {
    feat4[i * 4] = contour[i];
    feat4[i * 4 + 1] = highlight[i];
  }
  return { w3: L3.w, h3: L3.h, feat3, w4: L4.w, h4: L4.h, feat4 };
}
