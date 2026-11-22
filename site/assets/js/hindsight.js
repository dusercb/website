// 02 Hindsight: a real trade replayed bar by bar, its fills re-derived from the
// raw ticks, where every setup in a sweep went, and the statistics that decided
// which strategy was real. All numbers come from data/hindsight.json, which is
// built from the backtester's own run outputs and IBKR caches.
import { $, $$, clamp, clock, easeOut, fetchJSON, fitCanvas, fmt, loop, onResize, reducedMotion, rng, watch } from './util.js';

const C = {
  bg: '#0d0f12', line: 'rgba(235,231,220,0.08)', grid: 'rgba(235,231,220,0.05)', ink: '#ebe7dc', ink2: '#aaa69b', ink3: '#6f6c64',
  hot: '#ff5a1f', hot2: '#ff8a52', up: '#3ddc97', down: '#ff4d6a', violet: '#b197fc', teal: '#2dd4bf', cool: '#66d9ff', warn: '#ffbf3c',
};
const MONO = '"JetBrains Mono", ui-monospace, monospace';
const secOf = (iso) => { const m = iso.match(/T(\d\d):(\d\d):(\d\d)/); return +m[1] * 3600 + +m[2] * 60 + +m[3]; };
const px = (n) => `$${Number(n).toFixed(2)}`;

