// Reshape: a backward displacement grid. Each grid cell holds the offset (in uv units) from an
// output pixel to the spot in the photo it shows. Sculpt's face sliders are rasterised into it from
// the moved face mesh (sculpt.js); on top come landmark-anchored local warps (translations that pull
// the lips, the teeth's edge, the body's outline or the hair's, bulges that enlarge the head) and
// finally the Push brush's strokes.

import { IDX } from './face.js';
import { sculptFace, sculptActive } from './sculpt.js';

const dot = (v, a) => v[0] * a[0] + v[1] * a[1];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1]];
const lerp = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
const norm = (v) => {
  const l = Math.hypot(v[0], v[1]) || 1;
  return [v[0] / l, v[1] / l];
};
const scale = (v, k) => [v[0] * k, v[1] * k];
const add = (a, b) => [a[0] + b[0], a[1] + b[1]];
const smooth = (a, b, x) => {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

// A group: content near each anchor p moves by v, blended across the group's anchors (radius R).
// o: { plump, align, img } (Fillers' lips and Teeth › Align; Sculpt is drawn from the mesh).
function faceOps(f, o) {
  const groups = [], bulges = [];
  if (o.align && o.img) {
    const g = teethAlign(f, o.img, o.align);
    if (g) groups.push(g);
  }
  if (o.plump) {
    // Plump: the lips grow taller from their centre line, a little wider, as fillers would.
    const c = f.mouth.c;
    groups.push({
      R: f.mouth.w * 0.4,
      pts: [...IDX.lipsOuter.map((i) => [i, 0.2]), ...IDX.lipsInner.map((i) => [i, 0.08])].map(([i, s]) => {
        const d = sub(f.P[i], c);
        return { p: f.P[i], v: add(scale(f.yAxis, dot(d, f.yAxis) * o.plump * s), scale(f.xAxis, dot(d, f.xAxis) * o.plump * 0.04)) };
      }),
    });
  }
  return { groups, bulges };
}

// Teeth › Align: finds the lower edge of the upper teeth across the mouth, fits a smooth curve
// to it and moves the edge onto the curve, so uneven tips and steps even out. The lips stay put.
function teethAlign(f, img, k) {
  const { width: W, height: H, data } = img;
  const lum = (x, y) => {
    const i = (Math.min(H - 1, Math.max(0, Math.round(y))) * W + Math.min(W - 1, Math.max(0, Math.round(x)))) * 4;
    return 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
  };
  const c = f.mouth.c, ax = f.xAxis, ay = f.yAxis, mw = f.mouth.w;
  const local = (p) => [dot(sub(p, c), ax), dot(sub(p, c), ay)];
  const toImg = (u, v) => [c[0] + ax[0] * u + ay[0] * v, c[1] + ax[1] * u + ay[1] * v];
  const inner = IDX.lipsInner;
  const upper = inner.slice(0, 11).map((i) => local(f.P[i])).sort((a, b) => a[0] - b[0]);
  const lower = [...inner.slice(10), inner[0]].map((i) => local(f.P[i])).sort((a, b) => a[0] - b[0]);
  const vAt = (pts, u) => {
    if (u <= pts[0][0]) return pts[0][1];
    for (let i = 1; i < pts.length; i++) {
      if (u <= pts[i][0]) return pts[i - 1][1] + ((pts[i][1] - pts[i - 1][1]) * (u - pts[i - 1][0])) / (pts[i][0] - pts[i - 1][0] || 1);
    }
    return pts[pts.length - 1][1];
  };
  const step = Math.max(0.5, mw / 300);
  const edges = [];
  for (let n = 0; n < 24; n++) {
    const u = (-0.4 + (0.8 * n) / 23) * mw;
    const v0 = vAt(upper, u), v1 = vAt(lower, u);
    if (v1 - v0 < mw * 0.04) continue;                  // the mouth is closed here
    const col = [];
    for (let v = v0; v <= v1; v += step) {
      let l = 0;
      for (const du of [-3, 0, 3]) l += lum(...toImg(u + du * step, v));
      col.push([v, l / 3]);
    }
    // The first strong bright-to-dark step below the lip: the tips of the upper teeth.
    const drops = col.map((q, i) => (i < 2 || i > col.length - 3 ? 0 : (col[i - 2][1] + col[i - 1][1]) / 2 - (col[i + 1][1] + col[i + 2][1]) / 2));
    const max = Math.max(...drops);
    if (max < 22) continue;
    const i = drops.findIndex((d, j) => j >= 2 && d >= max * 0.5 && d >= drops[j - 1] && d >= drops[j + 1] && (col[j - 1][1] + col[j - 2][1]) / 2 > 110);
    if (i > 0) edges.push([u, col[i][0]]);
  }
  if (edges.length < 6) return null;
  // Least squares for v = a + b·u + c·u², then once more without the outliers.
  const fit = (pts) => {
    const S = Array.from({ length: 3 }, () => [0, 0, 0, 0]);
    for (const [u, v] of pts) {
      const b = [1, u, u * u];
      for (let r = 0; r < 3; r++) {
        for (let q = 0; q < 3; q++) S[r][q] += b[r] * b[q];
        S[r][3] += b[r] * v;
      }
    }
    for (let r = 0; r < 3; r++) {
      const p = S[r][r] || 1e-9;
      for (let q = r; q < 4; q++) S[r][q] /= p;
      for (let o = 0; o < 3; o++) if (o !== r) for (let q = 3; q >= r; q--) S[o][q] -= S[o][r] * S[r][q];
    }
    return (u) => S[0][3] + S[1][3] * u + S[2][3] * u * u;
  };
  let curve = fit(edges);
  const res = edges.map(([u, v]) => Math.abs(v - curve(u)));
  const med = [...res].sort((x, y) => x - y)[res.length >> 1];
  const kept = edges.filter((e, i) => res[i] <= 2.5 * med + 1);
  if (kept.length >= 6) curve = fit(kept);
  const lim = mw * 0.06;
  const pts = edges.map(([u, v]) => ({ p: toImg(u, v), v: scale(ay, Math.max(-lim, Math.min(lim, curve(u) - v)) * k) }));
  for (const [u, v] of [...upper, ...lower]) pts.push({ p: toImg(u, v), v: [0, 0] });
  return { R: mw * 0.12, pts };
}

// ---------- body ----------

// Distance from c along unit dir to the edge of the subject mask (photo px), capped at max.
function edgeDistance(mask, c, dir, max, W, H) {
  if (!mask) return max * 0.55;
  const { data, w, h } = mask;
  const step = Math.max(1, max / 60);
  for (let d = step; d <= max; d += step) {
    const x = Math.round(((c[0] + dir[0] * d) * w) / W), y = Math.round(((c[1] + dir[1] * d) * h) / H);
    if (x < 0 || y < 0 || x >= w || y >= h || data[y * w + x] < 128) return d;
  }
  return max;
}

// The arms and hands, as capsules round their bones (MediaPipe Pose: shoulder, elbow, wrist, and
// the pinky and index knuckles), for parts seen clearly enough to trust. Each capsule's radius is
// measured on the subject mask across the bone, on the side facing away from the body's midline
// (sh, along axis) where the arm meets the background, so a loose sleeve counts; it is kept within
// a plausible share of the shoulders' width.
export function armParts(pose, mask, W, H, shoulderW, sh, axis) {
  const P = (i) => [pose[i][0] * W, pose[i][1] * H];
  const seen = (...ids) => ids.every((i) => pose[i][2] > 0.5);
  const parts = [];
  const across = (a, b, t, base) => {
    const p = lerp(a, b, t), dir = norm(sub(b, a)), n = [-dir[1], dir[0]], cap = base * 3.5;
    const e1 = edgeDistance(mask, p, n, cap, W, H), e2 = edgeDistance(mask, p, scale(n, -1), cap, W, H);
    const off = sub(p, sh), out = norm(sub(off, scale(axis, dot(off, axis)))), side = dot(out, n);
    const r = Math.abs(side) > 0.5 ? (side > 0 ? e1 : e2) : Math.min(e1, e2);
    return Math.min(base * 3, Math.max(base * 0.6, r));
  };
  for (const [s, e, w, pk, ix] of [[11, 13, 15, 17, 19], [12, 14, 16, 18, 20]]) {
    if (seen(s, e)) parts.push({ a: P(s), b: P(e), r: across(P(s), P(e), 0.55, shoulderW * 0.11) });
    if (!seen(e, w)) continue;
    const fore = across(P(e), P(w), 0.5, shoulderW * 0.085);
    parts.push({ a: P(e), b: P(w), r: fore });
    // The hand: from the wrist past the knuckles to about where the fingertips reach.
    const k = pose[pk][2] > 0.3 && pose[ix][2] > 0.3 ? lerp(P(pk), P(ix), 0.5) : add(P(w), scale(norm(sub(P(w), P(e))), fore * 1.6));
    const len = Math.max(fore, Math.hypot(...sub(k, P(w))));
    parts.push({ a: P(w), b: add(P(w), scale(norm(sub(k, P(w))), len * 1.7)), r: Math.max(fore * 1.15, len * 0.75) });
  }
  return parts;
}

// How deep p lies in the nearest arm or hand by the body's side (those over its front are left out):
// 1 inside, falling to 0 at half a radius outside.
function inArm(parts, p) {
  let best = 0;
  for (const c of parts) {
    if (c.front) continue;
    const ab = sub(c.b, c.a), t = Math.max(0, Math.min(1, dot(sub(p, c.a), ab) / (dot(ab, ab) || 1)));
    const d = Math.hypot(...sub(p, add(c.a, scale(ab, t))));
    best = Math.max(best, 1 - Math.max(0, Math.min(1, (d - c.r) / (c.r * 0.5))));
  }
  return best;
}

// The torso's own edge from c along dir: where the subject mask ends, unless an arm or hand by the
// body's side comes first (the mask cannot tell them apart), in which case the torso ends where the
// arm begins, whatever lies beyond (a loose sleeve, something held).
function torsoEdge(mask, parts, c, dir, max, W, H) {
  if (!mask || !parts.length) return edgeDistance(mask, c, dir, max, W, H);
  const { data, w, h } = mask;
  const step = Math.max(1, max / 80);
  for (let d = step; d <= max; d += step) {
    const p = add(c, scale(dir, d));
    const x = Math.round((p[0] * w) / W), y = Math.round((p[1] * h) / H);
    if (x < 0 || y < 0 || x >= w || y >= h || data[y * w + x] < 128 || inArm(parts, p) > 0.5) return d;
  }
  return max;
}

// Arms and hands keep their shape while the torso and legs are reshaped round them: across each
// capsule the warp takes the value it has at the bone, so an arm by the waist or a hand on a hip
// moves with the body it touches, all of a piece, instead of being squeezed or stretched.
function protectParts(field, gw, gh, W, H, parts) {
  const snap = Float32Array.from(field);
  const sample = (x, y) => {
    const gx = Math.min(gw - 1, Math.max(0, (x / W) * gw - 0.5)), gy = Math.min(gh - 1, Math.max(0, (y / H) * gh - 0.5));
    const x0 = Math.floor(gx), y0 = Math.floor(gy), x1 = Math.min(gw - 1, x0 + 1), y1 = Math.min(gh - 1, y0 + 1), tx = gx - x0, ty = gy - y0;
    return [0, 1].map((c) => (snap[(y0 * gw + x0) * 2 + c] * (1 - tx) + snap[(y0 * gw + x1) * 2 + c] * tx) * (1 - ty) +
      (snap[(y1 * gw + x0) * 2 + c] * (1 - tx) + snap[(y1 * gw + x1) * 2 + c] * tx) * ty);
  };
  for (const c of parts) {
    const pad = c.r * 1.6, ab = sub(c.b, c.a), L2 = dot(ab, ab) || 1;
    const gx0 = Math.max(0, Math.floor(((Math.min(c.a[0], c.b[0]) - pad) / W) * gw)), gx1 = Math.min(gw - 1, Math.ceil(((Math.max(c.a[0], c.b[0]) + pad) / W) * gw));
    const gy0 = Math.max(0, Math.floor(((Math.min(c.a[1], c.b[1]) - pad) / H) * gh)), gy1 = Math.min(gh - 1, Math.ceil(((Math.max(c.a[1], c.b[1]) + pad) / H) * gh));
    for (let gy = gy0; gy <= gy1; gy++) {
      for (let gx = gx0; gx <= gx1; gx++) {
        const p = [((gx + 0.5) / gw) * W, ((gy + 0.5) / gh) * H];
        const t = Math.max(0, Math.min(1, dot(sub(p, c.a), ab) / L2)), bone = add(c.a, scale(ab, t));
        const d = Math.hypot(...sub(p, bone));
        const k = 1 - Math.max(0, Math.min(1, (d - c.r) / (c.r * 0.5)));
        if (k <= 0) continue;
        const v = sample(...bone), i = (gy * gw + gx) * 2;
        field[i] += (v[0] - field[i]) * k;
        field[i + 1] += (v[1] - field[i + 1]) * k;
      }
    }
  }
}

// Hair › Volume: along rays from the head's centre, the hair's outer edge moves out (or in) by a
// share of how thick the hair is there, while the face's own outline stays pinned.
function hairOps(faces, mask, W, H, k) {
  const groups = [];
  const { data, w, h } = mask;
  const inHair = (p) => {
    const x = Math.round((p[0] * w) / W), y = Math.round((p[1] * h) / H);
    return x >= 0 && y >= 0 && x < w && y < h && data[y * w + x] >= 128;
  };
  for (const f of faces) {
    const c = sub(f.center, scale(f.yAxis, 0.12 * f.fh));
    const oval = IDX.oval.map((i) => f.P[i]);
    const pts = [];
    for (let n = 0; n < 32; n++) {
      const a = (n / 32) * Math.PI * 2;
      // Rays in the face's frame; the ones pointing down at the neck and chest are skipped.
      const lx = Math.sin(a), ly = -Math.cos(a);
      if (ly > 0.5) continue;
      const dir = norm(add(scale(f.xAxis, lx), scale(f.yAxis, ly)));
      // Where the ray leaves the face: the outline point lying most nearly along it.
      let face = 0, best = -2;
      for (const p of oval) {
        const v = sub(p, c), l = Math.hypot(v[0], v[1]) || 1, q = dot(v, dir) / l;
        if (q > best) {
          best = q;
          face = l;
        }
      }
      // The hair along the ray: where it starts (skin may show first, as on a high forehead) and ends.
      const step = Math.max(1, f.fh / 90), max = f.fh * 1.6;
      let d = face, start = -1;
      for (; d < face + f.fh * 0.3 && start < 0; d += step) if (inHair(add(c, scale(dir, d)))) start = d;
      if (start < 0) continue;
      for (d = start; d < max && inHair(add(c, scale(dir, d))); d += step);
      const thick = d - start;
      if (thick < f.fh * 0.04) continue;
      pts.push({ p: add(c, scale(dir, face)), v: [0, 0] });
      pts.push({ p: add(c, scale(dir, d)), v: scale(dir, k * (0.16 * thick + 0.025 * f.fh)) });
    }
    if (pts.length) groups.push({ R: f.fh * 0.42, pts });
  }
  return { groups, bulges: [] };
}

// Body shaping from pose landmarks (MediaPipe Pose indices; left/right are the person's own).
// b: { slim, waist, hips, legs, arms, shoulders, square, tummy, neck, head, posture, tilt } in −1…1.
// Returns the shape ops, the arm and hand capsules they must not bend (protect), and Arms' own
// slimming (after), which is applied once the arms are protected.
function bodyOps(pose, mask, W, H, b, faced = true) {
  const groups = [], bulges = [], turns = [], flows = [], after = { groups: [], bulges: [] };
  // Slim, AirBrush's one slider for the whole figure, works through the others (and the chest).
  const slim = b.slim || 0, c1 = (v) => Math.max(-1, Math.min(1, v));
  if (slim) b = { ...b, waist: c1(b.waist + slim * 0.6), hips: c1(b.hips - slim * 0.5), legs: c1(b.legs + slim * 0.6), arms: c1(b.arms + slim * 0.5) };
  const P = (i) => [pose[i][0] * W, pose[i][1] * H];
  const seen = (...ids) => ids.every((i) => pose[i][2] > 0.45);
  if (!seen(11, 12)) return { groups, bulges, turns, flows, protect: [], after };
  const sh0 = lerp(P(11), P(12), 0.5), hp0 = seen(23, 24) ? lerp(P(23), P(24), 0.5) : add(sh0, [0, 1]);
  const parts = armParts(pose, mask, W, H, Math.hypot(...sub(P(11), P(12))), sh0, norm(sub(hp0, sh0)));
  const edge = (c, dir, max) => torsoEdge(mask, parts, c, dir, max, W, H);
  const sh = lerp(P(11), P(12), 0.5);
  const hipsSeen = seen(23, 24);
  const hp = hipsSeen ? lerp(P(23), P(24), 0.5) : add(sh, [0, Math.hypot(...sub(P(11), P(12))) * 1.4]);
  const axis = norm(sub(hp, sh)), perp = [-axis[1], axis[0]];
  const torso = Math.hypot(...sub(hp, sh));
  const shoulderW = Math.hypot(...sub(P(11), P(12)));
  const pin = (p) => ({ p, v: [0, 0] });
  // Both sides of the body at c across `across`, moved inward by k of each half-width. A side found
  // far beyond the body's usual half-width there is something held or an arm the pose missed, so the
  // half-width is capped at 1.6 times the usual one.
  const pinch = (c, across, max, k, R, spread) => {
    const pts = [];
    for (const t of spread) {
      const w = 1 - Math.abs(t) * 2.5;
      const at = add(c, scale(axis, t * torso));
      const cap = 1.6 * halfAt(dot(sub(at, sh), axis) / torso);
      const a = Math.min(cap, edge(at, scale(across, -1), max)), bb = Math.min(cap, edge(at, across, max));
      pts.push({ p: add(at, scale(across, -a)), v: scale(across, k * a * w) });
      pts.push({ p: add(at, scale(across, bb)), v: scale(across, -k * bb * w) });
    }
    groups.push({ R, pts });
  };
  // An arm or hand whose bone comes within half the body's usual half-width of its midline lies
  // over the front of the body (arms crossed, hands holding something before it); the torso's edge
  // is looked for past those, and stops at the ones by its sides.
  const hipW = hipsSeen ? Math.hypot(...sub(P(23), P(24))) : shoulderW * 0.75;
  const halfAt = (t) => 0.5 * (shoulderW + (hipW * 1.35 - shoulderW) * Math.max(0, Math.min(1.2, t)));
  for (const c of parts) {
    let near = Infinity;
    for (const t of [0, 0.25, 0.5, 0.75, 1]) {
      const off = sub(lerp(c.a, c.b, t), sh);
      near = Math.min(near, Math.abs(dot(off, perp)) / Math.max(1, halfAt(dot(off, axis) / torso)));
    }
    c.front = near < 0.5;
  }
  const plainEdge = (c, dir, max) => edgeDistance(mask, c, dir, max, W, H);
  if (b.waist && hipsSeen) pinch(lerp(sh, hp, 0.62), perp, torso * 0.9, b.waist * 0.13, torso * 0.32, [-0.18, 0, 0.18]);
  if (slim && hipsSeen) pinch(lerp(sh, hp, 0.3), perp, torso * 0.9, slim * 0.06, torso * 0.3, [-0.1, 0, 0.1]);
  const sideOn = faced && shoulderW < torso * 0.4 && pose[0][2] > 0.45;
  if (b.bellySmooth && hipsSeen) {
    // Belly › Smooth: bumps on the belly's outline (rolls, a muffin top) are drawn in to a smooth line.
    // The outline is measured at 14 heights from under the chest to the hips (the front when side on,
    // both sides, stopping at arms, when facing), a Gaussian-smoothed copy of it is the target, and
    // only what stands out past the target moves; dips are left alone.
    const smoothSide = (dir, edgeAt) => {
      const ts = Array.from({ length: 14 }, (_, i) => 0.48 + (0.58 * i) / 13);
      const e = ts.map((t) => edgeAt(lerp(sh, hp, t), dir, torso * 0.8));
      const pts = ts.map((t, i) => {
        let s = 0, w = 0;
        for (let j = 0; j < e.length; j++) {
          const g = Math.exp(-((i - j) ** 2) / 6);
          s += g * e[j];
          w += g;
        }
        const over = e[i] - s / w, at = add(lerp(sh, hp, t), scale(dir, e[i]));
        return over > 1 ? { p: at, v: scale(dir, -over * b.bellySmooth) } : pin(at);
      });
      groups.push({ R: torso * 0.14, pts });
    };
    if (sideOn) smoothSide(scale(perp, Math.sign(dot(sub(P(0), sh), perp)) || 1), plainEdge);
    else for (const d of [perp, scale(perp, -1)]) smoothSide(d, edge);
  }
  if (b.tummy && hipsSeen) {
    if (sideOn) {
      // Side on (narrow shoulders, and a face found, so not a back view): the belly is on the side the
      // face points to. Its front moves back toward the spine, most at the navel, while the back and
      // the chest and hips above and below stay put.
      const front = scale(perp, Math.sign(dot(sub(P(0), sh), perp)) || 1);
      const pts = [pin(lerp(sh, hp, 0.3)), pin(lerp(sh, hp, 1.2))];
      for (const [t, w] of [[0.6, 0.6], [0.78, 1], [0.95, 0.6]]) {
        const at = lerp(sh, hp, t);
        const e = plainEdge(at, front, torso * 0.8), back = plainEdge(at, scale(front, -1), torso * 0.8);
        pts.push({ p: add(at, scale(front, e)), v: scale(front, -b.tummy * 0.22 * w * Math.min(e, (e + back) * 0.6)) });
        pts.push(pin(add(at, scale(front, -back))));
      }
      groups.push({ R: torso * 0.35, pts });
    } else {
      pinch(lerp(sh, hp, 0.82), perp, torso * 0.9, b.tummy * 0.06, torso * 0.28, [-0.08, 0, 0.08]);
    }
  }
  if (b.hips && hipsSeen) pinch(lerp(sh, hp, 1.08), perp, torso * 0.9, -b.hips * 0.1, torso * 0.35, [-0.1, 0, 0.12]);
  // A limb's two sides moved in by k of each half-width (an arm's own sides are found on the plain
  // mask; a leg's stop where a hand rests on it).
  const limb = (ids, k, cap, strength, into = groups, edgeAt = edge) => {
    for (let s = 0; s + 1 < ids.length; s++) {
      if (!seen(ids[s], ids[s + 1])) break;
      const a = P(ids[s]), c = P(ids[s + 1]);
      const len = Math.hypot(...sub(c, a));
      const dir = norm(sub(c, a)), n = [-dir[1], dir[0]];
      const pts = [];
      for (const t of [0.15, 0.35, 0.55, 0.75, 0.92]) {
        const p = lerp(a, c, t);
        const e1 = Math.min(edgeAt(p, n, len * 0.6), len * cap), e2 = Math.min(edgeAt(p, scale(n, -1), len * 0.6), len * cap);
        pts.push({ p: add(p, scale(n, e1)), v: scale(n, -k * strength * e1) });
        pts.push({ p: add(p, scale(n, -e2)), v: scale(n, k * strength * e2) });
      }
      into.push({ R: len * 0.3, pts });
    }
  };
  if (b.legs) {
    limb([23, 25, 27], b.legs, 0.35, 0.15);
    limb([24, 26, 28], b.legs, 0.35, 0.15);
  }
  if (b.arms) {
    limb([11, 13, 15], b.arms, 0.4, 0.15, after.groups, plainEdge);
    limb([12, 14, 16], b.arms, 0.4, 0.15, after.groups, plainEdge);
  }
  if (b.shoulders) {
    const pts = [pin(sh)];
    for (const i of [11, 12]) {
      const out = norm(sub(P(i), sh));
      const e = plainEdge(P(i), out, shoulderW * 0.45);
      pts.push({ p: add(P(i), scale(out, e * 0.6)), v: scale(out, b.shoulders * 0.08 * shoulderW) });
    }
    groups.push({ R: shoulderW * 0.4, pts });
  }
  if (b.square) {
    // Square shoulders: the slope from the neck to each shoulder's edge lifts, the neck and the arms
    // below staying where they are.
    const pts = [pin(sh), pin(lerp(sh, hp, 0.45))];
    for (const i of [11, 12]) {
      const out = norm(sub(P(i), sh));
      const e = plainEdge(P(i), out, shoulderW * 0.45);
      pts.push({ p: add(P(i), scale(out, e * 0.5)), v: scale(axis, -b.square * 0.05 * shoulderW) });
      pts.push(pin(add(P(i), scale(axis, torso * 0.4))));
    }
    groups.push({ R: shoulderW * 0.45, pts });
  }
  const headIds = [0, 2, 5, 7, 8, 9, 10].filter((i) => pose[i][2] > 0.3);
  const head = headIds.length ? headIds.reduce((s, i) => add(s, scale(P(i), 1 / headIds.length)), [0, 0]) : add(sh, scale(axis, -torso * 0.45));
  const headR = seen(7, 8) ? Math.hypot(...sub(P(7), P(8))) * 0.75 : shoulderW * 0.3;
  const top = add(head, scale(axis, -headR));
  if (b.neck || b.posture) {
    const lift = (b.neck * 0.07 + b.posture * 0.03) * torso;
    const pts = [...headIds.map((i) => ({ p: P(i), v: scale(axis, -lift) })), { p: top, v: scale(axis, -lift) }, pin(P(11)), pin(P(12))];
    if (b.posture) {
      for (const i of [11, 12]) {
        const out = norm(sub(P(i), sh));
        pts.push({ p: lerp(P(i), sh, 0.15), v: add(scale(axis, b.posture * 0.035 * torso), scale(out, b.posture * 0.02 * shoulderW)) });
      }
      if (hipsSeen) pts.push(pin(hp));
    }
    groups.push({ R: torso * 0.5, pts });
  }
  if (b.tilt) {
    // The head and its hair turn as one about the base of the neck. The neck bends between the
    // shoulders and the jaw, and the turn fades out beside and above the hair.
    const up = scale(axis, -1), span = Math.max(1, dot(sub(head, sh), up));
    const mouth = seen(9, 10) ? lerp(P(9), P(10), 0.5) : null;
    const tJaw = mouth ? Math.max(0.3, dot(sub(mouth, sh), up) / span - 0.15) : 0.5;
    const reach = headR * 3.4;
    const corners = [sh, add(head, scale(up, reach)), add(sh, scale(perp, reach)), add(sh, scale(perp, -reach)),
      add(add(head, scale(up, reach)), scale(perp, reach)), add(add(head, scale(up, reach)), scale(perp, -reach))];
    turns.push({
      pivot: lerp(sh, head, 0.25), th: (b.tilt * 12 * Math.PI) / 180,
      box: [Math.min(...corners.map((q) => q[0])), Math.min(...corners.map((q) => q[1])), Math.max(...corners.map((q) => q[0])), Math.max(...corners.map((q) => q[1]))],
      weight: (p) => {
        const t = dot(sub(p, sh), up) / span, lat = Math.abs(dot(sub(p, head), perp)) / headR, above = dot(sub(p, head), up) / headR;
        return smooth(0.05, tJaw, t) * (1 - smooth(1.9, 3.2, lat)) * (1 - smooth(2.1, 3.3, above));
      },
    });
  }
  if (b.head) bulges.push({ c: head, R: headR * 1.9, k: b.head * 0.22 });
  if (b.legRatio && hipsSeen) {
    // Leg ratio (AirBrush's bodyLegRatio): the hips rise and the legs lengthen by as much, the head
    // and feet staying put. A row at y shows y + Δ·g(y), g rising from the shoulders to the new hip
    // line and falling back to the feet, the same across the whole width (as Stretch), so straight
    // lines stay straight. |Δ| ≤ 12% of the torso keeps it free of folds.
    const feet = [27, 28].filter((i) => pose[i][2] > 0.45).map((i) => P(i)[1]);
    const knees = [25, 26].filter((i) => pose[i][2] > 0.45).map((i) => P(i)[1]);
    const yF = feet.length ? Math.max(...feet) : knees.length ? Math.max(...knees) * 1.8 - hp[1] * 0.8 : 0;
    const yS = sh[1], dl = b.legRatio * 0.12 * (hp[1] - sh[1]), yH = hp[1] - dl;
    if (yF > hp[1] + 4 && yH > yS + 4) {
      flows.push({
        box: [0, yS, W, Math.min(H, yF)],
        fn: (x, y) => {
          const g = y < yH ? smooth(yS, yH, y) : 1 - smooth(yH, yF, y);
          return [0, dl * g];
        },
      });
    }
  }
  return { groups, bulges, turns, flows, protect: parts, after };
}

// About 3.5 photo px per cell, so small features such as eye corners move smoothly.
export function gridSize(W, H) {
  const gw = Math.min(560, Math.max(160, Math.round(W / 3.5)));
  return [gw, Math.max(2, Math.round((gw * H) / W))];
}

export const bodyActive = (b) => Boolean(b && Object.values(b).some(Boolean));

// o: { sculpt: per-face Sculpt values, plump, align, img, hair: { k, mask } | null }.
// pushes: Push-brush strokes { r, p: [x0, y0, x1, y1, …] } in image px, applied after the shape warps.
// body: { pose, mask: { data, w, h } | null, values, faced: a face was found } or null.
export function buildWarp(faces, W, H, o = {}, pushes = [], body = null) {
  const sculpt = o.sculpt || [];
  const faceOn = faces.length > 0 && (faces.some((f, i) => sculptActive(sculpt[i])) || Boolean(o.plump || o.align));
  const hairOn = faces.length > 0 && Boolean(o.hair && o.hair.k && o.hair.mask);
  const bodyOn = Boolean(body && body.pose && bodyActive(body.values));
  if (!faceOn && !hairOn && !bodyOn && !pushes.length) return null;
  const [gw, gh] = gridSize(W, H);
  const field = new Float32Array(gw * gh * 2);
  if (faceOn) {
    faces.forEach((f, i) => {
      applyOps(field, gw, gh, W, H, sculptFace(field, gw, gh, W, H, f, sculpt[i]));
      applyOps(field, gw, gh, W, H, faceOps(f, o));
    });
  }
  if (hairOn) applyOps(field, gw, gh, W, H, hairOps(faces, o.hair.mask, W, H, o.hair.k));
  if (bodyOn) {
    const ops = bodyOps(body.pose, body.mask, W, H, body.values, body.faced);
    const bf = new Float32Array(gw * gh * 2);
    applyOps(bf, gw, gh, W, H, ops);
    if (ops.protect.length) protectParts(bf, gw, gh, W, H, ops.protect);
    applyOps(bf, gw, gh, W, H, ops.after);
    for (let i = 0; i < bf.length; i++) field[i] += bf[i];
  }
  // Reshape's strokes go last, in drawing order, exactly as they were applied live.
  for (const s of pushes) applyStroke(field, gw, gh, W, H, s);
  return { field, gw, gh };
}

// Reshape strokes: { r, p } pushes (with a, the strength, when not 1), and { k: 'grow' | 'shrink' |
// 'restore', r, p } dabs, one at each stored point. Live strokes store a dab point every DAB_STEP × r,
// so replaying a stroke gives exactly what was drawn.
export const DAB_STEP = 0.35;
const GROW = 0.07, RESTORE = 0.4;

export function applyStroke(field, gw, gh, W, H, s) {
  if (!s.k) {
    for (let i = 2; i < s.p.length; i += 2) pushSegment(field, gw, gh, W, H, s.r, s.p[i - 2], s.p[i - 1], s.p[i], s.p[i + 1], s.a ?? 1);
    return;
  }
  for (let i = 0; i < s.p.length; i += 2) strokeDab(field, gw, gh, W, H, s, s.p[i], s.p[i + 1]);
}

export function strokeDab(field, gw, gh, W, H, s, x, y) {
  if (s.k === 'restore') restoreDab(field, gw, gh, W, H, s.r, x, y);
  else resizeDab(field, gw, gh, W, H, s.r, x, y, s.k === 'shrink' ? -GROW : GROW);
}

// The cells within r of (cx, cy), with their falloff (1 at the centre, 0 at r).
function eachCell(gw, gh, W, H, r, cx, cy, fn) {
  const sx = gw / W, sy = gh / H;
  const gx0 = Math.max(0, Math.floor((cx - r) * sx)), gx1 = Math.min(gw - 1, Math.ceil((cx + r) * sx));
  const gy0 = Math.max(0, Math.floor((cy - r) * sy)), gy1 = Math.min(gh - 1, Math.ceil((cy + r) * sy));
  for (let gy = gy0; gy <= gy1; gy++) {
    for (let gx = gx0; gx <= gx1; gx++) {
      const px = (gx + 0.5) / sx, py = (gy + 0.5) / sy;
      const q = ((px - cx) ** 2 + (py - cy) ** 2) / (r * r);
      if (q < 1) fn(gx, gy, px, py, q);
    }
  }
}

// Resize: what lies within r of (cx, cy) grows (k > 0) or shrinks (k < 0) about the centre, most at
// the centre and not at all at the rim. Composed onto the field like a push: a cell now shows what
// the field showed at its new sampling point. |k| ≤ 0.1 keeps every dab free of folds.
export function resizeDab(field, gw, gh, W, H, r, cx, cy, k) {
  const snap = snapshot(field, gw, gh, W, H, r, cx, cy, 2);
  eachCell(gw, gh, W, H, r, cx, cy, (gx, gy, px, py, q) => {
    const f = 1 - k * (1 - q) ** 2;
    const bx = cx + (px - cx) * f, by = cy + (py - cy) * f;
    const [ox, oy] = snap.at(bx * snap.sx - 0.5, by * snap.sy - 0.5);
    const i = (gy * gw + gx) * 2;
    field[i] = ox + (bx - px) / W;
    field[i + 1] = oy + (by - py) / H;
  });
}

// Restore: the field eases back toward no movement inside the brush.
export function restoreDab(field, gw, gh, W, H, r, cx, cy) {
  eachCell(gw, gh, W, H, r, cx, cy, (gx, gy, px, py, q) => {
    const keep = 1 - RESTORE * (1 - q) ** 2, i = (gy * gw + gx) * 2;
    field[i] *= keep;
    field[i + 1] *= keep;
  });
}

// A copy of the field round a brush (plus pad cells), read with bilinear filtering in cell units.
function snapshot(field, gw, gh, W, H, r, cx, cy, pad) {
  const sx = gw / W, sy = gh / H;
  const X0 = Math.max(0, Math.floor((cx - r) * sx) - pad), X1 = Math.min(gw - 1, Math.ceil((cx + r) * sx) + pad);
  const Y0 = Math.max(0, Math.floor((cy - r) * sy) - pad), Y1 = Math.min(gh - 1, Math.ceil((cy + r) * sy) + pad);
  const bw = X1 - X0 + 1;
  const snap = new Float32Array(bw * (Y1 - Y0 + 1) * 2);
  for (let y = Y0; y <= Y1; y++) snap.set(field.subarray((y * gw + X0) * 2, (y * gw + X1 + 1) * 2), (y - Y0) * bw * 2);
  const v = (x, y, c) => snap[((y - Y0) * bw + (x - X0)) * 2 + c];
  return {
    sx, sy,
    at(gx, gy) {
      gx = Math.min(X1, Math.max(X0, gx));
      gy = Math.min(Y1, Math.max(Y0, gy));
      const x0 = Math.floor(gx), y0 = Math.floor(gy), x1 = Math.min(X1, x0 + 1), y1 = Math.min(Y1, y0 + 1);
      const tx = gx - x0, ty = gy - y0;
      return [0, 1].map((c) => (v(x0, y0, c) * (1 - tx) + v(x1, y0, c) * tx) * (1 - ty) + (v(x0, y1, c) * (1 - tx) + v(x1, y1, c) * tx) * ty);
    },
  };
}

// Reshape › Protect: the painted mask (alpha, mw × mh) averaged over each warp-grid cell, 0–1.
export function protectMask(alpha, mw, mh, gw, gh) {
  const out = new Float32Array(gw * gh);
  for (let gy = 0; gy < gh; gy++) {
    const y0 = Math.floor((gy / gh) * mh), y1 = Math.max(y0 + 1, Math.floor(((gy + 1) / gh) * mh));
    for (let gx = 0; gx < gw; gx++) {
      const x0 = Math.floor((gx / gw) * mw), x1 = Math.max(x0 + 1, Math.floor(((gx + 1) / gw) * mw));
      let sum = 0;
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) sum += alpha[y * mw + x];
      out[gy * gw + gx] = sum / (255 * (x1 - x0) * (y1 - y0));
    }
  }
  return out;
}

