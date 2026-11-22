// WebGL2 renderer. Edits are non-destructive: the photo, cached filter passes, feature masks and
// painted masks live in textures, and each frame re-composites them from the current settings.
//
// Texture convention: row 0 of every texture is the top of the photo (no flips on upload).
// Only the on-screen pass flips, because the default framebuffer's origin is bottom-left.
//
// Passes: retouch (skin, face and body work) → hair (grey hair, care and colour, on the hair's matte)
// → composite (makeup, background) → added people → final (reshape warp, crop and lens, light,
// effects, colour, text) to screen or export.

const VERT = `#version 300 es
in vec2 aPos;
out vec2 vUv;
void main() {
  vUv = aPos * 0.5 + 0.5;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

const HEAD = `#version 300 es
precision highp float;
precision highp int;
in vec2 vUv;
out vec4 outColor;

float luma(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }
vec3 toYcc(vec3 c) { float y = luma(c); return vec3(y, (c.b - y) * 0.564 + 0.5, (c.r - y) * 0.713 + 0.5); }
vec3 fromYcc(vec3 v) {
  float cb = v.y - 0.5, cr = v.z - 0.5;
  return vec3(v.x + 1.403 * cr, v.x - 0.344 * cb - 0.714 * cr, v.x + 1.773 * cb);
}
// Non-separable blend helpers from the W3C compositing spec.
float lum(vec3 c) { return dot(c, vec3(0.3, 0.59, 0.11)); }
vec3 clipColor(vec3 c) {
  float l = lum(c), n = min(min(c.r, c.g), c.b), x = max(max(c.r, c.g), c.b);
  if (n < 0.0) c = l + (c - l) * l / max(l - n, 1e-5);
  if (x > 1.0) c = l + (c - l) * (1.0 - l) / max(x - l, 1e-5);
  return c;
}
vec3 setLum(vec3 c, float l) { return clipColor(c + (l - lum(c))); }
vec3 softLight(vec3 b, vec3 s) {
  vec3 d = mix(sqrt(b), ((16.0 * b - 12.0) * b + 4.0) * b, step(b, vec3(0.25)));
  return mix(b - (1.0 - 2.0 * s) * b * (1.0 - b), b + (2.0 * s - 1.0) * (d - b), step(vec3(0.5), s));
}
vec3 screen(vec3 a, vec3 b) { return 1.0 - (1.0 - a) * (1.0 - b); }
float hash(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
}
vec3 rgb2hsv(vec3 c) {
  vec4 K = vec4(0.0, -1.0 / 3.0, 2.0 / 3.0, -1.0);
  vec4 p = mix(vec4(c.bg, K.wz), vec4(c.gb, K.xy), step(c.b, c.g));
  vec4 q = mix(vec4(p.xyw, c.r), vec4(c.r, p.yzx), step(p.x, c.r));
  float d = q.x - min(q.w, q.y);
  return vec3(abs(q.z + (q.w - q.y) / (6.0 * d + 1e-10)), d / (q.x + 1e-10), q.x);
}
vec3 hsv2rgb(vec3 c) {
  vec3 p = abs(fract(c.xxx + vec3(1.0, 2.0 / 3.0, 1.0 / 3.0)) * 6.0 - 3.0);
  return c.z * mix(vec3(1.0), clamp(p - 1.0, 0.0, 1.0), c.y);
}
`;

// Box-filtered copy; uOffset = (downscale / 4) source texels averages the whole footprint.
const COPY = `
uniform sampler2D uSrc;
uniform vec2 uOffset;
void main() {
  vec2 o = uOffset;
  outColor = 0.25 * (texture(uSrc, vUv + vec2(-o.x, -o.y)) + texture(uSrc, vUv + vec2(o.x, -o.y)) +
                     texture(uSrc, vUv + vec2(-o.x, o.y)) + texture(uSrc, vUv + vec2(o.x, o.y)));
}`;

// Edge-preserving smoothing (bilateral filter, Tomasi & Manduchi 1998) sampled on a
// golden-angle spiral so a 40-tap kernel covers the whole disc evenly.
const BILATERAL = `
uniform sampler2D uSrc;
uniform vec2 uTexel;
uniform float uRadius;
uniform float uSigmaR;
const int N = 40;
void main() {
  vec3 c0 = texture(uSrc, vUv).rgb;
  vec3 sum = c0;
  float ws = 1.0;
  float k = 1.0 / (2.0 * uSigmaR * uSigmaR);
  for (int i = 1; i < N; i++) {
    float fi = float(i);
    float r = sqrt(fi / float(N)) * uRadius;
    float a = fi * 2.39996323;
    vec3 c = texture(uSrc, vUv + vec2(cos(a), sin(a)) * r * uTexel).rgb;
    vec3 d = c - c0;
    float w = exp(-dot(d, d) * k) * exp(-1.5 * r * r / (uRadius * uRadius));
    sum += c * w;
    ws += w;
  }
  outColor = vec4(sum / ws, 1.0);
}`;

// One direction of a separable Gaussian. uStep is the direction times the tap stride.
const GAUSS = `
uniform sampler2D uSrc;
uniform vec2 uStep;
uniform float uSigma;
uniform int uTaps;
void main() {
  vec4 sum = texture(uSrc, vUv);
  float ws = 1.0;
  for (int i = 1; i <= 32; i++) {
    if (i > uTaps) break;
    float fi = float(i);
    float w = exp(-0.5 * fi * fi / (uSigma * uSigma));
    sum += (texture(uSrc, vUv + uStep * fi) + texture(uSrc, vUv - uStep * fi)) * w;
    ws += 2.0 * w;
  }
  outColor = sum / ws;
}`;

// Colour of one side of the cut-out only, premultiplied by its weight: the background
// (weight 1 − subject), the subject (uInvert = 1), or every pixel (uUseMask = 0). uSure counts only
// clear background, so none of an edge pixel's own colour is taken for what lies behind it.
const BGPREP = `
uniform sampler2D uSrc;
uniform sampler2D uMask;
uniform vec2 uOffset;
uniform float uUseMask, uInvert, uSure;
void main() {
  vec4 acc = vec4(0.0);
  for (int i = 0; i < 4; i++) {
    vec2 o = vec2(i == 0 || i == 2 ? -uOffset.x : uOffset.x, i < 2 ? -uOffset.y : uOffset.y);
    float m = texture(uMask, vUv + o).a;
    float w = uSure > 0.5 ? 1.0 - smoothstep(0.05, 0.25, m) : mix(1.0, mix(1.0 - m, m, uInvert), uUseMask);
    acc += vec4(texture(uSrc, vUv + o).rgb * w, w);
  }
  outColor = acc * 0.25;
}`;

// A refined area (guidedCoeffs in blur.js): coefficients found on a quarter-size copy of the photo,
// applied to each photo pixel and kept between an inner and an outer limit drawn round the area's
// own outline, so the edge moves onto the strands but not out along lines behind them. The filter
// leaves the inside of a soft edge near 0.8, so the result is stretched to make it solid.
const MATTE = `
uniform sampler2D uSrc, uAB, uLH;
void main() {
  vec4 ab = texture(uAB, vUv);
  vec2 lh = texture(uLH, vUv).rg;
  float a = (dot(ab.rgb, texture(uSrc, vUv).rgb) + ab.a - 0.05) / 0.75;
  outColor = vec4(1.0, 1.0, 1.0, clamp(a, lh.x, lh.y));
}`;

// Hair's matte (refineHair in main.js). uFB holds the hair's own colour nearby and how far colour can
// tell hair from what lies behind; uBB the colour behind and the model's own area; uLH what is
// surely hair, what surely not, and whether what lies behind is skin or clothes (all at quarter size). Each photo pixel's share of hair is where
// its colour sits between the two colours. The model's edge decides instead where the two colours
// are too alike, or where the pixel is not a mix of the two at all (a light or an object behind,
// off the line between them). Where the photo is smooth, colour counts only as far as the model
// itself takes it for hair: soft hair out of focus keeps its share, but a smooth gradient of
// background beside sharp hair, which colour alone would take for a haze of hair, does not. Also
// writes the hair's own colour under the pixel, by blur fusion (Forte, ICIP 2021): the hair colour
// nearby, corrected by whatever of the pixel the mix of the two colours does not explain.
const HAIRMATTE = `
uniform sampler2D uSrc, uFB, uBB, uLH;
uniform vec2 uTexel;
void main() {
  vec3 c = texture(uSrc, vUv).rgb;
  vec4 f = texture(uFB, vUv), b = texture(uBB, vUv);
  vec3 lh = texture(uLH, vUv).rgb;
  vec3 d = f.rgb - b.rgb;
  float dd = max(dot(d, d), 1e-4), t = dot(c - b.rgb, d) / dd;
  // The light range round the pixel (is it fine detail?), and the share of hair of the most
  // background-like pixel round it (is background showing through beside it?).
  float lo = luma(c), hi = lo, near = t;
  for (int j = -1; j <= 1; j++) {
    for (int i = -1; i <= 1; i++) {
      vec3 q = texture(uSrc, vUv + vec2(float(i), float(j)) * 2.0 * uTexel).rgb;
      float l = luma(q);
      lo = min(lo, l);
      hi = max(hi, l);
      near = min(near, dot(q - b.rgb, d) / dd);
    }
  }
  float ac = clamp((t - 0.1) / 0.8, 0.0, 1.0);
  ac = mix(min(ac, smoothstep(0.1, 0.5, b.a)), ac, smoothstep(0.03, 0.09, hi - lo));
  // How far the pixel is from any mix of the two, with colour counted more than lightness: a grey
  // groove in a shutter can be as dark as a strand of brown hair, but not as brown. Skin and clothes
  // behind are allowed more: skin is pinker in a hairline's shadow than further off.
  vec3 r = c - b.rgb - clamp(t, 0.0, 1.0) * d;
  float ry = luma(r);
  vec2 rc = vec2(r.b - ry, r.r - ry) * vec2(0.564, 0.713);
  float trust = f.a * (1.0 - smoothstep(0.04 + 0.06 * lh.z, 0.11 + 0.12 * lh.z, sqrt(ry * ry + 6.0 * dot(rc, rc))));
  // Hair lit by the sun or from behind at its edge is far lighter than the hair inside, so it is no
  // mix of the two colours, but it keeps the hair's hue. Where the hair and what lies behind differ in
  // hue (colour with its lightness taken out), a pixel near the model's hair whose hue lies toward
  // the hair's counts as hair by how far toward it lies. This only ever adds hair, and skips dark
  // pixels, whose hue is mostly noise (skin is the hair's hue, so it is never added).
  vec3 yc = toYcc(c), yf = toYcc(f.rgb), yb = toYcc(b.rgb);
  vec2 hb = (yb.yz - 0.5) / max(yb.x, 0.05), dh = (yf.yz - 0.5) / max(yf.x, 0.05) - hb;
  vec2 hc = (yc.yz - 0.5) / max(yc.x, 0.05) - hb;
  float sep = length(dh), along = dot(hc, dh) / max(sep, 1e-4);
  float cone = smoothstep(0.75, 0.9, along / max(length(hc), 1e-4));
  float rim = smoothstep(0.06, 0.12, sep) * cone * smoothstep(0.08, 0.25, b.a) * smoothstep(0.08, 0.16, yc.x) * f.a;
  float rimHair = rim * clamp((along / max(sep, 1e-4) - 0.2) / 0.6, 0.0, 1.0);
  if (rimHair > ac) {
    ac = rimHair;
    trust = max(trust, rimHair);
  }
  // Background showing between strands (its own colour, clearly apart from the hair's) is not hair,
  // even inside what the model calls surely hair, and beside it colour decides how much of each
  // strand is hair: lit from behind, the strands round a gap are partly see-through.
  float gap = trust * (1.0 - smoothstep(0.08, 0.3, near));
  float a = clamp(mix(smoothstep(0.35, 0.65, b.a), ac, trust), lh.x * (1.0 - gap), lh.y);
  // The hair's colour is found from the colour's own share; where the share was set higher than the
  // colour says (surely hair, or the model's edge) and the pixel is mostly hair, it is taken as it is.
  float s = clamp(t, 0.0, 1.0), said = max(s, clamp((t - 0.1) / 0.8, 0.0, 1.0));
  vec3 hair = f.rgb + s * (c - s * f.rgb - (1.0 - s) * b.rgb);
  hair = mix(hair, c, smoothstep(0.5, 1.0, a) * clamp((a - said) / max(1.0 - said, 1e-3), 0.0, 1.0));
  // Where the share is clear, the hair's colour is what the pixel leaves once its share of what lies
  // behind is taken out, so a change to the hair moves the pixel by exactly the hair's part of it (a
  // darker estimate let soft hair at the temples go paler than both the hair and the skin).
  vec3 left = (c - (1.0 - a) * b.rgb) / max(a, 0.05);
  hair = mix(hair, left, smoothstep(0.2, 0.6, a) * trust);
  outColor = vec4(clamp(hair, 0.0, 1.0), a);
}`;

// The hair alone, weighted by its share, at half size (four taps): blurred, it gives the hair pass
// the hair's own light round each pixel without the background or skin beside it.
const HAIRPREP = `
uniform sampler2D uSrc, uHair;
uniform vec2 uOffset;
uniform float uHairMatte;
void main() {
  vec4 acc = vec4(0.0);
  for (int i = 0; i < 4; i++) {
    vec2 o = vec2(i == 0 || i == 2 ? -uOffset.x : uOffset.x, i < 2 ? -uOffset.y : uOffset.y);
    vec4 m = texture(uHair, vUv + o);
    acc += vec4((uHairMatte > 0.5 ? m.rgb : texture(uSrc, vUv + o).rgb) * m.a, m.a);
  }
  outColor = acc * 0.25;
}`;

// Hair: Age's grey hair, then Hair's care and colour, between the retouch and the composite. Each
// works on the hair's own colour (from the matte, or the pixel itself while Paint is in use), and
// only the hair's share of each pixel changes: a strand over the sky or the forehead takes the new
// colour in proportion, and the background, skin and ears round it none. Light and shade are judged
// against blurs of the hair alone, so the hair's edge is not taken for a shadow or a band of light
// (that left a dark rim round grey hair and a glow round dyed hair).
const HAIR = `
uniform sampler2D uSrc, uHair, uHairS, uHairM, uFlow;
uniform vec2 uTexel, uImgSize;
uniform float uGate, uSkinY;
uniform vec2 uSkinMean;
uniform mat2 uSkinInv;
uniform float uHairAmt, uHairDepth, uHairMatte;
uniform vec3 uHairColor, uHairDark, uHairLight;   // the shade, and its ramp's shadow and highlight
uniform float uHairShine, uHairSmooth, uHairTex, uHairEnrich, uHairOil;
uniform vec3 uHairMean;     // the hair's own average colour (luma, Cb, Cr)
uniform vec2 uHairMid;      // the hair's middle light (median) and how widely its log light spreads
// Age › Hair: how grey (0–1), how much it starts at the temples, and the shade it turns (a tint and
// a lift on silver's lightness). Per face: the two temples (xy, zw) and the top of the forehead (xy)
// with how far their pull reaches (z), in pixels. How much of the hair's light white hair keeps at
// each scale (strands, bands, the head), the spread of the hair's own strand detail, and a strand's
// width in pixels. The tint carries the photo's light as well as the shade.
uniform float uAgeGrey, uAgeTemples, uAgeLift;
uniform vec3 uAgeTint;
uniform vec4 uTemples[4], uTempleTop[4];
uniform int uTempleCount;
uniform vec3 uGreyGain;
uniform float uGreyFine, uStrandW;

vec3 hairAt(vec2 p) { return uHairMatte > 0.5 ? texture(uHair, p).rgb : texture(uSrc, p).rgb; }

// Care works on the hair's own light in proportion (it multiplies, never adds white), so the hair
// keeps its colour: a white veil, grey streaks and clumped strands are what read as greasy. The
// strands' direction comes from the flow field (FLOW, its doubled angle and how clear it is).
vec2 strandAt(vec2 p, out float coh) {
  vec2 f = texture(uFlow, p).rg * 2.0 - 1.0;
  coh = length(f);
  if (coh < 0.01) return vec2(0.0, 1.0);
  float a = 0.5 * atan(f.y, f.x);                      // the gradient's direction; strands cross it
  return vec2(-sin(a), cos(a));
}

// The average along the strands, following their curve both ways: it keeps the strands and loses
// what crosses them (frizz, fly-aways, noise).
vec3 alongStrands(vec3 col, out float coh) {
  vec2 d0 = strandAt(vUv, coh);
  vec3 sum = col;
  float ws = 1.0;
  for (int side = 0; side < 2; side++) {
    vec2 p = vUv, d = side == 0 ? d0 : -d0;
    for (int k = 1; k <= 6; k++) {
      float c;
      vec2 dk = strandAt(p, c);
      d = dot(dk, d) < 0.0 ? -dk : dk;
      p += d * uTexel * 1.5;
      float w = 1.0 - float(k) / 7.0;
      sum += hairAt(p) * w;
      ws += w;
    }
  }
  return sum / ws;
}

// Smooth averages along the strands where the hair has a clear flow (curls and coils are left
// alone). Texture deepens each strand's own light and dark. Oil control brings broad, soft bands of
// shine down toward their surroundings. Shine is local contrast at the scale of the bands of light
// the hair already has: brighter bands, a little more depth between them, strands crisp inside the
// light. Enrich fills scalp showing through and gives the mid-tones more depth and colour. col is
// the hair as it now is, h0 as photographed; ls and lm the hair's own light at two scales.
vec3 hairCare(vec3 col, vec3 h0, float ls, float lm) {
  float coh;
  vec3 along = alongStrands(h0, coh);
  float flow = smoothstep(0.08, 0.45, coh);
  // Above 1 on a band of light. Far above (strands lit from behind at the hair's edge or round a gap)
  // it counts for less, so Shine does not turn them white.
  float band = ls / lm;
  band = 1.0 + (band - 1.0) / (1.0 + 2.0 * max(band - 1.3, 0.0));
  vec3 c = col;
  if (uHairSmooth > 0.0) {
    // Fine fuzz differs little from the strands round it and goes; a strand that stands out stays.
    vec3 d = h0 - along;
    c -= d * uHairSmooth * 0.85 * flow * (1.0 - 0.7 * smoothstep(0.03, 0.12, length(d)));
  }
  if (uHairTex > 0.0) {
    float g = luma(along) / ls - 1.0;
    c *= 1.0 + uHairTex * (0.4 + 0.6 * flow) * 1.4 * g / (1.0 + 3.0 * abs(g));
  }
  if (uHairOil > 0.0) c *= pow(min(1.0, 1.05 / band), uHairOil * 0.9 * smoothstep(1.03, 1.3, band));
  if (uHairShine > 0.0) {
    // Dark hair's bands of light are faint, so it needs a stronger lift to show any gloss.
    float k = uHairShine * (1.0 + 1.2 * (1.0 - smoothstep(0.06, 0.3, lm)));
    c *= pow(band, 0.75 * k) * pow(min(max(luma(along), 0.01) / ls, 1.5), 0.35 * k * smoothstep(1.0, 1.5, band));
    c = clipColor(c);
  }
  if (uHairEnrich > 0.0) {
    vec3 y = toYcc(c);
    // Scalp or a thin patch: skin-coloured and lighter than the hair round it. Only looked for when
    // the hair is clearly darker than the skin; on fair hair a light patch is just hair.
    if (uGate > 0.5 && uHairMean.x < uSkinY - 0.12) {
      vec2 dv = toYcc(h0).yz - uSkinMean;
      float scalp = (1.0 - smoothstep(1.6, 3.6, sqrt(max(dot(dv, uSkinInv * dv), 0.0)))) * smoothstep(0.03, 0.12, y.x - min(lm, uHairMean.x * 1.3));
      y = mix(y, vec3(mix(min(y.x, lm), uHairMean.x, 0.5), uHairMean.yz), clamp(scalp * uHairEnrich, 0.0, 1.0));
    }
    float mid = smoothstep(0.02, 0.2, y.x) * (1.0 - smoothstep(0.45, 0.85, y.x));
    y.x *= 1.0 - 0.12 * uHairEnrich * mid;
    y.yz = 0.5 + (y.yz - 0.5) * (1.0 + 0.35 * uHairEnrich * mid);
    c = fromYcc(y);
  }
  return clamp(c, 0.0, 1.0);
}