/* ================================================================== the trade replay */
function tradeReplay(root, d) {
  const tr = d.trade;
  const canvas = $('#tradeCanvas', root);
  const note = $('#tradeNote', root);
  const states = $$('#tradeStates li', root);
  const clockEl = $('#tradeClock', root);
  const playBtn = $('#tradePlay', root);
  const T0 = 8 * 3600, T1 = 8 * 3600 + 30 * 60;
  const bars = d.bars.filter((b) => b[0] >= T0 && b[0] < T1);
  const t = {
    hod: secOf(tr.premarket_high_time), pull: secOf(tr.pullback_low_time), trig: secOf(tr.trigger_time),
    entry: secOf(tr.entry_time), bank: secOf(tr.exit_legs[0].time), exit: secOf(tr.exit_time),
  };
  const P = {
    hod: +tr.premarket_high, pull: +tr.pullback_low, trig: +tr.trigger_price, entry: +tr.entry_price,
    target: +tr.target_price, stop: +tr.stop_price, bank: tr.exit_legs[0].price, exit: tr.exit_legs[1].price, rip: +tr.rip_low,
  };
  // where the rip launched: the lowest low before the high of day
  const before = bars.filter((b) => b[0] <= t.hod);
  const ripBar = before.reduce((a, b) => (b[3] < a[3] ? b : a), before[0]);
  t.rip = ripBar[0];
  t.arm = t.pull; // armed once the pullback's red candle completes

  // the runner's stop: breakeven after the 1R bank, then each completed minute's low
  const trail = [[t.bank, P.entry]];
  let stopLvl = P.entry;
  for (let m = Math.floor(t.bank / 60) * 60; m + 60 <= t.exit; m += 60) {
    const inMin = bars.filter((b) => b[0] >= m && b[0] < m + 60);
    if (!inMin.length) continue;
    const low = Math.min(...inMin.map((b) => b[3]));
    if (m + 60 > t.bank && low > stopLvl) { stopLvl = low; trail.push([m + 60, stopLvl]); }
  }
  const trailFinal = stopLvl;

  const notes = [
    [t.rip, 1, 'Rip', `FLYX launches from ${px(P.rip)}. Volume would peak at ${fmt(+tr.max_rvol_seen)}× its normal pace.`],
    [t.hod, 1, 'High of day', `${px(P.hod)} at ${clock(t.hod)}: +${(+tr.premarket_gain_pct).toFixed(1)}% from the premarket open.`],
    [t.pull, 2, 'First pullback', `Down to ${px(P.pull)}, giving back ${(+tr.pullback_retrace_pct).toFixed(0)}% of the rip. The formation holds.`],
    [t.arm + 1, 3, 'Armed', `Trigger at the last red candle's high, ${px(P.trig)}. Stop at the pullback low ${px(P.stop)}, target 1R ${px(P.target)}.`],
    [t.entry, 4, 'Filled', `${px(P.entry)}: the first real print after the cross, plus 100 ms. Slippage ${px(+tr.slippage)}.`],
    [t.bank, 5, '½ banked at 1R', `${px(P.bank)}, one second after entry. The runner's stop moves to breakeven.`],
    [t.bank + 50, 6, 'Runner trailing', 'A fat green candle dropped the target. The stop ratchets up to each completed 1-minute low.'],
    [t.exit, 7, 'Exit', `Trailed out at ${px(P.exit)} (stop ${px(trailFinal)}). The trade: +${(+tr.r_multiple).toFixed(1)}R.`],
  ];

  let W = 0, H = 0, ctx, now = T0, playing = !reducedMotion(), hoverBar = null, noteIdx = -1;
  const vmax = Math.max(...bars.map((b) => b[5]));
  const pad = { l: 10, r: 58, t: 16, b: 74 };
  // The view eases between the whole half hour and a close-up of the entry,
  // because the high, the pullback, the fill and the 1R bank all happen inside
  // forty seconds.
  const ZOOM = [t.hod - 150, t.bank + 90];
  const rangeOf = (a, b) => {
    const inV = bars.filter((x) => x[0] >= a - 10 && x[0] <= b);
    let lo = Math.min(...inV.map((x) => x[3])), hi = Math.max(...inV.map((x) => x[2]));
    if (b - a < 900) { lo = Math.min(lo, P.stop); hi = Math.max(hi, P.target); }
    const m = (hi - lo) * 0.08;
    return [lo - m, hi + m];
  };
  const FULL = [T0, T1, ...rangeOf(T0, T1)];
  const CLOSE = [ZOOM[0], ZOOM[1], ...rangeOf(ZOOM[0], ZOOM[1])];
  const view = [...FULL];
  const zoomed = () => now >= t.hod - 70 && now < t.bank + 34;
  const X = (s) => pad.l + ((s - view[0]) / (view[1] - view[0])) * (W - pad.l - pad.r);
  const Y = (p) => pad.t + (1 - (p - view[2]) / (view[3] - view[2])) * (H - pad.t - pad.b);

  const resize = () => { ({ ctx, w: W, h: H } = fitCanvas(canvas)); };

  function setState(i) {
    states.forEach((li, k) => { li.classList.toggle('is-done', k < i); li.classList.toggle('is-now', k === i); });
  }
  function showNote(i) {
    if (i === noteIdx) return;
    noteIdx = i;
    if (i < 0) { note.classList.remove('is-on'); return; }
    const [, , title, body] = notes[i];
    note.innerHTML = `<small>${clock(notes[i][0])} · ${title}</small>${body}`;
    note.classList.add('is-on');
  }

  function draw() {
    ctx.clearRect(0, 0, W, H);
    const span = view[1] - view[0];
    const bw = Math.max(1.5, ((W - pad.l - pad.r) / (span / 10)) * 0.62);
    // grid + price axis
    ctx.font = `500 10.5px ${MONO}`;
    ctx.textBaseline = 'middle';
    const pStep = view[3] - view[2] > 2 ? 0.5 : 0.1;
    for (let p = Math.ceil(view[2] / pStep) * pStep; p <= view[3]; p += pStep) {
      const y = Y(p);
      ctx.strokeStyle = C.grid; ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(W - pad.r, y); ctx.stroke();
      ctx.fillStyle = C.ink3; ctx.fillText(px(p), W - pad.r + 8, y);
    }
    const tStep = span > 900 ? 300 : 30;
    for (let s = Math.ceil(view[0] / tStep) * tStep; s <= view[1]; s += tStep) {
      const x = X(s);
      ctx.strokeStyle = C.grid; ctx.beginPath(); ctx.moveTo(x, pad.t); ctx.lineTo(x, H - pad.b + 44); ctx.stroke();
      ctx.fillStyle = C.ink3; ctx.textAlign = 'center'; ctx.fillText(clock(s, tStep < 60), x, H - 12); ctx.textAlign = 'left';
    }
    ctx.save();
    ctx.beginPath(); ctx.rect(pad.l, 0, W - pad.l - pad.r, H); ctx.clip();
    // holding period
    if (now >= t.entry) {
      ctx.fillStyle = 'rgba(61,220,151,0.06)';
      ctx.fillRect(X(t.entry), pad.t, X(Math.min(now, t.exit)) - X(t.entry), H - pad.t - pad.b);
    }
    // candles + volume
    const volTop = H - pad.b + 8, volH = 34;
    for (const b of bars) {
      if (b[0] > now) break;
      if (b[0] < view[0] - 10 || b[0] > view[1]) continue;
      const [s, o, h, l, c, v] = b;
      const x = X(s + 5), up = c >= o;
      ctx.strokeStyle = ctx.fillStyle = up ? C.up : C.down;
      ctx.globalAlpha = hoverBar && hoverBar !== b ? 0.75 : 1;
      ctx.beginPath(); ctx.moveTo(x, Y(h)); ctx.lineTo(x, Y(l)); ctx.stroke();
      const y0 = Y(Math.max(o, c)), y1 = Y(Math.min(o, c));
      ctx.fillRect(x - bw / 2, y0, bw, Math.max(1, y1 - y0));
      ctx.globalAlpha = 0.35;
      const vh = (v / vmax) * volH;
      ctx.fillRect(x - bw / 2, volTop + volH - vh, bw, vh);
      ctx.globalAlpha = 1;
    }
    const mark = (shape, s, p, color, size = 6) => {
      const x = X(s), y = Y(p);
      ctx.fillStyle = color; ctx.strokeStyle = C.bg; ctx.lineWidth = 1.5;
      ctx.beginPath();
      if (shape === 'up') { ctx.moveTo(x, y - size); ctx.lineTo(x + size, y + size * 0.7); ctx.lineTo(x - size, y + size * 0.7); }
      else if (shape === 'down') { ctx.moveTo(x, y + size); ctx.lineTo(x + size, y - size * 0.7); ctx.lineTo(x - size, y - size * 0.7); }
      else if (shape === 'star') { for (let i = 0; i < 10; i++) { const r = i % 2 ? size * 0.45 : size * 1.15, a = -Math.PI / 2 + (i * Math.PI) / 5; ctx.lineTo(x + r * Math.cos(a), y + r * Math.sin(a)); } }
      else ctx.arc(x, y, size * 0.7, 0, 7);
      ctx.closePath(); ctx.stroke(); ctx.fill(); ctx.lineWidth = 1;
    };
    const hline = (p, s0, s1, color, dash = [5, 4]) => {
      ctx.strokeStyle = color; ctx.setLineDash(dash); ctx.beginPath(); ctx.moveTo(X(s0), Y(p)); ctx.lineTo(X(s1), Y(p)); ctx.stroke(); ctx.setLineDash([]);
    };
    if (now >= t.rip) mark('circle', t.rip, P.rip, C.ink2, 5);
    if (now >= t.hod) mark('up', t.hod, P.hod, C.violet, 6.5);
    if (now >= t.pull) mark('down', t.pull, P.pull, C.teal, 6.5);
    if (now >= t.arm) hline(P.trig, t.arm, Math.min(now, t.entry), C.hot);
    if (now >= t.entry) {
      hline(P.target, t.entry, Math.min(now, t.bank), C.up);
      hline(P.stop, t.entry, Math.min(now, t.bank), C.down);
      mark('up', t.entry, P.entry, C.up, 6.5);
    }
    if (now >= t.bank) {
      mark('circle', t.bank, P.bank, C.up, 6);
      // the trailing stop as it ratcheted
      ctx.strokeStyle = C.hot2; ctx.setLineDash([2, 3]); ctx.beginPath();
      trail.forEach(([s, lvl], i) => {
        if (s > now) return;
        const nextS = Math.min(now, t.exit, trail[i + 1]?.[0] ?? t.exit);
        if (i === 0) ctx.moveTo(X(s), Y(lvl)); else ctx.lineTo(X(s), Y(lvl));
        ctx.lineTo(X(nextS), Y(lvl));
      });
      ctx.stroke(); ctx.setLineDash([]);
    }
    if (now >= t.exit) mark('star', t.exit, P.exit, C.up, 7.5);
    // the trade's labels, on chips so they read over candles
    const chip = (text, x, y, color, align = 'left') => {
      ctx.font = `600 10.5px ${MONO}`;
      const w = ctx.measureText(text).width + 10;
      const bx = align === 'right' ? x - w : x;
      ctx.fillStyle = 'rgba(7,8,10,0.85)'; ctx.fillRect(bx, y - 9, w, 18);
      ctx.fillStyle = color; ctx.fillText(text, bx + 5, y + 0.5);
    };
    const close = span < 900;
    if (now >= t.hod) chip(`HOD ${px(P.hod)}`, X(t.hod) - 12, Y(P.hod) - 14, C.violet, 'right');
    if (close && now >= t.pull) chip(`pullback ${px(P.pull)}`, X(t.pull) + 12, Y(P.pull) + 14, C.teal);
    if (close && now >= t.arm && now < t.bank + 30) chip(`trigger ${px(P.trig)}`, X(t.arm) - 12, Y(P.trig), C.hot, 'right');
    if (close && now >= t.entry) {
      chip(`fill ${px(P.entry)}`, X(t.entry) + 12, Y(P.entry), C.up);
      chip(`target 1R ${px(P.target)}`, W - pad.r - 6, Y(P.target) - 12, C.up, 'right');
      chip(`stop ${px(P.stop)}`, W - pad.r - 6, Y(P.stop) + 12, C.down, 'right');
    }
    if (close && now >= t.bank) chip(`½ banked ${px(P.bank)}`, X(t.bank) + 12, Y(P.bank) - 16, C.up);
    if (now >= t.exit) chip(`exit ${px(P.exit)} · +${(+tr.r_multiple).toFixed(1)}R`, X(t.exit) - 12, Y(P.exit) - 24, C.up, 'right');
    ctx.restore();
    // hover crosshair readout
    if (hoverBar) {
      const [s, o, h, l, c, v] = hoverBar;
      const x = X(s + 5);
      ctx.strokeStyle = 'rgba(235,231,220,0.25)'; ctx.beginPath(); ctx.moveTo(x, pad.t); ctx.lineTo(x, H - pad.b + 42); ctx.stroke();
      const txt = `${clock(s)}  O ${o.toFixed(2)}  H ${h.toFixed(2)}  L ${l.toFixed(2)}  C ${c.toFixed(2)}  V ${fmt(v)}`;
      ctx.font = `500 11px ${MONO}`;
      const tw = ctx.measureText(txt).width + 16;
      const bx = clamp(x - tw / 2, pad.l, W - pad.r - tw);
      ctx.fillStyle = 'rgba(7,8,10,0.9)'; ctx.fillRect(bx, H - pad.b - 26, tw, 22);
      ctx.fillStyle = C.ink; ctx.fillText(txt, bx + 8, H - pad.b - 15);
    }
    // the "now" cursor
    if (playing && now < T1) {
      ctx.strokeStyle = 'rgba(255,90,31,0.5)'; ctx.beginPath(); ctx.moveTo(X(now), pad.t); ctx.lineTo(X(now), H - pad.b + 42); ctx.stroke();
    }
    clockEl.textContent = `${clock(Math.min(now, T1))} ET`;
    let si = 0, ni = -1;
    notes.forEach(([s, st], i) => { if (now >= s) { si = st; ni = i; } });
    if (now < t.rip) si = 0;
    setState(si);
    showNote(ni);
  }

  // speed: brisk through the build-up, slow through the entry, brisk again
  const speed = (s) => (s >= t.hod - 40 && s <= t.bank + 24 ? 8 : 75);
  const ease = (dt) => {
    const goal = zoomed() ? CLOSE : FULL;
    const k = Math.min(1, dt * 3.2);
    let moving = false;
    for (let i = 0; i < 4; i++) { const dv = goal[i] - view[i]; view[i] += dv * k; if (Math.abs(dv) > 1e-3) moving = true; }
    return moving;
  };
  const anim = loop((dt) => {
    if (playing) {
      now += dt * speed(now);
      if (now >= T1) { now = T1; playing = false; playBtn.classList.add('is-paused'); playBtn.setAttribute('aria-label', 'Play the replay'); }
    }
    const moving = ease(dt);
    if (playing || moving) draw();
  });

  playBtn.addEventListener('click', () => {
    if (now >= T1) now = T0;
    playing = !playing;
    playBtn.classList.toggle('is-paused', !playing);
    playBtn.setAttribute('aria-label', playing ? 'Pause the replay' : 'Play the replay');
    if (playing) anim.start(); else draw();
  });
  const restart = () => { now = T0; playing = true; playBtn.classList.remove('is-paused'); anim.start(); };
  $('#tradeRestart', root).addEventListener('click', restart);
  addEventListener('trade:replay', restart);
  canvas.addEventListener('pointermove', (e) => {
    const r = canvas.getBoundingClientRect();
    const s = view[0] + ((e.clientX - r.left - pad.l) / (W - pad.l - pad.r)) * (view[1] - view[0]);
    hoverBar = bars.find((b) => b[0] <= s && s < b[0] + 10 && b[0] <= now) || null;
    if (!anim.running || !playing) draw();
  });
  canvas.addEventListener('pointerleave', () => { hoverBar = null; if (!playing) draw(); });

  resize();
  onResize(canvas, () => { resize(); draw(); });
  if (reducedMotion()) { now = T1; playing = false; playBtn.classList.add('is-paused'); view.splice(0, 4, ...FULL); draw(); return; }
  draw();
  watch(canvas, { enter: () => anim.start(), leave: () => anim.stop(), threshold: 0.3 });
}

