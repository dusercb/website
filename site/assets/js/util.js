// Shared helpers. No dependencies.

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
export const reducedMotion = () => mq.matches || document.documentElement.classList.contains('motion-off');

export const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
export const lerp = (a, b, t) => a + (b - a) * t;
export const easeOut = (t) => 1 - Math.pow(1 - t, 3);
export const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

const nf = new Intl.NumberFormat('en-GB');
export const fmt = (n, d = 0) =>
  d ? Number(n).toLocaleString('en-GB', { minimumFractionDigits: d, maximumFractionDigits: d }) : nf.format(Math.round(n));
export const money = (n) => (n < 0 ? '−$' : '$') + Math.abs(n).toFixed(2);

/** Seconds since midnight -> "HH:MM:SS" (or "HH:MM"). */
export function clock(sec, withSeconds = true) {
  sec = Math.max(0, sec);
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = Math.floor(sec % 60);
  const p = (x) => String(x).padStart(2, '0');
  return withSeconds ? `${p(h)}:${p(m)}:${p(s)}` : `${p(h)}:${p(m)}`;
}

const cache = new Map();
export function fetchJSON(url) {
  if (!cache.has(url)) cache.set(url, fetch(url).then((r) => {
    if (!r.ok) throw new Error(`${url}: ${r.status}`);
    return r.json();
  }));
  return cache.get(url);
}

/** Read a CSS custom property from an element (theme-aware canvas colours). */
export const cssVar = (el, name) => getComputedStyle(el).getPropertyValue(name).trim();

/**
 * Size a canvas's backing store to its CSS box at the device pixel ratio.
 * Returns { ctx, w, h, dpr } in CSS pixels; ctx is pre-scaled.
 */
export function fitCanvas(canvas, maxDpr = 2) {
  const dpr = Math.min(maxDpr, window.devicePixelRatio || 1);
  const r = canvas.getBoundingClientRect();
  const w = Math.max(1, Math.round(r.width)), h = Math.max(1, Math.round(r.height));
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, w, h, dpr };
}

export function onResize(el, cb) {
  let raf = 0;
  const ro = new ResizeObserver(() => {
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(cb);
  });
  ro.observe(el);
  return () => ro.disconnect();
}

/** Call enter/leave as an element enters and leaves the viewport (with margin). */
export function watch(el, { enter, leave, margin = '0px', threshold = 0 } = {}) {
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (e.isIntersecting) enter?.(e);
      else leave?.(e);
    }
  }, { rootMargin: margin, threshold });
  io.observe(el);
  return () => io.disconnect();
}

/** A requestAnimationFrame loop that can be started and stopped (pauses when the tab is hidden). */
export function loop(step) {
  let raf = 0, running = false, last = 0;
  const frame = (t) => {
    if (!running) return;
    const dt = last ? Math.min(0.1, (t - last) / 1000) : 0;
    last = t;
    step(dt, t / 1000);
    raf = requestAnimationFrame(frame);
  };
  const api = {
    start() { if (running) return; running = true; last = 0; raf = requestAnimationFrame(frame); },
    stop() { running = false; cancelAnimationFrame(raf); },
    get running() { return running; },
  };
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && running) { api.stop(); api._resume = true; }
    else if (!document.hidden && api._resume) { api._resume = false; api.start(); }
  });
  return api;
}

/** Deterministic PRNG (mulberry32), so a "re-roll" can show its seed. */
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

