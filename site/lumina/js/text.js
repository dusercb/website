// Text over the photo. Each text is plain data in the edit state, positioned in the output frame
// (after cropping) so it stays put when the photo is cropped:
// { id, text, font, color, size (height as a fraction of the frame's shorter side), x, y (centre, 0–1),
//   angle (degrees), style: 'plain' | 'outline' | 'shadow' | 'label' | 'neon' }.
// All of it is drawn onto one canvas the final shader lays over the photo.

export const FONTS = [
  { id: 'sans', name: 'Sans', css: '700 {px} -apple-system, BlinkMacSystemFont, "SF Pro Display", system-ui, "Segoe UI", Roboto, sans-serif' },
  { id: 'serif', name: 'Serif', css: 'italic 600 {px} "Playfair Display", Georgia, "Times New Roman", serif' },
  { id: 'bodoni', name: 'Bodoni', css: 'italic 500 {px} "Bodoni Moda", "Bodoni 72", Didot, serif' },
  { id: 'script', name: 'Script', css: '400 {px} Pacifico, "Snell Roundhand", "Segoe Script", cursive' },
  { id: 'display', name: 'Display', css: '400 {px} "Bebas Neue", Impact, "Arial Narrow", sans-serif' },
  { id: 'mono', name: 'Mono', css: '600 {px} ui-monospace, "SF Mono", Menlo, Consolas, monospace' },
  { id: 'round', name: 'Rounded', css: '700 {px} ui-rounded, "SF Pro Rounded", "Arial Rounded MT Bold", system-ui, sans-serif' },
];

export const TEXT_STYLES = [
  { id: 'plain', name: 'Plain' }, { id: 'outline', name: 'Outline' }, { id: 'shadow', name: 'Shadow' },
  { id: 'label', name: 'Label' }, { id: 'neon', name: 'Neon' },
];

export const TEXT_COLORS = [
  { id: 'white', name: 'White', hex: '#ffffff' }, { id: 'black', name: 'Black', hex: '#111111' }, { id: 'pink', name: 'Pink', hex: '#ff5c8d' },
  { id: 'red', name: 'Red', hex: '#e5383b' }, { id: 'gold', name: 'Gold', hex: '#e9c46a' }, { id: 'peach', name: 'Peach', hex: '#f4a582' },
  { id: 'mint', name: 'Mint', hex: '#7bdcb5' }, { id: 'sky', name: 'Sky', hex: '#74b9ff' }, { id: 'lilac', name: 'Lilac', hex: '#b39ddb' },
];

// Text › Templates: ready-made looks, each a set of the text's own settings (AirBrush's text tool
// opens on templates too; these are Lumina's own).
export const TEXT_TEMPLATES = [
  { id: 'headline', name: 'Headline', v: { font: 'display', style: 'shadow', color: 'white', size: 0.12, spacing: 0.06 } },
  { id: 'elegant', name: 'Elegant', v: { font: 'bodoni', style: 'plain', color: 'white', size: 0.08, spacing: 0.12 } },
  { id: 'signature', name: 'Signature', v: { font: 'script', style: 'shadow', color: 'white', size: 0.09, spacing: 0 } },
  { id: 'neon', name: 'Neon sign', v: { font: 'round', style: 'neon', color: 'pink', size: 0.09, spacing: 0.04 } },
  { id: 'sticker', name: 'Sticker', v: { font: 'round', style: 'label', color: 'gold', size: 0.07, spacing: 0.02 } },
  { id: 'caption', name: 'Caption', v: { font: 'sans', style: 'label', color: 'black', size: 0.045, spacing: 0.02 } },
  { id: 'retro', name: 'Retro', v: { font: 'display', style: 'outline', color: 'peach', size: 0.11, spacing: 0.08 } },
  { id: 'typewriter', name: 'Typewriter', v: { font: 'mono', style: 'shadow', color: 'white', size: 0.05, spacing: 0.1 } },
  { id: 'airy', name: 'Airy', v: { font: 'sans', style: 'plain', color: 'white', size: 0.045, spacing: 0.4 } },
];

export const fontCss = (id, px) => (FONTS.find((f) => f.id === id) || FONTS[0]).css.replace('{px}', `${Math.max(1, Math.round(px))}px`);

// Starts loading the web fonts a text uses; resolves when they are ready (or failed).
export function loadFont(id) {
  if (!document.fonts?.load) return Promise.resolve();
  return document.fonts.load(fontCss(id, 40), 'Aa').catch(() => {});
}

const hex = (id) => (TEXT_COLORS.find((c) => c.id === id) || TEXT_COLORS[0]).hex;
const lines = (t) => String(t || '').split('\n');