/* ================================================================== tick microscope */
function microscope(root, d) {
  const fig = $('#micro', root);
  const canvas = $('#microCanvas', root);
  const read = $('#microRead', root);
  const tip = $('#microTip', root);
  const tr = d.trade;
  const latency = d.latency;
  let which = 'entry', W = 0, H = 0, ctx, model, hover = null, appear = 1;

  function build(kind) {
    const w = d.ticks[d.windows[kind]];
    const ticks = w.ticks.map(([x, p, s, e]) => ({ x, p, s, e }));
    const bar = d.bars.find((b) => b[0] === w.t0);
    if (kind === 'entry') {
      const trig = +tr.trigger_price;
      const ci = ticks.findIndex((k) => k.p >= trig);
      const crossSec = Math.floor(ticks[ci].x);
      // _delayed_fill: the first print at or after cross + latency. IBKR stamps
      // historical ticks to the second, so that is the first print of a later second.
      const fi = ticks.findIndex((k, i) => i >= ci && Math.floor(k.x) >= crossSec + latency);
      // first_touch_from_ticks scans exits from just after the crossing print;
      // a target is a resting limit, so it fills at the crossing print itself
      const target = +tr.target_price;
      const ti = ticks.findIndex((k, i) => i > ci && k.p >= target);
      return {
        kind, ticks, bar, w, levels: [[trig, C.hot, `trigger ${px(trig)}`], [target, C.up, `target ${px(target)}`], [+tr.stop_price, C.down, `stop ${px(+tr.stop_price)}`]],
        marks: [[ci, C.hot, 'first print at or above the trigger'], [fi, C.up, 'fill: first print after cross + 100 ms'], [ti, C.up, '½ banked at the target\'s crossing print']],
        rows: [
          ['Bar says', `H ${bar[2].toFixed(2)} L ${bar[3].toFixed(2)}`], ['Trades inside', fmt(ticks.length)], ['Venues', String(new Set(ticks.map((k) => k.e)).size)],
          ['Fill derived here', `${px(ticks[fi].p)} @ ${clock(w.t0 + Math.floor(ticks[fi].x))}`, 'up'],
          ['Backtest recorded', `${px(+tr.entry_price)} @ ${tr.entry_time.slice(11, 19)}`],
          ['Match', ticks[fi].p.toFixed(2) === (+tr.entry_price).toFixed(2) && clock(w.t0 + Math.floor(ticks[fi].x)) === tr.entry_time.slice(11, 19) ? 'exact ✓' : 'differs', 'up'],
        ],
      };
    }
    const stopLvl = +tr.trail_stop_final;
    const ci = ticks.findIndex((k) => k.p <= stopLvl);
    const crossSec = Math.floor(ticks[ci].x);
    // a stop has to race to the market: its fill is the print `latency` after the cross
    const fi = ticks.findIndex((k, i) => i >= ci && Math.floor(k.x) >= crossSec + latency);
    const leg = tr.exit_legs[1];
    return {
      kind, ticks, bar, w, levels: [[stopLvl, C.hot2, `trailing stop ${px(stopLvl)}`]],
      marks: [[ci, C.hot, 'first print at or below the trailing stop'], [fi, C.up, 'exit: first print after cross + 100 ms']],
      rows: [
        ['Bar says', `H ${bar[2].toFixed(2)} L ${bar[3].toFixed(2)}`], ['Trades inside', fmt(ticks.length)], ['Venues', String(new Set(ticks.map((k) => k.e)).size)],
        ['Exit derived here', `${px(ticks[fi].p)} @ ${clock(w.t0 + Math.floor(ticks[fi].x))}`, 'up'],
        ['Backtest recorded', `${px(leg.price)} @ ${leg.time.slice(11, 19)}`],
        ['Match', ticks[fi].p.toFixed(2) === leg.price.toFixed(2) && clock(w.t0 + Math.floor(ticks[fi].x)) === leg.time.slice(11, 19) ? 'exact ✓' : 'differs', 'up'],
      ],
    };
  }

  function draw() {
    if (!model) return;
    ctx.clearRect(0, 0, W, H);
    const pad = { l: 12, r: 70, t: 18, b: 26 };
    const ps = model.ticks.map((k) => k.p).concat(model.levels.map((l) => l[0]));
    const lo = Math.min(...ps) - 0.015, hi = Math.max(...ps) + 0.015;
    const X = (x) => pad.l + (x / 10) * (W - pad.l - pad.r);
    const Y = (p) => pad.t + (1 - (p - lo) / (hi - lo)) * (H - pad.t - pad.b);
    ctx.font = `500 10.5px ${MONO}`;
    ctx.textBaseline = 'middle';
    for (let s = 0; s <= 10; s++) {
      ctx.strokeStyle = C.grid; ctx.beginPath(); ctx.moveTo(X(s), pad.t); ctx.lineTo(X(s), H - pad.b); ctx.stroke();
      ctx.fillStyle = C.ink3; ctx.textAlign = 'center'; ctx.fillText(`:${String((model.w.t0 + s) % 60).padStart(2, '0')}`, X(s), H - 11);
    }
    ctx.textAlign = 'left';
    for (const [p, col, label] of model.levels) {
      ctx.strokeStyle = col; ctx.setLineDash([5, 4]); ctx.beginPath(); ctx.moveTo(pad.l, Y(p)); ctx.lineTo(W - pad.r, Y(p)); ctx.stroke(); ctx.setLineDash([]);
      ctx.fillStyle = col; ctx.fillText(label.split(' ').pop(), W - pad.r + 6, Y(p));
    }
    const n = Math.floor(model.ticks.length * appear);
    for (let i = 0; i < n; i++) {
      const k = model.ticks[i];
      const r = clamp(Math.sqrt(k.s) / 7, 0.9, 4.2);
      ctx.fillStyle = k === hover ? C.ink : `rgba(235,231,220,${0.18 + Math.min(0.5, k.s / 2000)})`;
      ctx.beginPath(); ctx.arc(X(k.x), Y(k.p), k === hover ? r + 2 : r, 0, 7); ctx.fill();
    }
    if (appear >= 1) {
      // numbered rings on the decisive prints, explained in a legend in clear space
      const a = model.ticks[model.marks[0][0]], b = model.ticks[model.marks[1][0]];
      ctx.strokeStyle = C.up; ctx.setLineDash([2, 3]); ctx.beginPath(); ctx.moveTo(X(a.x), Y(a.p)); ctx.lineTo(X(b.x), Y(b.p)); ctx.stroke(); ctx.setLineDash([]);
      model.marks.forEach(([i, col], j) => {
        const k = model.ticks[i];
        if (!k) return;
        const x = X(k.x), y = Y(k.p);
        ctx.strokeStyle = col; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(x, y, 8, 0, 7); ctx.stroke(); ctx.lineWidth = 1;
        const bx = x + 11, by = y - 13;
        ctx.fillStyle = col; ctx.beginPath(); ctx.arc(bx, by, 7.5, 0, 7); ctx.fill();
        ctx.fillStyle = '#0b0b0b'; ctx.font = `700 10px ${MONO}`; ctx.textAlign = 'center'; ctx.fillText(String(j + 1), bx, by + 0.5); ctx.textAlign = 'left';
      });
      ctx.font = `500 11px ${MONO}`;
      const lines = model.marks.map(([i, col, label], j) => [`${j + 1}  ${label} · ${clock(model.w.t0 + Math.floor(model.ticks[i].x))} · ${px(model.ticks[i].p)}`, col]);
      const lw = Math.max(...lines.map(([s]) => ctx.measureText(s).width)) + 20;
      const lx = W - pad.r - lw - 8, ly = model.kind === 'entry' ? Y(model.levels[2][0]) - lines.length * 18 - 14 : pad.t + 8;
      ctx.fillStyle = 'rgba(7,8,10,0.88)'; ctx.fillRect(lx, ly, lw, lines.length * 18 + 10);
      ctx.strokeStyle = C.line; ctx.strokeRect(lx + 0.5, ly + 0.5, lw - 1, lines.length * 18 + 9);
      lines.forEach(([s, col], j) => { ctx.fillStyle = col; ctx.fillText(s, lx + 10, ly + 14 + j * 18); });
    }
  }

  function setWindow(kind) {
    which = kind;
    model = build(kind);
    read.innerHTML = model.rows.map(([k, v, cls]) => `<dt>${k}</dt><dd class="${cls || ''}">${v}</dd>`).join('');
    $$('.micro__tabs button', fig).forEach((b) => b.setAttribute('aria-selected', String(b.dataset.w === kind)));
    $('.demo__cap', fig).innerHTML = `<span class="fig">FIG. 2.2</span> Tick microscope: the single 10-second candle at ${clock(model.w.t0)}, every trade inside it. IBKR stamps historical ticks to the second, so trades within a second are spread in sequence order.`;
    appear = reducedMotion() ? 1 : 0;
    if (appear < 1) intro.start(); else draw();
  }
  const intro = loop((dt) => { appear = Math.min(1, appear + dt / 1.1); draw(); if (appear >= 1) intro.stop(); });

  canvas.addEventListener('pointermove', (e) => {
    if (!model) return;
    const r = canvas.getBoundingClientRect();
    const mx = e.clientX - r.left, my = e.clientY - r.top;
    const pad = { l: 12, r: 70, t: 18, b: 26 };
    const ps = model.ticks.map((k) => k.p).concat(model.levels.map((l) => l[0]));
    const lo = Math.min(...ps) - 0.015, hi = Math.max(...ps) + 0.015;
    let best = null, bd = 144;
    for (const k of model.ticks) {
      const x = pad.l + (k.x / 10) * (W - pad.l - pad.r), y = pad.t + (1 - (k.p - lo) / (hi - lo)) * (H - pad.t - pad.b);
      const dd = (x - mx) ** 2 + (y - my) ** 2;
      if (dd < bd) { bd = dd; best = k; }
    }
    if (best !== hover) {
      hover = best;
      tip.innerHTML = best ? `${clock(model.w.t0 + Math.floor(best.x))} · trade #${model.ticks.indexOf(best) + 1}<br>${px(best.p)} × ${fmt(best.s)} sh<br>on ${d.exchanges[best.e]}` : 'Hover a trade.';
      draw();
    }
  });

  $$('.micro__tabs button', fig).forEach((b) => b.addEventListener('click', () => setWindow(b.dataset.w)));
  const open = () => {
    fig.hidden = false;
    ({ ctx, w: W, h: H } = fitCanvas(canvas));
    setWindow(which);
    fig.scrollIntoView({ behavior: reducedMotion() ? 'auto' : 'smooth', block: 'center' });
  };
  $('#tickOpen', root).addEventListener('click', open);
  onResize(canvas, () => { if (fig.hidden) return; ({ ctx, w: W, h: H } = fitCanvas(canvas)); draw(); });
}

