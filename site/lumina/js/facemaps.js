// Region templates, the way AirBrush builds them (evidence §8): soft maps painted once on a
// standard face, then warped onto each photo through the face mesh. Ours are drawn here, in the
// texture space of MediaPipe's canonical face mesh, from the mesh's own landmark positions; the GPU
// stretches them over the 468 detected points (plus a skirt past the face outline for the jaw).
//
// Atlas channels:
//   crease  r forehead lines   g crow's feet    b smile lines      a under-eye lines
//   zone    r eye bags         g tear troughs   b redness areas    a beard area
//   fill    r forehead         g temples, brow  b cheek hollows    a eye sockets
//   sculpt  r contour          g highlight      b jaw shadow       a stronger (masculine) contour
//   age     r fine lines       g eye bags       b where age spots gather   a hollows

import { UV, TRIANGLES } from './facemesh-data.js';
import { IDX } from './face.js';
import { blurChannel } from './blur.js';

export const ATLAS = 512;
const K = 0.72;                  // the face fills the middle 72% of an atlas; the rest is skirt
const SKIRT = 1.3;               // skirt ring: the outline pushed out 30% from the face centre
const UV_CENTRE = [0.5, 0.53];

const uvOf = (i) => [UV[i * 2], UV[i * 2 + 1]];
const mirror = ([u, v]) => [1 - u, v];
const toAtlas = ([u, v]) => [(0.5 + (u - 0.5) * K) * ATLAS, (0.5 + (v - 0.5) * K) * ATLAS];
const out = (p, k) => [UV_CENTRE[0] + (p[0] - UV_CENTRE[0]) * k, UV_CENTRE[1] + (p[1] - UV_CENTRE[1]) * k];

// Shapes in canonical uv. `both` repeats a shape for the other side of the face.
const ell = (c, rx, ry, rot = 0, a = 1) => ({ t: 'ell', c, rx, ry, rot, a });
const line = (pts, w, a = 1) => ({ t: 'line', pts, w, a });
const both = (s) => {
  const m = structuredClone(s);
  if (m.c) {
    m.c = mirror(m.c);
    m.rot = -m.rot;
  }
  if (m.pts) m.pts = m.pts.map(mirror);
  return [s, m];
};
const ovalPts = (ids, k = 1) => ids.map((i) => out(uvOf(i), k));
const LOWER_OVAL = [127, 234, 93, 132, 58, 172, 136, 150, 149, 176, 148, 152];
const UPPER_OVAL = [162, 21, 54, 103, 67, 109, 10];

