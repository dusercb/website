// 01 Tape Reader: the OCR band reading a real day's feed, and the calendar of
// every day the pipeline read. Names, first-appearance order, frame counts and
// confidences are from the 4 Aug 2026 result file; accept/reject is a port of
// the pipeline's filters.py with its own thresholds.
import { $, clamp, clock, fetchJSON, fitCanvas, fmt, loop, onResize, reducedMotion, watch } from './util.js';

const C = {
  bg: '#0d0f12', panel: '#0a0b0e', line: 'rgba(235,231,220,0.09)', ink: '#ebe7dc', ink2: '#aaa69b', ink3: '#6f6c64',
  cool: '#66d9ff', hot: '#ff5a1f', hot2: '#ff8a52', up: '#3ddc97', down: '#ff4d6a', warn: '#ffbf3c',
};
const MONO = '"JetBrains Mono", ui-monospace, monospace';

/* ------------------------------------------------------------------ filters.py, ported */
function verdicts(day) {
  const ref = day.refine || {};
  const domRatio = ref.dom_ratio ?? 2.5, single = ref.singleton_min_conf ?? 0.65;
  const uCount = ref.unlisted_min_count ?? 2, uConf = ref.unlisted_min_conf ?? 0.75;
  const all = { ...day.unlistedCounts, ...day.counts };
  const out = {};
  for (const [t, c] of Object.entries(day.counts)) {
    out[t] = c === 1 && (day.conf[t] ?? 1) < single
      ? { keep: false, why: `one frame at ${(day.conf[t]).toFixed(2)} < ${single}` }
      : { keep: true, why: 'listed' };
  }
  for (const [t, c] of Object.entries(day.unlistedCounts)) {
    if (t in day.counts) continue;
    const conf = day.unlistedConf[t] ?? 0;
    out[t] = c >= uCount && conf >= uConf
      ? { keep: true, why: `unlisted · kept on evidence (${c} frames)` }
      : { keep: false, why: `unlisted · ${c} frame${c > 1 ? 's' : ''} at ${conf.toFixed(2)}` };
  }
  for (const t of Object.keys(out)) {
    if (!out[t].keep) continue;
    const cx = all[t] || 0;
    for (const [y, cy] of Object.entries(all)) {
      const dl = y.length - t.length;
      if (y !== t && (dl === 1 || dl === 2) && (y.startsWith(t) || y.endsWith(t)) && cy >= domRatio * cx) {
        out[t] = { keep: false, why: `clipped partial of ${y} (${cy}× vs ${cx}×)` };
        break;
      }
    }
  }
  return out;
}

const lev1 = (a, b) => {
  if (a === b) return false;
  if (a.length === b.length) { let d = 0; for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) d++; return d === 1; }
  const [s, l] = a.length < b.length ? [a, b] : [b, a];
  return l.length - s.length <= 2 && (l.startsWith(s) || l.endsWith(s));
};

/** What was really on screen for a read: misreads and partials map back to the listed name they came from. */
function sourceOf(t, day) {
  if (t in day.counts) return t;
  let best = null, bc = 0;
  for (const [y, c] of Object.entries(day.counts)) if (lev1(t, y) && c > bc) { best = y; bc = c; }
  return best || t;
}

/** An alert stream: each name enters in its real first-appearance order, with repeats weighted by frame counts. */
function alertStream(day) {
  const seen = [], stream = [];
  let seed = 3;
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (const t of day.order) {
    stream.push({ shown: sourceOf(t, day), read: t });
    if (!seen.includes(t) && t in day.counts) seen.push(t);
    const reps = Math.round(rand() * 2);
    for (let r = 0; r < reps && seen.length; r++) {
      const total = seen.reduce((s, x) => s + Math.sqrt(day.counts[x]), 0);
      let pick = rand() * total, chosen = seen[0];
      for (const x of seen) { pick -= Math.sqrt(day.counts[x]); if (pick <= 0) { chosen = x; break; } }
      stream.push({ shown: chosen, read: chosen });
    }
  }
  return stream;
}

