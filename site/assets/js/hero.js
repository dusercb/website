// Hero: one real premarket session as a field of ridgelines, in raw WebGL.
// Each ridge is one symbol the live bot streamed on 14 Aug 2026: its trading
// volume minute by minute (from the bot's recorded 10-second bars). Orange marks
// each minute the symbol broke to a new high of day, the event the bot trades.
// A sweep replays the session clock.
import { fetchJSON, reducedMotion, loop, mat4, lerp, easeOut, clock, fmt, watch } from './util.js';

const X = 3.1;          // half-width of the time axis in world units
const SPACING = 0.088;  // distance between ridges
const FLOOR = -0.02;    // bottom of each ridge's occluding fill
const SWEEP_SECONDS = 20;

const LINE_VS = `
attribute vec3 aPos; attribute vec3 aPrev; attribute vec3 aNext;
attribute float aSide; attribute float aU; attribute float aHod;
uniform mat4 uMVP; uniform vec2 uHalf; uniform float uWidth; uniform float uAmp;
varying float vU; varying float vHod; varying float vH;
vec4 P(vec3 p) { return uMVP * vec4(p.x, p.y * uAmp, p.z, 1.0); }
void main() {
  vec4 c = P(aPos), a = P(aPrev), b = P(aNext);
  vec2 sa = a.xy / a.w * uHalf, sb = b.xy / b.w * uHalf;
  vec2 d = sb - sa; float l = length(d);
  vec2 dir = l > 1e-5 ? d / l : vec2(1.0, 0.0);
  vec2 n = vec2(-dir.y, dir.x);
  c.xy += n * aSide * uWidth / uHalf * c.w;
  gl_Position = c; vU = aU; vHod = aHod; vH = aPos.y;
}`;
const LINE_FS = `
precision mediump float;
varying float vU; varying float vHod; varying float vH;
uniform float uDepth; uniform float uHover; uniform float uSweep; uniform float uReveal; uniform float uSweepOn; uniform float uScale;
uniform vec3 uInk; uniform vec3 uHot;
void main() {
  if (vU > uReveal) discard;
  float edge = smoothstep(0.0, 0.06, vU) * smoothstep(1.0, 0.94, vU);
  float fog = mix(1.0, 0.24, pow(uDepth, 1.15));
  float hn = clamp(vH / max(uScale, 1e-3), 0.0, 1.0);
  float d = vU - uSweep;
  float glow = exp(-d * d * 3200.0) * uSweepOn;
  float near = exp(-d * d * 60.0) * uSweepOn;
  float head = exp(-pow((vU - uReveal) * 70.0, 2.0)) * (1.0 - uSweepOn);
  float hod = vHod * (0.5 + 0.5 * near + head);
  float a = edge * fog * (0.5 + 0.5 * hn) + edge * (glow * 0.9 + head + hod * 0.6);
  vec3 col = mix(uInk, uHot, clamp(glow * 1.2 + head + hod * 1.4 + uHover, 0.0, 1.0));
  a = mix(a, edge, uHover);
  gl_FragColor = vec4(col, clamp(a, 0.0, 1.0));
}`;
const FILL_VS = `
attribute vec3 aPos; attribute float aT; attribute float aU;
uniform mat4 uMVP; uniform float uAmp;
varying float vT; varying float vU;
void main() { gl_Position = uMVP * vec4(aPos.x, aPos.y * uAmp, aPos.z, 1.0); vT = aT; vU = aU; }`;
const FILL_FS = `
precision mediump float;
varying float vT; varying float vU;
uniform vec3 uBg; uniform vec3 uInk; uniform float uDepth; uniform float uReveal;
void main() {
  float lift = pow(vT, 12.0) * 0.05 * mix(1.0, 0.35, uDepth) * step(vU, uReveal);
  gl_FragColor = vec4(mix(uBg, uInk, lift), 1.0);
}`;