function templates() {
  const smile = [[0.405, 0.565], [0.38, 0.61], [0.357, 0.655], [0.345, 0.69]];
  const marionette = [[0.36, 0.72], [0.375, 0.765], [0.392, 0.8]];
  const trough = [[0.418, 0.41], [0.395, 0.435], [0.36, 0.455], [0.325, 0.462]];
  return {
    crease: [
      { feather: 10, shapes: [ell([0.5, 0.185], 0.27, 0.072), ell([0.5, 0.288], 0.035, 0.042, 0, 0.8)] },
      { feather: 8, shapes: both(ell([0.218, 0.385], 0.045, 0.062, -0.2)) },
      { feather: 6, shapes: [...both(line(smile, 0.03)), ...both(line(marionette, 0.025, 0.7))] },
      { feather: 6, shapes: both(ell([0.345, 0.427], 0.075, 0.022, 0.05)) },
    ],
    zone: [
      { feather: 8, shapes: both(ell([0.345, 0.448], 0.07, 0.03)) },
      { feather: 6, shapes: both(line(trough, 0.028)) },
      {
        feather: 8,
        shapes: [
          ...both(ell([0.41, 0.57], 0.035, 0.03)), ...both(line(smile, 0.035, 0.8)), ...both(ell([0.345, 0.44], 0.07, 0.035, 0, 0.6)),
          ...both(line(ovalPts(LOWER_OVAL.slice(2), 0.93), 0.05, 0.6)), ell([0.5, 0.54], 0.03, 0.035), ell([0.5, 0.88], 0.06, 0.035, 0, 0.6),
        ],
      },
      { feather: 10, shapes: [ell([0.5, 0.8], 0.4, 0.19), ell([0.5, 0.627], 0.12, 0.028), ...both(ell([0.2, 0.7], 0.12, 0.14))] },
    ],
    fill: [
      { feather: 16, shapes: [ell([0.5, 0.19], 0.26, 0.085)] },
      { feather: 12, shapes: [...both(ell([0.13, 0.27], 0.06, 0.08)), ...both(ell([0.33, 0.236], 0.08, 0.022, -0.05, 0.7))] },
      { feather: 14, shapes: [...both(ell([0.235, 0.645], 0.065, 0.06)), ...both(ell([0.31, 0.545], 0.07, 0.05, 0, 0.6))] },
      { feather: 8, shapes: both(ell([0.345, 0.325], 0.075, 0.024)) },
    ],
    // Age › Older: lines (three across the forehead, two frown lines, crow's feet, under-eye, smile and
    // marionette lines, lines over the lip), the pouch under each eye, where age spots gather (cheekbones,
    // temples, forehead), and the hollows that deepen (temples, cheeks, upper eye sockets).
    age: [
      {
        feather: 2,
        shapes: [
          ...[0.172, 0.207, 0.242].map((v, i) => line([[0.31, v + 0.006], [0.37, v], [0.43, v + 0.004], [0.5, v - 0.002], [0.57, v + 0.004], [0.63, v], [0.69, v + 0.006]], 0.0065 - i * 0.0005, 0.95 - i * 0.15)),
          ...both(line([[0.478, 0.262], [0.474, 0.29], [0.472, 0.312]], 0.005, 0.8)),
          ...both(line([[0.266, 0.366], [0.238, 0.354], [0.214, 0.345]], 0.005, 0.85)),
          ...both(line([[0.262, 0.381], [0.235, 0.384], [0.208, 0.39]], 0.005, 0.85)),
          ...both(line([[0.268, 0.395], [0.245, 0.41], [0.226, 0.428]], 0.005, 0.75)),
          ...both(line([[0.3, 0.412], [0.34, 0.425], [0.385, 0.418]], 0.006, 0.8)),
          ...both(line(smile, 0.011, 0.9)),
          ...both(line(marionette, 0.008, 0.8)),
          ...both(line([[0.47, 0.618], [0.468, 0.642]], 0.004, 0.6)), ...both(line([[0.445, 0.625], [0.442, 0.646]], 0.004, 0.5)),
        ],
      },
      { feather: 8, shapes: both(ell([0.345, 0.452], 0.062, 0.02)) },
      { feather: 14, shapes: [...both(ell([0.25, 0.47], 0.1, 0.07)), ...both(ell([0.15, 0.3], 0.06, 0.08)), ...both(ell([0.36, 0.2], 0.1, 0.05, 0, 0.7)), ell([0.5, 0.5], 0.03, 0.06, 0, 0.5)] },
      { feather: 14, shapes: [...both(ell([0.13, 0.27], 0.06, 0.08)), ...both(ell([0.235, 0.645], 0.065, 0.06)), ...both(ell([0.345, 0.322], 0.07, 0.022, 0, 0.8))] },
    ],
    sculpt: [
      {
        feather: 12,
        shapes: [
          ...both(line([[0.03, 0.53], [0.12, 0.575], [0.21, 0.615], [0.27, 0.64]], 0.07, 0.9)),
          ...both(line(ovalPts(UPPER_OVAL, 0.97), 0.06, 0.55)),
          ...both(line([[0.455, 0.33], [0.452, 0.42], [0.45, 0.5]], 0.022, 0.6)),
          ...both(line(ovalPts([234, 93, 132], 0.97), 0.05, 0.4)),
        ],
      },
      {
        feather: 10,
        shapes: [
          ...both(ell([0.27, 0.49], 0.09, 0.025, -0.25)), ...both(ell([0.31, 0.305], 0.05, 0.012, 0.15, 0.7)),
          line([[0.5, 0.36], [0.5, 0.45], [0.5, 0.53]], 0.03), ell([0.5, 0.2], 0.08, 0.06, 0, 0.7), ell([0.5, 0.632], 0.035, 0.012, 0, 0.7),
          ell([0.5, 0.875], 0.05, 0.03, 0, 0.8), ...both(ell([0.39, 0.45], 0.03, 0.02, 0, 0.5)),
        ],
      },
      { feather: 12, shapes: both(line(ovalPts(LOWER_OVAL, 1.07), 0.07)) },
      { feather: 12, shapes: [...both(line([[0.1, 0.6], [0.18, 0.66], [0.25, 0.7]], 0.06)), ...both(ell([0.4, 0.885], 0.05, 0.04, 0, 0.6))] },
    ],
  };
}