// Every warp scaled by one minus the mask, so protected areas never move; with invert, only the
// painted areas can. Returns a new field.
export function protectField(field, mask, invert) {
  const out = new Float32Array(field.length);
  for (let i = 0; i < mask.length; i++) {
    const keep = invert ? mask[i] : 1 - mask[i];
    out[i * 2] = field[i * 2] * keep;
    out[i * 2 + 1] = field[i * 2 + 1] * keep;
  }
  return out;
}

function applyOps(field, gw, gh, W, H, { groups, bulges, turns = [], flows = [] }) {
  const cell = (fn, x0, y0, x1, y1) => {
    const gx0 = Math.max(0, Math.floor((x0 / W) * gw)), gx1 = Math.min(gw - 1, Math.ceil((x1 / W) * gw));
    const gy0 = Math.max(0, Math.floor((y0 / H) * gh)), gy1 = Math.min(gh - 1, Math.ceil((y1 / H) * gh));
    for (let gy = gy0; gy <= gy1; gy++) {
      for (let gx = gx0; gx <= gx1; gx++) {
        const [dx, dy] = fn(((gx + 0.5) / gw) * W, ((gy + 0.5) / gh) * H);
        const k = (gy * gw + gx) * 2;
        field[k] += dx / W;
        field[k + 1] += dy / H;
      }
    }
  };
  for (const g of groups) {
    if (!g.pts.length) continue;
    const xs = g.pts.map((q) => q.p[0]), ys = g.pts.map((q) => q.p[1]);
    cell((x, y) => {
      let sx = 0, sy = 0, sw = 0;
      for (const { p, v } of g.pts) {
        const q = ((x - p[0]) ** 2 + (y - p[1]) ** 2) / (g.R * g.R);
        if (q >= 1) continue;
        const w = (1 - q) ** 2;
        sx += w * v[0];
        sy += w * v[1];
        sw += w;
      }
      const n = Math.max(1, sw);
      return [-sx / n, -sy / n];
    }, Math.min(...xs) - g.R, Math.min(...ys) - g.R, Math.max(...xs) + g.R, Math.max(...ys) + g.R);
  }
  for (const b of bulges) {
    cell((x, y) => {
      const ux = x - b.c[0], uy = y - b.c[1];
      const q = (ux * ux + uy * uy) / (b.R * b.R);
      if (q >= 1) return [0, 0];
      const s = 1 - b.k * (1 - q) ** 2;
      return [ux * (s - 1), uy * (s - 1)];
    }, b.c[0] - b.R, b.c[1] - b.R, b.c[0] + b.R, b.c[1] + b.R);
  }
  // Flows: any backward offset, given directly by fn(x, y) in photo px (Sculpt's Top).
  for (const fl of flows) cell(fl.fn, ...fl.box);
  // Turns: a part rotated by th about pivot, by as much of th as its weight there (1 = rigidly).
  for (const t of turns) {
    cell((x, y) => {
      const w = t.weight([x, y]);
      if (w <= 0) return [0, 0];
      const a = -t.th * w, cs = Math.cos(a), sn = Math.sin(a), dx = x - t.pivot[0], dy = y - t.pivot[1];
      return [dx * cs - dy * sn - dx, dx * sn + dy * cs - dy];
    }, ...t.box);
  }
}

