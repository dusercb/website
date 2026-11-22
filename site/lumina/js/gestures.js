// Stage navigation: pinch or wheel to zoom, drag to pan, and brush strokes or taps for the tools
// that paint — all from one pointer stream so touch, pen and mouse behave the same.

// At zoom 1 the photo fits between `padTop` (room for the status chips) and `padBottom`.
export class Viewport {
  constructor({ padTop = 52, padBottom = 14 } = {}) {
    this.W = 1;
    this.H = 1;
    this.cw = 1;
    this.ch = 1;
    this.padTop = padTop;
    this.padBottom = padBottom;
    this.reset();
  }

  // Screen point (CSS px) that the view centre (cx, cy) is drawn at.
  get anchor() {
    return [this.cw / 2, this.padTop + (this.ch - this.padTop - this.padBottom) / 2];
  }

  setImage(W, H) {
    this.W = W;
    this.H = H;
    this.reset();
  }

  setStage(cw, ch) {
    this.cw = Math.max(1, cw);
    this.ch = Math.max(1, ch);
    this.clamp();
  }

  reset() {
    this.zoom = 1;
    this.cx = 0.5;
    this.cy = 0.5;
  }

  get scale() {
    const h = Math.max(1, this.ch - this.padTop - this.padBottom);
    return Math.min((this.cw * 0.94) / this.W, h / this.H) * this.zoom;
  }

  toImage(sx, sy) {
    const s = this.scale, [ax, ay] = this.anchor;
    return [(sx - ax) / s + this.cx * this.W, (sy - ay) / s + this.cy * this.H];
  }

  zoomAt(factor, sx, sy) {
    const [ix, iy] = this.toImage(sx, sy);
    this.zoom = Math.min(12, Math.max(1, this.zoom * factor));
    const s = this.scale, [ax, ay] = this.anchor;
    this.cx = (ix - (sx - ax) / s) / this.W;
    this.cy = (iy - (sy - ay) / s) / this.H;
    this.clamp();
  }

  panBy(dx, dy) {
    const s = this.scale;
    this.cx -= dx / s / this.W;
    this.cy -= dy / s / this.H;
    this.clamp();
  }

  // Keeps the photo covering the view when zoomed in; centred when it fits.
  clamp() {
    const s = this.scale, [ax, ay] = this.anchor;
    const left = ax / s / this.W, right = (this.cw - ax) / s / this.W;
    const up = ay / s / this.H, down = (this.ch - ay) / s / this.H;
    this.cx = left + right >= 1 ? 0.5 : Math.min(1 - right, Math.max(left, this.cx));
    this.cy = up + down >= 1 ? 0.5 : Math.min(1 - down, Math.max(up, this.cy));
  }

  // Maps a canvas pixel (top-left origin, device pixels) to image uv for the shader.
  shaderView(dpr) {
    const s = this.scale, [ax, ay] = this.anchor;
    return {
      a: [1 / (dpr * s * this.W), 1 / (dpr * s * this.H)],
      b: [this.cx - ax / (s * this.W), this.cy - ay / (s * this.H)],
    };
  }
}

const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const midpoint = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];