/* ------------------------------------------------------------------ the feed demo */
function feedDemo(canvas, day, hud) {
  const v = verdicts(day);
  const stream = alertStream(day);
  const ROWS = 13, BAND = [4, 5, 6];
  const date = day.date.split('-');
  const usDate = `${date[1]}/${date[2]}/${date[0]}`;
  const winStart = 7 * 3600;
  let W = 0, H = 0, ctx;
  let rows = [], next = 0, shift = 0, lastAlert = 0, lastSample = 0, t = 0, frameChanged = true;
  let boxes = [], reads = [], csv = [], frames = 0, dropped = 0;
  const seenRead = new Set(), unique = new Set(), rejected = new Set();
  const counts = {};

  const reset = () => {
    rows = Array.from({ length: ROWS }, (_, i) => stream[(stream.length - ROWS + i) % stream.length]).reverse().map((a) => ({ ...a, w: 0.3 + Math.random() * 0.6 }));
    next = 0; shift = 0; boxes = []; reads = []; csv = []; frames = 0; dropped = 0;
    seenRead.clear(); unique.clear(); rejected.clear();
    for (const k of Object.keys(counts)) delete counts[k];
  };
  reset();

  const resize = () => { ({ ctx, w: W, h: H } = fitCanvas(canvas)); };
  onResize(canvas, () => { resize(); if (!anim.running) draw(); });
  resize();

  function pushAlert() {
    if (next >= stream.length) { reset(); return; }
    rows.unshift({ ...stream[next++], w: 0.3 + Math.random() * 0.6 });
    rows.length = ROWS + 1;
    shift = 1;
    frameChanged = true;
  }

  function sample() {
    frames++;
    if (!frameChanged) { dropped++; boxes = [{ static: true, t: 0 }]; return; }
    frameChanged = false;
    boxes = [];
    for (const r of BAND) {
      const a = rows[r];
      if (!a) continue;
      const read = a.read;
      counts[read] = (counts[read] || 0) + 1;
      const conf = day.conf[read] ?? day.unlistedConf[read] ?? 0.7;
      const jitter = counts[read] > 1 ? -Math.random() * 0.05 : 0;
      boxes.push({ row: r, read, conf: conf + jitter, t: 0 });
      if (!seenRead.has(read)) {
        seenRead.add(read);
        const verdict = v[read] || { keep: true, why: 'listed' };
        reads.unshift({ read, conf, verdict, t: 0 });
        reads.length = Math.min(reads.length, 9);
        if (verdict.keep) { unique.add(read); csv.unshift({ text: `${read},${usDate}`, t: 0 }); csv.length = Math.min(csv.length, 9); }
        else rejected.add(read);
      }
    }
    hud.frames.textContent = fmt(frames);
    hud.unique.textContent = fmt(unique.size);
    hud.rejected.textContent = fmt(rejected.size);
  }

  function draw() {
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = C.bg;
    ctx.fillRect(0, 0, W, H);
    const pad = 16, hudH = 38;
    // wide: feed left, reads + catalogue right. narrow: feed on top, the two lists below.
    const narrow = W < 560;
    const fw = narrow ? W - pad * 2 : Math.round(W * 0.56), fx = pad, fy = pad + 26;
    const feedH = narrow ? H * 0.56 - fy : H - fy - hudH - pad - 22;
    const rh = feedH / (ROWS + (narrow ? 1 : 0));
    const nameW = Math.min(118, fw * 0.3);

    // stream clock, as the layout probe reads it
    ctx.font = `500 10px ${MONO}`;
    ctx.fillStyle = C.ink3;
    ctx.textBaseline = 'middle';
    ctx.fillText('STREAM CLOCK', fx, pad + 6);
    ctx.fillStyle = C.ink;
    ctx.font = `600 12px ${MONO}`;
    const clk = winStart + (next / stream.length) * (2.5 * 3600);
    ctx.fillText(`${clock(clk)} ET`, fx + 92, pad + 6);
    if (W > 480) {
      ctx.fillStyle = C.ink3;
      ctx.font = `500 10px ${MONO}`;
      ctx.fillText('← window from the on-screen clock', fx + 186, pad + 6);
    }

    // feed panel
    ctx.fillStyle = C.panel;
    ctx.fillRect(fx, fy, fw, rh * (ROWS + 1));
    ctx.fillStyle = C.ink3;
    ctx.font = `500 10.5px ${MONO}`;
    ['NAME', 'REASON', 'PRICE', 'TIME'].forEach((h, i) => ctx.fillText(h, fx + 10 + [0, nameW, nameW + (fw - nameW) * 0.42, nameW + (fw - nameW) * 0.68][i], fy + rh / 2));
    ctx.save();
    ctx.beginPath();
    ctx.rect(fx, fy + rh, fw, rh * ROWS);
    ctx.clip();
    const yOff = -shift * rh;
    rows.forEach((a, i) => {
      if (!a) return;
      const y = fy + rh * (i + 1) + yOff;
      ctx.fillStyle = i % 2 ? 'rgba(235,231,220,0.025)' : 'transparent';
      ctx.fillRect(fx, y, fw, rh);
      const inBand = BAND.includes(i);
      ctx.font = `600 ${Math.min(15, rh * 0.58)}px ${MONO}`;
      ctx.textAlign = 'right';
      ctx.fillStyle = inBand ? C.ink : C.ink2;
      ctx.fillText(a.shown, fx + nameW - 8, y + rh / 2 + 1);
      ctx.textAlign = 'left';
      // columns the OCR never reads: drawn redacted
      ctx.fillStyle = 'rgba(235,231,220,0.08)';
      const cx = fx + nameW + 6, cw = fw - nameW - 16;
      ctx.fillRect(cx, y + rh * 0.36, cw * 0.32 * a.w + 20, rh * 0.28);
      ctx.fillRect(cx + cw * 0.42, y + rh * 0.36, cw * 0.14, rh * 0.28);
      ctx.fillRect(cx + cw * 0.68, y + rh * 0.36, cw * 0.28, rh * 0.28);
    });
    ctx.restore();

    // the OCR band
    const by = fy + rh * (BAND[0] + 1), bh = rh * BAND.length;
    ctx.strokeStyle = C.cool;
    ctx.lineWidth = 1;
    ctx.setLineDash([]);
    ctx.fillStyle = 'rgba(102,217,255,0.06)';
    ctx.fillRect(fx + 2, by, nameW, bh);
    ctx.strokeRect(fx + 2.5, by + 0.5, nameW - 1, bh - 1);
    ctx.fillStyle = C.cool;
    ctx.font = `600 9.5px ${MONO}`;
    ctx.fillText('OCR BAND · 3 ROWS', fx + nameW + 8, by - 7);
    // scan line on each sample
    const scanP = Math.min(1, (t - lastSample) / 0.22);
    if (scanP < 1) {
      ctx.fillStyle = 'rgba(102,217,255,0.5)';
      ctx.fillRect(fx + 2, by + bh * scanP, nameW, 1.5);
    }
    // boxes and confidences
    for (const b of boxes) {
      const age = t - lastSample;
      const alpha = clamp(1 - age / 0.5, 0, 1);
      if (b.static) {
        ctx.fillStyle = `rgba(170,166,155,${alpha})`;
        ctx.font = `600 9.5px ${MONO}`;
        ctx.fillText('static frame · dropped', fx + nameW + 8, by + bh / 2 + 1);
        continue;
      }
      const yy = fy + rh * (b.row + 1);
      const ok = (v[b.read] || { keep: true }).keep;
      ctx.strokeStyle = ok ? `rgba(102,217,255,${0.4 + alpha * 0.6})` : `rgba(255,77,106,${0.4 + alpha * 0.6})`;
      ctx.strokeRect(fx + 10.5, yy + 3.5, nameW - 16, rh - 7);
      ctx.fillStyle = ok ? C.cool : C.down;
      ctx.font = `600 9.5px ${MONO}`;
      ctx.textAlign = 'left';
      const label = b.read === rows[b.row]?.shown ? b.conf.toFixed(2) : `${b.read} ${b.conf.toFixed(2)}`;
      ctx.fillText(label, fx + nameW + 6, yy + rh / 2 + 1);
    }

    // reads + catalogue: a right column when wide, two columns under the feed when narrow
    const listTop = narrow ? fy + feedH + 22 : fy;
    const listH = narrow ? H - listTop - hudH - 6 : (H - fy - hudH - pad) / 2;
    const rx = narrow ? pad : fx + fw + 22;
    const rw = narrow ? (W - pad * 2) / 2 - 10 : W - rx - pad;
    const half = listH;
    ctx.textAlign = 'left';
    ctx.fillStyle = C.ink3;
    ctx.font = `500 10px ${MONO}`;
    ctx.fillText(narrow ? 'NEW READS' : 'NEW READS · VALIDATED', rx, listTop + 6);
    const lh = Math.min(22, (half - 24) / (narrow ? 6 : 7));
    reads.slice(0, Math.floor((half - 24) / lh)).forEach((r, i) => {
      const y = listTop + 26 + i * lh;
      const a = i === 0 ? clamp((t - r.t0) / 0.3, 0, 1) : 1;
      ctx.globalAlpha = a;
      ctx.font = `600 12px ${MONO}`;
      ctx.fillStyle = r.verdict.keep ? C.ink : C.down;
      ctx.fillText(r.read, rx, y);
      ctx.font = `500 10.5px ${MONO}`;
      ctx.fillStyle = C.ink3;
      ctx.fillText(r.conf.toFixed(2), rx + 52, y);
      ctx.fillStyle = r.verdict.keep ? (r.verdict.why === 'listed' ? C.up : C.warn) : C.down;
      const why = narrow ? (r.verdict.keep ? '✓' : '✗') : (r.verdict.keep ? '✓ ' : '✗ ') + r.verdict.why;
      const wx = narrow ? rx + 88 : rx + 88;
      ctx.fillText(why.length * 6.4 > rw - 88 ? why.slice(0, Math.floor((rw - 92) / 6.4)) + '…' : why, wx, y);
      ctx.globalAlpha = 1;
    });
    const cx0 = narrow ? pad + (W - pad * 2) / 2 + 10 : rx;
    const cy0 = narrow ? listTop + 6 : fy + half + 18;
    ctx.fillStyle = C.ink3;
    ctx.font = `500 10px ${MONO}`;
    ctx.fillText(narrow ? 'tickers.csv' : 'OUTPUT · tickers.csv', cx0, cy0);
    ctx.strokeStyle = C.line;
    if (!narrow) { ctx.beginPath(); ctx.moveTo(rx, cy0 - 16); ctx.lineTo(rx + rw, cy0 - 16); ctx.stroke(); }
    csv.slice(0, Math.floor((half - 30) / lh)).forEach((c, i) => {
      const y = cy0 + 20 + i * lh;
      const full = c.text;
      const n = i === 0 ? Math.floor(clamp((t - c.t0) / 0.35, 0, 1) * full.length) : full.length;
      ctx.font = `500 ${narrow ? 11 : 12}px ${MONO}`;
      ctx.fillStyle = i === 0 ? C.hot2 : C.ink2;
      ctx.fillText(full.slice(0, n) + (i === 0 && n < full.length ? '▍' : ''), cx0, y);
    });
  }

  const anim = loop((dt) => {
    t += dt;
    if (shift > 0) shift = Math.max(0, shift - dt / 0.22);
    if (t - lastAlert > 0.62) { lastAlert = t; pushAlert(); }
    if (t - lastSample > 0.5) {
      lastSample = t;
      sample();
      reads.forEach((r) => { r.t0 ??= t; });
      csv.forEach((c) => { c.t0 ??= t; });
    }
    draw();
  });

  if (reducedMotion()) {
    for (let i = 0; i < 60; i++) { pushAlert(); shift = 0; sample(); }
    reads.forEach((r) => { r.t0 = -1; });
    csv.forEach((c) => { c.t0 = -1; });
    t = 10; draw();
    return;
  }
  watch(canvas, { enter: () => anim.start(), leave: () => anim.stop() });
}

