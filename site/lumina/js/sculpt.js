// Sculpt: face shape sliders laid out as in AirBrush (evidence §9), on Lumina's own warp.
//
// Every control moves points of MediaPipe's face mesh. Which points move, and how much, is set in
// the mesh's canonical texture space (the space facemaps.js draws in), so a control always acts on
// the same part of a face whatever its shape or pose. Features a control must leave alone (the lips
// when the chin moves, the brows when the eyes grow) are protected in that space too. Each side of
// the face has its own value, so Left, Right or Both can be edited, and every face has its own set.
//
// The moved mesh, plus three rings of skirt points outside the face outline that let the hair, ears
// and neck follow, is rasterised into the backward warp grid: each grid cell inside a moved
// triangle gets the offset back to where that spot came from. That inverts the mesh's movement
// exactly, however far a feature moves, and leaves everything outside the skirt untouched. A face
// shape change is taken up close to the outline; a turn or nod of the head carries the hair with
// it and fades out further away, so the outline never folds against the skirt.

import { UV, TRIANGLES } from './facemesh-data.js';
import { IDX } from './face.js';

const N = 468;
const RING = IDX.oval;
const SKIRT = [1.2, 1.6, 2.1];     // the skirt rings, as multiples of the outline's distance from the face centre
const FOLLOW = [0.55, 0, 0];       // how much of the outline's movement each ring takes
const FOLLOW_HEAD = [1, 0.6, 0];   // … of the movement that comes from turning or nodding the head
const HEAD_CONTROLS = new Set(['turn', 'nod']);

export const SCULPT_TABS = [['head', 'Head'], ['face', 'Face'], ['jaw', 'Jaw'], ['eyes', 'Eyes'], ['nose', 'Nose'], ['lips', 'Lips'], ['brows', 'Brows']];

const clamp01 = (x) => Math.min(1, Math.max(0, x));
const smooth = (a, b, x) => {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};
// 1 at the centre of an ellipse (radii rx, ry) on the canonical face, smoothly 0 at its edge.
const blob = (u, v, c, rx, ry = rx) => {
  const q = ((u - c[0]) / rx) ** 2 + ((v - c[1]) / ry) ** 2;
  return q >= 1 ? 0 : (1 - q) ** 2;
};
const ell = (u, v, c, rx, ry) => Math.hypot((u - c[0]) / rx, (v - c[1]) / ry);

// Landmark positions on the canonical face, image-left half (the right half mirrors them).
const EYE = [0.3495, 0.3815], EYE_IN = [0.419, 0.387], EYE_OUT = [0.28, 0.376];
const BROW = [0.34, 0.284], BROW_PEAK = [0.327, 0.257], BROW_TAIL = [0.235, 0.302];
const MOUTH = [0.5, 0.694], CORNER = [0.382, 0.695], BOW_PEAK = [0.472, 0.65], BOW_DIP = [0.5, 0.652];

// Protected features: 1 on the feature, fading to 0 just outside it.
const GUARD = {
  eyes: (u, v) => 1 - smooth(1, 1.9, ell(u, v, EYE, 0.078, 0.036)),
  brows: (u, v) => 1 - smooth(1, 1.8, ell(u, v, BROW, 0.125, 0.034)),
  nose: (u, v) => Math.max(1 - smooth(1, 1.7, ell(u, v, [0.5, 0.56], 0.085, 0.055)),
    (1 - smooth(1, 1.8, (0.5 - u) / 0.035)) * smooth(0.34, 0.38, v) * (1 - smooth(0.5, 0.56, v))),
  lips: (u, v) => 1 - smooth(1, 1.7, ell(u, v, MOUTH, 0.13, 0.055)),
};