// Hair colour as dyed hair looks in photos (evidence §16). A shade is a ramp, measured from natural
// hair: deep shadow (darker, warmer and richer than the shade), the shade, and a pale highlight with
// less colour. Each pixel's light, measured against the hair's own (its middle light and how widely
// its light spreads, so flat-lit black hair uses the whole ramp too), places it on the ramp: the
// hair keeps its strands, depth and shine instead of turning one flat colour. Its lightness spreads
// round the shade's own as natural hair of that lightness does in photos: dark hair has deep shadows
// and bright highlights; light hair shadows less deep and highlights close to its own light (it
// scatters light into its shadows, and there is little room above it). Depth adds contrast. A
// little of the hair's own variation in colour stays, so streaks and lowlights still show. calm (a
// log factor) evens the light of very dark hair, whose fine variation is mostly the photo's noise;
// a pixel only partly hair (whole below 1) takes the ramp's middle, as its hair colour is an estimate.
vec3 dyeHair(vec3 col, float calm, float whole) {
  float l = max(luma(col), 0.003) * exp(calm);
  float z = whole * clamp(log(l / max(uHairMid.x, 0.01)) / max(uHairMid.y, 0.22), -2.5, 2.5);
  float pos = clamp(0.5 + 0.25 * z, 0.0, 1.0);
  vec3 ramp = pos < 0.5 ? mix(uHairDark, uHairColor, smoothstep(0.0, 1.0, pos * 2.0))
                        : mix(uHairColor, uHairLight, smoothstep(0.0, 1.0, pos * 2.0 - 1.0));
  float lt = max(luma(uHairColor), 0.01), k = smoothstep(0.2, 0.85, lt);
  float L = lt * exp(max(z, -1.8) * (z < 0.0 ? mix(0.6, 0.35, k) : mix(0.55, 0.12, k)) * (0.85 + 0.5 * uHairDepth));
  vec3 y = toYcc(clipColor(ramp * (L / max(luma(ramp), 0.003))));
  y.yz += 0.25 * (toYcc(col).yz - uHairMean.yz) * min(y.x / l, 2.0);
  return clamp(fromYcc(y), 0.0, 1.0);
}

// Hair greys first at the temples and along the front hairline: how near the pixel is to them (0–1).
float templeAt(vec2 p) {
  float w = 0.0;
  for (int i = 0; i < 4; i++) {
    if (i >= uTempleCount) break;
    vec4 tl = uTemples[i], tt = uTempleTop[i];
    float s2 = tt.z * tt.z;
    w = max(w, exp(-dot(p - tl.xy, p - tl.xy) / s2));
    w = max(w, exp(-dot(p - tl.zw, p - tl.zw) / s2));
    w = max(w, 0.6 * exp(-dot(p - tt.xy, p - tt.xy) / s2));
  }
  return w;
}

// Value noise on cells a strand wide. Its hash stays exact at photo-sized coordinates.
float strandHash(vec2 p) {
  vec3 q = fract(vec3(p.xyx) * 0.1031);
  q += dot(q, q.yzx + 33.33);
  return fract((q.x + q.y) * q.z);
}
float strandNoise(vec2 p) {
  vec2 i = floor(p), f = fract(p), u = f * f * (3.0 - 2.0 * f);
  return mix(mix(strandHash(i), strandHash(i + vec2(1.0, 0.0)), u.x), mix(strandHash(i + vec2(0.0, 1.0)), strandHash(i + vec2(1.0, 1.0)), u.x), u.y);
}

// Where more or fewer strands have turned white (0–1, 0.5 = as many as the rest): noise drawn out
// along the strands both ways, so it runs as white hairs do, evened to 0–1. The taps are half a
// cell apart (further apart, the noise's own cells come through as a ladder across the strands);
// one tap spreads 0.214, and close taps share some of it (the last factor, measured). Where the hair
// has no clear flow (curls and coils) it would only be grain, so it stays at 0.5.
float whiteStrands() {
  float coh;
  vec2 d0 = strandAt(vUv, coh), cell = uImgSize / uStrandW;
  float reach = smoothstep(0.08, 0.45, coh), sum = strandNoise(vUv * cell), ws = 1.0, w2 = 1.0;
  for (int side = 0; side < 2; side++) {
    vec2 p = vUv, d = side == 0 ? d0 : -d0;
    for (int k = 1; k <= 8; k++) {
      float c;
      vec2 dk = strandAt(p, c);
      d = dot(dk, d) < 0.0 ? -dk : dk;
      p += d * uTexel * uStrandW * 0.5;
      float w = (1.0 - float(k) / 9.0) * reach;
      sum += strandNoise(p * cell) * w;
      ws += w;
      w2 += w * w;
    }
  }
  float spread = 0.214 * sqrt(w2) / ws * (1.0 + 0.64 * (1.0 - exp(-5.0 * reach)));
  return mix(0.5, 1.0 / (1.0 + exp(-1.702 * (sum / ws - 0.5) / spread)), reach);
}

void main() {
  vec3 col = texture(uSrc, vUv).rgb;
  vec4 m = texture(uHair, vUv);
  float share = m.a;
  if (share < 0.003) {
    outColor = vec4(col, 1.0);
    return;
  }
  vec3 h0 = uHairMatte > 0.5 ? m.rgb : col, h = h0;
  vec4 rs = texture(uHairS, vUv), rm = texture(uHairM, vUv);
  float ls = max(rs.a > 0.004 ? luma(rs.rgb) / rs.a : luma(h0), 0.015);
  float lm = max(rm.a > 0.004 ? luma(rm.rgb) / rm.a : ls, 0.015);
  // Light is read strand by strand only where the pixel is all hair: at the edge the hair's colour is
  // an estimate, and its light against the hair round it would draw a bright or dark line.
  float whole = smoothstep(0.6, 1.0, share);

  // Very dark hair's fine variation is mostly the photo's noise: its light is evened over the hair
  // round each pixel (weighted by its share, so background beside the hair counts for nothing) before
  // a colour reads it. Grey hair keeps it: white hair shows its strands.
  float calm = 0.0;
  if (uHairAmt > 0.0) {
    vec2 l3 = vec2(0.0);
    for (int j = -1; j <= 1; j++) {
      for (int i = -1; i <= 1; i++) {
        vec2 q = vUv + vec2(float(i), float(j)) * 1.5 * uTexel;
        float w = texture(uHair, q).a;
        l3 += vec2(luma(hairAt(q)) * w, w);
      }
    }
    calm = 0.6 * (1.0 - smoothstep(0.1, 0.3, uHairMid.x)) * (log(max(l3.x / max(l3.y, 1e-3), 0.003)) - log(max(luma(h0), 0.003)));
  }

  if (uAgeGrey > 0.0) {
    // Age › Grey hair (evidence §17). Hair greys strand by strand, whatever the light: the share of
    // strands that has turned (more at the temples and the front hairline while it is part grey) is
    // white, the rest keeps its pigment with a little less colour. White hair scatters light into
    // its own shadows, so it is light and its contrast is low, but its strands still show: its light
    // is the pixel's own, split into strands, bands of light and the head as the hair's light is,
    // each scale brought part way to the spread white hair shows in photos (never above the photo's
    // own, so locs and curls keep more of their shape), round white hair's middle, with a soft
    // shoulder below white, in the photo's light. Dark hair's shine does not turn to chrome, and
    // smooth hair does not turn to a flat wig.
    float grey = uAgeGrey;
    if (uAgeTemples > 0.0) grey = clamp(grey + 1.4 * uAgeTemples * (2.0 * templeAt(vUv * uImgSize) - 1.0) * min(grey, 1.0 - grey), 0.0, 1.0);
    // The photo's own noise is a larger part of dark hair's finest variation (about 0.008 of light,
    // against the hair's light round the pixel): strand detail near that size is shrunk, so black
    // hair's grain does not turn to blotches, and lone specks far past the hair's own strand detail
    // (uGreyFine) are softened. Near the hair's outline its colour can keep some of the background's
    // light (an estimate at the edge; background through the outermost hair just inside it), so
    // the pixel's own detail being lighter than the hair round it only counts well inside the hair
    // (else the outline turns into a white line); the outline keeps the light of the hair round it
    // (the hair-only blur), so it is no darker than the hair inside either.
    float f = log(max(luma(h), 0.003) / ls), fn = 0.008 / ls;
    f = 3.0 * uGreyFine * tanh(f * f * f / (f * f + fn * fn) / (3.0 * uGreyFine));
    float edge = smoothstep(0.75, 1.0, share), inner = edge * smoothstep(0.75, 0.98, rs.a);
    float v = uGreyGain.x * f + uGreyGain.y * log(ls / lm);
    v = v * (v > 0.0 ? inner * inner : edge) + uGreyGain.z * log(lm / max(uHairMid.x, 0.01));
    float L = (0.68 + uAgeLift) * exp(clamp(v, -1.6, 0.8));
    L = L > 0.8 ? 0.8 + 0.17 * tanh((L - 0.8) / 0.17) : L;
    // Each pixel holds many strands, so part-grey hair is a fine mix: the share that has turned
    // varies round the grey along the strands, never all or nothing.
    float turned = grey + 0.5 * (2.0 * whiteStrands() - 1.0) * min(grey, 1.0 - grey);
    h = mix(mix(vec3(luma(h)), h, 1.0 - 0.3 * grey), clamp(L * uAgeTint, 0.0, 1.0), turned);
  }
  if (uHairShine + uHairSmooth + uHairTex + uHairEnrich + uHairOil > 0.0) h = mix(h, hairCare(h, h0, ls, lm), whole);
  if (uHairAmt > 0.0) {
    // Amount: brightness moves toward the new shade sooner than colour does (on a square-root
    // scale), so a part-strength shade reads as a softer version of itself, not a muddier one.
    float a = clamp(uHairAmt, 0.0, 1.0);
    vec3 yo = toYcc(h), yd = toYcc(dyeHair(h, calm, whole));
    float y = mix(sqrt(max(yo.x, 0.0)), sqrt(yd.x), sqrt(a));
    y *= y;
    h = clipColor(fromYcc(vec3(y, mix(yo.yz - 0.5, (yd.yz - 0.5) * y / max(yd.x, 0.01), a) + 0.5)));
  }
  outColor = vec4(clamp(col + share * (h - h0), 0.0, 1.0), 1.0);
}`;

// Lens blur with a shaped aperture (circle, hexagon, triangle, heart, star). As in AirBrush's
// defocus tables, colour is raised to a power first so bright points dominate and bloom into
// the aperture's shape, then the power is undone.
const BOKEH = `
uniform sampler2D uSrc;
uniform vec2 uTexel;
uniform float uRadius, uShape, uGamma;
const int N = 72;
// Radius of a regular n-sided polygon (a corner at the top) at angle a; 1 at the corners.
float polyR(float a, float n) {
  float s = 6.2831853 / n;
  return cos(3.14159265 / n) / cos(mod(a + 1.5707963, s) - 3.14159265 / n);
}
void main() {
  vec4 acc = vec4(0.0);
  float ws = 0.0;
  for (int i = 0; i < N; i++) {
    float fi = float(i) + 0.5;
    float r = sqrt(fi / float(N));
    float a = fi * 2.39996323;
    vec2 q = vec2(cos(a), sin(a)) * r;
    float w = 1.0;
    if (uShape > 1.5 && uShape < 2.5) q *= polyR(a, 6.0);
    else if (uShape > 2.5 && uShape < 3.5) q *= polyR(a, 3.0);
    else if (uShape > 3.5 && uShape < 4.5) {
      vec2 h = vec2(q.x, -q.y) * 1.3 + vec2(0.0, 0.18);   // uv runs down, the heart's lobes go up
      float k = h.x * h.x + h.y * h.y - 1.0;
      w = step(k * k * k - h.x * h.x * h.y * h.y * h.y, 0.0);
    } else if (uShape > 4.5) {
      w = step(r, 0.42 + 0.58 * pow(abs(cos(2.5 * (a + 1.5707963))), 2.2));
    }
    vec4 s = texture(uSrc, vUv + q * uRadius * uTexel);
    vec3 c = s.a > 0.001 ? s.rgb / s.a : vec3(0.0);
    acc += vec4(pow(c, vec3(uGamma)) * s.a, s.a) * w;
    ws += w;
  }
  acc /= max(ws, 1.0);
  outColor = vec4(pow(acc.rgb / max(acc.a, 1e-4), vec3(1.0 / uGamma)) * acc.a, acc.a);
}`;

// Noise reduction: luma averaged only with similar neighbours (bilateral), colour noise over a
// wider window.
const DENOISE = `
uniform sampler2D uSrc;
uniform vec2 uTexel;
uniform float uAmt;
void main() {
  vec3 y0 = toYcc(texture(uSrc, vUv).rgb);
  float sl = 0.025 + 0.06 * uAmt;
  float ys = y0.x, ws = 1.0, wc = 1.0;
  vec2 cs = y0.yz;
  for (int j = -3; j <= 3; j++) {
    for (int i = -3; i <= 3; i++) {
      if (i == 0 && j == 0) continue;
      vec3 y = toYcc(texture(uSrc, vUv + vec2(float(i), float(j)) * uTexel).rgb);
      float d2 = float(i * i + j * j), dl = y.x - y0.x;
      float wl = exp(-dl * dl / (2.0 * sl * sl) - d2 / 8.0);
      ys += y.x * wl;
      ws += wl;
      float w2 = exp(-dl * dl / 0.03 - d2 / 18.0);
      cs += y.yz * w2;
      wc += w2;
    }
  }
  outColor = vec4(fromYcc(vec3(mix(y0.x, ys / ws, uAmt * 0.85), mix(y0.yz, cs / wc, min(1.0, uAmt * 1.4)))), 1.0);
}`;

// Four painted masks (their alpha) packed into one texture's channels.
const PACK = `
uniform sampler2D uA, uB, uC, uD;
void main() { outColor = vec4(texture(uA, vUv).a, texture(uB, vUv).a, texture(uC, vUv).a, texture(uD, vUv).a); }`;

// Cut-out edge: grown (max) or shrunk (min) by uGrow texels.
const EDGE = `
uniform sampler2D uSrc;
uniform vec2 uTexel;
uniform float uGrow;
void main() {
  float m = texture(uSrc, vUv).a;
  float r = abs(uGrow);
  for (int i = 0; i < 16; i++) {
    float a = float(i) * 0.3927;
    for (int j = 1; j <= 2; j++) {
      float v = texture(uSrc, vUv + vec2(cos(a), sin(a)) * r * float(j) * 0.5 * uTexel).a;
      m = uGrow > 0.0 ? max(m, v) : min(m, v);
    }
  }
  outColor = vec4(1.0, 1.0, 1.0, m);
}`;

// Hair › Care: which way the strands run. Each pixel's brightness gradient as a doubled angle (so
// opposite gradients agree), four samples a pixel, weighted by how strong it is. Blurred afterwards,
// the field's length says how clearly the hair runs one way there; frizz follows the main flow.
const FLOW = `
uniform sampler2D uSrc;
uniform vec2 uTexel;    // one photo pixel
void main() {
  vec2 acc = vec2(0.0);
  for (int i = 0; i < 4; i++) {
    vec2 q = vUv + vec2(i == 0 || i == 2 ? -0.5 : 0.5, i < 2 ? -0.5 : 0.5) * uTexel;
    float gx = luma(texture(uSrc, q + vec2(uTexel.x * 1.5, 0.0)).rgb) - luma(texture(uSrc, q - vec2(uTexel.x * 1.5, 0.0)).rgb);
    float gy = luma(texture(uSrc, q + vec2(0.0, uTexel.y * 1.5)).rgb) - luma(texture(uSrc, q - vec2(0.0, uTexel.y * 1.5)).rgb);
    float e = gx * gx + gy * gy;
    if (e > 1e-7) acc += vec2(gx * gx - gy * gy, 2.0 * gx * gy) / e * smoothstep(0.0002, 0.003, e);
  }
  outColor = vec4(0.5 + 0.125 * acc, 0.5, 1.0);
}`;

// Push-pull fill, upward step: holes in the finer level take the coarser level's colour.
const UPFILL = `
uniform sampler2D uFine, uCoarse;
void main() {
  vec4 f = texture(uFine, vUv), c = texture(uCoarse, vUv);
  outColor = vec4(f.rgb + (c.a > 1e-4 ? c.rgb / c.a : vec3(0.0)) * (1.0 - f.a), 1.0);
}`;

// Retouch pass: skin, face and body work, each a masked blend over the photo.
const RETOUCH = `
uniform sampler2D uSrc, uSmooth, uBlurS, uBlurM, uFeat, uFeat2, uStrict, uPaintA, uPaintB;
uniform sampler2D uCreaseMap, uZoneMap, uFillMap, uSculptMap, uSeg, uPerson;
uniform vec2 uTexel, uImgSize;
uniform float uGate, uSkinY, uSegOn;
uniform vec2 uSkinMean;
uniform mat2 uSkinInv;
uniform float uSmoothAmt, uEvenAmt, uDepth, uStubble, uDeglare;
uniform vec4 uCreaseAmt, uConcealAmt, uFillAmt, uSculptW, uDetail;
uniform float uCreaseBrush, uConcealBrush;
uniform float uMatteAmt, uMatteAuto, uMatteHair;
uniform float uTexAmt, uTexSize, uTexOnSmooth;
uniform float uEyeWhite, uEyeIris, uDarkCircle, uRedEye, uIrisSize;
uniform vec4 uEyes[8];      // iris centre (px), iris radius, eye width
uniform int uEyeCount;
uniform float uTeeth, uStains, uLipPlump;
uniform vec4 uMouths[4];    // mouth centre (px), mouth axis scaled to the mouth's width
uniform int uMouthCount;
uniform float uToneAmt, uRedness, uGlowType, uGlowAmt, uMuscle;
// Age (each 0–1, older): crepey texture, eye bags, dark circles, hollows, the folds beside the mouth
// (with Sagging), spots, uneven tone, the eyes and the teeth. Signed, below 0 younger: lines (drawn
// and the photo's own creases deepened, or crease shadows lifted), skin (duller or fresher), lips
// (paler or redder) and brows (faded or darker). Shapes come from the age map (facemaps.js); uAgeStep is a small distance on the
// face (px) that sets their scale. Younger's other parts are the retouch tools' own effects.
uniform sampler2D uAgeMap;
uniform float uAgeLines, uAgeTexture, uAgeBags, uAgeCircles, uAgeHollows, uAgeFolds, uAgeSpots, uAgeTone, uAgeEyes, uAgeTeeth;
uniform float uAgeSkin, uAgeLipTone, uAgeBrows, uAgeStep;
float ageHash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
uniform vec3 uToneYcc;

vec3 lumScale(vec3 c, float l) { return c * (l / max(luma(c), 1e-3)); }
// One detail band with only its bright part above thr turned down to f (by k), for Matte.
vec3 shineBand(vec3 d, float thr, float f, float k) { return d * mix(1.0, f, k * smoothstep(0.8 * thr, 1.2 * thr, luma(d))); }

