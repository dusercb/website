// 03 Parity: mission control, replaying the live bot's recorded event log for
// the 14 Aug 2026 paper session (account ids stripped at build time), and the
// wiring of the parity loop diagram.
import { $, $$, clamp, clock, fetchJSON, fmt, loop, money, onResize, reducedMotion, watch } from './util.js';

const OPEN = 4 * 3600;

function line(e) {
  const [, k, s, p] = e;
  const S = s ? `<span class="s">${s}</span>` : '';
  switch (k) {
    case 'session_meta': return ['', `signal_core@${p.sha} pinned · trading ${p.trading ? 'enabled' : 'off'}`];
    case 'ib_message': return ['e-dim', `ib ${p.code} · ${p.msg}`];
    case 'connected': return ['', `gateway :${p.port} · attempt ${p.attempt}`];
    case 'trading_armed': return ['e-open', 'account is paper · guard passed · ARMED'];
    case 'scanner_seen': return ['e-dim', `${S}`];
    case 'backfill': return ['e-dim', `${S}${fmt(p.bars)} bars`];
    case 'confirm': return ['', `${S}float ${fmt(p.float)} · adv ${fmt(p.adv)}${p.why ? ` · ${p.why}` : ''}`];
    case 'demoted': return ['e-dim', `${S}back to the monitor tier`];
    case 'tick_slot_acquired': return ['', `${S}tick slot ${p.used}/3`];
    case 'tick_slot_released': return ['e-dim', `${S}tick slot freed · ${p.used}/3`];
    case 'tick_fire': return ['e-fire', `${S}${p.dir} · trigger ${p.trigger} · stop ${p.stop} · target ${p.target}`];
    case 'entry_submitted': return ['', `${S}${p.dir} ${p.shares} sh · limit ${p.limit}`];
    case 'entry_unfilled': return ['e-dim', `${S}${p.status}`];
    case 'position_opened': return ['e-open', `${S}${p.dir} ${p.shares} @ ${p.entry} · ${p.mode}`];
    case 'position_closed': return [p.pnl >= 0 ? 'e-close' : 'e-alarm', `${S}${p.reason} · exit ${p.exit} · ${money(p.pnl)}`];
    case 'exit_submitted': return ['', `${S}${p.reason} · ${p.shares} sh · ${p.src}`];
    case 'reconcile_alarm': return ['e-alarm', p.detail];
    case 'intended_trade': return ['', `${S}${p.dir} @ ${p.entry} · ${p.result}`];
    case 'session_end': return ['', p.reason];
    case 'summary': return ['', `tracked ${p.tracked} · seen ${p.scanner_seen} · closed ${p.closed_trades} · realized ${money(p.realized_pnl)}`];
    default: return ['e-dim', k];
  }
}