/* ================================================================== funnel + gates */
function funnel(root, d) {
  const el = $('#funnel', root);
  const total = d.funnel[0][1];
  const L = (n) => Math.log10(Math.max(1, n)) / Math.log10(total);
  let remaining = total;
  const rows = d.funnel.map(([label, n], i) => {
    const head = i === 0, end = i === d.funnel.length - 1;
    let keep, cut = 0, num;
    if (head) { keep = 1; num = fmt(total); }
    else if (end) { keep = L(n); num = fmt(n); }
    else { const prev = remaining; remaining -= n; keep = L(remaining); cut = L(prev) - keep; num = `<small>−${fmt(n)}</small>`; }
    return `<div class="fn ${head ? 'fn--head' : ''} ${end ? 'fn--end' : ''}"><span class="fn__label">${label}</span>
      <span class="fn__bar"><i class="fn__keep" style="width:${(keep * 100).toFixed(2)}%;transition-delay:${i * 70}ms"></i>${cut ? `<i class="fn__cut" style="left:${(keep * 100).toFixed(2)}%;width:${(cut * 100).toFixed(2)}%;transition-delay:${i * 70 + 200}ms"></i>` : ''}</span>
      <span class="fn__n">${num}</span></div>`;
  });
  el.innerHTML = rows.join('') + '<p class="small" style="margin:10px 0 0">Bar lengths on a log scale; hatched = removed at that step. Dip strategy, run of 12 Aug 2026.</p>';
  watch(el, { enter: () => el.classList.add('is-in'), threshold: 0.3 });

  const g = $('#gates', root);
  const LABELS = {
    skipped_outside_entry_window: 'Outside the entry window',
    skipped_rvol_not_yet_confirmed: "Volume hadn't confirmed yet",
    skipped_red_volume_dominant: 'Sellers outweighed buyers',
    skipped_no_red_dip_candle: 'No red candle in the dip',
    skipped_macd_not_bullish: 'MACD not bullish',
    skipped_fill_exceeds_limit: 'Fill would break the limit',
    skipped_no_macd_bar: 'No completed MACD bar yet',
    skipped_buy_below_vwap: 'Below VWAP',
  };
  const items = Object.entries(d.gates).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
  const max = Math.max(...items.map((x) => x[1]), d.strategies.dip.n);
  const trades = d.strategies.dip.n;
  g.innerHTML = [[`Traded`, trades, 'gt--trade'], ...items.map(([k, v]) => [LABELS[k] || k.replace('skipped_', '').replaceAll('_', ' '), v, k === 'skipped_rvol_not_yet_confirmed' ? 'gt--hind' : ''])]
    .map(([label, v, cls], i) => `<div class="gt ${cls}"><span>${label}</span><span class="gt__bar"><i style="--w:${(v / max).toFixed(4)};transition-delay:${i * 60}ms"></i></span><span>${fmt(v)}</span></div>`)
    .join('');
  watch(g, { enter: () => g.classList.add('is-in'), threshold: 0.3 });
}