void main() {
  vec2 px = vUv * uImgSize;
  vec4 f1 = texture(uFeat, vUv);     // r eye openings, g inner mouth, b lips, a irises
  vec4 f2 = texture(uFeat2, vUv);    // r under-eyes, g brows, b cheeks, a face skin
  vec3 src = texture(uSrc, vUv).rgb;

  // Iris size: inside each eye opening the photo is shown scaled about the iris centre.
  if (uIrisSize != 0.0 && f1.r > 0.0) {
    float s = 1.0 + uIrisSize * 0.22;
    for (int i = 0; i < 8; i++) {
      if (i >= uEyeCount) break;
      vec4 e = uEyes[i];
      vec2 d = px - e.xy;
      float r = length(d);
      if (r > e.z * 2.0) continue;
      src = mix(src, texture(uSrc, (e.xy + d / s) / uImgSize).rgb, f1.r * (1.0 - smoothstep(e.z * 1.25, e.z * 1.9, r)));
    }
  }
  vec3 col = src;
  vec4 pa = texture(uPaintA, vUv);   // painted: r smooth, g wrinkles, b concealer, a texture
  vec4 pb = texture(uPaintB, vUv);   // painted: r matte (0.5 = automatic), g details, b teeth (0.5 = automatic)
  vec4 cr = texture(uCreaseMap, vUv), zn = texture(uZoneMap, vUv), fl = texture(uFillMap, vUv), sc = texture(uSculptMap, vUv);
  vec4 seg = texture(uSeg, vUv);     // r hair, g body skin, b face skin, a clothes
  float person = texture(uPerson, vUv).a;
  vec3 ycc = toYcc(src);

  // Skin likelihood from this person's own cheek colour (Mahalanobis distance in CbCr),
  // so the same logic works on every skin tone.
  float gate = 1.0;
  if (uGate > 0.5) {
    vec2 dv = ycc.yz - uSkinMean;
    gate = 1.0 - smoothstep(2.4, 4.2, sqrt(max(dot(dv, uSkinInv * dv), 0.0)));
    gate *= smoothstep(0.04, 0.12, ycc.x);
  }
  float face = f2.a * gate;
  float strict = texture(uStrict, vUv).r * gate;
  vec3 bS = texture(uBlurS, vUv).rgb, bM = texture(uBlurM, vUv).rgb;
  vec3 bL = textureLod(uBlurM, vUv, 2.5).rgb;
  vec3 b5 = (src + texture(uSrc, vUv + vec2(uTexel.x, 0.0)).rgb + texture(uSrc, vUv - vec2(uTexel.x, 0.0)).rgb +
             texture(uSrc, vUv + vec2(0.0, uTexel.y)).rgb + texture(uSrc, vUv - vec2(0.0, uTexel.y)).rgb) * 0.2;
  // The local mean moved to the wider mean: evens tone between blemish and patch size, keeps texture.
  vec3 even = col + (bM - bS);
  float body = clamp(person - f2.a, 0.0, 1.0);
  float skinAll = uSegOn > 0.5 ? max(face, clamp(seg.g + seg.b, 0.0, 1.0) * mix(1.0, gate, 0.6)) : max(face, body * gate * 0.7);

  // Smoothing happens only where it was painted; stubble keeps its texture.
  float painted = pa.r * gate;
  if (uStubble > 0.0) painted *= 1.0 - uStubble * 0.85 * zn.a * smoothstep(0.02, 0.09, uSkinY - luma(bS));
  if (uSmoothAmt > 0.0) {
    vec3 target = texture(uSmooth, vUv).rgb + (src - b5) * 0.45;   // keep the finest detail: pores
    col = mix(col, target, clamp(painted * uSmoothAmt, 0.0, 1.0));
  }
  if (uEvenAmt > 0.0) {
    vec3 a = toYcc(col), b = toYcc(bM);
    float k = clamp(painted * uEvenAmt, 0.0, 1.0);
    a.yz = mix(a.yz, b.yz, k * 0.85);
    a.x = mix(a.x, b.x, k * 0.3);
    col = fromYcc(a);
  }
  if (uDepth > 0.0) {
    // Light and shadow put back where smoothing flattened them (AirBrush's ShadowLight step).
    float k = clamp(painted * uDepth, 0.0, 1.0);
    col = lumScale(col, luma(col) + (luma(bS) - luma(bM)) * k * 0.9);
    col = lumScale(col, luma(col) * (1.0 + 0.18 * clamp(sc.g * 0.8 - sc.r - sc.b * 0.4, -1.0, 1.0) * k));
  }

  // Wrinkles: the shadow inside a crease is lifted toward its surroundings; texture stays.
  float kc = dot(cr, uCreaseAmt) * face + pa.g * uCreaseBrush * gate;
  if (kc > 0.0) {
    float d = luma(bS) - luma(col);
    col = mix(col, bS + (col - b5) * 0.55, clamp(kc * smoothstep(0.003, 0.03, d), 0.0, 1.0));
  }

  // Concealer: dark and light spots (dodge and burn), eye bags, tear troughs, and a brush.
  if (dot(uConcealAmt, vec4(1.0)) + uConcealBrush > 0.0) {
    float dl = luma(bM) - luma(bS);
    float w = (uConcealAmt.x * smoothstep(0.0, 0.02, dl) + uConcealAmt.y * smoothstep(0.0, 0.02, -dl)) * strict;
    w += (zn.r * uConcealAmt.z + pa.b * uConcealBrush) * gate;
    col = mix(col, even, clamp(w, 0.0, 1.0));
    float t = zn.g * uConcealAmt.w * gate;
    if (t > 0.0) {
      vec3 a = toYcc(col), b = toYcc(bM);
      a.x += max(b.x - luma(bS), 0.0) * 1.2 * t + 0.012 * t;
      a.yz = mix(a.yz, b.yz, clamp(t * 0.6, 0.0, 1.0));
      col = fromYcc(a);
    }
  }

  // Shine is bright detail at the scale of the bands of light on skin. As AirBrush's CleanShiny, the
  // skin splits into three detail bands and only bright detail standing out above a threshold (scaled
  // to the skin's own lightness) is turned down in each: the coarse bands to 15%, the finest to 60%.
  // Pores and every darker detail stay, and the shine's colour settles toward the skin around it.
  // Only skin lighter than the face's own usual skin counts, so skin beside the brows, eyes or hair
  // (bright only next to their darkness) is left alone.
  float mAdd = max(pb.r - 0.5, 0.0) * 2.0, mRem = max(0.5 - pb.r, 0.0) * 2.0;
  float matte = max(uMatteAuto * face * (1.0 - mRem), mAdd * gate) * uMatteAmt + uDeglare * face;
  matte = max(matte, max(uSculptW.x, uSculptW.y) * 0.4 * face);   // Sculpt takes shine down first
  if (matte > 0.0) {
    float k = clamp(matte, 0.0, 1.0) * smoothstep(uSkinY + 0.02, uSkinY + 0.14, luma(col));
    vec3 r = bM + shineBand(bS - bM, 0.035 + 0.03 * uSkinY, 0.15, k) + shineBand(b5 - bS, 0.02 + 0.02 * uSkinY, 0.15, k)
      + shineBand(col - b5, 0.012 + 0.012 * uSkinY, 0.6, k);
    vec3 a = toYcc(r);
    a.yz = mix(a.yz, toYcc(bM).yz, 0.4 * k * smoothstep(0.02, 0.1, luma(col) - luma(bM)));
    col = fromYcc(a);
  }
  if (uMatteHair > 0.0) {
    float hs = smoothstep(0.04, 0.22, luma(col) - luma(bM)) * seg.r * uSegOn;
    col = mix(col, bM + (col - b5) * 0.85, clamp(hs * uMatteHair, 0.0, 1.0));
  }

  // Texture: fine pore grain laid back over skin.
  float ta = max(pa.a, pa.r * uTexOnSmooth) * gate * uTexAmt;
  if (ta > 0.0) {
    float n = vnoise(px / uTexSize) * 0.6 + vnoise(px / (uTexSize * 0.45) + 17.0) * 0.4;
    col *= 1.0 + ((n - 0.5) * 0.22 + (hash(floor(px)) - 0.5) * 0.05) * ta;
  }

  // Details: sharpening by area (face, body, background) and by brush.
  float da = uDetail.x * f2.a + uDetail.y * body + uDetail.z * (1.0 - person) + uDetail.w * pb.g;
  if (da > 0.0) col += ((src - b5) * 1.3 + (src - bS) * 0.35) * da;

  // Eyes: whites and irises separately, red-eye, dark circles.
  if (uEyeWhite > 0.0) {
    float m = clamp(f1.r * (1.0 - smoothstep(0.2, 0.6, f1.a)) * uEyeWhite, 0.0, 1.0);
    // As AirBrush's BrightEye: red veins go to the white's own grey (their red level), spots darker
    // than the white around them lift toward it, and detail is only ever brightened, so no vein is
    // sharpened back in.
    // Both act only on the white itself: well inside the opening, in a bright, near-neutral
    // neighbourhood, never on the warm skin of the lids.
    float sclera = smoothstep(0.6, 0.95, f1.r) * (1.0 - smoothstep(0.035, 0.07, length(toYcc(bS).yz - 0.5))) * smoothstep(0.3, 0.5, luma(bS));
    vec3 e = col;
    e = mix(e, vec3(max(e.r, max(e.g, e.b))), 0.85 * sclera * smoothstep(0.015, 0.08, e.r - max(e.g, e.b)));
    e = max(e, mix(e, bM, 0.6 * sclera * smoothstep(0.0, 0.08, luma(bM) - luma(e))));
    e += max(src - b5, 0.0) * 1.2;
    e += (1.0 - e) * 0.12;
    vec3 a = toYcc(e);
    a.yz = mix(a.yz, vec2(0.5), smoothstep(0.35, 0.65, a.x) * 0.4);
    col = mix(col, fromYcc(a), m);
  }
  if (uEyeIris > 0.0) {
    float m = clamp(f1.a * f1.r * uEyeIris, 0.0, 1.0);
    col = mix(col, (col + (src - b5) * 2.4 + (src - bS) * 0.9) * 1.16 + 0.015, m);
  }
  if (uRedEye > 0.0) {
    float red = col.r - max(col.g, col.b);
    float m = clamp(smoothstep(0.1, 0.5, f1.a) * f1.r * uRedEye * smoothstep(0.05, 0.2, red), 0.0, 1.0);
    col = mix(col, vec3(max(col.g, col.b) * 0.85, col.g, col.b) * 0.8, m);
  }
  if (uDarkCircle > 0.0) {
    float m = clamp(f2.r * uDarkCircle * gate, 0.0, 1.0);
    vec3 a = toYcc(col), b = toYcc(bM);
    a.x = mix(a.x, max(a.x, b.x + 0.025), m);
    a.yz = mix(a.yz, b.yz, m * 0.7);
    col = mix(col, fromYcc(a), m);
    vec3 sm = texture(uSmooth, vUv).rgb;
    col = mix(col, sm + (col - sm) * 0.4, m * 0.5);
  }

  // Teeth: the automatic area (bright, not red, inside the mouth) plus brush and erase.
  if (uTeeth + uStains > 0.0) {
    float tAdd = max(pb.b - 0.5, 0.0) * 2.0, tRem = max(0.5 - pb.b, 0.0) * 2.0;
    vec3 a = toYcc(col);
    float bright = smoothstep(0.2, 0.42, a.x);
    float mt = max(f1.g * bright * (1.0 - smoothstep(0.56, 0.62, a.z)) * (1.0 - tRem), tAdd * mix(1.0, bright, 0.5));
    if (uStains > 0.0) {
      float w = mt * uStains;
      a.yz = mix(a.yz, vec2(0.5, 0.497), clamp(w * smoothstep(0.008, 0.05, length(a.yz - 0.5)), 0.0, 1.0));
      a.x = mix(a.x, max(a.x, luma(bS) * 1.03), clamp(w * 0.7, 0.0, 1.0));
    }
    if (uTeeth > 0.0) {
      float m = clamp(mt * uTeeth, 0.0, 1.0);
      a.yz = mix(a.yz, vec2(0.505, 0.497), m * 0.85);
      a.x += (1.0 - a.x) * 0.2 * m;
    }
    col = fromYcc(a);
  }

  // Skin tone, redness and Glow Up, over face and body skin.
  if (uToneAmt + uRedness + uGlowAmt > 0.0) {
    vec3 a = toYcc(col);
    float w = uToneAmt * skinAll;
    a.x += (uToneYcc.x - uSkinY) * 0.55 * w;
    a.yz += (uToneYcc.yz - uSkinMean) * 0.9 * w;
    float rw = uRedness * clamp(zn.b + skinAll * 0.5, 0.0, 1.0) * gate;
    float excess = max(a.z - uSkinMean.y - 0.005, 0.0);
    a.z -= excess * rw * 0.9;
    a.y += excess * rw * 0.12;
    float g = uGlowAmt * skinAll;
    if (uGlowType > 0.5 && uGlowType < 1.5) {             // tan
      a.x *= 1.0 - 0.15 * g;
      a.y -= 0.03 * g;
      a.z += 0.022 * g;
    } else if (uGlowType > 1.5 && uGlowType < 2.5) {      // sun-kissed: warmer overall
      a.y -= 0.014 * g;
      a.z += 0.012 * g;
    }
    col = fromYcc(a);
    if (uGlowType > 1.5 && uGlowType < 2.5) {             // … and flushed cheeks and nose
      float flush = clamp(f2.b * 1.2 + sc.g * 0.5, 0.0, 1.0) * face * uGlowAmt;
      col = mix(col, softLight(clamp(col, 0.0, 1.0), vec3(0.8, 0.52, 0.4)), clamp(flush * 0.6, 0.0, 1.0));
    } else if (uGlowType > 2.5) {                         // glass skin: sheen on the high points, no blur
      float sheen = clamp(sc.g * 1.3 + fl.b * 0.3, 0.0, 1.0) * face * uGlowAmt;
      col = screen(clamp(col, 0.0, 1.0), vec3(0.2, 0.19, 0.18) * sheen) * (1.0 + 0.05 * uGlowAmt * face);
      vec3 c2 = toYcc(col);
      c2.yz = mix(c2.yz, toYcc(bM).yz, 0.3 * uGlowAmt * face);
      col = fromYcc(c2);
    }
  }

  // Fillers: hollows lifted with light, not moved.
  float kf = dot(fl, uFillAmt) * f2.a * gate;
  if (kf > 0.0) col += (max(luma(bL) - luma(bM), 0.0) * 1.6 + 0.03) * kf * (0.6 + 0.4 * col);
  if (uLipPlump > 0.0 && f1.b > 0.0) {
    for (int i = 0; i < 4; i++) {
      if (i >= uMouthCount) break;
      vec4 m = uMouths[i];
      float mw = length(m.zw);
      vec2 ax = m.zw / mw, d = px - m.xy;
      float dx = dot(d, ax) / mw, dy = dot(d, vec2(-ax.y, ax.x)) / mw;
      float w = f1.b * smoothstep(0.02, 0.1, dy) * (1.0 - smoothstep(0.12, 0.24, dy)) * (1.0 - smoothstep(0.05, 0.3, abs(dx)));
      col = screen(clamp(col, 0.0, 1.0), vec3(0.17) * w * uLipPlump);
    }
  }

  // Sculpt: shading maps darken (contour) or lift (highlight) brightness on skin only; the far
  // side of a turned face gets more contour (done when the maps are drawn).
  if (dot(uSculptW, vec4(1.0)) > 0.0) {
    // Like AirBrush's contour chain, skin colour is evened first (shine was taken down above).
    vec3 ev = toYcc(col);
    ev.yz = mix(ev.yz, toYcc(bM).yz, 0.25 * max(uSculptW.x, uSculptW.y) * face);
    col = fromYcc(ev);
    float sh = clamp(sc.g * uSculptW.y - (sc.r * uSculptW.x + sc.b * uSculptW.z + sc.a * uSculptW.w), -1.0, 1.0);
    float area = gate * (uSegOn > 0.5 ? clamp(seg.g + seg.b, 0.0, 1.0) : max(person, f2.a));
    vec3 a = toYcc(col);
    if (sh < 0.0) {
      a.x *= 1.0 + 0.3 * sh;
      a.yz = 0.5 + (a.yz - 0.5) * (1.0 + 0.12 * sh);
    } else {
      a.x += (1.0 - a.x) * 0.2 * sh;
      a.yz = 0.5 + (a.yz - 0.5) * (1.0 - 0.1 * sh);
    }
    col = mix(col, fromYcc(a), area);
  }

  // Muscle definition: the body skin's large light and shadow shapes are deepened (not its
  // fine texture), so arms, shoulders and stomach read as more defined.
  if (uMuscle > 0.0) {
    float area = (uSegOn > 0.5 ? seg.g : body * gate) * uMuscle;
    float band = luma(bM) - luma(bL);
    col = lumScale(col, luma(col) * (1.0 + band * 2.4 * area));
    col *= 1.0 - 0.12 * area * smoothstep(0.0, 0.08, -band);
  }
  float ageOlder = uAgeTexture + uAgeBags + uAgeCircles + uAgeHollows + uAgeFolds + uAgeSpots + uAgeTone + uAgeEyes + uAgeTeeth;
  if (ageOlder + abs(uAgeLines) + abs(uAgeSkin) + abs(uAgeLipTone) + abs(uAgeBrows) > 0.0) {
    // Age, under any makeup. Light and shade change by multiplying, never by adding white, so no skin
    // tone turns grey.
    vec4 ag = texture(uAgeMap, vUv);
    vec2 up = vec2(0.0, uAgeStep / uImgSize.y), across = vec2(uAgeStep / uImgSize.x, 0.0);
    // Lines come and go along their length (a smooth noise a few lines' widths across), never evenly.
    float vary = 0.25 + 1.1 * vnoise(px / max(uAgeStep * 1.6, 1.0));
    // The photo's own relief: fine (creases and pores, without the finest pixel noise) and middle
    // (folds), each below zero where the skin is darker than around it.
    float fine = luma(b5) - luma(bS), mid = luma(bS) - luma(bM);
    if (uAgeLines > 0.0) {
      // The creases this face already has deepen where lines form (an aged face without its own
      // texture looks too smooth: Tiddeman, Burt and Perrett 2001), then the drawn lines. The map is
      // coarser than the photo, so a drawn line is soft there; only its ridge (its curvature across
      // the line, a few pixels each way) is kept, a thin core however large the face. A crease's
      // shadow is warm, as shadow in skin is, with a faint lit edge below it.
      float k = uAgeLines * face, zone = clamp(cr.r + cr.g + cr.b + cr.a, 0.0, 1.0);
      col = lumScale(col, max(luma(col) + 1.6 * k * zone * min(fine + 0.002, 0.0), 0.0));
      vec2 hy = vec2(0.0, max(1.5, uAgeStep * 0.15) / uImgSize.y), hx = vec2(hy.y * uImgSize.y / uImgSize.x, 0.0);
      float ridge = max(2.0 * ag.r - texture(uAgeMap, vUv + hy).r - texture(uAgeMap, vUv - hy).r,
                        2.0 * ag.r - texture(uAgeMap, vUv + hx).r - texture(uAgeMap, vUv - hx).r);
      float core = clamp(2.2 * ridge, 0.0, 1.0) * smoothstep(0.1, 0.35, ag.r);
      col *= mix(vec3(1.0), vec3(0.8, 0.71, 0.68), clamp(0.85 * k * core * vary, 0.0, 1.0));
      col *= 1.0 - 0.1 * k * ag.r * vary;
      float above = texture(uAgeMap, vUv - up * 0.25).r;
      col *= 1.0 + 0.05 * k * max(above - ag.r, 0.0) * vary;
    } else if (uAgeLines < 0.0) {
      // Younger: each crease's shadow, at the width of an older face's lines, lifts toward the skin
      // round it where lines form and under the eyes (the Wrinkles tool's fill works at a finer
      // width). Only the shadow moves; colour and the finest texture stay, so skin is not smoothed.
      float dd = luma(bM) - luma(col);
      float k = -uAgeLines * clamp(cr.r + cr.g + cr.b + cr.a + 0.7 * f2.r, 0.0, 1.0) * face * smoothstep(0.004, 0.04, dd);
      col = lumScale(col, luma(col) + 0.85 * dd * clamp(k, 0.0, 1.0));
    }
    if (uAgeTexture > 0.0) {
      // Crepey skin: thinner skin shows its own fine texture more, in its shadows most, and most
      // round the eyes. A fine crepe is added too, for skin too smooth to show any: a network of
      // shallow creases, mostly across the face (the ridges of smooth noise), under 1% of the face's
      // height apart. Tiddeman et al. gave young faces older texture the same way.
      float k = uAgeTexture * face * (0.6 + 0.4 * clamp(f2.r + cr.g, 0.0, 1.0));
      col = lumScale(col, max(luma(col) + k * (1.2 * min(fine, 0.0) + 0.35 * max(fine, 0.0)), 0.0));
      vec2 q = px / max(uAgeStep * 0.22, 1.0);
      float crepe = pow(1.0 - abs(2.0 * vnoise(vec2(q.x * 0.6, q.y)) - 1.0), 4.0);
      col *= mix(vec3(1.0), vec3(0.9, 0.85, 0.84), clamp(0.4 * k * crepe, 0.0, 1.0));
    }
    if (uAgeFolds > 0.0) {
      // The folds from the nose to the mouth and on to the chin deepen as the cheeks drop: their own
      // shadow darkens, and a soft shadow follows the drawn fold, with light on the cheek above it.
      float k = uAgeFolds * face * cr.b;
      col = lumScale(col, max(luma(col) + 1.4 * k * min(mid + 0.003, 0.0), 0.0));
      float soft = 0.25 * (texture(uAgeMap, vUv + across).r + texture(uAgeMap, vUv - across).r +
                           texture(uAgeMap, vUv + up * 0.6).r + texture(uAgeMap, vUv - up * 0.6).r);
      float above = 0.5 * (texture(uAgeMap, vUv - up * 1.3 + across * 0.5).r + texture(uAgeMap, vUv - up * 1.3 - across * 0.5).r);
      col *= mix(vec3(1.0), vec3(0.84, 0.78, 0.76), clamp(k * soft, 0.0, 1.0));
      col *= 1.0 + 0.1 * k * max(above - soft, 0.0);
    }
    if (uAgeBags > 0.0) {
      // A bag is a soft bulge under the eye: lit on top, a warm shadow along its lower edge.
      float k = uAgeBags * face, above = texture(uAgeMap, vUv - up).g;
      col *= 1.0 + 0.08 * k * ag.g;
      col *= mix(vec3(1.0), vec3(0.86, 0.8, 0.79), clamp(0.7 * k * smoothstep(0.0, 0.5, above - ag.g), 0.0, 1.0));
    }
    if (uAgeCircles > 0.0) {
      // Darker under the eyes: a little blue on fair skin, browner on dark skin.
      vec3 tint = mix(vec3(0.86, 0.84, 0.85), vec3(0.9, 0.85, 0.88), smoothstep(0.3, 0.6, uSkinY));
      col *= mix(vec3(1.0), tint, clamp(uAgeCircles * f2.r * face * 0.5, 0.0, 1.0));
    }
    if (uAgeHollows > 0.0) {
      // Hollows deepen as fat is lost: temples, under the cheekbones, the upper eye sockets, and the
      // groove from the inner corner of the eye down the cheek (the tear trough).
      col *= mix(vec3(1.0), vec3(0.9, 0.88, 0.88), clamp(uAgeHollows * ag.a * face * 0.6, 0.0, 1.0));
      col *= mix(vec3(1.0), vec3(0.88, 0.83, 0.83), clamp(uAgeHollows * zn.g * face * 0.5, 0.0, 1.0));
    }
    if (uAgeSpots > 0.0 && ag.b > 0.01) {
      vec2 p = px / max(uAgeStep * 0.9, 1.0), ce = floor(p);
      if (ageHash(ce) > 0.78) {
        vec2 c = ce + 0.25 + 0.5 * vec2(ageHash(ce + 3.1), ageHash(ce + 7.7));
        float rad = 0.12 + 0.22 * ageHash(ce + 1.3), m = 1.0 - smoothstep(rad * 0.55, rad, length(p - c));
        col *= mix(vec3(1.0), vec3(0.86, 0.76, 0.66), clamp(m * ag.b * uAgeSpots * face * (0.3 + 0.5 * ageHash(ce + 5.5)), 0.0, 1.0));
      }
    }
    if (uAgeTone > 0.0) {
      // Uneven tone: soft brown patches and redder blotches, most where the sun falls (faces whose
      // colour is less even look older: Fink, Grammer and Matts 2006).
      vec2 q = px / max(uAgeStep * 3.0, 1.0);
      float k = uAgeTone * face * (0.45 + 0.55 * clamp(ag.b * 1.5, 0.0, 1.0));
      float brown = smoothstep(0.5, 0.85, 0.65 * vnoise(q) + 0.35 * vnoise(q * 2.3 + 17.0));
      float red = smoothstep(0.55, 0.9, vnoise(q * 1.7 + 41.0)) * zn.b;
      col *= mix(vec3(1.0), vec3(0.93, 0.87, 0.8), clamp(0.8 * k * brown, 0.0, 1.0));
      col *= mix(vec3(1.0), vec3(1.0, 0.92, 0.92), clamp(0.7 * k * red, 0.0, 1.0));
    }
    if (uAgeSkin != 0.0) {
      // Older skin is duller, a little yellower and darker; younger, a little fresher.
      vec3 y = toYcc(col);
      float k = abs(uAgeSkin) * face;
      if (uAgeSkin > 0.0) {
        y.yz = mix(y.yz, vec2(0.5), 0.14 * k);
        y.y -= 0.012 * k;
        y.x *= 1.0 - 0.025 * k;
      } else {
        y.yz = 0.5 + (y.yz - 0.5) * (1.0 + 0.08 * k);
        y.x *= 1.0 + 0.02 * k;
      }
      col = fromYcc(y);
    }
    if (uAgeLipTone != 0.0 && f1.b > 0.0) {
      // Lips: older their red fades toward the skin's colour, younger it deepens. Less contrast
      // between the features and the skin looks older (Porcheron, Mauger and Russell 2013).
      vec3 y = toYcc(col);
      float k = abs(uAgeLipTone) * f1.b;
      y.yz = uAgeLipTone > 0.0 ? mix(y.yz, uSkinMean, 0.45 * k) : uSkinMean + (y.yz - uSkinMean) * (1.0 + 0.35 * k);
      col = fromYcc(y);
    }
    if (uAgeBrows != 0.0 && f2.g > 0.0) {
      // Brows: their contrast with the skin falls the most with age (the same study): older, the hairs
      // fade toward the skin and lose colour; younger, they darken. Only what is darker than the skin
      // round the brow changes.
      float ref = max(luma(bL), 0.5 * (luma(bL) + uSkinY)), l = luma(col);
      float k = abs(uAgeBrows) * f2.g * smoothstep(0.01, 0.07, ref - l);
      if (uAgeBrows > 0.0) {
        vec3 y = toYcc(col);
        y.x = mix(y.x, ref, 0.5 * k);
        y.yz = mix(y.yz, vec2(0.5), 0.45 * k);
        col = fromYcc(y);
      } else col = lumScale(col, max(l - (ref - l) * 0.4 * k, 0.0));
    }
    if (uAgeEyes > 0.0) {
      // Eyes: the whites duller and nearer the skin's colour (the eyes' colour contrast falls with age
      // too), and a pale ring at the edge of the iris (arcus senilis).
      col *= mix(vec3(1.0), vec3(0.96, 0.93, 0.86), clamp(uAgeEyes * f1.r * (1.0 - f1.a) * 0.65, 0.0, 1.0));
      for (int i = 0; i < 8; i++) {
        if (i >= uEyeCount) break;
        float r = length(px - uEyes[i].xy) / max(uEyes[i].z, 1.0);
        float ring = smoothstep(0.76, 0.9, r) * (1.0 - smoothstep(0.92, 1.04, r)) * f1.r;
        col = mix(col, col * 0.7 + 0.2, clamp(0.4 * uAgeEyes * ring, 0.0, 1.0));
      }
    }
    if (uAgeTeeth > 0.0) {
      // Teeth darken and yellow with age (the automatic teeth area, as Teeth uses).
      vec3 y = toYcc(col);
      float k = clamp(uAgeTeeth * f1.g * smoothstep(0.2, 0.42, y.x) * (1.0 - smoothstep(0.56, 0.62, y.z)), 0.0, 1.0);
      y.x *= 1.0 - 0.12 * k;
      y.y -= 0.03 * k;
      y.z += 0.014 * k;
      col = fromYcc(y);
    }
  }

  outColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}`;

// Composite pass: makeup, hair care and colour, and the background, over the retouched photo.
// Background: the new background for a pixel whose old one is under (blurred, swapped, brightened,
// shadowed or greyed), shared by the composite and Background Freeze's layer.
const NEW_BACKGROUND = `
uniform sampler2D uBG, uBgImage, uPersonSoft;
uniform float uBgBlur, uBgMono, uBgSwap, uBgBright, uBgShadow, uBlend;
uniform vec2 uShadowOff;
uniform vec3 uBgColA, uBgColB;
bool hasNewBackground() {
  return uBgSwap > 0.5 || uBgBlur > 0.0 || uBgBright != 0.0 || uBgShadow > 0.0 || uBlend > 0.0 || uBgMono > 0.0;
}
vec3 newBackground(vec3 under) {
  vec3 bgc = under;
  if (uBgBlur > 0.0) {
    vec4 bg = texture(uBG, vUv);
    bgc = bg.a > 0.002 ? bg.rgb / bg.a : under;
    if (uBgSwap > 0.5 && uBgSwap < 1.5) bgc = mix(uBgColA, uBgColB, vUv.y);
  } else if (uBgSwap > 0.5) {
    bgc = uBgSwap < 1.5 ? mix(uBgColA, uBgColB, vUv.y) : texture(uBgImage, vUv).rgb;
  }
  bgc *= exp2(uBgBright * 0.9);
  // Shadow: the blurred cut-out, offset, darkens the background behind the subject.
  if (uBgShadow > 0.0) bgc *= 1.0 - uBgShadow * 0.7 * texture(uPersonSoft, vUv - uShadowOff).a;
  if (uBgMono > 0.0) bgc = mix(bgc, vec3(luma(bgc)), uBgMono);
  return bgc;
}`;

const COMPOSITE = `
uniform sampler2D uSrc, uFeat, uFeat2, uFeat3, uFeat4, uPerson, uBgLow, uSubjLow, uBgPlate;
uniform vec2 uTexel, uImgSize;
uniform float uGate, uSkinY;
uniform vec2 uSkinMean;
uniform mat2 uSkinInv;
uniform float uIrisAmt, uLipAmt, uLipFinish, uBlushAmt, uBrowAmt;
uniform vec3 uIrisColor, uLipColor, uBlushColor, uBrowColor;
uniform float uShadowAmt, uShadowShimmer, uLinerAmt, uLashAmt, uFreckleAmt, uContourAmt, uHighlightAmt;
uniform vec3 uShadowColor, uLinerColor;
uniform vec4 uMouths[4];
uniform int uMouthCount;
uniform vec4 uLipLum;       // each mouth's average lip lightness, as photographed
// Makeup › Fine-tune: per face, its centre and across axis (uFaces), and how far (px) each part's
// makeup has been moved: lips (uTuneA.xy), brows, eyes and blush (image-left xy, image-right zw).
uniform vec4 uFaces[4], uTuneA[4], uTuneB[4], uTuneC[4], uTuneD[4];
uniform int uTuneCount;