let toastTimer = 0;
export function toast(msg) {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = msg;
  el.classList.add('is-on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('is-on'), 2200);
}

/* ---------------------------------------------------------------- odometer */
/** Roll a number up like an odometer. Text stays correct for no-JS / screen readers. */
export function odometer(el) {
  if (el.dataset.odo) return;
  el.dataset.odo = '1';
  const target = Number(el.dataset.count);
  const text = fmt(target);
  el.setAttribute('aria-label', text);
  if (reducedMotion()) { el.textContent = text; return; }
  const wrap = document.createElement('span');
  wrap.className = 'odo';
  wrap.setAttribute('aria-hidden', 'true');
  const cols = [];
  [...text].forEach((ch) => {
    if (!/\d/.test(ch)) { const s = document.createElement('span'); s.textContent = ch; wrap.append(s); return; }
    const d = document.createElement('span');
    d.className = 'odo__d';
    const strip = document.createElement('span');
    for (let i = 0; i <= 19; i++) { const n = document.createElement('span'); n.textContent = String(i % 10); strip.append(n); }
    d.append(strip);
    wrap.append(d);
    cols.push([strip, Number(ch)]);
  });
  el.textContent = '';
  el.append(wrap);
  requestAnimationFrame(() => requestAnimationFrame(() => {
    cols.forEach(([strip, n], i) => {
      strip.style.transitionDelay = `${(cols.length - i) * 55}ms`;
      strip.style.transform = `translateY(-${(n + 10)}em)`;
    });
  }));
}

/* ---------------------------------------------------------------- OCR decode */
const GLYPHS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789#%&$@';
/**
 * Decode a heading like an OCR pass: characters resolve left to right out of
 * noise. Each character keeps its final width, so nothing reflows.
 */
export function decode(el, { duration = 900 } = {}) {
  if (el.dataset.decoded || reducedMotion()) return;
  el.dataset.decoded = '1';
  const original = el.textContent;
  el.setAttribute('aria-label', original);
  const chars = [];
  const frag = document.createDocumentFragment();
  original.split(/(\s+)/).forEach((word) => {
    if (/^\s+$/.test(word)) { frag.append(document.createTextNode(word)); return; }
    if (!word) return;
    const w = document.createElement('span');
    w.style.whiteSpace = 'nowrap';
    w.setAttribute('aria-hidden', 'true');
    [...word].forEach((c) => {
      const s = document.createElement('span');
      s.textContent = c;
      s.style.display = 'inline-block';
      s.style.textAlign = 'center';
      w.append(s);
      chars.push([s, c]);
    });
    frag.append(w);
  });
  el.textContent = '';
  el.append(frag);
  chars.forEach(([s]) => { s.style.width = `${s.getBoundingClientRect().width}px`; });
  const start = performance.now();
  const n = chars.length;
  const tick = (now) => {
    const t = (now - start) / duration;
    let done = true;
    chars.forEach(([s, c], i) => {
      const at = (i / n) * 0.75;
      if (t >= at + 0.25) { if (s.textContent !== c) { s.textContent = c; s.style.color = ''; } return; }
      done = false;
      if (t >= at) { s.textContent = GLYPHS[(Math.random() * GLYPHS.length) | 0]; s.style.color = 'var(--cool)'; }
      else { s.textContent = c; s.style.color = 'transparent'; }
    });
    if (!done) requestAnimationFrame(tick);
    else chars.forEach(([s]) => { s.style.width = ''; s.style.color = ''; });
  };
  requestAnimationFrame(tick);
}

/* ---------------------------------------------------------------- tiny 4x4 matrix kit (hero) */
export const mat4 = {
  perspective(fovy, aspect, near, far) {
    const f = 1 / Math.tan(fovy / 2), nf = 1 / (near - far);
    return [f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, (far + near) * nf, -1, 0, 0, 2 * far * near * nf, 0];
  },
  lookAt(e, c, up) {
    let zx = e[0] - c[0], zy = e[1] - c[1], zz = e[2] - c[2];
    let l = Math.hypot(zx, zy, zz); zx /= l; zy /= l; zz /= l;
    let xx = up[1] * zz - up[2] * zy, xy = up[2] * zx - up[0] * zz, xz = up[0] * zy - up[1] * zx;
    l = Math.hypot(xx, xy, xz); xx /= l; xy /= l; xz /= l;
    const yx = zy * xz - zz * xy, yy = zz * xx - zx * xz, yz = zx * xy - zy * xx;
    return [xx, yx, zx, 0, xy, yy, zy, 0, xz, yz, zz, 0,
      -(xx * e[0] + xy * e[1] + xz * e[2]), -(yx * e[0] + yy * e[1] + yz * e[2]), -(zx * e[0] + zy * e[1] + zz * e[2]), 1];
  },
  mul(a, b) {
    const o = new Array(16);
    for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) {
      o[j * 4 + i] = a[i] * b[j * 4] + a[4 + i] * b[j * 4 + 1] + a[8 + i] * b[j * 4 + 2] + a[12 + i] * b[j * 4 + 3];
    }
    return o;
  },
  project(m, x, y, z) {
    const cx = m[0] * x + m[4] * y + m[8] * z + m[12];
    const cy = m[1] * x + m[5] * y + m[9] * z + m[13];
    const cw = m[3] * x + m[7] * y + m[11] * z + m[15];
    return [cx / cw, cy / cw, cw];
  },
};
