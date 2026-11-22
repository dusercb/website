// Separable box blur, run three times to approximate a Gaussian. Used to feather masks, to find skin
// spots and to refine cut-outs on the CPU, where a GPU round trip would cost more than it saves.

export function blurFloat(data, w, h, r, passes = 3) {
  r = Math.round(r);
  if (r < 1) return data;
  let a = data, b = new Float32Array(w * h);
  for (let i = 0; i < passes; i++) {
    boxH(a, b, w, h, r);
    boxV(b, a, w, h, r);
  }
  return a;
}

// Blurs an 8-bit channel and returns a new Uint8ClampedArray.
export function blurChannel(src, w, h, r) {
  const out = new Uint8ClampedArray(w * h);
  const f = blurFloat(Float32Array.from(src), w, h, r);
  for (let i = 0; i < out.length; i++) out[i] = f[i];
  return out;
}

// Guided filter (He, Sun and Tang, 2010): refines a coarse mask p so its edges follow the
// edges of the guide image I (both w × h floats). Used to sharpen the hair mask, which the
// segmentation model makes at 256 × 256.
export function guidedFilter(I, p, w, h, r, eps) {
  const mean = (a) => blurFloat(a, w, h, r, 1);
  const n = w * h;
  const II = new Float32Array(n), Ip = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    II[i] = I[i] * I[i];
    Ip[i] = I[i] * p[i];
  }
  const mI = mean(Float32Array.from(I)), mp = mean(Float32Array.from(p)), mII = mean(II), mIp = mean(Ip);
  const a = new Float32Array(n), b = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const v = mII[i] - mI[i] * mI[i];
    a[i] = (mIp[i] - mI[i] * mp[i]) / (v + eps);
    b[i] = mp[i] - a[i] * mI[i];
  }
  const ma = mean(a), mb = mean(b);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = Math.min(1, Math.max(0, ma[i] * I[i] + mb[i]));
  return out;
}

// The same filter with a colour guide (the paper's 3 × 3 covariance form), in its fast form: only
// the coefficients are found here, on a small copy of the photo, and the shader applies them to every
// photo pixel (alpha = a · rgb + b), so the cut-out follows strands finer than the grid. R, G, B and p
// are w × h floats (0–1). Returns a, b per pixel packed as RGBA floats.
export function guidedCoeffs(R, G, B, p, w, h, r, eps) {
  const n = w * h;
  const mean = (a) => blurFloat(a, w, h, r, 1);
  const prod = (x, y) => {
    const o = new Float32Array(n);
    for (let i = 0; i < n; i++) o[i] = x[i] * y[i];
    return o;
  };
  const mR = mean(Float32Array.from(R)), mG = mean(Float32Array.from(G)), mB = mean(Float32Array.from(B)), mP = mean(Float32Array.from(p));
  const mRR = mean(prod(R, R)), mRG = mean(prod(R, G)), mRB = mean(prod(R, B));
  const mGG = mean(prod(G, G)), mGB = mean(prod(G, B)), mBB = mean(prod(B, B));
  const mRP = mean(prod(R, p)), mGP = mean(prod(G, p)), mBP = mean(prod(B, p));
  const aR = new Float32Array(n), aG = new Float32Array(n), aB = new Float32Array(n), b = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const r0 = mR[i], g0 = mG[i], b0 = mB[i], p0 = mP[i];
    // Covariance of the guide (eps on the diagonal) and its covariance with p, then a = Σ⁻¹ c.
    const s11 = mRR[i] - r0 * r0 + eps, s12 = mRG[i] - r0 * g0, s13 = mRB[i] - r0 * b0;
    const s22 = mGG[i] - g0 * g0 + eps, s23 = mGB[i] - g0 * b0, s33 = mBB[i] - b0 * b0 + eps;
    const c1 = mRP[i] - r0 * p0, c2 = mGP[i] - g0 * p0, c3 = mBP[i] - b0 * p0;
    const i11 = s22 * s33 - s23 * s23, i12 = s13 * s23 - s12 * s33, i13 = s12 * s23 - s13 * s22;
    const i22 = s11 * s33 - s13 * s13, i23 = s12 * s13 - s11 * s23, i33 = s11 * s22 - s12 * s12;
    const k = 1 / (s11 * i11 + s12 * i12 + s13 * i13);
    const a1 = (i11 * c1 + i12 * c2 + i13 * c3) * k, a2 = (i12 * c1 + i22 * c2 + i23 * c3) * k, a3 = (i13 * c1 + i23 * c2 + i33 * c3) * k;
    aR[i] = a1;
    aG[i] = a2;
    aB[i] = a3;
    b[i] = p0 - a1 * r0 - a2 * g0 - a3 * b0;
  }
  const fR = mean(aR), fG = mean(aG), fB = mean(aB), fb = mean(b);
  const out = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) {
    out[i * 4] = fR[i];
    out[i * 4 + 1] = fG[i];
    out[i * 4 + 2] = fB[i];
    out[i * 4 + 3] = fb[i];
  }
  return out;
}

// Separable minimum (max = false) or maximum over a (2r + 1)² square: shrinks or grows a soft mask.
export function rankFilter(data, w, h, r, max) {
  r = Math.round(r);
  const out = Float32Array.from(data);
  if (r < 1) return out;
  const tmp = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      let v = data[row + x];
      for (let k = Math.max(0, x - r), e = Math.min(w - 1, x + r); k <= e; k++) {
        const u = data[row + k];
        if (max ? u > v : u < v) v = u;
      }
      tmp[row + x] = v;
    }
  }
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) {
      let v = tmp[y * w + x];
      for (let k = Math.max(0, y - r), e = Math.min(h - 1, y + r); k <= e; k++) {
        const u = tmp[k * w + x];
        if (max ? u > v : u < v) v = u;
      }
      out[y * w + x] = v;
    }
  }
  return out;
}