// Paints the atlases once: { crease, zone, fill, age, sculpt }, each RGBA ATLAS × ATLAS bytes.
let atlasCache = null;
export function buildAtlases() {
  if (atlasCache) return atlasCache;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = ATLAS;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const scale = K * ATLAS;
  const paint = ({ feather, shapes }) => {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, ATLAS, ATLAS);
    ctx.fillStyle = ctx.strokeStyle = '#fff';
    ctx.lineCap = ctx.lineJoin = 'round';
    for (const s of shapes) {
      ctx.globalAlpha = s.a;
      ctx.beginPath();
      if (s.t === 'ell') {
        const [x, y] = toAtlas(s.c);
        ctx.ellipse(x, y, s.rx * scale, s.ry * scale, s.rot, 0, Math.PI * 2);
        ctx.fill();
      } else {
        s.pts.map(toAtlas).forEach(([x, y], k) => (k ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
        ctx.lineWidth = s.w * scale;
        ctx.stroke();
      }
    }
    ctx.globalAlpha = 1;
    const d = ctx.getImageData(0, 0, ATLAS, ATLAS).data;
    const a = new Uint8ClampedArray(ATLAS * ATLAS);
    for (let i = 0; i < a.length; i++) a[i] = d[i * 4 + 3];
    return blurChannel(a, ATLAS, ATLAS, feather);
  };
  atlasCache = {};
  for (const [name, channels] of Object.entries(templates())) {
    const planes = channels.map(paint);
    const data = new Uint8Array(ATLAS * ATLAS * 4);
    for (let i = 0; i < ATLAS * ATLAS; i++) for (let c = 0; c < 4; c++) data[i * 4 + c] = planes[c][i];
    atlasCache[name] = data;
  }
  canvas.width = canvas.height = 0;
  return atlasCache;
}

// The skirt: one ring of extra points outside the face outline, joined to it by triangles.
const RING = IDX.oval;
let indexCache = null;
function meshIndices() {
  if (indexCache) return indexCache;
  const idx = Array.from(TRIANGLES);
  for (let k = 0; k < RING.length; k++) {
    const a = RING[k], b = RING[(k + 1) % RING.length], sa = 468 + k, sb = 468 + ((k + 1) % RING.length);
    idx.push(a, b, sa, b, sb, sa);
  }
  indexCache = new Uint16Array(idx);
  return indexCache;
}

// Yaw from the landmarks' depth: positive when the face's image-right side turns away.
export function faceYaw(f) {
  const a = f.P[234], b = f.P[454];
  return Math.atan2(f.Z[454] - f.Z[234], Math.hypot(b[0] - a[0], b[1] - a[1]));
}

// Per face: clip-space positions, atlas coordinates and the triangle list for the mesh pass.
export function faceMeshes(faces, W, H) {
  const indices = meshIndices();
  return faces.map((f) => {
    const n = 468 + RING.length;
    const pos = new Float32Array(n * 2), uv = new Float32Array(n * 2);
    const c = [(f.P[10][0] + f.P[152][0]) / 2, (f.P[10][1] + f.P[152][1]) / 2];
    const put = (k, p, t) => {
      pos[k * 2] = (p[0] / W) * 2 - 1;
      pos[k * 2 + 1] = (p[1] / H) * 2 - 1;
      const [ax, ay] = toAtlas(t);
      uv[k * 2] = ax / ATLAS;
      uv[k * 2 + 1] = ay / ATLAS;
    };
    for (let i = 0; i < 468; i++) put(i, f.P[i], uvOf(i));
    RING.forEach((i, k) => put(468 + k, [c[0] + (f.P[i][0] - c[0]) * SKIRT, c[1] + (f.P[i][1] - c[1]) * SKIRT], out(uvOf(i), SKIRT)));
    return { pos, uv, indices, far: Math.max(-1, Math.min(1, faceYaw(f) * 2.5)) };
  });
}
