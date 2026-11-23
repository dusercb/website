// 04 Lumina: what the app sees (its own cached landmarks for the sample photo,
// the canonical face mesh's triangles, and the region lists from its face.js),
// a magnifier, the real app booted inside the phone, and the tools index.
import { $, $$, clamp, easeOut, fetchJSON, loop, onResize, reducedMotion, watch } from './util.js';

const PINK = '#ff3d7f', CYAN = '#5ee1ff', AMBER = '#ffc56b', WHITE = '#ffffff';
const MONO = '"JetBrains Mono", ui-monospace, monospace';
const STAGES = [
  ['Photo', 'the sample, as loaded'],
  ['478 landmarks', 'x, y and depth, from MediaPipe on the device'],
  ['Face mesh', '898 triangles of the canonical mesh, warped onto this face'],
  ['Region masks', 'skin, lips, eyes, irises and brows: what every tool reads'],
];

function faceDemo(root, d) {
  const box = $('#face', root);
  const img = $('img', box);
  const canvas = $('#faceCanvas', root);
  const lens = $('#faceLens', root);
  const label = $('#faceStage', root);
  const buttons = $$('[data-stage]', root);
  const P = d.pts;
  let W = 0, H = 0, dpr = 1, ctx, lctx, stage = 1, t = 1, auto = !reducedMotion(), lastSwitch = 0, clock = 0;
  const pt = (i) => [P[i][0] * W, P[i][1] * H];
  const zs = P.map((p) => p[2]);
  const zmin = Math.min(...zs), zmax = Math.max(...zs);
  const nose = P[1];
  // triangles ordered by distance from the nose tip: the mesh ripples outward
  const tris = [];
  for (let i = 0; i < d.tris.length; i += 3) {
    const a = d.tris[i], b = d.tris[i + 1], c = d.tris[i + 2];
    const cx = (P[a][0] + P[b][0] + P[c][0]) / 3, cy = (P[a][1] + P[b][1] + P[c][1]) / 3;
    tris.push([a, b, c, Math.hypot(cx - nose[0], (cy - nose[1]) * 1.6)]);
  }
  tris.sort((x, y) => x[3] - y[3]);
  const maxD = tris[tris.length - 1][3];
  const order = P.slice(0, 478).map((p, i) => [i, p[1]]).sort((a, b) => a[1] - b[1]).map((x) => x[0]);

  function size() {
    dpr = Math.min(2, devicePixelRatio || 1);
    const r = box.getBoundingClientRect();
    W = r.width; H = r.height;
    for (const c of [canvas, lens]) { c.width = Math.round(W * dpr); c.height = Math.round(H * dpr); }
    ctx = canvas.getContext('2d'); ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    lctx = lens.getContext('2d');
  }

  const poly = (idx) => { ctx.beginPath(); idx.forEach((i, k) => { const [x, y] = pt(i); k ? ctx.lineTo(x, y) : ctx.moveTo(x, y); }); ctx.closePath(); };

  function draw() {
    ctx.clearRect(0, 0, W, H);
    const e = easeOut(clamp(t, 0, 1));
    if (stage >= 1 && stage < 3) {
      // a gentle scrim so white marks read on a bright photo
      ctx.fillStyle = `rgba(20,10,16,${0.22 * (stage === 1 ? e : 1)})`;
      ctx.fillRect(0, 0, W, H);
    }
    if (stage === 1) {
      const n = Math.floor(order.length * e);
      for (let k = 0; k < n; k++) {
        const i = order[k];
        const [x, y] = pt(i);
        const z = (P[i][2] - zmin) / (zmax - zmin);
        ctx.fillStyle = i >= 468 ? CYAN : `rgba(255,255,255,${0.95 - z * 0.55})`;
        ctx.beginPath(); ctx.arc(x, y, i >= 468 ? 2 : 1.35, 0, 7); ctx.fill();
      }
      if (e < 1) {
        const y = H * (P[order[Math.max(0, n - 1)]][1]);
        ctx.fillStyle = 'rgba(255,61,127,0.7)'; ctx.fillRect(0, y, W, 1.5);
      }
    }
    if (stage === 2) {
      ctx.lineWidth = 0.6;
      const lim = maxD * e;
      for (const [a, b, c, dist] of tris) {
        if (dist > lim) break;
        const z = ((P[a][2] + P[b][2] + P[c][2]) / 3 - zmin) / (zmax - zmin);
        ctx.strokeStyle = `rgba(255,255,255,${0.75 - z * 0.45})`;
        const [ax, ay] = pt(a), [bx, by] = pt(b), [cx, cy] = pt(c);
        ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.lineTo(cx, cy); ctx.closePath(); ctx.stroke();
      }
      ctx.lineWidth = 1;
    }
    if (stage === 3) {
      ctx.save();
      ctx.globalAlpha = e;
      // skin: the oval, minus eyes, brows and mouth
      ctx.fillStyle = 'rgba(255,61,127,0.26)';
      poly(d.idx.oval); ctx.fill();
      ctx.globalCompositeOperation = 'destination-out';
      ctx.fillStyle = '#000';
      for (const k of ['eyeL', 'eyeR', 'browL', 'browR', 'lipsOuter']) { poly(d.idx[k]); ctx.fill(); }
      ctx.globalCompositeOperation = 'source-over';
      // lips: outer minus inner
      ctx.fillStyle = 'rgba(255,61,127,0.62)';
      ctx.beginPath();
      [d.idx.lipsOuter, [...d.idx.lipsInner].reverse()].forEach((ring) => ring.forEach((i, k) => { const [x, y] = pt(i); k ? ctx.lineTo(x, y) : ctx.moveTo(x, y); }));
      ctx.fill('evenodd');
      ctx.fillStyle = 'rgba(94,225,255,0.45)';
      for (const k of ['eyeL', 'eyeR']) { poly(d.idx[k]); ctx.fill(); }
      for (const k of ['irisL', 'irisR']) {
        const [c0, c1] = [pt(d.idx[k][0]), pt(d.idx[k][1])];
        ctx.fillStyle = 'rgba(94,225,255,0.9)';
        ctx.beginPath(); ctx.arc(c0[0], c0[1], Math.hypot(c1[0] - c0[0], c1[1] - c0[1]), 0, 7); ctx.fill();
      }
      ctx.fillStyle = 'rgba(255,197,107,0.6)';
      for (const k of ['browL', 'browR']) { poly(d.idx[k]); ctx.fill(); }
      ctx.strokeStyle = 'rgba(255,255,255,0.8)'; ctx.setLineDash([3, 3]);
      poly(d.idx.oval); ctx.stroke(); ctx.setLineDash([]);
      ctx.restore();
      // labels with leader lines
      if (e > 0.6) {
        ctx.globalAlpha = clamp((e - 0.6) / 0.4, 0, 1);
        const lab = (text, i, dx, dy, col) => {
          const [x, y] = pt(i);
          const lx = clamp(x + dx, 8, W - 8), ly = clamp(y + dy, 14, H - 14);
          ctx.strokeStyle = col; ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(lx, ly); ctx.stroke();
          ctx.font = `600 10.5px ${MONO}`;
          const w = ctx.measureText(text).width + 12;
          const bx = clamp(dx < 0 ? lx - w : lx, 6, W - w - 6);
          ctx.fillStyle = 'rgba(23,19,26,0.82)'; ctx.fillRect(bx, ly - 10, w, 20);
          ctx.fillStyle = col; ctx.fillText(text, bx + 6, ly + 4);
        };
        lab(`lips · ${d.idx.lipsOuter.length}+${d.idx.lipsInner.length} pts`, 291, W * 0.16, H * 0.05, PINK);
        lab(`iris · 5 pts`, 473, W * 0.2, -H * 0.06, CYAN);
        lab(`eye · ${d.idx.eyeR.length} pts`, 133, -W * 0.22, -H * 0.05, CYAN);
        lab(`brow · ${d.idx.browR.length} pts`, 105, -W * 0.18, -H * 0.06, AMBER);
        lab(`skin · ${d.idx.oval.length}-pt oval`, 234, -W * 0.12, H * 0.12, WHITE);
        ctx.globalAlpha = 1;
      }
    }
    label.innerHTML = `<b>${STAGES[stage][0]}</b> · ${STAGES[stage][1]}`;
  }

  function setStage(s, byUser) {
    stage = s; t = reducedMotion() ? 1 : 0;
    if (byUser) auto = false;
    buttons.forEach((b) => b.setAttribute('aria-checked', String(Number(b.dataset.stage) === s)));
    anim.start();
  }

  const anim = loop((dt) => {
    clock += dt;
    if (t < 1) { t = Math.min(1, t + dt / (stage === 2 ? 1.8 : 1.3)); draw(); }
    if (auto && clock - lastSwitch > 4.2) { lastSwitch = clock; setStage((stage + 1) % 4, false); }
    if (!auto && t >= 1) anim.stop();
  });
  buttons.forEach((b) => b.addEventListener('click', () => setStage(Number(b.dataset.stage), true)));

  // magnifier: 2.5× of the photo and whatever the current stage drew
  const Z = 2.5, R = 84;
  box.addEventListener('pointermove', (e) => {
    if (e.pointerType === 'touch') return;
    const r = box.getBoundingClientRect();
    const mx = e.clientX - r.left, my = e.clientY - r.top;
    box.classList.add('is-lens');
    lctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    lctx.clearRect(0, 0, W, H);
    lctx.save();
    lctx.beginPath(); lctx.arc(mx, my, R, 0, 7); lctx.clip();
    const sw = (R * 2) / Z, sh = (R * 2) / Z;
    const ix = (mx - sw / 2) / W * img.naturalWidth, iy = (my - sh / 2) / H * img.naturalHeight;
    lctx.drawImage(img, ix, iy, (sw / W) * img.naturalWidth, (sh / H) * img.naturalHeight, mx - R, my - R, R * 2, R * 2);
    lctx.drawImage(canvas, (mx - sw / 2) * dpr, (my - sh / 2) * dpr, sw * dpr, sh * dpr, mx - R, my - R, R * 2, R * 2);
    lctx.restore();
    lctx.strokeStyle = '#fff'; lctx.lineWidth = 2.5; lctx.beginPath(); lctx.arc(mx, my, R, 0, 7); lctx.stroke();
    lctx.strokeStyle = 'rgba(224,36,94,0.9)'; lctx.lineWidth = 1; lctx.beginPath(); lctx.arc(mx, my, R + 3, 0, 7); lctx.stroke();
  });
  box.addEventListener('pointerleave', () => box.classList.remove('is-lens'));

  const ready = () => { size(); draw(); };
  if (img.complete && img.naturalWidth) ready(); else img.addEventListener('load', ready, { once: true });
  img.loading = 'eager';
  onResize(box, () => { size(); draw(); });
  watch(box, { enter: () => { if (auto || t < 1) anim.start(); }, leave: () => anim.stop(), threshold: 0.3 });
}

