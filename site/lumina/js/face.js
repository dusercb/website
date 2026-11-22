// Face analysis. MediaPipe Face Landmarker (478 points) and Selfie Segmenter run in the browser
// from self-hosted WebAssembly and model files; nothing is uploaded. Landmarks are turned into
// soft region masks (skin, eyes, mouth, lips, irises, under-eyes, brows, cheeks) that the
// retouch shader blends through.

import { blurChannel } from './blur.js';

const MP_VERSION = '0.10.21';
const MP_BUNDLE = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MP_VERSION}/vision_bundle.mjs`;
const VENDOR = new URL('../vendor/mediapipe/', import.meta.url).href;

// MediaPipe face mesh indices (canonical 468-point topology plus 10 iris points).
export const IDX = {
  oval: [10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288, 397, 365, 379, 378, 400, 377, 152, 148, 176, 149, 150, 136, 172, 58, 132, 93, 234, 127, 162, 21, 54, 103, 67, 109],
  eyeR: [33, 246, 161, 160, 159, 158, 157, 173, 133, 155, 154, 153, 145, 144, 163, 7],
  eyeL: [263, 466, 388, 387, 386, 385, 384, 398, 362, 382, 381, 380, 374, 373, 390, 249],
  browR: [46, 53, 52, 65, 55, 107, 66, 105, 63, 70],
  browL: [276, 283, 282, 295, 285, 336, 296, 334, 293, 300],
  lipsOuter: [61, 185, 40, 39, 37, 0, 267, 269, 270, 409, 291, 375, 321, 405, 314, 17, 84, 181, 91, 146],
  lipsInner: [78, 191, 80, 81, 82, 13, 312, 311, 310, 415, 308, 324, 318, 402, 317, 14, 87, 178, 88, 95],
  jaw: [234, 93, 132, 58, 172, 136, 150, 149, 176, 148, 152, 377, 400, 378, 379, 365, 397, 288, 361, 323, 454],
  chin: [152, 148, 377, 176, 400],
  noseWings: [129, 358, 98, 327, 64, 294, 48, 278],
};

// ---------- model loading ----------

let visionP = null;
let landmarkerP = null;
let segmenterP = null;
let poseP = null;
let partsP = null;

// Model bytes. Hosts that refuse binary file types (the Claude artifact viewer) get a base64 text
// copy written by tools/make-artifact.mjs, split into numbered parts when it is large;
// `looksRight` rejects an HTML page served for a missing file.
async function modelBytes(name, looksRight) {
  const res = await fetch(VENDOR + name).catch(() => null);
  if (res?.ok && !/text\/html/.test(res.headers.get('content-type') || '')) {
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (looksRight(bytes)) return bytes;
  }
  const text = async (url) => {
    const r = await fetch(url).catch(() => null);
    return r?.ok && !/text\/html/.test(r.headers.get('content-type') || '') ? (await r.text()).trim() : null;
  };
  let b64 = await text(VENDOR + name + '.b64.txt');
  if (b64 === null) {
    const parts = [];
    for (let i = 1; i < 10; i++) {
      const p = await text(`${VENDOR}${name}.b64.${i}.txt`);
      if (p === null) break;
      parts.push(p);
    }
    if (!parts.length) throw new Error(`Model file ${name} is missing`);
    b64 = parts.join('');
  }
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  if (!looksRight(bytes)) throw new Error(`Model file ${name} is damaged`);
  return bytes;
}

// .task bundles are zip files (the signature sits after a short header); .tflite are flatbuffers.
const isZip = (b) => b.subarray(0, 16).some((v, i) => v === 0x50 && b[i + 1] === 0x4b && b[i + 2] === 3 && b[i + 3] === 4);
const isTflite = (b) => String.fromCharCode(b[4], b[5], b[6], b[7]) === 'TFL3';

function loadVision() {
  visionP ??= (async () => {
    const mp = await import(MP_BUNDLE);
    const simd = await mp.FilesetResolver.isSimdSupported();
    const name = simd ? 'vision_wasm_internal' : 'vision_wasm_nosimd_internal';
    return { mp, fileset: { wasmLoaderPath: VENDOR + name + '.js', wasmBinaryPath: VENDOR + name + '.wasm' } };
  })().catch((e) => { visionP = null; throw e; });
  return visionP;
}

export function preloadFaceModel() {
  landmarkerP ??= (async () => {
    const [{ mp, fileset }, model] = await Promise.all([loadVision(), modelBytes('face_landmarker.task', isZip)]);
    return mp.FaceLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetBuffer: model, delegate: 'CPU' },
      runningMode: 'IMAGE',
      numFaces: 4,
      minFaceDetectionConfidence: 0.4,
      minFacePresenceConfidence: 0.4,
    });
  })().catch((e) => { landmarkerP = null; throw e; });
  return landmarkerP;
}

// Returns one array of [x, y, z] per face: x and y normalised 0–1; z is depth on the same scale
// as x (negative is closer to the camera), which Relight turns into surface normals.
export async function detectFaces(canvas) {
  const lm = await preloadFaceModel();
  const res = lm.detect(canvas);
  return (res.faceLandmarks || []).map((f) => f.map((p) => [p.x, p.y, p.z]));
}

// Person probability as 8-bit values at the segmenter's output size.
export async function segmentPerson(canvas) {
  segmenterP ??= (async () => {
    const [{ mp, fileset }, model] = await Promise.all([loadVision(), modelBytes('selfie_segmenter.tflite', isTflite)]);
    return mp.ImageSegmenter.createFromOptions(fileset, {
      baseOptions: { modelAssetBuffer: model, delegate: 'CPU' },
      runningMode: 'IMAGE',
      outputCategoryMask: false,
      outputConfidenceMasks: true,
    });
  })().catch((e) => { segmenterP = null; throw e; });
  const seg = await segmenterP;
  const res = seg.segment(canvas);
  const masks = res.confidenceMasks;
  const m = masks[masks.length - 1];
  const f = m.getAsFloat32Array();
  const data = new Uint8ClampedArray(f.length);
  for (let i = 0; i < f.length; i++) data[i] = f[i] * 255;
  const out = { w: m.width, h: m.height, data };
  res.close?.();
  return out;
}

// Body landmarks (MediaPipe Pose, 33 points) for the largest person, normalised 0–1 with a
// visibility score, or null. Loaded the first time a body tool needs it (about 6 MB).
export async function detectPose(canvas) {
  poseP ??= (async () => {
    const [{ mp, fileset }, model] = await Promise.all([loadVision(), modelBytes('pose_landmarker_lite.task', isZip)]);
    return mp.PoseLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetBuffer: model, delegate: 'CPU' },
      runningMode: 'IMAGE',
      numPoses: 2,
      minPoseDetectionConfidence: 0.4,
      minPosePresenceConfidence: 0.4,
    });
  })().catch((e) => { poseP = null; throw e; });
  const pl = await poseP;
  const res = pl.detect(canvas);
  const poses = (res.landmarks || []).map((ps) => ps.map((p) => [p.x, p.y, p.visibility ?? 1]));
  res.close?.();
  if (!poses.length) return null;
  // The largest person: widest shoulder-to-hip box.
  const size = (ps) => {
    const xs = [11, 12, 23, 24].map((i) => ps[i][0]), ys = [11, 12, 23, 24].map((i) => ps[i][1]);
    return (Math.max(...xs) - Math.min(...xs) + 0.01) * (Math.max(...ys) - Math.min(...ys) + 0.01);
  };
  return poses.sort((a, b) => size(b) - size(a))[0];
}

// Hair, body skin, face skin and clothes (MediaPipe's multi-class selfie segmenter, 256 × 256).
// Returns { w, h, hair, body, face, clothes, person } as 8-bit planes; person is everything but the
// background, accessories included. Loaded on first use (about 16 MB).
export async function segmentParts(canvas) {
  partsP ??= (async () => {
    const [{ mp, fileset }, model] = await Promise.all([loadVision(), modelBytes('selfie_multiclass_256x256.tflite', isTflite)]);
    return mp.ImageSegmenter.createFromOptions(fileset, {
      baseOptions: { modelAssetBuffer: model, delegate: 'CPU' },
      runningMode: 'IMAGE',
      outputCategoryMask: false,
      outputConfidenceMasks: true,
    });
  })().catch((e) => { partsP = null; throw e; });
  const seg = await partsP;
  const res = seg.segment(canvas);
  // Classes: 0 background, 1 hair, 2 body skin, 3 face skin, 4 clothes, 5 other.
  const plane = (k) => {
    const m = res.confidenceMasks[k];
    const f = m.getAsFloat32Array();
    const d = new Uint8ClampedArray(f.length);
    for (let i = 0; i < f.length; i++) d[i] = f[i] * 255;
    return d;
  };
  const m0 = res.confidenceMasks[0];
  const person = plane(0).map((v) => 255 - v);
  const out = { w: m0.width, h: m0.height, hair: plane(1), body: plane(2), face: plane(3), clothes: plane(4), person };
  res.close?.();
  return out;
}

// ---------- geometry ----------

const sub = (a, b) => [a[0] - b[0], a[1] - b[1]];
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const mid = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];

// Converts normalised landmarks to pixels and derives the measurements every tool uses.
export function analyseFace(norm, W, H) {
  const P = norm.map(([x, y]) => [x * W, y * H]);
  const Z = norm.map((p) => (p[2] || 0) * W);
  const eye = (outer, inner, top, bottom, iris, ring) => {
    const irisR = ring.reduce((s, i) => s + dist(P[iris], P[i]), 0) / ring.length;
    return { c: mid(P[outer], P[inner]), w: dist(P[outer], P[inner]), h: dist(P[top], P[bottom]), iris: P[iris], irisR };
  };
  const eyeR = eye(33, 133, 159, 145, 468, [469, 470, 471, 472]);
  const eyeL = eye(263, 362, 386, 374, 473, [474, 475, 476, 477]);
  const xv = sub(eyeL.c, eyeR.c);
  const xl = Math.hypot(xv[0], xv[1]) || 1;
  const xAxis = [xv[0] / xl, xv[1] / xl];
  const yAxis = [-xAxis[1], xAxis[0]];
  const xs = IDX.oval.map((i) => P[i][0]), ys = IDX.oval.map((i) => P[i][1]);
  return {
    P,
    Z,
    eyeR,
    eyeL,
    xAxis,
    yAxis,
    roll: Math.atan2(xAxis[1], xAxis[0]),
    fw: dist(P[234], P[454]),
    fh: dist(P[10], P[152]),
    center: mid(P[234], P[454]),
    mouth: { c: mid(P[13], P[14]), w: dist(P[61], P[291]) },
    nose: P[4],
    box: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)],
  };
}

// ---------- masks ----------

function polygon(ctx, P, idx) {
  ctx.beginPath();
  idx.forEach((i, k) => (k ? ctx.lineTo(P[i][0], P[i][1]) : ctx.moveTo(P[i][0], P[i][1])));
  ctx.closePath();
}

function ellipse(ctx, c, rx, ry, rot) {
  ctx.beginPath();
  ctx.ellipse(c[0], c[1], Math.max(rx, 0.5), Math.max(ry, 0.5), rot, 0, Math.PI * 2);
}

// Builds every face mask at mask resolution (mw × mh = image × scale).
// Returns { mw, mh, skin, spots, feat, feat2 } where skin/spots are 8-bit alpha channels and
// feat/feat2 are packed RGBA; feat2.a repeats the face-skin mask for DeGlare and contouring.
export function buildFaceMasks(faces, W, H, scale) {
  const mw = Math.max(1, Math.round(W * scale)), mh = Math.max(1, Math.round(H * scale));
  const canvas = document.createElement('canvas');
  canvas.width = mw;
  canvas.height = mh;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const fwMax = Math.max(...faces.map((f) => f.fw), 1);

  // Draws `draw(face)` for each face, then returns the blurred alpha channel.
  const channel = (draw, featherFrac) => {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, mw, mh);
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    ctx.fillStyle = ctx.strokeStyle = '#fff';
    ctx.lineJoin = ctx.lineCap = 'round';
    for (const f of faces) {
      ctx.save();
      draw(f);
      ctx.restore();
    }
    const d = ctx.getImageData(0, 0, mw, mh).data;
    const a = new Uint8ClampedArray(mw * mh);
    for (let i = 0; i < a.length; i++) a[i] = d[i * 4 + 3];
    return blurChannel(a, mw, mh, Math.max(1, Math.round(fwMax * featherFrac * scale)));
  };

  const cut = (f, idx, grow) => {
    polygon(ctx, f.P, idx);
    ctx.fill();
    ctx.lineWidth = f.fw * grow;
    ctx.stroke();
  };

  const skinWithout = (f, extra) => {
    polygon(ctx, f.P, IDX.oval);
    ctx.fill();
    ctx.globalCompositeOperation = 'destination-out';
    cut(f, IDX.eyeR, 0.05);
    cut(f, IDX.eyeL, 0.05);
    cut(f, IDX.browR, 0.045);
    cut(f, IDX.browL, 0.045);
    cut(f, IDX.lipsOuter, 0.03);
    if (extra) extra(f);
  };

  const skin = channel((f) => skinWithout(f), 0.025);
  // Stricter mask for automatic spot finding: also avoids nostrils, the creased skin around
  // the eyes and the face edge, where dark lines are features rather than blemishes.
  const spots = channel((f) => skinWithout(f, () => {
    ellipse(ctx, f.nose, f.fw * 0.13, f.fw * 0.11, f.roll);
    ctx.fill();
    for (const e of [f.eyeR, f.eyeL]) {
      ellipse(ctx, [e.c[0] + f.yAxis[0] * e.w * 0.25, e.c[1] + f.yAxis[1] * e.w * 0.25], e.w * 0.95, e.w * 0.75, f.roll);
      ctx.fill();
    }
    // Nose-wing creases and mouth corners are shading, not spots.
    for (const i of [...IDX.noseWings, 61, 291]) {
      ellipse(ctx, f.P[i], f.fw * 0.065, f.fw * 0.065, 0);
      ctx.fill();
    }
    cut(f, IDX.lipsOuter, 0.07);
    polygon(ctx, f.P, IDX.oval);
    ctx.lineWidth = f.fw * 0.08;
    ctx.stroke();
  }), 0.012);

  // Each eye's opening. Its rim narrows as the eye closes and a closed eye (height under a tenth of
  // its width) draws nothing, so a closed eye's lashes are never taken for its white; AirBrush turns
  // its eye brightening off for closed eyes too.
  const eyes = channel((f) => {
    for (const [idx, e] of [[IDX.eyeR, f.eyeR], [IDX.eyeL, f.eyeL]]) {
      const t = Math.min(1, Math.max(0, (e.h / e.w - 0.1) / 0.1)), open = t * t * (3 - 2 * t);
      if (open > 0.05) cut(f, idx, 0.012 * open);
    }
  }, 0.006);

  const mouth = channel((f) => {
    polygon(ctx, f.P, IDX.lipsInner);
    ctx.fill();
  }, 0.004);

  const lips = channel((f) => {
    polygon(ctx, f.P, IDX.lipsOuter);
    ctx.fill();
    ctx.globalCompositeOperation = 'destination-out';
    polygon(ctx, f.P, IDX.lipsInner);
    ctx.fill();
  }, 0.006);

  const irises = channel((f) => {
    for (const [idx, e] of [[IDX.eyeR, f.eyeR], [IDX.eyeL, f.eyeL]]) {
      ctx.save();
      polygon(ctx, f.P, idx);
      ctx.clip();
      ellipse(ctx, e.iris, e.irisR, e.irisR, 0);
      ctx.fill();
      ctx.restore();
    }
  }, 0.003);

  const underEyes = channel((f) => {
    for (const e of [f.eyeR, f.eyeL]) {
      const c = [e.c[0] + f.yAxis[0] * e.w * 0.42, e.c[1] + f.yAxis[1] * e.w * 0.42];
      ellipse(ctx, c, e.w * 0.58, e.w * 0.26, f.roll);
      ctx.fill();
    }
    ctx.globalCompositeOperation = 'destination-out';
    cut(f, IDX.eyeR, 0.03);
    cut(f, IDX.eyeL, 0.03);
  }, 0.03);

  const brows = channel((f) => {
    cut(f, IDX.browR, 0.012);
    cut(f, IDX.browL, 0.012);
  }, 0.008);

  const cheeks = channel((f) => {
    polygon(ctx, f.P, IDX.oval);
    ctx.clip();
    for (const [e, side] of [[f.eyeR, -1], [f.eyeL, 1]]) {
      const c = [
        e.c[0] + f.yAxis[0] * e.w * 1.15 + f.xAxis[0] * side * e.w * 0.3,
        e.c[1] + f.yAxis[1] * e.w * 1.15 + f.xAxis[1] * side * e.w * 0.3,
      ];
      ellipse(ctx, c, e.w * 0.8, e.w * 0.55, f.roll);
      ctx.fill();
    }
  }, 0.07);

  canvas.width = canvas.height = 0; // free it now; iOS Safari counts canvas memory until GC
  const feat = new Uint8Array(mw * mh * 4);
  const feat2 = new Uint8Array(mw * mh * 4);
  for (let i = 0; i < mw * mh; i++) {
    feat[i * 4] = eyes[i];
    feat[i * 4 + 1] = mouth[i];
    feat[i * 4 + 2] = lips[i];
    feat[i * 4 + 3] = irises[i];
    feat2[i * 4] = underEyes[i];
    feat2[i * 4 + 1] = brows[i];
    feat2[i * 4 + 2] = cheeks[i];
    feat2[i * 4 + 3] = skin[i];
  }
  return { mw, mh, skin, spots, feat, feat2 };
}

// Mean and inverse covariance of skin chroma (Cb, Cr), sampled where the face mask is solid, plus
// the mean brightness (y).
// Two passes: the second drops outliers (stubble, glasses, stray hair) beyond 2.5σ.
export function skinModel(img, skin, mw, mh) {
  const { width: W, height: H, data } = img;
  const step = Math.max(1, Math.round(Math.sqrt((mw * mh) / 30000)));
  const samples = [];
  for (let my = 0; my < mh; my += step) {
    for (let mx = 0; mx < mw; mx += step) {
      if (skin[my * mw + mx] < 220) continue;
      const x = Math.min(W - 1, Math.round((mx * W) / mw)), y = Math.min(H - 1, Math.round((my * H) / mh));
      const i = (y * W + x) * 4;
      const r = data[i] / 255, g = data[i + 1] / 255, b = data[i + 2] / 255;
      const Y = 0.299 * r + 0.587 * g + 0.114 * b;
      if (Y < 0.06) continue;
      samples.push([(b - Y) * 0.564 + 0.5, (r - Y) * 0.713 + 0.5, Y]);
    }
  }
  if (samples.length < 50) return null;
  let model = fit(samples);
  const kept = samples.filter((s) => mahal(model, s) < 2.5);
  if (kept.length > 50) model = fit(kept);
  // Mean brightness of the same skin, for Skin tone and stubble protection.
  const use = kept.length > 50 ? kept : samples;
  model.y = use.reduce((t, s) => t + s[2], 0) / use.length;
  return model;
}

function fit(s) {
  const n = s.length;
  let mx = 0, my = 0;
  for (const [a, b] of s) { mx += a; my += b; }
  mx /= n;
  my /= n;
  let sxx = 0, syy = 0, sxy = 0;
  for (const [a, b] of s) {
    sxx += (a - mx) ** 2;
    syy += (b - my) ** 2;
    sxy += (a - mx) * (b - my);
  }
  const floor = 0.012 ** 2;
  sxx = Math.max(sxx / n, floor);
  syy = Math.max(syy / n, floor);
  sxy /= n;
  const det = sxx * syy - sxy * sxy || 1e-9;
  return { mean: [mx, my], inv: [syy / det, -sxy / det, -sxy / det, sxx / det] };
}

function mahal(m, [a, b]) {
  const dx = a - m.mean[0], dy = b - m.mean[1];
  return Math.sqrt(dx * (m.inv[0] * dx + m.inv[1] * dy) + dy * (m.inv[2] * dx + m.inv[3] * dy));
}
