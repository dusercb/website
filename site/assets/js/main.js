// Boot: navigation, the scroll-driven session clock, the hero's OCR read of the
// name, counters, heading decodes, lazy section modules, the pipeline flow, the
// relight transition into Lumina, and the command palette.
import { $, $$, clamp, clock, decode, easeInOut, fetchJSON, fitCanvas, fmt, loop, odometer, onResize, reducedMotion, toast, watch } from './util.js';

const root = document.documentElement;
try { if (localStorage.getItem('motion') === 'off') root.classList.add('motion-off'); } catch { /* storage blocked */ }

/* ------------------------------------------------------------------ nav, progress and the session clock */
const nav = $('#nav');
const navClock = $('#navClock');
const progress = $('#navProgress');
const relight = $('#relight');
const relightLight = $('.relight__light');
const relightStage = $('.relight__stage');
const lumina = $('#lumina');
const OPEN = 4 * 3600, BELL = 9.5 * 3600;

let scrollQueued = false;
function onScroll() {
  if (scrollQueued) return;
  scrollQueued = true;
  requestAnimationFrame(() => {
    scrollQueued = false;
    const max = document.documentElement.scrollHeight - innerHeight;
    const p = max > 0 ? clamp(scrollY / max, 0, 1) : 0;
    progress.style.transform = `scaleX(${p})`;
    navClock.textContent = clock(OPEN + p * (BELL - OPEN));
    nav.classList.toggle('is-solid', scrollY > 40);

    // relight: a soft studio light grows from the centre while the stage is pinned
    const r = relight.getBoundingClientRect();
    const span = r.height - innerHeight;
    const rp = clamp(-r.top / span, 0, 1);
    const reach = Math.hypot(innerWidth, innerHeight) * 0.62;
    relightLight.style.setProperty('--r', `${(reducedMotion() ? 1 : easeInOut(rp)) * reach}px`);
    relightStage.style.setProperty('--p', rp.toFixed(3));
    // the nav turns to studio colours once the light has reached the top of the screen
    const lr = lumina.getBoundingClientRect();
    const lit = r.top <= 0 && (reducedMotion() || easeInOut(rp) > 0.62);
    nav.classList.toggle('is-light', lit && lr.bottom > 60);
  });
}
addEventListener('scroll', onScroll, { passive: true });
addEventListener('resize', onScroll);
onScroll();

const links = new Map($$('[data-nav]').map((a) => [a.dataset.nav, a]));
$$('main > section[id]').forEach((sec) => {
  watch(sec, {
    margin: '-45% 0px -50% 0px',
    enter: () => links.forEach((a, id) => a.classList.toggle('is-active', id === sec.id)),
  });
});

/* ------------------------------------------------------------------ hero name, read like OCR */
const LOOKALIKE = {
  A: '4RH', B: '8E3', C: 'GO(', D: '0OB', E: 'F3B', F: 'EP7', G: 'C6O', H: 'NM#', I: '1|LT', J: 'I1', K: 'XR', L: 'I1J',
  M: 'NWH', N: 'MH', O: '0QD', P: 'RF', Q: 'O0', R: 'PB', S: '58$', T: 'I7', U: 'VO', V: 'UY', W: 'MVN', X: 'KY', Y: 'VX', Z: '27',
};
function readName() {
  const h1 = $('#heroName');
  const chars = [];
  $$('.line', h1).forEach((line) => {
    const text = line.textContent;
    line.textContent = '';
    [...text].forEach((c) => {
      const s = document.createElement('span');
      s.className = 'ch';
      s.textContent = c;
      line.append(s);
      chars.push([s, c.toUpperCase()]);
    });
  });
  if (reducedMotion()) return chars;
  chars.forEach(([s]) => { s.style.opacity = '0'; });
  chars.forEach(([s, c], i) => {
    const t0 = 350 + i * 70;
    setTimeout(() => {
      s.style.width = `${s.getBoundingClientRect().width}px`;
      s.style.opacity = '1';
      s.classList.add('is-reading');
      const box = document.createElement('i');
      box.className = 'box';
      const conf = document.createElement('i');
      conf.className = 'conf';
      s.append(box, conf);
      const alts = LOOKALIKE[c] || c;
      let n = 0;
      const steps = 5 + (i % 3);
      const iv = setInterval(() => {
        n++;
        const done = n >= steps;
        s.firstChild.textContent = done ? c : alts[n % alts.length];
        conf.textContent = (done ? 0.97 + (i % 3) * 0.01 : 0.31 + n * 0.09 + Math.random() * 0.05).toFixed(2);
        if (done) {
          clearInterval(iv);
          s.classList.remove('is-reading');
          setTimeout(() => { box.remove(); conf.remove(); s.style.width = ''; }, 380);
        }
      }, 62);
    }, t0);
  });
  return chars;
}
const nameChars = readName();