// Each control: where it acts (w, on the folded canonical face: u ≤ 0.5), what it protects, and
// which way a point moves at +100 (d, in photo px, written into o). F is the face (see context()),
// i the point and s its side (−1 image left, 1 image right). `sides` controls have a value per side.
const C = (id, tab, label, o) => ({ id, tab, label, icon: `sc-${id}`, min: -100, sides: false, guard: [], ...o });
const along = (o, ax, k) => { o[0] = ax[0] * k; o[1] = ax[1] * k; };
const from = (o, F, i, c, k) => { o[0] = (F.P[i][0] - c[0]) * k; o[1] = (F.P[i][1] - c[1]) * k; };
const proj = (F, i, c, ax) => (F.P[i][0] - c[0]) * ax[0] + (F.P[i][1] - c[1]) * ax[1];
const both = (o, F, kx, ky) => {
  o[0] = F.X[0] * kx + F.Y[0] * ky;
  o[1] = F.X[1] * kx + F.Y[1] * ky;
};
// A small turn of th radians about c, in the face's own frame (positive turns clockwise on screen).
const turn = (o, F, i, c, th) => {
  const dx = F.P[i][0] - c[0], dy = F.P[i][1] - c[1];
  both(o, F, -th * (dx * F.Y[0] + dy * F.Y[1]), th * (dx * F.X[0] + dy * F.X[1]));
};
const side = (s) => (s < 0 ? 0 : 1);