// The colour of the pixels a weight marks (wt, 0–1), spread to every pixel: the weighted average
// round each pixel (normalised convolution, radius r), and where too little weight is that near,
// the same over wider areas (on copies a quarter, a sixteenth … the size, so it costs little), out
// to the whole picture. R, G, B and wt are w × h floats (0–1). Returns the R, G and B averages and
// how much the colour varies round each pixel (the variance, summed over R, G and B).
export function spreadColour(R, G, B, wt, w, h, r) {
  const n = w * h, k = 4;
  let W = Float32Array.from(wt), C = [new Float32Array(n), new Float32Array(n), new Float32Array(n), new Float32Array(n)];
  let total = 0;
  const sum = [0, 0, 0, 0];
  for (let i = 0; i < n; i++) {
    const q = wt[i];
    C[0][i] = R[i] * q;
    C[1][i] = G[i] * q;
    C[2][i] = B[i] * q;
    C[3][i] = (R[i] * R[i] + G[i] * G[i] + B[i] * B[i]) * q;
    total += q;
    for (let c = 0; c < k; c++) sum[c] += C[c][i];
  }
  const mean = sum.map((v) => (total > 1e-6 ? v / total : 0.25));
  const levels = [];
  for (let lw = w, lh = h; levels.length < 4 && Math.max(lw, lh) > 2 * r;) {
    levels.push({ w: lw, h: lh, den: blurFloat(Float32Array.from(W), lw, lh, r, 2), num: C.map((c) => blurFloat(Float32Array.from(c), lw, lh, r, 2)) });
    const nw = Math.ceil(lw / 4), nh = Math.ceil(lh / 4);
    W = pool4(W, lw, lh, nw, nh);
    C = C.map((c) => pool4(c, lw, lh, nw, nh));
    lw = nw;
    lh = nh;
  }
  const out = [new Float32Array(n), new Float32Array(n), new Float32Array(n), new Float32Array(n)];
  const left = new Float32Array(n).fill(1);   // how much of each pixel's colour is still to find
  for (const L of levels) {
    const sx = L.w / w, sy = L.h / h;
    for (let y = 0; y < h; y++) {
      const fy = Math.min(L.h - 1, Math.max(0, (y + 0.5) * sy - 0.5)), y0 = Math.floor(fy), y1 = Math.min(L.h - 1, y0 + 1), ty = fy - y0;
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (left[i] < 1e-3) continue;
        const fx = Math.min(L.w - 1, Math.max(0, (x + 0.5) * sx - 0.5)), x0 = Math.floor(fx), x1 = Math.min(L.w - 1, x0 + 1), tx = fx - x0;
        const a = y0 * L.w + x0, b = y0 * L.w + x1, c0 = y1 * L.w + x0, d = y1 * L.w + x1;
        const k00 = (1 - tx) * (1 - ty), k01 = tx * (1 - ty), k10 = (1 - tx) * ty, k11 = tx * ty;
        const den = L.den[a] * k00 + L.den[b] * k01 + L.den[c0] * k10 + L.den[d] * k11;
        if (den < 1e-5) continue;
        const f = left[i] * Math.min(1, den / 0.12);
        for (let c = 0; c < k; c++) {
          const v = L.num[c];
          out[c][i] += (f * (v[a] * k00 + v[b] * k01 + v[c0] * k10 + v[d] * k11)) / den;
        }
        left[i] -= f;
      }
    }
  }
  const v = out[3];
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < k; c++) out[c][i] += left[i] * mean[c];
    v[i] = Math.max(0, v[i] - out[0][i] * out[0][i] - out[1][i] * out[1][i] - out[2][i] * out[2][i]);
  }
  return out;
}

// The mean of each 4 × 4 block: a w × h plane to nw × nh.
function pool4(src, w, h, nw, nh) {
  const out = new Float32Array(nw * nh);
  for (let y = 0; y < nh; y++) {
    for (let x = 0; x < nw; x++) {
      let s = 0, m = 0;
      for (let yy = y * 4; yy < Math.min(h, y * 4 + 4); yy++) {
        for (let xx = x * 4; xx < Math.min(w, x * 4 + 4); xx++) {
          s += src[yy * w + xx];
          m++;
        }
      }
      out[y * nw + x] = s / m;
    }
  }
  return out;
}

function boxH(src, dst, w, h, r) {
  const inv = 1 / (2 * r + 1);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let acc = 0;
    for (let x = -r; x <= r; x++) acc += src[row + clampi(x, 0, w - 1)];
    for (let x = 0; x < w; x++) {
      dst[row + x] = acc * inv;
      acc += src[row + clampi(x + r + 1, 0, w - 1)] - src[row + clampi(x - r, 0, w - 1)];
    }
  }
}

function boxV(src, dst, w, h, r) {
  const inv = 1 / (2 * r + 1);
  for (let x = 0; x < w; x++) {
    let acc = 0;
    for (let y = -r; y <= r; y++) acc += src[clampi(y, 0, h - 1) * w + x];
    for (let y = 0; y < h; y++) {
      dst[y * w + x] = acc * inv;
      acc += src[clampi(y + r + 1, 0, h - 1) * w + x] - src[clampi(y - r, 0, h - 1) * w + x];
    }
  }
}

function clampi(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}