// kinetic type: letters near the cursor thin out, like the light is eating them
if (!reducedMotion() && matchMedia('(pointer: fine)').matches) {
  const hero = $('.hero');
  let mx = -1e4, my = -1e4, raf = 0;
  const apply = () => {
    raf = 0;
    for (const [s] of nameChars) {
      const r = s.getBoundingClientRect();
      const d = Math.hypot(r.left + r.width / 2 - mx, r.top + r.height / 2 - my);
      const f = Math.max(0, 1 - d / 260);
      s.style.fontWeight = String(Math.round(800 - f * f * 560));
    }
  };
  hero.addEventListener('pointermove', (e) => { mx = e.clientX; my = e.clientY; if (!raf) raf = requestAnimationFrame(apply); });
  hero.addEventListener('pointerleave', () => { mx = my = -1e4; if (!raf) raf = requestAnimationFrame(apply); });
}

import('./hero.js').then((m) => m.init()).catch((e) => console.warn('hero', e));

/* ------------------------------------------------------------------ counters, decodes, reveals */
$$('[data-count]').forEach((el) => watch(el, { enter: () => odometer(el), threshold: 0.6 }));
$$('[data-decode]').forEach((el) => watch(el, { enter: () => decode(el), threshold: 0.5 }));
if (!reducedMotion()) {
  const groups = ['.facts li', '.stats > div', '.phead__meta li', '.classes li', '.timeline li', '.passes li', '.contact__links li'];
  $$(groups.join(',')).forEach((el) => {
    el.setAttribute('data-reveal', '');
    const sibs = [...el.parentElement.children];
    el.style.transitionDelay = `${Math.min(8, sibs.indexOf(el)) * 70}ms`;
    watch(el, { enter: () => el.classList.add('is-in'), threshold: 0.2 });
  });
}

/* ------------------------------------------------------------------ project modules, loaded as they approach */
$$('[data-module]').forEach((sec) => {
  let started = false;
  watch(sec, {
    margin: '900px 0px 900px 0px',
    enter: () => {
      if (started) return;
      started = true;
      import(`./${sec.dataset.module}.js`).then((m) => m.init(sec)).catch((e) => console.warn(sec.dataset.module, e));
    },
  });
});

/* ------------------------------------------------------------------ pipeline flow: frames -> tickers -> signals -> orders */
(function pipeline() {
  const canvas = $('#pipeFlow');
  if (!canvas || reducedMotion()) return;
  const wrap = canvas.parentElement;
  const nodes = $$('.pipe__node', wrap);
  const parts = Array.from({ length: 84 }, (_, i) => ({ x: Math.random(), y: (Math.random() - 0.5) * 22, v: 0.03 + Math.random() * 0.035, s: i }));
  let W = 0, H = 0, cuts = [];
  const measure = () => {
    const f = fitCanvas(canvas);
    W = f.w; H = f.h;
    const r0 = wrap.getBoundingClientRect();
    cuts = nodes.map((n) => { const r = n.getBoundingClientRect(); return (r.left + r.width / 2 - r0.left) / W; });
  };
  onResize(wrap, measure);
  const colors = ['#66d9ff', '#ff8a52', '#ebe7dc', '#3ddc97'];
  const anim = loop((dt) => {
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, W, H);
    ctx.strokeStyle = 'rgba(235,231,220,0.12)';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(0, H / 2); ctx.lineTo(W, H / 2); ctx.stroke();
    for (const p of parts) {
      p.x += p.v * dt;
      if (p.x > 1) { p.x = 0; p.y = (Math.random() - 0.5) * 18; }
      const seg = cuts.filter((c) => p.x > c).length;
      const x = p.x * W, y = H / 2 + p.y * (0.4 + 0.6 * Math.sin(p.x * Math.PI));
      ctx.fillStyle = colors[seg];
      ctx.globalAlpha = 0.85;
      if (seg === 0) ctx.fillRect(x - 3, y - 2, 6, 4);                       // video frames
      else if (seg === 1) { ctx.beginPath(); ctx.arc(x, y, 2.2, 0, 7); ctx.fill(); } // tickers
      else if (seg === 2) { ctx.save(); ctx.translate(x, y); ctx.rotate(Math.PI / 4); ctx.fillRect(-2.2, -2.2, 4.4, 4.4); ctx.restore(); } // signals
      else { ctx.beginPath(); ctx.moveTo(x - 3, y + 3); ctx.lineTo(x + 3, y + 3); ctx.lineTo(x, y - 3); ctx.fill(); } // orders
    }
    ctx.globalAlpha = 1;
  });
  watch(wrap, { enter: () => anim.start(), leave: () => anim.stop() });
})();

/* ------------------------------------------------------------------ copy buttons */
$$('[data-copy]').forEach((b) => b.addEventListener('click', async () => {
  try { await navigator.clipboard.writeText(b.dataset.copy); toast('Email address copied'); }
  catch { toast(b.dataset.copy); }
}));