export const SCULPT_CONTROLS = [
  C('headSize', 'head', 'Size', { op: true }),
  // Turn and Up / down: points nearer the camera move further (MediaPipe's depth is roughly twice the
  // real one, hence the small factor), and the whole head shifts a little the same way, so the far
  // cheek is foreshortened without folding against the outline.
  C('turn', 'head', 'Turn', { w: () => 1, d: (o, F, i) => along(o, F.X, -0.13 * F.z[i] + 0.035 * F.fw) }),
  C('nod', 'head', 'Up / down', { w: () => 1, d: (o, F, i) => along(o, F.Y, 0.09 * F.z[i] - 0.025 * F.fh) }),

  C('width', 'face', 'Width', {
    sides: true, guard: ['eyes', 'brows', 'nose', 'lips'],
    w: (u, v) => smooth(0.1, 0.42, 0.5 - u) * smooth(0.15, 0.3, v), d: (o, F, i) => along(o, F.X, 0.07 * F.a[i]),
  }),
  C('slim', 'face', 'Slim', {
    sides: true, guard: ['lips', 'nose'],
    w: (u, v) => smooth(0.06, 0.36, 0.5 - u) * smooth(0.42, 0.62, v), d: (o, F, i) => along(o, F.X, -0.09 * F.a[i]),
  }),
  C('length', 'face', 'Length', {
    w: () => 1, d: (o, F, i) => along(o, F.Y, 0.06 * Math.max(0, F.b[i] - F.bEye) - 0.035 * Math.max(0, F.bBrow - F.b[i])),
  }),
  C('size', 'face', 'Size', { w: () => 1, d: (o, F, i) => from(o, F, i, F.Fc, 0.07) }),
  C('forehead', 'face', 'Forehead', {
    guard: ['brows', 'eyes'], w: (u, v) => 1 - smooth(0.13, 0.34, v),
    d: (o, F, i) => {
      const dx = F.P[i][0] - F.FH[0], dy = F.P[i][1] - F.FH[1], l = Math.hypot(dx, dy) || 1;
      o[0] = (dx / l) * 0.065 * F.fw;
      o[1] = (dy / l) * 0.065 * F.fw;
    },
  }),
  C('hairline', 'face', 'Hairline', { guard: ['brows'], w: (u, v) => 1 - smooth(0.13, 0.31, v), d: (o, F) => along(o, F.Y, -0.075 * F.fh) }),
  C('temples', 'face', 'Temples', {
    sides: true, guard: ['eyes', 'brows'], w: (u, v) => blob(u, v, [0.1, 0.27], 0.17), d: (o, F, i, s) => along(o, F.X, s * 0.065 * F.fw),
  }),
  C('cheekbones', 'face', 'Cheekbones', {
    sides: true, guard: ['eyes'], w: (u, v) => blob(u, v, [0.06, 0.47], 0.2), d: (o, F, i, s) => along(o, F.X, s * 0.065 * F.fw),
  }),
  C('midface', 'face', 'Midface', { guard: ['eyes'], w: (u, v) => smooth(0.42, 0.64, v), d: (o, F) => along(o, F.Y, 0.05 * F.fh) }),
  C('philtrum', 'face', 'Philtrum', {
    guard: ['nose'], w: (u, v) => smooth(0.6, 0.66, v) * (1 - smooth(0.76, 0.95, v)), d: (o, F) => along(o, F.Y, 0.035 * F.fh),
  }),
  C('lift', 'face', 'Lift', {
    min: 0, sides: true, guard: ['lips'],
    w: (u, v) => smooth(0.55, 0.8, v) * smooth(0.12, 0.4, 0.5 - u), d: (o, F, i, s) => both(o, F, -s * 0.018 * F.fw, -0.05 * F.fh),
  }),
  // The lower third, from the base of the nose to the chin, lengthens: the further below the nose a
  // point is, the further it moves, so the lips shift a little and the chin most.
  C('lowerFace', 'face', 'Lower face', { w: (u, v) => smooth(0.55, 0.62, v), d: (o, F, i) => along(o, F.Y, 0.1 * Math.max(0, F.b[i] - F.bNose)) }),
  // The crown of the head rises (AirBrush's "Top", a high head top): a warp over the hair, not the mesh.
  C('top', 'face', 'Top', { op: true }),

  C('chin', 'jaw', 'Chin', {
    guard: ['lips'], w: (u, v) => smooth(0.755, 0.93, v) * (1 - smooth(0.14, 0.32, 0.5 - u)), d: (o, F) => along(o, F.Y, 0.07 * F.fh),
  }),
  C('chinWidth', 'jaw', 'Chin width', {
    guard: ['lips'], w: (u, v) => smooth(0.8, 0.93, v) * (1 - smooth(0.12, 0.28, 0.5 - u)), d: (o, F, i) => along(o, F.X, 0.35 * F.a[i]),
  }),
  C('jawAngle', 'jaw', 'Jaw angle', {
    sides: true, guard: ['lips'], w: (u, v) => blob(u, v, [0.15, 0.8], 0.17), d: (o, F, i, s) => along(o, F.X, s * 0.065 * F.fw),
  }),
  C('jawline', 'jaw', 'Jawline', {
    sides: true, guard: ['lips'], w: (u, v) => blob(u, v, [0.26, 0.885], 0.15), d: (o, F, i, s) => both(o, F, -s * 0.045 * F.fw, -0.03 * F.fh),
  }),
  // The whole lower jaw, angles included, moves down (Chin moves only its middle).
  C('jawLength', 'jaw', 'Length', { guard: ['lips'], w: (u, v) => smooth(0.74, 0.92, v), d: (o, F) => along(o, F.Y, 0.05 * F.fh) }),
  // Jaw shape, AirBrush's V-line: the whole lower outline, both sides at once, from a rounder U toward
  // a sharper V. The sides between the jaw's corners and the chin draw in, most at mid-jaw, and the
  // chin's tip lengthens a little; below zero the outline rounds out.
  C('jawShape', 'jaw', 'Shape', {
    guard: ['lips'], w: (u, v) => smooth(0.72, 0.86, v),
    d: (o, F, i) => both(o, F, -0.16 * F.a[i] * smooth(0.02, 0.2, 0.5 - Math.min(UV[i * 2], 1 - UV[i * 2])), 0.025 * F.fh * (1 - smooth(0.04, 0.2, 0.5 - Math.min(UV[i * 2], 1 - UV[i * 2])))),
  }),

  C('eyeSize', 'eyes', 'Size', { sides: true, guard: ['brows'], w: (u, v) => blob(u, v, EYE, 0.13), d: (o, F, i, s) => from(o, F, i, F.eye[side(s)], 0.16) }),
  C('eyeHeight', 'eyes', 'Height', {
    sides: true, guard: ['brows'], w: (u, v) => blob(u, v, EYE, 0.11, 0.1), d: (o, F, i, s) => along(o, F.Y, 0.28 * proj(F, i, F.eye[side(s)], F.Y)),
  }),
  C('eyeWidth', 'eyes', 'Width', {
    sides: true, guard: ['brows'], w: (u, v) => blob(u, v, EYE, 0.13, 0.1), d: (o, F, i, s) => along(o, F.X, 0.16 * proj(F, i, F.eye[side(s)], F.X)),
  }),
  C('eyeDistance', 'eyes', 'Distance', {
    sides: true, guard: ['brows', 'nose'], w: (u, v) => blob(u, v, EYE, 0.14, 0.12), d: (o, F, i, s) => along(o, F.X, s * 0.13 * F.ew[side(s)]),
  }),
  C('eyeTilt', 'eyes', 'Tilt', { sides: true, guard: ['brows'], w: (u, v) => blob(u, v, EYE, 0.11, 0.09), d: (o, F, i, s) => turn(o, F, i, F.eye[side(s)], -s * 0.12) }),
  C('eyePosition', 'eyes', 'Position', {
    sides: true, guard: ['brows'], w: (u, v) => blob(u, v, EYE, 0.12, 0.1), d: (o, F, i, s) => along(o, F.Y, -0.12 * F.ew[side(s)]),
  }),
  C('eyeInner', 'eyes', 'Inner corner', {
    sides: true, guard: ['nose'], w: (u, v) => blob(u, v, EYE_IN, 0.065, 0.06), d: (o, F, i, s) => along(o, F.X, -s * 0.18 * F.ew[side(s)]),
  }),
  C('eyeOuter', 'eyes', 'Outer corner', {
    sides: true, guard: ['brows'], w: (u, v) => blob(u, v, EYE_OUT, 0.075, 0.065), d: (o, F, i, s) => along(o, F.X, s * 0.18 * F.ew[side(s)]),
  }),
  // The outer corner alone lifts (a cat-eye line) or, below zero, drops (softer, rounder eyes).
  C('eyeTail', 'eyes', 'Tail', {
    sides: true, guard: ['brows'], w: (u, v) => blob(u, v, EYE_OUT, 0.06, 0.055), d: (o, F, i, s) => along(o, F.Y, -0.11 * F.ew[side(s)]),
  }),

  C('noseSize', 'nose', 'Size', { guard: ['eyes', 'lips'], w: (u, v) => blob(u, v, [0.5, 0.53], 0.12, 0.15), d: (o, F, i) => from(o, F, i, F.nose, 0.15) }),
  C('noseWidth', 'nose', 'Width', {
    sides: true, guard: ['lips', 'eyes'], w: (u, v) => blob(u, v, [0.5, 0.57], 0.13, 0.075) * smooth(0.45, 0.52, v), d: (o, F, i) => along(o, F.X, 0.3 * F.a[i]),
  }),
  C('noseLength', 'nose', 'Length', { guard: ['lips'], w: (u, v) => blob(u, v, [0.5, 0.56], 0.12, 0.085), d: (o, F) => along(o, F.Y, 0.045 * F.fh) }),
  C('noseBridge', 'nose', 'Bridge', {
    guard: ['eyes'], w: (u, v) => blob(u, 0, [0.5, 0], 0.075, 1) * smooth(0.34, 0.4, v) * (1 - smooth(0.48, 0.54, v)), d: (o, F, i) => along(o, F.X, 0.8 * F.a[i]),
  }),
  C('noseTip', 'nose', 'Tip', { guard: ['lips'], w: (u, v) => blob(u, v, [0.5, 0.535], 0.065), d: (o, F) => along(o, F.Y, -0.045 * F.fh) }),
  // Root (AirBrush's "Root lift", 山根): the top of the nose between the eyes narrows, which reads
  // as a higher root; its icon is a front-view nose with arrows pressing in at the top.
  C('noseRoot', 'nose', 'Root', {
    guard: ['eyes'], w: (u, v) => blob(u, v, [0.5, 0.41], 0.075, 0.07), d: (o, F, i) => along(o, F.X, -0.7 * F.a[i]),
  }),

  C('lipSize', 'lips', 'Size', { guard: ['nose'], w: (u, v) => blob(u, v, MOUTH, 0.16, 0.085), d: (o, F, i) => from(o, F, i, F.mouth, 0.15) }),
  C('lipWidth', 'lips', 'Width', { w: (u, v) => blob(u, v, MOUTH, 0.16, 0.085), d: (o, F, i) => along(o, F.X, 0.15 * proj(F, i, F.mouth, F.X)) }),
  C('lipUpper', 'lips', 'Upper lip', {
    guard: ['nose'], w: (u, v) => blob(u, v, MOUTH, 0.16, 0.085), d: (o, F, i) => along(o, F.Y, 0.3 * Math.min(0, proj(F, i, F.mouth, F.Y))),
  }),
  C('lipLower', 'lips', 'Lower lip', { w: (u, v) => blob(u, v, MOUTH, 0.16, 0.085), d: (o, F, i) => along(o, F.Y, 0.3 * Math.max(0, proj(F, i, F.mouth, F.Y))) }),
  C('lipPosition', 'lips', 'Position', { guard: ['nose'], w: (u, v) => blob(u, v, MOUTH, 0.2, 0.11), d: (o, F) => along(o, F.Y, -0.035 * F.fh) }),
  C('smile', 'lips', 'Smile', { sides: true, w: (u, v) => blob(u, v, CORNER, 0.075), d: (o, F, i, s) => both(o, F, s * 0.02 * F.mw, -0.09 * F.mw) }),
  C('cupid', 'lips', 'Cupid’s bow', { w: (u, v) => blob(u, v, BOW_PEAK, 0.032) - 0.35 * blob(u, v, BOW_DIP, 0.018), d: (o, F) => along(o, F.Y, -0.05 * F.mw) }),

  C('browDistance', 'brows', 'Distance', {
    sides: true, guard: ['eyes'], w: (u, v) => blob(u, v, BROW, 0.16, 0.065), d: (o, F, i, s) => along(o, F.X, s * 0.12 * F.bw[side(s)]),
  }),
  C('browLift', 'brows', 'Lift', { sides: true, guard: ['eyes'], w: (u, v) => blob(u, v, BROW, 0.16, 0.07), d: (o, F) => along(o, F.Y, -0.045 * F.fh) }),
  C('browArch', 'brows', 'Arch', { sides: true, guard: ['eyes'], w: (u, v) => blob(u, v, BROW_PEAK, 0.07, 0.06), d: (o, F) => along(o, F.Y, -0.03 * F.fh) }),
  C('browTilt', 'brows', 'Tilt', { sides: true, guard: ['eyes'], w: (u, v) => blob(u, v, BROW, 0.15, 0.065), d: (o, F, i, s) => turn(o, F, i, F.brow[side(s)], -s * 0.12) }),
  C('browLength', 'brows', 'Length', { sides: true, guard: ['eyes'], w: (u, v) => blob(u, v, BROW_TAIL, 0.075, 0.06), d: (o, F, i, s) => along(o, F.X, s * 0.07 * F.fw) }),
  C('browThickness', 'brows', 'Thickness', {
    sides: true, guard: ['eyes'], w: (u, v) => blob(u, v, BROW, 0.15, 0.06), d: (o, F, i, s) => along(o, F.Y, 0.35 * proj(F, i, F.brow[side(s)], F.Y)),
  }),
];
export const SCULPT_BY_ID = Object.fromEntries(SCULPT_CONTROLS.map((c) => [c.id, c]));
const MESH_CONTROLS = SCULPT_CONTROLS.filter((c) => !c.op);

