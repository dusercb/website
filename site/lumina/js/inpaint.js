// Background Freeze's plate: the photo with the subject taken out and the gap filled, so a reshaped
// subject moves over clean background instead of leaving its old outline behind. AirBrush runs a
// small inpainting network on the phone for its Background Lock (evidence §11). Here:
//   fillSmooth: push-pull (Gortler et al. 1996), the gap filled smoothly from the colours around it;
//   fillPatches: a band along the outline, where a reshape can uncover the background, rebuilt from
//   patches of the background itself (PatchMatch, Barnes et al. 2009, with the voting of Wexler et
//   al. 2007), coarse to fine, so bricks, leaves and window frames carry on into the gap.
// Both work in place on an RGB float image (w × h × 3, 0–255) and a hole mask (1 = to fill).

const R = 3;                       // patch radius: 7 × 7 patches

export function fillSmooth(img, hole, w, h) {
  // Down: each level averages the known colours of the 2 × 2 pixels below it.
  const levels = [];
  let col = new Float32Array(w * h * 3), wt = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    if (hole[i]) continue;
    wt[i] = 1;
    col[i * 3] = img[i * 3];
    col[i * 3 + 1] = img[i * 3 + 1];
    col[i * 3 + 2] = img[i * 3 + 2];
  }
  levels.push({ w, h, col, wt });
  let lw = w, lh = h;
  while (lw > 1 || lh > 1) {
    const nw = Math.ceil(lw / 2), nh = Math.ceil(lh / 2);
    const nc = new Float32Array(nw * nh * 3), nwt = new Float32Array(nw * nh);
    for (let y = 0; y < nh; y++) {
      for (let x = 0; x < nw; x++) {
        let r = 0, g = 0, b = 0, s = 0;
        for (let dy = 0; dy < 2; dy++) {
          const yy = y * 2 + dy;
          if (yy >= lh) continue;
          for (let dx = 0; dx < 2; dx++) {
            const xx = x * 2 + dx;
            if (xx >= lw) continue;
            const j = yy * lw + xx, k = wt[j];
            r += col[j * 3] * k;
            g += col[j * 3 + 1] * k;
            b += col[j * 3 + 2] * k;
            s += k;
          }
        }
        const o = y * nw + x;
        if (s > 0) {
          nc[o * 3] = r / s;
          nc[o * 3 + 1] = g / s;
          nc[o * 3 + 2] = b / s;
        }
        nwt[o] = Math.min(1, s);
      }
    }
    levels.push({ w: nw, h: nh, col: nc, wt: nwt });
    col = nc;
    wt = nwt;
    lw = nw;
    lh = nh;
  }
  // Up: each level keeps what it knows and takes the rest from the level above, upsampled smoothly.
  for (let l = levels.length - 2; l >= 0; l--) {
    const f = levels[l], c = levels[l + 1];
    for (let y = 0; y < f.h; y++) {
      const cy = Math.min(c.h - 1, Math.max(0, (y + 0.5) / 2 - 0.5)), y0 = Math.floor(cy), y1 = Math.min(c.h - 1, y0 + 1), ty = cy - y0;
      for (let x = 0; x < f.w; x++) {
        const i = y * f.w + x, k = f.wt[i];
        if (k >= 1) continue;
        const cx = Math.min(c.w - 1, Math.max(0, (x + 0.5) / 2 - 0.5)), x0 = Math.floor(cx), x1 = Math.min(c.w - 1, x0 + 1), tx = cx - x0;
        for (let ch = 0; ch < 3; ch++) {
          const v = (c.col[(y0 * c.w + x0) * 3 + ch] * (1 - tx) + c.col[(y0 * c.w + x1) * 3 + ch] * tx) * (1 - ty) +
            (c.col[(y1 * c.w + x0) * 3 + ch] * (1 - tx) + c.col[(y1 * c.w + x1) * 3 + ch] * tx) * ty;
          f.col[i * 3 + ch] = f.col[i * 3 + ch] * k + v * (1 - k);
        }
        f.wt[i] = 1;
      }
    }
  }
  const top = levels[0].col;
  for (let i = 0; i < w * h; i++) {
    if (!hole[i]) continue;
    img[i * 3] = top[i * 3];
    img[i * 3 + 1] = top[i * 3 + 1];
    img[i * 3 + 2] = top[i * 3 + 2];
  }
}