// One drag segment of the Push brush: content near a moves to b (times amt, the strength). For a
// backward field the update is d(x) ← d(x − m) − m with m = (b − a)·falloff, read from a snapshot so
// no cell sees a value already changed in this segment. Field values are in uv units; positions in
// image px.
export function pushSegment(field, gw, gh, W, H, r, ax, ay, bx, by, amt = 1) {
  const mx0 = (bx - ax) * amt, my0 = (by - ay) * amt;
  if (!mx0 && !my0) return;
  bx = ax + mx0;
  by = ay + my0;
  const sx = gw / W, sy = gh / H;
  const pad = Math.ceil(Math.max(Math.abs(mx0) * sx, Math.abs(my0) * sy)) + 2;
  const gx0 = Math.max(0, Math.floor((bx - r) * sx)), gx1 = Math.min(gw - 1, Math.ceil((bx + r) * sx));
  const gy0 = Math.max(0, Math.floor((by - r) * sy)), gy1 = Math.min(gh - 1, Math.ceil((by + r) * sy));
  const X0 = Math.max(0, gx0 - pad), X1 = Math.min(gw - 1, gx1 + pad);
  const Y0 = Math.max(0, gy0 - pad), Y1 = Math.min(gh - 1, gy1 + pad);
  const bw = X1 - X0 + 1;
  const snap = new Float32Array(bw * (Y1 - Y0 + 1) * 2);
  for (let y = Y0; y <= Y1; y++) snap.set(field.subarray((y * gw + X0) * 2, (y * gw + X1 + 1) * 2), (y - Y0) * bw * 2);
  const at = (x, y, c) => snap[((y - Y0) * bw + (x - X0)) * 2 + c];
  const sample = (gx, gy) => {
    gx = Math.min(X1, Math.max(X0, gx));
    gy = Math.min(Y1, Math.max(Y0, gy));
    const x0 = Math.floor(gx), y0 = Math.floor(gy), x1 = Math.min(X1, x0 + 1), y1 = Math.min(Y1, y0 + 1);
    const tx = gx - x0, ty = gy - y0;
    return [0, 1].map((c) => (at(x0, y0, c) * (1 - tx) + at(x1, y0, c) * tx) * (1 - ty) + (at(x0, y1, c) * (1 - tx) + at(x1, y1, c) * tx) * ty);
  };
  for (let gy = gy0; gy <= gy1; gy++) {
    for (let gx = gx0; gx <= gx1; gx++) {
      const px = (gx + 0.5) / sx, py = (gy + 0.5) / sy;
      const q = ((px - bx) ** 2 + (py - by) ** 2) / (r * r);
      if (q >= 1) continue;
      const w = (1 - q) ** 2, mx = mx0 * w, my = my0 * w;
      const [ox, oy] = sample((px - mx) * sx - 0.5, (py - my) * sy - 0.5);
      const k = (gy * gw + gx) * 2;
      field[k] = ox - mx / W;
      field[k + 1] = oy - my / H;
    }
  }
}