${NEW_BACKGROUND}
void main() {
  vec3 src = texture(uSrc, vUv).rgb;
  vec3 col = src;
  vec4 f1 = texture(uFeat, vUv);   // r: eye openings, g: inner mouth, b: lips, a: irises
  vec4 f2 = texture(uFeat2, vUv);  // r: under-eyes, g: brows, b: cheeks, a: face skin
  vec4 f3 = texture(uFeat3, vUv);  // r: eyeshadow, g: eyeliner, b: lashes, a: freckles
  vec4 f4 = texture(uFeat4, vUv);  // r: contour, g: highlight
  // Fine-tuned parts read their masks from where the dot moved them (nearest face, its side).
  float lipM = f1.b, browM = f2.g, cheekM = f2.b;
  vec3 eyeM = f3.rgb;
  if (uTuneCount > 0) {
    int best = 0;
    float bd = 1e9;
    for (int i = 0; i < 4; i++) {
      if (i >= uTuneCount) break;
      float d = length(vUv * uImgSize - uFaces[i].xy);
      if (d < bd) { bd = d; best = i; }
    }
    vec4 fc = uFaces[best];
    bool left = dot(vUv * uImgSize - fc.xy, fc.zw) < 0.0;
    vec2 to = 1.0 / uImgSize;
    vec4 a = uTuneA[best], b = uTuneB[best], c = uTuneC[best], dd = uTuneD[best];
    lipM = texture(uFeat, vUv - a.xy * to).b;
    browM = texture(uFeat2, vUv - (left ? b.xy : b.zw) * to).g;
    cheekM = texture(uFeat2, vUv - (left ? dd.xy : dd.zw) * to).b;
    eyeM = texture(uFeat3, vUv - (left ? c.xy : c.zw) * to).rgb;
  }
  vec3 ycc = toYcc(src);
  vec2 px = floor(vUv / uTexel);
  float gate = 1.0;
  if (uGate > 0.5) {
    vec2 dv = ycc.yz - uSkinMean;
    gate = 1.0 - smoothstep(2.4, 4.2, sqrt(max(dot(dv, uSkinInv * dv), 0.0)));
    gate *= smoothstep(0.04, 0.12, ycc.x);
  }
  float face = f2.a * gate;

  if (uIrisAmt > 0.0) {
    float l = lum(col);
    float m = f1.a * uIrisAmt * smoothstep(0.05, 0.14, l) * (1.0 - smoothstep(0.72, 0.92, l));
    col = mix(col, setLum(uIrisColor, l * 1.05 + 0.02), clamp(m, 0.0, 1.0));
  }

  // Makeup, in the order it would go on.
  if (uFreckleAmt > 0.0) col = mix(col, col * vec3(0.76, 0.64, 0.56), clamp(f3.a * uFreckleAmt * gate, 0.0, 1.0));
  if (uContourAmt > 0.0) col = mix(col, col * vec3(0.8, 0.73, 0.69), clamp(f4.r * face * uContourAmt * 0.85, 0.0, 1.0));
  if (uHighlightAmt > 0.0) col = mix(col, screen(col, vec3(0.34, 0.3, 0.24)), clamp(f4.g * face * uHighlightAmt * 0.75, 0.0, 1.0));
  if (uBlushAmt > 0.0) col = mix(col, softLight(clamp(col, 0.0, 1.0), uBlushColor), clamp(cheekM * uBlushAmt * gate, 0.0, 1.0));
  if (uShadowAmt > 0.0) {
    vec3 tinted = mix(softLight(clamp(col, 0.0, 1.0), uShadowColor), col * uShadowColor * 1.2, 0.45);
    tinted += uShadowShimmer * (0.06 * smoothstep(0.3, 0.8, luma(col)) + 0.55 * step(0.986, hash(floor(px / 1.5))));
    col = mix(col, tinted, clamp(eyeM.r * uShadowAmt, 0.0, 1.0));
  }
  if (uLinerAmt > 0.0) col = mix(col, uLinerColor * (0.45 + 0.55 * luma(col)), clamp(eyeM.g * uLinerAmt, 0.0, 1.0));
  if (uLashAmt > 0.0) col = mix(col, vec3(0.035, 0.028, 0.032), clamp(eyeM.b * uLashAmt, 0.0, 1.0));
  if (uBrowAmt > 0.0) col = mix(col, col * mix(vec3(1.0), uBrowColor * 1.7, 0.75), clamp(browM * uBrowAmt, 0.0, 1.0));
  if (uLipAmt > 0.0 && lipM > 0.0) {
    // This pixel relative to the nearest mouth, in mouth widths (x along the mouth, y down).
    vec2 ml = vec2(9.0);
    float lipMean = 0.0;
    for (int i = 0; i < 4; i++) {
      if (i >= uMouthCount) break;
      vec4 m = uMouths[i];
      float mw = length(m.zw);
      vec2 ax = m.zw / mw, d = (vUv * uImgSize - m.xy) / mw;
      vec2 q = vec2(dot(d, ax), dot(d, vec2(-ax.y, ax.x)));
      if (length(q) < length(ml)) {
        ml = q;
        lipMean = dot(uLipLum, vec4(equal(ivec4(i), ivec4(0, 1, 2, 3))));
      }
    }
    // Lipstick taken down first, as AirBrush's remover does: lips darker than the new shade are lifted
    // toward it (no further than natural lips, about 0.8 of the skin's lightness), keeping their own
    // light and shade, so a light shade over a dark lipstick reads as itself.
    float target = clamp(lum(uLipColor) * 1.1, lipMean, max(lipMean, 0.8 * uSkinY));
    float l = lum(col) * (lipMean > 0.02 ? mix(1.0, target / lipMean, 0.8) : 1.0);
    vec3 lip = setLum(uLipColor, mix(l, lum(uLipColor), 0.4));
    float hl = smoothstep(0.5, 0.85, l);
    float amt = lipM * uLipAmt;
    int fin = int(uLipFinish + 0.5);
    if (fin == 0) lip = mix(lip, setLum(uLipColor, lum(uLipColor) * 0.96), 0.45);                    // matte
    else if (fin == 1) lip += hl * 0.12;                                                             // satin
    else if (fin == 2) lip += hl * 0.32 + pow(hl, 3.0) * 0.3;                                        // gloss
    else if (fin == 3) lip += hl * 0.12 + 0.5 * step(0.976, hash(floor(px / 1.2)));                  // shimmer
    else if (fin == 4) {                                                                             // highlight
      float stripe = smoothstep(0.03, 0.1, ml.y) * (1.0 - smoothstep(0.12, 0.22, ml.y)) * (1.0 - smoothstep(0.08, 0.32, abs(ml.x)));
      lip += hl * 0.1 + stripe * 0.35;
    } else if (fin == 5) lip = mix(lip, screen(lip, vec3(0.92, 0.88, 1.0) * 0.32), smoothstep(0.3, 0.8, l));  // pearl
    else if (fin == 6) lip = lip * (0.72 + 0.55 * smoothstep(0.25, 0.8, l)) + uLipColor * hl * 0.45 + pow(hl, 4.0) * 0.25; // metallic
    else if (fin == 7) {                                                                             // gradient (bitten)
      amt *= 1.0 - smoothstep(0.12, 0.42, length(ml * vec2(0.9, 1.6)));
      lip += hl * 0.1;
    } else lip += hl * 0.22 + 0.9 * step(0.955, hash(floor(px / 1.6))) * (0.5 + hl);              // diamond
    col = mix(col, lip, clamp(amt, 0.0, 1.0));
  }

  float person = texture(uPerson, vUv).a;
  if (hasNewBackground()) {
    // What lies behind this pixel: the photo itself where it is clearly background, otherwise the
    // plate (the background filled in from around the subject). Only the background's share of each
    // pixel, 1 − person, is replaced, so strands of hair keep their own colour over the new
    // background instead of carrying a fringe of the old one.
    vec3 under = mix(texture(uBgPlate, vUv).rgb, col, 1.0 - smoothstep(0.05, 0.25, person));
    vec3 bgc = newBackground(under);
    if (uBlend > 0.0) {
      // Blend: the subject's colour moves 60% and its brightness 30% toward the background's,
      // judged on blurred copies of each so detail stays.
      vec4 sl = texture(uSubjLow, vUv), bl = texture(uBgLow, vUv);
      vec3 subj = sl.a > 0.01 ? sl.rgb / sl.a : col;
      vec3 env = uBgSwap > 0.5 && uBgSwap < 1.5 ? mix(uBgColA, uBgColB, vUv.y) : (bl.a > 0.01 ? bl.rgb / bl.a : bgc);
      vec3 d = toYcc(env * exp2(uBgBright * 0.9)) - toYcc(subj);
      vec3 a = toYcc(col);
      a.x += d.x * 0.3 * uBlend;
      a.yz += d.yz * 0.6 * uBlend;
      col = mix(col, fromYcc(a), person);
    }
    col += (1.0 - person) * (bgc - under);
  }

  outColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}`;

// Background Freeze's layer: the finished scene with the subject taken out: its area (the plate's
// alpha) filled from the plate and given the same background effects. Alpha says how clearly the
// photo there shows something over that filled-in background, judged on 3 × 3 averages so the
// background's own texture does not count, only what lies on it: strands the cut-out missed and
// the soft, blurred edge of hair.
const FREEZEBG = `
uniform sampler2D uSrc, uFreezePlate;
uniform vec2 uTexel;
${NEW_BACKGROUND}
void main() {
  vec4 fp = texture(uFreezePlate, vUv);
  vec3 col = texture(uSrc, vUv).rgb;
  vec3 bgc = hasNewBackground() ? newBackground(fp.rgb) : fp.rgb;
  vec3 d = col - bgc;
  if (!hasNewBackground()) {
    d = vec3(0.0);
    for (int j = -1; j <= 1; j++) {
      for (int i = -1; i <= 1; i++) {
        vec2 o = vec2(float(i), float(j)) * 2.0 * uTexel;
        d += texture(uSrc, vUv + o).rgb - texture(uFreezePlate, vUv + o).rgb;
      }
    }
    d /= 9.0;
  }
  outColor = vec4(mix(col, bgc, fp.a), fp.a * smoothstep(0.035, 0.1, length(d)));
}`;

// People added from other photos: up to five cut-outs placed over the scene.
const PEOPLE = `
uniform sampler2D uSrc, uP0, uP1, uP2, uP3, uP4;
uniform vec4 uPT[5];    // centre (uv), half width and half height (uv); a negative width flips
uniform int uPCount;
vec3 put(vec3 c, sampler2D s, vec4 t) {
  vec2 q = (vUv - t.xy) / (2.0 * t.zw) + 0.5;
  if (q.x < 0.0 || q.y < 0.0 || q.x > 1.0 || q.y > 1.0) return c;
  vec4 p = texture(s, q);
  return mix(c, p.rgb, p.a);
}
void main() {
  vec4 src = texture(uSrc, vUv);
  vec3 c = src.rgb;
  if (uPCount > 0) c = put(c, uP0, uPT[0]);
  if (uPCount > 1) c = put(c, uP1, uPT[1]);
  if (uPCount > 2) c = put(c, uP2, uPT[2]);
  if (uPCount > 3) c = put(c, uP3, uPT[3]);
  if (uPCount > 4) c = put(c, uP4, uPT[4]);
  outColor = vec4(c, src.a);
}`;

// Final pass: crop and lens geometry, reshape warp, local adjustments, relighting, effects,
// colour grade, text and an optional mask preview; draws to the screen or to an export target.
const FINAL = `
uniform sampler2D uImg, uOrig, uWarp, uLocal, uNormal, uPerson, uGlow, uOverlayTex, uBgLayer, uMatte, uText;
uniform vec4 uView;
uniform float uFlip, uCanvasH, uShowOrig, uOverlay, uOverlayInvert, uOverlayMode;
uniform vec2 uImgSize, uOutSize;
uniform vec3 uOverlayColor;
// A colour grade. Two are applied: the person's Adjust (with a Relight preset's tweaks), then the
// filter's, so a filter sits on top of the adjustments and skin can be shielded from it alone.
struct Grade {
  float exposure, brightness, contrast, highlights, shadows, saturation, vibrance, warmth, tint;
  float fade, curve, mono, split, vignette, grain, isoAmt, isoHue, isoWidth;
  vec3 shadowTint, highTint;
};
uniform Grade uA, uF;
uniform float uSharpen, uClarity, uAmbience, uDehaze;
uniform sampler2D uLut, uGlitterMask;
uniform float uLutAmt, uProtect, uGate, uHalation, uDust;
uniform vec2 uSkinMean;
uniform mat2 uSkinInv;
uniform float uRelight, uWrap, uFill, uRef, uSubjExp, uBgExp, uBgGrad, uSpill, uBgTintAmt, uRim, uSheen, uLift, uHaze;
uniform float uRays, uWater, uWaterScale, uCatch, uAspect, uSat;
uniform vec3 uL0, uL1, uC0, uC1, uFillCol, uWash0, uWash1, uBgTint;
uniform vec2 uKeyDir, uSideDir, uKeyC, uLightUv, uIrisR, uLidY;
uniform vec4 uIris;
uniform float uGlowAmt, uSoftFocus, uLeak;
// Filter overlays. AirBrush lays artistic texture over its colour tables (light leaks, streaks,
// colour washes, tape effects), blended in a Photoshop mode and kept off the face, and adds a
// vignette. Lumina draws its own layers procedurally: up to two per filter. Kinds: 1 leak,
// 2 streak, 3 wash, 4 flare, 5 VHS, 6 film burn, 7 stars, 8 holographic sheen. Blends: 0 screen,
// 1 soft light, 2 overlay, 3 multiply, 4 lighten. Each fades out inside an ellipse round every face.
uniform vec2 uOvKind, uOvBlend, uOvAmt, uOvAng, uOvSize;
uniform vec4 uOvPos;
uniform vec3 uOvC1[2], uOvC2[2];
uniform vec4 uFaceEll[4];
uniform int uFaceN;
uniform float uOvFace;

float ovHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float ovNoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(ovHash(i), ovHash(i + vec2(1.0, 0.0)), f.x), mix(ovHash(i + vec2(0.0, 1.0)), ovHash(i + vec2(1.0, 1.0)), f.x), f.y);
}

// A layer's colour and coverage (a) at frame position q (0–1 of the output).
vec4 ovLayer(int k, vec2 q, vec2 pos, float ang, float size, vec3 c1, vec3 c2) {
  float asp = uOutSize.x / uOutSize.y;
  vec2 a = (q - pos) * vec2(asp, 1.0), dir = vec2(cos(ang), sin(ang));
  float t = dot(a, dir), u = dot(a, vec2(-dir.y, dir.x));
  size = max(size, 0.05);
  if (k == 1) {                 // leak: a soft, wobbling pool of light coming in at pos
    float d = length(a) / size - ovNoise(q * 3.0 + pos * 7.0) * 0.4;
    return vec4(mix(c1, c2, smoothstep(0.1, 1.0, d)), 1.0 - smoothstep(0.0, 1.0, d));
  }
  if (k == 2) {                 // streak: three soft bands of light along dir, fading away from pos
    float m = 0.0;
    for (int i = 0; i < 3; i++) {
      float fi = float(i);
      m += exp(-pow((u - (fi - 1.0) * size * 0.9) / (size * (0.16 + 0.1 * fi)), 2.0)) * (i == 1 ? 0.85 : 0.5);
    }
    m *= 1.0 - smoothstep(-0.2, 1.4, t);
    return vec4(mix(c1, c2, clamp(abs(u) / size, 0.0, 1.0)), clamp(m, 0.0, 1.0));
  }
  if (k == 3) return vec4(mix(c1, c2, clamp(t / size * 0.5 + 0.5, 0.0, 1.0)), 1.0);   // wash
  if (k == 4) {                 // flare: a glow at pos, a faint ring, and ghosts toward the centre
    float d = length(a);
    float m = exp(-d * d / (size * size * 0.08)) + 0.25 * exp(-pow((d - size * 0.6) / (size * 0.05), 2.0));
    vec2 toC = (vec2(0.5) - pos) * vec2(asp, 1.0);
    for (int i = 1; i <= 3; i++) {
      vec2 g = a - toC * (0.45 + 0.45 * float(i));
      m += 0.16 * exp(-dot(g, g) / (size * size * 0.005 * float(i)));
    }
    return vec4(mix(c1, c2, smoothstep(0.0, size, d)), clamp(m, 0.0, 1.0));
  }
  if (k == 6) {                 // film burn: strongest at pos (on an edge), eating inward against dir
    float e = 1.0 + t / size + (ovNoise(q * 5.0 + 3.1) - 0.5) * 0.7;
    return vec4(mix(c1, c2, smoothstep(0.0, 1.0, e)), smoothstep(0.0, 0.9, e));
  }
  if (k == 7) {                 // stars: sparse four-point glints
    float cs = 26.0 + 40.0 * size, m = 0.0;
    vec2 px = q * uOutSize, cell = floor(px / cs);
    if (ovHash(cell + 0.37) > 0.82) {
      vec2 c = (cell + 0.2 + 0.6 * vec2(ovHash(cell + 1.7), ovHash(cell + 4.1))) * cs, d = px - c;
      float len = cs * (0.18 + 0.25 * ovHash(cell + 9.3)), w = max(0.8, len * 0.06);
      m = (max(0.0, 1.0 - abs(d.x) / len) * exp(-d.y * d.y / (w * w)) + max(0.0, 1.0 - abs(d.y) / len) * exp(-d.x * d.x / (w * w)));
      m = clamp(m * (0.5 + 0.5 * ovHash(cell + 2.2)), 0.0, 1.0);
    }
    return vec4(c1, m);
  }
  if (k == 8) {                 // holographic sheen: rainbow bands running across the frame
    vec3 rb = 0.5 + 0.5 * cos(6.2832 * (t / size + vec3(0.0, 0.33, 0.67)));
    return vec4(mix(rb, c1, 0.3), 1.0);
  }
  return vec4(0.0);
}

vec3 ovBlend(vec3 b, vec3 s, int mode) {
  if (mode == 1) return mix(2.0 * b * s + b * b * (1.0 - 2.0 * s), sqrt(b) * (2.0 * s - 1.0) + 2.0 * b * (1.0 - s), step(0.5, s));
  if (mode == 2) return mix(2.0 * b * s, 1.0 - 2.0 * (1.0 - b) * (1.0 - s), step(0.5, b));
  if (mode == 3) return b * s;
  if (mode == 4) return max(b, s);
  return 1.0 - (1.0 - b) * (1.0 - s);
}

// How much of the overlays a pixel gets: faces stay clear (uOvFace of the way).
float ovKeep(vec2 suv) {
  float f = 0.0;
  for (int i = 0; i < 4; i++) {
    if (i >= uFaceN) break;
    vec4 e = uFaceEll[i];
    f = max(f, 1.0 - smoothstep(0.75, 1.25, length((suv - e.xy) / e.zw)));
  }
  return 1.0 - uOvFace * f;
}

vec3 ovApply(vec3 c, int i, vec2 ouv, vec2 suv) {
  int k = int((i == 0 ? uOvKind.x : uOvKind.y) + 0.5);
  float amt = (i == 0 ? uOvAmt.x : uOvAmt.y) * ovKeep(suv);
  if (k == 0 || amt <= 0.0) return c;
  if (k == 5) {                 // VHS: colour bleeding sideways, scan lines and tape noise
    float o = 2.5 / uImgSize.x;
    vec3 s0 = texture(uImg, suv).rgb;
    c.r += (texture(uImg, suv + vec2(o, 0.0)).r - s0.r) * 1.4 * amt;
    c.b += (texture(uImg, suv - vec2(o, 0.0)).b - s0.b) * 1.4 * amt;
    c *= 1.0 - amt * 0.14 * (0.5 + 0.5 * cos(ouv.y * 2010.6));      // 320 lines down the frame, at any size
    return clamp(c + (ovHash(floor(ouv * uOutSize)) - 0.5) * 0.07 * amt, 0.0, 1.0);
  }
  vec4 l = ovLayer(k, ouv, i == 0 ? uOvPos.xy : uOvPos.zw, i == 0 ? uOvAng.x : uOvAng.y, i == 0 ? uOvSize.x : uOvSize.y, uOvC1[i], uOvC2[i]);
  vec3 cc = clamp(c, 0.0, 1.0);
  return mix(c, ovBlend(cc, l.rgb, int((i == 0 ? uOvBlend.x : uOvBlend.y) + 0.5)), clamp(l.a * amt, 0.0, 1.0));
}

uniform float uGeo, uLens;
uniform mat3 uGeoM;
uniform vec4 uCrop, uStretch;
uniform vec2 uFrame;
uniform float uFreeze, uPrism, uPrismR, uGlitter, uGlitterSize, uGlitterAll, uTextOn;
uniform vec2 uPrismC;
uniform vec3 uGlitterCol;
uniform vec3 uSparkPts[48];   // highlight points: photo uv, strength
uniform int uSparkN;
uniform float uSparkShape, uSparkSize, uSparkAngle;
uniform vec3 uSparkCol;

// Output frame uv → photo uv: crop, Stretch's band, lens correction, then straighten,
// perspective, rotation and flips as one homography (built in geometry.js).
vec2 geom(vec2 o) {
  vec2 fs = (uCrop.xy + o * uCrop.zw) * vec2(uFrame.x, uStretch.w);
  float y = fs.y;
  if (uStretch.z > 1.0 && y > uStretch.x) y = y < uStretch.x + uStretch.y * uStretch.z ? uStretch.x + (y - uStretch.x) / uStretch.z : y - uStretch.y * (uStretch.z - 1.0);
  vec2 f = vec2(fs.x, y) - 0.5 * uFrame;
  float rn = length(f) / (0.5 * length(uFrame));
  f *= 1.0 + uLens * rn * rn;
  vec3 h = uGeoM * vec3(f, 1.0);
  return h.xy / h.z / uImgSize + 0.5;
}

// Clarity, Ambience and Dehaze compare each pixel with its surroundings, like their namesakes in
// photo apps, so they act on local contrast instead of shifting the whole photo.
vec3 localAdjust(vec3 c, vec3 loc) {
  float l = luma(c), ll = luma(loc);
  vec3 d = c - loc;
  d /= 1.0 + 3.0 * abs(d);                                     // soft-limit strong edges so outlines don't halo
  c += d * uClarity * 1.25 * (4.0 * l * (1.0 - l));            // midtone local contrast; negative glows
  if (uAmbience != 0.0) {
    float s = uAmbience * 0.7 * (1.0 - smoothstep(0.0, 0.6, ll));
    float h = uAmbience * 0.45 * smoothstep(0.4, 1.0, ll);
    c = clamp(c, 0.0, 1.0);
    c = 1.0 - pow(1.0 - c, vec3(1.0 + s));
    c = pow(c, vec3(1.0 + h));
    c = mix(vec3(luma(c)), c, 1.0 + 0.25 * uAmbience);
  }
  if (uDehaze != 0.0) {
    float haze = min(min(loc.r, loc.g), loc.b);
    if (uDehaze > 0.0) {
      float t = 0.6 * uDehaze * haze;
      c = (c - t) / max(1.0 - t, 0.2);
    } else {
      c = mix(c, vec3(0.86), -uDehaze * 0.45 * (0.4 + 0.6 * (1.0 - haze)));
    }
  }
  return c;
}

vec3 toLin(vec3 c) { return pow(max(c, 0.0), vec3(2.2)); }
vec3 toGamma(vec3 c) { return pow(max(c, 0.0), vec3(1.0 / 2.2)); }

// How much of a light reaches a surface: Lambert wrapped round the form, with a smooth terminator.
float lightAt(vec3 n, vec3 L) {
  float w = clamp((dot(n, L) + uWrap) / (1.0 + uWrap), 0.0, 1.0);
  return w * w * (3.0 - 2.0 * w);
}

// Where light raised a value it rolls off toward white instead of clipping (never below where it
// started); darkened values pass through.
vec3 rolloff(vec3 base, vec3 x) {
  const float t = 0.75;
  vec3 s = min(x, vec3(t)) + (1.0 - t) * (1.0 - exp(-max(x - t, 0.0) / (1.0 - t)));
  return mix(x, max(min(base, vec3(1.0)), s), step(base, x));
}

vec2 hash2(vec2 p) { return fract(sin(vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3)))) * 43758.5453); }

// Water: a bright net of lines like sunlight through ripples (the borders between random cells).
float caustic(vec2 p) {
  p += 0.4 * vec2(sin(p.y * 1.7), sin(p.x * 1.3));
  vec2 g = floor(p), f = fract(p);
  float d1 = 9.0, d2 = 9.0;
  for (int y = -1; y <= 1; y++) {
    for (int x = -1; x <= 1; x++) {
      vec2 o = vec2(float(x), float(y));
      vec2 r = o + hash2(g + o) - f;
      float d = dot(r, r);
      if (d < d1) { d2 = d1; d1 = d; } else if (d < d2) { d2 = d; }
    }
  }
  return exp(-(sqrt(d2) - sqrt(d1)) * 6.0);
}

// Relighting in linear light. Each light reaches the subject according to its 3D form, measured
// against what a camera-facing surface gets (uRef), so the photo's own exposure is the starting
// point; shading stays within soft limits (about a stop down, under a stop up) and its colour is
// the lights' colour where they land. The background is a wall behind: brighter toward the light
// and washed with its colour.
vec3 relight(vec3 c, vec2 suv) {
  vec4 nm = texture(uNormal, suv);
  vec3 n = normalize(nm.xyz * 2.0 - 1.0);
  float subj = max(texture(uPerson, suv).a, nm.a);
  vec3 lin = toLin(c);
  vec2 q = suv * vec2(uAspect, 1.0);

  vec3 E = uFillCol * uFill + uC0 * lightAt(n, uL0) + uC1 * lightAt(n, uL1);
  float e = max(luma(E), 1e-4);
  float s = log2(e / uRef);
  s = s < 0.0 ? -1.1 * tanh(-s / 1.1) : 0.85 * tanh(s / 0.85);
  float broad = luma(toLin(texture(uGlow, suv).rgb));
  float lift = 1.0 + uLift * (1.0 - smoothstep(0.01, 0.2, broad));     // opens shadows already there
  vec3 lit = lin * lift * exp2(s + uSubjExp) * mix(vec3(1.0), E / e, uSat);
  // Edge light from lights behind or beside; a soft sheen where skin faces between light and camera.
  float edge = pow(1.0 - clamp(n.z, 0.0, 1.0), 2.0);
  vec3 add = uC0 * clamp(dot(normalize(n.xy + 1e-5), normalize(uL0.xy + 1e-5)), 0.0, 1.0) +
             uC1 * clamp(dot(normalize(n.xy + 1e-5), normalize(uL1.xy + 1e-5)), 0.0, 1.0);
  add *= edge * uRim * (0.15 + lin) * (1.0 - 0.75 * nm.a);      // edges of the figure, not inside the face
  add += uC0 * pow(max(dot(n, normalize(uL0 + vec3(0.0, 0.0, 1.0))), 0.0), 60.0) * uSheen * nm.a * smoothstep(0.03, 0.35, luma(lin));

  vec2 dv = q - uKeyC;
  vec3 wash = mix(uWash0, uWash1, smoothstep(-0.35, 0.35, dot(dv, uSideDir)));
  vec3 bg = lin * exp2(uBgExp + uBgGrad * clamp(dot(dv, uKeyDir), -0.8, 0.8)) * mix(vec3(1.0), wash, uSpill) * mix(vec3(1.0), uBgTint, uBgTintAmt);

  vec3 o = mix(rolloff(lin, bg), rolloff(lin, lit + add), subj);
  if (uWater > 0.0) {
    // Two layers of ripples, patchy rather than an even net. The light multiplies what it lands on
    // (red cloth gets brighter red lines, not white ones), more gently on the subject.
    vec2 wp = q * uWaterScale + n.xy * 0.5;     // the pattern bends round the form
    float c1 = caustic(wp), c2 = caustic(wp * 1.13 + vec2(3.1, 7.4));
    float k = pow(c1 * c2, 0.7) * 1.4 + (c1 + c2) * 0.12;     // brightest where the two ripples cross
    k *= 0.3 + 0.7 * vnoise(wp * 0.3 + 7.0);
    o = rolloff(o, o * (1.0 + uC0 * k * uWater * 1.6 * (1.0 - 0.5 * subj)));
  }
  return toGamma(o);
}