// Distance (in px, 3-4 chamfer) from each hole pixel to the nearest known pixel.
function distanceIn(hole, w, h) {
  const d = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) d[i] = hole[i] ? 1e9 : 0;
  const pass = (x, y, j, c) => {
    if (x >= 0 && y >= 0 && x < w && y < h) return d[y * w + x] + c;
    return 1e9;
  };
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!d[i]) continue;
      d[i] = Math.min(d[i], pass(x - 1, y, i, 1), pass(x, y - 1, i, 1), pass(x - 1, y - 1, i, 1.4), pass(x + 1, y - 1, i, 1.4));
    }
  }
  for (let y = h - 1; y >= 0; y--) {
    for (let x = w - 1; x >= 0; x--) {
      const i = y * w + x;
      if (!d[i]) continue;
      d[i] = Math.min(d[i], pass(x + 1, y, i, 1), pass(x, y + 1, i, 1), pass(x + 1, y + 1, i, 1.4), pass(x - 1, y + 1, i, 1.4));
    }
  }
  return d;
}

// One level of the pyramid: the image padded by R on every side (edges repeated) so every patch
// centre in the photo has a whole patch, which pixels are known, which are to be rebuilt, and
// where a whole known patch can be taken from.
function makeLevel(img, known, target, w, h) {
  const pw = w + 2 * R, ph = h + 2 * R;
  const px = new Float32Array(pw * ph * 3), kn = new Uint8Array(pw * ph), tg = new Uint8Array(pw * ph);
  for (let y = 0; y < ph; y++) {
    const sy = Math.min(h - 1, Math.max(0, y - R));
    for (let x = 0; x < pw; x++) {
      const sx = Math.min(w - 1, Math.max(0, x - R)), s = sy * w + sx, o = y * pw + x;
      px[o * 3] = img[s * 3];
      px[o * 3 + 1] = img[s * 3 + 1];
      px[o * 3 + 2] = img[s * 3 + 2];
      const inside = x >= R && y >= R && x < pw - R && y < ph - R;
      kn[o] = inside && known[s] ? 1 : 0;
      tg[o] = inside && target[s] ? 1 : 0;
    }
  }
  // A source centre needs its whole patch known: a box count of unknown pixels must be zero.
  const bad = new Int32Array((pw + 1) * (ph + 1));
  for (let y = 0; y < ph; y++) {
    let row = 0;
    for (let x = 0; x < pw; x++) {
      row += kn[y * pw + x] ? 0 : 1;
      bad[(y + 1) * (pw + 1) + x + 1] = bad[y * (pw + 1) + x + 1] + row;
    }
  }
  const src = new Uint8Array(pw * ph);
  let nsrc = 0;
  for (let y = R; y < ph - R; y++) {
    for (let x = R; x < pw - R; x++) {
      const x0 = x - R, y0 = y - R, x1 = x + R + 1, y1 = y + R + 1;
      const c = bad[y1 * (pw + 1) + x1] - bad[y0 * (pw + 1) + x1] - bad[y1 * (pw + 1) + x0] + bad[y0 * (pw + 1) + x0];
      if (!c) {
        src[y * pw + x] = 1;
        nsrc++;
      }
    }
  }
  // Patch centres to match: every pixel whose patch touches a pixel being rebuilt (the rebuilt
  // pixels grown by R, a row pass then a column pass).
  const rowHit = new Uint8Array(pw * ph), cen = [];
  for (let y = 0; y < ph; y++) {
    for (let x = R; x < pw - R; x++) {
      let hit = 0;
      for (let dx = -R; dx <= R && !hit; dx++) hit = tg[y * pw + x + dx];
      rowHit[y * pw + x] = hit;
    }
  }
  for (let y = R; y < ph - R; y++) {
    for (let x = R; x < pw - R; x++) {
      let hit = 0;
      for (let dy = -R; dy <= R && !hit; dy++) hit = rowHit[(y + dy) * pw + x];
      if (hit) cen.push(y * pw + x);
    }
  }
  return { w, h, pw, ph, px, kn, tg, src, nsrc, cen: Int32Array.from(cen), nnf: new Int32Array(pw * ph).fill(-1), d: new Float32Array(pw * ph) };
}