// A face's values: { [control]: [image-left, image-right] }; a control without sides uses the first.
const live = (v) => Boolean(v && (v[0] || v[1]));
export const sculptActive = (values) => Boolean(values && Object.values(values).some(live));

// Where each control acts, with its protected features taken out (per mesh point, computed once).
const weightCache = new Map();
function weights(c) {
  let w = weightCache.get(c.id);
  if (w) return w;
  w = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const u = Math.min(UV[i * 2], 1 - UV[i * 2]), v = UV[i * 2 + 1];
    let k = c.w(u, v);
    for (const g of c.guard) k *= 1 - GUARD[g](u, v);
    w[i] = k;
  }
  weightCache.set(c.id, w);
  return w;
}

const mid = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

// The measurements the controls work from, in photo px.
function context(f) {
  const P = f.P, X = f.xAxis, Y = f.yAxis, M0 = P[168];
  const a = new Float32Array(N), b = new Float32Array(N), z = new Float32Array(N);
  const zp = ((f.Z?.[234] || 0) + (f.Z?.[454] || 0)) / 2;
  for (let i = 0; i < N; i++) {
    const dx = P[i][0] - M0[0], dy = P[i][1] - M0[1];
    a[i] = dx * X[0] + dy * X[1];
    b[i] = dx * Y[0] + dy * Y[1];
    z[i] = (f.Z?.[i] || 0) - zp;
  }
  const mean = (ids) => ids.reduce((s, i) => [s[0] + P[i][0] / ids.length, s[1] + P[i][1] / ids.length], [0, 0]);
  const down = (p) => (p[0] - M0[0]) * Y[0] + (p[1] - M0[1]) * Y[1];
  const brow = [mean(IDX.browR), mean(IDX.browL)];
  return {
    P, X, Y, a, b, z, fw: f.fw, fh: f.fh,
    Fc: mid(P[10], P[152]), FH: P[9],
    eye: [f.eyeR.c, f.eyeL.c], ew: [f.eyeR.w, f.eyeL.w],
    brow, bw: [dist(P[70], P[107]), dist(P[300], P[336])],
    mouth: f.mouth.c, mw: f.mouth.w,
    nose: [P[4][0] * 0.7 + P[2][0] * 0.3, P[4][1] * 0.7 + P[2][1] * 0.3],
    bEye: down(mid(f.eyeR.c, f.eyeL.c)), bBrow: (down(brow[0]) + down(brow[1])) / 2, bNose: down(P[2]),
  };
}