function shader(gl, type, src) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
  return s;
}
function program(gl, vs, fs) {
  const p = gl.createProgram();
  gl.attachShader(p, shader(gl, gl.VERTEX_SHADER, vs));
  gl.attachShader(p, shader(gl, gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
  const loc = {};
  const na = gl.getProgramParameter(p, gl.ACTIVE_ATTRIBUTES);
  for (let i = 0; i < na; i++) { const n = gl.getActiveAttrib(p, i).name; loc[n] = gl.getAttribLocation(p, n); }
  const nu = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
  for (let i = 0; i < nu; i++) { const n = gl.getActiveUniform(p, i).name; loc[n] = gl.getUniformLocation(p, n); }
  return { p, loc };
}

const hex = (h) => { h = h.replace('#', ''); return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255); };

/** Depth order: the busiest names through the middle distance, where they stand
 *  clear of both the text and the front rows; everything else around them. */
function arrange(series) {
  const desc = [...series].sort((a, b) => b.totalVol - a.totalVol);
  const n = series.length;
  const out = new Array(n).fill(null);
  const mids = [0.44, 0.52, 0.36, 0.6, 0.48, 0.3, 0.56, 0.66, 0.4, 0.7, 0.26, 0.74].map((f) => Math.round(f * (n - 1)));
  desc.slice(0, mids.length).forEach((s, i) => { out[mids[i]] = s; });
  const rest = desc.slice(mids.length);
  let seed = 11;
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let i = rest.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [rest[i], rest[j]] = [rest[j], rest[i]]; }
  for (let i = 0; i < n; i++) if (!out[i]) out[i] = rest.pop();
  return out;
}