// Letter spacing, t.spacing in ems (0 = the font's own, kerned). Spaced lines are set a character
// at a time, the same in every browser (iOS Safari's canvas has no letter spacing of its own).
const chars = (line) => Array.from(line);
function lineWidth(ctx, line, gap) {
  if (!gap) return ctx.measureText(line).width;
  const cs = chars(line);
  return cs.reduce((s, c) => s + ctx.measureText(c).width, 0) + gap * Math.max(0, cs.length - 1);
}
function put(ctx, draw, line, y, gap) {
  if (!gap) return draw(line, 0, y);
  const align = ctx.textAlign;
  ctx.textAlign = 'left';
  let x = -lineWidth(ctx, line, gap) / 2;
  for (const c of chars(line)) {
    draw(c, x, y);
    x += ctx.measureText(c).width + gap;
  }
  ctx.textAlign = align;
}

// Size and layout of one text at output size ow × oh: font px, line height, box half-size.
function layout(ctx, t, ow, oh) {
  const px = t.size * Math.min(ow, oh);
  ctx.font = fontCss(t.font, px);
  const ls = lines(t.text), gap = (t.spacing || 0) * px;
  const w = Math.max(...ls.map((l) => lineWidth(ctx, l, gap)), px * 0.5);
  const lh = px * 1.18;
  const pad = t.style === 'label' ? px * 0.45 : px * 0.15;
  return { px, ls, lh, gap, hw: w / 2 + pad, hh: (ls.length * lh) / 2 + pad * 0.6 };
}

// Draws every text onto `canvas` (sized ow × oh) and returns it, or null when there is none.
export function drawTexts(canvas, texts, ow, oh) {
  if (!texts.length) return null;
  canvas.width = ow;
  canvas.height = oh;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, ow, oh);
  for (const t of texts) {
    const L = layout(ctx, t, ow, oh);
    const col = hex(t.color);
    ctx.save();
    ctx.translate(t.x * ow, t.y * oh);
    ctx.rotate((t.angle * Math.PI) / 180);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = fontCss(t.font, L.px);
    ctx.lineJoin = 'round';
    if (t.style === 'label') {
      ctx.fillStyle = col;
      const r = Math.min(L.hh, L.px * 0.5);
      ctx.beginPath();
      if (ctx.roundRect) ctx.roundRect(-L.hw, -L.hh, L.hw * 2, L.hh * 2, r);
      else ctx.rect(-L.hw, -L.hh, L.hw * 2, L.hh * 2);
      ctx.fill();
    }
    const stroke = (s, x, y) => ctx.strokeText(s, x, y), fill = (s, x, y) => ctx.fillText(s, x, y);
    L.ls.forEach((line, i) => {
      const y = (i - (L.ls.length - 1) / 2) * L.lh;
      if (t.style === 'outline') {
        ctx.lineWidth = L.px * 0.12;
        ctx.strokeStyle = col === '#111111' ? '#ffffff' : '#111111';
        put(ctx, stroke, line, y, L.gap);
      }
      if (t.style === 'shadow') {
        ctx.shadowColor = 'rgba(0,0,0,0.55)';
        ctx.shadowBlur = L.px * 0.18;
        ctx.shadowOffsetY = L.px * 0.06;
      }
      if (t.style === 'neon') {
        ctx.shadowColor = col;
        ctx.shadowBlur = L.px * 0.5;
        ctx.fillStyle = col;
        put(ctx, fill, line, y, L.gap);
        ctx.shadowBlur = L.px * 0.2;
      }
      ctx.fillStyle = t.style === 'label' ? (col === '#ffffff' || col === '#e9c46a' || col === '#7bdcb5' ? '#111111' : '#ffffff') : t.style === 'neon' ? '#ffffff' : col;
      put(ctx, fill, line, y, L.gap);
      ctx.shadowColor = 'transparent';
    });
    ctx.restore();
  }
  return canvas;
}

// The text under output point (x, y) in 0–1 units, topmost first; or null.
export function textAt(texts, x, y, ow, oh) {
  const ctx = document.createElement('canvas').getContext('2d');
  for (let i = texts.length - 1; i >= 0; i--) {
    const t = texts[i];
    const L = layout(ctx, t, ow, oh);
    const a = (-t.angle * Math.PI) / 180;
    const dx = (x - t.x) * ow, dy = (y - t.y) * oh;
    const u = dx * Math.cos(a) - dy * Math.sin(a), v = dx * Math.sin(a) + dy * Math.cos(a);
    if (Math.abs(u) <= L.hw + 12 && Math.abs(v) <= L.hh + 12) return t;
  }
  return null;
}

// Half-size of a text's box in output pixels (for the selection frame).
export function textBox(t, ow, oh) {
  const L = layout(document.createElement('canvas').getContext('2d'), t, ow, oh);
  return [L.hw, L.hh];
}