// How far each mesh point moves (photo px, interleaved x, y) for one face's values; head is the
// part of it that comes from turning or nodding the head.
function meshDisplacement(f, values) {
  const F = context(f);
  const d = new Float32Array(N * 2), head = new Float32Array(N * 2), o = [0, 0];
  for (const c of MESH_CONTROLS) {
    const val = values[c.id];
    if (!live(val)) continue;
    const w = weights(c), into = HEAD_CONTROLS.has(c.id);
    for (let i = 0; i < N; i++) {
      if (!w[i]) continue;
      const u = UV[i * 2], s = u < 0.5 ? -1 : 1;
      const k = c.sides ? val[0] + (val[1] - val[0]) * smooth(0.46, 0.54, u) : val[0];
      if (!k) continue;
      c.d(o, F, i, s);
      d[i * 2] += o[0] * k * w[i];
      d[i * 2 + 1] += o[1] * k * w[i];
      if (into) {
        head[i * 2] += o[0] * k * w[i];
        head[i * 2 + 1] += o[1] * k * w[i];
      }
    }
  }
  // However the controls stack up, no point moves more than 12% of the face's width.
  const cap = 0.12 * f.fw;
  for (let i = 0; i < N; i++) {
    const l = Math.hypot(d[i * 2], d[i * 2 + 1]);
    if (l > cap) {
      for (const a of [d, head]) {
        a[i * 2] *= cap / l;
        a[i * 2 + 1] *= cap / l;
      }
    }
  }
  return { d, head, F };
}