export async function init() {
  const canvas = document.getElementById('heroCanvas');
  const hero = canvas.parentElement;
  const clockEl = document.getElementById('heroClock');
  const tipEl = document.getElementById('heroTip');
  const data = await fetchJSON('/data/hero.json');
  const ridges = arrange(data.series);
  const N = ridges.length, M = data.n, start = data.startMin * 60;

  const gl = canvas.getContext('webgl', { antialias: true, alpha: false, powerPreference: 'high-performance' });
  if (!gl) { canvas.style.display = 'none'; return; }

  const line = program(gl, LINE_VS, LINE_FS);
  const fill = program(gl, FILL_VS, FILL_FS);

  // ---- heights: sqrt of each minute's share of the symbol's busiest minute,
  //      scaled by how much the symbol traded all morning
  const lt = ridges.map((r) => Math.log10(Math.max(10, r.totalVol)));
  const lo = Math.min(...lt), hi = Math.max(...lt);
  const scales = lt.map((v) => 0.1 + 0.42 * Math.pow((v - lo) / (hi - lo || 1), 1.4));
  const smooth = (a) => {
    const o = new Float32Array(a.length);
    for (let k = 0; k < a.length; k++) o[k] = (a[Math.max(0, k - 1)] + 2 * a[k] + a[Math.min(a.length - 1, k + 1)]) / 4;
    return o;
  };
  const ys = ridges.map((r, i) => smooth(Float32Array.from({ length: M }, (_, k) => Math.sqrt(Number(r.rv.slice(k * 2, k * 2 + 2)) / 99) * scales[i])));
  const hods = ridges.map((r) => {
    const f = Float32Array.from({ length: M }, (_, k) => (r.hod[k] === '1' ? 1 : 0));
    return f.map((v, k) => Math.max(v, 0.6 * (f[k - 1] || 0), 0.6 * (f[k + 1] || 0)));
  });
  const xs = Float32Array.from({ length: M }, (_, k) => lerp(-X, X, k / (M - 1)));

  const lineData = new Float32Array(N * M * 2 * 12);
  const fillData = new Float32Array(N * M * 2 * 6);
  let li = 0, fi = 0;
  ridges.forEach((r, i) => {
    const z = -i * SPACING, y = ys[i];
    for (let k = 0; k < M; k++) {
      const kp = Math.max(0, k - 1), kn = Math.min(M - 1, k + 1);
      const u = k / (M - 1);
      for (const side of [-1, 1]) {
        lineData.set([xs[k], y[k], z, xs[kp], y[kp], z, xs[kn], y[kn], z, side, u, hods[i][k]], li); li += 12;
      }
      fillData.set([xs[k], FLOOR, z, 0, u, 0], fi); fi += 6;
      fillData.set([xs[k], y[k], z, 1, u, 0], fi); fi += 6;
    }
  });
  const lineBuf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, lineBuf);
  gl.bufferData(gl.ARRAY_BUFFER, lineData, gl.STATIC_DRAW);
  const fillBuf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, fillBuf);
  gl.bufferData(gl.ARRAY_BUFFER, fillData, gl.STATIC_DRAW);

  const attrib = (prog, buf, layout, stride) => {
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    let off = 0;
    for (const [name, size] of layout) {
      const l = prog.loc[name];
      if (l !== undefined && l >= 0) {
        gl.enableVertexAttribArray(l);
        gl.vertexAttribPointer(l, size, gl.FLOAT, false, stride * 4, off * 4);
      }
      off += size;
    }
  };

  const BG = hex(getComputedStyle(document.documentElement).getPropertyValue('--bg').trim() || '#07080a');
  const INK = hex('#ebe7dc'), HOT = hex('#ff5a1f');

  // ---- view state
  let W = 1, H = 1, dpr = 1, mvp = null;
  const mouse = { x: 0, y: 0, tx: 0, ty: 0, px: -1, py: -1 };
  const still = reducedMotion();
  let hover = -1, introT = still ? 1 : 0, reveal = still ? 1.0001 : 0, ampT = still ? 1 : 0;
  let sweep = 0.62, sweepOn = still ? 1 : 0;

  function resize() {
    dpr = Math.min(2, window.devicePixelRatio || 1);
    const r = canvas.getBoundingClientRect();
    W = Math.max(1, r.width); H = Math.max(1, r.height);
    canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
    gl.viewport(0, 0, canvas.width, canvas.height);
  }

  // A high camera with a long lens: near-even ridge spacing (the pulsar-plot
  // look) with just enough perspective to read as terrain.
  function camera() {
    const aspect = W / H;
    const narrow = aspect < 0.9;
    const tilt = (narrow ? 30 : 23) * Math.PI / 180;
    const dist = narrow ? 13.5 : 9.6;
    const target = [narrow ? 0.9 : 0.3, 0.1, -(N - 1) * SPACING * 0.5];
    const eye = [target[0] + mouse.x * 0.9, target[1] + Math.sin(tilt) * dist + mouse.y * 0.35, target[2] + Math.cos(tilt) * dist];
    const proj = mat4.perspective((narrow ? 21 : 18.5) * Math.PI / 180, aspect, 0.5, 60);
    proj[9] += narrow ? 0.42 : 0.46; // lens shift: the field sits low, under the name
    return mat4.mul(proj, mat4.lookAt(eye, target, [0, 1, 0]));
  }

  function draw() {
    mvp = camera();
    gl.clearColor(BG[0], BG[1], BG[2], 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    for (let i = N - 1; i >= 0; i--) {
      const depth = i / (N - 1);
      gl.useProgram(fill.p);
      attrib(fill, fillBuf, [['aPos', 3], ['aT', 1], ['aU', 1], ['_', 1]], 6);
      gl.uniformMatrix4fv(fill.loc.uMVP, false, mvp);
      gl.uniform1f(fill.loc.uAmp, ampT);
      gl.uniform3fv(fill.loc.uBg, BG);
      gl.uniform3fv(fill.loc.uInk, INK);
      gl.uniform1f(fill.loc.uDepth, depth);
      gl.uniform1f(fill.loc.uReveal, reveal);
      gl.drawArrays(gl.TRIANGLE_STRIP, i * M * 2, M * 2);

      gl.useProgram(line.p);
      attrib(line, lineBuf, [['aPos', 3], ['aPrev', 3], ['aNext', 3], ['aSide', 1], ['aU', 1], ['aHod', 1]], 12);
      gl.uniformMatrix4fv(line.loc.uMVP, false, mvp);
      gl.uniform2f(line.loc.uHalf, canvas.width / 2, canvas.height / 2);
      gl.uniform1f(line.loc.uWidth, (i === hover ? 1.7 : 0.62 + 0.5 * (1 - depth)) * dpr);
      gl.uniform1f(line.loc.uAmp, ampT);
      gl.uniform1f(line.loc.uDepth, depth);
      gl.uniform1f(line.loc.uScale, scales[i]);
      gl.uniform1f(line.loc.uHover, i === hover ? 1 : 0);
      gl.uniform1f(line.loc.uSweep, sweep);
      gl.uniform1f(line.loc.uSweepOn, sweepOn);
      gl.uniform1f(line.loc.uReveal, reveal);
      gl.uniform3fv(line.loc.uInk, INK);
      gl.uniform3fv(line.loc.uHot, HOT);
      gl.drawArrays(gl.TRIANGLE_STRIP, i * M * 2, M * 2);
    }
  }

  // ---- hover: project ridges on the CPU, front to back; the first whose line is
  //      under the cursor wins, and a nearer ridge's surface hides those behind it
  function pick(px, py) {
    if (!mvp) return -1;
    const tol = 8;
    for (let i = 0; i < N; i++) {
      const z = -i * SPACING;
      const sx = (k) => (mat4.project(mvp, xs[k], ys[i][k] * ampT, z)[0] * 0.5 + 0.5) * W;
      if (px < sx(0) || px > sx(M - 1)) continue;
      let lo2 = 0, hi2 = M - 1;
      while (hi2 - lo2 > 1) { const mid = (lo2 + hi2) >> 1; if (sx(mid) < px) lo2 = mid; else hi2 = mid; }
      const k = Math.abs(sx(lo2) - px) < Math.abs(sx(hi2) - px) ? lo2 : hi2;
      const p = mat4.project(mvp, xs[k], ys[i][k] * ampT, z);
      const sy = (1 - (p[1] * 0.5 + 0.5)) * H;
      if (Math.abs(sy - py) <= tol) return i;
      if (sy < py - tol) return -1;
    }
    return -1;
  }

  const tag = document.createElement('div');
  tag.className = 'hero__tag';
  tag.setAttribute('aria-hidden', 'true');
  hero.append(tag);
  const sign = (g) => (g >= 0 ? '+' : '') + g;

  function describe(i) {
    if (i < 0) { tipEl.textContent = `all ${N} symbols`; tag.classList.remove('is-on'); return; }
    const r = ridges[i];
    const at = r.hodMin != null ? clock(start + r.hodMin * 60, false) : '–';
    tipEl.textContent = `${r.s} ${sign(r.gain)}% · high $${r.hi} at ${at} · ${fmt(r.totalVol)} sh`;
    tag.innerHTML = `<b>${r.s}</b> ${sign(r.gain)}% · ${r.hodBreaks} new highs`;
    tag.classList.add('is-on');
  }

  hero.addEventListener('pointermove', (e) => {
    const r = canvas.getBoundingClientRect();
    mouse.px = e.clientX - r.left; mouse.py = e.clientY - r.top;
    mouse.tx = (mouse.px / W) * 2 - 1; mouse.ty = -((mouse.py / H) * 2 - 1);
    const i = pick(mouse.px, mouse.py);
    if (i !== hover) { hover = i; describe(i); if (!anim.running) draw(); }
    tag.style.transform = `translate(${Math.min(mouse.px + 14, W - 220)}px, ${mouse.py - 34}px)`;
  });
  hero.addEventListener('pointerleave', () => { mouse.tx = mouse.ty = 0; hover = -1; describe(-1); if (!anim.running) draw(); });

  // ---- animation: the session draws itself in, then a sweep replays it
  const anim = loop((dt) => {
    if (introT < 1) {
      introT = Math.min(1, introT + dt / 2.8);
      reveal = easeOut(introT) * 1.0001;
      ampT = 0.15 + 0.85 * easeOut(Math.min(1, introT * 1.1));
      if (introT >= 1) { sweepOn = 1; sweep = 0; }
    } else {
      sweep = (sweep + dt / SWEEP_SECONDS) % 1.1;
    }
    mouse.x += (mouse.tx - mouse.x) * Math.min(1, dt * 2.5);
    mouse.y += (mouse.ty - mouse.y) * Math.min(1, dt * 2.5);
    const u = introT < 1 ? reveal : Math.min(1, sweep);
    clockEl.textContent = clock(start + u * (M - 1) * 60, false);
    draw();
  });

  resize();
  window.addEventListener('resize', () => { resize(); if (!anim.running) draw(); });
  canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); anim.stop(); });

  if (still) {
    clockEl.textContent = clock(start + sweep * (M - 1) * 60, false);
    draw();
    return;
  }
  watch(hero, { enter: () => anim.start(), leave: () => anim.stop() });
}