/* ================================================================== confidence intervals */
function ciChart(canvas, d) {
  const rows = [['Dip', d.strategies.dip, C.up], ['Wedge', d.strategies.wedge, C.down]];
  let ctx, W, H, appear = reducedMotion() ? 1 : 0;
  const draw = () => {
    ctx.clearRect(0, 0, W, H);
    const pad = { l: 16, r: 16, t: 30, b: 34 };
    const lo = -0.45, hi = 1.0;
    const X = (r) => pad.l + ((r - lo) / (hi - lo)) * (W - pad.l - pad.r);
    ctx.font = `500 10.5px ${MONO}`;
    ctx.textBaseline = 'middle';
    for (let r = -0.4; r <= 1.001; r += 0.2) {
      const x = X(r);
      ctx.strokeStyle = Math.abs(r) < 1e-6 ? 'rgba(235,231,220,0.45)' : C.grid;
      ctx.beginPath(); ctx.moveTo(x, pad.t - 8); ctx.lineTo(x, H - pad.b); ctx.stroke();
      ctx.fillStyle = Math.abs(r) < 1e-6 ? C.ink : C.ink3; ctx.textAlign = 'center';
      ctx.fillText(`${r > 0 ? '+' : ''}${r.toFixed(1)}R`, x, H - 14);
    }
    ctx.textAlign = 'left';
    const rowH = (H - pad.t - pad.b) / rows.length;
    rows.forEach(([name, s, col], i) => {
      const sig = s.sig;
      const y = pad.t + rowH * (i + 0.5);
      const e = easeOut(clamp(appear * 1.6 - i * 0.35, 0, 1));
      const m = sig.mean_r;
      ctx.strokeStyle = col; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(X(m - (m - sig.ci95_low) * e), y); ctx.lineTo(X(m + (sig.ci95_high - m) * e), y); ctx.stroke();
      [sig.ci95_low, sig.ci95_high].forEach((v) => { const x = X(m + (v - m) * e); ctx.beginPath(); ctx.moveTo(x, y - 7); ctx.lineTo(x, y + 7); ctx.stroke(); });
      ctx.lineWidth = 1;
      ctx.fillStyle = col; ctx.beginPath(); ctx.arc(X(m), y, 6, 0, 7); ctx.fill();
      ctx.font = `700 15px "Anybody", sans-serif`; ctx.fillStyle = C.ink;
      ctx.fillText(name, pad.l, y - 30);
      ctx.font = `500 10.5px ${MONO}`; ctx.fillStyle = C.ink2;
      ctx.fillText(`n ${s.n} · mean ${m.toFixed(2)}R · t ${sig.t_stat.toFixed(2)} · PF ${s.profit_factor.toFixed(2)}`, pad.l + 62, y - 30);
      if (name === 'Dip' && appear >= 1) {
        [[sig.mean_r_excl_top1, '−1'], [sig.mean_r_excl_top3, '−3'], [sig.mean_r_excl_top5, '−5']].forEach(([v, lab]) => {
          ctx.fillStyle = C.ink2; ctx.beginPath(); ctx.arc(X(v), y + 15, 2.5, 0, 7); ctx.fill();
          ctx.textAlign = 'center'; ctx.fillText(lab, X(v), y + 27); ctx.textAlign = 'left';
        });
        ctx.fillStyle = C.ink3;
        ctx.fillText('↑ mean without its best 1, 3 and 5 trades', X(sig.mean_r_excl_top5) - 8, y + 43);
      }
      if (name === 'Wedge' && appear >= 1) {
        ctx.save(); ctx.translate(X(0.74), y + 2); ctx.rotate(-0.08);
        ctx.strokeStyle = C.down; ctx.lineWidth = 1.5; ctx.strokeRect(-36, -13, 72, 26);
        ctx.fillStyle = C.down; ctx.font = `700 12px ${MONO}`; ctx.textAlign = 'center'; ctx.fillText('CUT', 0, 1);
        ctx.restore(); ctx.textAlign = 'left'; ctx.lineWidth = 1;
      }
    });
  };
  const size = () => { ({ ctx, w: W, h: H } = fitCanvas(canvas)); };
  size();
  onResize(canvas, () => { size(); draw(); });
  draw();
  const anim = loop((dt) => { appear = Math.min(1, appear + dt / 1.4); draw(); if (appear >= 1) anim.stop(); });
  if (appear < 1) watch(canvas, { enter: () => { if (appear < 1) anim.start(); }, threshold: 0.4 });
}