// No triangle of the moved mesh or its skirt may shrink below a third of its area or turn over (a
// fold), nor grow to more than two and a half times it: the warp shows either as a torn or smeared
// edge, as when a turned head pulls the thin band of triangles along the far cheek's outline. Where
// one would, its corners' movements are drawn toward their average, a few rounds over, so the change
// spreads out instead. Vertices from `fixed` on (the outermost ring) never move.
function foldGuard(rest, disp, tris, fixed) {
  for (let round = 0; round < 16; round++) {
    let bad = 0;
    for (let t = 0; t < tris.length; t += 3) {
      const a = tris[t], b = tris[t + 1], c = tris[t + 2];
      const a0 = (rest[b * 2] - rest[a * 2]) * (rest[c * 2 + 1] - rest[a * 2 + 1]) - (rest[c * 2] - rest[a * 2]) * (rest[b * 2 + 1] - rest[a * 2 + 1]);
      if (Math.abs(a0) < 1e-6) continue;
      const ax = rest[a * 2] + disp[a * 2], ay = rest[a * 2 + 1] + disp[a * 2 + 1], bx = rest[b * 2] + disp[b * 2], by = rest[b * 2 + 1] + disp[b * 2 + 1];
      const cx = rest[c * 2] + disp[c * 2], cy = rest[c * 2 + 1] + disp[c * 2 + 1];
      const ratio = ((bx - ax) * (cy - ay) - (cx - ax) * (by - ay)) / a0;
      if (ratio >= 0.35 && ratio <= 2.5) continue;
      bad++;
      const mx = (disp[a * 2] + disp[b * 2] + disp[c * 2]) / 3, my = (disp[a * 2 + 1] + disp[b * 2 + 1] + disp[c * 2 + 1]) / 3;
      for (const v of [a, b, c]) {
        if (v >= fixed) continue;
        disp[v * 2] += (mx - disp[v * 2]) * 0.5;
        disp[v * 2 + 1] += (my - disp[v * 2 + 1]) * 0.5;
      }
    }
    if (!bad) break;
  }
}

