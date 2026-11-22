// Painted masks: skin to smooth, the subject for background effects, hair to recolour, and the
// brush areas of Wrinkles, Concealer, Matte, Texture, Details and Teeth. Each one is a canvas at
// mask resolution holding a base (empty, a model's output, or the face) plus the person's brush
// strokes. Strokes live in the edit state, so undo simply replays them. A canvas is only made
// once a layer is first painted (or given a base), so unused tools cost no memory.
//
// A stroke is { m: 'add' | 'remove', r: radius in image px, p: [x0, y0, x1, y1, …] in image px }.
// Layers created with { base: 128 } start half-on: they adjust an automatic area, so brushing adds
// to it (toward 255) and erasing takes away from it (toward 0).

export class MaskLayer {
  constructor(scale, { hard = false, base = 0 } = {}) {
    this.scale = scale;
    this.hard = hard;
    this.fill = base;
    this.canvas = null;
    this.ctx = null;
    this.base = null;
    this.baseAlpha = null;
    this.w = 1;
    this.h = 1;
    this.dirty = false;
  }

  // New photo: remember the size and the uniform base; the canvas comes later.
  reset(W, H, fill = this.fill) {
    this.w = Math.max(1, Math.round(W * this.scale));
    this.h = Math.max(1, Math.round(H * this.scale));
    this.fill = fill;
    this.baseAlpha = null;
    if (this.canvas) this.canvas.width = this.canvas.height = 0;   // iOS counts canvas memory until GC
    this.canvas = null;
    this.ctx = null;
    this.base = null;
    this.dirty = false;
  }

  get width() {
    return this.w;
  }

  get height() {
    return this.h;
  }

  get ready() {
    return Boolean(this.ctx);
  }

  ensure() {
    if (this.ctx) return;
    this.canvas = document.createElement('canvas');
    this.canvas.width = this.w;
    this.canvas.height = this.h;
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });
    this.base = new ImageData(this.w, this.h);
    this.paintBase();
  }

  paintBase() {
    const d = this.base.data, a = this.baseAlpha;
    for (let i = 0; i < this.w * this.h; i++) {
      d[i * 4] = d[i * 4 + 1] = d[i * 4 + 2] = 255;
      d[i * 4 + 3] = a ? a[i] : this.fill;
    }
  }

  // alpha: Uint8 array of width × height, or null for the uniform base `fill`.
  setBase(alpha, fill = this.fill) {
    this.baseAlpha = alpha;
    this.fill = fill;
    if (this.base) this.paintBase();
  }

  // True when the layer would show nothing but its uniform base.
  get blank() {
    return !this.baseAlpha;
  }

  // regionOf(s) gives a tapped stroke's region (Background › Fix edges › Tap), as for region().
  redraw(strokes, regionOf) {
    if (!this.ctx && !strokes.length && this.blank) return;
    this.ensure();
    this.ctx.putImageData(this.base, 0, 0);
    for (const s of strokes) {
      if (s.t) {
        const r = regionOf?.(s);
        if (r) this.region(r, s.m);
        continue;
      }
      const st = this.begin(s);
      for (let i = 2; i < s.p.length; i += 2) this.extend(s, st, s.p[i], s.p[i + 1]);
    }
    this.dirty = true;
  }

  // Starts a stroke (draws its first dab) and returns the cursor used by extend().
  begin(s) {
    this.ensure();
    const st = { x: s.p[0] * this.scale, y: s.p[1] * this.scale };
    this.dab(s, st.x, st.y);
    this.dirty = true;
    return st;
  }

  // Dabs evenly from the last dab to (x, y) in image px.
  extend(s, st, x, y) {
    const r = s.r * this.scale, step = Math.max(1, r * 0.3);
    const tx = x * this.scale, ty = y * this.scale;
    const n = Math.floor(Math.hypot(tx - st.x, ty - st.y) / step);
    if (!n) return;
    for (let j = 1; j <= n; j++) this.dab(s, st.x + ((tx - st.x) * j) / n, st.y + ((ty - st.y) * j) / n);
    st.x = tx;
    st.y = ty;
    this.dirty = true;
  }

  dab(s, x, y) {
    const ctx = this.ctx, r = Math.max(1, s.r * this.scale);
    ctx.save();
    ctx.globalCompositeOperation = s.m === 'remove' ? 'destination-out' : 'source-over';
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    if (this.hard) {
      g.addColorStop(0, 'rgba(255,255,255,0.9)');
      g.addColorStop(0.7, 'rgba(255,255,255,0.75)');
    } else {
      g.addColorStop(0, 'rgba(255,255,255,0.5)');
      g.addColorStop(0.55, 'rgba(255,255,255,0.32)');
    }
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  // Adds (or with mode 'remove' takes away) a whole region { a, w, h, x0, y0 }: alpha at this
  // layer's scale, placed at x0, y0.
  region(r, mode) {
    this.ensure();
    const c = document.createElement('canvas');
    c.width = r.w;
    c.height = r.h;
    const id = new ImageData(r.w, r.h);
    for (let i = 0; i < r.w * r.h; i++) {
      id.data[i * 4] = id.data[i * 4 + 1] = id.data[i * 4 + 2] = 255;
      id.data[i * 4 + 3] = r.a[i];
    }
    c.getContext('2d').putImageData(id, 0, 0);
    this.ctx.save();
    this.ctx.globalCompositeOperation = mode === 'remove' ? 'destination-out' : 'source-over';
    this.ctx.drawImage(c, r.x0, r.y0);
    this.ctx.restore();
    c.width = c.height = 0;
    this.dirty = true;
  }

  // Current alpha channel (for CPU work such as relight normals).
  alpha() {
    if (!this.ctx) {
      const a = new Uint8ClampedArray(this.w * this.h);
      if (this.baseAlpha) a.set(this.baseAlpha);
      else a.fill(this.fill);
      return a;
    }
    const d = this.ctx.getImageData(0, 0, this.w, this.h).data;
    const a = new Uint8ClampedArray(this.w * this.h);
    for (let i = 0; i < a.length; i++) a[i] = d[i * 4 + 3];
    return a;
  }
}