function phone(root) {
  const btn = $('#phoneLaunch', root);
  const screen = $('.phone__screen', root);
  btn.addEventListener('click', () => {
    const f = document.createElement('iframe');
    f.src = '/lumina/';
    f.title = 'Lumina, running live';
    f.allow = 'clipboard-write; web-share';
    screen.append(f);
    f.addEventListener('load', () => $('#phonePoster', root).remove(), { once: true });
    btn.textContent = 'Starting…';
  });
}

function tools(root, d) {
  const list = $('#toolsList', root);
  const blurb = $('#toolsBlurb', root);
  const idle = blurb.innerHTML;
  list.innerHTML = d.tools.map(([n]) => `<li><button type="button">${n}</button></li>`).join('');
  const btns = $$('button', list);
  const show = (i) => {
    btns.forEach((b, k) => b.classList.toggle('is-on', k === i));
    blurb.innerHTML = i < 0 ? idle : `<b>${d.tools[i][0]}.</b> ${d.tools[i][1]}`;
  };
  btns.forEach((b, i) => {
    b.addEventListener('mouseenter', () => show(i));
    b.addEventListener('focus', () => show(i));
    b.addEventListener('click', () => show(i));
  });
  list.addEventListener('mouseleave', () => show(-1));
}

export async function init(section) {
  const d = await fetchJSON('/data/lumina.json');
  faceDemo(section, d);
  phone(section);
  tools(section, d);
}