function mission(root, d) {
  const ev = d.events;
  const END = Math.max(...ev.map((e) => e[0])) + 5;
  const el = {
    clock: $('#missionClock', root), log: $('#missionLog', root), A: $$('#tierA i', root), B: $('#tierB', root), C: $('#tierC', root),
    seen: $('#mSeen', root), tracked: $('#mTracked', root), slots: $('#mSlots', root), open: $('#mOpen', root), pnl: $('#mPnl', root),
    play: $('#missionPlay', root), scrub: $('#missionScrub', root), fill: $('.scrub__fill', root), marks: $('#missionMarks', root),
  };
  let t = 0, idx = 0, speed = 240, playing = !reducedMotion();
  let st;
  el.banner = document.createElement('span');
  el.banner.className = 'mission__alarm';
  el.banner.hidden = true;
  el.clock.before(el.banner);
  const reset = () => {
    st = { C: new Set(), B: new Set(), down: new Set(), slots: [null, null, null], pos: new Map(), pnl: 0, alarmUntil: -1, alarmSym: null, seen: new Set() };
    idx = 0;
    el.log.innerHTML = '';
  };
  reset();

  // the scrubber's marks: trades and alarms
  const frac = (x) => clamp(x / END, 0, 1);
  el.marks.innerHTML = ev
    .filter((e) => ['tick_fire', 'position_opened', 'reconcile_alarm'].includes(e[1]))
    .map((e) => `<i class="${e[1] === 'reconcile_alarm' ? 'm-alarm' : 'm-trade'}" style="left:${(frac(e[0]) * 100).toFixed(2)}%"></i>`)
    .join('');

  function apply(e, live) {
    const [ts, k, s, p] = e;
    switch (k) {
      case 'scanner_seen': st.seen.add(s); if (!st.B.has(s)) st.C.add(s); break;
      case 'confirm': st.C.delete(s); st.B.add(s); st.down.delete(s); break;
      case 'demoted': st.B.delete(s); st.C.add(s); st.down.add(s); break;
      case 'tick_slot_acquired': { const i = st.slots.indexOf(null); if (i >= 0) st.slots[i] = s; break; }
      case 'tick_slot_released': { const i = st.slots.indexOf(s); if (i >= 0) st.slots[i] = null; break; }
      case 'position_opened': st.pos.set(s, p); break;
      case 'position_closed': st.pos.delete(s); st.pnl = p.session; break;
      case 'reconcile_alarm': { const m = p.detail.match(/holds \d+ (\w+)/); st.alarmSym = m?.[1] || null; st.alarmUntil = ts + 9; break; }
      default: break;
    }
    if (live && k !== 'scanner_seen' && k !== 'backfill') {
      const [cls, text] = line(e);
      const row = document.createElement('p');
      row.className = cls + ({ tick_fire: ' e-fire', position_opened: ' e-open', reconcile_alarm: ' e-alarm' }[k] || '');
      row.innerHTML = `<time>${clock(OPEN + ts)}</time><span class="k">${k}</span>${text}`;
      el.log.append(row);
      while (el.log.children.length > 60) el.log.firstChild.remove();
    }
  }

  function renderTiers() {
    const chips = (set, cls) => [...set].map((s) => {
      let c = 'chip';
      if (st.alarmSym === s && t < st.alarmUntil) c += ' is-alarm';
      else if (st.slots.includes(s) || st.pos.has(s)) c += ' is-hot';
      else if (cls === 'B' && !st.down.has(s)) c += '';
      if (cls === 'C' && st.down.has(s)) c += ' is-down';
      return `<span class="${c}">${s}</span>`;
    }).join('');
    const b = chips(st.B, 'B'), c = chips(st.C, 'C');
    if (el.B._h !== b) { el.B.innerHTML = b; el.B._h = b; }
    if (el.C._h !== c) { el.C.innerHTML = c; el.C._h = c; }
    st.slots.forEach((s, i) => {
      const slot = el.A[i];
      const pos = s && st.pos.get(s);
      const alarm = !s && i === 0 && st.alarmSym && t < st.alarmUntil;
      const html = alarm ? `${st.alarmSym}<small>UNMANAGED · broker ≠ book</small>` : s ? `${s}<small>${pos ? `${pos.dir} ${pos.shares} @ ${pos.entry}` : 'armed · tick-by-tick'}</small>` : '';
      if (slot._h !== html) { slot.innerHTML = html; slot._h = html; }
      slot.className = alarm ? 'is-alarm' : pos ? 'is-on is-pos' : s ? 'is-on' : '';
    });
    const alarmOn = st.alarmSym && t < st.alarmUntil;
    if (alarmOn !== el._alarm) {
      el._alarm = alarmOn;
      el.banner.hidden = !alarmOn;
      el.banner.textContent = alarmOn ? `broker ≠ book · ${st.alarmSym} unmanaged` : '';
    }
    el.seen.textContent = st.seen.size;
    el.tracked.textContent = st.B.size;
    el.slots.textContent = `${st.slots.filter(Boolean).length}/3`;
    el.open.textContent = st.pos.size;
    el.pnl.textContent = money(st.pnl);
    el.pnl.className = st.pnl > 0 ? 'up' : st.pnl < 0 ? 'down' : '';
    el.clock.textContent = clock(OPEN + t);
    el.fill.style.width = `${(frac(t) * 100).toFixed(2)}%`;
    el.scrub.setAttribute('aria-valuenow', String(Math.round(frac(t) * 100)));
    el.scrub.setAttribute('aria-valuetext', `${clock(OPEN + t)} ET`);
  }

  function seek(to) {
    reset();
    t = clamp(to, 0, END);
    const firstLive = ev.findIndex((e) => e[0] > t - 600);
    while (idx < ev.length && ev[idx][0] <= t) { apply(ev[idx], idx >= firstLive); idx++; }
    renderTiers();
  }

  const anim = loop((dt) => {
    if (!playing) return;
    t += dt * speed;
    while (idx < ev.length && ev[idx][0] <= t) { apply(ev[idx], true); idx++; }
    if (t >= END) { t = END; playing = false; el.play.classList.add('is-paused'); el.play.setAttribute('aria-label', 'Play the replay'); }
    renderTiers();
  });

  el.play.addEventListener('click', () => {
    if (t >= END) seek(0);
    playing = !playing;
    el.play.classList.toggle('is-paused', !playing);
    el.play.setAttribute('aria-label', playing ? 'Pause the replay' : 'Play the replay');
    if (playing) anim.start();
  });
  $$('[data-speed]', root).forEach((b) => b.addEventListener('click', () => {
    speed = Number(b.dataset.speed);
    $$('[data-speed]', root).forEach((x) => x.setAttribute('aria-checked', String(x === b)));
  }));
  const jump = () => {
    const fire = ev.find((e) => e[1] === 'tick_fire' && e[2] === 'WETO') || ev.find((e) => e[1] === 'position_opened');
    seek(fire[0] - 25);
    speed = 30;
    $$('[data-speed]', root).forEach((x) => x.setAttribute('aria-checked', 'false'));
    playing = true; el.play.classList.remove('is-paused'); anim.start();
  };
  $('#missionJump', root).addEventListener('click', jump);
  addEventListener('mission:incident', jump);

  // scrubbing: pointer and keyboard
  const scrubTo = (clientX) => { const r = el.scrub.getBoundingClientRect(); seek(((clientX - r.left) / r.width) * END); };
  el.scrub.addEventListener('pointerdown', (e) => {
    el.scrub.setPointerCapture(e.pointerId);
    scrubTo(e.clientX);
    const move = (m) => scrubTo(m.clientX);
    el.scrub.addEventListener('pointermove', move);
    el.scrub.addEventListener('pointerup', () => el.scrub.removeEventListener('pointermove', move), { once: true });
  });
  el.scrub.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowRight') { seek(t + 300); e.preventDefault(); }
    else if (e.key === 'ArrowLeft') { seek(t - 300); e.preventDefault(); }
  });

  if (reducedMotion()) { seek(ev.find((e) => e[1] === 'reconcile_alarm')?.[0] + 1 || END); el.play.classList.add('is-paused'); return; }
  seek(0);
  watch(root.querySelector('#mission'), { enter: () => anim.start(), leave: () => anim.stop(), threshold: 0.2 });
}