function down(img, w, h) {
  const nw = Math.ceil(w / 2), nh = Math.ceil(h / 2), out = new Float32Array(nw * nh * 3);
  for (let y = 0; y < nh; y++) {
    for (let x = 0; x < nw; x++) {
      for (let c = 0; c < 3; c++) {
        let s = 0, k = 0;
        for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
          const yy = y * 2 + dy, xx = x * 2 + dx;
          if (yy < h && xx < w) {
            s += img[(yy * w + xx) * 3 + c];
            k++;
          }
        }
        out[(y * nw + x) * 3 + c] = s / k;
      }
    }
  }
  return out;
}

function downMask(m, w, h, all) {
  const nw = Math.ceil(w / 2), nh = Math.ceil(h / 2), out = new Uint8Array(nw * nh);
  for (let y = 0; y < nh; y++) {
    for (let x = 0; x < nw; x++) {
      let v = all ? 1 : 0;
      for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
        const yy = Math.min(h - 1, y * 2 + dy), xx = Math.min(w - 1, x * 2 + dx), b = m[yy * w + xx];
        v = all ? v & b : v | b;
      }
      out[y * nw + x] = v;
    }
  }
  return out;
}

// Fills the hole pixels within `band` px of known background with patches of that background;
// the rest of the hole keeps the smooth fill already in img. pause() is awaited every ~20 ms so
// the page stays responsive; it may throw to cancel. Returns the matches found at this size (for
// fillDetail), or null if there was nothing to fill.
export async function fillPatches(img, hole, w, h, band, pause) {
  const n = w * h;
  const dist = distanceIn(hole, w, h);
  const target = new Uint8Array(n), known = new Uint8Array(n);
  let any = false;
  for (let i = 0; i < n; i++) {
    known[i] = hole[i] ? 0 : 1;
    target[i] = hole[i] && dist[i] <= band ? 1 : 0;
    any ||= target[i] === 1;
  }
  if (!any) return null;
  // Three levels at most, the coarsest no smaller than about 48 px across.
  const imgs = [img], kns = [known], tgs = [target], dims = [[w, h]];
  while (dims.length < 3 && Math.min(...dims[dims.length - 1]) >= 96) {
    const [lw, lh] = dims[dims.length - 1];
    imgs.push(down(imgs[imgs.length - 1], lw, lh));
    kns.push(downMask(kns[kns.length - 1], lw, lh, true));
    tgs.push(downMask(tgs[tgs.length - 1], lw, lh, false));
    dims.push([Math.ceil(lw / 2), Math.ceil(lh / 2)]);
  }
  let seed = 12345;
  const rand = () => {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return (seed >>> 0) / 4294967296;
  };
  let t0 = performance.now();
  const tick = async () => {
    if (performance.now() - t0 > 20) {
      await pause();
      t0 = performance.now();
    }
  };
  let prev = null;
  for (let l = dims.length - 1; l >= 0; l--) {
    const [lw, lh] = dims[l];
    const L = makeLevel(imgs[l], kns[l], tgs[l], lw, lh);
    if (!L.nsrc || !L.cen.length) return null;
    const { pw, px, src, cen, nnf, d } = L;
    const off = [];
    for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) off.push(dy * pw + dx);
    const OFF = Int32Array.from(off), NO = OFF.length;
    const dist2 = (t, s, best) => {
      let sum = 0;
      for (let k = 0; k < NO; k++) {
        const a = (t + OFF[k]) * 3, b = (s + OFF[k]) * 3;
        const dr = px[a] - px[b], dg = px[a + 1] - px[b + 1], db = px[a + 2] - px[b + 2];
        sum += dr * dr + dg * dg + db * db;
        if (sum >= best) return sum;
      }
      return sum;
    };
    // Sources are searched near each target first: within a third of the photo at this level.
    const win = Math.max(8, Math.round(Math.max(lw, lh) / 3));
    const randomSource = (t) => {
      const tx = t % pw, ty = (t - tx) / pw;
      for (let k = 0; k < 30; k++) {
        const x = Math.round(tx + (rand() * 2 - 1) * win), y = Math.round(ty + (rand() * 2 - 1) * win);
        if (x < R || y < R || x >= pw - R || y >= L.ph - R) continue;
        const s = y * pw + x;
        if (src[s]) return s;
      }
      for (;;) {
        const s = Math.floor(rand() * pw * L.ph);
        if (src[s]) return s;
      }
    };
    // Start: the coarser level's matches, scaled up, or random sources at the coarsest.
    for (const t of cen) {
      let s = -1;
      if (prev) {
        const x = t % pw - R, y = (t - (t % pw)) / pw - R;
        const q = prev.nnf[((y >> 1) + R) * prev.pw + (x >> 1) + R];
        if (q >= 0) {
          const qx = q % prev.pw - R, qy = (q - (q % prev.pw)) / prev.pw - R;
          const sx = qx * 2 + (x & 1) + R, sy = qy * 2 + (y & 1) + R;
          const c = sy * pw + sx;
          if (sx >= R && sy >= R && sx < pw - R && sy < L.ph - R && src[c]) s = c;
        }
      }
      if (s < 0) s = randomSource(t);
      nnf[t] = s;
      d[t] = dist2(t, s, Infinity);
    }
    const vote = () => {
      // Each pixel being rebuilt takes the weighted average of what every patch covering it says.
      const sorted = Float32Array.from(cen, (t) => d[t]).sort();
      const s2 = Math.max(1, sorted[sorted.length >> 1]);
      const acc = new Float32Array(pw * L.ph * 4);
      for (const t of cen) {
        const wgt = Math.exp(-d[t] / (2 * s2)) + 1e-6, s = nnf[t];
        for (let k = 0; k < NO; k++) {
          const q = t + OFF[k];
          if (!L.tg[q]) continue;
          const b = (s + OFF[k]) * 3;
          acc[q * 4] += px[b] * wgt;
          acc[q * 4 + 1] += px[b + 1] * wgt;
          acc[q * 4 + 2] += px[b + 2] * wgt;
          acc[q * 4 + 3] += wgt;
        }
      }
      for (let q = 0; q < pw * L.ph; q++) {
        const a = acc[q * 4 + 3];
        if (!a) continue;
        px[q * 3] = acc[q * 4] / a;
        px[q * 3 + 1] = acc[q * 4 + 1] / a;
        px[q * 3 + 2] = acc[q * 4 + 2] / a;
      }
      for (const t of cen) d[t] = dist2(t, nnf[t], Infinity);
    };
    if (prev) vote();
    const iters = l === dims.length - 1 ? 5 : l === 0 ? 2 : 3;
    for (let it = 0; it < iters; it++) {
      for (let pass = 0; pass < 2; pass++) {
        const fwd = pass === 0, step = fwd ? 1 : -1;
        for (let j = fwd ? 0 : cen.length - 1; fwd ? j < cen.length : j >= 0; j += step) {
          const t = cen[j];
          let best = d[t], bs = nnf[t];
          // Propagation: a neighbour's match, shifted by one, often fits here too.
          for (const o of [step, step * pw]) {
            const nb = nnf[t - o];
            if (nb < 0) continue;
            const c = nb + o;
            if (c === bs || !src[c]) continue;
            const dd = dist2(t, c, best);
            if (dd < best) {
              best = dd;
              bs = c;
            }
          }
          // Random search in shrinking windows round the best match so far.
          const bx = bs % pw, by = (bs - bx) / pw;
          for (let r = win; r >= 1; r >>= 1) {
            const x = Math.round(bx + (rand() * 2 - 1) * r), y = Math.round(by + (rand() * 2 - 1) * r);
            if (x < R || y < R || x >= pw - R || y >= L.ph - R) continue;
            const c = y * pw + x;
            if (c === bs || !src[c]) continue;
            const dd = dist2(t, c, best);
            if (dd < best) {
              best = dd;
              bs = c;
            }
          }
          nnf[t] = bs;
          d[t] = best;
          if ((j & 255) === 0) await tick();
        }
      }
      vote();
      await tick();
    }
    // Back into this level's unpadded image, for the next finer level to start from.
    const out = imgs[l];
    for (let y = 0; y < lh; y++) {
      for (let x = 0; x < lw; x++) {
        const i = y * lw + x;
        if (!tgs[l][i]) continue;
        const o = (y + R) * pw + x + R;
        out[i * 3] = px[o * 3];
        out[i * 3 + 1] = px[o * 3 + 1];
        out[i * 3 + 2] = px[o * 3 + 2];
      }
    }
    if (l > 0) {
      // The finer level starts from this result where it is rebuilding.
      const [fw, fh] = dims[l - 1], fine = imgs[l - 1], ft = tgs[l - 1];
      for (let y = 0; y < fh; y++) {
        for (let x = 0; x < fw; x++) {
          const i = y * fw + x;
          if (!ft[i]) continue;
          const c = (Math.min(lh - 1, y >> 1) * lw + Math.min(lw - 1, x >> 1)) * 3;
          fine[i * 3] = out[c];
          fine[i * 3 + 1] = out[c + 1];
          fine[i * 3 + 2] = out[c + 2];
        }
      }
    }
    prev = L;
  }
  return { nnf: prev.nnf, d: prev.d, pw: prev.pw, target };
}