/* ------------------------------------------------------------------ command palette */
const palette = $('#palette');
const pInput = $('#paletteInput');
const pList = $('#paletteList');
const pOut = $('#paletteOut');
const go = (id) => () => { close(); document.getElementById(id)?.scrollIntoView({ behavior: reducedMotion() ? 'auto' : 'smooth' }); };
const email = $('[data-copy]')?.dataset.copy;
const COMMANDS = [
  { t: 'Go to the top', k: 'nav', run: go('top') },
  { t: '01 · Tape Reader', k: 'nav', run: go('tape') },
  { t: '02 · Hindsight', k: 'nav', run: go('hindsight') },
  { t: '03 · Parity', k: 'nav', run: go('parity') },
  { t: '04 · Lumina', k: 'nav', run: go('lumina') },
  { t: 'Contact', k: 'nav', run: go('contact') },
  { t: 'About me and how I work', k: 'open', run: () => { close(); location.href = 'about/'; } },
  { t: 'Open Lumina, the live app', k: 'open', run: () => { close(); window.open('lumina/', '_blank', 'noopener'); } },
  { t: 'Replay the FLYX trade', k: 'demo', run: () => { go('hindsight')(); setTimeout(() => dispatchEvent(new CustomEvent('trade:replay')), 700); } },
  { t: 'Jump the bot replay to the WETO incident', k: 'demo', run: () => { go('parity')(); setTimeout(() => dispatchEvent(new CustomEvent('mission:incident')), 700); } },
  { t: 'python -m live_bot status', k: 'cli', run: status },
  { t: 'python -m live_bot flatten', k: 'cli', run: () => print('$ python -m live_bot flatten\nNo open positions. Wrote STOP kill-file... to a website.\nNothing was flattened. Nothing was harmed.') },
  { t: 'Copy email address', k: 'copy', run: async () => { close(); try { await navigator.clipboard.writeText(email); toast('Email address copied'); } catch { toast(email); } } },
  { t: 'Toggle motion', k: 'pref', run: () => { const off = !root.classList.contains('motion-off'); try { localStorage.setItem('motion', off ? 'off' : 'on'); } catch { /* */ } location.reload(); } },
];
let sel = 0, shown = COMMANDS;

function render() {
  const q = pInput.value.trim().toLowerCase();
  shown = COMMANDS.filter((c) => !q || c.t.toLowerCase().includes(q) || c.k.includes(q) || (q === 'status' && c.k === 'cli'));
  sel = clamp(sel, 0, Math.max(0, shown.length - 1));
  pList.innerHTML = '';
  shown.forEach((c, i) => {
    const li = document.createElement('li');
    li.role = 'option';
    li.className = i === sel ? 'is-sel' : '';
    li.setAttribute('aria-selected', String(i === sel));
    li.innerHTML = `${c.t}<span>${c.k}</span>`;
    li.addEventListener('click', () => c.run());
    li.addEventListener('mousemove', () => { if (sel !== i) { sel = i; render(); } });
    pList.append(li);
  });
}
function print(text) { pOut.hidden = false; pOut.textContent = text; }
async function status() {
  try {
    const d = await fetchJSON('data/parity.json');
    const rows = d.sessions.map((s) => `${s.date}  ${String(fmt(s.events)).padStart(7)}  ${String(s.tracked).padStart(7)}  ${String(s.seen).padStart(4)}  ${String(s.intended).padStart(8)}  ${String(s.closed).padStart(6)}`);
    print(`$ python -m live_bot status\ndate          events  tracked  seen  intended  closed\n${rows.join('\n')}\n\n${d.totals.sessions} sessions · ${d.totals.mb} MB of JSONL · account ids never leave the box`);
  } catch { print('status: data unavailable'); }
}
let lastFocus = null;
function open() {
  lastFocus = document.activeElement;
  palette.hidden = false;
  pInput.value = '';
  pOut.hidden = true;
  sel = 0;
  render();
  pInput.focus();
}
function close() { palette.hidden = true; lastFocus?.focus?.(); }
pInput.addEventListener('input', () => { sel = 0; render(); });
pInput.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown') { sel = (sel + 1) % Math.max(1, shown.length); render(); e.preventDefault(); }
  else if (e.key === 'ArrowUp') { sel = (sel - 1 + shown.length) % Math.max(1, shown.length); render(); e.preventDefault(); }
  else if (e.key === 'Enter') { shown[sel]?.run(); e.preventDefault(); }
});
palette.addEventListener('click', (e) => { if (e.target === palette) close(); });
addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); palette.hidden ? open() : close(); }
  else if (e.key === 'Escape' && !palette.hidden) close();
});
$$('[data-open-palette]').forEach((b) => b.addEventListener('click', open));
if (/Mac|iPhone|iPad/.test(navigator.platform)) $$('kbd').forEach((k) => { if (k.textContent === 'Ctrl') k.textContent = '⌘'; });