vec3 grade(vec3 c, vec2 uv, Grade g) {
  c *= exp2(g.exposure);
  c *= vec3(1.0 + 0.09 * g.warmth, 1.0 - 0.05 * g.tint, 1.0 - 0.09 * g.warmth);
  c = pow(max(c, vec3(0.0)), vec3(exp2(-0.85 * g.brightness)));   // midtones only; black and white stay put
  float l = luma(c);
  float sh = 1.0 - smoothstep(0.0, 0.55, l);
  float hi = smoothstep(0.45, 1.0, l);
  float nl = l + g.shadows * 0.22 * sh * (1.0 - l) + g.highlights * 0.22 * hi * (g.highlights > 0.0 ? 1.0 - l : l);
  c *= nl / max(l, 1e-4);
  c = clamp((c - 0.5) * (1.0 + g.contrast) + 0.5, 0.0, 1.0);
  c = mix(c, c * c * (3.0 - 2.0 * c), g.curve);
  c = c * (1.0 - 0.14 * g.fade) + 0.07 * g.fade;
  l = luma(c);
  float sat = max(max(c.r, c.g), c.b) - min(min(c.r, c.g), c.b);
  c = mix(vec3(l), c, 1.0 + g.saturation + g.vibrance * (1.0 - sat));
  if (g.isoAmt > 0.0) {
    // Colour pop: everything but one hue range goes grey.
    vec3 h = rgb2hsv(clamp(c, 0.0, 1.0));
    float dh = abs(fract(h.x - g.isoHue + 0.5) - 0.5);
    float keep = (1.0 - smoothstep(g.isoWidth * 0.5, g.isoWidth, dh)) * smoothstep(0.1, 0.3, h.y);
    c = mix(c, vec3(luma(c)), g.isoAmt * (1.0 - keep));
  }
  c = mix(c, vec3(luma(c)), g.mono);
  c += ((g.shadowTint - 0.5) * sh + (g.highTint - 0.5) * hi) * g.split;   // after mono, so toning tints it
  vec2 d = (uv - 0.5) * 2.0 * uOutSize / max(uOutSize.x, uOutSize.y);
  float v = smoothstep(0.45, 1.35, length(d));
  c = g.vignette >= 0.0 ? c * (1.0 - g.vignette * 0.6 * v) : c + (1.0 - c) * (-g.vignette) * 0.45 * v;
  if (g.grain > 0.0) c += (hash(floor(uv * uOutSize)) - 0.5) * g.grain * 0.09 * (1.0 - 0.5 * luma(c));
  return c;
}

// A filter's colour table: 33 slices of 33 × 33 side by side, blue choosing the slice.
vec3 lutColor(vec3 c) {
  c = clamp(c, 0.0, 1.0) * 32.0;
  float b = floor(c.b), f = c.b - b;
  vec2 uv0 = vec2((b * 33.0 + c.r + 0.5) / 1089.0, (c.g + 0.5) / 33.0);
  vec2 uv1 = b < 32.0 ? uv0 + vec2(33.0 / 1089.0, 0.0) : uv0;
  return mix(texture(uLut, uv0).rgb, texture(uLut, uv1).rgb, f);
}

// Dust: a few specks and fine scratches, as on old film (positions fixed to the output frame).
float dust(vec2 q) {
  float k = max(uOutSize.x, uOutSize.y) / 1200.0;
  vec2 s = q / (14.0 * k), g = floor(s);
  float h = hash(g + 3.7), m = 0.0;
  if (h > 0.982) {
    vec2 c = vec2(hash(g + 1.1), hash(g + 2.2)) * 0.6 + 0.2;
    float r = 0.08 + 0.22 * hash(g + 5.5);
    vec2 d = (fract(s) - c) * vec2(1.0, 0.6 + 0.8 * hash(g + 8.1));
    m = 1.0 - smoothstep(r * 0.5, r, length(d));
  }
  for (int i = 0; i < 3; i++) {
    float fi = float(i);
    float x = hash(vec2(fi, 1.7)) + 0.004 * sin(q.y * 0.006 / k + fi * 5.0);
    float line = 1.0 - smoothstep(0.0, 0.9 * k / uOutSize.x, abs(q.x / uOutSize.x - x));
    m = max(m, line * step(0.55, vnoise(vec2(fi * 9.0, q.y * 0.004 / k))) * 0.7);
  }
  return m;
}

// Glitter: two scattered layers of small hexagonal flakes over the painted area, at different sizes
// so no grid shows. Each flake tilts its own way, so it catches the light brightly, faintly or not
// at all (with a gradient across its face); only the light it catches is added. The few that catch
// it fully throw four-point glints over their neighbours.
float flakeLayer(vec2 s, float salt, out float hue) {
  s.x += mod(floor(s.y), 2.0) * 0.5;
  vec2 g = floor(s) + salt, f = fract(s);
  float a = hash(g + 41.9) * 6.2832;
  vec2 d = f - 0.5 - (vec2(hash(g), hash(g + 17.3)) - 0.5) * 0.3;
  vec2 r = vec2(cos(a) * d.x - sin(a) * d.y, sin(a) * d.x + cos(a) * d.y);
  vec2 ar = abs(r);
  float size = 0.28 + 0.14 * hash(g + 23.1);
  float flake = 1.0 - smoothstep(size - 0.06, size, max(ar.x * 0.866 + ar.y * 0.5, ar.y));
  hue = hash(g + 9.7);
  return flake * pow(hash(g + 5.1), 3.0) * (0.55 + 0.9 * clamp(r.x / size * 0.5 + 0.5, 0.0, 1.0));
}

float glints(vec2 s, float salt) {
  vec2 g = floor(s);
  float star = 0.0;
  for (int y = -2; y <= 2; y++) {
    for (int x = -2; x <= 2; x++) {
      vec2 gg = g + vec2(float(x), float(y));
      float l = hash(gg + salt + 5.1);
      if (l < 0.965) continue;
      vec2 dd = s - (gg + 0.5 + (vec2(hash(gg + salt), hash(gg + salt + 17.3)) - 0.5) * 0.3);
      float st = exp(-dot(dd, dd) * 10.0) * 0.6;
      st += max(0.0, 1.0 - abs(dd.x) * 12.0) * pow(max(0.0, 1.0 - abs(dd.y) * 0.42), 2.0);
      st += max(0.0, 1.0 - abs(dd.y) * 12.0) * pow(max(0.0, 1.0 - abs(dd.x) * 0.42), 2.0);
      star += st * (l - 0.965) * 30.0;
    }
  }
  return star;
}

vec3 glitterOver(vec3 c, vec2 q, float m) {
  vec2 s = q / uGlitterSize;
  bool rainbow = dot(uGlitterCol, vec3(1.0)) < 0.01;
  float h1, h2;
  float a = flakeLayer(s, 0.0, h1), b = flakeLayer(s * 1.6 + vec2(0.37, 0.71), 113.0, h2);
  vec3 t1 = rainbow ? hsv2rgb(vec3(h1, 0.5, 1.0)) : uGlitterCol, t2 = rainbow ? hsv2rgb(vec3(h2, 0.5, 1.0)) : uGlitterCol;
  // The glitter's colour washes over what it covers, then the flakes add the light they catch.
  vec3 tint = rainbow ? vec3(0.85, 0.82, 0.95) : uGlitterCol;
  vec3 o = mix(c, c * mix(vec3(1.0), tint, 0.5) + tint * 0.04, m * 0.4);
  float k = 0.55 + 0.7 * luma(c);
  o = max(o, mix(o, (t1 * a * 1.45 + t2 * b * 1.2) * k, m));
  float star = glints(s, 0.0) + glints(s * 1.6 + vec2(0.37, 0.71), 113.0) * 0.6;
  return screen(clamp(o, 0.0, 1.0), mix(vec3(1.0), tint, 0.3) * star * m);
}

// Sparkle: star glints on the photo's own highlights (found on the CPU): a bright core, a soft glow
// and thin rays that taper, turned by Angle. Shapes: 1 four-point, 2 six, 3 eight, 4 twinkle, 5 glow.
vec3 sparkleOver(vec3 c, vec2 suv) {
  vec2 p = suv * uImgSize;
  vec3 add = vec3(0.0);
  float ca = cos(uSparkAngle), sa = sin(uSparkAngle);
  int shape = int(uSparkShape + 0.5);
  int rays = shape == 2 ? 3 : shape == 3 ? 4 : 2;
  for (int i = 0; i < 48; i++) {
    if (i >= uSparkN) break;
    vec3 sp = uSparkPts[i];
    float R = uSparkSize * (0.55 + 0.6 * sp.z);
    vec2 d = p - sp.xy * uImgSize;
    if (abs(d.x) > R || abs(d.y) > R) continue;
    vec2 q = vec2(ca * d.x + sa * d.y, -sa * d.x + ca * d.y) / R;
    float r2 = dot(q, q);
    float k = exp(-r2 * 260.0) * 1.2 + exp(-sqrt(r2) * (shape == 5 ? 4.5 : 9.0)) * (shape == 5 ? 0.75 : 0.35);
    if (shape != 5) {
      for (int j = 0; j < 4; j++) {
        if (j >= rays) break;
        float an = 3.14159265 * float(j) / float(rays);
        vec2 dir = vec2(cos(an), sin(an));
        float al = abs(dot(q, dir)), pe = abs(dot(q, vec2(-dir.y, dir.x)));
        k += pow(max(0.0, 1.0 - al), 2.2) * exp(-pe * 90.0 * (1.0 + 2.5 * al)) * 0.9;
      }
      if (shape == 4) {
        for (int j = 0; j < 2; j++) {
          vec2 dir = j == 0 ? vec2(0.7071, 0.7071) : vec2(-0.7071, 0.7071);
          float al = abs(dot(q, dir)) * 2.2, pe = abs(dot(q, vec2(-dir.y, dir.x)));
          k += pow(max(0.0, 1.0 - al), 2.2) * exp(-pe * 120.0 * (1.0 + 2.5 * al)) * 0.6;
        }
      }
    }
    vec3 tint = dot(uSparkCol, vec3(1.0)) < 0.01 ? hsv2rgb(vec3(fract(float(i) * 0.618 + 0.1), 0.45, 1.0)) : uSparkCol;
    add += tint * k * sp.z;
  }
  return screen(clamp(c, 0.0, 1.0), min(add, vec3(1.0)));
}

// Background Freeze: whether the subject covered the photo at p. Its refined cut-out grown by about
// 3 px counts, so the faint outer edge of hair does, fading out over the next few pixels so the
// filled-in background never meets the photo along a hard line; so does anything the layer behind
// marks as lying over the background near the outline (stray strands, hair's blurred edge).
float covered(vec2 p) {
  vec2 t = 3.0 / uImgSize;
  float a = texture(uMatte, p).a, far = 0.0;
  for (int i = 0; i < 8; i++) {
    vec2 d = vec2(cos(float(i) * 0.7853982), sin(float(i) * 0.7853982));
    a = max(a, texture(uMatte, p + d * t).a);
    far += texture(uMatte, p + d * t * 2.7).a;
  }
  return max(max(smoothstep(0.02, 0.15, a), smoothstep(0.0, 4.0, far)), texture(uBgLayer, p).a);
}