/* ------------------------------------------------------------------ the parity loop's wiring */
function wires(root) {
  const box = $('#loopDiagram', root);
  const svg = $('#loopWires', root);
  const node = (c) => $(c, box).getBoundingClientRect();
  const draw = () => {
    if (getComputedStyle(svg).display === 'none') return;
    const b = box.getBoundingClientRect();
    const P = (r, side) => {
      const x = { l: r.left, r: r.right, c: r.left + r.width / 2 }[side[0]] - b.left;
      const y = { t: r.top, b: r.bottom, m: r.top + r.height / 2 }[side[1]] - b.top;
      return [x, y];
    };
    const core = node('.loop__core'), bt = node('.loop__bt'), bot = node('.loop__bot'), rec = node('.loop__rec'), diff = node('.loop__diff');
    const curve = (a, z, cls) => {
      const my = (a[1] + z[1]) / 2;
      return `<path class="${cls}" d="M${a[0]},${a[1]} C${a[0]},${my} ${z[0]},${my} ${z[0]},${z[1]}"/>`;
    };
    const h = (a, z, cls) => `<path class="${cls}" d="M${a[0]},${a[1]} C${(a[0] + z[0]) / 2},${a[1]} ${(a[0] + z[0]) / 2},${z[1]} ${z[0]},${z[1]}"/>`;
    svg.setAttribute('viewBox', `0 0 ${b.width} ${b.height}`);
    svg.innerHTML = [
      curve(P(core, 'cb'), P(bt, 'ct'), 'flow'),
      curve(P(core, 'cb'), P(bot, 'ct'), 'flow'),
      curve(P(bot, 'cb'), P(rec, 'ct'), 'flow'),
      h(P(rec, 'lm'), P(diff, 'rm'), 'flow flow--cool'),
      curve(P(diff, 'ct'), P(bt, 'cb'), 'flow flow--cool'),
    ].join('');
  };
  onResize(box, draw);
  draw();
}

export async function init(section) {
  wires(section);
  const d = await fetchJSON('data/parity.json');
  const sha = d.events.find((e) => e[1] === 'session_meta')?.[3]?.sha;
  if (sha) $('#missionSha', section).textContent = `signal_core@${sha}`;
  mission(section, d);
}