// The rebuilt band at twice the size fillPatches worked at, from the full-size photo: each pixel
// gains the fine detail (what the half-size photo, half, lacks) of the full-size pixels that its
// own and its neighbours' patches were matched to, so grain and fine lines are not lost to the
// half-size fill. photo is RGBA (W × H); out is RGBA too, already holding the plate scaled up;
// only the band's pixels in rows y0 to y1 change.
export function fillDetail(photo, W, H, match, w, h, half, out, y0 = 0, y1 = H) {
  const { nnf, d, pw, target } = match;
  let sum = 0, cnt = 0;
  for (let i = 0; i < nnf.length; i++) {
    if (nnf[i] >= 0) {
      sum += d[i];
      cnt++;
    }
  }
  const s2 = Math.max(1, cnt ? sum / cnt : 1);
  for (let Y = y0; Y < y1; Y++) {
    const ty = Math.min(h - 1, Y >> 1);
    for (let X = 0; X < W; X++) {
      const tx = Math.min(w - 1, X >> 1);
      if (!target[ty * w + tx]) continue;
      let r = 0, g = 0, b = 0, k = 0;
      for (let ny = ty - 1; ny <= ty + 1; ny++) {
        if (ny < 0 || ny >= h) continue;
        for (let nx = tx - 1; nx <= tx + 1; nx++) {
          if (nx < 0 || nx >= w) continue;
          const n = (ny + R) * pw + nx + R, m = nnf[n];
          if (m < 0) continue;
          const sx = (m % pw) - R, sy = (m - (m % pw)) / pw - R;
          const SX = sx * 2 + X - nx * 2, SY = sy * 2 + Y - ny * 2;
          if (SX < 0 || SY < 0 || SX >= W || SY >= H) continue;
          const wt = Math.exp(-d[n] / (2 * s2)) * (nx === tx && ny === ty ? 2 : 1) + 1e-6, j = (SY * W + SX) * 4;
          // The half-size photo at SX, SY (bilinear): what the detail is measured against.
          const fx = Math.min(w - 1, Math.max(0, (SX + 0.5) / 2 - 0.5)), fy = Math.min(h - 1, Math.max(0, (SY + 0.5) / 2 - 0.5));
          const x0 = Math.floor(fx), y0 = Math.floor(fy), x1 = Math.min(w - 1, x0 + 1), y1 = Math.min(h - 1, y0 + 1), ax = fx - x0, ay = fy - y0;
          const lo = (c) => (half[(y0 * w + x0) * 3 + c] * (1 - ax) + half[(y0 * w + x1) * 3 + c] * ax) * (1 - ay) +
            (half[(y1 * w + x0) * 3 + c] * (1 - ax) + half[(y1 * w + x1) * 3 + c] * ax) * ay;
          r += (photo[j] - lo(0)) * wt;
          g += (photo[j + 1] - lo(1)) * wt;
          b += (photo[j + 2] - lo(2)) * wt;
          k += wt;
        }
      }
      if (!k) continue;
      const o = (Y * W + X) * 4;
      out[o] += r / k;
      out[o + 1] += g / k;
      out[o + 2] += b / k;
    }
  }
}