void main() {
  vec2 p = vec2(gl_FragCoord.x, mix(gl_FragCoord.y, uCanvasH - gl_FragCoord.y, uFlip));
  vec2 ouv = p * uView.xy + uView.zw;
  if (ouv.x < 0.0 || ouv.y < 0.0 || ouv.x > 1.0 || ouv.y > 1.0) { outColor = vec4(0.0); return; }
  vec2 uv = uGeo > 0.5 ? geom(ouv) : ouv;
  if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) { outColor = vec4(0.0, 0.0, 0.0, 1.0); return; }
  if (uShowOrig > 0.5) { outColor = vec4(texture(uOrig, uv).rgb, 1.0); return; }
  vec2 suv = clamp(uv + texture(uWarp, uv).rg, vec2(0.0), vec2(1.0));
  vec3 c = texture(uImg, suv).rgb;
  if (uFreeze > 0.5) {
    // Background Freeze: the subject moves and the background stays. A pixel brought here is part
    // subject (its share in the refined cut-out) and part whatever was behind it; that background
    // share is swapped for the background that belongs here. Where the subject covered a spot, its
    // background comes from the scene with the subject filled out; elsewhere it is the photo's own.
    // So the subject's old outline cannot stay behind, strands carry no fringe of their old
    // surroundings, and with nothing moved the photo is unchanged.
    float as = texture(uMatte, suv).a;
    vec3 bs = mix(c, texture(uBgLayer, suv).rgb, covered(suv));
    vec3 bd = mix(texture(uImg, uv).rgb, texture(uBgLayer, uv).rgb, covered(uv));
    c = clamp(c + (1.0 - as) * (bd - bs), 0.0, 1.0);
  }
  if (uPrism > 0.0) {
    vec2 d = ouv - uPrismC;
    float k = uPrism * 0.014 * smoothstep(uPrismR, uPrismR + 0.35, length(d * vec2(uOutSize.x / uOutSize.y, 1.0)));
    c.r = texture(uImg, clamp(suv + d * k, 0.0, 1.0)).r;
    c.b = texture(uImg, clamp(suv - d * k, 0.0, 1.0)).b;
  }
  if (uSharpen != 0.0) {
    vec2 t = 1.0 / uImgSize;
    vec3 n = texture(uImg, suv + vec2(t.x, 0.0)).rgb + texture(uImg, suv - vec2(t.x, 0.0)).rgb +
             texture(uImg, suv + vec2(0.0, t.y)).rgb + texture(uImg, suv - vec2(0.0, t.y)).rgb;
    c = clamp(c + (c - n * 0.25) * uSharpen * 1.4, 0.0, 1.0);
  }
  if (uClarity != 0.0 || uAmbience != 0.0 || uDehaze != 0.0) c = localAdjust(c, texture(uLocal, suv).rgb);
  if (uRelight > 0.5) {
    c = relight(c, suv);
    vec2 q = suv * vec2(uAspect, 1.0);
    float subj = texture(uPerson, suv).a;
    vec3 tone = clamp(uC0 / max(max(uC0.r, uC0.g), max(uC0.b, 1e-4)), 0.0, 1.0);   // the key light's colour
    if (uHaze > 0.0) {
      // Haze: the light glows into the air, most near it, and bright areas bloom.
      float near = exp(-2.4 * distance(q, uLightUv));
      float bloom = max(luma(texture(uGlow, suv).rgb) - 0.5, 0.0) * 0.9;
      c = screen(clamp(c, 0.0, 1.0), tone * (near * 0.55 + bloom) * uHaze);
    }
    if (uRays > 0.0) {
      // Rays: soft beams fanning out from the light, seen mostly in the air around the subject.
      // The angle is measured from the subject's direction, so its seam points away from the photo.
      vec2 d = q - uLightUv, toward = normalize(uKeyC - uLightUv);
      float a = atan(dot(d, vec2(-toward.y, toward.x)), dot(d, toward));
      float beams = smoothstep(0.42, 0.85, vnoise(vec2(a * 10.0 + 3.0, 1.7)) * 0.6 + vnoise(vec2(a * 26.0 + 9.0, 5.3)) * 0.4);
      float fall = exp(-1.1 * length(d)) * smoothstep(0.0, 0.25, length(d));
      c = screen(clamp(c, 0.0, 1.0), tone * beams * fall * uRays * (0.7 - 0.45 * subj));
    }
    if (uCatch > 0.0) {
      // Catchlights: a ring light's ring, or a soft window toward the light; never above the lid.
      vec2 p = suv * uImgSize;
      for (int e = 0; e < 2; e++) {
        vec2 ic = e == 0 ? uIris.xy : uIris.zw;
        float r = e == 0 ? uIrisR.x : uIrisR.y;
        if (r <= 0.0) continue;
        float m = uCatch < 1.5
          ? 1.0 - smoothstep(r * 0.05, r * 0.12, abs(distance(p, ic) - r * 0.5))
          : 1.0 - smoothstep(r * 0.1, r * 0.2, distance(p, ic + normalize(uL0.xy + vec2(0.0, -1e-3)) * r * 0.42));
        m *= smoothstep(0.0, r * 0.2, p.y - (e == 0 ? uLidY.x : uLidY.y));
        c = screen(clamp(c, 0.0, 1.0), vec3(m * 0.7));
      }
    }
  }
  if (uGlowAmt > 0.0 || uSoftFocus > 0.0) {
    vec3 g = texture(uGlow, suv).rgb;
    c = screen(clamp(c, 0.0, 1.0), max(g - 0.5, 0.0) * 1.6 * uGlowAmt);                  // bright areas bloom
    c = mix(c, screen(clamp(c, 0.0, 1.0), g * 0.45), uSoftFocus * 0.65);                 // dreamy haze
  }
  if (uLeak > 0.0) {
    vec3 leak = vec3(1.0, 0.45, 0.15) * (1.0 - smoothstep(0.0, 1.1, distance(ouv, vec2(-0.05, 0.12)))) +
                vec3(1.0, 0.3, 0.5) * 0.6 * (1.0 - smoothstep(0.0, 0.9, distance(ouv, vec2(1.08, 0.88))));
    c = screen(clamp(c, 0.0, 1.0), leak * uLeak * 0.85);
  }
  if (uHalation > 0.0) {
    // Halation: film's red-orange glow bleeding round bright areas (from the local blur).
    float hl = max(luma(texture(uLocal, suv).rgb) - 0.55, 0.0);
    c = screen(clamp(c, 0.0, 1.0), vec3(1.0, 0.32, 0.12) * hl * 2.2 * uHalation);
  }
  vec3 adj = grade(c, ouv, uA);
  c = grade(adj, ouv, uF);
  if (uLutAmt > 0.0) c = mix(c, lutColor(c), uLutAmt);
  if (uProtect > 0.0 && uGate > 0.5) {
    // Skin keeps most of its own colour under a filter: 60% of the filter's change in brightness
    // and 30% of its change in colour reach it. Skin is judged on the photo before any grading.
    vec2 dv = toYcc(texture(uImg, suv).rgb).yz - uSkinMean;
    float skin = (1.0 - smoothstep(2.4, 4.6, sqrt(max(dot(dv, uSkinInv * dv), 0.0)))) * texture(uPerson, suv).a * uProtect;
    vec3 a = toYcc(c), b = toYcc(adj);
    c = mix(c, fromYcc(vec3(mix(b.x, a.x, 0.6), mix(b.yz, a.yz, 0.3))), skin);
  }
  c = ovApply(ovApply(c, 0, ouv, suv), 1, ouv, suv);
  if (uDust > 0.0) c = mix(c, vec3(0.93, 0.92, 0.88), clamp(dust(ouv * uOutSize) * uDust, 0.0, 1.0));
  float gm = uGlitter * max(uGlitterAll, texture(uGlitterMask, suv).a);
  if (gm > 0.002) c = glitterOver(c, ouv * uOutSize, min(gm, 1.0));
  if (uSparkN > 0) c = sparkleOver(c, suv);
  if (uOverlay > 0.0) {
    float m = texture(uOverlayTex, suv).a;
    if (uOverlayMode > 0.5) m = abs(m - 0.5) * 2.0;     // brush layers over an automatic area start at 0.5
    c = mix(c, uOverlayColor, mix(m, 1.0 - m, uOverlayInvert) * uOverlay);
  }
  if (uTextOn > 0.5) {
    vec4 t = texture(uText, ouv);
    c = mix(c, t.rgb, t.a);
  }
  outColor = vec4(clamp(c, 0.0, 1.0), 1.0);
}`;

// Region templates drawn through the face mesh (facemaps.js).
const MESH_VERT = `#version 300 es
in vec2 aPos;
in vec2 aUv;
out vec2 vT;
out float vSide;
void main() {
  vT = aUv;
  vSide = (aUv.x - 0.5) / 0.36;     // -1 image left … 1 image right, on the canonical face
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;
const MESH_FRAG = `#version 300 es
precision highp float;
in vec2 vT;
in float vSide;
uniform sampler2D uAtlas;
uniform float uFar;                 // sculpt only: which side turns away (−1…1)
out vec4 outColor;
void main() {
  vec4 a = texture(uAtlas, vT);
  float s = clamp(vSide, -1.0, 1.0);
  float cw = 1.0 + 0.55 * uFar * s, hw = 1.0 - 0.45 * uFar * s;
  outColor = vec4(a.r * cw, a.g * hw, a.b * cw, a.a * cw);
}`;

// Which painted layers share a packed texture, channel by channel.
export const PAINT_PACKS = { paintA: ['skin', 'wrinkle', 'conceal', 'texture'], paintB: ['matte', 'detail', 'teeth', null] };
// Layers whose untouched state is 0.5: brushing adds to or takes away from an automatic area.
export const OVERRIDE_LAYERS = new Set(['matte', 'teeth']);
const MAPS = ['crease', 'zone', 'fill', 'sculpt', 'age'];

export class Renderer {
  constructor(canvas) {
    const gl = canvas.getContext('webgl2', {
      alpha: true, premultipliedAlpha: true, antialias: false, depth: false, stencil: false,
      preserveDrawingBuffer: false, powerPreference: 'high-performance',
    });
    if (!gl) throw new Error('WebGL2 is not available');
    this.gl = gl;
    this.canvas = canvas;
    this.programs = {};
    const sources = {
      copy: COPY, bilateral: BILATERAL, gauss: GAUSS, bgprep: BGPREP, matte: MATTE, bokeh: BOKEH, denoise: DENOISE, pack: PACK,
      edge: EDGE, flow: FLOW, upfill: UPFILL, retouch: RETOUCH, hairmatte: HAIRMATTE, hairprep: HAIRPREP, hair: HAIR, composite: COMPOSITE,
      freezebg: FREEZEBG, people: PEOPLE, final: FINAL,
    };
    for (const [name, src] of Object.entries(sources)) this.programs[name] = this.makeProgram(VERT, HEAD + src);
    this.programs.mesh = this.makeProgram(MESH_VERT, MESH_FRAG, ['aPos', 'aUv']);
    this.quadVao = gl.createVertexArray();
    gl.bindVertexArray(this.quadVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    this.meshVao = gl.createVertexArray();
    gl.bindVertexArray(this.meshVao);
    this.meshPos = gl.createBuffer();
    this.meshUv = gl.createBuffer();
    this.meshIdx = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.meshPos);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.meshUv);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.meshIdx);
    gl.bindVertexArray(this.quadVao);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
    this.blank = this.makeTexture(1, 1, { data: new Uint8Array([0, 0, 0, 0]) });
    this.solid = this.makeTexture(1, 1, { data: new Uint8Array([255, 255, 255, 255]) });
    this.half = this.makeTexture(1, 1, { data: new Uint8Array([255, 255, 255, 128]) });
    this.flatNormal = this.makeTexture(1, 1, { data: new Uint8Array([128, 128, 255, 0]) });
    this.zeroWarp = this.makeTexture(1, 1, { internal: gl.RG16F, format: gl.RG, type: gl.FLOAT, data: new Float32Array([0, 0]) });
    this.shared = new Set([this.blank, this.solid, this.half, this.flatNormal, this.zeroWarp]);
    this.atlas = null;
    this.luts = new Map();
    this.tex = {};
    this.mattes = {};
    this.t = {};
    this.lazy = {};
    this.W = 0;
    this.H = 0;
    this.maskScale = 0.5;
    this.smoothRadius = 6;
    this.blurSigma = 12;
    this.smallSigma = 4;
    this.version = 0;
    this.paintVersion = 0;
  }

  makeProgram(vs, fs, attribs = ['aPos']) {
    const gl = this.gl;
    const compile = (type, src) => {
      const s = gl.createShader(type);
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) || 'shader compile failed');
      return s;
    };
    const p = gl.createProgram();
    gl.attachShader(p, compile(gl.VERTEX_SHADER, vs));
    gl.attachShader(p, compile(gl.FRAGMENT_SHADER, fs));
    attribs.forEach((a, i) => gl.bindAttribLocation(p, i, a));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p) || 'link failed');
    const uniforms = {};
    const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < n; i++) {
      const info = gl.getActiveUniform(p, i);
      uniforms[info.name.replace(/\[0\]$/, '')] = { loc: gl.getUniformLocation(p, info.name), type: info.type };
    }
    return { p, uniforms };
  }

  makeTexture(w, h, { internal, format, type, data = null, filter } = {}) {
    const gl = this.gl;
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter || gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter || gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.upload(tex, w, h, data, internal, format, type);
    return tex;
  }

  upload(tex, w, h, data, internal, format, type) {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    if (data && !ArrayBuffer.isView(data)) {
      gl.texImage2D(gl.TEXTURE_2D, 0, internal || gl.RGBA8, format || gl.RGBA, type || gl.UNSIGNED_BYTE, data);
    } else {
      gl.texImage2D(gl.TEXTURE_2D, 0, internal || gl.RGBA8, w, h, 0, format || gl.RGBA, type || gl.UNSIGNED_BYTE, data);
    }
  }

  // Replaces texture `name` (deleting the old one unless it is a shared default).
  swap(name, tex) {
    const old = this.tex[name];
    if (old && old !== tex && !this.shared.has(old)) this.gl.deleteTexture(old);
    this.tex[name] = tex;
  }

  makeTarget(w, h) {
    const gl = this.gl;
    const tex = this.makeTexture(w, h);
    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    return { tex, fbo, w, h };
  }

  freeTarget(t) {
    if (!t) return;
    this.gl.deleteTexture(t.tex);
    this.gl.deleteFramebuffer(t.fbo);
  }

  // A size-dependent target made the first time a tool needs it; kind: 'full', 'half', 'quarter',
  // 'eighth' or 'mask'.
  target(name, kind) {
    if (!this.lazy[name]) {
      const d = { full: 1, half: 2, quarter: 4, eighth: 8, sixteenth: 16, s32: 32, s64: 64 }[kind];
      const [w, h] = kind === 'mask' ? this.maskSize() : [Math.max(1, Math.ceil(this.W / d)), Math.max(1, Math.ceil(this.H / d))];
      this.lazy[name] = this.makeTarget(w, h);
    }
    return this.lazy[name];
  }

  maskSize() {
    return [Math.max(1, Math.round(this.W * this.maskScale)), Math.max(1, Math.round(this.H * this.maskScale))];
  }

  run(name, target, values) {
    const gl = this.gl;
    const prog = this.programs[name];
    gl.bindFramebuffer(gl.FRAMEBUFFER, target ? target.fbo : null);
    gl.viewport(0, 0, target ? target.w : gl.drawingBufferWidth, target ? target.h : gl.drawingBufferHeight);
    gl.useProgram(prog.p);
    this.bindUniforms(prog, values);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  bindUniforms(prog, values) {
    const gl = this.gl;
    let unit = 0;
    for (const [k, v] of Object.entries(values)) {
      const u = prog.uniforms[k];
      if (!u) continue;
      switch (u.type) {
        case gl.SAMPLER_2D:
          gl.activeTexture(gl.TEXTURE0 + unit);
          gl.bindTexture(gl.TEXTURE_2D, v);
          gl.uniform1i(u.loc, unit++);
          break;
        case gl.FLOAT: typeof v === 'number' ? gl.uniform1f(u.loc, v) : gl.uniform1fv(u.loc, v); break;
        case gl.FLOAT_VEC2: gl.uniform2fv(u.loc, v); break;
        case gl.FLOAT_VEC3: gl.uniform3fv(u.loc, v); break;
        case gl.FLOAT_VEC4: gl.uniform4fv(u.loc, v); break;
        case gl.INT: gl.uniform1i(u.loc, v); break;
        case gl.FLOAT_MAT2: gl.uniformMatrix2fv(u.loc, false, v); break;
        case gl.FLOAT_MAT3: gl.uniformMatrix3fv(u.loc, false, v); break;
      }
    }
  }

  // A new photo: (re)allocate every size-dependent texture. `orig` and `work` are ImageData.
  setImage(orig, work) {
    const W = orig.width, H = orig.height;
    for (const t of Object.values(this.t)) this.freeTarget(t);
    for (const t of Object.values(this.lazy)) this.freeTarget(t);
    this.lazy = {};
    for (const name of Object.keys(this.tex)) this.swap(name, null);
    this.W = W;
    this.H = H;
    this.tex = {
      orig: this.makeTexture(W, H, { data: orig }),
      src: this.makeTexture(W, H, { data: work }),
      skin: this.blank, hair: this.blank, person: this.solid, erase: this.blank,
      wrinkle: this.blank, conceal: this.blank, texture: this.blank, detail: this.blank, matte: this.half, teeth: this.half,
      feat: this.blank, feat2: this.blank, feat3: this.blank, feat4: this.blank, strict: this.blank, seg: this.blank,
      crease: this.blank, zone: this.blank, fill: this.blank, sculpt: this.blank, age: this.blank,
      normal: this.flatNormal, bgImage: this.blank, warp: this.zeroWarp, tempWarp: null, text: this.blank, glitter: this.blank,
      p0: this.blank, p1: this.blank, p2: this.blank, p3: this.blank, p4: this.blank,
      personAB: this.blank, personLH: this.blank, hairFB: this.blank, hairBB: this.blank, hairLH: this.blank, freezePlate: this.blank,
    };
    this.mattes = {};
    this.personTex = null;
    const hw = Math.ceil(W / 2), hh = Math.ceil(H / 2), qw = Math.ceil(W / 4), qh = Math.ceil(H / 4);
    const ew = Math.ceil(W / 8), eh = Math.ceil(H / 8);
    const [mw, mh] = this.maskSize();
    this.t = {
      smooth: this.makeTarget(W, H),
      retouch: this.makeTarget(W, H),
      comp: this.makeTarget(W, H),
      half: this.makeTarget(hw, hh),
      halfTmp: this.makeTarget(hw, hh),
      small: this.makeTarget(hw, hh),
      quarter: this.makeTarget(qw, qh),
      quarterTmp: this.makeTarget(qw, qh),
      bgOut: this.makeTarget(qw, qh),
      local: this.makeTarget(qw, qh),
      glow: this.makeTarget(ew, eh),
      glowTmp: this.makeTarget(ew, eh),
      paintA: this.makeTarget(mw, mh),
      paintB: this.makeTarget(mw, mh),
    };
    this.stale = { smooth: true, blurM: true, blurS: true, flow: true };
    this.paintKey = '';
    this.bgKey = '';
    this.compKey = '';
    this.localKey = '';
    this.glowKey = '';
    this.mipKey = '';
    this.freezeKey = '';
    this.bgPlateKey = '';
    this.lowKey = '';
    this.edgeKey = '';
    this.hairRefKey = '';
    this.people = [];
    this.version++;
  }

  updateSource(work) {
    this.upload(this.tex.src, this.W, this.H, work);
    this.stale = { smooth: true, blurM: true, blurS: true, flow: true };
    this.version++;
  }

  // Uploads only the changed rectangle of the working photo (Stamp paints live).
  updateSourceRect(work, x, y, w, h) {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.tex.src);
    gl.pixelStorei(gl.UNPACK_ROW_LENGTH, work.width);
    gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, x);
    gl.pixelStorei(gl.UNPACK_SKIP_ROWS, y);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, x, y, w, h, gl.RGBA, gl.UNSIGNED_BYTE, work.data);
    gl.pixelStorei(gl.UNPACK_ROW_LENGTH, 0);
    gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, 0);
    gl.pixelStorei(gl.UNPACK_SKIP_ROWS, 0);
    this.stale = { smooth: true, blurM: true, blurS: true, flow: true };
    this.version++;
  }

  setSmoothing(radiusPx, blurSigmaPx, smallSigmaPx = blurSigmaPx / 3.5) {
    if (radiusPx === this.smoothRadius && blurSigmaPx === this.blurSigma && smallSigmaPx === this.smallSigma) return;
    this.smoothRadius = radiusPx;
    this.blurSigma = blurSigmaPx;
    this.smallSigma = smallSigmaPx;
    this.stale.smooth = this.stale.blurM = this.stale.blurS = this.stale.flow = true;
    this.version++;
  }

  // Painted masks come from canvases; their alpha is the mask.
  setLayer(name, canvas) {
    const cur = this.tex[name];
    if (!cur || this.shared.has(cur)) this.swap(name, this.makeTexture(canvas.width, canvas.height, { data: canvas }));
    else this.upload(cur, canvas.width, canvas.height, canvas);
    if (name === 'erase') return;      // the eraser preview never changes the retouch itself
    if (Object.values(PAINT_PACKS).some((l) => l.includes(name))) this.paintVersion++;
    this.version++;
  }

  // A layer back to untouched (no canvas yet).
  clearLayer(name) {
    this.swap(name, OVERRIDE_LAYERS.has(name) ? this.half : name === 'person' ? this.solid : this.blank);
    this.paintVersion++;
    this.version++;
  }

  ensurePaint() {
    const key = `${this.paintVersion}`;
    if (key === this.paintKey) return;
    for (const [target, names] of Object.entries(PAINT_PACKS)) {
      const [a, b, c, d] = names.map((n) => (n ? this.tex[n] : this.blank));
      this.run('pack', this.t[target], { uA: a, uB: b, uC: c, uD: d });
    }
    this.paintKey = key;
  }

  setFeatures(feat, feat2, w, h, strict) {
    const gl = this.gl;
    this.swap('feat', feat ? this.makeTexture(w, h, { data: feat }) : this.blank);
    this.swap('feat2', feat2 ? this.makeTexture(w, h, { data: feat2 }) : this.blank);
    this.swap('strict', strict ? this.makeTexture(w, h, { internal: gl.R8, format: gl.RED, data: strict }) : this.blank);
    this.version++;
  }

  setMakeup(m) {
    this.swap('feat3', m ? this.makeTexture(m.w3, m.h3, { data: m.feat3 }) : this.blank);
    this.swap('feat4', m ? this.makeTexture(m.w4, m.h4, { data: m.feat4 }) : this.blank);
    this.version++;
  }

  // Multi-class segmentation as RGBA: r hair, g body skin, b face skin, a clothes.
  setSeg(data, w, h) {
    this.swap('seg', data ? this.makeTexture(w, h, { data }) : this.blank);
    this.version++;
  }

  // Draws the region templates through each face's mesh into the four map textures.
  setFaceMaps(meshes, atlases) {
    const gl = this.gl;
    if (!meshes || !meshes.length) {
      for (const m of MAPS) this.swap(m, this.blank);
      this.version++;
      return;
    }
    if (!this.atlas) {
      this.atlas = {};
      for (const m of MAPS) {
        this.atlas[m] = this.makeTexture(512, 512, { data: atlases[m] });
        this.shared.add(this.atlas[m]);
      }
    }
    const prog = this.programs.mesh;
    gl.bindVertexArray(this.meshVao);
    gl.useProgram(prog.p);
    gl.enable(gl.BLEND);
    gl.blendEquation(gl.MAX);
    for (const m of MAPS) {
      const t = this.target(`map-${m}`, 'mask');
      gl.bindFramebuffer(gl.FRAMEBUFFER, t.fbo);
      gl.viewport(0, 0, t.w, t.h);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      for (const f of meshes) {
        gl.bindBuffer(gl.ARRAY_BUFFER, this.meshPos);
        gl.bufferData(gl.ARRAY_BUFFER, f.pos, gl.DYNAMIC_DRAW);
        gl.bindBuffer(gl.ARRAY_BUFFER, this.meshUv);
        gl.bufferData(gl.ARRAY_BUFFER, f.uv, gl.DYNAMIC_DRAW);
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.meshIdx);
        gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, f.indices, gl.STATIC_DRAW);
        this.bindUniforms(prog, { uAtlas: this.atlas[m], uFar: m === 'sculpt' ? f.far : 0 });
        gl.drawElements(gl.TRIANGLES, f.indices.length, gl.UNSIGNED_SHORT, 0);
      }
      this.tex[m] = t.tex;
      this.shared.add(t.tex);
    }
    gl.blendEquation(gl.FUNC_ADD);
    gl.disable(gl.BLEND);
    gl.bindVertexArray(this.quadVao);
    this.version++;
  }

  setNormalMap(n) {
    this.swap('normal', n ? this.makeTexture(n.nw, n.nh, { data: n.data }) : this.flatNormal);
  }

  setBgImage(canvas) {
    this.swap('bgImage', canvas ? this.makeTexture(canvas.width, canvas.height, { data: canvas }) : this.blank);
    this.version++;
  }

  // The cut-out ('person') refined onto the photo's edges (hair has its own matte: setHairMatte):
  // guidedCoeffs' coefficients, m = { w, h, ab (a and b as RGBA floats), lh (inner and outer limits,
  // two bytes a pixel) } at grid size, or null for the layer as painted.
  setMatte(name, m) {
    const gl = this.gl;
    this.swap(`${name}AB`, m ? this.makeTexture(m.w, m.h, { internal: gl.RGBA16F, format: gl.RGBA, type: gl.FLOAT, data: m.ab }) : this.blank);
    this.swap(`${name}LH`, m ? this.makeTexture(m.w, m.h, { internal: gl.RG8, format: gl.RG, data: m.lh }) : this.blank);
    this.mattes[name] = m ? 'stale' : null;
    this.version++;
  }

  // Hair's matte (refineHair in main.js): m = { w, h, fb, bb, lh (RGBA bytes) } at quarter size, or
  // null for the layer as painted.
  setHairMatte(m) {
    const gl = this.gl;
    this.swap('hairFB', m ? this.makeTexture(m.w, m.h, { data: m.fb }) : this.blank);
    this.swap('hairBB', m ? this.makeTexture(m.w, m.h, { data: m.bb }) : this.blank);
    this.swap('hairLH', m ? this.makeTexture(m.w, m.h, { data: m.lh }) : this.blank);
    this.mattes.hair = m ? 'stale' : null;
    this.version++;
  }

  // The refined layer at full size, drawn the first time it is needed after setMatte: for hair, its
  // share in alpha and the hair's own colour in RGB.
  matteTex(name) {
    if (!this.mattes[name]) return this.tex[name];
    const t = this.target(`matte-${name}`, 'full');
    if (this.mattes[name] === 'stale') {
      const hair = { uSrc: this.tex.orig, uFB: this.tex.hairFB, uBB: this.tex.hairBB, uLH: this.tex.hairLH, uTexel: [1 / this.W, 1 / this.H] };
      if (name === 'hair') this.run('hairmatte', t, hair);
      else this.run('matte', t, { uSrc: this.tex.orig, uAB: this.tex[`${name}AB`], uLH: this.tex[`${name}LH`] });
      this.mattes[name] = 'ready';
    }
    return t.tex;
  }

  // Blurs of the hair alone (weighted by its share) at half size, at the scales of the small and
  // mid blurs: what the hair pass judges each pixel's light against.
  ensureHairRefs(hair, matte, src) {
    const s = this.target('hairRefS', 'half'), m = this.target('hairRefM', 'half');
    const key = `${this.version}|${matte}|${src === this.tex.src}`;
    if (key !== this.hairRefKey) {
      const tmp = this.target('hairRefT', 'half');
      this.run('hairprep', m, { uSrc: src, uHair: hair, uOffset: [0.5 / this.W, 0.5 / this.H], uHairMatte: matte });
      this.run('copy', s, { uSrc: m.tex, uOffset: [0, 0] });
      this.gaussian(s, tmp, s, Math.max(0.6, this.smallSigma / 2));
      this.gaussian(m, tmp, m, this.blurSigma / 2);
      this.hairRefKey = key;
    }
    return [s, m];
  }

  // Added people: canvases (straight alpha) in the order they were added.
  setPeople(canvases) {
    for (let i = 0; i < 5; i++) this.swap(`p${i}`, canvases[i] ? this.makeTexture(canvases[i].width, canvases[i].height, { data: canvases[i] }) : this.blank);
    this.version++;
  }

  // A filter's colour table (33³, see luts.js), kept for the session once made.
  ensureLut(id, build) {
    if (!this.luts.has(id)) this.luts.set(id, this.makeTexture(1089, 33, { data: build() }));
    return id;
  }

  setText(canvas) {
    this.swap('text', canvas ? this.makeTexture(canvas.width, canvas.height, { data: canvas }) : this.blank);
  }

  setWarp(field, gw, gh) {
    const gl = this.gl;
    this.swap('warp', field ? this.makeTexture(gw, gh, { internal: gl.RG16F, format: gl.RG, type: gl.FLOAT, data: field }) : this.zeroWarp);
  }

  // A second warp used only while comparing one tool (its "before" shape).
  setTempWarp(w) {
    const gl = this.gl;
    if (this.tex.tempWarp && !this.shared.has(this.tex.tempWarp)) gl.deleteTexture(this.tex.tempWarp);
    this.tex.tempWarp = w === undefined ? null : w ? this.makeTexture(w.gw, w.gh, { internal: gl.RG16F, format: gl.RG, type: gl.FLOAT, data: w.field }) : this.zeroWarp;
  }

  gaussian(src, tmp, dst, sigmaPx) {
    const stride = Math.max(1, sigmaPx / 6);
    const taps = Math.min(32, Math.ceil((2.5 * sigmaPx) / stride));
    const sigma = sigmaPx / stride;
    this.run('gauss', tmp, { uSrc: src.tex, uStep: [stride / src.w, 0], uSigma: sigma, uTaps: taps });
    this.run('gauss', dst, { uSrc: tmp.tex, uStep: [0, stride / tmp.h], uSigma: sigma, uTaps: taps });
  }

  ensureSmooth() {
    if (!this.stale.smooth) return;
    this.run('bilateral', this.t.smooth, {
      uSrc: this.tex.src, uTexel: [1 / this.W, 1 / this.H], uRadius: this.smoothRadius, uSigmaR: 0.085,
    });
    this.stale.smooth = false;
  }

  // Hair › Care: the strands' direction (FLOW) at half size, blurred over about 1% of the face so
  // frizz takes the direction of the hair's main flow.
  ensureFlow() {
    const f = this.target('flow', 'half');
    if (this.stale.flow) {
      this.run('flow', f, { uSrc: this.tex.src, uTexel: [1 / this.W, 1 / this.H] });
      this.gaussian(f, this.target('flowTmp', 'half'), f, Math.max(1.5, this.smallSigma * 0.4));
      this.stale.flow = false;
    }
    return f;
  }

  // Mid-scale blur (about 4.5% of the face), mipmapped so the retouch pass can also read a much
  // wider blur from it for the fillers.
  ensureBlurM() {
    if (!this.stale.blurM) return;
    const gl = this.gl;
    const { half, halfTmp } = this.t;
    this.run('copy', half, { uSrc: this.tex.src, uOffset: [0.5 / this.W, 0.5 / this.H] });
    this.gaussian(half, halfTmp, half, this.blurSigma / 2);
    gl.bindTexture(gl.TEXTURE_2D, half.tex);
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    this.stale.blurM = false;
  }

  // Small-scale blur (about 1.3% of the face): the scale of creases and spots.
  ensureBlurS() {
    if (!this.stale.blurS) return;
    const { small, halfTmp } = this.t;
    this.run('copy', small, { uSrc: this.tex.src, uOffset: [0.5 / this.W, 0.5 / this.H] });
    this.gaussian(small, halfTmp, small, Math.max(0.6, this.smallSigma / 2));
    this.stale.blurS = false;
  }

  // The background with the subject filled in from around it (push-pull from clear background
  // only), at half size and below. Blur blurs it, so the subject's colour never spreads into the
  // background, and the composite reads what lies behind the subject's edge from it.
  ensureBgPlate(src, person, pkey) {
    const key = `${this.version}|${src === this.tex.orig}|${pkey}`;
    const levels = ['half', 'quarter', 'eighth', 'sixteenth', 's32', 's64'];
    const up = levels.map((k, i) => this.target(`bgPlate${i}`, k));
    if (key === this.bgPlateKey) return up;
    const down = levels.map((k, i) => this.target(`bgPlateD${i}`, k));
    this.run('bgprep', down[0], { uSrc: src, uMask: person, uOffset: [0.5 / this.W, 0.5 / this.H], uUseMask: 1, uInvert: 0, uSure: 1 });
    for (let i = 1; i < down.length; i++) this.run('copy', down[i], { uSrc: down[i - 1].tex, uOffset: [0.5 / down[i - 1].w, 0.5 / down[i - 1].h] });
    const last = down.length - 1;
    this.run('upfill', up[last], { uFine: down[last].tex, uCoarse: down[last].tex });
    for (let i = last - 1; i >= 0; i--) this.run('upfill', up[i], { uFine: down[i].tex, uCoarse: up[i + 1].tex });
    this.bgPlateKey = key;
    return up;
  }

  // Blurred background (Gaussian or a shaped bokeh) of the plate, or of a swapped-in background photo.
  ensureBackground(sigmaPx, shape, gamma, swapPhoto, plate, pkey) {
    const key = `${sigmaPx.toFixed(2)}|${shape}|${gamma}|${swapPhoto}|${this.bgPlateKey}|${pkey}`;
    if (key === this.bgKey) return;
    const { quarter, quarterTmp, bgOut } = this.t;
    let from = plate;
    if (swapPhoto) {
      this.run('bgprep', quarter, { uSrc: this.tex.bgImage, uMask: this.blank, uOffset: [1 / this.W, 1 / this.H], uUseMask: 0, uInvert: 0, uSure: 0 });
      from = quarter;
    }
    if (shape) {
      this.run('bokeh', bgOut, {
        uSrc: from.tex, uTexel: [1 / from.w, 1 / from.h], uRadius: Math.max(1, sigmaPx / 4) * 1.6, uShape: shape, uGamma: gamma,
      });
    } else {
      this.gaussian(from, quarterTmp, bgOut, Math.max(0.5, sigmaPx / 4));
    }
    this.bgKey = key;
  }

  // The cut-out (refined when c.matte is set) with its edge grown, shrunk or softened (Background › Edge).
  personFor(c) {
    const base = c.matte ? this.matteTex('person') : this.tex.person;
    if (!c.uEdge && !c.uEdgeSoft) return base;
    const key = `${c.uEdge}|${c.uEdgeSoft}|${c.matte}|${this.version}`;
    const a = this.target('edgeA', 'full'), b = this.target('edgeB', 'full');
    if (key !== this.edgeKey) {
      const d = Math.hypot(this.W, this.H);
      this.run('edge', a, { uSrc: base, uTexel: [1 / this.W, 1 / this.H], uGrow: c.uEdge * 0.012 * d });
      if (c.uEdgeSoft > 0) this.gaussian(a, b, a, Math.max(0.5, c.uEdgeSoft * 0.006 * d));
      this.edgeKey = key;
    }
    return a.tex;
  }

  // Background Blend and Shadow: blurred copies of the subject alone, the background alone, and
  // of the cut-out itself.
  ensureLows(c, src, retouched, person, swapPhoto) {
    const key = `${c.uBlend > 0}|${c.uBgShadow > 0}|${swapPhoto}|${this.compKey}|${person === this.tex.person}|${this.version}`;
    if (key === this.lowKey) return;
    const diag = Math.hypot(this.W, this.H);
    const q = this.target('lowQ', 'quarter'), e = this.target('lowE', 'eighth'), et = this.target('lowT', 'eighth');
    if (c.uBlend > 0) {
      const subj = this.target('subjLow', 'eighth'), bg = this.target('bgLow', 'eighth');
      this.run('bgprep', q, { uSrc: retouched, uMask: person, uOffset: [1 / this.W, 1 / this.H], uUseMask: 1, uInvert: 1, uSure: 0 });
      this.run('copy', subj, { uSrc: q.tex, uOffset: [0.5 / q.w, 0.5 / q.h] });
      this.gaussian(subj, et, subj, Math.max(1, (diag * 0.05) / 8));
      this.run('bgprep', q, { uSrc: swapPhoto ? this.tex.bgImage : src, uMask: person, uOffset: [1 / this.W, 1 / this.H], uUseMask: swapPhoto ? 0 : 1, uInvert: 0, uSure: 0 });
      this.run('copy', bg, { uSrc: q.tex, uOffset: [0.5 / q.w, 0.5 / q.h] });
      this.gaussian(bg, et, bg, Math.max(1, (diag * 0.05) / 8));
    }
    if (c.uBgShadow > 0) {
      const soft = this.target('personSoft', 'eighth');
      this.run('copy', e, { uSrc: person, uOffset: [0.5 / e.w, 0.5 / e.h] });
      this.gaussian(e, et, soft, Math.max(1, (diag * 0.02) / 8));
    }
    this.lowKey = key;
  }

  // opts.useOrig: composite from the untouched photo (comparing heal-based tools).
  composite(c, opts = {}) {
    const key = JSON.stringify(c) + '|' + this.version + '|' + Boolean(opts.useOrig);
    if (key === this.compKey) return;
    const src = opts.useOrig ? this.tex.orig : this.tex.src;
    const texel = [1 / this.W, 1 / this.H];
    let base = src;
    if (c.uDenoise > 0) {
      const dn = this.target('denoise', 'full');
      this.run('denoise', dn, { uSrc: src, uTexel: texel, uAmt: c.uDenoise });
      base = dn.tex;
    }
    let retouched = base;
    if (c.retouch) {
      if (c.uSmoothAmt > 0 || c.uDarkCircle > 0) this.ensureSmooth();
      this.ensureBlurM();
      this.ensureBlurS();
      this.ensurePaint();
      this.run('retouch', this.t.retouch, {
        ...c,
        uSrc: base, uSmooth: this.t.smooth.tex, uBlurS: this.t.small.tex, uBlurM: this.t.half.tex, uFeat: this.tex.feat, uFeat2: this.tex.feat2,
        uStrict: this.tex.strict, uPaintA: this.t.paintA.tex, uPaintB: this.t.paintB.tex, uCreaseMap: this.tex.crease, uZoneMap: this.tex.zone,
        uFillMap: this.tex.fill, uSculptMap: this.tex.sculpt, uSeg: this.tex.seg, uPerson: this.tex.person, uAgeMap: this.tex.age, uTexel: texel,
        uImgSize: [this.W, this.H],
      });
      retouched = this.t.retouch.tex;
    }
    const hairCare = c.uHairShine + c.uHairSmooth + c.uHairTex + c.uHairEnrich + c.uHairOil > 0;
    if (hairCare || c.uHairAmt > 0 || c.uAgeGrey > 0) {
      const hair = c.uHairMatte ? this.matteTex('hair') : this.tex.hair;
      const [hs, hm] = this.ensureHairRefs(hair, c.uHairMatte, base);
      const out = this.target('hairOut', 'full');
      this.run('hair', out, {
        ...c, uSrc: retouched, uHair: hair, uHairS: hs.tex, uHairM: hm.tex, uFlow: hairCare || c.uAgeGrey > 0 ? this.ensureFlow().tex : this.blank, uTexel: texel,
        uImgSize: [this.W, this.H],
      });
      retouched = out.tex;
    }
    const person = this.personFor(c);
    this.personTex = person;
    const swapPhoto = c.uBgSwap > 1.5;
    const bgFx = c.uBgBlur > 0 || c.uBgSwap > 0.5 || c.uBgBright !== 0 || c.uBgShadow > 0 || c.uBlend > 0 || c.uBgMono > 0;
    // The plate comes from the cut-out before Edge: hair that Shrink gives up must not count as background.
    const plate = bgFx ? this.ensureBgPlate(src, c.matte ? this.matteTex('person') : this.tex.person, `${c.matte}`) : null;
    if (c.uBgBlur > 0) this.ensureBackground(c.bgSigma, c.bokeh, c.bokehGamma, swapPhoto, plate[1], `${c.matte}`);
    if (c.uBlend > 0 || c.uBgShadow > 0) this.ensureLows(c, src, retouched, person, swapPhoto);
    this.compArgs = {
      ...c,
      uSrc: retouched, uPerson: person, uPersonSoft: this.lazy.personSoft?.tex || this.blank,
      uFeat: this.tex.feat, uFeat2: this.tex.feat2, uFeat3: this.tex.feat3, uFeat4: this.tex.feat4,
      uBG: this.t.bgOut.tex, uBgImage: this.tex.bgImage, uBgLow: this.lazy.bgLow?.tex || this.blank, uSubjLow: this.lazy.subjLow?.tex || this.blank,
      uBgPlate: plate ? plate[0].tex : this.blank,
      uTexel: texel, uImgSize: [this.W, this.H],
    };
    this.run('composite', this.t.comp, this.compArgs);
    this.out = this.t.comp;
    this.compPeople = null;
    if (c.people && c.people.length) {
      const pt = this.target('people', 'full');
      const uPT = new Float32Array(20);
      c.people.slice(0, 5).forEach((p, i) => uPT.set(p, i * 4));
      this.compPeople = { uP0: this.tex.p0, uP1: this.tex.p1, uP2: this.tex.p2, uP3: this.tex.p3, uP4: this.tex.p4, uPT, uPCount: Math.min(5, c.people.length) };
      this.run('people', pt, { ...this.compPeople, uSrc: this.t.comp.tex });
      this.out = pt;
    }
    this.compKey = key;
  }

  // Background Freeze's plate (see inpaint.js): the photo at half size with the subject's area filled
  // in, that area in alpha.
  setFreezePlate(rgba, w, h) {
    this.swap('freezePlate', rgba ? this.makeTexture(w, h, { data: rgba }) : this.blank);
    this.freezeKey = '';
  }

  // Background Freeze's layer: the finished scene without the subject, for the reshape warp to
  // move the subject over (added people stay in it, in front of the background).
  ensureFreezeLayer() {
    if (this.freezeKey === this.compKey) return this.freezeOut.tex;
    let out = this.target('freezeBg', 'full');
    this.run('freezebg', out, { ...this.compArgs, uSrc: this.t.comp.tex, uFreezePlate: this.tex.freezePlate });
    if (this.compPeople) {
      const pt = this.target('freezePeople', 'full');
      this.run('people', pt, { ...this.compPeople, uSrc: out.tex });
      out = pt;
    }
    this.freezeOut = out;
    this.freezeKey = this.compKey;
    return out.tex;
  }

  // Blurred copies of the retouched photo: "local" (about 1.2% of the diagonal) for Clarity,
  // Ambience and Dehaze; "glow" (about 3.5%) for Glow, Soft focus and Relight's shadow lift and
  // haze. Rebuilt when the retouch changes.
  ensureDerived(grade) {
    const diag = Math.hypot(this.W, this.H);
    if ((grade.uClarity || grade.uAmbience || grade.uDehaze || grade.uHalation) && this.localKey !== this.compKey) {
      const { local, quarterTmp } = this.t;
      this.run('copy', local, { uSrc: this.out.tex, uOffset: [1 / this.W, 1 / this.H] });
      this.gaussian(local, quarterTmp, local, Math.max(1, (0.012 * diag) / 4));
      this.localKey = this.compKey;
    }
    const relightGlow = grade.uRelight && (grade.uLift || grade.uHaze);
    if ((grade.uGlowAmt || grade.uSoftFocus || relightGlow) && this.glowKey !== this.compKey) {
      const { glow, glowTmp } = this.t;
      this.run('copy', glow, { uSrc: this.out.tex, uOffset: [2 / this.W, 2 / this.H] });
      this.gaussian(glow, glowTmp, glow, Math.max(1, (0.035 * diag) / 8));
      this.glowKey = this.compKey;
    }
  }

  finalValues(g, extra, opts = {}) {
    return {
      ...g, ...extra,
      uImg: this.out.tex, uOrig: this.tex.orig, uLocal: this.t.local.tex, uGlow: this.t.glow.tex, uText: this.tex.text,
      uBgLayer: g.uFreeze ? this.ensureFreezeLayer() : this.blank, uMatte: g.uFreeze ? this.matteTex('person') : this.blank,
      uLut: (g.lutId && this.luts.get(g.lutId)) || this.blank, uGlitterMask: this.tex.glitter,
      uWarp: opts.tempWarp && this.tex.tempWarp ? this.tex.tempWarp : this.tex.warp,
      uNormal: this.tex.normal, uPerson: this.tex.person,
      // Fix edges tints the cut-out the background tools actually use (refined, grown or shrunk).
      uOverlayTex: (opts.overlayLayer === 'person' && this.personTex) || this.tex[opts.overlayLayer || 'skin'] || this.blank,
      uImgSize: [this.W, this.H],
    };
  }

  // view: { a: [ax, ay], b: [bx, by] } maps a canvas pixel (top-left origin) to output uv.
  // geo: crop and lens uniforms (or null); outSize: the output frame in pixels.
  // opts: original, useOrig, tempWarp, overlay, overlayLayer, overlayInvert, overlayMode, overlayColor.
  drawScreen(comp, grade, view, geo, opts = {}) {
    const gl = this.gl;
    this.composite(comp, opts);
    if (!opts.original) this.ensureDerived(grade);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    this.run('final', null, this.finalValues(grade, {
      ...geoValues(geo, this.W, this.H),
      uView: [view.a[0], view.a[1], view.b[0], view.b[1]], uFlip: 1, uCanvasH: gl.drawingBufferHeight,
      uShowOrig: opts.original ? 1 : 0, uOverlay: opts.overlay || 0, uOverlayInvert: opts.overlayInvert ? 1 : 0,
      uOverlayMode: opts.overlayMode || 0, uOverlayColor: opts.overlayColor || [1, 0.3, 0.5],
    }, opts));
  }

  // Renders the edit at w × h and returns ImageData. rect picks a part of the output as
  // [x, y, width, height] in 0–1 units (a face crop for thumbnails); geo applies crop and lens.
  renderPixels(comp, grade, w = this.W, h = this.H, rect = [0, 0, 1, 1], geo = null) {
    const gl = this.gl;
    this.composite(comp);
    this.ensureDerived(grade);
    const small = !geo && w < this.W * rect[2];
    if (small) {
      // Thumbnails sample a mipmapped copy so they stay smooth instead of aliasing.
      gl.bindTexture(gl.TEXTURE_2D, this.out.tex);
      if (this.mipKey !== this.compKey) {
        gl.generateMipmap(gl.TEXTURE_2D);
        this.mipKey = this.compKey;
      }
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    }
    const target = this.makeTarget(w, h);
    this.run('final', target, this.finalValues(grade, {
      ...geoValues(geo, this.W, this.H),
      uView: [rect[2] / w, rect[3] / h, rect[0], rect[1]], uFlip: 0, uCanvasH: h, uShowOrig: 0, uOverlay: 0, uOverlayInvert: 0, uOverlayColor: [0, 0, 0],
    }));
    const px = new Uint8ClampedArray(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
    this.freeTarget(target);
    if (small) {
      gl.bindTexture(gl.TEXTURE_2D, this.out.tex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    }
    return new ImageData(px, w, h);
  }
}

// Shader settings for the crop and lens geometry (see geometry.js); none for thumbnails.
function geoValues(geo, W, H) {
  if (!geo) return { uGeo: 0, uOutSize: [W, H], uTextOn: 0 };
  return {
    uGeo: 1, uGeoM: geo.m, uCrop: geo.crop, uFrame: geo.frame, uStretch: geo.st, uLens: geo.lens,
    uOutSize: geo.out, uTextOn: geo.text ? 1 : 0,
  };
}