// Top: everything above the brows stretches upward. Height above the brow line, t, samples from
// t − Δ·g(t), where g rises from 0 at the brows to 1 at the crown (taken as twice the forehead's
// height above the brows) and falls back to 0 a little above it, so the hair grows taller and the
// background above is gently squeezed. Δ ≤ 18% of the forehead keeps it free of folds; the effect
// fades out sideways past the face's width.
function crown(f, k) {
  const mean = (ids) => ids.reduce((s, i) => [s[0] + f.P[i][0] / ids.length, s[1] + f.P[i][1] / ids.length], [0, 0]);
  const B = mid(mean(IDX.browR), mean(IDX.browL)), X = f.xAxis, Y = f.yAxis;
  const fore = Math.max(1, -((f.P[10][0] - B[0]) * Y[0] + (f.P[10][1] - B[1]) * Y[1]));
  const T = 2 * fore, D = 0.18 * fore * k, half = 0.55 * f.fw;
  const xs = [-1, 1].flatMap((sx) => [-0.4, 1.7].map((st) => [B[0] + X[0] * sx * 1.5 * half - Y[0] * st * T, B[1] + X[1] * sx * 1.5 * half - Y[1] * st * T]));
  return {
    box: [Math.min(...xs.map((p) => p[0])), Math.min(...xs.map((p) => p[1])), Math.max(...xs.map((p) => p[0])), Math.max(...xs.map((p) => p[1]))],
    fn: (x, y) => {
      const dx = x - B[0], dy = y - B[1];
      const t = -(dx * Y[0] + dy * Y[1]), a = Math.abs(dx * X[0] + dy * X[1]);
      if (t <= 0 || t >= 1.6 * T) return [0, 0];
      const g = t < T ? smooth(0, T, t) : 1 - smooth(T, 1.6 * T, t);
      const m = D * g * (1 - smooth(half, 1.5 * half, a));
      return [Y[0] * m, Y[1] * m];
    },
  };
}

// The mesh's triangles plus the skirt: the outline joined to ring 1, each ring to the next.
let triCache = null;
function triangles() {
  if (triCache) return triCache;
  const t = Array.from(TRIANGLES), n = RING.length;
  for (let k = 0; k < n; k++) {
    const k1 = (k + 1) % n;
    t.push(RING[k], RING[k1], N + k, RING[k1], N + k1, N + k);
    for (let r = 1; r < SKIRT.length; r++) {
      const a = N + (r - 1) * n, b = N + r * n;
      t.push(a + k, a + k1, b + k, a + k1, b + k1, b + k);
    }
  }
  triCache = new Uint16Array(t);
  return triCache;
}

// Adds one face's Sculpt to the backward warp `field` (gw × gh cells of uv offsets). Returns the
// face's extra local ops (head size is a bulge over the whole head, not a mesh movement).
export function sculptFace(field, gw, gh, W, H, f, values) {
  const ops = { groups: [], bulges: [], flows: [] };
  if (!sculptActive(values)) return ops;
  if (live(values.headSize)) {
    const c = [f.center[0] - f.yAxis[0] * 0.12 * f.fh, f.center[1] - f.yAxis[1] * 0.12 * f.fh];
    ops.bulges.push({ c, R: f.fh * 1.2, k: values.headSize[0] * 0.2 });
  }
  if (live(values.top)) ops.flows.push(crown(f, values.top[0]));
  const { d, head, F } = meshDisplacement(f, values);
  let moved = false;
  for (let i = 0; i < N * 2 && !moved; i++) moved = Math.abs(d[i]) > 0.02;
  if (!moved) return ops;
  // Vertices: the 468 mesh points, then the skirt rings, where they sit and how far they move.
  const n = RING.length, total = N + n * SKIRT.length;
  const rest = new Float32Array(total * 2), disp = new Float32Array(total * 2);
  for (let i = 0; i < N; i++) {
    rest[i * 2] = F.P[i][0];
    rest[i * 2 + 1] = F.P[i][1];
    disp[i * 2] = d[i * 2];
    disp[i * 2 + 1] = d[i * 2 + 1];
  }
  RING.forEach((ri, k) => {
    for (let r = 0; r < SKIRT.length; r++) {
      const j = N + r * n + k;
      rest[j * 2] = F.Fc[0] + (F.P[ri][0] - F.Fc[0]) * SKIRT[r];
      rest[j * 2 + 1] = F.Fc[1] + (F.P[ri][1] - F.Fc[1]) * SKIRT[r];
      disp[j * 2] = (d[ri * 2] - head[ri * 2]) * FOLLOW[r] + head[ri * 2] * FOLLOW_HEAD[r];
      disp[j * 2 + 1] = (d[ri * 2 + 1] - head[ri * 2 + 1]) * FOLLOW[r] + head[ri * 2 + 1] * FOLLOW_HEAD[r];
    }
  });
  const tris = triangles();
  foldGuard(rest, disp, tris, N + n * (SKIRT.length - 1));
  const pos = new Float32Array(total * 2), off = new Float32Array(total * 2), depth = new Float32Array(total);
  for (let i = 0; i < total * 2; i++) {
    pos[i] = rest[i] + disp[i];
    off[i] = -disp[i];
  }
  for (let i = 0; i < total; i++) depth[i] = i < N ? F.z[i] : 1e6 + i;
  rasterise(field, gw, gh, W, H, pos, off, depth, tris);
  return ops;
}