/* ------------------------------------------------------------------ calendar */
function calendar(canvas, tip, data) {
  const byDate = new Map(data.calendar.map(([d, n, top]) => [d, { n, top }]));
  const first = new Date(`${data.calendar[0][0]}T12:00:00Z`);
  const last = new Date(`${data.calendar[data.calendar.length - 1][0]}T12:00:00Z`);
  const years = [];
  for (let y = first.getUTCFullYear(); y <= last.getUTCFullYear(); y++) years.push(y);
  const maxN = Math.max(...data.calendar.map((c) => c[1]));
  const boundary = data.boundary?.oldest || data.calendar[0][0];
  let W = 0, H = 0, ctx, cells = [], hover = null, progress = reducedMotion() ? 1 : 0;
  const labelW = 46, monthH = 16, gap = 2;
  const MONTHS = 'JFMAMJJASOND';
  const ramp = (f) => {
    // ink-black → ember → signal orange → pale
    const stops = [[22, 18, 16], [120, 40, 14], [255, 90, 31], [255, 196, 160]];
    const x = clamp(f, 0, 1) * (stops.length - 1), i = Math.min(stops.length - 2, Math.floor(x)), u = x - i;
    const c = stops[i].map((a, k) => Math.round(a + (stops[i + 1][k] - a) * u));
    return `rgb(${c[0]},${c[1]},${c[2]})`;
  };

  function layout() {
    const r = canvas.getBoundingClientRect();
    W = r.width;
    const cw = Math.max(4, Math.floor((W - labelW) / 53) - gap);
    const ch = Math.max(5, Math.min(13, Math.round(cw * 0.55)));
    const yearH = monthH + 5 * (ch + gap) + 14;
    H = years.length * yearH;
    canvas.style.height = `${H}px`;
    ({ ctx } = fitCanvas(canvas));
    cells = [];
    years.forEach((y, yi) => {
      const y0 = yi * yearH + monthH;
      const jan1 = new Date(Date.UTC(y, 0, 1));
      const offset = (jan1.getUTCDay() + 6) % 7; // Monday = 0
      for (let d = new Date(jan1); d.getUTCFullYear() === y; d.setUTCDate(d.getUTCDate() + 1)) {
        const wd = (d.getUTCDay() + 6) % 7;
        if (wd > 4) continue;
        const doy = Math.round((d - jan1) / 864e5);
        const week = Math.floor((doy + offset) / 7);
        const iso = d.toISOString().slice(0, 10);
        cells.push({ iso, x: labelW + week * (cw + gap), y: y0 + wd * (ch + gap), w: cw, h: ch, rec: byDate.get(iso), before: iso < boundary, after: d > last });
      }
    });
    cells.order = [...cells].sort((a, b) => (a.iso < b.iso ? 1 : -1)); // newest first, as the backfill ran
    cells.forEach((c) => { c.rank = cells.order.indexOf(c) / cells.order.length; });
    calendar.yearH = yearH; calendar.cw = cw;
  }

  function draw() {
    ctx.clearRect(0, 0, W, H);
    ctx.font = `500 10px ${MONO}`;
    ctx.textBaseline = 'middle';
    years.forEach((y, yi) => {
      const y0 = yi * calendar.yearH;
      ctx.fillStyle = C.ink2;
      ctx.fillText(String(y), 0, y0 + monthH + 2.5 * (calendar.cw * 0.55 + gap));
      for (let m = 0; m < 12; m++) {
        const d = new Date(Date.UTC(y, m, 1));
        const jan1 = new Date(Date.UTC(y, 0, 1));
        const week = Math.floor((Math.round((d - jan1) / 864e5) + (jan1.getUTCDay() + 6) % 7) / 7);
        ctx.fillStyle = C.ink3;
        ctx.fillText(MONTHS[m], labelW + week * (calendar.cw + gap), y0 + 6);
      }
    });
    for (const c of cells) {
      if (c.after) continue;
      const shown = c.rank <= progress;
      if (c.rec) {
        if (!shown) continue;
        ctx.fillStyle = ramp(Math.pow(c.rec.n / maxN, 0.85));
        ctx.fillRect(c.x, c.y, c.w, c.h);
      } else if (c.before) {
        ctx.strokeStyle = 'rgba(235,231,220,0.07)';
        ctx.beginPath(); ctx.moveTo(c.x, c.y + c.h); ctx.lineTo(c.x + c.w, c.y); ctx.stroke();
      } else {
        ctx.fillStyle = 'rgba(235,231,220,0.04)';
        ctx.fillRect(c.x, c.y, c.w, c.h);
      }
      if (hover === c) { ctx.strokeStyle = C.ink; ctx.lineWidth = 1.5; ctx.strokeRect(c.x - 1, c.y - 1, c.w + 2, c.h + 2); ctx.lineWidth = 1; }
    }
    // the boundary the pipeline found for itself, labelled inside the hatched days
    const b = cells.find((c) => c.iso === boundary);
    if (b && progress >= 1) {
      const x0 = labelW, x1 = b.x - 6;
      const midY = b.y + 2 * (b.h + gap) + b.h / 2 - (((new Date(`${boundary}T12:00:00Z`).getUTCDay() + 6) % 7) * (b.h + gap));
      ctx.font = `500 10px ${MONO}`;
      const lines = x1 - x0 > 300 ? ['feed did not exist yet:', 'boundary found by the pipeline →'] : ['no feed yet →'];
      ctx.fillStyle = 'rgba(13,15,18,0.85)';
      const tw = Math.max(...lines.map((l) => ctx.measureText(l).width)) + 14;
      ctx.fillRect(x1 - tw, midY - lines.length * 7 - 3, tw, lines.length * 14 + 6);
      ctx.fillStyle = C.hot2;
      ctx.textAlign = 'right';
      lines.forEach((l, i) => ctx.fillText(l, x1 - 7, midY - (lines.length - 1) * 7 + i * 14));
      ctx.textAlign = 'left';
    }
  }

  canvas.addEventListener('pointermove', (e) => {
    const r = canvas.getBoundingClientRect();
    const x = e.clientX - r.left, y = e.clientY - r.top;
    const c = cells.find((k) => x >= k.x && x <= k.x + k.w + gap && y >= k.y && y <= k.y + k.h + gap) || null;
    if (c !== hover) { hover = c; draw(); }
    if (c && (c.rec || c.before)) {
      const d = new Date(`${c.iso}T12:00:00Z`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
      tip.innerHTML = c.rec
        ? `<b>${d}</b><br>${c.rec.n} tickers<br><span class="tk">${c.rec.top}</span>`
        : `<b>${d}</b><br>before the alert feed existed`;
      tip.style.left = `${clamp(c.x + c.w / 2, 90, W - 90)}px`;
      tip.style.top = `${c.y}px`;
      tip.classList.add('is-on');
    } else tip.classList.remove('is-on');
  });
  canvas.addEventListener('pointerleave', () => { hover = null; tip.classList.remove('is-on'); draw(); });

  layout();
  draw();
  onResize(canvas.parentElement, () => { layout(); draw(); });
  if (progress < 1) {
    const anim = loop((dt) => { progress = Math.min(1, progress + dt / 2.6); draw(); if (progress >= 1) anim.stop(); });
    watch(canvas, { enter: () => { if (progress < 1) anim.start(); }, threshold: 0.25 });
  }
}

export async function init(section) {
  const data = await fetchJSON('data/tape.json');
  feedDemo($('#tapeCanvas', section), data.demo, { frames: $('#tapeFrames'), unique: $('#tapeUnique'), rejected: $('#tapeRejected') });
  calendar($('#calCanvas', section), $('#calTip', section), data);
}