// h: { mode() → 'pan' | 'brush' | 'tap', view(), strokeStart(p), strokeMove(p), strokeEnd(),
//      strokeCancel(), tap(p), cursor(x, y, visible) } — points passed to tools are image pixels.
export function attachStageInput(el, vp, h) {
  const pts = new Map();
  let pinch = null, press = null, stroke = null, lastTap = { t: 0, x: 0, y: 0 };
  const local = (e) => {
    const r = el.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  };

  const beginStroke = () => {
    if (!stroke || stroke.started) return;
    clearTimeout(stroke.timer);
    stroke.started = true;
    h.strokeStart(stroke.first);
  };
  const cancelStroke = () => {
    if (!stroke) return;
    clearTimeout(stroke.timer);
    if (stroke.started) h.strokeCancel();
    stroke = null;
  };

  // Buttons and labels floating over the photo handle their own taps; capturing their pointer
  // here would steal the release (Compare stuck on) and, on some phones, the tap itself.
  const onControl = (e) => Boolean(e.target.closest?.('button, label, a, input'));

  el.addEventListener('pointerdown', (e) => {
    if (e.button > 0 || onControl(e)) return;
    el.setPointerCapture?.(e.pointerId);
    const p = local(e);
    pts.set(e.pointerId, p);
    if (pts.size === 1) {
      press = { x: p[0], y: p[1], t: performance.now(), moved: false };
      // Wait briefly before painting so a second finger can turn this into a pinch.
      if (h.mode() === 'brush') stroke = { started: false, first: vp.toImage(...p), timer: setTimeout(beginStroke, 90) };
      h.cursor(p[0], p[1], true);
    } else if (pts.size === 2) {
      cancelStroke();
      press = null;
      const [a, b] = [...pts.values()];
      pinch = { d: dist(a, b), m: midpoint(a, b) };
      h.cursor(0, 0, false);
    }
  });

  el.addEventListener('pointermove', (e) => {
    const p = local(e);
    if (!pts.has(e.pointerId)) {
      if (e.pointerType === 'mouse') h.cursor(p[0], p[1], !onControl(e));
      return;
    }
    const prev = pts.get(e.pointerId);
    pts.set(e.pointerId, p);
    if (pinch && pts.size >= 2) {
      const [a, b] = [...pts.values()];
      const d = dist(a, b), m = midpoint(a, b);
      vp.zoomAt(d / Math.max(pinch.d, 1), m[0], m[1]);
      vp.panBy(m[0] - pinch.m[0], m[1] - pinch.m[1]);
      pinch = { d, m };
      h.view();
      return;
    }
    if (press && Math.hypot(p[0] - press.x, p[1] - press.y) > 6) press.moved = true;
    if (stroke) {
      if (!stroke.started && press?.moved) beginStroke();
      if (stroke.started) h.strokeMove(vp.toImage(...p));
      h.cursor(p[0], p[1], true);
      return;
    }
    if (press?.moved) {
      vp.panBy(p[0] - prev[0], p[1] - prev[1]);
      h.view();
    }
    if (e.pointerType === 'mouse') h.cursor(p[0], p[1], true);
  });

  const end = (e) => {
    if (!pts.has(e.pointerId)) return;
    const p = pts.get(e.pointerId);
    pts.delete(e.pointerId);
    if (pts.size < 2) pinch = null;
    if (pts.size > 0) return;
    if (stroke) {
      if (!stroke.started && e.type === 'pointerup') beginStroke(); // a tap paints one dab
      if (stroke.started) {
        if (e.type === 'pointerup') h.strokeEnd();
        else h.strokeCancel();
      }
      clearTimeout(stroke.timer);
      stroke = null;
    } else if (press && !press.moved && e.type === 'pointerup' && performance.now() - press.t < 450) {
      if (h.mode() === 'tap') {
        h.tap(vp.toImage(p[0], p[1]));
      } else {
        const now = performance.now();
        if (now - lastTap.t < 320 && Math.hypot(p[0] - lastTap.x, p[1] - lastTap.y) < 30) {
          if (vp.zoom > 1.05) vp.reset();
          else vp.zoomAt(2.5, p[0], p[1]);
          h.view();
          lastTap.t = 0;
        } else {
          lastTap = { t: now, x: p[0], y: p[1] };
        }
      }
    }
    press = null;
    if (e.pointerType !== 'mouse') h.cursor(0, 0, false);
  };
  el.addEventListener('pointerup', end);
  el.addEventListener('pointercancel', end);
  el.addEventListener('pointerleave', (e) => {
    if (e.pointerType === 'mouse' && !pts.size) h.cursor(0, 0, false);
  });
  el.addEventListener('wheel', (e) => {
    e.preventDefault();
    const p = local(e);
    vp.zoomAt(Math.exp(-e.deltaY * 0.0015), p[0], p[1]);
    h.view();
  }, { passive: false });
}