// Fills every grid cell whose centre lies in the moved mesh or skirt with the covering triangle's
// interpolated offset. Where triangles overlap (a face turned partly away lays the far side of its
// mesh over itself), the one nearest the camera wins, as in the photo; the skirt lies behind them all.
function rasterise(field, gw, gh, W, H, pos, off, depth, tris) {
  const sx = gw / W, sy = gh / H;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let i = 0; i < pos.length; i += 2) {
    minX = Math.min(minX, pos[i] * sx);
    maxX = Math.max(maxX, pos[i] * sx);
    minY = Math.min(minY, pos[i + 1] * sy);
    maxY = Math.max(maxY, pos[i + 1] * sy);
  }
  const bx0 = Math.max(0, Math.floor(minX)), bx1 = Math.min(gw - 1, Math.ceil(maxX));
  const by0 = Math.max(0, Math.floor(minY)), by1 = Math.min(gh - 1, Math.ceil(maxY));
  if (bx1 < bx0 || by1 < by0) return;
  const bw = bx1 - bx0 + 1, bh = by1 - by0 + 1;
  const zbuf = new Float32Array(bw * bh).fill(Infinity), ox = new Float32Array(bw * bh), oy = new Float32Array(bw * bh);
  for (let t = 0; t < tris.length; t += 3) {
    const a = tris[t], b = tris[t + 1], c = tris[t + 2];
    const ax = pos[a * 2] * sx, ay = pos[a * 2 + 1] * sy, bx = pos[b * 2] * sx, by = pos[b * 2 + 1] * sy, cx = pos[c * 2] * sx, cy = pos[c * 2 + 1] * sy;
    const area = (bx - ax) * (cy - ay) - (cx - ax) * (by - ay);
    if (Math.abs(area) < 1e-9) continue;
    const x0 = Math.max(bx0, Math.ceil(Math.min(ax, bx, cx) - 0.5)), x1 = Math.min(bx1, Math.floor(Math.max(ax, bx, cx) - 0.5));
    const y0 = Math.max(by0, Math.ceil(Math.min(ay, by, cy) - 0.5)), y1 = Math.min(by1, Math.floor(Math.max(ay, by, cy) - 0.5));
    for (let gy = y0; gy <= y1; gy++) {
      const py = gy + 0.5;
      for (let gx = x0; gx <= x1; gx++) {
        const px = gx + 0.5;
        const w0 = ((bx - px) * (cy - py) - (cx - px) * (by - py)) / area;
        const w1 = ((cx - px) * (ay - py) - (ax - px) * (cy - py)) / area;
        const w2 = 1 - w0 - w1;
        if (w0 < -1e-6 || w1 < -1e-6 || w2 < -1e-6) continue;
        const k = (gy - by0) * bw + gx - bx0, z = w0 * depth[a] + w1 * depth[b] + w2 * depth[c];
        if (z >= zbuf[k]) continue;
        zbuf[k] = z;
        ox[k] = w0 * off[a * 2] + w1 * off[b * 2] + w2 * off[c * 2];
        oy[k] = w0 * off[a * 2 + 1] + w1 * off[b * 2 + 1] + w2 * off[c * 2 + 1];
      }
    }
  }
  for (let gy = by0; gy <= by1; gy++) {
    for (let gx = bx0; gx <= bx1; gx++) {
      const k = (gy - by0) * bw + gx - bx0;
      if (zbuf[k] === Infinity) continue;
      const o = (gy * gw + gx) * 2;
      field[o] += ox[k] / W;
      field[o + 1] += oy[k] / H;
    }
  }
}