/* ================================================================== Monte Carlo, live */
function monteCarlo(root, d) {
  const canvas = $('#mcCanvas', root);
  const cap = $('#mcCaption', root);
  let which = 'dip', seed = 0x5eed, paths = null, actual = null, bands = null, ctx, W, H, appear = 1;
  const ITER = 1000, SHOW = 140;

  function simulate() {
    const r = which === 'dip' ? d.rDip : d.rWedge;
    const n = r.length, rand = rng(seed);
    const t0 = performance.now();
    paths = new Array(ITER);
    for (let i = 0; i < ITER; i++) {
      const p = new Float32Array(n + 1);
      for (let k = 1; k <= n; k++) p[k] = p[k - 1] + r[(rand() * n) | 0];
      paths[i] = p;
    }
    actual = new Float32Array(n + 1);
    for (let k = 1; k <= n; k++) actual[k] = actual[k - 1] + r[k - 1];
    bands = Array.from({ length: n + 1 }, (_, k) => {
      const col = paths.map((p) => p[k]).sort((a, b) => a - b);
      const q = (f) => col[Math.min(ITER - 1, Math.floor(f * ITER))];
      return [q(0.05), q(0.25), q(0.5), q(0.75), q(0.95)];
    });
    const below = paths.filter((p) => p[n] < 0).length / ITER;
    const ms = performance.now() - t0;
    cap.textContent = `${fmt(ITER)} bootstrap resamples of the ${n} real ${which} trades, computed in your browser just now (${ms.toFixed(0)} ms, seed 0x${seed.toString(16)}). Ending below zero: ${(below * 100).toFixed(1)}%.`;
  }

  function draw() {
    ctx.clearRect(0, 0, W, H);
    const n = actual.length - 1;
    const pad = { l: 40, r: 14, t: 14, b: 26 };
    const all = bands.flatMap((b) => [b[0], b[4]]).concat([...actual]);
    const lo = Math.min(0, ...all), hi = Math.max(...all);
    const X = (k) => pad.l + (k / n) * (W - pad.l - pad.r);
    const Y = (v) => pad.t + (1 - (v - lo) / (hi - lo)) * (H - pad.t - pad.b);
    ctx.font = `500 10px ${MONO}`; ctx.textBaseline = 'middle';
    const step = Math.max(5, Math.round((hi - lo) / 5 / 5) * 5);
    for (let v = Math.ceil(lo / step) * step; v <= hi; v += step) {
      ctx.strokeStyle = v === 0 ? 'rgba(235,231,220,0.4)' : C.grid;
      ctx.beginPath(); ctx.moveTo(pad.l, Y(v)); ctx.lineTo(W - pad.r, Y(v)); ctx.stroke();
      ctx.fillStyle = C.ink3; ctx.textAlign = 'right'; ctx.fillText(`${v}R`, pad.l - 6, Y(v)); ctx.textAlign = 'left';
    }
    ctx.fillText(`trade ${n}`, W - pad.r - 52, H - 10);
    ctx.fillText('trade 1', pad.l, H - 10);
    const upto = Math.max(1, Math.floor(n * appear));
    const band = (a, b, alpha) => {
      ctx.fillStyle = `rgba(255,90,31,${alpha})`; ctx.beginPath();
      for (let k = 0; k <= upto; k++) ctx.lineTo(X(k), Y(bands[k][a]));
      for (let k = upto; k >= 0; k--) ctx.lineTo(X(k), Y(bands[k][b]));
      ctx.fill();
    };
    band(0, 4, 0.08); band(1, 3, 0.12);
    ctx.lineWidth = 1;
    for (let i = 0; i < SHOW; i++) {
      const p = paths[i];
      ctx.strokeStyle = 'rgba(235,231,220,0.05)'; ctx.beginPath();
      for (let k = 0; k <= upto; k++) ctx.lineTo(X(k), Y(p[k]));
      ctx.stroke();
    }
    ctx.strokeStyle = C.hot2; ctx.setLineDash([4, 3]); ctx.beginPath();
    for (let k = 0; k <= upto; k++) ctx.lineTo(X(k), Y(bands[k][2]));
    ctx.stroke(); ctx.setLineDash([]);
    ctx.strokeStyle = C.ink; ctx.lineWidth = 2; ctx.beginPath();
    for (let k = 0; k <= upto; k++) ctx.lineTo(X(k), Y(actual[k]));
    ctx.stroke(); ctx.lineWidth = 1;
    if (appear >= 1) {
      // a small key in the top-left corner, clear of the fan
      ctx.font = `600 10.5px ${MONO}`;
      const key = [[`━ actual order of trades · ${actual[n] >= 0 ? '+' : ''}${actual[n].toFixed(1)}R`, C.ink], ['╍ median resample · 5–95% band', C.hot2]];
      const kw = Math.max(...key.map(([s]) => ctx.measureText(s).width)) + 16;
      ctx.fillStyle = 'rgba(7,8,10,0.8)'; ctx.fillRect(pad.l + 6, pad.t + 2, kw, 42);
      key.forEach(([s, col], i) => { ctx.fillStyle = col; ctx.fillText(s, pad.l + 14, pad.t + 15 + i * 17); });
    }
  }

  const anim = loop((dt) => { appear = Math.min(1, appear + dt / 1.3); draw(); if (appear >= 1) anim.stop(); });
  const rerun = () => { simulate(); appear = reducedMotion() ? 1 : 0; if (appear < 1) anim.start(); else draw(); };
  const size = () => { ({ ctx, w: W, h: H } = fitCanvas(canvas)); };
  size();
  onResize(canvas, () => { size(); if (actual) draw(); });
  $$('[data-mc]', root).forEach((b) => b.addEventListener('click', () => {
    which = b.dataset.mc;
    $$('[data-mc]', root).forEach((x) => x.setAttribute('aria-checked', String(x === b)));
    rerun();
  }));
  $('#mcRoll', root).addEventListener('click', () => { seed = (Math.random() * 0xffffff) | 0; rerun(); });
  let started = false;
  watch(canvas, { enter: () => { if (!started) { started = true; rerun(); } }, threshold: 0.35 });
}

export async function init(section) {
  const d = await fetchJSON('data/hindsight.json');
  tradeReplay(section, d);
  microscope(section, d);
  funnel(section, d);
  ciChart($('#ciCanvas', section), d);
  monteCarlo(section, d);
}
