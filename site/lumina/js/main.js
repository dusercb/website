// Lumina: app controller. Holds the edit state (plain data, so undo is a snapshot), turns it
// into shader settings, and drives the editor: a scrolling row of tools, and inside a tool its
// options row with ✗ / ✓, a slider floating over the photo, and the before/after buttons.

import { Renderer, OVERRIDE_LAYERS } from './gl.js';
import { Viewport, attachStageInput } from './gestures.js';
import { IDX, analyseFace, buildFaceMasks, skinModel, detectFaces, segmentPerson, segmentParts, detectPose, preloadFaceModel } from './face.js';
import { buildAtlases, faceMeshes } from './facemaps.js';
import { healSpot, findSpots, cloneBegin, cloneExtend, cloneStroke, STAMP_FEATHER } from './heal.js';
import { buildWarp, pushSegment, strokeDab, DAB_STEP, protectMask, protectField, gridSize, bodyActive } from './warp.js';
import { SCULPT_TABS, SCULPT_CONTROLS, SCULPT_BY_ID, sculptActive } from './sculpt.js';
import { MaskLayer } from './layers.js';
import { buildMakeupMasks } from './makeup.js';
import { RELIGHT_PRESETS, relightUniforms, buildNormalMap } from './relight.js';
import { NO_CROP, ASPECTS, geometry, toSource, toOutput, sourceScale, aspectRect, frameSize, frameY, isIdentity } from './geometry.js';
import { FONTS, TEXT_STYLES, TEXT_COLORS, TEXT_TEMPLATES, drawTexts, textAt, textBox, loadFont, fontCss } from './text.js';
import { guidedFilter, guidedCoeffs, blurFloat, rankFilter, spreadColour } from './blur.js';
import { fillSmooth, fillPatches, fillDetail } from './inpaint.js';
import {
  FILTERS, FILTER_CATS, LIP_COLORS, LIP_FINISHES, SHADOW_COLORS, LINER_COLORS, LINER_STYLES, LASH_STYLES, BLUSH_COLORS,
  BROW_COLORS, IRIS_COLORS, HAIR_COLORS, BG_SWAPS, LOOK_GROUPS, AUTO_RECIPE, PRESETS, PRESET_CATS, AGE_PARTS, AGE_LOOKS, AGE_GREYS, SKIN_TONES, GLOW_TYPES, SCULPT_STYLES,
  BOKEH_SHAPES, GLITTER_COLORS, SPARKLE_SHAPES, SPARKLE_COLORS, HAIR_STYLES, HAIR_STYLE_KEYS, hexToRgb,
} from './looks.js';
import { buildLut } from './luts.js';
import { prepareSaving, saveBlob } from './save.js';
import { icon, aspectIcon } from './icons.js';

// Phones get a smaller working size: the face model, WebGL and the photo share one tab's memory.
const MAX_SIDE = matchMedia('(pointer: coarse)').matches ? 1600 : 2048;
const MASK_SCALE = 0.5;
const HISTORY_LIMIT = 60;
const LOOKS_KEY = 'lumina.looks';
const FAVS_KEY = 'lumina.filterFavs';
const MAX_PEOPLE = 5;

const DEFAULTS = {
  auto: { on: false, amt: 0.6, spots: 0 },
  // Smoothing only applies where it is painted (or to the whole face when that is switched on).
  smooth: 0.6,
  even: 0.3,
  depth: 0,
  stubble: true,
  skinFace: false,
  strokes: [],
  heals: [],                       // in order: blemish taps, found spots, eraser dabs (e: 1), stamp strokes (c: 1)
  wrinkles: { forehead: 0, crows: 0, smile: 0, under: 0, brush: 0.7 },
  wrinkleStrokes: [],
  conceal: { dark: 0, light: 0, bags: 0, trough: 0, brush: 0.6 },
  concealStrokes: [],
  matte: { amt: 0.7, auto: false, hair: 0 },
  matteStrokes: [],
  texture: { amt: 0.5, size: 0.4, onSmooth: false },
  textureStrokes: [],
  details: { face: 0, body: 0, bg: 0, brush: 0.6 },
  detailStrokes: [],
  eyes: { bright: 0, iris: 0, circles: 0, redeye: 0, size: 0, color: 'none' },
  teeth: { white: 0, stains: 0, align: 0 },
  teethStrokes: [],
  skin: { tone: 'none', custom: '#c69072', amt: 0.5, redness: 0, glow: 'none', glowAmt: 0.6 },
  plump: { forehead: 0, temples: 0, cheeks: 0, sockets: 0, lips: 0 },
  // Age: the Age slider (t, −1 younger … 1 older), what Skin and Face changed by hand on top of its
  // course (off), and each part's value, −1…1 (looks.js AGE_PARTS).
  age: { t: 0, off: {}, shade: 'silver', ...Object.fromEntries(AGE_PARTS.map(([k]) => [k, 0])) },
  // Sculpt: per face, { [control]: [image-left value, image-right value] } for what has been moved.
  sculpt: { faces: [] },
  pushes: [],
  protectStrokes: [],
  protectInvert: false,
  freeze: false,
  body: { slim: 0, waist: 0, hips: 0, legs: 0, legRatio: 0, arms: 0, shoulders: 0, square: 0, tummy: 0, bellySmooth: 0, neck: 0, head: 0, posture: 0, tilt: 0, muscle: 0 },
  stretch: { amt: 0, y0: 0.55, y1: 0.95 },
  makeup: {
    // Fine-tune: per face index, { part: [dx, dy] } in face widths (parts in TUNE_PARTS).
    tune: {},
    look: 'none', lookAmt: 1,
    lip: 'none', lipAmt: 0.5, lipFinish: 'satin',
    shadow: 'none', shadowAmt: 0.45, shimmer: 0.3,
    liner: 'none', linerStyle: 'classic', linerAmt: 0.6,
    lashes: 'none', lashAmt: 0.6,
    brow: 'none', browAmt: 0.35,
    blush: 'none', blushAmt: 0.4,
    contour: 0, highlight: 0,
    freckles: 0,
  },
  contour: { style: 'none', amt: 0.6, jaw: 0 },      // Makeup › Contour's shading styles
  hair: {
    color: 'none', amt: 0.75, depth: 0.2, auto: false,
    shine: 0, smooth: 0, texture: 0, enrich: 0, oil: 0,     // Care
    volume: 0, hairline: 0,                                 // Shape
  },
  hairStrokes: [],
  relight: { preset: 'none', bright: 0, hue: 0, soft: 0, dir: [-0.55, -0.45] },
  filter: { id: 'none', amt: 0.8, protect: true },
  preset: { id: 'none', look: 0.8, bg: 0.6 },   // Presets: which one, and its Look and Background     // protect: skin keeps most of its own colour
  effects: { glow: 0, soft: 0, leak: 0, prism: 0, focus: [0.5, 0.42], halation: 0, dust: 0 },
  glitter: { amt: 0.8, color: 'gold', size: 0.4, all: false },
  glitterStrokes: [],
  sparkle: { shape: 'none', size: 0.5, amount: 0.4, angle: 0, color: 'white' },
  adjust: {
    brightness: 0, light: 0, contrast: 0, highlights: 0, shadows: 0, ambience: 0,
    saturation: 0, vibrance: 0, temperature: 0, tint: 0,
    clarity: 0, sharpen: 0, dehaze: 0, fade: 0, grain: 0, vignette: 0, denoise: 0,
  },
  bg: { blur: 0, bokeh: 0, hi: 0.35, mono: 0, swap: 'none', edge: 0, soft: 0, shadow: 0, shadowDir: 'down', blend: 0, bright: 0 },
  bgStrokes: [],
  people: [],                      // added from other photos: { id, x, y (centre, 0–1 of the photo), h (height, 0–1), flip }
  crop: structuredClone(NO_CROP),
  texts: [],
};

// Tools in AirBrush's order of use, by the group whose bottom tab shows them.
const TOOLS = [
  { id: 'auto', name: 'Auto', group: 'retouch', face: true },
  { id: 'smooth', name: 'Smooth', group: 'retouch' },
  { id: 'blemish', name: 'Blemish', group: 'retouch' },
  { id: 'eraser', name: 'Eraser', group: 'retouch' },
  { id: 'stamp', name: 'Stamp', group: 'retouch' },
  { id: 'wrinkles', name: 'Wrinkles', group: 'retouch' },
  { id: 'conceal', name: 'Concealer', group: 'retouch' },
  { id: 'matte', name: 'Matte', group: 'retouch' },
  { id: 'texture', name: 'Texture', group: 'retouch' },
  { id: 'details', name: 'Details', group: 'retouch' },
  { id: 'eyes', name: 'Eyes', group: 'face', face: true },
  { id: 'teeth', name: 'Teeth', group: 'face', face: true },
  { id: 'skin', name: 'Skin', group: 'face' },
  { id: 'plump', name: 'Fillers', group: 'face', face: true },
  { id: 'age', name: 'Age', group: 'face', face: true },
  { id: 'sculpt', name: 'Sculpt', group: 'face', face: true },
  { id: 'reshape', name: 'Reshape', group: 'face' },
  { id: 'body', name: 'Body', group: 'body' },
  { id: 'makeup', name: 'Makeup', group: 'makeup', face: true },
  { id: 'hair', name: 'Hair', group: 'makeup' },
  { id: 'relight', name: 'Relight', group: 'scene', face: true },
  { id: 'background', name: 'Background', group: 'scene' },
  { id: 'presets', name: 'Presets', group: 'colour' },
  { id: 'filters', name: 'Filters', group: 'colour' },
  { id: 'adjust', name: 'Adjust', group: 'colour' },
  { id: 'glitter', name: 'Glitter', group: 'colour' },
  { id: 'crop', name: 'Crop', group: 'edit' },
  { id: 'text', name: 'Text', group: 'edit' },
];
const GROUPS = [['retouch', 'Retouch'], ['face', 'Face'], ['body', 'Body'], ['makeup', 'Makeup'], ['scene', 'Scene'], ['colour', 'Colour'], ['edit', 'Edit']];
const toolName = (id) => TOOLS.find((t) => t.id === id)?.name || '';

// AirBrush's Adjust controls (evidence/android/strings_en.json), grouped Light / Colour / Detail.
// [state key, label, slider minimum]
const ADJUST_GROUPS = {
  light: [['brightness', 'Brightness', -100], ['light', 'Light', -100], ['contrast', 'Contrast', -100],
    ['highlights', 'Highlights', -100], ['shadows', 'Shadows', -100], ['ambience', 'Ambience', -100]],
  colour: [['saturation', 'Saturation', -100], ['vibrance', 'Vibrance', -100], ['temperature', 'Temperature', -100],
    ['tint', 'Tint', -100]],
  detail: [['clarity', 'Clarity', -100], ['sharpen', 'Sharpen', 0], ['denoise', 'Denoise', 0], ['dehaze', 'Dehaze', -100],
    ['fade', 'Fade', 0], ['grain', 'Grain', 0], ['vignette', 'Vignette', -100]],
};

// AirBrush's makeup parts (makeup_part_* in the app's text), plus its preset looks.
const MAKEUP_PARTS = [['looks', 'Looks'], ['lips', 'Lips'], ['shadow', 'Eyeshadow'], ['liner', 'Eyeliner'],
  ['lashes', 'Lashes'], ['brows', 'Brows'], ['blush', 'Blush'], ['contour', 'Contour'], ['freckles', 'Freckles'], ['eyes', 'Eye colour']];
// Amounts a look's Intensity scales.
const LOOK_SCALED = ['lipAmt', 'shadowAmt', 'linerAmt', 'lashAmt', 'browAmt', 'blushAmt', 'contour', 'highlight', 'freckles'];

// What each tool's Reset clears (Blemish, Eraser, Stamp and Auto are handled apart).
const TOOL_KEYS = {
  smooth: ['smooth', 'even', 'depth', 'stubble', 'skinFace', 'strokes'],
  wrinkles: ['wrinkles', 'wrinkleStrokes'], conceal: ['conceal', 'concealStrokes'], matte: ['matte', 'matteStrokes'],
  texture: ['texture', 'textureStrokes'], details: ['details', 'detailStrokes'],
  eyes: ['eyes'], teeth: ['teeth', 'teethStrokes'], skin: ['skin'], plump: ['plump'], age: ['age'], sculpt: ['sculpt'],
  makeup: ['makeup', 'contour'], hair: ['hair', 'hairStrokes'], reshape: ['pushes', 'protectStrokes', 'protectInvert'], body: ['body', 'stretch'],
  relight: ['relight'], background: ['bg', 'bgStrokes', 'people'], filters: ['filter', 'effects'], adjust: ['adjust'],
  glitter: ['glitter', 'glitterStrokes', 'sparkle'],
  crop: ['crop'], text: ['texts'],
};

// Painted layers: their strokes in the edit state, and which tool paints which layer.
const LAYER_STROKES = {
  skin: 'strokes', hair: 'hairStrokes', person: 'bgStrokes', wrinkle: 'wrinkleStrokes', conceal: 'concealStrokes',
  texture: 'textureStrokes', detail: 'detailStrokes', matte: 'matteStrokes', teeth: 'teethStrokes', glitter: 'glitterStrokes',
  protect: 'protectStrokes',
};
const BRUSH_LAYER = {
  smooth: 'skin', hair: 'hair', background: 'person', wrinkles: 'wrinkle', conceal: 'conceal', texture: 'texture',
  details: 'detail', matte: 'matte', teeth: 'teeth', glitter: 'glitter',
};
// Painted layers redrawn straight from their strokes on undo and reset.
const PLAIN_LAYERS = ['wrinkle', 'conceal', 'texture', 'detail', 'matte', 'teeth', 'glitter', 'protect'];

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const getPath = (o, p) => p.split('.').reduce((x, k) => x[k], o);
const setPath = (o, p, v) => {
  const ks = p.split('.');
  const last = ks.pop();
  ks.reduce((x, k) => x[k], o)[last] = v;
};
const nextFrame = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
// iOS Safari counts canvas memory until garbage collection; shrinking a canvas frees it now.
const release = (...canvases) => canvases.forEach((c) => { c.width = c.height = 0; });
const healKind = (h) => (h.c ? 'stamp' : h.e ? 'eraser' : 'blemish');
const anyOf = (o, keys) => keys.some((k) => Boolean(o[k]));

const app = {
  W: 0,
  H: 0,
  canvas: null,
  orig: null,
  work: null,
  faces: [],
  masks: null,
  skin: null,
  seg: null,              // the subject mask, at mask size (combinePerson)
  segSelfie: null,        // … as the selfie model found it
  segParts: null,         // … as the hair-and-skin model found it
  segFailed: false,
  personReady: false,     // background tools have a subject: from the model or brushed in
  personPending: null,
  personVersion: 0,
  matteVersion: -1,       // the personVersion the refined cut-out was made from
  hairVersion: 0,         // bumped when Hair's area changes
  hairMatteVersion: -1,   // … and the one its refined area was made from
  guide: null,            // the photo at quarter size, for refining areas
  matteNear: null,        // the cut-out blurred at quarter size: where the refined cut-out can reach
  workVersion: 0,         // bumped when spot heals or Stamp change the photo
  freezeKey: '',          // what Background Freeze's plate was made from
  freezeJob: 0,           // the patch fill running for it
  parts: null,            // hair (refined) from the multi-class model, at mask size
  partsPending: null,
  partsFailed: false,
  segOn: false,           // hair, body skin and face skin are known
  pose: null,             // body landmarks for Body
  posePending: null,
  poseFailed: false,
  cutouts: new Map(),     // added people's cut-out canvases by id
  bgImageReady: false,
  warp: null,
  warpDirty: true,
  makeupKey: '',
  normalKey: '',
  geo: null,              // crop and stretch geometry of what is on screen
  geoScale: 1,            // photo px per output px
  textKey: '',
  textCanvas: null,
  stamp: { src: null, offset: null, picking: true },
  sel: { text: null, person: null },
  live: null,
  state: structuredClone(DEFAULTS),
  history: [],
  index: -1,
  view: 'main',           // 'main': the tool row; 'tool': one tool's options
  tool: null,
  lastTool: null,         // the main row scrolls back to it
  entryIndex: 0,          // history position when the open tool was entered (✗ returns to it)
  mainGroup: 'retouch',
  tab: {
    eyes: 'enhance', makeup: 'looks', hair: 'paint', sculpt: 'face', relight: 'studio', background: 'blur', filters: 'filters',
    adjust: 'light', wrinkles: 'auto', conceal: 'auto', matte: 'auto', details: 'areas', teeth: 'whiten', skin: 'tone', body: 'shape',
    crop: 'crop', text: 'font', glitter: 'glitter', reshape: 'push', presets: 'natural', age: 'look',
  },
  // What the floating slider controls, per tool (or part).
  param: {
    smooth: 'smooth', eyes: 'eyes.bright', hair: 'hair.amt', sculpt: 'slim', relight: 'relight.bright',
    hairCare: 'hair.shine', hairShape: 'hair.volume',
    adjust: 'adjust.brightness', effects: 'effects.glow', contour: 'makeup.contour', shadow: 'makeup.shadowAmt', bg: 'bg.blur',
    wrinkles: 'wrinkles.forehead', conceal: 'conceal.dark', matte: 'matte.amt', details: 'details.face', teeth: 'teeth.white',
    plump: 'plump.forehead', body: 'body.waist', bgAdjust: 'bg.edge', crop: 'crop.angle', lens: 'crop.persV', textStyle: 'size',
    glitter: 'glitter.amt', sparkle: 'sparkle.size', ageLook: 'age.t',
  },
  sculptSide: 'both',     // which side of the face the Sculpt sliders edit
  sculptFace: -1,         // which face they edit (−1: all)
  mode: { smooth: 'add', hair: 'add', background: 'remove', wrinkles: 'add', conceal: 'add', texture: 'add', details: 'add', matte: 'add', teeth: 'add', glitter: 'add', reshape: 'add' },
  showMask: false,
  pushStrength: 'heavy',  // Reshape › Push: 'light' or 'heavy'
  stampFeather: STAMP_FEATHER,
  tuneOn: false,          // Makeup › Fine-tune: dots shown and draggable
  bgTap: false,           // Background › Fix edges › Tap object
  textTemplate: null,     // Text › Templates: the look a new text starts with
  resizeDir: 'grow',      // Reshape › Resize: 'grow' or 'shrink'
  protectVersion: 0,
  protectGrid: null,
  lookGroup: 'natural',
  filterCat: 'all',
  brushSize: 0.4,
  blemishSize: 0.4,
  faceStatus: 'idle',
  isSample: false,
  comparing: null,
  beforeState: null,
  beforeFlags: {},
  pendingAuto: false,
  loadToken: 0,
};

const layers = {
  skin: new MaskLayer(MASK_SCALE),
  person: new MaskLayer(MASK_SCALE, { hard: true, base: 255 }),
  hair: new MaskLayer(MASK_SCALE),
  erase: new MaskLayer(MASK_SCALE, { hard: true }),
  wrinkle: new MaskLayer(MASK_SCALE),
  conceal: new MaskLayer(MASK_SCALE),
  texture: new MaskLayer(MASK_SCALE),
  detail: new MaskLayer(MASK_SCALE),
  matte: new MaskLayer(MASK_SCALE, { base: 128 }),
  teeth: new MaskLayer(MASK_SCALE, { base: 128 }),
  glitter: new MaskLayer(MASK_SCALE),
  protect: new MaskLayer(MASK_SCALE, { hard: true }),
};

// ---------- renderer and stage ----------

const stage = $('#stage');
const view = $('#view');
// The photo fits above the slider's place, so floating controls never cover it at fit size.
const vp = new Viewport({ padTop: 10, padBottom: 62 });
let renderer = null;
let dpr = 1;
try {
  renderer = new Renderer(view);
} catch (e) {
  console.error(e);
  $('#fatal').hidden = false;
}

let raf = 0;
function render() {
  if (!raf) raf = requestAnimationFrame(draw);
}

function accentRgb() {
  const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim();
  return /^#[0-9a-f]{6}$/i.test(accent) ? hexToRgb(accent) : [0.9, 0.2, 0.4];
}

// What to tint over the photo: the stroke being painted, the painted area when Show is on, or
// (Background › Fix) the area treated as background, so gaps in it are easy to see.
function overlayFor() {
  if (app.comparing) return { amount: 0 };
  const mode = (layer) => (OVERRIDE_LAYERS.has(layer) ? 1 : 0);
  if (app.live && (app.live.kind === 'layer' || app.live.kind === 'erase')) {
    const layer = app.live.kind === 'erase' ? 'erase' : app.live.name;
    return { amount: 0.42, layer, invert: layer === 'person', mode: mode(layer) };
  }
  if (app.view !== 'tool') return { amount: 0 };
  if (app.tool === 'background' && app.tab.background === 'fix' && app.personReady) return { amount: 0.28, layer: 'person', invert: true };
  const layer = app.tool === 'reshape' ? (app.tab.reshape === 'protect' ? 'protect' : null) : BRUSH_LAYER[app.tool];
  if (app.showMask && layer && layer !== 'person') {
    return { amount: 0.38, layer, mode: mode(layer), invert: layer === 'protect' && app.state.protectInvert };
  }
  return { amount: 0 };
}

// The crop and stretch geometry for the screen; the Crop tool shows the whole frame.
function syncGeometry() {
  const s = app.state;
  const full = app.view === 'tool' && app.tool === 'crop';
  const hideText = full || (app.comparing === 'tool' && app.tool === 'text') || app.comparing === 'all';
  const geo = geometry(s.crop, app.W, app.H, { full, text: !hideText && s.texts.length > 0, stretch: s.stretch });
  app.geo = geo;
  app.geoScale = sourceScale(geo);
  if (geo.out[0] !== vp.W || geo.out[1] !== vp.H) vp.setImage(geo.out[0], geo.out[1]);
  if (!full) syncText(geo);
  return geo;
}

// Redraws the text layer when the texts or the output size change.
function syncText(geo) {
  const texts = app.state.texts;
  const key = `${JSON.stringify(texts)}|${geo.out}|${app.fontsReady || 0}`;
  if (key === app.textKey) return;
  app.textKey = key;
  if (!texts.length) {
    renderer.setText(null);
    return;
  }
  app.textCanvas ||= document.createElement('canvas');
  renderer.setText(drawTexts(app.textCanvas, texts, geo.out[0], geo.out[1]));
}

function draw() {
  raf = 0;
  if (!renderer || !app.W) return;
  for (const [name, layer] of Object.entries(layers)) {
    if (layer.dirty && layer.ready) {
      renderer.setLayer(name, layer.canvas);
      layer.dirty = false;
    }
  }
  if (app.warpDirty) {
    renderer.setWarp(uploadedField(app.warp, app.state), app.warp && app.warp.gw, app.warp && app.warp.gh);
    app.warpDirty = false;
  }
  const toolBefore = app.comparing === 'tool';
  const s = toolBefore ? app.beforeState : app.state;
  if (needsNormals(s)) ensureNormals();
  const geo = syncGeometry();
  const u = uniforms(s);
  const ov = overlayFor();
  renderer.drawScreen(u.comp, u.grade, vp.shaderView(dpr), geo, {
    original: app.comparing === 'all',
    useOrig: toolBefore && app.beforeFlags.useOrig,
    tempWarp: toolBefore && app.beforeFlags.tempWarp,
    overlay: ov.amount,
    overlayLayer: ov.layer,
    overlayInvert: ov.invert,
    overlayMode: ov.mode,
    overlayColor: ov.amount ? accentRgb() : undefined,
  });
  $('#fit').hidden = vp.zoom <= 1.01;
  placeHandles();
}

new ResizeObserver(() => {
  const r = stage.getBoundingClientRect();
  dpr = Math.min(2, window.devicePixelRatio || 1);
  view.width = Math.max(1, Math.round(r.width * dpr));
  view.height = Math.max(1, Math.round(r.height * dpr));
  vp.setStage(r.width, r.height);
  render();
}).observe(stage);

// Output pixels (after crop) → stage CSS pixels.
function outToScreen(x, y) {
  const s = vp.scale, [ax, ay] = vp.anchor;
  return [ax + (x - vp.cx * vp.W) * s, ay + (y - vp.cy * vp.H) * s];
}

// Photo pixels → stage CSS pixels.
function toScreen(x, y) {
  return outToScreen(...(app.geo ? toOutput(app.geo, x, y) : [x, y]));
}

// Output pixels → photo pixels (touches arrive in output pixels).
const toPhoto = (p) => (app.geo ? toSource(app.geo, p[0], p[1]) : p);

function colorOf(list, id) {
  return hexToRgb((list.find((c) => c.id === id) || list[0]).hex);
}

function yccOf([r, g, b]) {
  const y = 0.299 * r + 0.587 * g + 0.114 * b;
  return [y, (b - y) * 0.564 + 0.5, (r - y) * 0.713 + 0.5];
}

const filterOf = (id) => FILTERS.find((x) => x.id === id) || FILTERS[0];
// Skin protection suits colour filters; black and white, colour pop and false-colour looks are
// meant to change skin along with everything else.
const protects = (f) => f.id !== 'none' && !f.p?.mono && !f.p?.isolate && !f.noProtect && !f.lut?.some((op) => op.mono || op.mix);
const GRADE_KEYS = ['exposure', 'brightness', 'contrast', 'highlights', 'shadows', 'saturation', 'vibrance', 'warmth', 'tint', 'fade', 'curve',
  'mono', 'split', 'vignette', 'grain', 'isoAmt', 'isoHue', 'isoWidth', 'shadowTint', 'highTint'];
const GREY = [0.5, 0.5, 0.5];
// A grade as the shader's struct uniform (uA.exposure, …).
const gradeStruct = (name, g) => Object.fromEntries(GRADE_KEYS.map((k) => [`${name}.${k}`, g[k]]));

// The person's Adjust; rg: colour tweaks a Relight preset brings with it (Flash adds contrast, …).
function adjustGrade(a, rg = {}) {
  const r = (k) => rg[k] || 0;
  return {
    exposure: (a.light + r('light')) * 0.9, brightness: a.brightness, contrast: (a.contrast + r('contrast')) * 0.45,
    highlights: a.highlights, shadows: a.shadows, saturation: (a.saturation + r('saturation')) * 0.6, vibrance: (a.vibrance + r('vibrance')) * 0.8,
    warmth: a.temperature + r('temperature'), tint: a.tint + r('tint'), fade: (a.fade + r('fade')) * 0.8, curve: 0, mono: 0, split: 0,
    vignette: a.vignette + r('vignette'), grain: a.grain + r('grain'), isoAmt: 0, isoHue: 0, isoWidth: 0.1, shadowTint: GREY, highTint: GREY,
  };
}

// The chosen filter's own changes, at its strength (a colour table, if it has one, comes after).
// A filter's overlay layers (looks.js `o`) as the final shader's uniforms. Strength follows the
// filter's own; faces stay clear unless a layer says otherwise (face: 0).
const OV_KINDS = { leak: 1, streak: 2, wash: 3, flare: 4, vhs: 5, burn: 6, stars: 7, sheen: 8 };
const OV_BLENDS = { screen: 0, soft: 1, overlay: 2, multiply: 3, lighten: 4 };
function overlayUniforms(flt, amt) {
  const L = [0, 1].map((i) => flt.o?.[i] || null);
  const f2 = (fn) => L.map((l) => (l ? fn(l) : 0));
  const faces = app.faces.slice(0, 4);
  return {
    uOvKind: f2((l) => OV_KINDS[l.k] || 0),
    uOvBlend: f2((l) => OV_BLENDS[l.blend || 'screen']),
    uOvAmt: f2((l) => (l.a ?? 0.6) * amt),
    uOvAng: f2((l) => ((l.ang ?? 0) * Math.PI) / 180),
    uOvSize: f2((l) => l.size ?? 0.6),
    uOvPos: L.flatMap((l) => l?.pos || [0, 0]),
    uOvC1: L.flatMap((l) => (l ? hexToRgb(l.c1 || '#ffffff') : [0, 0, 0])),
    uOvC2: L.flatMap((l) => (l ? hexToRgb(l.c2 || l.c1 || '#ffffff') : [0, 0, 0])),
    uOvFace: flt.o?.length ? (flt.o[0].face ?? 0.85) : 0,
    uFaceN: faces.length,
    uFaceEll: new Float32Array(16).map((_, k) => {
      const f = faces[k >> 2];
      if (!f) return 1;
      return [f.center[0] / app.W, f.center[1] / app.H, (f.fw * 0.62) / app.W, (f.fh * 0.7) / app.H][k & 3];
    }),
  };
}

function filterGrade(f) {
  const p = filterOf(f.id).p || {};
  const g = (k) => (p[k] || 0) * f.amt;
  return {
    exposure: g('exposure'), brightness: 0, contrast: g('contrast'), highlights: g('highlights'), shadows: g('shadows'),
    saturation: g('saturation'), vibrance: g('vibrance'), warmth: g('warmth'), tint: g('tint'), fade: g('fade'), curve: g('curve'),
    mono: g('mono'), split: g('split'), vignette: g('vignette'), grain: g('grain'),
    isoAmt: p.isolate ? f.amt : 0, isoHue: p.isolate ? p.isolate[0] : 0, isoWidth: p.isolate ? p.isolate[1] : 0.1,
    shadowTint: p.shadowTint || GREY, highTint: p.highTint || GREY,
  };
}

const SHADOW_OFFSETS = { left: [-0.022, 0.018], down: [0, 0.028], right: [0.022, 0.018] };

function uniforms(s = app.state) {
  const m = s.makeup;
  const k = m.look !== 'none' ? m.lookAmt : 1;     // a look's Intensity
  const on = (id) => Boolean(id) && id !== 'none';
  const pick = (list, id) => (on(id) ? colorOf(list, id) : [0, 0, 0]);
  const rl = relightUniforms(s.relight, app.faces, app.W, app.H);
  const painted = s.strokes.length > 0 || s.skinFace;
  const swap = BG_SWAPS.find((b) => b.id === s.bg.swap) || BG_SWAPS[0];
  const swapCode = swap.id === 'none' ? 0 : swap.id === 'photo' ? (app.bgImageReady ? 2 : 0) : 1;
  const bgOn = app.personReady;
  const b = s.bg;
  // The background tools use the refined cut-out, except while its brush is painting.
  const matte = bgOn && Boolean(b.blur || b.mono || swapCode || b.bright || b.shadow || b.blend) && !(app.live && app.live.name === 'person');
  if (matte) ensureMatte();
  // Background Freeze moves the refined cut-out over the scene with the subject filled out.
  const freeze = Boolean(s.freeze && app.personReady && app.warp);
  if (freeze) {
    ensureMatte();
    ensureFreezePlate();
  }
  const faceOn = app.faces.length > 0;
  const young = Object.fromEntries(AGE_PARTS.map(([k]) => [k, Math.max(0, -s.age[k])]));

  // Eyes and mouths as shader arrays (up to four faces).
  const eyes = new Float32Array(32), mouths = new Float32Array(16);
  const nf = Math.min(4, app.faces.length);
  app.faces.slice(0, 4).forEach((f, i) => {
    eyes.set([f.eyeR.iris[0], f.eyeR.iris[1], f.eyeR.irisR, f.eyeR.w], i * 8);
    eyes.set([f.eyeL.iris[0], f.eyeL.iris[1], f.eyeL.irisR, f.eyeL.w], i * 8 + 4);
    mouths.set([f.mouth.c[0], f.mouth.c[1], f.xAxis[0] * f.mouth.w, f.xAxis[1] * f.mouth.w], i * 4);
  });
  const tone = s.skin.tone === 'none' ? null : s.skin.tone === 'custom' ? s.skin.custom : SKIN_TONES.find((t) => t.id === s.skin.tone)?.hex;
  const style = SCULPT_STYLES.find((x) => x.id === s.contour.style);
  const sculptW = style ? style.w.map((v) => v * s.contour.amt) : [0, 0, 0, 0];
  sculptW[2] += s.contour.jaw;
  const hc = s.hair, hairFound = s.hairStrokes.length > 0 || hc.auto;
  // Hair's colour and care, and Age's grey hair, use its refined area, except while its brush is painting.
  const hairMatte = (hairFound && Boolean(on(hc.color) || hc.shine || hc.smooth || hc.texture || hc.enrich || hc.oil) || (s.age.grey > 0 && faceOn)) &&
    !(app.live && app.live.name === 'hair');
  if (hairMatte) ensureHairMatte();
  const flt = filterOf(s.filter.id);
  const glow = GLOW_TYPES.find((g) => g.id === s.skin.glow);
  const ref = referenceSize(false);
  const retouch = {
    uSkinY: app.skin ? app.skin.y : 0.5,
    uSegOn: app.segOn ? 1 : 0,
    uSmoothAmt: painted ? s.smooth : 0,
    uEvenAmt: painted ? s.even : 0,
    uDepth: painted ? s.depth : 0,
    uStubble: s.stubble && painted && faceOn ? 1 : 0,
    uDeglare: rl.u.uDeglare || 0,
    uCreaseAmt: faceOn ? [Math.max(s.wrinkles.forehead, 0.9 * young.lines), Math.max(s.wrinkles.crows, 0.9 * young.lines),
      Math.max(s.wrinkles.smile, 0.7 * young.lines), Math.max(s.wrinkles.under, 0.8 * young.lines)] : [0, 0, 0, 0],
    uCreaseBrush: s.wrinkleStrokes.length ? s.wrinkles.brush : 0,
    uConcealAmt: faceOn ? [Math.max(s.conceal.dark, 0.6 * young.spots, 0.35 * young.tone), s.conceal.light, Math.max(s.conceal.bags, 0.8 * young.bags),
      Math.max(s.conceal.trough, 0.6 * young.bags)] : [0, 0, 0, 0],
    uConcealBrush: s.concealStrokes.length ? s.conceal.brush : 0,
    uMatteAmt: s.matte.auto || s.matteStrokes.length ? s.matte.amt : 0,
    uMatteAuto: s.matte.auto && faceOn ? 1 : 0,
    uMatteHair: app.segOn ? s.matte.hair : 0,
    uTexAmt: s.textureStrokes.length || (s.texture.onSmooth && painted) ? s.texture.amt : 0,
    uTexSize: Math.max(1.2, (0.0025 + 0.007 * s.texture.size) * ref),
    uTexOnSmooth: s.texture.onSmooth ? 1 : 0,
    uDetail: [s.details.face, app.personReady ? s.details.body : 0, app.personReady ? s.details.bg : 0, s.detailStrokes.length ? s.details.brush : 0],
    uEyeWhite: Math.max(s.eyes.bright, 0.4 * young.eyes),
    uEyeIris: Math.max(s.eyes.iris, 0.3 * young.eyes),
    uDarkCircle: Math.max(s.eyes.circles, 0.8 * young.circles),
    uRedEye: s.eyes.redeye,
    uIrisSize: faceOn ? s.eyes.size : 0,
    uEyes: eyes,
    uEyeCount: nf * 2,
    uTeeth: Math.max(s.teeth.white, 0.5 * young.teeth),
    uStains: s.teeth.stains,
    uLipPlump: faceOn ? s.plump.lips : 0,
    uMouths: mouths,
    uMouthCount: nf,
    uToneAmt: tone ? s.skin.amt : 0,
    uToneYcc: tone ? yccOf(hexToRgb(tone)) : [0.5, 0.5, 0.5],
    uRedness: Math.max(s.skin.redness, 0.5 * young.tone),
    uGlowType: glow ? glow.code : 0,
    uGlowAmt: glow ? s.skin.glowAmt : 0,
    ...ageUniforms(s.age, faceOn),
    uFillAmt: faceOn ? [Math.max(s.plump.forehead, 0.3 * young.volume), Math.max(s.plump.temples, 0.5 * young.volume),
      Math.max(s.plump.cheeks, 0.6 * young.volume), Math.max(s.plump.sockets, 0.5 * young.volume)] : [0, 0, 0, 0],
    uSculptW: faceOn ? sculptW : [0, 0, 0, 0],
    uMuscle: s.body.muscle,
  };
  const active = Object.entries(retouch).some(([key, v]) => !['uSkinY', 'uSegOn', 'uEyes', 'uEyeCount', 'uMouths', 'uMouthCount', 'uToneYcc', 'uTexSize', 'uTexOnSmooth', 'uAgeStep', 'uAgeGrey'].includes(key) &&
    (Array.isArray(v) ? v.some(Boolean) : Boolean(v)));
  const people = s.people.map((p) => {
    const c = app.cutouts.get(p.id);
    if (!c) return null;
    const hh = p.h / 2, hw = (hh * (c.width / c.height) * app.H) / app.W;
    return [p.x, p.y, p.flip ? -hw : hw, hh];
  }).filter(Boolean);
  return {
    comp: {
      ...retouch,
      retouch: active,
      uGate: app.skin ? 1 : 0,
      uSkinMean: app.skin ? app.skin.mean : [0.5, 0.5],
      uSkinInv: app.skin ? app.skin.inv : [1, 0, 0, 1],
      uDenoise: s.adjust.denoise,
      uIrisAmt: on(s.eyes.color) ? 0.6 : 0,
      uIrisColor: pick(IRIS_COLORS, s.eyes.color),
      uLipAmt: on(m.lip) ? m.lipAmt * k : 0,
      uLipColor: pick(LIP_COLORS, m.lip),
      uLipLum: [0, 1, 2, 3].map((i) => app.lipLums?.[i] || 0),
      ...tuneUniforms(m.tune),
      uLipFinish: Math.max(0, LIP_FINISHES.findIndex((f) => f.id === m.lipFinish)),
      uShadowAmt: on(m.shadow) ? m.shadowAmt * k : 0,
      uShadowColor: pick(SHADOW_COLORS, m.shadow),
      uShadowShimmer: m.shimmer,
      uLinerAmt: on(m.liner) ? m.linerAmt * k : 0,
      uLinerColor: pick(LINER_COLORS, m.liner),
      uLashAmt: on(m.lashes) ? m.lashAmt * k : 0,
      uBrowAmt: on(m.brow) ? m.browAmt * 0.6 * k : 0,
      uBrowColor: pick(BROW_COLORS, m.brow),
      uBlushAmt: on(m.blush) ? m.blushAmt * 0.8 * k : 0,
      uBlushColor: pick(BLUSH_COLORS, m.blush),
      uContourAmt: m.contour * k,
      uHighlightAmt: m.highlight * k,
      uFreckleAmt: m.freckles * k,
      uHairAmt: on(s.hair.color) ? s.hair.amt : 0,
      uHairColor: pick(HAIR_COLORS, s.hair.color),
      uHairDark: on(s.hair.color) ? hexToRgb((HAIR_COLORS.find((c) => c.id === s.hair.color) || HAIR_COLORS[0]).dark) : [0, 0, 0],
      uHairLight: on(s.hair.color) ? hexToRgb((HAIR_COLORS.find((c) => c.id === s.hair.color) || HAIR_COLORS[0]).light) : [0, 0, 0],
      uHairDepth: s.hair.depth,
      uHairShine: hairFound ? hc.shine : 0,
      uHairSmooth: hairFound ? hc.smooth : 0,
      uHairTex: hairFound ? hc.texture : 0,
      uHairEnrich: hairFound ? hc.enrich : 0,
      uHairOil: hairFound ? hc.oil : 0,
      uHairMean: (hairFound && (hc.enrich || on(hc.color))) || (s.age.grey > 0 && faceOn) ? hairMean() : [0.25, 0.5, 0.5],
      uHairMid: (hairFound && on(hc.color)) || (s.age.grey > 0 && faceOn) ? hairMid() : [0.25, 0.5],
      uHairMatte: hairMatte ? 1 : 0,
      ...ageHairUniforms(s.age, faceOn),
      uBgBlur: bgOn ? s.bg.blur : 0,
      uBgMono: bgOn ? s.bg.mono : 0,
      uBgSwap: bgOn ? swapCode : 0,
      uBgColA: swap.hex ? hexToRgb(swap.hex) : [0, 0, 0],
      uBgColB: hexToRgb(swap.hex2 || swap.hex || '#000000'),
      uBgBright: bgOn ? s.bg.bright : 0,
      uBgShadow: bgOn ? s.bg.shadow : 0,
      uShadowOff: SHADOW_OFFSETS[s.bg.shadowDir] || SHADOW_OFFSETS.down,
      uBlend: bgOn ? s.bg.blend : 0,
      uEdge: bgOn ? s.bg.edge : 0,
      uEdgeSoft: bgOn ? s.bg.soft : 0,
      matte: matte ? 1 : 0,
      bgSigma: s.bg.blur * 0.022 * Math.hypot(app.W, app.H),
      bokeh: s.bg.bokeh || 0,
      bokehGamma: +(1 + 8 * s.bg.hi).toFixed(2),
      people,
    },
    grade: {
      ...gradeStruct('uA', adjustGrade(s.adjust, rl.grade)),
      ...gradeStruct('uF', filterGrade(s.filter)),
      uSharpen: s.adjust.sharpen + (flt.p?.sharpen || 0) * s.filter.amt,
      uClarity: s.adjust.clarity,
      uAmbience: s.adjust.ambience,
      uDehaze: s.adjust.dehaze,
      uLutAmt: flt.lut ? s.filter.amt : 0,
      lutId: flt.lut ? renderer.ensureLut(flt.id, () => buildLut(flt.id, flt.lut)) : null,
      uProtect: s.filter.protect && protects(flt) ? 1 : 0,
      uGate: app.skin ? 1 : 0,
      uSkinMean: app.skin ? app.skin.mean : [0.5, 0.5],
      uSkinInv: app.skin ? app.skin.inv : [1, 0, 0, 1],
      uHalation: Math.min(1, s.effects.halation + (flt.p?.halation || 0) * s.filter.amt),
      uDust: s.effects.dust,
      ...overlayUniforms(flt, s.filter.amt),
      ...rl.u,
      uGlowAmt: s.effects.glow,
      uSoftFocus: s.effects.soft,
      uLeak: Math.min(1, s.effects.leak + rl.leak),
      uPrism: s.effects.prism,
      uPrismC: s.effects.focus,
      uPrismR: 0.12,
      uGlitter: s.glitter.all || s.glitterStrokes.length ? s.glitter.amt : 0,
      uGlitterAll: s.glitter.all ? 1 : 0,
      uGlitterSize: (3 + 11 * s.glitter.size) * Math.max(1, Math.max(...(app.geo ? app.geo.out : [app.W, app.H])) / 1600),
      uGlitterCol: colorOf(GLITTER_COLORS, s.glitter.color),
      ...sparkleUniforms(s.sparkle),
      uFreeze: freeze ? 1 : 0,
    },
  };
}

// Sparkle: the brightest small highlights of the photo (catchlights, jewellery, glints), found on a
// copy about 360 px across, strongest first and kept apart from each other.
function findHighlights() {
  const { data, width: W, height: H } = app.work;
  const k = Math.min(1, 360 / Math.max(W, H)), w = Math.max(1, Math.round(W * k)), h = Math.max(1, Math.round(H * k));
  const L = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (Math.min(H - 1, Math.round((y + 0.5) / k)) * W + Math.min(W - 1, Math.round((x + 0.5) / k))) * 4;
      L[y * w + x] = (0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]) / 255;
    }
  }
  // Local mean over 13 × 13 from an integral image.
  const I = new Float64Array((w + 1) * (h + 1));
  for (let y = 0; y < h; y++) for (let x = 0, row = 0; x < w; x++) { row += L[y * w + x]; I[(y + 1) * (w + 1) + x + 1] = I[y * (w + 1) + x + 1] + row; }
  const mean = (x, y, r) => {
    const x0 = Math.max(0, x - r), y0 = Math.max(0, y - r), x1 = Math.min(w, x + r + 1), y1 = Math.min(h, y + r + 1);
    return (I[y1 * (w + 1) + x1] - I[y0 * (w + 1) + x1] - I[y1 * (w + 1) + x0] + I[y0 * (w + 1) + x0]) / ((x1 - x0) * (y1 - y0));
  };
  const sorted = Float32Array.from(L).sort();
  // Strict first; on photos with few glints, looser until there are enough to choose from.
  let cand = [];
  for (const [q, minLift] of [[0.992, 0.05], [0.98, 0.03], [0.96, 0.015]]) {
    const floor = Math.min(0.9, Math.max(0.45, sorted[Math.floor(sorted.length * q)]));
    cand = [];
    for (let y = 2; y < h - 2; y++) {
      for (let x = 2; x < w - 2; x++) {
        const v = L[y * w + x];
        if (v < floor) continue;
        let peak = true;
        for (let dy = -2; dy <= 2 && peak; dy++) for (let dx = -2; dx <= 2; dx++) if (L[(y + dy) * w + x + dx] > v) { peak = false; break; }
        const lift = v - mean(x, y, 6);
        if (peak && lift > minLift) cand.push([x, y, lift * 0.7 + v * 0.3]);
      }
    }
    if (cand.length >= 14) break;
  }
  cand.sort((a, b) => b[2] - a[2]);
  const gap = 0.035 * Math.max(w, h), out = [];
  for (const c of cand) {
    if (out.length >= 48) break;
    if (out.every((o) => Math.hypot(o[0] - c[0], o[1] - c[1]) > gap)) out.push(c);
  }
  const top = out.length ? out[0][2] : 1;
  return out.map(([x, y, sc]) => [(x + 0.5) / w, (y + 0.5) / h, 0.55 + 0.45 * (sc / top)]);
}

function sparkleUniforms(sp) {
  const shape = SPARKLE_SHAPES.find((x) => x.id === sp.shape);
  const data = new Float32Array(48 * 3);
  if (!shape || !app.W) return { uSparkN: 0, uSparkPts: data };
  const key = `${app.loadToken}|${app.state.heals.length}`;
  if (!app.sparkCache || app.sparkCache.key !== key) app.sparkCache = { key, pts: findHighlights() };
  const pts = app.sparkCache.pts.slice(0, Math.round(4 + sp.amount * 44));
  pts.forEach((p, i) => data.set(p, i * 3));
  return {
    uSparkN: pts.length, uSparkPts: data, uSparkShape: shape.code, uSparkSize: (0.02 + 0.09 * sp.size) * Math.max(app.W, app.H),
    uSparkAngle: (sp.angle * Math.PI) / 4, uSparkCol: colorOf(SPARKLE_COLORS, sp.color),
  };
}

const needsNormals = (s) => s.relight.preset !== 'none' && s.relight.preset !== 'deglare';

// ---------- history ----------

function commit() {
  app.history = app.history.slice(0, app.index + 1);
  app.history.push(structuredClone(app.state));
  if (app.history.length > HISTORY_LIMIT) {
    app.history.shift();
    app.entryIndex = Math.max(0, app.entryIndex - 1);
  }
  app.index = app.history.length - 1;
  syncHistoryButtons();
}

function restore(snapshot) {
  const prev = app.state;
  app.state = structuredClone(snapshot);
  const s = app.state;
  const changed = (k) => JSON.stringify(prev[k]) !== JSON.stringify(s[k]);
  if (changed('heals')) replayHeals();
  if (changed('strokes') || changed('skinFace')) redrawSkin();
  for (const name of PLAIN_LAYERS) {
    if (changed(LAYER_STROKES[name])) layers[name].redraw(s[LAYER_STROKES[name]]);
  }
  if (changed('hairStrokes') || prev.hair.auto !== s.hair.auto) redrawHair();
  if (changed('bgStrokes')) redrawPerson();
  if (changed('protectStrokes') || prev.protectInvert !== s.protectInvert) protectChanged();
  if (changed('age')) ageChanged();
  if (changed('sculpt') || changed('pushes') || changed('body') || prev.plump.lips !== s.plump.lips || prev.teeth.align !== s.teeth.align ||
    prev.hair.volume !== s.hair.volume || prev.hair.hairline !== s.hair.hairline) updateWarp();
  if (prev.makeup.linerStyle !== s.makeup.linerStyle || prev.makeup.lashes !== s.makeup.lashes) ensureMakeupMasks();
  if (changed('people')) syncPeople();
  if (!s.texts.some((t) => t.id === app.sel.text)) app.sel.text = null;
  if (!s.people.some((p) => p.id === app.sel.person)) app.sel.person = null;
  ensureNeeds(s);
  syncUI();
  render();
}

// Starts whatever model work the state relies on (subject cut-out, hair and skin, body pose).
function ensureNeeds(s) {
  const b = s.bg;
  const bg = b.blur || b.mono || b.swap !== 'none' || b.edge || b.soft || b.shadow || b.blend || b.bright;
  if (bg || s.people.length || s.relight.preset !== 'none' || s.freeze || s.details.body || s.details.bg || bodyActive(s.body)) ensurePerson();
  if (bg || s.freeze || s.hair.auto || s.age.grey > 0 || s.matte.hair || s.skin.tone !== 'none' || s.skin.glow !== 'none' || s.body.muscle) ensureParts();
  if (bodyActive(s.body)) ensurePose();
}

function undo() {
  if (app.index <= 0 || app.live) return;
  app.index--;
  // Undoing past the moment a tool was opened moves ✗'s restore point back with it.
  if (app.view === 'tool') app.entryIndex = Math.min(app.entryIndex, app.index);
  restore(app.history[app.index]);
  syncHistoryButtons();
}

function redo() {
  if (app.index >= app.history.length - 1 || app.live) return;
  app.index++;
  restore(app.history[app.index]);
  syncHistoryButtons();
}

function syncHistoryButtons() {
  $('#undo').disabled = app.index <= 0;
  $('#redo').disabled = app.index >= app.history.length - 1;
}

// ---------- loading photos ----------

// Decodes a photo. An <img> applies the camera's rotation (EXIF) in every current browser;
// createImageBitmap is the fallback. Returns { source, width, height, done() }.
async function decodeImage(blob) {
  const url = URL.createObjectURL(blob);
  const img = new Image();
  img.decoding = 'async';
  img.src = url;
  try {
    await img.decode();
    return { source: img, width: img.naturalWidth, height: img.naturalHeight, done: () => URL.revokeObjectURL(url) };
  } catch (err) {
    URL.revokeObjectURL(url);
    const bmp = await createImageBitmap(blob).catch(() => { throw err; });
    return { source: bmp, width: bmp.width, height: bmp.height, done: () => bmp.close() };
  }
}

async function loadPhoto(blob, sample = null) {
  const token = ++app.loadToken;
  const pic = await decodeImage(blob);
  if (!pic.width || !pic.height) throw new Error('Empty image');
  const k = Math.min(1, MAX_SIDE / Math.max(pic.width, pic.height));
  const W = Math.max(1, Math.round(pic.width * k)), H = Math.max(1, Math.round(pic.height * k));
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(pic.source, 0, 0, W, H);
  pic.done();
  Object.assign(app, {
    W, H, canvas: c, faces: [], masks: null, skin: null, seg: null, segSelfie: null, segParts: null, segFailed: false, personReady: false,
    personPending: null, matteVersion: -1, hairMatteVersion: -1, matteNear: null, freezeKey: '', parts: null, partsPending: null, partsFailed: false, segOn: false, pose: null, posePending: null,
    poseFailed: false, cutouts: new Map(), bgImageReady: false, warp: null, warpDirty: true, protectGrid: null, tapCache: null, makeupKey: '', normalKey: '',
    textKey: '', live: null, isSample: Boolean(sample), pendingAuto: false, view: 'main', tool: null,
    stamp: { src: null, offset: null, picking: true }, sel: { text: null, person: null },
  });
  app.orig = ctx.getImageData(0, 0, W, H);
  app.work = new ImageData(new Uint8ClampedArray(app.orig.data), W, H);
  renderer.setImage(app.orig, app.work);
  renderer.setSmoothing(clamp(Math.min(W, H) * 0.012, 3, 16), clamp(Math.min(W, H) * 0.02, 4, 40));
  for (const layer of Object.values(layers)) layer.reset(W, H);
  vp.setImage(W, H);
  app.state = structuredClone(DEFAULTS);
  app.history = [];
  app.index = -1;
  commit();
  syncUI();
  render();
  if (sample) {
    if (sample.person) setSegmentation(sample.person);
    setFaces(sample.faces.map((f) => analyseFace(f, W, H)));
  } else {
    detect(token);
  }
}

async function detect(token) {
  setFaceStatus('loading');
  try {
    const norm = await detectFaces(app.canvas);
    if (token !== app.loadToken) return;
    setFaces(norm.map((f) => analyseFace(f, app.W, app.H)));
  } catch (e) {
    if (token !== app.loadToken) return;
    console.warn('Face detection unavailable:', e);
    app.pendingAuto = false;
    setFaceStatus('error');
  }
}

function setFaces(faces) {
  // Left to right, so Sculpt's "Face 1, Face 2…" read in the order people stand.
  app.faces = [...faces].sort((a, b) => a.center[0] - b.center[0]);
  app.sculptFace = -1;
  app.normalKey = '';
  if (!faces.length) {
    app.masks = null;
    app.skin = null;
    renderer.setFeatures(null, null);
    renderer.setMakeup(null);
    renderer.setFaceMaps(null);
    setFaceStatus('none');
    if (app.pendingAuto) {
      app.pendingAuto = false;
      toast('No face found, so Auto has nothing to retouch.');
    }
    return;
  }
  faces = app.faces;
  const m = buildFaceMasks(faces, app.W, app.H, MASK_SCALE);
  app.lipLums = fitLips(m);
  app.masks = m;
  app.skin = skinModel(app.orig, m.skin, m.mw, m.mh);
  renderer.setFeatures(m.feat, m.feat2, m.mw, m.mh, m.spots);
  renderer.setFaceMaps(faceMeshes(faces, app.W, app.H), buildAtlases());
  const fw = Math.max(...faces.map((f) => f.fw));
  renderer.setSmoothing(clamp(fw * 0.03, 3, 28), clamp(fw * 0.045, 4, 60), clamp(fw * 0.013, 1.5, 18));
  redrawSkin();
  ensureMakeupMasks();
  updateWarp();
  setFaceStatus('ready');
  if (app.pendingAuto) {
    app.pendingAuto = false;
    applyAuto();
  }
  render();
}

let statusTimer = 0;
function setFaceStatus(status) {
  app.faceStatus = status;
  const n = app.faces.length;
  const [text, ms] = {
    loading: ['Finding faces…', 0],
    ready: [n === 1 ? '1 face found' : `${n} faces found`, 2200],
    none: ['No face found', 4000],
    error: ['Face tools unavailable here', 5000],
  }[status] || ['', 0];
  const chip = $('#status');
  chip.dataset.state = status;
  $('#status-text').textContent = text;
  chip.hidden = !text || app.isSample;
  clearTimeout(statusTimer);
  if (ms) statusTimer = setTimeout(() => { chip.hidden = true; }, ms);
  if (status === 'error') toast('Face detection could not start. Smooth, Blemish, Eraser, Filters and Adjust still work.');
  syncUI();
}

// ---------- painted layers, makeup masks, normals ----------

function redrawSkin() {
  layers.skin.setBase(app.state.skinFace && app.masks ? app.masks.skin : null);
  layers.skin.redraw(app.state.strokes);
}

function redrawHair() {
  layers.hair.setBase((app.state.hair.auto || app.state.age.grey > 0) && app.parts ? app.parts.hair : null);
  layers.hair.redraw(app.state.hairStrokes);
  app.hairCache = null;
  app.hairVersion++;
  if (app.state.hair.volume) updateWarp();
}

// The hair area as found or painted (mask size), read back once per change: Volume follows its
// edge and Enrich compares against its average colour.
function hairAlpha() {
  if (!app.hairCache) app.hairCache = { alpha: layers.hair.alpha(), mean: null };
  return app.hairCache.alpha;
}

// The hair's own average colour (luma, Cb, Cr), sampled where the hair area is solid.
function hairMean() {
  const a = hairAlpha();
  if (app.hairCache.mean) return app.hairCache.mean;
  const mw = layers.hair.width, mh = layers.hair.height, { data, width: W, height: H } = app.work;
  const step = Math.max(1, Math.round(Math.sqrt((mw * mh) / 40000)));
  let y = 0, cb = 0, cr = 0, n = 0, sl = 0, sl2 = 0;
  const hist = new Uint32Array(256);
  for (let my = 0; my < mh; my += step) {
    for (let mx = 0; mx < mw; mx += step) {
      if (a[my * mw + mx] < 170) continue;
      const i = (Math.min(H - 1, Math.round((my * H) / mh)) * W + Math.min(W - 1, Math.round((mx * W) / mw))) * 4;
      const r = data[i] / 255, g = data[i + 1] / 255, b = data[i + 2] / 255, l = 0.299 * r + 0.587 * g + 0.114 * b;
      y += l;
      cb += (b - l) * 0.564 + 0.5;
      cr += (r - l) * 0.713 + 0.5;
      hist[Math.min(255, Math.round(l * 255))]++;
      const ln = Math.log(Math.max(l, 0.01));
      sl += ln;
      sl2 += ln * ln;
      n++;
    }
  }
  app.hairCache.mean = n > 30 ? [y / n, cb / n, cr / n] : [0.25, 0.5, 0.5];
  let k = 0;
  for (let c = 0; k < n / 2 && c < 256; c++) {
    k += hist[c];
    app.hairCache.mid = c / 255;
  }
  if (n <= 30) app.hairCache.mid = 0.25;
  app.hairCache.spread = n > 30 ? Math.sqrt(Math.max(0, sl2 / n - (sl / n) ** 2)) : 0.5;
  return app.hairCache.mean;
}

// The hair's middle light (the median, which highlights do not pull up as they do the mean) and how
// widely its light spreads (the deviation of its log light): what Colour measures each pixel against.
function hairMid() {
  hairMean();
  return [Math.max(0.01, app.hairCache.mid), app.hairCache.spread];
}

// How widely white hair's light spreads in photos at the hair pass's three scales (strands, bands of
// light, the head), as measured on real white and grey hair (evidence §17).
const WHITE_HAIR = [0.09, 0.065, 0.13];
const GAUSS9 = Array.from({ length: 9 }, (_, i) => Math.exp(-((i - 4) ** 2) / 8));

// The hair's light split as the hair pass splits it (gl.js HAIR): each pixel against the hair round
// it at the small blur's scale, that against the mid blur, that against the hair's median. Each is a
// spread (1.25 × the mean |log|) over points where the hair area is solid; the blurs take the hair
// alone, from 9 × 9 taps half a sigma apart, and the finest scale leaves out the photo's noise as
// the hair pass does. Grey hair brings each to white hair's own.
function hairScales() {
  hairMean();
  const c = app.hairCache, ss = renderer.smallSigma, sm = renderer.blurSigma, key = `${ss}|${sm}`;
  if (c.scales && c.scalesKey === key) return c.scales;
  const a = c.alpha, mw = layers.hair.width, mh = layers.hair.height, { data, width: W, height: H } = app.work;
  const lum = (x, y) => {
    const i = (y * W + x) * 4;
    return Math.max(0.003, (0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]) / 255);
  };
  const around = (x, y, s) => {
    let sw = 0, sl = 0;
    for (let j = 0; j < 9; j++) {
      const py = Math.round(y + ((j - 4) * s) / 2);
      if (py < 0 || py >= H) continue;
      const my = Math.min(mh - 1, Math.floor((py * mh) / H)) * mw;
      for (let i = 0; i < 9; i++) {
        const px = Math.round(x + ((i - 4) * s) / 2);
        if (px < 0 || px >= W) continue;
        const w = GAUSS9[i] * GAUSS9[j] * a[my + Math.min(mw - 1, Math.floor((px * mw) / W))];
        sw += w;
        sl += w * lum(px, py);
      }
    }
    return Math.max(0.015, sl / Math.max(sw, 1e-4));
  };
  const step = Math.max(1, Math.round(Math.sqrt((mw * mh) / 6000))), mid = Math.max(0.01, c.mid), sum = [0, 0, 0];
  let n = 0;
  for (let my = 0; my < mh; my += step) {
    for (let mx = 0; mx < mw; mx += step) {
      if (a[my * mw + mx] < 243) continue;
      const x = Math.min(W - 1, Math.round((mx * W) / mw)), y = Math.min(H - 1, Math.round((my * H) / mh));
      const l = lum(x, y), ls = around(x, y, ss), lm = around(x, y, sm), f = Math.log(l / ls), fn = 0.008 / ls;
      sum[0] += Math.abs((f * f * f) / (f * f + fn * fn));
      sum[1] += Math.abs(Math.log(ls / lm));
      sum[2] += Math.abs(Math.log(lm / mid));
      n++;
    }
  }
  c.scales = n > 30 ? sum.map((v) => (1.25 * v) / n) : WHITE_HAIR.slice();
  c.scalesKey = key;
  return c.scales;
}

function redrawPerson() {
  layers.person.setBase(app.seg, 255);
  layers.person.redraw(app.state.bgStrokes, tapRegion);
  app.personReady = Boolean(app.seg) || app.state.bgStrokes.length > 0;
  app.personVersion++;
  if (app.state.freeze || bodyActive(app.state.body)) updateWarp();
}

function ensureMakeupMasks() {
  if (!app.faces.length || !renderer) return;
  const m = app.state.makeup;
  const key = `${app.loadToken}|${m.linerStyle}|${m.lashes}`;
  if (key === app.makeupKey) return;
  renderer.setMakeup(buildMakeupMasks(app.faces, app.W, app.H, { linerStyle: m.linerStyle, lashStyle: m.lashes === 'none' ? 'natural' : m.lashes }));
  app.makeupKey = key;
}

function ensureNormals() {
  if (!app.faces.length) return;
  const key = `${app.loadToken}|${app.personVersion}|${app.personReady}`;
  if (key === app.normalKey) return;
  const person = app.personReady ? layers.person.alpha() : null;
  renderer.setNormalMap(buildNormalMap(app.faces, app.W, app.H, person, layers.person.width, layers.person.height));
  app.normalKey = key;
}

function referenceSize(big) {
  return big || !app.faces.length ? Math.min(app.W, app.H) * 0.5 : Math.max(...app.faces.map((f) => f.fw));
}

// Background, hair, body and Push work on big areas, so their brush scales with the photo, not the face.
// Reshape › Push › Light moves what is under the finger this much of the way.
const PUSH_LIGHT = 0.45;
const BIG_BRUSH = ['background', 'hair', 'reshape', 'details', 'stamp', 'body', 'glitter'];
const brushRadius = () => (0.02 + 0.13 * app.brushSize) * referenceSize(BIG_BRUSH.includes(app.tool));
const blemishRadius = () => (0.012 + 0.035 * app.blemishSize) * referenceSize(false);

// ---------- edits ----------

function okSkin(x, y) {
  if (!app.masks) return true;
  const { skin, mw, mh } = app.masks;
  const mx = clamp(Math.round(x * MASK_SCALE), 0, mw - 1), my = clamp(Math.round(y * MASK_SCALE), 0, mh - 1);
  return skin[my * mw + mx] > 140;
}

function healAt(p) {
  const [x, y] = toPhoto(p);
  if (x < 0 || y < 0 || x >= app.W || y >= app.H) return;
  const r = blemishRadius();
  const src = healSpot(app.work, x, y, r, null, app.masks ? okSkin : null);
  if (!src) return;
  app.state.heals.push({ x: Math.round(x), y: Math.round(y), r: +r.toFixed(2), sx: src[0], sy: src[1] });
  app.workVersion++;
  renderer.updateSource(app.work);
  commit();
  syncUI();
  render();
}

function replayHeals() {
  app.work.data.set(app.orig.data);
  for (const h of app.state.heals) {
    if (h.c) cloneStroke(app.work, h);
    else healSpot(app.work, h.x, h.y, h.r, [h.sx, h.sy], null, Boolean(h.auto));
  }
  app.workVersion++;
  renderer.updateSource(app.work);
  if (app.state.teeth.align) updateWarp();     // Align reads the teeth from the photo
}

// Points every `step` px along a stroke path [x0, y0, x1, y1, …].
function resample(p, step) {
  const out = [[p[0], p[1]]];
  let px = p[0], py = p[1], acc = 0;
  for (let i = 2; i < p.length; i += 2) {
    const x = p[i], y = p[i + 1];
    let d = Math.hypot(x - px, y - py);
    while (d > 0 && acc + d >= step) {
      const t = (step - acc) / d;
      px += (x - px) * t;
      py += (y - py) * t;
      out.push([px, py]);
      d = Math.hypot(x - px, y - py);
      acc = 0;
    }
    acc += d;
    px = x;
    py = y;
  }
  const last = [p[p.length - 2], p[p.length - 1]], prev = out[out.length - 1];
  if (Math.hypot(last[0] - prev[0], last[1] - prev[1]) > step * 0.3) out.push(last);
  return out;
}

// Eraser: heal overlapping patches along the stroke, never copying from inside the stroke itself.
function eraseStroke(s) {
  const L = layers.erase, ex = L.alpha(), ew = L.width, eh = L.height;
  const ok = (x, y) => ex[clamp(Math.round(y * L.scale), 0, eh - 1) * ew + clamp(Math.round(x * L.scale), 0, ew - 1)] < 24;
  let n = 0;
  for (const [x, y] of resample(s.p, s.r * 0.6)) {
    const src = healSpot(app.work, x, y, s.r, null, ok);
    if (!src) continue;
    app.state.heals.push({ x: Math.round(x), y: Math.round(y), r: s.r, sx: src[0], sy: src[1], e: 1 });
    n++;
  }
  if (n) {
    app.workVersion++;
    renderer.updateSource(app.work);
  }
  return n;
}

// Finds and heals spots on every face; returns how many were healed.
function healAutoSpots() {
  let n = 0;
  for (const f of app.faces) {
    for (const sp of findSpots(app.work, f, app.masks.spots, app.masks.mw, app.masks.mh)) {
      const src = healSpot(app.work, sp.x, sp.y, sp.r, null, okSkin, true);
      if (!src) continue;
      app.state.heals.push({ x: Math.round(sp.x), y: Math.round(sp.y), r: +sp.r.toFixed(2), sx: src[0], sy: src[1], auto: 1 });
      n++;
    }
  }
  if (n) {
    app.workVersion++;
    renderer.updateSource(app.work);
  }
  return n;
}

async function findSpotsNow() {
  busy('Looking for spots…');
  await nextFrame();
  const n = healAutoSpots();
  busy(null);
  if (n) commit();
  syncUI();
  render();
  toast(n ? `${n} spot${n === 1 ? '' : 's'} healed` : 'No spots found. Tap any you can see.');
}

function applyAuto() {
  if (!app.faces.length) {
    if (app.faceStatus === 'loading') {
      app.pendingAuto = true;
      toast('Finding the face first…');
    } else {
      toast('Auto needs a face in the photo.');
    }
    return;
  }
  const s = app.state;
  if (!s.heals.some((h) => h.auto)) s.auto.spots = healAutoSpots();
  s.auto.on = true;
  setAutoStrength(s.auto.amt);
  commit();
  syncUI();
  render();
}

// Auto's recipe entries are state paths; 'sculpt.<control>' sets that control on every face.
function setRecipe(s, path, v) {
  if (!path.startsWith('sculpt.')) return setPath(s, path, v);
  const id = path.slice(7), faces = s.sculpt.faces;
  for (let i = 0; i < app.faces.length; i++) {
    const f = (faces[i] ||= {});
    if (v) f[id] = [v, v];
    else delete f[id];
  }
}

function setAutoStrength(v) {
  const s = app.state;
  s.auto.amt = v;
  if (!s.auto.on) return;
  for (const [path, full] of Object.entries(AUTO_RECIPE)) setRecipe(s, path, +(full * v).toFixed(3));
  updateWarp();
}

// Age's own effects: the retouch pass draws them (gl.js), and grey hair the composite. Younger's
// other parts work through the retouch tools' uniforms above.
function ageUniforms(a, faceOn) {
  const o = (k) => (faceOn ? Math.max(0, a[k]) : 0), both = (k) => (faceOn ? a[k] : 0);
  const fh = app.faces.length ? Math.max(...app.faces.map((f) => f.fh)) : 0;
  return {
    uAgeLines: both('lines'), uAgeTexture: o('texture'), uAgeBags: o('bags'), uAgeCircles: o('circles'), uAgeHollows: o('volume'),
    uAgeFolds: o('sag'), uAgeSpots: o('spots'), uAgeTone: o('tone'), uAgeEyes: o('eyes'), uAgeTeeth: o('teeth'),
    uAgeSkin: both('skin'), uAgeLipTone: both('lips'), uAgeBrows: both('brows'), uAgeGrey: o('grey'), uAgeStep: Math.max(2, fh * 0.025),
  };
}

// The colour of the photo's light, which white hair takes as anything near white does: the mean
// colour of its near-neutral pixels (neither dark nor blown, little chroma), as a tint of luma 1,
// taken half way (a beige wall is partly its own colour). Once per photo.
function sceneTint() {
  if (app.sceneTint?.of === app.orig) return app.sceneTint.tint;
  const { data, width: W, height: H } = app.orig, step = Math.max(1, Math.round(Math.sqrt((W * H) / 40000)));
  const sum = [0, 0, 0];
  let n = 0;
  for (let y = 0; y < H; y += step) {
    for (let x = 0; x < W; x += step) {
      const i = (y * W + x) * 4, r = data[i] / 255, g = data[i + 1] / 255, b = data[i + 2] / 255, l = 0.299 * r + 0.587 * g + 0.114 * b;
      if (l < 0.15 || l > 0.96 || Math.hypot((b - l) * 0.564, (r - l) * 0.713) > 0.08) continue;
      sum[0] += r / l;
      sum[1] += g / l;
      sum[2] += b / l;
      n++;
    }
  }
  const tint = n > 50 ? sum.map((v) => 0.5 + (0.5 * v) / n) : [1, 1, 1];
  app.sceneTint = { of: app.orig, tint };
  return tint;
}

// Grey hair's shade and where it starts, for the hair pass (gl.js HAIR). Hair greys first at the
// temples, above and in front of the ears, then along the front hairline: each face gives the hair
// pass those three points (pushed out from the face into the hair) and how far their pull reaches.
// White hair's light: each scale of the hair's own brought part way to white hair's spread, never
// raised. The strands that turn are picked on cells about a strand wide. The shade is lit by the
// photo's light.
function ageHairUniforms(a, faceOn) {
  const tone = AGE_GREYS.find((g) => g.id === a.shade) || AGE_GREYS[0];
  const temples = new Float32Array(16), top = new Float32Array(16);
  const faces = faceOn ? app.faces.slice(0, 4) : [];
  const greyOn = faceOn && a.grey > 0, scales = greyOn ? hairScales() : WHITE_HAIR;
  const gain = greyOn ? scales.map((v, k) => clamp((WHITE_HAIR[k] / Math.max(v, 1e-3)) ** 0.7, 0.1, 1)) : [1, 1, 1];
  const light = greyOn ? sceneTint() : [1, 1, 1];
  const fw = faces.length ? Math.max(...faces.map((f) => f.fw)) : 300;
  faces.forEach((f, i) => {
    const P = f.P, out = 0.06 * f.fw, mid = (p, q) => [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2];
    const l = mid(P[54], P[127]), r = mid(P[284], P[356]);
    temples.set([l[0] - f.xAxis[0] * out, l[1] - f.xAxis[1] * out, r[0] + f.xAxis[0] * out, r[1] + f.xAxis[1] * out], i * 4);
    top.set([P[10][0] - f.yAxis[0] * 0.04 * f.fh, P[10][1] - f.yAxis[1] * 0.04 * f.fh, 0.4 * f.fw, 0], i * 4);
  });
  return {
    uAgeTemples: faceOn ? Math.max(0, a.temples) : 0, uAgeTint: tone.tint.map((v, k) => v * light[k]), uAgeLift: tone.lift,
    uTemples: temples, uTempleTop: top, uTempleCount: faces.length,
    uGreyGain: gain, uGreyFine: Math.max(0.02, scales[0]), uStrandW: clamp(fw * 0.008, 1.5, 6),
  };
}

// A part's value at t on the Age slider, from its course in AGE_PARTS: older, from where it begins
// up to its full strength; younger, in proportion.
function agePart([, , , , old, start, young], t) {
  return t >= 0 ? old * Math.min(1, Math.max(0, (t - start) / (1 - start))) : young * t;
}

// Age at t on the slider, with what Skin, Face and Hair changed by hand (off) added to each part, and
// the shade grey hair turns.
function ageAt(t, off = {}, shade = 'silver') {
  const a = { t, off: { ...off }, shade };
  for (const p of AGE_PARTS) a[p[0]] = +Math.min(1, Math.max(p[6] ? -1 : 0, agePart(p, t) + (off[p[0]] || 0))).toFixed(3);
  return a;
}

// Age's warps, added to a face's Sculpt values. Sagging: the cheeks and jowls drop, the jawline
// softens, the brows and the eyes' outer corners come down (the outer brow first) and the lids grow
// heavier; younger lifts and sharpens. Proportions: older, the midface and lower face lengthen and the
// temples hollow; younger, a "babyface": bigger eyes, a shorter lower face, a narrower chin, higher
// brows. Nose: older it lengthens and its tip droops; younger it is smaller, the tip lifted. Lips:
// older the red of the lips thins and the skin above them lengthens (younger plumps, as Fillers).
// Brows: younger, a little fuller.
function ageSculpt(v, a) {
  const y = (k) => Math.max(0, -a[k]), o = (k) => Math.max(0, a[k]);
  const add = {
    lift: 0.8 * y('sag') - 0.9 * o('sag'), jawShape: 0.3 * y('sag') - 0.35 * o('sag'), jawline: 0.2 * y('sag') - 0.35 * o('sag'),
    browLift: -0.3 * o('sag') + 0.15 * y('shape'), eyeTail: -0.3 * o('sag'), eyeHeight: -0.12 * o('sag'),
    midface: 0.2 * o('shape'), lowerFace: 0.2 * o('shape') - 0.35 * y('shape'), temples: -0.25 * o('shape'),
    eyeSize: 0.25 * y('shape'), chinWidth: -0.25 * y('shape'),
    noseLength: 0.45 * o('nose'), noseTip: -0.5 * o('nose') + 0.2 * y('nose'), noseWidth: 0.12 * o('nose'), noseSize: -0.3 * y('nose'),
    lipSize: -0.35 * o('lips'), lipUpper: -0.4 * o('lips'), philtrum: 0.3 * o('lips'),
    browThickness: 0.15 * y('brows'),
    hairline: 0.6 * o('hairline') - 0.4 * y('hairline'),
  };
  const out = { ...v };
  for (const [id, k] of Object.entries(add)) {
    if (!k) continue;
    const h = out[id] || [0, 0];
    out[id] = [h[0] + k, h[1] + k];
  }
  return out;
}

// After Age changes: its warps, and the hair area Grey hair needs.
function ageChanged() {
  const s = app.state, grey = s.age.grey > 0;
  if (grey) ensureParts();
  if (grey !== Boolean(app.ageGrey)) {
    app.ageGrey = grey;
    redrawHair();
  }
  updateWarp();
}

function setAge(t, off, shade = app.state.age.shade) {
  app.state.age = ageAt(t, off, shade);
  ageChanged();
  commitUI();
}

// Age: Look holds None, Younger and Older, the Age slider and every part it is changing, each of them
// adjustable there (as AirBrush's makeup looks are built from parts, each changeable); Skin, Face and
// Hair hold every part's slider, and Hair the shade grey hair turns.
function ageSpec(noFace) {
  const s = app.state, a = s.age;
  const any = (tab) => AGE_PARTS.some((p) => (!tab || p[3] === tab) && a[p[0]]);
  const tabs = tabsOf([['look', 'Look', a.t !== 0], ['skin', 'Skin', any('skin')], ['face', 'Face', any('face')],
    ['hair', 'Hair', any('hair') || a.shade !== 'silver']], 'age');
  const note = noFace ? FACE_NOTE() : a.grey > 0 ? partsNote() : null;
  const tab = app.tab.age;
  const partItem = (group) => ([k, label, ic, , , , young]) => itParam(group, `age.${k}`, label, ic, young ? -100 : 0, { disabled: noFace });
  // A part moved by hand keeps its difference from the Age slider's course, so the slider still works.
  const after = (group) => (v) => {
    const p = AGE_PARTS.find(([k]) => `age.${k}` === app.param[group]);
    if (p) a.off[p[0]] = +(v - agePart(p, a.t)).toFixed(3);
    ageChanged();
  };
  if (tab === 'skin' || tab === 'face' || tab === 'hair') {
    const parts = AGE_PARTS.filter((p) => p[3] === tab);
    const items = parts.map(partItem('age'));
    if (tab === 'hair') {
      items.push(divider('age-greys'), ...AGE_GREYS.map((g) => itSwatch(`age-grey-${g.id}`, g.name, {
        hex: g.hex, pressed: a.shade === g.id, disabled: noFace, onTap: () => setAge(a.t, a.off, g.id),
      })));
    }
    items.push(itIcon('reset', 'Reset', 'reset', {
      disabled: !parts.some(([k]) => a.off[k]) && (tab !== 'hair' || a.shade === 'silver'),
      onTap: () => {
        const off = { ...a.off };
        for (const [k] of parts) delete off[k];
        setAge(a.t, off, tab === 'hair' ? 'silver' : a.shade);
      },
    }));
    const hints = {
      skin: 'Each skin part, on top of the Age slider',
      face: 'Each part of the face, on top of the Age slider',
      hair: 'How grey, starting at the temples, in which shade; the hairline',
    };
    return { tabs, items, slider: noFace ? null : boundParam('age', items, after('age')), note, hint: hints[tab] };
  }
  const look = (id, label) => itThumb(`age-${id}`, label, {
    pressed: id === 'none' ? !any() : Math.sign(a.t) === Math.sign(AGE_LOOKS[id]),
    disabled: noFace,
    thumb: { rect: 'face', state: () => ({ ...app.state, age: id === 'none' ? ageAt(0) : ageAt(AGE_LOOKS[id], a.off, a.shade) }) },
    onTap: () => {
      app.param.ageLook = 'age.t';
      if (id === 'none') setAge(0, {}, 'silver');
      else setAge(AGE_LOOKS[id], a.off);
    },
  });
  const slide = () => {
    app.state.age = ageAt(app.state.age.t, app.state.age.off, app.state.age.shade);
    ageChanged();
  };
  // Every part the Age slider (or a hand) is changing, in the order of the tabs, and the one being
  // adjusted even once it is back at 0.
  const changing = AGE_PARTS.filter(([k]) => Math.abs(a[k]) > 0.004 || app.param.ageLook === `age.${k}`).map(partItem('ageLook'));
  const items = [
    look('none', 'None'), look('younger', 'Younger'), look('older', 'Older'), divider('age-parts'),
    itParam('ageLook', 'age.t', 'Age', 'age', -100, { disabled: noFace }), ...changing,
  ];
  const partAfter = after('ageLook');
  return {
    tabs, items,
    slider: noFace ? null : boundParam('ageLook', items, (v) => (app.param.ageLook === 'age.t' ? slide() : partAfter(v))),
    note,
    hint: changing.length ? 'Each part the Age slider is changing: tap one to change it' : 'Slide left for younger, right for older',
  };
}

// Presets: the state a preset sets, at its Look and Background (0–1). Clearing puts back every key
// it touched.
const presetById = (id) => PRESETS.find((p) => p.id === id) || null;
function presetPaths(p) {
  return ['filter.id', 'filter.amt', ...Object.keys(p.set), ...(p.bg.blur ? ['bg.blur'] : []), ...(p.bg.bright ? ['bg.bright'] : [])];
}
function clearPreset(s) {
  const p = presetById(s.preset.id);
  if (!p) return;
  for (const path of presetPaths(p)) {
    if (path.startsWith('sculpt.')) setRecipe(s, path, 0);
    else setPath(s, path, structuredClone(getPath(DEFAULTS, path)));
  }
  s.preset.id = 'none';
}
function writePreset(s, p) {
  const k = s.preset.look, b = s.preset.bg;
  s.filter.id = p.filter[0];
  s.filter.amt = +(p.filter[1] * Math.min(1.25, 0.25 + k)).toFixed(3);
  for (const [path, v] of Object.entries(p.set)) setRecipe(s, path, +(v * k).toFixed(3));
  if (p.bg.blur) s.bg.blur = +(p.bg.blur * b).toFixed(3);
  if (p.bg.bright) s.bg.bright = +(p.bg.bright * b).toFixed(3);
  s.preset.id = p.id;
}
function applyPreset(id) {
  const s = app.state;
  clearPreset(s);
  const p = presetById(id);
  if (p) {
    writePreset(s, p);
    if (p.bg.blur || p.bg.bright) ensurePerson();
  }
  updateWarp();
  commitUI();
}

function removeAuto() {
  const s = app.state;
  s.auto.on = false;
  for (const path of Object.keys(AUTO_RECIPE)) setRecipe(s, path, 0);
  if (s.heals.some((h) => h.auto)) {
    s.heals = s.heals.filter((h) => !h.auto);
    replayHeals();
  }
  s.auto.spots = 0;
  updateWarp();
  commit();
  syncUI();
  render();
}

// Body shaping needs the pose and the subject's outline; Fillers' lips, Teeth › Align and Hair's
// Volume and Hairline are warps too (Hair's hairline adds to every face's Sculpt hairline).
function warpInputs(s) {
  const body = app.pose && bodyActive(s.body)
    ? { pose: app.pose, mask: app.seg ? { data: app.seg, w: layers.person.width, h: layers.person.height } : null, values: s.body, faced: app.faces.length > 0 }
    : null;
  const hl = s.hair.hairline;
  const sculpt = app.faces.map((f, i) => {
    const v = ageSculpt(s.sculpt.faces[i] || {}, s.age);
    if (!hl) return v;
    const h = v.hairline || [0, 0];
    return { ...v, hairline: [h[0] + hl, h[1] + hl] };
  });
  const hairFound = s.hairStrokes.length > 0 || s.hair.auto;
  const hair = s.hair.volume && hairFound ? { k: s.hair.volume, mask: { data: hairAlpha(), w: layers.hair.width, h: layers.hair.height } } : null;
  const plump = Math.max(s.plump.lips, 0.5 * Math.max(0, -s.age.lips));
  return [{ sculpt, plump, align: s.teeth.align, img: app.work, hair }, s.pushes, body];
}

function updateWarp() {
  const [rs, pushes, body] = warpInputs(app.state);
  app.warp = buildWarp(app.faces, app.W, app.H, rs, pushes, body);
  app.warpDirty = true;
}

// Reshape › Protect scales every warp by the painted mask, taken at warp-grid size once per paint.
function uploadedField(w, s) {
  if (!w || !s.protectStrokes.length) return w && w.field;
  const key = `${app.protectVersion}|${w.gw}x${w.gh}`;
  if (app.protectGrid?.key !== key) {
    const L = layers.protect;
    app.protectGrid = { key, mask: protectMask(L.alpha(), L.width, L.height, w.gw, w.gh) };
  }
  return protectField(w.field, app.protectGrid.mask, s.protectInvert);
}

// After Protect's strokes or Invert change: the mask is taken again and the warp re-sent.
function protectChanged() {
  app.protectVersion++;
  app.warpDirty = true;
}

// Histogram-based correction. It deliberately never aims the face at a target brightness, which
// would push darker skin toward a light norm; it only repairs range, clipping and strong casts.
function autoAdjust() {
  const { data } = app.work;
  const step = Math.max(1, Math.floor(data.length / 4 / 60000)) * 4;
  const hist = new Uint32Array(256);
  let r = 0, g = 0, b = 0, n = 0;
  for (let i = 0; i < data.length; i += step) {
    hist[Math.round(0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2])]++;
    r += data[i];
    g += data[i + 1];
    b += data[i + 2];
    n++;
  }
  const pct = (q) => {
    let acc = 0;
    for (let v = 0; v < 256; v++) if ((acc += hist[v]) >= q * n) return v / 255;
    return 1;
  };
  const share = (lo, hi) => hist.slice(lo, hi + 1).reduce((s, v) => s + v, 0) / n;
  const lo = pct(0.01), hi = pct(0.99);
  const cast = (b - r) / Math.max((r + g + b) / 3, 1);
  const next = {
    light: hi < 0.92 ? +clamp(Math.log2(0.95 / Math.max(hi, 0.2)) / 0.9, 0, 0.5).toFixed(2) : 0,
    contrast: +clamp((0.85 - (hi - lo)) * 1.2, 0, 0.35).toFixed(2),
    highlights: share(250, 255) > 0.02 ? -0.35 : 0,
    shadows: share(0, 8) > 0.04 ? 0.25 : 0,
    temperature: Math.abs(cast) > 0.12 ? +clamp(cast * 0.8, -0.3, 0.3).toFixed(2) : 0,
  };
  if (Object.values(next).every((v) => v === 0)) {
    toast('No adjustment needed');
    return;
  }
  Object.assign(app.state.adjust, next);
  commit();
  syncUI();
  render();
  toast('Auto adjustments applied');
}

// Clears the listed parts of the state back to their defaults (a tool's Reset or Clear).
function resetKeys(keys) {
  const s = app.state;
  for (const k of keys) s[k] = structuredClone(DEFAULTS[k]);
  if (keys.includes('strokes') || keys.includes('skinFace')) redrawSkin();
  for (const name of PLAIN_LAYERS) {
    if (keys.includes(LAYER_STROKES[name])) layers[name].redraw(s[LAYER_STROKES[name]]);
  }
  if (keys.includes('hairStrokes') || keys.includes('hair')) redrawHair();
  if (keys.includes('bgStrokes')) redrawPerson();
  if (keys.includes('protectStrokes') || keys.includes('protectInvert')) protectChanged();
  if (keys.includes('age')) ageChanged();
  if (['sculpt', 'pushes', 'body', 'plump', 'teeth', 'hair'].some((k) => keys.includes(k))) updateWarp();
  if (keys.includes('makeup')) ensureMakeupMasks();
  if (keys.includes('people')) syncPeople();
  commit();
  syncUI();
  render();
}

// Each heal-based tool's Clear keeps the other tools' work.
function clearHeals(kind) {
  const s = app.state;
  s.heals = s.heals.filter((h) => healKind(h) !== kind);
  if (kind === 'blemish') s.auto.spots = 0;
  replayHeals();
  commit();
  syncUI();
  render();
}

// ---------- the subject (background tools, relight, body) ----------

function ensurePerson() {
  if (app.seg || app.personPending || app.segFailed || !app.W) return;
  const token = app.loadToken;
  app.personPending = segmentPerson(app.canvas)
    .then((seg) => {
      if (token === app.loadToken) setSegmentation(seg);
    })
    .catch((e) => {
      console.warn('Segmentation unavailable:', e);
      if (token !== app.loadToken) return;
      app.segFailed = true;
      combinePerson();   // the hair-and-skin model's cut-out, if it has run
    })
    .finally(() => {
      app.personPending = null;
      if (token === app.loadToken) {
        syncUI();
        render();
      }
    });
  syncUI();
}

// An 8-bit plane resampled to w × h with smooth interpolation.
// An 8-bit plane at mask size as 0–1 floats on the quarter-size grid: 2 × 2 means when the grid is
// half the mask's size (it is, as MASK_SCALE is 0.5), so no canvas round trip.
function toGrid(data, sw, sh, w, h) {
  if (Math.abs(sw / w - 2) > 0.02 || Math.abs(sh / h - 2) > 0.02) return Float32Array.from(resizePlane(data, sw, sh, w, h), (v) => v / 255);
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const r0 = Math.min(sh - 1, y * 2) * sw, r1 = Math.min(sh - 1, y * 2 + 1) * sw;
    for (let x = 0; x < w; x++) {
      const c0 = Math.min(sw - 1, x * 2), c1 = Math.min(sw - 1, x * 2 + 1);
      out[y * w + x] = (data[r0 + c0] + data[r0 + c1] + data[r1 + c0] + data[r1 + c1]) / 1020;
    }
  }
  return out;
}

function resizePlane(data, sw, sh, w, h) {
  const src = document.createElement('canvas');
  src.width = sw;
  src.height = sh;
  const id = new ImageData(sw, sh);
  for (let i = 0; i < data.length; i++) {
    id.data[i * 4] = id.data[i * 4 + 1] = id.data[i * 4 + 2] = data[i];
    id.data[i * 4 + 3] = 255;
  }
  src.getContext('2d').putImageData(id, 0, 0);
  const dst = document.createElement('canvas');
  dst.width = w;
  dst.height = h;
  const dctx = dst.getContext('2d', { willReadFrequently: true });
  dctx.imageSmoothingQuality = 'high';
  dctx.drawImage(src, 0, 0, w, h);
  const d = dctx.getImageData(0, 0, w, h).data;
  const out = new Uint8ClampedArray(w * h);
  for (let i = 0; i < out.length; i++) out[i] = d[i * 4];
  release(src, dst);
  return out;
}

// seg: { w, h, data } with 0–255 subject probability from the selfie model; resampled to mask size.
function setSegmentation(seg) {
  app.segSelfie = resizePlane(seg.data, seg.w, seg.h, layers.person.width, layers.person.height);
  combinePerson();
  render();
}

// The subject mask. The selfie model is small and answers first; the hair-and-skin model, once it
// has run, is far better at hair and at telling a person from a pillar or railing behind them, so
// its cut-out takes over (its background class never drops much below 0.1, so 0.1–0.85 is
// stretched to 0–1). It sometimes drops a forearm or hand resting on a table, so what the selfie
// model found and that has this person's own skin colour is added back.
function combinePerson() {
  const sel = app.segSelfie, mc = app.segParts;
  if (!sel && !(mc && app.segFailed)) return;
  if (!mc) {
    app.seg = sel;
  } else {
    const mw = layers.person.width, mh = layers.person.height, sk = app.skin;
    const { data, width: W, height: H } = app.orig;
    const out = new Uint8ClampedArray(mw * mh);
    for (let i = 0; i < out.length; i++) {
      let v = (mc[i] - 25.5) / 0.75;
      if (sel && sk && sel[i] > 128 && v < 200) {
        const x = i % mw, y = (i - x) / mw;
        const j = (Math.min(H - 1, Math.round(((y + 0.5) * H) / mh)) * W + Math.min(W - 1, Math.round(((x + 0.5) * W) / mw))) * 4;
        const r = data[j] / 255, g = data[j + 1] / 255, b = data[j + 2] / 255, Y = 0.299 * r + 0.587 * g + 0.114 * b;
        const dx = (b - Y) * 0.564 + 0.5 - sk.mean[0], dy = (r - Y) * 0.713 + 0.5 - sk.mean[1];
        const d = Math.sqrt(Math.max(0, dx * (sk.inv[0] * dx + sk.inv[1] * dy) + dy * (sk.inv[2] * dx + sk.inv[3] * dy)));
        if (Y > 0.08) v = Math.max(v, sel[i] * clamp((3.5 - d) / 1.5, 0, 1));
      }
      out[i] = v;
    }
    app.seg = out;
  }
  redrawPerson();
}

// Makeup › Lips: the lip area drawn from the landmarks is fitted to the lips' own edge in the photo
// with the colour guided filter, mouth by mouth at mask size (AirBrush fits its lipstick with a guided
// filter too). Well inside the outline it stays solid and a few pixels outside it stays empty.
// Returns each mouth's average lip lightness (0–1), for taking existing lipstick down.
function fitLips(m) {
  const { mw, mh, feat } = m, sc = mw / app.W, d = app.orig.data, W = app.W, H = app.H;
  const ramp = (e0, e1, x) => {
    const t = clamp((x - e0) / (e1 - e0), 0, 1);
    return t * t * (3 - 2 * t);
  };
  return app.faces.slice(0, 4).map((f) => {
    const c = f.mouth.c, w = f.mouth.w;
    const x0 = Math.max(0, Math.floor((c[0] - w * 0.8) * sc)), x1 = Math.min(mw - 1, Math.ceil((c[0] + w * 0.8) * sc));
    const y0 = Math.max(0, Math.floor((c[1] - w * 0.6) * sc)), y1 = Math.min(mh - 1, Math.ceil((c[1] + w * 0.6) * sc));
    const bw = x1 - x0 + 1, bh = y1 - y0 + 1, n = bw * bh;
    if (bw < 8 || bh < 8) return 0;
    const R = new Float32Array(n), G = new Float32Array(n), B = new Float32Array(n), p = new Float32Array(n);
    const step = Math.max(1, Math.round(1 / sc));
    for (let y = 0; y < bh; y++) {
      for (let x = 0; x < bw; x++) {
        const i = y * bw + x;
        p[i] = feat[((y0 + y) * mw + x0 + x) * 4 + 2] / 255;
        let r = 0, g = 0, b = 0, k = 0;
        for (let dy = 0; dy < step; dy++) {
          for (let dx = 0; dx < step; dx++) {
            const px = Math.min(W - 1, Math.floor((x0 + x) / sc) + dx), py = Math.min(H - 1, Math.floor((y0 + y) / sc) + dy);
            const j = (py * W + px) * 4;
            r += d[j];
            g += d[j + 1];
            b += d[j + 2];
            k++;
          }
        }
        R[i] = r / k / 255;
        G[i] = g / k / 255;
        B[i] = b / k / 255;
      }
    }
    const r = Math.max(2, Math.round(w * sc * 0.06));
    const ab = guidedCoeffs(R, G, B, p, bw, bh, r, 1e-3);
    const near = blurFloat(Float32Array.from(p), bw, bh, Math.max(1, Math.round(r / 2)), 1);
    let sum = 0, wt = 0;
    for (let y = 0; y < bh; y++) {
      for (let x = 0; x < bw; x++) {
        const i = y * bw + x;
        const q = ab[i * 4] * R[i] + ab[i * 4 + 1] * G[i] + ab[i * 4 + 2] * B[i] + ab[i * 4 + 3];
        const v = clamp(Math.min(ramp(0.05, 0.35, near[i]), Math.max(ramp(0.65, 0.95, near[i]), q)), 0, 1);
        feat[((y0 + y) * mw + x0 + x) * 4 + 2] = Math.round(255 * v);
        sum += v * (0.299 * R[i] + 0.587 * G[i] + 0.114 * B[i]);
        wt += v;
      }
    }
    return wt > 1 ? sum / wt : 0;
  });
}

// The photo at quarter size as float planes (made once a photo): the guide for the cut-out's
// refinement and for Tap.
function ensureGuide() {
  const gw = Math.max(1, Math.ceil(app.W / 4)), gh = Math.max(1, Math.ceil(app.H / 4)), n = gw * gh;
  if (app.guide?.canvas !== app.canvas) {
    const c = document.createElement('canvas');
    c.width = gw;
    c.height = gh;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(app.canvas, 0, 0, gw, gh);
    const d = ctx.getImageData(0, 0, gw, gh).data;
    release(c);
    const R = new Float32Array(n), G = new Float32Array(n), B = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      R[i] = d[i * 4] / 255;
      G[i] = d[i * 4 + 1] / 255;
      B[i] = d[i * 4 + 2] / 255;
    }
    app.guide = { canvas: app.canvas, R, G, B, w: gw, h: gh };
  }
  return app.guide;
}

// Background › Fix edges › Tap, AirBrush's Smart Select without an object model. Colours round the
// tapped point stand for the object, and colours where the cut-out sees background stand for
// what's behind it (each set reduced to a few clusters). Every pixel near the tap goes to whichever
// it is closer to, on a lightly smoothed quarter-size photo, so a textured thing (flowers, a
// pattern) is taken whole; the piece joined to the tap is the object. It is closed, fitted to the
// photo's edges with the colour guided filter, and given at the person layer's scale. A piece larger
// than a third of the photo is refused. Cached per tap point.
function tapRegion(s) {
  const key = `${app.loadToken}|${s.x},${s.y}`;
  app.tapCache ||= new Map();
  if (app.tapCache.has(key)) return app.tapCache.get(key);
  const done = (v) => {
    app.tapCache.set(key, v);
    return v;
  };
  const g = ensureGuide(), w = g.w, h = g.h, n = w * h;
  const [R, G, B] = [g.R, g.G, g.B].map((c) => blurFloat(Float32Array.from(c), w, h, 1, 1));
  const sx = clamp(Math.round(s.x / 4), 0, w - 1), sy = clamp(Math.round(s.y / 4), 0, h - 1);
  const rw = Math.round(0.28 * Math.max(w, h));
  const wx0 = Math.max(0, sx - rw), wx1 = Math.min(w - 1, sx + rw), wy0 = Math.max(0, sy - rw), wy1 = Math.min(h - 1, sy + rw);
  const col = (i) => [R[i], G[i], B[i]];
  // The object's samples: 11 × 11 round the tap. The background's: pixels in the window the cut-out
  // calls background, at least a little way from the tap (or the window's rim if there's no cut-out).
  const obj = [], bg = [];
  for (let dy = -5; dy <= 5; dy++) for (let dx = -5; dx <= 5; dx++) obj.push(col(clamp(sy + dy, 0, h - 1) * w + clamp(sx + dx, 0, w - 1)));
  const seg = app.seg, sw = layers.person.width, shh = layers.person.height, far = 0.06 * Math.max(w, h);
  const step = Math.max(1, Math.round(rw / 24));
  for (let y = wy0; y <= wy1; y += step) {
    for (let x = wx0; x <= wx1; x += step) {
      if (Math.hypot(x - sx, y - sy) < far) continue;
      const rim = x === wx0 || x === wx1 || y === wy0 || y === wy1;
      const back = seg ? seg[Math.min(shh - 1, Math.round((y * shh) / h)) * sw + Math.min(sw - 1, Math.round((x * sw) / w))] < 50 : rim;
      if (back) bg.push(col(y * w + x));
    }
  }
  if (bg.length < 8) return done(null);
  // A few rounds of k-means, seeded from evenly spaced samples, so the same tap always gives the same
  // clusters.
  const clusters = (pts, k) => {
    const c = Array.from({ length: Math.min(k, pts.length) }, (_, j) => [...pts[Math.floor((j * pts.length) / Math.min(k, pts.length))]]);
    for (let it = 0; it < 6; it++) {
      const sum = c.map(() => [0, 0, 0, 0]);
      for (const p of pts) {
        let best = 0, bd = Infinity;
        c.forEach((q, j) => {
          const d = (p[0] - q[0]) ** 2 + (p[1] - q[1]) ** 2 + (p[2] - q[2]) ** 2;
          if (d < bd) { bd = d; best = j; }
        });
        sum[best][0] += p[0]; sum[best][1] += p[1]; sum[best][2] += p[2]; sum[best][3]++;
      }
      sum.forEach((q, j) => { if (q[3]) c[j] = [q[0] / q[3], q[1] / q[3], q[2] / q[3]]; });
    }
    return c;
  };
  const co = clusters(obj, 4), cb = clusters(bg, 6);
  const near = (cs, i) => Math.min(...cs.map((q) => (R[i] - q[0]) ** 2 + (G[i] - q[1]) ** 2 + (B[i] - q[2]) ** 2));
  const inside = new Uint8Array(n), queue = new Int32Array(n);
  let head = 0, tail = 0, x0 = sx, x1 = sx, y0 = sy, y1 = sy;
  inside[sy * w + sx] = 1;
  queue[tail++] = sy * w + sx;
  while (head < tail) {
    if (head > n / 3) return done(null);
    const i = queue[head++], x = i % w, y = (i - x) / w;
    x0 = Math.min(x0, x);
    x1 = Math.max(x1, x);
    y0 = Math.min(y0, y);
    y1 = Math.max(y1, y);
    for (const [nx, ny] of [[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]]) {
      if (nx < wx0 || ny < wy0 || nx > wx1 || ny > wy1) continue;
      const j = ny * w + nx;
      if (inside[j] || near(co, j) * 1.15 > near(cb, j)) continue;
      inside[j] = 1;
      queue[tail++] = j;
    }
  }
  if (tail < 12) return done(null);
  // The region's box with a margin, closed (grown, then shrunk, by two pixels) and fitted to the photo.
  const m = 8, bx0 = Math.max(0, x0 - m), by0 = Math.max(0, y0 - m), bx1 = Math.min(w - 1, x1 + m), by1 = Math.min(h - 1, y1 + m);
  const bw = bx1 - bx0 + 1, bh = by1 - by0 + 1, bn = bw * bh;
  const box = (src) => Float32Array.from({ length: bn }, (_, i) => src[(by0 + Math.floor(i / bw)) * w + bx0 + (i % bw)]);
  const morph = (a, shrink) => Float32Array.from({ length: bn }, (_, i) => {
    const x = i % bw, y = Math.floor(i / bw);
    let v = shrink ? 1 : 0;
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        const q = a[clamp(y + dy, 0, bh - 1) * bw + clamp(x + dx, 0, bw - 1)];
        v = shrink ? Math.min(v, q) : Math.max(v, q);
      }
    }
    return v;
  });
  const p = morph(morph(box(inside), false), true);
  const gr = box(R), gg = box(G), gb = box(B);
  const ab = guidedCoeffs(gr, gg, gb, p, bw, bh, 2, 1e-3);
  const soft = blurFloat(Float32Array.from(p), bw, bh, 1, 1);
  const ramp = (e0, e1, v) => {
    const t = clamp((v - e0) / (e1 - e0), 0, 1);
    return t * t * (3 - 2 * t);
  };
  // At the layer's scale (twice the guide's), sampled bilinearly.
  const sc = layers.person.width / w, ow = Math.round(bw * sc), oh = Math.round(bh * sc);
  const at = (arr, fx, fy) => {
    const x = clamp(fx, 0, bw - 1), y = clamp(fy, 0, bh - 1), xa = Math.floor(x), ya = Math.floor(y);
    const xb = Math.min(bw - 1, xa + 1), yb = Math.min(bh - 1, ya + 1), tx = x - xa, ty = y - ya;
    return (arr[ya * bw + xa] * (1 - tx) + arr[ya * bw + xb] * tx) * (1 - ty) + (arr[yb * bw + xa] * (1 - tx) + arr[yb * bw + xb] * tx) * ty;
  };
  const a = new Uint8ClampedArray(ow * oh);
  for (let y = 0; y < oh; y++) {
    for (let x = 0; x < ow; x++) {
      const fx = (x + 0.5) / sc - 0.5, fy = (y + 0.5) / sc - 0.5;
      const i = clamp(Math.round(fy), 0, bh - 1) * bw + clamp(Math.round(fx), 0, bw - 1);
      const q = ab[i * 4] * at(gr, fx, fy) + ab[i * 4 + 1] * at(gg, fx, fy) + ab[i * 4 + 2] * at(gb, fx, fy) + ab[i * 4 + 3];
      const nv = at(soft, fx, fy);
      a[y * ow + x] = 255 * clamp(Math.min(ramp(0.05, 0.35, nv), Math.max(ramp(0.65, 0.95, nv), q)), 0, 1);
    }
  }
  return done({ a, w: ow, h: oh, x0: Math.round(bx0 * sc), y0: Math.round(by0 * sc) });
}

// A painted layer's area refined onto the photo's own edges, for Renderer.setMatte: the colour
// guided filter's coefficients, worked out on a quarter-size copy of the photo (made once a photo),
// and limits that keep it solid well inside the layer's outline and empty a few pixels outside it.
function refineLayer(layer) {
  const { R, G, B, w: gw, h: gh } = ensureGuide(), n = gw * gh;
  const p = Float32Array.from(resizePlane(layer.alpha(), layer.width, layer.height, gw, gh), (v) => v / 255);
  const r = Math.max(2, Math.round(Math.hypot(gw, gh) / 120));
  const ab = guidedCoeffs(R, G, B, p, gw, gh, r, 1e-3);
  const near = blurFloat(p, gw, gh, Math.max(1, Math.round(r / 2)), 1);
  const lh = new Uint8Array(n * 2);
  const ramp = (e0, e1, x) => {
    const t = clamp((x - e0) / (e1 - e0), 0, 1);
    return t * t * (3 - 2 * t);
  };
  for (let i = 0; i < n; i++) {
    lh[i * 2] = 255 * ramp(0.65, 0.95, near[i]);
    lh[i * 2 + 1] = 255 * ramp(0.05, 0.35, near[i]);
  }
  return { ab, lh, near, w: gw, h: gh };
}

// The refined cut-out for the background tools, remade when the cut-out or its strokes change.
function ensureMatte() {
  if (!app.personReady || app.matteVersion === app.personVersion) return;
  app.matteVersion = app.personVersion;
  const m = refineLayer(layers.person);
  app.matteNear = { data: m.near, w: m.w, h: m.h };
  renderer.setMatte('person', m);
}

// Background Freeze's plate, at half size: the photo with everything the refined cut-out can reach
// (and a little more) filled in, at once smoothly from the colours around it, then, along the
// outline where a reshape can uncover the background, with patches of the background itself.
function ensureFreezePlate() {
  const key = `${app.loadToken}|${app.matteVersion}|${app.workVersion}`;
  if (key === app.freezeKey || !app.matteNear) return;
  app.freezeKey = key;
  const job = ++app.freezeJob;
  const W = app.W, H = app.H, pw = Math.ceil(W / 2), ph = Math.ceil(H / 2), n = pw * ph, d = app.work.data;
  const img = new Float32Array(n * 3);
  for (let y = 0; y < ph; y++) {
    for (let x = 0; x < pw; x++) {
      let r = 0, g = 0, b = 0, k = 0;
      for (let dy = 0; dy < 2; dy++) {
        for (let dx = 0; dx < 2; dx++) {
          const yy = y * 2 + dy, xx = x * 2 + dx;
          if (yy >= H || xx >= W) continue;
          const j = (yy * W + xx) * 4;
          r += d[j];
          g += d[j + 1];
          b += d[j + 2];
          k++;
        }
      }
      const o = (y * pw + x) * 3;
      img[o] = r / k;
      img[o + 1] = g / k;
      img[o + 2] = b / k;
    }
  }
  // The hole: wherever the blurred cut-out is above 2% (the refined cut-out stops at 5%), widened by
  // about 0.6% of the diagonal so stray strands just outside the cut-out are filled over too.
  const { data: near, w: qw, h: qh } = app.matteNear;
  const reach = new Uint8Array(n);
  for (let y = 0; y < ph; y++) {
    const fy = clamp(((y + 0.5) * qh) / ph - 0.5, 0, qh - 1), y0 = Math.floor(fy), y1 = Math.min(qh - 1, y0 + 1), ty = fy - y0;
    for (let x = 0; x < pw; x++) {
      const fx = clamp(((x + 0.5) * qw) / pw - 0.5, 0, qw - 1), x0 = Math.floor(fx), x1 = Math.min(qw - 1, x0 + 1), tx = fx - x0;
      const v = (near[y0 * qw + x0] * (1 - tx) + near[y0 * qw + x1] * tx) * (1 - ty) + (near[y1 * qw + x0] * (1 - tx) + near[y1 * qw + x1] * tx) * ty;
      reach[y * pw + x] = v > 0.02 ? 1 : 0;
    }
  }
  const grow = Math.max(2, Math.round(0.006 * Math.hypot(pw, ph)));
  const rows = new Uint8Array(n), hole = new Uint8Array(n);
  for (let y = 0; y < ph; y++) {
    for (let x = 0; x < pw; x++) {
      let v = 0;
      for (let dx = -grow; dx <= grow && !v; dx++) {
        const xx = x + dx;
        if (xx >= 0 && xx < pw) v = reach[y * pw + xx];
      }
      rows[y * pw + x] = v;
    }
  }
  for (let y = 0; y < ph; y++) {
    for (let x = 0; x < pw; x++) {
      let v = 0;
      for (let dy = -grow; dy <= grow && !v; dy++) {
        const yy = y + dy;
        if (yy >= 0 && yy < ph) v = rows[yy * pw + x];
      }
      hole[y * pw + x] = v;
    }
  }
  // The plate's alpha: the hole, fading out over 3 px beyond it so it has no stepped edge.
  const soft = blurFloat(Float32Array.from(hole), pw, ph, 3, 1);
  const pack = () => {
    const out = new Uint8ClampedArray(n * 4);
    for (let i = 0; i < n; i++) {
      out[i * 4] = img[i * 3];
      out[i * 4 + 1] = img[i * 3 + 1];
      out[i * 4 + 2] = img[i * 3 + 2];
      out[i * 4 + 3] = hole[i] ? 255 : 510 * soft[i];
    }
    return out;
  };
  const photo = Float32Array.from(img);
  fillSmooth(img, hole, pw, ph);
  const smoothFill = Float32Array.from(img);
  renderer.setFreezePlate(pack(), pw, ph);
  // The patch fill runs in short slices; a newer plate stops it. The plate keeps the smooth fill's
  // colour and shading and takes only the patches' texture (grain, fine lines), so a soft or out of
  // focus background is not patched with blocks of other colours. It is then taken to full size
  // with the photo's own finest detail.
  const pause = () => new Promise((res, rej) => setTimeout(() => (job === app.freezeJob ? res() : rej(new Error('stale'))), 0));
  app.freezeDone = fillPatches(img, hole, pw, ph, Math.round(0.045 * Math.hypot(pw, ph)), pause)
    .then(async (match) => {
      if (job !== app.freezeJob) return;
      if (!match) {
        renderer.setFreezePlate(pack(), pw, ph);
        render();
        return;
      }
      for (let c = 0; c < 3; c++) {
        const ch = new Float32Array(n);
        for (let i = 0; i < n; i++) ch[i] = img[i * 3 + c];
        const low = blurFloat(Float32Array.from(ch), pw, ph, 2, 3);
        for (let i = 0; i < n; i++) if (match.target[i]) img[i * 3 + c] = smoothFill[i * 3 + c] + ch[i] - low[i];
      }
      // Full size, in slices of rows: the half-size plate scaled up (only where its alpha reaches),
      // then the band's finest detail.
      const full = new Uint8ClampedArray(W * H * 4);
      let top = H, bottom = 0;
      for (let y = 0; y < ph; y++) {
        for (let x = 0; x < pw; x++) {
          if (soft[y * pw + x] > 0 || hole[y * pw + x]) {
            top = Math.min(top, y * 2);
            bottom = Math.max(bottom, y * 2 + 2);
            break;
          }
        }
      }
      for (let y0 = top; y0 < Math.min(H, bottom); y0 += 96) {
        const y1 = Math.min(H, bottom, y0 + 96);
        for (let Y = y0; Y < y1; Y++) {
          const fy = clamp((Y + 0.5) / 2 - 0.5, 0, ph - 1), r0 = Math.floor(fy), r1 = Math.min(ph - 1, r0 + 1), ty = fy - r0;
          for (let X = 0; X < W; X++) {
            const h0 = (Y >> 1) * pw + (X >> 1), a = hole[h0] ? 255 : 510 * soft[h0];
            if (!a) continue;
            const fx = clamp((X + 0.5) / 2 - 0.5, 0, pw - 1), c0 = Math.floor(fx), c1 = Math.min(pw - 1, c0 + 1), tx = fx - c0;
            const o = (Y * W + X) * 4, i00 = (r0 * pw + c0) * 3, i01 = (r0 * pw + c1) * 3, i10 = (r1 * pw + c0) * 3, i11 = (r1 * pw + c1) * 3;
            for (let c = 0; c < 3; c++) {
              full[o + c] = (img[i00 + c] * (1 - tx) + img[i01 + c] * tx) * (1 - ty) + (img[i10 + c] * (1 - tx) + img[i11 + c] * tx) * ty;
            }
            full[o + 3] = a;
          }
        }
        fillDetail(d, W, H, match, pw, ph, photo, full, y0, y1);
        await pause();
      }
      renderer.setFreezePlate(full, W, H);
      render();
    })
    .catch((e) => {
      if (e.message !== 'stale') console.warn('Background Freeze fill failed:', e);
    });
}

// Hair's area as a matte, so colour, care and grey hair stop at the strands instead of a soft blur
// round them. The model (or Paint) gives the area roughly: the model sees the whole photo at
// 256 × 256, so its edge can be a pixel or two of its grid out, and fly-away strands reach further.
// Along that edge each pixel is split by colour between the hair and what lies behind it: the hair's
// own colour nearby (from what is surely hair), the colour behind (from what is surely background,
// skin or clothes) and where the pixel's colour sits between the two. Strands finer than the model's
// grid then get their true share, and the forehead, ears and background none. Where hair and what
// lies behind are too alike in colour to tell apart, the model's own edge is kept, made crisp, so no
// haze spreads round the hair. Found on a quarter-size copy of the photo; the hair matte shader
// (gl.js) applies it to every photo pixel.
function refineHair() {
  const { R, G, B, w, h } = ensureGuide(), n = w * h, L = layers.hair;
  const ramp = (e0, e1, x) => {
    const t = clamp((x - e0) / (e1 - e0), 0, 1);
    return t * t * (3 - 2 * t);
  };
  const p = toGrid(L.alpha(), L.width, L.height, w, h);
  const other = app.parts?.other ? toGrid(app.parts.other, L.width, L.height, w, h) : null;
  // What Paint's eraser took out of the model's area is surely not hair, whatever its colour.
  const auto = (app.state.hair.auto || app.state.age.grey > 0) && app.parts ? toGrid(app.parts.hair, L.width, L.height, w, h) : null;
  const cell = Math.max(w, h) / 256;   // one of the model's pixels on this grid
  const inner = rankFilter(p, w, h, Math.max(1, Math.round(2 * cell)), false);
  const outer = rankFilter(p, w, h, Math.max(2, Math.round(5 * cell)), true);
  const hairW = new Float32Array(n), backW = new Float32Array(n), backC = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    hairW[i] = ramp(0.6, 0.9, inner[i]);
    // Skin and clothes are sure only where the model all but rules hair out, so strands over the
    // forehead or beside the cheek keep their share.
    backW[i] = Math.max(1 - ramp(0.08, 0.3, outer[i]), other ? ramp(0.5, 0.8, other[i]) * (1 - ramp(0.05, 0.2, p[i])) : 0);
    if (auto) backW[i] = Math.max(backW[i], ramp(0.1, 0.4, auto[i] - p[i]));
    // The colour behind is read nearer the hair: skin right by the hairline is darker and pinker
    // (in the hair's shade) than further down the forehead.
    backC[i] = Math.max(backW[i], other ? ramp(0.35, 0.7, other[i]) * (1 - ramp(0.15, 0.45, p[i])) : 0);
  }
  const r = Math.max(1, Math.round(cell));
  const [fR, fG, fB, fV] = spreadColour(R, G, B, hairW, w, h, r);
  const [bR, bG, bB, bV] = spreadColour(R, G, B, backC, w, h, r);
  // The limits, softened by a grid pixel so their edges do not step when scaled up to the photo, and
  // whether what lies behind is skin or clothes (whose colour varies, pinker in a hairline's shadow).
  const lo = blurFloat(Float32Array.from(hairW), w, h, 1, 2), hi = blurFloat(Float32Array.from(backW), w, h, 1, 2);
  const near = other ? blurFloat(Float32Array.from(other), w, h, Math.max(1, Math.round(3 * cell))) : null;
  const fb = new Uint8ClampedArray(n * 4), bb = new Uint8ClampedArray(n * 4), lh = new Uint8ClampedArray(n * 4);
  for (let i = 0; i < n; i++) {
    // Colour tells hair from what lies behind when the two differ by much more than each varies
    // round here: a plain wall, or skin, beside dark hair, but not a busy background of hair's colour.
    const sep = Math.hypot(fR[i] - bR[i], fG[i] - bG[i], fB[i] - bB[i]);
    const z = sep / Math.sqrt(fV[i] + bV[i] + 4e-4);
    fb[i * 4] = fR[i] * 255;
    fb[i * 4 + 1] = fG[i] * 255;
    fb[i * 4 + 2] = fB[i] * 255;
    fb[i * 4 + 3] = 255 * ramp(0.04, 0.1, sep) * ramp(0.8, 2, z);
    bb[i * 4] = bR[i] * 255;
    bb[i * 4 + 1] = bG[i] * 255;
    bb[i * 4 + 2] = bB[i] * 255;
    bb[i * 4 + 3] = 255 * p[i];   // the model's own area (the shader makes its edge crisp)
    lh[i * 4] = 255 * lo[i];
    lh[i * 4 + 1] = 255 * (1 - hi[i]);
    lh[i * 4 + 2] = near ? 255 * ramp(0.2, 0.6, near[i]) : 0;
    lh[i * 4 + 3] = 255;
  }
  return { fb, bb, lh, w, h };
}

function ensureHairMatte() {
  if (app.hairMatteVersion === app.hairVersion) return;
  app.hairMatteVersion = app.hairVersion;
  renderer.setHairMatte(layers.hair.blank && !layers.hair.ready ? null : refineHair());
}

// Hair, body skin, face skin and clothes from the multi-class model (Hair › Auto, Matte's hair,
// Skin, Body › Tone). Loaded the first time one of them is used.
function ensureParts() {
  if (app.parts || app.partsPending || app.partsFailed || !app.W) return;
  const token = app.loadToken;
  app.partsPending = segmentParts(app.canvas)
    .then((p) => {
      if (token === app.loadToken) setParts(p);
    })
    .catch((e) => {
      console.warn('Hair and skin segmentation unavailable:', e);
      if (token === app.loadToken) app.partsFailed = true;
    })
    .finally(() => {
      app.partsPending = null;
      if (token === app.loadToken) {
        syncUI();
        render();
      }
    });
  syncUI();
}

function setParts(p) {
  const mw = layers.hair.width, mh = layers.hair.height;
  const [hair, body, face, clothes] = ['hair', 'body', 'face', 'clothes'].map((k) => resizePlane(p[k], p.w, p.h, mw, mh));
  // The model sees 256 × 256; the guided filter snaps the hair's edge to the photo's own edges.
  const guide = new Float32Array(mw * mh);
  const { data, width: W, height: H } = app.orig;
  for (let y = 0; y < mh; y++) {
    for (let x = 0; x < mw; x++) {
      const i = (Math.min(H - 1, Math.round(((y + 0.5) * H) / mh)) * W + Math.min(W - 1, Math.round(((x + 0.5) * W) / mw))) * 4;
      guide[y * mw + x] = (0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]) / 255;
    }
  }
  const r = Math.max(2, Math.round(mw / 220));
  const refine = (plane, eps) => Uint8ClampedArray.from(guidedFilter(guide, Float32Array.from(plane, (v) => v / 255), mw, mh, r, eps), (v) => v * 255);
  const hairA = refine(hair, 2e-3), bodyA = refine(body, 4e-3), faceA = refine(face, 4e-3);
  const rgba = new Uint8Array(mw * mh * 4);
  for (let i = 0; i < mw * mh; i++) {
    rgba[i * 4] = hairA[i];
    rgba[i * 4 + 1] = bodyA[i];
    rgba[i * 4 + 2] = faceA[i];
    rgba[i * 4 + 3] = clothes[i];
  }
  // The model's hair confidence tops out near 0.93 and leaves a faint trace along every outline;
  // stretched, Hair's own area is solid inside and clean outside. Skin and clothes are what the
  // hair's matte knows lies behind the hair's inner edge (forehead, ears, neck, collar).
  const other = new Uint8ClampedArray(mw * mh);
  for (let i = 0; i < mw * mh; i++) other[i] = Math.max(bodyA[i], faceA[i], clothes[i]);
  app.parts = { hair: Uint8ClampedArray.from(hairA, (v) => (v - 15) * (255 / 210)), other };
  app.segOn = true;
  renderer.setSeg(rgba, mw, mh);
  if (app.state.hair.auto || app.state.age.grey > 0) redrawHair();
  else app.hairVersion++;   // painted hair's matte can now tell skin and clothes from hair
  app.segParts = resizePlane(p.person, p.w, p.h, layers.person.width, layers.person.height);
  combinePerson();
}

// Body landmarks for Body (loaded the first time it is used).
function ensurePose() {
  if (app.pose || app.posePending || app.poseFailed || !app.W) return;
  const token = app.loadToken;
  app.posePending = detectPose(app.canvas)
    .then((pose) => {
      if (token !== app.loadToken) return;
      app.pose = pose;
      if (!pose) app.poseFailed = true;
      updateWarp();
    })
    .catch((e) => {
      console.warn('Pose detection unavailable:', e);
      if (token === app.loadToken) app.poseFailed = true;
    })
    .finally(() => {
      app.posePending = null;
      if (token === app.loadToken) {
        syncUI();
        render();
      }
    });
  syncUI();
}

async function loadBgImage(file) {
  busy('Placing background…');
  try {
    const pic = await decodeImage(new Blob([await file.arrayBuffer()], { type: file.type }));
    // Cover-fit the new background to the photo's shape.
    const k = Math.min(1, 1200 / Math.max(app.W, app.H));
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(app.W * k));
    c.height = Math.max(1, Math.round(app.H * k));
    const s = Math.max(c.width / pic.width, c.height / pic.height);
    const ctx = c.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(pic.source, (c.width - pic.width * s) / 2, (c.height - pic.height * s) / 2, pic.width * s, pic.height * s);
    pic.done();
    renderer.setBgImage(c);
    release(c);
    app.bgImageReady = true;
    app.state.bg.swap = 'photo';
    ensurePerson();
    commit();
  } catch (e) {
    console.error(e);
    toast('Could not open that photo. Try a JPEG or PNG.');
  } finally {
    busy(null);
    syncUI();
    render();
  }
}

// Background › People: a person cut out of another photo, placed beside the subject.
async function addPerson(file) {
  if (app.state.people.length >= MAX_PEOPLE) return toast('You can add up to 5 people.');
  busy('Cutting out the person…');
  try {
    const pic = await decodeImage(new Blob([await file.arrayBuffer()], { type: file.type }));
    const k = Math.min(1, 1100 / Math.max(pic.width, pic.height));
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(pic.width * k));
    c.height = Math.max(1, Math.round(pic.height * k));
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(pic.source, 0, 0, c.width, c.height);
    pic.done();
    const seg = await segmentPerson(c);
    const mask = resizePlane(seg.data, seg.w, seg.h, c.width, c.height);
    let x0 = c.width, y0 = c.height, x1 = -1, y1 = -1;
    for (let y = 0; y < c.height; y++) {
      for (let x = 0; x < c.width; x++) {
        if (mask[y * c.width + x] < 128) continue;
        x0 = Math.min(x0, x);
        x1 = Math.max(x1, x);
        y0 = Math.min(y0, y);
        y1 = Math.max(y1, y);
      }
    }
    if (x1 < 0) throw new Error('No person found');
    const img = ctx.getImageData(x0, y0, x1 - x0 + 1, y1 - y0 + 1);
    for (let y = 0; y < img.height; y++) {
      for (let x = 0; x < img.width; x++) img.data[(y * img.width + x) * 4 + 3] = mask[(y + y0) * c.width + x + x0];
    }
    const cut = document.createElement('canvas');
    cut.width = img.width;
    cut.height = img.height;
    cut.getContext('2d').putImageData(img, 0, 0);
    release(c);
    const id = `p${Date.now()}`;
    app.cutouts.set(id, cut);
    // Same height as the subject, standing on the same line, on the emptier side.
    const box = subjectBox();
    const h = box ? box[3] - box[1] : 0.7;
    const right = !box || (box[0] + box[2]) / 2 < 0.5;
    const w = ((h * cut.width) / cut.height) * (app.H / app.W);
    const x = right ? Math.min(1 - w / 2, (box ? box[2] : 0.5) + w / 2) : Math.max(w / 2, (box ? box[0] : 0.5) - w / 2);
    app.state.people.push({ id, x: +x.toFixed(4), y: +((box ? box[3] : 1) - h / 2).toFixed(4), h: +h.toFixed(4), flip: false });
    app.sel.person = id;
    syncPeople();
    ensurePerson();
    commit();
  } catch (e) {
    console.error(e);
    toast(/No person/.test(e.message) ? 'No person found in that photo.' : 'Could not open that photo. Try a JPEG or PNG.');
  } finally {
    busy(null);
    syncUI();
    render();
  }
}

// The subject's bounding box in 0–1 units, from the cut-out.
function subjectBox() {
  if (!app.seg) return null;
  const w = layers.person.width, h = layers.person.height;
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y += 2) {
    for (let x = 0; x < w; x += 2) {
      if (app.seg[y * w + x] < 128) continue;
      x0 = Math.min(x0, x);
      x1 = Math.max(x1, x);
      y0 = Math.min(y0, y);
      y1 = Math.max(y1, y);
    }
  }
  return x1 < 0 ? null : [x0 / w, y0 / h, x1 / w, y1 / h];
}

function syncPeople() {
  renderer.setPeople(app.state.people.map((p) => app.cutouts.get(p.id)).filter(Boolean));
}

// ---------- brushes and drags ----------

function brushMode() {
  if (app.view !== 'tool') return 'pan';
  const s = app.state, tab = app.tab[app.tool];
  switch (app.tool) {
    case 'smooth':
    case 'eraser':
    case 'texture':
    case 'stamp':
      return 'brush';
    case 'makeup':
      return app.tuneOn ? 'brush' : 'pan';
    case 'wrinkles':
    case 'conceal':
    case 'matte':
    case 'details':
    case 'teeth':
      return tab === 'brush' ? 'brush' : 'pan';
    case 'blemish':
      return 'tap';
    case 'hair':
      return tab === 'paint' ? 'brush' : 'pan';
    case 'reshape':
      return 'brush';
    case 'background':
      return tab === 'fix' || (tab === 'people' && s.people.length) ? 'brush' : 'pan';
    case 'relight':
      return s.relight.preset === 'custom' && app.faces.length ? 'brush' : 'pan';
    case 'body':
      return tab === 'stretch' ? 'brush' : 'pan';
    case 'filters':
      return tab === 'effects' && app.param.effects === 'effects.prism' && s.effects.prism > 0 ? 'brush' : 'pan';
    case 'glitter':
      return tab === 'glitter' ? 'brush' : 'pan';
    case 'crop':
      return tab === 'crop' ? 'brush' : 'pan';
    case 'text':
      return s.texts.length ? 'brush' : 'pan';
    default:
      return 'pan';
  }
}

// Relight › Custom: the light comes from wherever the finger is, relative to the face.
function setLightFrom([x, y]) {
  const f = app.faces[0];
  const R = f.fw * 1.1;
  let dx = (x - f.center[0]) / R, dy = (y - f.center[1]) / R;
  const d = Math.hypot(dx, dy);
  if (d > 0.95) {
    dx *= 0.95 / d;
    dy *= 0.95 / d;
  }
  app.state.relight.dir = [+dx.toFixed(3), +dy.toFixed(3)];
  render();
}

// Crop: which part of the frame a touch grabs (a corner, an edge, or the middle to move it).
function cropGrab(o) {
  const r = app.state.crop.rect, [Wf, Hs] = app.geo.out;
  const box = [r[0] * Wf, r[1] * Hs, (r[0] + r[2]) * Wf, (r[1] + r[3]) * Hs];
  const tol = 28 / vp.scale;
  const nearX = Math.abs(o[0] - box[0]) < tol ? 'l' : Math.abs(o[0] - box[2]) < tol ? 'r' : '';
  const nearY = Math.abs(o[1] - box[1]) < tol ? 't' : Math.abs(o[1] - box[3]) < tol ? 'b' : '';
  const inside = o[0] > box[0] - tol && o[0] < box[2] + tol && o[1] > box[1] - tol && o[1] < box[3] + tol;
  if (!inside) return null;
  return { edges: nearX + nearY || 'move', start: o, rect: [...r], size: [Wf, Hs] };
}

function cropDrag(L, o) {
  const s = app.state.crop, [Wf, Hs] = L.size;
  const dx = (o[0] - L.start[0]) / Wf, dy = (o[1] - L.start[1]) / Hs;
  let [x, y, w, h] = L.rect;
  const min = 0.08;
  if (L.edges === 'move') {
    x = clamp(x + dx, 0, 1 - w);
    y = clamp(y + dy, 0, 1 - h);
  } else {
    let x1 = x + w, y1 = y + h;
    if (L.edges.includes('l')) x = clamp(x + dx, 0, x1 - min);
    if (L.edges.includes('r')) x1 = clamp(x1 + dx, x + min, 1);
    if (L.edges.includes('t')) y = clamp(y + dy, 0, y1 - min);
    if (L.edges.includes('b')) y1 = clamp(y1 + dy, y + min, 1);
    w = x1 - x;
    h = y1 - y;
    const ratio = aspectValue(s.aspect);
    if (ratio) {
      // Keep the chosen shape: the dragged side wins, the other follows.
      const want = (ratio * Hs) / Wf;
      if (L.edges === 't' || L.edges === 'b') w = Math.min(h * want, 1);
      else h = Math.min(w / want, 1);
      if (h * want > 1) h = 1 / want;
      w = h * want;
      if (L.edges.includes('l')) x = x1 - w;
      if (L.edges.includes('t')) y = y1 - h;
      x = clamp(x, 0, 1 - w);
      y = clamp(y, 0, 1 - h);
    }
  }
  s.rect = [+x.toFixed(4), +y.toFixed(4), +w.toFixed(4), +h.toFixed(4)];
  render();
}

const aspectValue = (id) => {
  if (id === 'free') return 0;
  if (id === 'original') return app.W / app.H;
  const [a, b] = id.split(':').map(Number);
  return a / b;
};

// Body › Stretch: the band's lines, as 0–1 of the frame's height.
function bandLines() {
  const geo = app.geo, st = app.state.stretch;
  const [, Hf] = geo.frame, [y0, band, s, Hs] = geo.st;
  const top = s > 1 ? y0 : st.y0 * Hf, bottom = s > 1 ? y0 + band * s : st.y1 * Hf;
  const toOut = (fy) => ((fy / Hs - geo.crop[1]) / geo.crop[3]) * geo.out[1];
  return [toOut(top), toOut(bottom)];
}

// An output y (px) back to 0–1 of the unstretched frame.
function frameFromOut(oy) {
  const geo = app.geo, [, Hf] = geo.frame, [y0, band, s, Hs] = geo.st;
  let fy = (geo.crop[1] + (oy / geo.out[1]) * geo.crop[3]) * Hs;
  if (s > 1 && fy > y0) fy = fy < y0 + band * s ? y0 + (fy - y0) / s : fy - band * (s - 1);
  return clamp(fy / Hf, 0, 1);
}

// Places the band from the hips to the ankles when the body was found.
function autoBand() {
  const p = app.pose;
  const st = app.state.stretch;
  if (p && p[23][2] > 0.4 && p[24][2] > 0.4) {
    const geo = geometry(app.state.crop, app.W, app.H);
    const hip = frameY(geo, ((p[23][0] + p[24][0]) / 2) * app.W, ((p[23][1] + p[24][1]) / 2) * app.H);
    const ankles = [27, 28].filter((i) => p[i][2] > 0.3).map((i) => frameY(geo, p[i][0] * app.W, p[i][1] * app.H));
    st.y0 = +clamp(hip - 0.02, 0, 0.9).toFixed(4);
    st.y1 = +clamp(ankles.length ? Math.max(...ankles) - 0.01 : 0.96, st.y0 + 0.05, 1).toFixed(4);
  } else {
    st.y0 = 0.55;
    st.y1 = 0.95;
  }
  if (!st.amt) st.amt = 0.4;
  commitUI();
  if (!p) toast(app.poseFailed ? 'No legs found, so the band covers the lower photo. Drag the lines to adjust.' : 'Finding the body…');
}

function strokeStart(o) {
  const t = app.tool, s = app.state;
  const [x, y] = toPhoto(o);
  const r = +brushRadius().toFixed(1), p = [Math.round(x), Math.round(y)];
  if (t === 'relight') {
    app.live = { kind: 'light' };
    setLightFrom([x, y]);
    return;
  }
  if (t === 'filters') {
    app.live = { kind: 'focus' };
    s.effects.focus = [+clamp(o[0] / app.geo.out[0], 0, 1).toFixed(4), +clamp(o[1] / app.geo.out[1], 0, 1).toFixed(4)];
    render();
    return;
  }
  if (t === 'crop') {
    const grab = cropGrab(o);
    app.live = grab ? { kind: 'crop', ...grab } : { kind: 'none' };
    return;
  }
  if (t === 'body') {
    const [a, b] = bandLines();
    const tol = 34 / vp.scale;
    const which = Math.abs(o[1] - a) < Math.abs(o[1] - b) ? 'y0' : 'y1';
    if (Math.min(Math.abs(o[1] - a), Math.abs(o[1] - b)) > tol * 1.6) {
      app.live = { kind: 'none' };
      return;
    }
    app.live = { kind: 'band', which };
    return;
  }
  if (t === 'text') {
    const hit = textAt(s.texts, o[0] / app.geo.out[0], o[1] / app.geo.out[1], ...app.geo.out);
    app.sel.text = hit ? hit.id : null;
    app.live = hit ? { kind: 'text', id: hit.id, start: o, from: [hit.x, hit.y] } : { kind: 'none' };
    syncUI();
    render();
    return;
  }
  if (t === 'makeup') {
    const hit = app.tuneOn && tuneDotAt(o);
    if (!hit) {
      app.live = { kind: 'none' };
      return;
    }
    const v = s.makeup.tune[hit.face]?.[hit.part] || [0, 0];
    app.live = { kind: 'tune', ...hit, start: [x, y], from: [...v] };
    placeTuneDots();
    return;
  }
  if (t === 'background' && app.tab.background === 'fix' && app.bgTap) {
    // Tap: the object under the finger is kept sharp (Keep) or blurred with the background (Blur).
    app.live = { kind: 'none' };
    const st = { t: 1, m: app.mode.background, x: p[0], y: p[1] };
    if (!tapRegion(st)) {
      toast('Couldn’t pick out one thing there. Paint it with the brush instead');
      return;
    }
    s.bgStrokes.push(st);
    redrawPerson();
    commit();
    syncUI();
    render();
    return;
  }
  if (t === 'background' && app.tab.background === 'people') {
    const hit = personAt(x / app.W, y / app.H);
    app.sel.person = hit ? hit.id : null;
    app.live = hit ? { kind: 'person', id: hit.id, start: [x, y], from: [hit.x, hit.y] } : { kind: 'none' };
    syncUI();
    render();
    return;
  }
  if (t === 'stamp') {
    if (app.stamp.picking || !app.stamp.src) {
      app.stamp = { src: p, offset: null, picking: false };
      app.live = { kind: 'none' };
      syncUI();
      render();
      toast('Now paint where the copy should go');
      return;
    }
    const off = app.stamp.offset || [app.stamp.src[0] - p[0], app.stamp.src[1] - p[1]];
    app.stamp.offset = off;
    const cs = { c: 1, r, p, dx: off[0], dy: off[1] };
    if (app.stampFeather !== STAMP_FEATHER) cs.f = +app.stampFeather.toFixed(2);
    const { st, rect } = cloneBegin(app.work, cs);
    renderer.updateSourceRect(app.work, ...rect);
    app.live = { kind: 'clone', s: cs, st };
    render();
    return;
  }
  if (t === 'reshape' && app.tab.reshape !== 'protect') {
    if (!app.warp) {
      const [gw, gh] = gridSize(app.W, app.H);
      app.warp = { field: new Float32Array(gw * gh * 2), gw, gh };
    }
    if (app.tab.reshape === 'push') {
      const st = { r, p };
      if (app.pushStrength === 'light') st.a = PUSH_LIGHT;
      app.live = { kind: 'push', s: st, last: p };
      return;
    }
    // Resize and Restore: one dab now, then one every DAB_STEP × r along the drag.
    const st = { k: app.tab.reshape === 'restore' ? 'restore' : app.resizeDir, r, p };
    strokeDab(app.warp.field, app.warp.gw, app.warp.gh, app.W, app.H, st, p[0], p[1]);
    app.live = { kind: 'dab', s: st, last: p };
    app.warpDirty = true;
    render();
    return;
  }
  if (t === 'eraser') {
    const st = { m: 'add', r, p };
    layers.erase.redraw([]);
    app.live = { kind: 'erase', s: st, st: layers.erase.begin(st) };
  } else {
    const name = t === 'reshape' ? 'protect' : BRUSH_LAYER[t];
    const st = { m: app.mode[t], r, p };
    app.live = { kind: 'layer', name, s: st, st: layers[name].begin(st) };
  }
  render();
}

function strokeMove(o) {
  const L = app.live;
  if (!L) return;
  const s = app.state;
  if (L.kind === 'none') return;
  if (L.kind === 'focus') {
    s.effects.focus = [+clamp(o[0] / app.geo.out[0], 0, 1).toFixed(4), +clamp(o[1] / app.geo.out[1], 0, 1).toFixed(4)];
    render();
    return;
  }
  if (L.kind === 'crop') return cropDrag(L, o);
  if (L.kind === 'tune') {
    // A part moves at most an eighth of the face's width from where it was found: this nudges.
    const [x, y] = toPhoto(o), fw = app.faces[L.face].fw;
    const v = [0, 1].map((k) => +clamp(L.from[k] + ([x, y][k] - L.start[k]) / fw, -0.12, 0.12).toFixed(4));
    const t = (s.makeup.tune[L.face] ||= {});
    t[L.part] = v;
    placeTuneDots();
    render();
    return;
  }
  if (L.kind === 'band') {
    const fy = frameFromOut(o[1]);
    const st = s.stretch;
    if (L.which === 'y0') st.y0 = +clamp(fy, 0, st.y1 - 0.04).toFixed(4);
    else st.y1 = +clamp(fy, st.y0 + 0.04, 1).toFixed(4);
    render();
    return;
  }
  if (L.kind === 'text') {
    const t = s.texts.find((q) => q.id === L.id);
    t.x = +clamp(L.from[0] + (o[0] - L.start[0]) / app.geo.out[0], 0, 1).toFixed(4);
    t.y = +clamp(L.from[1] + (o[1] - L.start[1]) / app.geo.out[1], 0, 1).toFixed(4);
    render();
    return;
  }
  const [x, y] = toPhoto(o);
  if (L.kind === 'light') {
    setLightFrom([x, y]);
    return;
  }
  if (L.kind === 'person') {
    const q = s.people.find((pp) => pp.id === L.id);
    q.x = +clamp(L.from[0] + (x - L.start[0]) / app.W, 0, 1).toFixed(4);
    q.y = +clamp(L.from[1] + (y - L.start[1]) / app.H, 0, 1).toFixed(4);
    render();
    return;
  }
  const p = [Math.round(x), Math.round(y)];
  if (L.kind === 'clone') {
    L.s.p.push(p[0], p[1]);
    const rect = cloneExtend(app.work, L.s, L.st, p[0], p[1]);
    if (rect) renderer.updateSourceRect(app.work, ...rect);
    render();
    return;
  }
  if (L.kind === 'push') {
    pushSegment(app.warp.field, app.warp.gw, app.warp.gh, app.W, app.H, L.s.r, L.last[0], L.last[1], p[0], p[1], L.s.a ?? 1);
    L.s.p.push(p[0], p[1]);
    L.last = p;
    app.warpDirty = true;
    render();
    return;
  }
  if (L.kind === 'dab') {
    const step = DAB_STEP * L.s.r, [lx, ly] = L.last, d = Math.hypot(p[0] - lx, p[1] - ly);
    const n = Math.floor(d / step);
    if (!n) return;
    for (let j = 1; j <= n; j++) {
      const q = [Math.round(lx + ((p[0] - lx) * j * step) / d), Math.round(ly + ((p[1] - ly) * j * step) / d)];
      strokeDab(app.warp.field, app.warp.gw, app.warp.gh, app.W, app.H, L.s, q[0], q[1]);
      L.s.p.push(q[0], q[1]);
      L.last = q;
    }
    app.warpDirty = true;
    render();
    return;
  }
  L.s.p.push(p[0], p[1]);
  (L.kind === 'erase' ? layers.erase : layers[L.name]).extend(L.s, L.st, p[0], p[1]);
  render();
}

async function strokeEnd() {
  const L = app.live;
  app.live = null;
  if (!L || L.kind === 'none') return;
  if (['light', 'focus', 'crop', 'band', 'text', 'person', 'tune'].includes(L.kind)) {
    commit();
    syncUI();
    render();
    return;
  }
  if (L.kind === 'clone') {
    app.state.heals.push(L.s);
    app.workVersion++;
    commit();
    syncUI();
    render();
    return;
  }
  if (L.kind === 'push' || L.kind === 'dab') {
    app.state.pushes.push(L.s);
    updateWarp();
    commit();
    syncUI();
    render();
    return;
  }
  if (L.kind === 'erase') {
    busy('Erasing…');
    await nextFrame();
    const n = eraseStroke(L.s);
    layers.erase.redraw([]);
    busy(null);
    if (n) commit();
    syncUI();
    render();
    return;
  }
  app.state[LAYER_STROKES[L.name]].push(L.s);
  if (L.name === 'protect') protectChanged();
  if (L.name === 'person') {
    app.personReady = true;
    app.personVersion++;
  }
  if (L.name === 'hair') {
    app.hairCache = null;
    app.hairVersion++;
  }
  if (L.name === 'hair' && app.state.hair.color === 'none' && app.state.hairStrokes.length === 1) toast('Now pick a colour in the Colour tab');
  commit();
  syncUI();
  render();
}

function strokeCancel() {
  const L = app.live;
  app.live = null;
  if (!L || ['none', 'light', 'focus'].includes(L.kind)) return;
  if (['crop', 'band', 'text', 'person', 'tune'].includes(L.kind)) restore(app.history[app.index]);
  else if (L.kind === 'clone') replayHeals();
  else if (L.kind === 'push' || L.kind === 'dab') updateWarp();
  else if (L.kind === 'erase') layers.erase.redraw([]);
  else if (L.name === 'skin') redrawSkin();
  else if (L.name === 'hair') redrawHair();
  else if (L.name === 'person') redrawPerson();
  else layers[L.name].redraw(app.state[LAYER_STROKES[L.name]]);
  render();
}

// The added person under a photo point (0–1 units), topmost first.
function personAt(x, y) {
  for (let i = app.state.people.length - 1; i >= 0; i--) {
    const p = app.state.people[i], c = app.cutouts.get(p.id);
    if (!c) continue;
    const hh = p.h / 2, hw = (hh * (c.width / c.height) * app.H) / app.W;
    if (Math.abs(x - p.x) <= hw && Math.abs(y - p.y) <= hh) return p;
  }
  return null;
}

// ---------- before / after ----------

// The current photo with only one tool's work taken away.
function beforeFor(tool) {
  const cur = app.state, s = structuredClone(cur), flags = {};
  switch (tool) {
    case 'auto':
      for (const p of Object.keys(AUTO_RECIPE)) setRecipe(s, p, 0);
      flags.useOrig = cur.heals.some((h) => h.auto);
      break;
    case 'smooth':
      s.smooth = 0;
      s.even = 0;
      s.depth = 0;
      break;
    case 'blemish':
    case 'eraser':
    case 'stamp':
      flags.useOrig = cur.heals.length > 0;
      break;
    case 'hair':
      s.hair = { ...structuredClone(DEFAULTS.hair), auto: cur.hair.auto };
      break;
    case 'relight':
      s.relight.preset = 'none';
      break;
    case 'background':
      s.bg = structuredClone(DEFAULTS.bg);
      s.people = [];
      break;
    case 'crop':
      break;
    case 'presets':
      clearPreset(s);
      break;
    default:
      for (const k of TOOL_KEYS[tool] || []) s[k] = structuredClone(DEFAULTS[k]);
  }
  const shape = (x) => JSON.stringify([x.sculpt, x.pushes, x.body, x.plump.lips, x.teeth.align, x.hair.volume, x.hair.hairline, x.protectStrokes, x.protectInvert, x.age]);
  flags.tempWarp = shape(s) !== shape(cur);
  return { state: s, flags };
}

function startCompare(kind) {
  if (kind === 'tool') {
    const b = beforeFor(app.tool);
    app.beforeState = b.state;
    app.beforeFlags = b.flags;
    if (b.flags.tempWarp) {
      const w = buildWarp(app.faces, app.W, app.H, ...warpInputs(b.state));
      renderer.setTempWarp(w && { ...w, field: uploadedField(w, b.state) });
    }
  }
  app.comparing = kind;
  $('#before').textContent = kind === 'all' ? 'Before · all edits' : `Before · ${toolName(app.tool)}`;
  $('#before').hidden = false;
  $('#toast').hidden = true;
  render();
}

function stopCompare() {
  app.comparing = null;
  renderer.setTempWarp(undefined);
  $('#before').hidden = true;
  render();
}

function holdToCompare(btn, kind) {
  const on = () => {
    if (!app.W || app.comparing || app.live) return;
    startCompare(kind);
    btn.setAttribute('aria-pressed', 'true');
  };
  const off = () => {
    if (!app.comparing) return;
    stopCompare();
    btn.setAttribute('aria-pressed', 'false');
  };
  btn.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    btn.setPointerCapture?.(e.pointerId);
    on();
  });
  for (const ev of ['pointerup', 'pointercancel', 'lostpointercapture']) btn.addEventListener(ev, off);
  btn.addEventListener('keydown', (e) => {
    if ((e.key === ' ' || e.key === 'Enter') && !e.repeat) on();
  });
  btn.addEventListener('keyup', off);
  btn.addEventListener('contextmenu', (e) => e.preventDefault());
}

// ---------- makeup helpers ----------

function partInUse(id) {
  const m = app.state.makeup;
  return {
    looks: m.look !== 'none', lips: m.lip !== 'none', shadow: m.shadow !== 'none', liner: m.liner !== 'none',
    lashes: m.lashes !== 'none', brows: m.brow !== 'none', blush: m.blush !== 'none',
    contour: Boolean(m.contour || m.highlight || app.state.contour.style !== 'none' || app.state.contour.jaw), freckles: m.freckles > 0,
    eyes: app.state.eyes.color !== 'none',
  }[id];
}

function savedLooks() {
  try {
    return JSON.parse(localStorage.getItem(LOOKS_KEY)) || [];
  } catch {
    return [];
  }
}

function storeLooks(list) {
  try {
    localStorage.setItem(LOOKS_KEY, JSON.stringify(list));
    return true;
  } catch {
    return false;
  }
}

// Saved looks and favourite filters were kept under the app's earlier name: move them to the
// current keys once. A published copy has its own origin, so keys of that shape can only be ours.
function moveSavedKeys() {
  try {
    for (const key of [LOOKS_KEY, FAVS_KEY]) {
      const end = key.slice(key.indexOf('.'));
      for (const k of Object.keys(localStorage)) {
        if (k === key || !k.endsWith(end) || !/^[a-z]+\.\w+$/.test(k)) continue;
        if (localStorage.getItem(key) === null) localStorage.setItem(key, localStorage.getItem(k));
        localStorage.removeItem(k);
      }
    }
  } catch {
    // Storage is blocked, so there is nothing to move.
  }
}

// The makeup a look puts on (presets are compact tuples; saved looks keep a full copy).
function makeupFromLook(look) {
  const m = structuredClone(DEFAULTS.makeup);
  if (look.makeup) Object.assign(m, structuredClone(look.makeup));
  else {
    if (look.lip) [m.lip, m.lipAmt, m.lipFinish] = look.lip;
    if (look.blush) [m.blush, m.blushAmt] = look.blush;
    if (look.shadow) [m.shadow, m.shadowAmt, m.shimmer] = look.shadow;
    if (look.liner) [m.linerStyle, m.liner, m.linerAmt] = look.liner;
    if (look.lashes) [m.lashes, m.lashAmt] = look.lashes;
    if (look.brow) [m.brow, m.browAmt] = look.brow;
    if (look.contour) [m.contour, m.highlight] = look.contour;
    if (look.freckles) m.freckles = look.freckles;
  }
  m.look = look.id;
  m.lookAmt = 1;
  return m;
}

function applyLook(look) {
  app.state.makeup = makeupFromLook(look);
  ensureMakeupMasks();
  commit();
  syncUI();
  render();
}

// Editing one part ends a look: its Intensity is folded into the part amounts first.
function bakeLook() {
  const m = app.state.makeup;
  if (m.look === 'none') return;
  for (const key of LOOK_SCALED) m[key] = +(m[key] * m.lookAmt).toFixed(3);
  m.look = 'none';
  m.lookAmt = 1;
}

function setMakeup(key, value) {
  const m = app.state.makeup;
  bakeLook();
  m[key] = value;
  if (key === 'linerStyle' && m.liner === 'none') m.liner = 'black';
  ensureMakeupMasks();
  commit();
  syncUI();
  render();
}

function saveCurrentLook() {
  const list = savedLooks();
  if (list.length >= 10) return toast('You can keep 10 looks. Delete one first.');
  bakeLook();
  const look = { id: `my${Date.now()}`, name: `Look ${list.length + 1}`, makeup: structuredClone(app.state.makeup) };
  look.makeup.look = look.id;
  if (!storeLooks([...list, look])) return toast('This browser won’t keep saved looks.');
  app.state.makeup.look = look.id;
  commit();
  syncUI();
  toast('Look saved on this phone');
}

function deleteLook(id) {
  storeLooks(savedLooks().filter((o) => o.id !== id));
  if (app.state.makeup.look === id) app.state.makeup.look = 'none';
  syncUI();
}

// ---------- tool panels: what each tool shows ----------

// Item kinds: tool (main row), icon (mode, toggle or action), param (a value the slider sets,
// with a ring showing it), swatch (colour), thumb (your photo rendered with that option),
// font (a typeface sample).
const itIcon = (key, label, ic, o = {}) => ({ key, kind: 'icon', label, icon: ic, ...o });
const itSwatch = (key, label, o = {}) => ({ key, kind: 'swatch', label, ...o });
const itThumb = (key, label, o = {}) => ({ key, kind: 'thumb', label, ...o });
const divider = (key) => ({ key, kind: 'divider' });

function itParam(group, path, label, ic, min = 0, o = {}) {
  return {
    key: path, kind: 'param', label, icon: ic, min, value: getPath(app.state, path),
    pressed: app.param[group] === path,
    onTap: () => {
      app.param[group] = path;
      syncUI();
    },
    ...o,
  };
}

// A slider bound to part of the edit state ('@size' and '@spot' are brush sizes, not edits).
function sliderOf(path, label, min = 0, after) {
  if (path === '@size') return { label, min: 0, ui: true, preview: 'brush', get: () => app.brushSize, set: (v) => { app.brushSize = v; } };
  if (path === '@spot') return { label, min: 0, ui: true, preview: 'spot', get: () => app.blemishSize, set: (v) => { app.blemishSize = v; } };
  if (path === '@feather') return { label, min: 0, ui: true, get: () => app.stampFeather, set: (v) => { app.stampFeather = v; } };
  return {
    label, min, path,
    get: () => getPath(app.state, path),
    set: (v) => {
      setPath(app.state, path, v);
      after?.(v);
    },
  };
}

// Chips choosing what the slider controls. options: [[path, label, min, after]].
function bound(group, options) {
  const cur = options.find((o) => o[0] === app.param[group]) || options[0];
  app.param[group] = cur[0];
  return {
    chips: options.length > 1
      ? options.map(([path, label]) => ({
        key: path, label, pressed: path === cur[0],
        onTap: () => {
          app.param[group] = path;
          syncUI();
        },
      }))
      : null,
    slider: sliderOf(...cur),
  };
}

function boundParam(group, items, after) {
  const cur = items.find((i) => i.key === app.param[group]) || items.find((i) => i.kind === 'param');
  if (!cur) return null;
  app.param[group] = cur.key;
  for (const it of items) if (it.kind === 'param') it.pressed = it.key === cur.key;
  return sliderOf(cur.key, cur.label, cur.min, after);
}

const tabsOf = (list, key) => list.map(([id, label, dot]) => ({ id, label, dot, selected: app.tab[key] === id, onTap: () => setTab(key, id) }));

function setTab(key, id) {
  app.tab[key] = id;
  if (key === 'background') ensurePerson();
  if (key === 'body' && id !== 'stretch') ensurePose();
  if (key === 'body' && id === 'tone') ensureParts();
  syncUI();
  render();
}

function setMode(tool, mode) {
  app.mode[tool] = mode;
  syncUI();
}

function toggleShow() {
  app.showMask = !app.showMask;
  syncUI();
  render();
}

function toggleFreeze() {
  const s = app.state;
  s.freeze = !s.freeze;
  if (s.freeze) {
    ensurePerson();
    ensureParts();
  }
  commitUI();
  if (s.freeze) toast('The background stays still while you reshape');
}
const freezeItem = () => itIcon('freeze', 'Freeze bg', 'freeze', { pressed: app.state.freeze, onTap: toggleFreeze });

const FACE_NOTE = () => (app.faceStatus === 'loading' ? 'Finding the face…'
  : app.faceStatus === 'error' ? 'Face detection isn’t available in this browser.' : 'No face found in this photo.');
const partsNote = () => (app.partsPending ? 'Finding hair and skin… (16 MB the first time)'
  : app.partsFailed ? 'Hair and skin finding isn’t available here' : null);
const personNote = () => (app.personPending ? 'Finding you in the photo…' : null);

// A brush tab: paint where the tool works (Erase takes the area away again).
function brushSpec(tool, key, strength, hint, strengthLabel = 'Strength') {
  const n = app.state[key].length;
  return {
    items: [
      itIcon('brush', 'Brush', 'brush', { pressed: app.mode[tool] === 'add', onTap: () => setMode(tool, 'add') }),
      itIcon('erase', 'Erase', 'unbrush', { pressed: app.mode[tool] === 'remove', onTap: () => setMode(tool, 'remove') }),
      itIcon('show', 'Show area', 'show', { pressed: app.showMask, onTap: toggleShow }),
      itIcon('clear', 'Clear', 'reset', { disabled: !n, onTap: () => resetKeys([key]) }),
    ],
    ...bound(`${tool}Brush`, [[strength, strengthLabel], ['@size', 'Brush size']]),
    hint: n ? null : hint,
  };
}

function toolInUse(id) {
  const s = app.state;
  switch (id) {
    case 'auto': return s.auto.on;
    case 'smooth': return s.strokes.length > 0 || s.skinFace;
    case 'blemish': return s.heals.some((h) => healKind(h) === 'blemish');
    case 'eraser': return s.heals.some((h) => h.e);
    case 'stamp': return s.heals.some((h) => h.c);
    case 'wrinkles': return anyOf(s.wrinkles, ['forehead', 'crows', 'smile', 'under']) || s.wrinkleStrokes.length > 0;
    case 'conceal': return anyOf(s.conceal, ['dark', 'light', 'bags', 'trough']) || s.concealStrokes.length > 0;
    case 'matte': return s.matte.auto || s.matte.hair > 0 || s.matteStrokes.length > 0;
    case 'texture': return s.textureStrokes.length > 0 || s.texture.onSmooth;
    case 'details': return anyOf(s.details, ['face', 'body', 'bg']) || s.detailStrokes.length > 0;
    case 'eyes': return anyOf(s.eyes, ['bright', 'iris', 'circles', 'redeye', 'size']) || s.eyes.color !== 'none';
    case 'teeth': return anyOf(s.teeth, ['white', 'stains', 'align']);
    case 'skin': return s.skin.tone !== 'none' || s.skin.redness > 0 || s.skin.glow !== 'none';
    case 'plump': return Object.values(s.plump).some(Boolean);
    case 'sculpt': return s.sculpt.faces.some(sculptActive);
    case 'reshape': return s.pushes.length > 0 || s.protectStrokes.length > 0;
    case 'presets': return s.preset.id !== 'none';
    case 'age': return AGE_PARTS.some(([k]) => s.age[k]);
    case 'body': return bodyActive(s.body) || s.stretch.amt > 0;
    case 'makeup': return MAKEUP_PARTS.some(([p]) => p !== 'eyes' && partInUse(p));
    case 'hair': return (s.hairStrokes.length > 0 || s.hair.auto) && (s.hair.color !== 'none' || anyOf(s.hair, [...HAIR_STYLE_KEYS, 'hairline']));
    case 'relight': return s.relight.preset !== 'none';
    case 'background': return anyOf(s.bg, ['blur', 'mono', 'edge', 'soft', 'shadow', 'blend', 'bright']) || s.bg.swap !== 'none' || s.people.length > 0;
    case 'filters': return s.filter.id !== 'none' || anyOf(s.effects, ['glow', 'soft', 'leak', 'prism', 'halation', 'dust']);
    case 'glitter': return Boolean((s.glitter.all || s.glitterStrokes.length) && s.glitter.amt) || s.sparkle.shape !== 'none';
    case 'adjust': return Object.values(s.adjust).some(Boolean);
    case 'crop': return !isIdentity(s.crop);
    case 'text': return s.texts.length > 0;
    default: return false;
  }
}

const faceOff = (t) => t.face && !app.faces.length && app.faceStatus !== 'loading';

// As in AirBrush, the bottom tabs pick a group and the row above shows that group's tools.
// A tab's dot means one of its tools is in use.
function mainSpec() {
  return {
    items: TOOLS.filter((t) => t.group === app.mainGroup).map((t) => ({
      key: `tool-${t.id}`, kind: 'tool', label: t.name, icon: t.id, group: t.group, tool: t.id,
      dot: toolInUse(t.id), dim: faceOff(t), onTap: () => openTool(t.id),
    })),
    tabs: GROUPS.map(([id, label]) => ({
      id, label, selected: app.mainGroup === id, dot: TOOLS.some((t) => t.group === id && toolInUse(t.id)), onTap: () => setGroup(id),
    })),
  };
}

function toolSpec(tool) {
  const s = app.state;
  const noFace = !app.faces.length;
  const dis = { disabled: noFace };
  switch (tool) {
    case 'auto': {
      const spots = s.auto.spots;
      return {
        title: 'Auto',
        items: [itIcon('auto', s.auto.on ? 'Auto on' : 'Auto off', 'auto', {
          pressed: s.auto.on, disabled: noFace, onTap: () => (s.auto.on ? removeAuto() : applyAuto()),
        })],
        slider: s.auto.on ? { label: 'Strength', min: 0, get: () => s.auto.amt, set: setAutoStrength } : null,
        note: noFace ? FACE_NOTE() : null,
        hint: s.auto.on ? `Eyes and teeth brightened, face slimmed a little${spots ? ` · ${spots} spot${spots === 1 ? '' : 's'} healed` : ''}` : null,
      };
    }
    case 'smooth': {
      const painted = s.strokes.length > 0 || s.skinFace;
      return {
        title: 'Smooth',
        items: [
          itIcon('brush', 'Brush', 'brush', { pressed: app.mode.smooth === 'add', onTap: () => setMode('smooth', 'add') }),
          itIcon('erase', 'Erase', 'unbrush', { pressed: app.mode.smooth === 'remove', onTap: () => setMode('smooth', 'remove') }),
          itIcon('face', 'Whole face', 'face', {
            pressed: s.skinFace, disabled: !app.masks,
            onTap: () => {
              s.skinFace = !s.skinFace;
              redrawSkin();
              commitUI();
            },
          }),
          itIcon('stubble', 'Stubble', 'jaw', { pressed: s.stubble, disabled: noFace, onTap: () => { s.stubble = !s.stubble; commitUI(); } }),
          itIcon('show', 'Show area', 'show', { pressed: app.showMask, onTap: toggleShow }),
          itIcon('clear', 'Clear', 'reset', { disabled: !painted, onTap: () => resetKeys(TOOL_KEYS.smooth) }),
        ],
        ...bound('smooth', [['smooth', 'Strength'], ['even', 'Even tone'], ['depth', 'Depth'], ['@size', 'Brush size']]),
        hint: painted ? null : 'Paint over the skin you want smoothed',
      };
    }
    case 'blemish': {
      const healed = s.heals.filter((h) => healKind(h) === 'blemish').length;
      return {
        title: 'Blemish',
        items: [
          itIcon('find', 'Find spots', 'find', { disabled: noFace || s.heals.some((h) => h.auto), onTap: findSpotsNow }),
          itIcon('clear', 'Clear', 'reset', { disabled: !healed, onTap: () => clearHeals('blemish') }),
        ],
        slider: sliderOf('@spot', 'Spot size'),
        hint: 'Tap a spot to heal it · pinch to zoom in',
      };
    }
    case 'eraser': {
      const erased = s.heals.some((h) => h.e);
      return {
        title: 'Eraser',
        items: [
          itIcon('brush', 'Brush', 'eraser', { pressed: true, onTap: () => {} }),
          itIcon('clear', 'Clear', 'reset', { disabled: !erased, onTap: () => clearHeals('eraser') }),
        ],
        slider: sliderOf('@size', 'Brush size'),
        hint: erased ? null : 'Paint over a stray hair, a mark or a small object',
      };
    }
    case 'stamp': {
      const used = s.heals.some((h) => h.c);
      const picking = app.stamp.picking || !app.stamp.src;
      return {
        title: 'Stamp',
        items: [
          itIcon('source', 'Source', 'source', { pressed: picking, onTap: () => { app.stamp.picking = true; syncUI(); render(); toast('Tap the area to copy from'); } }),
          itIcon('clone', 'Clone', 'stamp', { pressed: !picking, disabled: !app.stamp.src, onTap: () => { app.stamp.picking = false; syncUI(); render(); } }),
          itIcon('clear', 'Clear', 'reset', { disabled: !used, onTap: () => clearHeals('stamp') }),
        ],
        ...bound('stamp', [['@size', 'Brush size'], ['@feather', 'Feather']]),
        hint: picking ? 'Tap the area to copy from' : 'Paint where the copy should go',
      };
    }
    case 'wrinkles': {
      const w = s.wrinkles, auto = anyOf(w, ['forehead', 'crows', 'smile', 'under']);
      const tabs = tabsOf([['auto', 'Auto', auto], ['brush', 'Brush', s.wrinkleStrokes.length > 0]], 'wrinkles');
      if (app.tab.wrinkles === 'brush') return { tabs, ...brushSpec('wrinkles', 'wrinkleStrokes', 'wrinkles.brush', 'Paint over lines you want softened') };
      const items = [
        itParam('wrinkles', 'wrinkles.forehead', 'Forehead', 'forehead', 0, dis),
        itParam('wrinkles', 'wrinkles.crows', 'Crow’s feet', 'crows', 0, dis),
        itParam('wrinkles', 'wrinkles.smile', 'Smile lines', 'smileLines', 0, dis),
        itParam('wrinkles', 'wrinkles.under', 'Under eyes', 'underEye', 0, dis),
        itIcon('reset', 'Reset', 'reset', { disabled: !auto, onTap: () => { Object.assign(w, { forehead: 0, crows: 0, smile: 0, under: 0 }); commitUI(); } }),
      ];
      return { tabs, items, slider: noFace ? null : boundParam('wrinkles', items), note: noFace ? 'No face found, so use the Brush tab' : null };
    }
    case 'conceal': {
      const c = s.conceal, auto = anyOf(c, ['dark', 'light', 'bags', 'trough']);
      const tabs = tabsOf([['auto', 'Auto', auto], ['brush', 'Brush', s.concealStrokes.length > 0]], 'conceal');
      if (app.tab.conceal === 'brush') return { tabs, ...brushSpec('conceal', 'concealStrokes', 'conceal.brush', 'Paint over dark or uneven patches') };
      const items = [
        itParam('conceal', 'conceal.dark', 'Dark spots', 'darkSpots', 0, dis),
        itParam('conceal', 'conceal.light', 'Light spots', 'lightSpots', 0, dis),
        itParam('conceal', 'conceal.bags', 'Eye bags', 'eyeBags', 0, dis),
        itParam('conceal', 'conceal.trough', 'Tear troughs', 'trough', 0, dis),
        itIcon('acne', 'Acne', 'blemish', { disabled: noFace || s.heals.some((h) => h.auto), onTap: findSpotsNow }),
        itIcon('reset', 'Reset', 'reset', { disabled: !auto, onTap: () => { Object.assign(c, { dark: 0, light: 0, bags: 0, trough: 0 }); commitUI(); } }),
      ];
      return { tabs, items, slider: noFace ? null : boundParam('conceal', items), note: noFace ? 'No face found, so use the Brush tab' : null };
    }
    case 'matte': {
      const mt = s.matte;
      const tabs = tabsOf([['auto', 'Auto', mt.auto || mt.hair > 0], ['brush', 'Brush', s.matteStrokes.length > 0]], 'matte');
      if (app.tab.matte === 'brush') return { tabs, ...brushSpec('matte', 'matteStrokes', 'matte.amt', 'Paint over shine; Erase keeps an area as it is') };
      const items = [
        itIcon('auto-face', 'Face', 'face', { pressed: mt.auto, disabled: noFace, onTap: () => { mt.auto = !mt.auto; commitUI(); } }),
        itParam('matte', 'matte.amt', 'Strength', 'matte'),
        itParam('matte', 'matte.hair', 'Hair oil', 'hairOil', 0, { onTap: () => { app.param.matte = 'matte.hair'; ensureParts(); syncUI(); } }),
        itIcon('reset', 'Reset', 'reset', { disabled: !(mt.auto || mt.hair), onTap: () => { mt.auto = false; mt.hair = 0; commitUI(); } }),
      ];
      const hairSel = app.param.matte === 'matte.hair';
      return {
        tabs, items, slider: boundParam('matte', items, hairSel ? ensureParts : undefined),
        note: hairSel ? partsNote() : null,
        hint: mt.auto || s.matteStrokes.length ? null : 'Tap Face to take shine down automatically, or paint it in Brush',
      };
    }
    case 'texture': {
      const n = s.textureStrokes.length;
      return {
        title: 'Texture',
        items: [
          itIcon('brush', 'Brush', 'brush', { pressed: app.mode.texture === 'add', onTap: () => setMode('texture', 'add') }),
          itIcon('erase', 'Erase', 'unbrush', { pressed: app.mode.texture === 'remove', onTap: () => setMode('texture', 'remove') }),
          itIcon('on-smooth', 'Smoothed', 'smooth', { pressed: s.texture.onSmooth, onTap: () => { s.texture.onSmooth = !s.texture.onSmooth; commitUI(); } }),
          itIcon('show', 'Show area', 'show', { pressed: app.showMask, onTap: toggleShow }),
          itIcon('clear', 'Clear', 'reset', { disabled: !n && !s.texture.onSmooth, onTap: () => resetKeys(TOOL_KEYS.texture) }),
        ],
        ...bound('texture', [['texture.amt', 'Amount'], ['texture.size', 'Grain size'], ['@size', 'Brush size']]),
        hint: n || s.texture.onSmooth ? null : 'Paint fine skin texture back where it looks too smooth',
      };
    }
    case 'details': {
      const d = s.details, areas = anyOf(d, ['face', 'body', 'bg']);
      const tabs = tabsOf([['areas', 'Areas', areas], ['brush', 'Brush', s.detailStrokes.length > 0]], 'details');
      if (app.tab.details === 'brush') return { tabs, ...brushSpec('details', 'detailStrokes', 'details.brush', 'Paint where you want more detail') };
      const pick = (path) => () => { app.param.details = path; ensurePerson(); syncUI(); };
      const items = [
        itParam('details', 'details.face', 'Face', 'face'),
        itParam('details', 'details.body', 'Body', 'body', 0, { onTap: pick('details.body') }),
        itParam('details', 'details.bg', 'Background', 'background', 0, { onTap: pick('details.bg') }),
        itIcon('reset', 'Reset', 'reset', { disabled: !areas, onTap: () => { Object.assign(d, { face: 0, body: 0, bg: 0 }); commitUI(); } }),
      ];
      return { tabs, items, slider: boundParam('details', items, ensurePerson), note: app.param.details !== 'details.face' ? personNote() : null };
    }
    case 'eyes': {
      const e = s.eyes;
      const enh = anyOf(e, ['bright', 'iris', 'circles', 'redeye', 'size']);
      const tabs = tabsOf([['enhance', 'Enhance', enh], ['colour', 'Colour', e.color !== 'none']], 'eyes');
      if (app.tab.eyes === 'colour') {
        return { tabs, items: swatches(IRIS_COLORS, e.color, (id) => { e.color = id; commitUI(); }, dis), note: noFace ? FACE_NOTE() : null };
      }
      const items = [
        itParam('eyes', 'eyes.bright', 'Whites', 'whites', 0, dis),
        itParam('eyes', 'eyes.iris', 'Iris', 'iris', 0, dis),
        itParam('eyes', 'eyes.circles', 'Dark circles', 'circles', 0, dis),
        itParam('eyes', 'eyes.redeye', 'Red-eye', 'redeye', 0, dis),
        itParam('eyes', 'eyes.size', 'Iris size', 'irisSize', -100, dis),
        itIcon('reset', 'Reset', 'reset', { disabled: !enh, onTap: () => { Object.assign(e, { bright: 0, iris: 0, circles: 0, redeye: 0, size: 0 }); commitUI(); } }),
      ];
      return { tabs, items, slider: noFace ? null : boundParam('eyes', items), note: noFace ? FACE_NOTE() : null };
    }
    case 'teeth': {
      const t = s.teeth, on = anyOf(t, ['white', 'stains', 'align']);
      const tabs = tabsOf([['whiten', 'Whiten', on], ['brush', 'Brush', s.teethStrokes.length > 0]], 'teeth');
      if (app.tab.teeth === 'brush') {
        return { tabs, ...brushSpec('teeth', 'teethStrokes', 'teeth.white', 'Paint teeth the automatic area missed; Erase takes gums or lips out', 'Whiten') };
      }
      const items = [
        itParam('teeth', 'teeth.white', 'Whiten', 'teeth', 0, dis),
        itParam('teeth', 'teeth.stains', 'Stains', 'stains', 0, dis),
        itParam('teeth', 'teeth.align', 'Align', 'align', 0, dis),
        itIcon('reset', 'Reset', 'reset', { disabled: !on, onTap: () => { Object.assign(t, { white: 0, stains: 0, align: 0 }); updateWarp(); commitUI(); } }),
      ];
      return {
        tabs, items, slider: noFace ? null : boundParam('teeth', items, updateWarp),
        note: noFace ? FACE_NOTE() : null, hint: 'Whitens teeth only; gums and lips keep their colour',
      };
    }
    case 'skin':
      return skinSpec(noFace);
    case 'plump': {
      const items = [
        itParam('plump', 'plump.forehead', 'Forehead', 'forehead', 0, dis),
        itParam('plump', 'plump.temples', 'Temples', 'temples', 0, dis),
        itParam('plump', 'plump.cheeks', 'Cheeks', 'cheekFill', 0, dis),
        itParam('plump', 'plump.sockets', 'Eye sockets', 'sockets', 0, dis),
        itParam('plump', 'plump.lips', 'Lips', 'lips', 0, dis),
        itIcon('reset', 'Reset', 'reset', { disabled: !Object.values(s.plump).some(Boolean), onTap: () => resetKeys(['plump']) }),
      ];
      return {
        title: 'Fillers', items, slider: noFace ? null : boundParam('plump', items, updateWarp),
        note: noFace ? FACE_NOTE() : null, hint: 'Hollows are filled with light, the way fillers lift them',
      };
    }
    case 'sculpt':
      return sculptSpec(noFace);
    case 'presets':
      return presetsSpec();
    case 'age':
      return ageSpec(noFace);
    case 'makeup': {
      const spec = makeupSpec(noFace);
      const tuned = Object.values(s.makeup.tune).some((v) => Object.keys(v).length);
      const tune = [
        itIcon('tune', 'Fine-tune', 'tune', {
          pressed: app.tuneOn, disabled: noFace,
          onTap: () => {
            app.tuneOn = !app.tuneOn;
            syncUI();
            render();
          },
        }),
        ...(app.tuneOn ? [itIcon('tune-reset', 'Reset dots', 'reset', {
          disabled: !tuned,
          onTap: () => {
            s.makeup.tune = {};
            commitUI();
          },
        })] : []),
        divider('dt'),
      ];
      return { ...spec, items: [...tune, ...(spec.items || [])], hint: app.tuneOn ? 'Drag a dot to move that part’s makeup' : spec.hint };
    }
    case 'hair':
      return hairSpec();
    case 'reshape':
      return reshapeSpec();
    case 'body':
      return bodySpec();
    case 'relight':
      return relightSpec(noFace);
    case 'background':
      return backgroundSpec();
    case 'filters':
      return filtersSpec();
    case 'glitter':
      return glitterSpec();
    case 'adjust': {
      const groups = [['light', 'Light'], ['colour', 'Colour'], ['detail', 'Detail']];
      const tabs = tabsOf(groups.map(([id, label]) => [id, label, ADJUST_GROUPS[id].some(([k]) => s.adjust[k])]), 'adjust');
      const items = [
        itIcon('auto', 'Auto', 'auto', { onTap: autoAdjust }),
        divider('d1'),
        ...ADJUST_GROUPS[app.tab.adjust].map(([k, label, min]) => itParam('adjust', `adjust.${k}`, label, k, min)),
        itIcon('reset', 'Reset', 'reset', { disabled: !Object.values(s.adjust).some(Boolean), onTap: () => resetKeys(['adjust']) }),
      ];
      return { tabs, items, slider: boundParam('adjust', items) };
    }
    case 'crop':
      return cropSpec();
    case 'text':
      return textSpec();
    default:
      return { title: toolName(tool), items: [] };
  }
}

function commitUI() {
  commit();
  syncUI();
  render();
}

// Colour swatches with "None" first.
function swatches(list, selected, onPick, o = {}) {
  return [
    itSwatch('none', 'None', { blank: 'none', pressed: selected === 'none', onTap: () => onPick('none'), ...o }),
    ...list.map((c) => itSwatch(c.id, c.name, {
      hex: c.hex, ramp: c.dark ? [c.light, c.dark] : undefined, pressed: selected === c.id, onTap: () => onPick(c.id), ...o,
    })),
  ];
}

// ---------- Sculpt: values per face and side ----------

// The faces the Sculpt sliders edit: the picked one, or all of them.
const sculptTargets = () => (app.sculptFace >= 0 && app.sculptFace < app.faces.length ? [app.sculptFace] : app.faces.map((f, i) => i));

// The value the slider shows: Both sides shows their average.
function sculptValue(s, c) {
  const v = s.sculpt.faces[sculptTargets()[0]]?.[c.id] || [0, 0];
  if (!c.sides) return v[0];
  return app.sculptSide === 'left' ? v[0] : app.sculptSide === 'right' ? v[1] : (v[0] + v[1]) / 2;
}

function setSculptValue(c, x) {
  const faces = app.state.sculpt.faces;
  while (faces.length < app.faces.length) faces.push({});
  for (const i of sculptTargets()) {
    const f = faces[i] || (faces[i] = {});
    const v = f[c.id] || [0, 0];
    const next = !c.sides || app.sculptSide === 'both' ? [x, x] : app.sculptSide === 'left' ? [x, v[1]] : [v[0], x];
    if (next[0] || next[1]) f[c.id] = next;
    else delete f[c.id];
  }
  updateWarp();
}

const sculptTabUsed = (tab) => app.state.sculpt.faces.some((f) => f && SCULPT_CONTROLS.some((c) => c.tab === tab && f[c.id] && (f[c.id][0] || f[c.id][1])));

function resetSculptTab(tab) {
  const faces = app.state.sculpt.faces;
  for (const i of sculptTargets()) {
    if (!faces[i]) continue;
    for (const c of SCULPT_CONTROLS) if (c.tab === tab) delete faces[i][c.id];
  }
  updateWarp();
  commitUI();
}

// Left / Right edit one side of the photo; controls along the middle of the face move as one.
function setSide(id, c) {
  if (!c.sides && id !== 'both') return toast(`${c.label} moves as one, so it has no sides`);
  app.sculptSide = id;
  syncUI();
}

function setFacePick(i) {
  app.sculptFace = i;
  syncUI();
  render();
  toast(i < 0 ? 'Changes apply to every face' : `Changes apply to face ${i + 1} only`);
}

function sculptSpec(noFace) {
  const tab = app.tab.sculpt;
  const tabs = tabsOf(SCULPT_TABS.map(([id, label]) => [id, label, sculptTabUsed(id)]), 'sculpt');
  const list = SCULPT_CONTROLS.filter((c) => c.tab === tab);
  const cur = SCULPT_BY_ID[app.param.sculpt]?.tab === tab ? SCULPT_BY_ID[app.param.sculpt] : list[0];
  app.param.sculpt = cur.id;
  const items = list.map((c) => ({
    key: `sc-${c.id}`, kind: 'param', label: c.label, icon: c.icon, min: c.min, value: sculptValue(app.state, c),
    pressed: c === cur, disabled: noFace,
    onTap: () => {
      app.param.sculpt = c.id;
      syncUI();
    },
  }));
  items.push(divider('d1'));
  items.push(freezeItem());
  items.push(itIcon('reset', 'Reset', 'reset', { disabled: !sculptTabUsed(tab), onTap: () => resetSculptTab(tab) }));
  // Side and face pickers sit by the slider, as AirBrush's Both button does.
  const side = cur.sides ? app.sculptSide : 'both';
  const chips = noFace ? null : [
    ...[['both', 'Both sides'], ['left', 'Left'], ['right', 'Right']].map(([id, label]) => ({ key: `side-${id}`, label, pressed: side === id, onTap: () => setSide(id, cur) })),
    ...(app.faces.length > 1
      ? [{ key: 'face-all', label: 'All faces', pressed: app.sculptFace < 0, onTap: () => setFacePick(-1) },
        ...app.faces.map((f, i) => ({ key: `face-${i}`, label: `Face ${i + 1}`, pressed: app.sculptFace === i, onTap: () => setFacePick(i) }))]
      : []),
  ];
  return {
    tabs, items, chips,
    slider: noFace ? null : { label: cur.label, min: cur.min, path: `sc-${cur.id}`, get: () => sculptValue(app.state, cur), set: (v) => setSculptValue(cur, v) },
    note: noFace ? FACE_NOTE() : null,
    hint: 'Pick a feature and slide · Left or Right moves one side only',
  };
}

// ---------- Hair ----------

const hairFound = () => app.state.hairStrokes.length > 0 || app.state.hair.auto;

// Care, Shape and Style work on the hair area; if none has been found yet, Auto finds it.
function needHair() {
  if (hairFound()) return;
  app.state.hair.auto = true;
  ensureParts();
  redrawHair();
  toast('Finding the hair automatically · fix it in Paint');
}

const hairStyleOf = (h) => (HAIR_STYLES.find((st) => HAIR_STYLE_KEYS.every((k) => Math.abs((st.v[k] || 0) - h[k]) < 0.005)) || { id: 'none' }).id;

function applyHairStyle(st) {
  const h = app.state.hair;
  for (const k of HAIR_STYLE_KEYS) h[k] = st ? st.v[k] || 0 : 0;
  needHair();
  updateWarp();
  commitUI();
}

function hairSpec() {
  const s = app.state, h = s.hair;
  const found = hairFound();
  const care = anyOf(h, ['shine', 'smooth', 'texture', 'enrich', 'oil']);
  const style = hairStyleOf(h);
  const tabs = tabsOf([['paint', 'Paint', found], ['colour', 'Colour', h.color !== 'none'], ['care', 'Care', care],
    ['shape', 'Shape', Boolean(h.volume || h.hairline)], ['style', 'Style', style !== 'none' && anyOf(h, HAIR_STYLE_KEYS)]], 'hair');
  const note = h.auto ? partsNote() : null;
  if (app.tab.hair === 'paint') {
    return {
      tabs,
      items: [
        itIcon('auto', 'Auto', 'auto', {
          pressed: h.auto,
          onTap: () => {
            h.auto = !h.auto;
            if (h.auto) ensureParts();
            redrawHair();
            commitUI();
          },
        }),
        itIcon('brush', 'Brush', 'brush', { pressed: app.mode.hair === 'add', onTap: () => setMode('hair', 'add') }),
        itIcon('erase', 'Erase', 'unbrush', { pressed: app.mode.hair === 'remove', onTap: () => setMode('hair', 'remove') }),
        itIcon('show', 'Show area', 'show', { pressed: app.showMask, onTap: toggleShow }),
        itIcon('clear', 'Clear', 'reset', { disabled: !s.hairStrokes.length, onTap: () => resetKeys(['hairStrokes']) }),
      ],
      slider: sliderOf('@size', 'Brush size'),
      note,
      hint: found ? null : 'Tap Auto or paint over the hair, then pick a colour, care or style',
    };
  }
  if (app.tab.hair === 'care') {
    const P = (key, label, ic) => itParam('hairCare', `hair.${key}`, label, ic, 0, {
      onTap: () => {
        app.param.hairCare = `hair.${key}`;
        needHair();
        syncUI();
      },
    });
    const items = [
      P('shine', 'Shine', 'hairShine'), P('smooth', 'Smooth', 'hairSmooth'), P('texture', 'Texture', 'hairTexture'),
      P('enrich', 'Enrich', 'hairEnrich'), P('oil', 'Oil control', 'hairOil'),
      itIcon('reset', 'Reset', 'reset', { disabled: !care, onTap: () => { Object.assign(h, { shine: 0, smooth: 0, texture: 0, enrich: 0, oil: 0 }); commitUI(); } }),
    ];
    const hints = {
      'hair.shine': 'Lifts the light the hair already catches',
      'hair.smooth': 'Calms frizz along the strands',
      'hair.texture': 'Brings out the strands',
      'hair.enrich': 'Thicker look: fills thin spots and the parting, deepens the colour',
      'hair.oil': 'Takes greasy shine down',
    };
    return { tabs, items, slider: boundParam('hairCare', items, needHair), note, hint: hints[app.param.hairCare] };
  }
  if (app.tab.hair === 'shape') {
    const items = [
      itParam('hairShape', 'hair.volume', 'Volume', 'hairVolume', -100, { onTap: () => { app.param.hairShape = 'hair.volume'; needHair(); syncUI(); } }),
      itParam('hairShape', 'hair.hairline', 'Hairline', 'sc-hairline', -100, { disabled: !app.faces.length }),
      freezeItem(),
      itIcon('reset', 'Reset', 'reset', { disabled: !(h.volume || h.hairline), onTap: () => { h.volume = 0; h.hairline = 0; updateWarp(); commitUI(); } }),
    ];
    const vol = app.param.hairShape === 'hair.volume';
    return {
      tabs, items,
      slider: boundParam('hairShape', items, () => {
        if (vol) needHair();
        updateWarp();
      }),
      note: vol ? note : app.faces.length ? null : FACE_NOTE(),
      hint: vol ? 'More or less volume; Freeze bg keeps the background still' : 'Lower or raise the hairline',
    };
  }
  if (app.tab.hair === 'style') {
    const zero = Object.fromEntries(HAIR_STYLE_KEYS.map((k) => [k, 0]));
    const thumbFor = (st) => ({ rect: 'portrait', state: () => ({ ...app.state, hair: { ...app.state.hair, ...zero, ...(st ? st.v : {}) } }) });
    const items = [
      itThumb('hs-none', 'Natural', { pressed: style === 'none' || !anyOf(h, HAIR_STYLE_KEYS), thumb: thumbFor(null), onTap: () => applyHairStyle(null) }),
      ...HAIR_STYLES.map((st) => itThumb(`hs-${st.id}`, st.name, { pressed: style === st.id, thumb: thumbFor(st), onTap: () => applyHairStyle(st) })),
    ];
    return { tabs, items, note, hint: found ? 'Each style mixes Care and Volume; fine-tune them after' : 'Pick a style; the hair is found automatically' };
  }
  return {
    tabs,
    items: swatches(HAIR_COLORS, h.color, (id) => {
      h.color = id;
      commitUI();
      if (id !== 'none' && !found) toast('Find the hair in the Paint tab: Auto or brush');
    }),
    ...(h.color !== 'none' ? bound('hair', [['hair.amt', 'Amount'], ['hair.depth', 'Depth']]) : {}),
    hint: found ? null : 'Find the hair first in the Paint tab',
  };
}

function skinSpec(noFace) {
  const k = app.state.skin;
  const tabs = tabsOf([['tone', 'Tone', k.tone !== 'none'], ['redness', 'Redness', k.redness > 0], ['glow', 'Glow', k.glow !== 'none']], 'skin');
  const note = partsNote() || (noFace && !app.segOn ? FACE_NOTE() : null);
  if (app.tab.skin === 'redness') {
    return {
      tabs, items: [itParam('skin', 'skin.redness', 'Redness', 'redness', 0, { pressed: true, disabled: noFace })],
      slider: noFace ? null : sliderOf('skin.redness', 'Redness'), note, hint: 'Calms red patches: nose, cheeks, chin and jaw',
    };
  }
  if (app.tab.skin === 'glow') {
    const thumbFor = (id) => ({ rect: 'face', state: () => ({ ...app.state, skin: { ...app.state.skin, glow: id, glowAmt: Math.max(0.6, app.state.skin.glowAmt) } }) });
    const items = [
      itThumb('glow-none', 'None', { pressed: k.glow === 'none', thumb: thumbFor('none'), onTap: () => { k.glow = 'none'; commitUI(); } }),
      ...GLOW_TYPES.map((g) => itThumb(`glow-${g.id}`, g.name, {
        pressed: k.glow === g.id, thumb: thumbFor(g.id),
        onTap: () => {
          k.glow = g.id;
          ensureParts();
          commitUI();
        },
      })),
    ];
    return { tabs, items, slider: k.glow !== 'none' ? sliderOf('skin.glowAmt', 'Amount') : null, note };
  }
  const pickTone = (id) => {
    k.tone = id;
    if (id !== 'none') ensureParts();
    commitUI();
  };
  const items = [
    ...swatches(SKIN_TONES, k.tone, pickTone),
    itSwatch('custom', 'Pick', { hex: k.custom, pressed: k.tone === 'custom', fileFor: 'tone-color' }),
  ];
  return { tabs, items, slider: k.tone !== 'none' ? sliderOf('skin.amt', 'Amount') : null, note };
}

// Reshape, as in AirBrush: Push (Light or Heavy), Resize (enlarge or shrink under the brush), Restore
// (back toward the original) and Protect (painted areas never move; Invert lets only them move).
function reshapeSpec() {
  const s = app.state, tab = app.tab.reshape;
  const kindOf = (q) => (q.k === 'grow' || q.k === 'shrink' ? 'resize' : q.k || 'push');
  const has = (k) => s.pushes.some((q) => kindOf(q) === k);
  const tabs = tabsOf([
    ['push', 'Push', has('push')], ['resize', 'Resize', has('resize')], ['restore', 'Restore', has('restore')],
    ['protect', 'Protect', s.protectStrokes.length > 0],
  ], 'reshape');
  const clear = itIcon('clear', 'Clear', 'reset', { disabled: !s.pushes.length, onTap: () => resetKeys(['pushes']) });
  const pick = (key, value) => () => {
    app[key] = value;
    syncUI();
  };
  let items, hint;
  if (tab === 'protect') {
    const n = s.protectStrokes.length;
    const invert = () => {
      s.protectInvert = !s.protectInvert;
      protectChanged();
      commitUI();
    };
    items = [
      itIcon('brush', 'Brush', 'brush', { pressed: app.mode.reshape === 'add', onTap: () => setMode('reshape', 'add') }),
      itIcon('erase', 'Erase', 'unbrush', { pressed: app.mode.reshape === 'remove', onTap: () => setMode('reshape', 'remove') }),
      itIcon('invert', 'Invert', 'invert', { pressed: s.protectInvert, disabled: !n, onTap: invert }),
      itIcon('show', 'Show area', 'show', { pressed: app.showMask, onTap: toggleShow }),
      itIcon('clearProtect', 'Clear', 'reset', { disabled: !n, onTap: () => resetKeys(['protectStrokes', 'protectInvert']) }),
    ];
    hint = !n ? 'Paint over anything that must not move' : s.protectInvert ? 'Only the painted areas can move' : null;
  } else if (tab === 'resize') {
    items = [
      itIcon('grow', 'Enlarge', 'grow', { pressed: app.resizeDir === 'grow', onTap: pick('resizeDir', 'grow') }),
      itIcon('shrink', 'Shrink', 'shrink', { pressed: app.resizeDir === 'shrink', onTap: pick('resizeDir', 'shrink') }),
      divider('d1'), freezeItem(), clear,
    ];
    hint = has('resize') ? null : `Tap or brush to ${app.resizeDir === 'grow' ? 'enlarge' : 'shrink'} what is under the circle`;
  } else if (tab === 'restore') {
    items = [itIcon('restore', 'Restore', 'restore', { pressed: true, onTap: () => {} }), divider('d1'), freezeItem(), clear];
    hint = has('restore') ? null : 'Brush to put back the original shape';
  } else {
    items = [
      itIcon('light', 'Light', 'light', { pressed: app.pushStrength === 'light', onTap: pick('pushStrength', 'light') }),
      itIcon('heavy', 'Heavy', 'heavy', { pressed: app.pushStrength === 'heavy', onTap: pick('pushStrength', 'heavy') }),
      divider('d1'), freezeItem(), clear,
    ];
    hint = s.pushes.length ? null : 'Drag to nudge a jaw, waist, arm or hair';
  }
  return { title: 'Reshape', tabs, items, slider: sliderOf('@size', 'Brush size'), hint };
}

// Body › Shape presets, as AirBrush's Slender, Hourglass, Muscular and Hot: a set of slider values.
const BODY_PRESETS = [
  ['slender', 'Slender', 'legs', { slim: 0.5, legs: 0.2, arms: 0.2 }],
  ['hourglass', 'Hourglass', 'waist', { waist: 0.6, hips: 0.35 }],
  ['muscular', 'Muscular', 'muscle', { shoulders: 0.45, square: 0.3, arms: -0.25, waist: 0.2, muscle: 0.5 }],
  ['curvy', 'Curvy', 'hips', { waist: 0.45, hips: 0.5, legs: 0.25, tummy: 0.3 }],
];

function bodySpec() {
  const s = app.state, b = s.body;
  const shaped = bodyActive({ ...b, muscle: 0 });
  const tabs = tabsOf([['shape', 'Shape', shaped], ['stretch', 'Stretch', s.stretch.amt > 0], ['tone', 'Tone', b.muscle > 0]], 'body');
  if (app.tab.body === 'stretch') {
    return {
      tabs,
      items: [
        itIcon('auto-legs', 'Legs', 'auto', { onTap: autoBand }),
        itIcon('reset', 'Reset', 'reset', { disabled: !s.stretch.amt, onTap: () => resetKeys(['stretch']) }),
      ],
      slider: sliderOf('stretch.amt', 'Stretch'),
      hint: 'Drag the two lines to choose what stretches, or tap Legs',
    };
  }
  if (app.tab.body === 'tone') {
    const items = [itParam('body', 'body.muscle', 'Definition', 'muscle', 0, { pressed: true })];
    return { tabs, items, slider: sliderOf('body.muscle', 'Definition', 0, ensureParts), note: partsNote(), hint: 'Defines arms, shoulders and stomach' };
  }
  const note = app.posePending ? 'Finding the body… (6 MB the first time)'
    : app.poseFailed ? 'No body found here; Push in Reshape still works' : null;
  const P = (key, label, ic) => itParam('body', `body.${key}`, label, ic, -100, { disabled: !app.pose });
  const preset = ([id, label, ic, v]) => itIcon(`preset-${id}`, label, ic, {
    disabled: !app.pose,
    pressed: Object.keys(DEFAULTS.body).every((k) => k === 'muscle' || (b[k] || 0) === (v[k] || 0)),
    onTap: () => {
      s.body = { ...structuredClone(DEFAULTS.body), muscle: b.muscle, ...v };
      if (v.muscle) ensureParts();
      updateWarp();
      commitUI();
    },
  });
  const items = [
    ...BODY_PRESETS.map(preset), divider('d0'),
    P('slim', 'Slim', 'body'), P('waist', 'Waist', 'waist'), P('hips', 'Hips', 'hips'), P('legs', 'Legs', 'legs'), P('legRatio', 'Leg ratio', 'stretch'), P('arms', 'Arms', 'arms'),
    P('shoulders', 'Shoulders', 'shoulders'), P('square', 'Square', 'shoulders'), P('tummy', 'Belly slim', 'waist'), P('bellySmooth', 'Belly smooth', 'waist'), P('neck', 'Neck', 'neck'),
    P('head', 'Head', 'head'), P('posture', 'Posture', 'posture'), P('tilt', 'Head tilt', 'tilt'), divider('d1'), freezeItem(),
    itIcon('reset', 'Reset', 'reset', {
      disabled: !shaped,
      onTap: () => {
        s.body = { ...structuredClone(DEFAULTS.body), muscle: b.muscle };
        updateWarp();
        commitUI();
      },
    }),
  ];
  return { tabs, items, slider: app.pose ? boundParam('body', items, updateWarp) : null, note };
}

function makeupSpec(noFace) {
  const s = app.state, m = s.makeup, part = app.tab.makeup;
  const tabs = tabsOf(MAKEUP_PARTS.map(([id, label]) => [id, label, partInUse(id)]), 'makeup');
  const dis = { disabled: noFace };
  // A part's amount slider shows the amount as it looks now, including a look's Intensity.
  const partSlider = (key, label = 'Amount') => ({
    label, min: 0, path: `makeup.${key}`,
    get: () => m[key] * (m.look !== 'none' ? m.lookAmt : 1),
    set: (v) => {
      bakeLook();
      app.state.makeup[key] = v;
    },
  });
  const base = { tabs, note: noFace ? FACE_NOTE() : null };
  switch (part) {
    case 'looks': {
      const groups = [...LOOK_GROUPS.map((g) => [g.id, g.name]), ['mine', 'My looks']];
      const chips = groups.map(([id, label]) => ({
        key: id, label, pressed: app.lookGroup === id,
        onTap: () => {
          app.lookGroup = id;
          syncUI();
        },
      }));
      const thumbFor = (look) => ({ rect: 'face', state: () => ({ ...app.state, makeup: makeupFromLook(look) }) });
      const items = [itThumb('look-none', 'None', {
        pressed: m.look === 'none' && !MAKEUP_PARTS.some(([id]) => id !== 'looks' && id !== 'eyes' && partInUse(id)),
        thumb: { rect: 'face', state: () => ({ ...app.state, makeup: structuredClone(DEFAULTS.makeup) }) },
        onTap: () => applyLook({ id: 'none' }), ...dis,
      })];
      if (app.lookGroup === 'mine') {
        const mine = savedLooks();
        for (const L of mine) items.push(itThumb(L.id, L.name, { pressed: m.look === L.id, thumb: thumbFor(L), onTap: () => applyLook(L), ...dis }));
        items.push(itIcon('save-look', 'Save look', 'bookmark', { onTap: saveCurrentLook, ...dis }));
        if (mine.some((L) => L.id === m.look)) items.push(itIcon('delete-look', 'Delete', 'trash', { onTap: () => deleteLook(m.look) }));
        if (!mine.length) base.hint = 'Build makeup part by part, then save it here';
      } else {
        for (const L of LOOK_GROUPS.find((g) => g.id === app.lookGroup).looks) {
          items.push(itThumb(L.id, L.name, { pressed: m.look === L.id, thumb: thumbFor(L), onTap: () => applyLook(L), ...dis }));
        }
      }
      return { ...base, items, chips, slider: m.look !== 'none' ? sliderOf('makeup.lookAmt', 'Intensity') : null };
    }
    case 'lips':
      return {
        ...base,
        items: swatches(LIP_COLORS, m.lip, (id) => setMakeup('lip', id), dis),
        chips: m.lip !== 'none' ? LIP_FINISHES.map((f) => ({ key: f.id, label: f.name, pressed: m.lipFinish === f.id, onTap: () => setMakeup('lipFinish', f.id) })) : null,
        slider: m.lip !== 'none' ? partSlider('lipAmt') : null,
      };
    case 'shadow':
      return {
        ...base,
        items: swatches(SHADOW_COLORS, m.shadow, (id) => setMakeup('shadow', id), dis),
        ...(m.shadow !== 'none'
          ? (() => {
            const b = bound('shadow', [['makeup.shadowAmt', 'Amount'], ['makeup.shimmer', 'Shimmer']]);
            return { chips: b.chips, slider: app.param.shadow === 'makeup.shadowAmt' ? partSlider('shadowAmt') : sliderOf('makeup.shimmer', 'Shimmer', 0, bakeLook) };
          })()
          : {}),
      };
    case 'liner':
      return {
        ...base,
        items: swatches(LINER_COLORS, m.liner, (id) => setMakeup('liner', id), dis),
        chips: LINER_STYLES.map((st) => ({ key: st.id, label: st.name, pressed: m.linerStyle === st.id, onTap: () => setMakeup('linerStyle', st.id) })),
        slider: m.liner !== 'none' ? partSlider('linerAmt') : null,
      };
    case 'lashes':
      return {
        ...base,
        items: [
          itSwatch('none', 'None', { blank: 'none', pressed: m.lashes === 'none', onTap: () => setMakeup('lashes', 'none'), ...dis }),
          ...LASH_STYLES.map((st) => itIcon(st.id, st.name, 'lashes', { pressed: m.lashes === st.id, onTap: () => setMakeup('lashes', st.id), ...dis })),
        ],
        slider: m.lashes !== 'none' ? partSlider('lashAmt') : null,
      };
    case 'brows':
      return { ...base, items: swatches(BROW_COLORS, m.brow, (id) => setMakeup('brow', id), dis), slider: m.brow !== 'none' ? partSlider('browAmt') : null };
    case 'blush':
      return { ...base, items: swatches(BLUSH_COLORS, m.blush, (id) => setMakeup('blush', id), dis), slider: m.blush !== 'none' ? partSlider('blushAmt') : null };
    case 'contour': {
      // The shading styles (Natural, Soft, Defined, Chiselled, Glow) and the plain amounts.
      const ct = s.contour;
      const thumbFor = (style) => ({ rect: 'face', state: () => ({ ...app.state, contour: { ...app.state.contour, style, amt: Math.max(0.6, app.state.contour.amt) } }) });
      const pickStyle = (id) => () => {
        ct.style = id;
        if (id !== 'none') app.param.contour = 'contour.amt';
        commitUI();
      };
      const styles = [
        itThumb('ct-none', 'Off', { pressed: ct.style === 'none', thumb: thumbFor('none'), onTap: pickStyle('none'), ...dis }),
        ...SCULPT_STYLES.map((st) => itThumb(`ct-${st.id}`, st.name, { pressed: ct.style === st.id, thumb: thumbFor(st.id), onTap: pickStyle(st.id), ...dis })),
      ];
      const params = [
        ...(ct.style !== 'none' ? [itParam('contour', 'contour.amt', 'Intensity', 'strength', 0, dis)] : []),
        itParam('contour', 'contour.jaw', 'Jawline', 'jaw', 0, dis),
        itParam('contour', 'makeup.contour', 'Contour', 'contour', 0, dis),
        itParam('contour', 'makeup.highlight', 'Highlight', 'highlight', 0, dis),
      ];
      const cur = params.find((i) => i.key === app.param.contour) || params[0];
      app.param.contour = cur.key;
      for (const it of params) {
        it.pressed = it === cur;
        if (it.key.startsWith('makeup.')) it.value = getPath(app.state, it.key) * (m.look !== 'none' ? m.lookAmt : 1);
      }
      const slider = noFace ? null : cur.key.startsWith('makeup.') ? partSlider(cur.key.split('.')[1], cur.label) : sliderOf(cur.key, cur.label);
      return { ...base, items: [...styles, divider('d1'), ...params], slider };
    }
    case 'freckles': {
      const items = [itParam('freckles', 'makeup.freckles', 'Freckles', 'freckles', 0, { ...dis, pressed: true })];
      return { ...base, items, slider: noFace ? null : partSlider('freckles', 'Freckles') };
    }
    case 'eyes':
      return { ...base, items: swatches(IRIS_COLORS, s.eyes.color, (id) => { s.eyes.color = id; commitUI(); }, dis) };
    default:
      return { ...base, items: [] };
  }
}

function relightSpec(noFace) {
  const s = app.state, r = s.relight;
  const tabs = tabsOf([['studio', 'Studio', RELIGHT_PRESETS.some((p) => p.group === 'studio' && p.id === r.preset && p.id !== 'none')],
    ['scene', 'Scene', RELIGHT_PRESETS.some((p) => p.group === 'scene' && p.id === r.preset)]], 'relight');
  const items = RELIGHT_PRESETS.filter((p) => p.group === app.tab.relight || p.id === 'none').map((p) => itThumb(`rl-${p.id}`, p.name, {
    pressed: r.preset === p.id, disabled: noFace,
    thumb: { rect: 'portrait', state: () => ({ ...app.state, relight: { ...app.state.relight, preset: p.id } }) },
    onTap: () => {
      r.preset = p.id;
      if (p.id !== 'none') ensurePerson();
      commitUI();
    },
  }));
  let extra = {};
  if (r.preset === 'deglare') extra = { slider: sliderOf('relight.bright', 'Strength', -100) };
  else if (r.preset !== 'none') extra = bound('relight', [['relight.bright', 'Brightness', -100], ['relight.hue', 'Hue', -100], ['relight.soft', 'Softness', 0]]);
  return {
    tabs, items, ...extra,
    note: noFace ? FACE_NOTE() : null,
    hint: r.preset === 'custom' ? 'Drag on the photo to move the light' : null,
  };
}

function backgroundSpec() {
  const s = app.state, b = s.bg;
  const adjusted = anyOf(b, ['edge', 'soft', 'shadow', 'blend', 'bright']);
  const tabs = tabsOf([['blur', 'Blur', Boolean(b.blur || b.mono)], ['swap', 'Swap', b.swap !== 'none'], ['adjust', 'Adjust', adjusted],
    ['fix', 'Fix edges', s.bgStrokes.length > 0], ['people', 'People', s.people.length > 0]], 'background');
  const note = app.personPending
    ? 'Finding you in the photo…'
    : app.segFailed && !app.personReady
      ? 'Couldn’t find you automatically. Paint the background in Fix edges.'
      : app.partsPending ? 'Refining the edges… (16 MB the first time)' : null;
  const touch = () => {
    ensurePerson();
    commitUI();
  };
  if (app.tab.background === 'swap') {
    const items = BG_SWAPS.filter((sw) => sw.id !== 'photo').map((sw) => itSwatch(sw.id, sw.name, {
      square: true, hex: sw.hex, hex2: sw.hex2, blank: sw.id === 'none' ? 'none' : undefined, pressed: b.swap === sw.id,
      onTap: () => {
        b.swap = sw.id;
        touch();
      },
    }));
    if (app.bgImageReady) {
      items.push(itSwatch('photo', 'Your photo', { square: true, blank: 'photo', pressed: b.swap === 'photo', onTap: () => { b.swap = 'photo'; touch(); } }));
      items.push(itSwatch('photo-new', 'Change', { square: true, blank: 'plus', fileFor: 'bg-file' }));
    } else {
      items.push(itSwatch('photo-new', 'Photo…', { square: true, blank: 'photo', fileFor: 'bg-file' }));
    }
    return { tabs, items, note };
  }
  if (app.tab.background === 'fix') {
    return {
      tabs,
      items: [
        itIcon('bg', 'Blur brush', 'blurBrush', { pressed: app.mode.background === 'remove', onTap: () => setMode('background', 'remove') }),
        itIcon('keep', 'Keep brush', 'keep', { pressed: app.mode.background === 'add', onTap: () => setMode('background', 'add') }),
        itIcon('tap', 'Tap object', 'tap', {
          pressed: app.bgTap,
          onTap: () => {
            app.bgTap = !app.bgTap;
            if (app.bgTap) app.mode.background = 'add';
            syncUI();
          },
        }),
        itIcon('clear', 'Clear', 'reset', { disabled: !s.bgStrokes.length, onTap: () => resetKeys(['bgStrokes']) }),
      ],
      slider: app.bgTap ? null : sliderOf('@size', 'Brush size'),
      note,
      hint: !app.bgTap ? 'The tinted area is background. Paint to fix any gaps'
        : app.mode.background === 'add' ? 'Tap something to keep it sharp' : 'Tap something to blur it with the background',
    };
  }
  if (app.tab.background === 'adjust') {
    const items = [
      itParam('bgAdjust', 'bg.edge', 'Edge', 'edge', -100),
      itParam('bgAdjust', 'bg.soft', 'Soften', 'soften'),
      itParam('bgAdjust', 'bg.shadow', 'Shadow', 'dropShadow'),
      itParam('bgAdjust', 'bg.blend', 'Blend', 'blend'),
      itParam('bgAdjust', 'bg.bright', 'Brightness', 'brightness', -100),
      itIcon('reset', 'Reset', 'reset', { disabled: !adjusted, onTap: () => { Object.assign(b, { edge: 0, soft: 0, shadow: 0, blend: 0, bright: 0 }); commitUI(); } }),
    ];
    const slider = boundParam('bgAdjust', items, ensurePerson);
    const chips = app.param.bgAdjust === 'bg.shadow'
      ? [['left', 'Left'], ['down', 'Below'], ['right', 'Right']].map(([id, label]) => ({ key: id, label, pressed: b.shadowDir === id, onTap: () => { b.shadowDir = id; commitUI(); } }))
      : null;
    return { tabs, items, slider, chips, note, hint: b.swap === 'none' && !b.blur ? 'Edge, Shadow and Blend show best on a new background' : null };
  }
  if (app.tab.background === 'people') {
    const sel = s.people.find((p) => p.id === app.sel.person) || null;
    const items = [
      itIcon('add-person', 'Add', 'addPerson', { fileFor: 'person-file' }),
      ...s.people.map((p, i) => itIcon(p.id, `Person ${i + 1}`, 'person', { pressed: p.id === app.sel.person, onTap: () => { app.sel.person = p.id; syncUI(); render(); } })),
    ];
    if (sel) {
      items.push(divider('d1'));
      items.push(itIcon('flip', 'Flip', 'flip', { onTap: () => { sel.flip = !sel.flip; commitUI(); } }));
      items.push(itIcon('delete', 'Remove', 'trash', {
        onTap: () => {
          s.people = s.people.filter((p) => p !== sel);
          app.sel.person = null;
          syncPeople();
          commitUI();
        },
      }));
    }
    const slider = sel ? { label: 'Size', min: 0, get: () => (sel.h - 0.1) / 1.1, set: (v) => { sel.h = +(0.1 + v * 1.1).toFixed(4); } } : null;
    return { tabs, items, slider, note, hint: s.people.length ? 'Drag a person to move them' : 'Add someone from another photo (up to 5)' };
  }
  const items = [
    itParam('bg', 'bg.blur', 'Blur', 'blur'),
    divider('d1'),
    itIcon('shape-0', 'No bokeh', 'none', { pressed: !b.bokeh, onTap: () => { b.bokeh = 0; touch(); } }),
    ...BOKEH_SHAPES.map((sh) => itIcon(`shape-${sh.id}`, sh.name, sh.icon, {
      pressed: b.bokeh === sh.id,
      onTap: () => {
        b.bokeh = sh.id;
        if (!b.blur) b.blur = 0.5;
        touch();
      },
    })),
    divider('d2'),
    itIcon('mono', 'Mono', 'mono', {
      pressed: Boolean(b.mono),
      onTap: () => {
        b.mono = b.mono ? 0 : 1;
        touch();
      },
    }),
  ];
  items[0].pressed = true;
  const slide = b.bokeh ? bound('bgBlur', [['bg.blur', 'Blur', 0, ensurePerson], ['bg.hi', 'Highlights']]) : { slider: sliderOf('bg.blur', 'Blur', 0, ensurePerson) };
  return { tabs, items, ...slide, note };
}

function filterFavs() {
  try {
    return JSON.parse(localStorage.getItem(FAVS_KEY)) || [];
  } catch {
    return [];
  }
}

function toggleFav(id) {
  const list = filterFavs(), saved = list.includes(id);
  try {
    localStorage.setItem(FAVS_KEY, JSON.stringify(saved ? list.filter((x) => x !== id) : [...list, id]));
  } catch {
    return toast('This browser won’t keep saved filters.');
  }
  syncUI();
  toast(saved ? 'Removed from Saved' : `${filterOf(id).name} saved · find it under Saved`);
}

function filtersSpec() {
  const s = app.state, fx = s.effects;
  const fxOn = anyOf(fx, ['glow', 'soft', 'leak', 'prism', 'halation', 'dust']);
  const tabs = tabsOf([['filters', 'Filters', s.filter.id !== 'none'], ['effects', 'Effects', fxOn]], 'filters');
  if (app.tab.filters === 'effects') {
    const items = [
      itParam('effects', 'effects.glow', 'Glow', 'glow'),
      itParam('effects', 'effects.soft', 'Soft focus', 'softFocus'),
      itParam('effects', 'effects.leak', 'Light leak', 'leak'),
      itParam('effects', 'effects.halation', 'Halation', 'halation'),
      itParam('effects', 'effects.dust', 'Dust', 'dust'),
      itParam('effects', 'effects.prism', 'Prism', 'prism'),
      itIcon('reset', 'Reset', 'reset', { disabled: !fxOn, onTap: () => resetKeys(['effects']) }),
    ];
    const slider = boundParam('effects', items);
    const hints = { 'effects.prism': fx.prism > 0 ? 'Drag on the photo to move the sharp spot' : null, 'effects.halation': 'The red glow film gives bright lights' };
    return { tabs, items, slider, hint: hints[app.param.effects] || null };
  }
  const favs = filterFavs(), cur = s.filter.id;
  const list = FILTERS.filter((f) => f.id === 'none' || app.filterCat === 'all' || (app.filterCat === 'saved' ? favs.includes(f.id) : f.cat === app.filterCat));
  const items = [
    itIcon('protect', 'Protect skin', 'protectSkin', {
      pressed: s.filter.protect, disabled: cur !== 'none' && !protects(filterOf(cur)),
      onTap: () => {
        s.filter.protect = !s.filter.protect;
        if (s.filter.protect) ensurePerson();
        commitUI();
        toast(s.filter.protect ? 'Skin keeps its own colour under filters' : 'Filters now change skin too');
      },
    }),
    ...(cur !== 'none' ? [itIcon('fav', favs.includes(cur) ? 'Saved' : 'Save', favs.includes(cur) ? 'heartOn' : 'heart', { pressed: favs.includes(cur), onTap: () => toggleFav(cur) })] : []),
    divider('d0'),
    ...list.map((f) => itThumb(`f-${f.id}`, f.name, {
      square: true, pressed: cur === f.id,
      thumb: { rect: 'photo', state: () => ({ ...app.state, filter: { ...app.state.filter, id: f.id, amt: Math.max(0.6, app.state.filter.amt) } }) },
      onTap: () => {
        s.filter.id = f.id;
        if (s.filter.protect && f.id !== 'none') ensurePerson();
        commitUI();
      },
    })),
  ];
  return {
    tabs,
    chips: FILTER_CATS.map(([id, label]) => ({ key: `cat-${id}`, label, pressed: app.filterCat === id, onTap: () => { app.filterCat = id; syncUI(); } })),
    items,
    slider: cur !== 'none' ? sliderOf('filter.amt', 'Strength') : null,
    hint: app.filterCat === 'saved' && !favs.length ? 'Pick a filter and tap Save to keep it here' : null,
  };
}

// Glitter: brushed on (or over the whole photo) in a colour, and Sparkle's star glints.
function glitterSpec() {
  const s = app.state, g = s.glitter, sp = s.sparkle;
  const painted = s.glitterStrokes.length > 0;
  const tabs = tabsOf([['glitter', 'Glitter', painted || g.all], ['sparkle', 'Sparkle', sp.shape !== 'none']], 'glitter');
  const swatch = (prefix, c, cur, pick) => itSwatch(`${prefix}-${c.id}`, c.name, {
    hex: c.id === 'rainbow' ? '#ff9ad5' : c.hex, hex2: c.id === 'rainbow' ? '#8fd3ff' : undefined, pressed: cur === c.id, onTap: () => pick(c.id),
  });
  if (app.tab.glitter === 'sparkle') {
    const pickShape = (id) => () => {
      sp.shape = id;
      commitUI();
      if (id !== 'none' && !app.sparkCache?.pts.length) setTimeout(() => { if (!app.sparkCache?.pts.length) toast('No bright highlights found for stars in this photo'); }, 300);
    };
    const items = [
      itIcon('sp-none', 'None', 'none', { pressed: sp.shape === 'none', onTap: pickShape('none') }),
      ...SPARKLE_SHAPES.map((x) => itIcon(`sp-${x.id}`, x.name, x.icon, { pressed: sp.shape === x.id, onTap: pickShape(x.id) })),
      divider('d1'),
      ...SPARKLE_COLORS.map((c) => swatch('spc', c, sp.color, (id) => { sp.color = id; commitUI(); })),
    ];
    return {
      tabs, items,
      ...(sp.shape !== 'none' ? bound('sparkle', [['sparkle.size', 'Size'], ['sparkle.amount', 'Quantity'], ['sparkle.angle', 'Angle', -100]]) : {}),
      hint: 'Stars land on the photo’s own highlights',
    };
  }
  const items = [
    itIcon('brush', 'Brush', 'brush', { pressed: app.mode.glitter === 'add', onTap: () => setMode('glitter', 'add') }),
    itIcon('erase', 'Erase', 'unbrush', { pressed: app.mode.glitter === 'remove', onTap: () => setMode('glitter', 'remove') }),
    itIcon('all', 'All over', 'photo', { pressed: g.all, onTap: () => { g.all = !g.all; commitUI(); } }),
    itIcon('show', 'Show area', 'show', { pressed: app.showMask, onTap: toggleShow }),
    itIcon('clear', 'Clear', 'reset', { disabled: !painted, onTap: () => resetKeys(['glitterStrokes']) }),
    divider('d1'),
    ...GLITTER_COLORS.map((c) => swatch('gc', c, g.color, (id) => { g.color = id; commitUI(); })),
  ];
  return {
    tabs, items,
    ...bound('glitter', [['glitter.amt', 'Intensity'], ['glitter.size', 'Flake size'], ['@size', 'Brush size']]),
    hint: painted || g.all ? null : 'Brush across an area to add glitter · tap a colour to change it',
  };
}

// The crop rectangle for an aspect ratio, inside the (rotated, stretched) frame.
function fitAspect(c) {
  const g = geometry(c, app.W, app.H, { full: true, stretch: app.state.stretch });
  return aspectRect(c.aspect, g.out[0], g.out[1], app.W, app.H);
}

function cropSpec() {
  const c = app.state.crop;
  const cropped = c.rect.some((v, i) => v !== NO_CROP.rect[i]);
  const tabs = tabsOf([['crop', 'Crop', cropped], ['rotate', 'Rotate', Boolean(c.rot || c.flipH || c.flipV || c.angle)],
    ['lens', 'Perspective', Boolean(c.persV || c.persH || c.lens)]], 'crop');
  const reset = itIcon('reset', 'Reset', 'reset', { disabled: isIdentity(c), onTap: () => resetKeys(['crop']) });
  if (app.tab.crop === 'rotate') {
    const items = [
      itIcon('rot', 'Rotate', 'rotate', { onTap: () => { c.rot = (c.rot + 1) % 4; c.rect = fitAspect(c); commitUI(); } }),
      itIcon('flip-h', 'Flip', 'flip', { pressed: c.flipH, onTap: () => { c.flipH = !c.flipH; commitUI(); } }),
      itIcon('flip-v', 'Flip vertical', 'flipV', { pressed: c.flipV, onTap: () => { c.flipV = !c.flipV; commitUI(); } }),
      itParam('crop', 'crop.angle', 'Straighten', 'straighten', -100, { pressed: true, value: c.angle / 45 }),
      reset,
    ];
    return { tabs, items, slider: { label: 'Straighten', min: -100, path: 'crop.angle', get: () => c.angle / 45, set: (v) => { c.angle = +(v * 45).toFixed(2); } } };
  }
  if (app.tab.crop === 'lens') {
    const items = [
      itParam('lens', 'crop.persV', 'Vertical', 'persV', -100),
      itParam('lens', 'crop.persH', 'Horizontal', 'persH', -100),
      itParam('lens', 'crop.lens', 'Lens', 'lens', -100),
      reset,
    ];
    return { tabs, items, slider: boundParam('lens', items), hint: 'Straighten buildings and undo wide-angle bulge' };
  }
  const items = [
    ...ASPECTS.map((a) => ({
      key: `ar-${a.id}`, kind: 'icon', label: a.name, pressed: c.aspect === a.id,
      svg: a.id === 'free' ? icon('crop') : a.id === 'original' ? aspectIcon(app.W, app.H) : aspectIcon(...a.id.split(':').map(Number)),
      onTap: () => {
        c.aspect = a.id;
        c.rect = fitAspect(c);
        commitUI();
      },
    })),
    reset,
  ];
  return { tabs, items, hint: 'Drag the corners or edges to crop' };
}

// Makeup › Fine-tune, as AirBrush's "Perfect your makeup by moving the dots": a dot per part and
// side, dragged to move that part's makeup (the masks are read from where it moved them).
const TUNE_PARTS = ['lips', 'browL', 'browR', 'eyeL', 'eyeR', 'cheekL', 'cheekR'];

// Where each part's dot sits on a face before it's moved (photo px). L and R are image-left and
// image-right, as the shader tells them apart.
function tuneAnchors(f) {
  const mean = (ids) => ids.reduce((s, i) => [s[0] + f.P[i][0] / ids.length, s[1] + f.P[i][1] / ids.length], [0, 0]);
  const side = (p) => (p[0] - f.center[0]) * f.xAxis[0] + (p[1] - f.center[1]) * f.xAxis[1];
  const pair = (a, b) => (side(a) < side(b) ? [a, b] : [b, a]);
  const [browL, browR] = pair(mean(IDX.browR), mean(IDX.browL));
  const [eyeL, eyeR] = pair(f.eyeR.c, f.eyeL.c);
  const below = (e, w) => [e[0] + f.yAxis[0] * w * 1.05, e[1] + f.yAxis[1] * w * 1.05];
  return { lips: f.mouth.c, browL, browR, eyeL, eyeR, cheekL: below(eyeL, f.eyeR.w), cheekR: below(eyeR, f.eyeL.w) };
}

function tuneOffset(tune, i, part) {
  const v = tune[i]?.[part], fw = app.faces[i]?.fw || 0;
  return v ? [v[0] * fw, v[1] * fw] : [0, 0];
}

function tuneUniforms(tune) {
  const faces = app.faces.slice(0, 4);
  const used = faces.some((f, i) => tune[i] && Object.keys(tune[i]).length);
  const pack = (fn) => new Float32Array(16).map((_, k) => (faces[k >> 2] ? fn(k >> 2)[k & 3] : 0));
  const two = (i, a, b) => [...tuneOffset(tune, i, a), ...tuneOffset(tune, i, b)];
  return {
    uTuneCount: used ? faces.length : 0,
    uFaces: pack((i) => [...faces[i].center, ...faces[i].xAxis]),
    uTuneA: pack((i) => [...tuneOffset(tune, i, 'lips'), 0, 0]),
    uTuneB: pack((i) => two(i, 'browL', 'browR')),
    uTuneC: pack((i) => two(i, 'eyeL', 'eyeR')),
    uTuneD: pack((i) => two(i, 'cheekL', 'cheekR')),
  };
}

// The dot under a touch (stage px), within a finger's reach.
function tuneDotAt(o) {
  let best = null, bd = 30;
  app.faces.slice(0, 4).forEach((f, i) => {
    const an = tuneAnchors(f);
    for (const part of TUNE_PARTS) {
      const d0 = tuneOffset(app.state.makeup.tune, i, part);
      const [sx, sy] = toScreen(an[part][0] + d0[0], an[part][1] + d0[1]);
      const [ox, oy] = outToScreen(o[0], o[1]);
      const d = Math.hypot(sx - ox, sy - oy);
      if (d < bd) {
        bd = d;
        best = { face: i, part };
      }
    }
  });
  return best;
}

function placeTuneDots() {
  const box = $('#tune-dots');
  const show = app.view === 'tool' && app.tool === 'makeup' && app.tuneOn && !app.comparing && app.faces.length > 0;
  box.hidden = !show;
  if (!show) return;
  const dots = [];
  app.faces.slice(0, 4).forEach((f, i) => {
    const an = tuneAnchors(f);
    for (const part of TUNE_PARTS) {
      const d0 = tuneOffset(app.state.makeup.tune, i, part);
      const [x, y] = toScreen(an[part][0] + d0[0], an[part][1] + d0[1]);
      const on = app.live?.kind === 'tune' && app.live.face === i && app.live.part === part;
      dots.push(`<i class="${on ? 'on' : ''}" style="left:${x.toFixed(1)}px;top:${y.toFixed(1)}px"></i>`);
    }
  });
  box.innerHTML = dots.join('');
}

function presetsSpec() {
  const s = app.state, cat = app.tab.presets;
  const tabs = tabsOf(PRESET_CATS.map(([id, label]) => [id, label, presetById(s.preset.id)?.cat === id]), 'presets');
  const preview = (p) => () => {
    const st = structuredClone(app.state);
    clearPreset(st);
    if (p) writePreset(st, p);
    return st;
  };
  const items = [
    itThumb('preset-none', 'None', { pressed: s.preset.id === 'none', thumb: { rect: 'photo', state: preview(null) }, onTap: () => applyPreset('none') }),
    ...PRESETS.filter((p) => p.cat === cat).map((p) => itThumb(`preset-${p.id}`, p.name, {
      pressed: s.preset.id === p.id, thumb: { rect: 'photo', state: preview(p) }, onTap: () => applyPreset(p.id),
    })),
  ];
  const on = s.preset.id !== 'none';
  // The two sliders rewrite what the preset set, so Look and Background stay live.
  const again = () => {
    const p = presetById(s.preset.id);
    if (p) writePreset(s, p);
    updateWarp();
  };
  return {
    tabs, items,
    ...(on ? bound('presets', [['preset.look', 'Look', 0, again], ['preset.bg', 'Background', 0, again]]) : {}),
    hint: on ? null : 'One tap sets a filter, a little retouching and the background',
  };
}

function textSpec() {
  const s = app.state;
  const sel = s.texts.find((t) => t.id === app.sel.text) || null;
  const tabs = tabsOf([['templates', 'Templates'], ['font', 'Font'], ['style', 'Style'], ['colour', 'Colour']], 'text');
  const dis = { disabled: !sel };
  const set = (key, v) => {
    if (!sel) return;
    sel[key] = v;
    if (key === 'font') loadFont(v).then(() => { app.fontsReady = (app.fontsReady || 0) + 1; render(); });
    commitUI();
  };
  const head = [
    itIcon('add-text', 'Add', 'plus', { onTap: () => openTextSheet(null) }),
    itIcon('edit-text', 'Edit', 'edit', { onTap: () => openTextSheet(sel), ...dis }),
    itIcon('delete-text', 'Delete', 'trash', {
      onTap: () => {
        s.texts = s.texts.filter((t) => t !== sel);
        app.sel.text = null;
        commitUI();
      },
      ...dis,
    }),
    divider('d0'),
  ];
  let items, slider = null;
  if (app.tab.text === 'templates') {
    // A template restyles the selected text, or starts a new one in its look.
    const apply = (tp) => {
      loadFont(tp.v.font).then(() => { app.fontsReady = (app.fontsReady || 0) + 1; render(); });
      if (!sel) {
        app.textTemplate = tp;
        openTextSheet(null);
        return;
      }
      Object.assign(sel, tp.v);
      commitUI();
    };
    items = TEXT_TEMPLATES.map((tp) => ({
      key: `tt-${tp.id}`, kind: 'font', label: tp.name, css: fontCss(tp.v.font, 19),
      pressed: Boolean(sel) && Object.entries(tp.v).every(([k, v]) => (sel[k] ?? 0) === v), onTap: () => apply(tp),
    }));
  } else if (app.tab.text === 'style') {
    const glyph = { plain: 'tPlain', outline: 'tOutline', shadow: 'tShadow', label: 'tLabel', neon: 'tNeon' };
    items = [
      ...TEXT_STYLES.map((st) => itIcon(`ts-${st.id}`, st.name, glyph[st.id], { pressed: sel?.style === st.id, onTap: () => set('style', st.id), ...dis })),
      divider('d1'),
      itParam('textStyle', 'size', 'Size', 'size', 0, { value: sel ? (sel.size - 0.02) / 0.23 : 0, ...dis }),
      itParam('textStyle', 'angle', 'Angle', 'angle', -100, { value: sel ? sel.angle / 45 : 0, ...dis }),
      itParam('textStyle', 'spacing', 'Spacing', 'spacing', 0, { value: sel ? (sel.spacing || 0) / 0.5 : 0, ...dis }),
    ];
    if (sel) {
      slider = app.param.textStyle === 'angle'
        ? { label: 'Angle', min: -100, get: () => sel.angle / 45, set: (v) => { sel.angle = +(v * 45).toFixed(1); } }
        : app.param.textStyle === 'spacing'
          ? { label: 'Spacing', min: 0, get: () => (sel.spacing || 0) / 0.5, set: (v) => { sel.spacing = +(v * 0.5).toFixed(3); } }
          : { label: 'Size', min: 0, get: () => (sel.size - 0.02) / 0.23, set: (v) => { sel.size = +(0.02 + v * 0.23).toFixed(4); } };
    }
  } else if (app.tab.text === 'colour') {
    items = TEXT_COLORS.map((c) => itSwatch(`tc-${c.id}`, c.name, { hex: c.hex, pressed: sel?.color === c.id, onTap: () => set('color', c.id), ...dis }));
  } else {
    items = FONTS.map((f) => ({ key: `tf-${f.id}`, kind: 'font', label: f.name, css: fontCss(f.id, 19), pressed: sel?.font === f.id, onTap: () => set('font', f.id), ...dis }));
  }
  return {
    tabs, items: [...head, ...items], slider,
    hint: s.texts.length ? (sel ? 'Drag the text to move it' : 'Tap a text to change it') : 'Tap Add to write on the photo',
  };
}

// ---------- text editing ----------

function openTextSheet(t) {
  app.textEditing = t ? t.id : null;
  $('#text-input').value = t ? t.text : '';
  $('#text-sheet').hidden = false;
  setTimeout(() => $('#text-input').focus(), 30);
}

function closeTextSheet(save) {
  $('#text-sheet').hidden = true;
  const template = app.textTemplate;
  app.textTemplate = null;
  if (!save) return;
  const s = app.state, value = $('#text-input').value.replace(/\s+$/, '');
  const t = s.texts.find((q) => q.id === app.textEditing);
  if (t) {
    if (value.trim()) t.text = value;
    else {
      s.texts = s.texts.filter((q) => q !== t);
      app.sel.text = null;
    }
  } else if (value.trim()) {
    const id = `t${Date.now()}`;
    s.texts.push({
      id, text: value, font: 'sans', color: 'white', size: 0.075, x: 0.5, y: +(0.5 + 0.1 * (s.texts.length % 4)).toFixed(2), angle: 0, style: 'shadow',
      ...(template?.v || {}),
    });
    app.sel.text = id;
  } else {
    return;
  }
  commitUI();
}

// ---------- tool panels: drawing them ----------

const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text) n.textContent = text;
  return n;
};

function buildItem(it) {
  if (it.kind === 'divider') {
    const d = el('span', 'divider');
    d.dataset.key = it.key;
    d.setAttribute('aria-hidden', 'true');
    return d;
  }
  const n = el(it.fileFor ? 'label' : 'button', 'it');
  if (it.fileFor) {
    n.htmlFor = it.fileFor;
    n.tabIndex = 0;
    n.setAttribute('role', 'button');
  } else {
    n.type = 'button';
  }
  const kindClass = { tool: 'tool', swatch: 'sw', thumb: 'th' }[it.kind];
  if (kindClass) n.classList.add(kindClass);
  if (it.square) n.classList.add('square');
  if (it.hex2) n.classList.add('grad');
  if (it.ramp) n.classList.add('ramp');
  if (it.blank) n.classList.add('blank');
  n.dataset.key = it.key;
  if (it.group) n.dataset.group = it.group;
  if (it.tool) n.dataset.tool = it.tool;
  const ic = el('span', 'ic');
  if (it.kind === 'thumb') {
    const c = el('canvas');
    c.width = 120;
    c.height = it.square ? 120 : 156;
    c.setAttribute('aria-hidden', 'true');
    ic.append(c);
  }
  if (it.kind === 'font') {
    const f = el('span', 'font', 'Aa');
    f.style.font = it.css;
    f.setAttribute('aria-hidden', 'true');
    ic.append(f);
  }
  const glyph = it.kind === 'swatch' ? it.blank : it.icon;
  if (it.svg) ic.insertAdjacentHTML('beforeend', it.svg);
  else if (glyph) ic.insertAdjacentHTML('beforeend', icon(glyph));
  if (it.kind === 'param') ic.insertAdjacentHTML('beforeend', '<svg class="ring" viewBox="0 0 54 54" aria-hidden="true"><circle cx="27" cy="27" r="25" pathLength="100" stroke-dasharray="0 100"/></svg>');
  n.append(ic, el('span', 'lb', it.label));
  return n;
}

function setRing(node, v, min) {
  const ring = node.querySelector('.ring');
  if (!ring) return;
  const frac = Math.min(1, Math.abs(v || 0));
  ring.querySelector('circle').setAttribute('stroke-dasharray', `${(frac * 100).toFixed(1)} 100`);
  ring.style.opacity = frac > 0.004 ? '1' : '0';
  ring.style.transform = min < 0 && v < 0 ? 'scaleX(-1) rotate(-90deg)' : 'rotate(-90deg)';
}

function updateItem(n, it) {
  n._it = it;
  if (it.kind === 'divider') return;
  if (n.tagName === 'BUTTON') n.disabled = Boolean(it.disabled);
  else n.setAttribute('aria-disabled', String(Boolean(it.disabled)));
  if (it.kind !== 'tool') n.setAttribute('aria-pressed', String(Boolean(it.pressed)));
  n.dataset.dim = String(Boolean(it.dim));
  n.querySelector('.lb').textContent = it.label;
  if (it.hex) n.style.setProperty('--sw', it.hex);
  if (it.hex2) n.style.setProperty('--sw2', it.hex2);
  if (it.ramp) {
    n.style.setProperty('--sw3', it.ramp[0]);
    n.style.setProperty('--sw2', it.ramp[1]);
  }
  let dot = n.querySelector(':scope > .dot');
  if (it.dot && !dot) n.append((dot = el('span', 'dot')));
  else if (!it.dot && dot) dot.remove();
  if (it.kind === 'param') setRing(n, it.value, it.min);
  if (it.thumb) queueThumb(n.querySelector('canvas'), it.thumb);
}

function renderList(box, items, sig, build, update) {
  const fresh = box.dataset.sig !== sig;
  if (fresh) {
    box.replaceChildren(...items.map(build));
    box.dataset.sig = sig;
  }
  items.forEach((it, i) => update(box.children[i], it));
  return fresh;
}

let lastRowFrame = '';
function renderRow(spec) {
  const row = $('#row');
  const frame = app.view === 'tool' ? `${app.tool}|${app.tab[app.tool] || ''}` : `main|${app.mainGroup}`;
  const sig = `${frame}|${spec.items.map((i) => i.key).join(',')}`;
  const fresh = renderList(row, spec.items, sig, buildItem, updateItem);
  row.setAttribute('aria-label', app.view === 'tool' ? `${toolName(app.tool)} options` : 'Tools');
  if (fresh && frame !== lastRowFrame) {
    row.classList.remove('swap');
    void row.offsetWidth;
    row.classList.add('swap');
    row.scrollLeft = 0;
    const sel = app.view === 'main'
      ? row.querySelector(`[data-tool="${app.lastTool}"]`)
      : row.querySelector('.it[aria-pressed="true"]:not(.tool)');
    if (sel && sel.offsetLeft + sel.offsetWidth > row.clientWidth) row.scrollLeft = sel.offsetLeft - (row.clientWidth - sel.offsetWidth) / 2;
  }
  lastRowFrame = frame;
}

function buildTab(t) {
  const b = el('button', 'tab');
  b.type = 'button';
  b.setAttribute('role', 'tab');
  b.dataset.tab = t.id;
  b.append(el('span', '', t.label));
  return b;
}

function updateTab(b, t) {
  b._it = t;
  b.setAttribute('aria-selected', String(Boolean(t.selected)));
  let dot = b.querySelector('.dot');
  if (t.dot && !dot) b.append(el('span', 'dot'));
  else if (!t.dot && dot) dot.remove();
}

function renderBar(spec) {
  const tool = app.view === 'tool';
  $('#cancel').hidden = $('#done').hidden = !tool;
  const tabs = $('#tabs'), title = $('#bar-title');
  tabs.hidden = !spec.tabs;
  title.hidden = Boolean(spec.tabs) || !tool;
  if (spec.tabs) {
    const fresh = renderList(tabs, spec.tabs, `${app.view}|${app.tool}|${spec.tabs.map((t) => t.id).join(',')}`, buildTab, updateTab);
    const sel = tabs.querySelector('[aria-selected="true"]');
    if (sel && (fresh || sel.offsetLeft < tabs.scrollLeft || sel.offsetLeft + sel.offsetWidth > tabs.scrollLeft + tabs.clientWidth)) {
      tabs.scrollLeft = sel.offsetLeft - (tabs.clientWidth - sel.offsetWidth) / 2;
    }
  } else {
    title.textContent = spec.title || '';
  }
  if (tool) {
    $('#cancel').setAttribute('aria-label', `Discard changes to ${toolName(app.tool)}`);
    $('#done').setAttribute('aria-label', `Done with ${toolName(app.tool)}`);
  }
}

function renderChips(chips) {
  const box = $('#chips');
  box.hidden = !chips;
  if (!chips) return;
  renderList(box, chips, `${app.tool}|${app.tab[app.tool] || ''}|${chips.map((c) => c.key).join(',')}`, (c) => {
    const b = el('button', '', c.label);
    b.type = 'button';
    return b;
  }, (b, c) => {
    b._it = c;
    b.setAttribute('aria-pressed', String(Boolean(c.pressed)));
  });
}

// ---------- the floating slider ----------

const slider = { spec: null };
const sliderInput = $('#slider-input');

function setRange(input, v01) {
  const min = +input.min, max = +input.max;
  const v = Math.round(v01 * 100);
  input.value = v;
  const pct = (x) => ((x - min) / (max - min)) * 100 + '%';
  const zero = min < 0 ? 0 : min;
  input.style.setProperty('--a', pct(Math.min(zero, v)));
  input.style.setProperty('--b', pct(Math.max(zero, v)));
}

function showSliderValue(v01) {
  const v = Math.round(v01 * 100);
  $('#slider-value').textContent = slider.spec && slider.spec.min < 0 && v > 0 ? `+${v}` : String(v);
}

function bindSlider(spec) {
  slider.spec = spec;
  $('#slider').hidden = !spec;
  if (!spec) return;
  $('#slider-label').textContent = spec.label;
  sliderInput.min = String(spec.min || 0);
  sliderInput.setAttribute('aria-label', spec.label);
  setRange(sliderInput, spec.get());
  showSliderValue(spec.get());
}

const shownBrush = () => (2 * brushRadius() * vp.scale) / app.geoScale;

let previewTimer = 0;
function previewBrush(kind) {
  const c = $('#cursor');
  const r = stage.getBoundingClientRect();
  const d = kind === 'spot' ? (2 * blemishRadius() * 1.35 * vp.scale) / app.geoScale : shownBrush();
  Object.assign(c.style, { width: `${d}px`, height: `${d}px`, left: `${r.width / 2}px`, top: `${r.height / 2}px` });
  c.hidden = false;
  clearTimeout(previewTimer);
  previewTimer = setTimeout(() => { c.hidden = true; }, 700);
}

sliderInput.addEventListener('input', () => {
  const spec = slider.spec;
  if (!spec) return;
  const v = +sliderInput.value / 100;
  spec.set(v);
  setRange(sliderInput, v);
  showSliderValue(v);
  if (spec.preview) previewBrush(spec.preview);
  if (spec.path) {
    const n = $(`#row .it[data-key="${CSS.escape(spec.path)}"]`);
    if (n && n._it?.kind === 'param') setRing(n, v, n._it.min);
  }
  render();
});
sliderInput.addEventListener('change', () => {
  if (slider.spec && !slider.spec.ui) commit();
  syncUI();
});

// ---------- thumbnails: your own photo with each filter, look or light ----------

const thumbJobs = new Set();
let thumbsQueued = false;

function queueThumb(canvas, thumb) {
  canvas._thumb = thumb;
  thumbJobs.add(canvas);
  schedulePump(0);
}

// rect kinds: 'face' (a close crop), 'portrait' (head and shoulders), 'photo' (the whole photo).
function thumbRect(kind, aspect) {
  const W = app.W, H = app.H, f = app.faces[0];
  let cw, ch;
  if (kind !== 'photo' && f) {
    cw = Math.min(W, f.fw * (kind === 'face' ? 1.5 : 2.3));
    ch = cw / aspect;
    if (ch > H) {
      ch = H;
      cw = ch * aspect;
    }
  } else if (W / H > aspect) {
    ch = H;
    cw = H * aspect;
  } else {
    cw = W;
    ch = W / aspect;
  }
  // The crop sits a little below the face's centre, so the label along the bottom covers the
  // neck rather than the mouth.
  const cx = f ? f.center[0] : W / 2, cy = f ? f.center[1] + f.fw * (kind === 'portrait' ? 0.3 : 0.18) : H / 2;
  return [clamp(cx - cw / 2, 0, W - cw) / W, clamp(cy - ch / 2, 0, H - ch) / H, cw / W, ch / H];
}

function schedulePump(delay) {
  if (thumbsQueued) return;
  thumbsQueued = true;
  setTimeout(() => requestAnimationFrame(pumpThumbs), delay);
}

// Renders queued thumbnails a few at a time, so scrolling and painting stay smooth.
function pumpThumbs() {
  thumbsQueued = false;
  if (!renderer || !app.W) return;
  if (app.live) {
    schedulePump(150);
    return;
  }
  const t0 = performance.now();
  for (const c of thumbJobs) {
    thumbJobs.delete(c);
    if (!c.isConnected) continue;
    const st = c._thumb.state();
    if (needsNormals(st)) ensureNormals();
    const u = uniforms(st);
    const rect = thumbRect(c._thumb.rect, c.width / c.height);
    const key = `${JSON.stringify([u.comp, u.grade, rect])}|${renderer.version}|${app.loadToken}|${app.normalKey}|${app.personVersion}`;
    if (c._key === key) continue;
    c._key = key;
    c.getContext('2d').putImageData(renderer.renderPixels(u.comp, u.grade, c.width, c.height, rect), 0, 0);
    if (performance.now() - t0 > 12) break;
  }
  if (thumbJobs.size) schedulePump(0);
}

// ---------- on-photo handles ----------

function placeLightHandle() {
  const h = $('#light-handle');
  const show = app.view === 'tool' && app.tool === 'relight' && app.state.relight.preset === 'custom' && app.faces.length > 0 && !app.comparing;
  h.hidden = !show;
  if (!show) return;
  const f = app.faces[0], R = f.fw * 1.1, [dx, dy] = app.state.relight.dir;
  const [sx, sy] = toScreen(f.center[0] + dx * R, f.center[1] + dy * R);
  h.style.left = `${sx}px`;
  h.style.top = `${sy}px`;
}

// The stamp's source, the prism's sharp spot, Stretch's band, the crop frame and the frame
// around a selected text or added person.
function placeHandles() {
  placeLightHandle();
  placeTuneDots();
  const s = app.state, geo = app.geo, t = app.tool;
  const inTool = app.view === 'tool' && !app.comparing && geo;
  const marker = $('#marker');
  let mk = null;
  if (inTool && t === 'stamp' && app.stamp.src && !app.stamp.picking) {
    const L = app.live;
    mk = L && L.kind === 'clone' ? toScreen(L.st.x + L.s.dx, L.st.y + L.s.dy) : toScreen(...app.stamp.src);
  } else if (inTool && t === 'filters' && app.tab.filters === 'effects' && app.param.effects === 'effects.prism' && s.effects.prism > 0) {
    mk = outToScreen(s.effects.focus[0] * geo.out[0], s.effects.focus[1] * geo.out[1]);
  }
  marker.hidden = !mk;
  if (mk) {
    marker.style.left = `${mk[0]}px`;
    marker.style.top = `${mk[1]}px`;
  }
  const band = Boolean(inTool && t === 'body' && app.tab.body === 'stretch');
  for (const id of ['#band-a', '#band-b', '#band-fill']) $(id).hidden = !band;
  if (band) {
    const [a, b] = bandLines();
    const ya = outToScreen(0, a)[1], yb = outToScreen(0, b)[1];
    $('#band-a').style.top = `${ya}px`;
    $('#band-b').style.top = `${yb}px`;
    Object.assign($('#band-fill').style, { top: `${ya}px`, height: `${Math.max(0, yb - ya)}px` });
  }
  const box = $('#crop-box');
  const cropOn = Boolean(inTool && t === 'crop' && app.tab.crop === 'crop');
  box.hidden = !cropOn;
  if (cropOn) {
    const r = s.crop.rect, [Wf, Hs] = geo.out;
    const [x0, y0] = outToScreen(r[0] * Wf, r[1] * Hs), [x1, y1] = outToScreen((r[0] + r[2]) * Wf, (r[1] + r[3]) * Hs);
    Object.assign(box.style, { left: `${x0}px`, top: `${y0}px`, width: `${x1 - x0}px`, height: `${y1 - y0}px` });
  }
  const sb = $('#sel-box');
  let sel = null;
  if (inTool && t === 'text' && app.sel.text) {
    const tx = s.texts.find((q) => q.id === app.sel.text);
    if (tx) {
      const [hw, hh] = textBox(tx, ...geo.out);
      sel = { c: outToScreen(tx.x * geo.out[0], tx.y * geo.out[1]), w: hw * 2 * vp.scale, h: hh * 2 * vp.scale, a: tx.angle };
    }
  } else if (inTool && t === 'sculpt' && app.faces.length > 1 && app.sculptFace >= 0 && app.faces[app.sculptFace]) {
    const [x0, y0, x1, y1] = app.faces[app.sculptFace].box, k = vp.scale / app.geoScale;
    sel = { c: toScreen((x0 + x1) / 2, (y0 + y1) / 2), w: (x1 - x0) * k * 1.15, h: (y1 - y0) * k * 1.15, a: 0 };
  } else if (inTool && t === 'background' && app.tab.background === 'people' && app.sel.person) {
    const p = s.people.find((q) => q.id === app.sel.person), cut = p && app.cutouts.get(p.id);
    if (cut) {
      const hh = (p.h / 2) * app.H, hw = (hh * cut.width) / cut.height, k = vp.scale / app.geoScale;
      sel = { c: toScreen(p.x * app.W, p.y * app.H), w: hw * 2 * k, h: hh * 2 * k, a: 0 };
    }
  }
  sb.hidden = !sel;
  if (sel) {
    Object.assign(sb.style, {
      left: `${sel.c[0] - sel.w / 2}px`, top: `${sel.c[1] - sel.h / 2}px`, width: `${sel.w}px`, height: `${sel.h}px`, transform: `rotate(${sel.a}deg)`,
    });
  }
}

// ---------- the editor: main row, tools, ✗ / ✓ ----------

let lastHint = '';
function syncUI() {
  const root = $('#app');
  root.dataset.view = app.view;
  $('#open').classList.toggle('labelled', app.isSample);
  syncHistoryButtons();
  const spec = app.view === 'tool' && app.tool ? toolSpec(app.tool) : mainSpec();
  renderRow(spec);
  renderBar(spec);
  renderChips(spec.chips || null);
  const note = $('#note');
  note.hidden = !spec.note;
  note.textContent = spec.note || '';
  bindSlider(spec.slider || null);
  // Hints show once, when a tool or tab opens (or when the hint itself changes).
  const hintKey = `${app.view}|${app.tool}|${app.tab[app.tool] || ''}|${spec.hint || ''}`;
  if (hintKey !== lastHint) {
    lastHint = hintKey;
    if (spec.hint && app.view === 'tool') toast(spec.hint);
  }
  // The compare and fit buttons sit just above whatever floats at the bottom of the photo.
  let lift = 10;
  for (const n of $('#float').children) if (!n.hidden) lift += n.offsetHeight + 8;
  $('.side').style.bottom = $('#fit').style.bottom = `${lift}px`;
  const ct = $('#compare-tool');
  ct.hidden = app.view !== 'tool' || app.tool === 'crop';
  if (app.view === 'tool') {
    ct.innerHTML = icon(app.tool);
    ct.setAttribute('aria-label', `Hold to see the photo before ${toolName(app.tool)}`);
    ct.title = `Hold: before ${toolName(app.tool)}`;
  }
  placeHandles();
}

function openTool(id) {
  if (app.live || !app.W) return;
  const t = TOOLS.find((x) => x.id === id);
  if (faceOff(t)) {
    toast(app.faceStatus === 'error' ? 'Face tools aren’t available in this browser.' : `No face found, so ${t.name} has nothing to work on.`);
    return;
  }
  const s = app.state;
  app.tool = id;
  app.lastTool = id;
  app.mainGroup = t.group;      // ✓ or ✗ comes back to this tool's group
  app.view = 'tool';
  app.entryIndex = app.index;
  app.showMask = false;
  $('#cursor').hidden = true;
  $('#toast').hidden = true;
  if (id === 'background' || id === 'relight') ensurePerson();
  if (id === 'background') ensureParts();   // its cut-out is the better one at hair and edges
  if (id === 'body') {
    ensurePose();
    ensurePerson();
  }
  if (id === 'skin') ensureParts();
  if (id === 'hair' && !(s.hairStrokes.length || s.hair.auto)) app.tab.hair = 'paint';
  else if (id === 'hair' && app.tab.hair === 'paint') app.tab.hair = 'colour';
  if (id === 'auto' && !s.auto.on && app.faces.length) applyAuto();
  if (id === 'stamp') app.stamp.picking = !app.stamp.src;
  if (id === 'text' && !s.texts.length) openTextSheet(null);
  if (id === 'text' && !app.sel.text && s.texts.length) app.sel.text = s.texts[s.texts.length - 1].id;
  syncUI();
  render();
}

// keep: ✓ (the tool's changes stay). ✗ puts the photo back as it was when the tool was opened;
// that is a step of its own, so Undo can still bring the work back.
function closeTool(keep) {
  if (app.live || app.view !== 'tool') return;
  if (app.comparing) stopCompare();
  if (!keep && app.index !== app.entryIndex && app.history[app.entryIndex]) {
    restore(app.history[app.entryIndex]);
    commit();
  }
  app.view = 'main';
  app.showMask = false;
  $('#cursor').hidden = true;
  $('#toast').hidden = true;
  syncUI();
  render();
}

function setGroup(id) {
  if (app.mainGroup === id) return;
  app.mainGroup = id;
  syncUI();
}

let toastTimer = 0;
function toast(text) {
  const t = $('#toast');
  t.textContent = text;
  t.hidden = false;
  $('#status').hidden = true;
  t.style.animation = 'none';
  void t.offsetWidth;
  t.style.animation = '';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 2800);
}

function busy(text) {
  $('#busy').hidden = !text;
  if (text) $('#busy-text').textContent = text;
}

// ---------- saving ----------

function stamp() {
  const d = new Date(), p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

async function save() {
  if (!app.W || !renderer) return;
  busy('Preparing your photo…');
  let blob;
  try {
    await nextFrame();
    const s = app.state;
    if (needsNormals(s)) ensureNormals();
    const geo = geometry(s.crop, app.W, app.H, { text: s.texts.length > 0, stretch: s.stretch });
    syncText(geo);
    let u = uniforms();
    // Background Freeze saves with its patch-filled plate, not the quick smooth one.
    if (u.grade.uFreeze && app.freezeDone) {
      await app.freezeDone;
      u = uniforms();
    }
    const img = renderer.renderPixels(u.comp, u.grade, geo.out[0], geo.out[1], [0, 0, 1, 1], geo);
    const c = document.createElement('canvas');
    c.width = img.width;
    c.height = img.height;
    c.getContext('2d').putImageData(img, 0, 0);
    blob = await new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('encode failed'))), 'image/jpeg', 0.92));
    release(c);
  } catch (e) {
    console.error(e);
    busy(null);
    toast('Could not export the photo. Try again.');
    return;
  }
  busy(null);
  render();
  const result = await saveBlob(blob, `lumina-${stamp()}.jpg`);
  if (result === 'saved') toast('Saved');
  else if (result === 'shared') toast('Shared');
  else if (result === 'downloaded') toast('Downloaded');
  else if (result === 'busy') toast('A save prompt is already open');
  else if (result === 'manual') showManualSave(blob);
}

let manualUrl = '';
function showManualSave(blob) {
  if (manualUrl) URL.revokeObjectURL(manualUrl);
  manualUrl = URL.createObjectURL(blob);
  $('#save-img').src = manualUrl;
  $('#save-sheet').hidden = false;
  $('#save-sheet-close').focus();
}

// ---------- events ----------

// A mouse has no sideways swipe, so on a computer the wheel scrolls a row of options sideways, and
// dragging the row scrolls it as a finger does (the click that ends a drag is not a tap). Trackpads
// and touch scroll as before.
function mouseScroll(el) {
  el.addEventListener('wheel', (e) => {
    if (el.scrollWidth <= el.clientWidth || Math.abs(e.deltaX) >= Math.abs(e.deltaY)) return;
    el.scrollLeft += e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? el.clientWidth : 1);
    e.preventDefault();
  }, { passive: false });
  let drag = null;
  el.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' && e.button === 0 && el.scrollWidth > el.clientWidth) drag = { id: e.pointerId, x: e.clientX, left: el.scrollLeft, moved: false };
  });
  el.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const dx = e.clientX - drag.x;
    if (!drag.moved && Math.abs(dx) < 6) return;
    if (!drag.moved) {
      drag.moved = true;
      el.setPointerCapture(e.pointerId);
      el.classList.add('dragging');
    }
    el.scrollLeft = drag.left - dx;
  });
  const end = (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    if (drag.moved) {
      const swallow = (c) => {
        c.stopPropagation();
        c.preventDefault();
      };
      el.addEventListener('click', swallow, { capture: true, once: true });
      setTimeout(() => el.removeEventListener('click', swallow, { capture: true }), 0);
      el.classList.remove('dragging');
    }
    drag = null;
  };
  el.addEventListener('pointerup', end);
  el.addEventListener('pointercancel', end);
  el.addEventListener('dragstart', (e) => e.preventDefault());
}

// Tools whose touches drag a handle rather than paint, so no brush circle follows the finger.
const NO_CURSOR = ['relight', 'crop', 'text', 'body', 'filters', 'makeup'];

function wire() {
  // One listener per list: items, tabs and chips carry what they do (set on every render).
  const tapOf = (sel) => (e) => {
    const n = e.target.closest(sel);
    if (!n || n.disabled || n.getAttribute('aria-disabled') === 'true' || !n._it?.onTap) return;
    n._it.onTap();
  };
  $('#row').addEventListener('click', tapOf('.it'));
  $('#tabs').addEventListener('click', tapOf('.tab'));
  $('#chips').addEventListener('click', tapOf('button'));
  for (const id of ['#row', '#tabs', '#chips']) mouseScroll($(id));
  $('#row').addEventListener('keydown', (e) => {
    const n = e.target.closest('label.it');
    if (n && (e.key === 'Enter' || e.key === ' ')) {
      e.preventDefault();
      n.click();
    }
  });
  $('#cancel').addEventListener('click', () => closeTool(false));
  $('#done').addEventListener('click', () => closeTool(true));

  $('#bg-file').addEventListener('change', async () => {
    const f = $('#bg-file').files && $('#bg-file').files[0];
    if (f) await loadBgImage(f);
    $('#bg-file').value = '';
  });
  $('#person-file').addEventListener('change', async () => {
    const f = $('#person-file').files && $('#person-file').files[0];
    if (f) await addPerson(f);
    $('#person-file').value = '';
  });
  const tone = $('#tone-color');
  tone.addEventListener('input', () => {
    app.state.skin.custom = tone.value;
    app.state.skin.tone = 'custom';
    ensureParts();
    syncUI();
    render();
  });
  tone.addEventListener('change', commitUI);
  $('#text-cancel').addEventListener('click', () => closeTextSheet(false));
  $('#text-done').addEventListener('click', () => closeTextSheet(true));
  $('#text-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) closeTextSheet(true);
  });

  $('#undo').addEventListener('click', undo);
  $('#redo').addEventListener('click', redo);
  $('#save').addEventListener('click', save);
  $('#save-sheet-close').addEventListener('click', () => { $('#save-sheet').hidden = true; });
  $('#fit').addEventListener('click', () => {
    vp.reset();
    render();
  });

  // Open is a <label for="file">, so the browser opens the photo picker itself (more reliable on
  // phones than a script-triggered click). The click handler only starts fetching the face model
  // while the person chooses.
  const file = $('#file');
  $('#open').addEventListener('click', () => preloadFaceModel().catch(() => {}));
  $('#open').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      file.click();
    }
  });
  file.addEventListener('change', async () => {
    const f = file.files && file.files[0];
    if (f) await openFile(f);
    file.value = '';
  });
  stage.addEventListener('dragover', (e) => e.preventDefault());
  stage.addEventListener('drop', (e) => {
    e.preventDefault();
    const f = [...(e.dataTransfer?.files || [])].find((x) => x.type.startsWith('image/'));
    if (f) openFile(f);
  });
  window.addEventListener('paste', (e) => {
    if (!$('#text-sheet').hidden) return;
    const f = [...(e.clipboardData?.files || [])].find((x) => x.type.startsWith('image/'));
    if (f) openFile(f);
  });

  holdToCompare($('#compare'), 'all');
  holdToCompare($('#compare-tool'), 'tool');

  window.addEventListener('keydown', (e) => {
    if (!$('#text-sheet').hidden) {
      if (e.key === 'Escape') closeTextSheet(false);
      return;
    }
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      e.shiftKey ? redo() : undo();
    } else if (mod && e.key.toLowerCase() === 'y') {
      e.preventDefault();
      redo();
    } else if (e.key === 'Escape' && app.view === 'tool' && $('#save-sheet').hidden) {
      closeTool(true);
    }
  });

  const cursor = $('#cursor');
  attachStageInput(stage, vp, {
    mode: brushMode,
    view: render,
    tap: healAt,
    strokeStart,
    strokeMove,
    strokeEnd,
    strokeCancel,
    cursor: (x, y, show) => {
      const mode = brushMode();
      cursor.hidden = !show || mode === 'pan' || !app.W || NO_CURSOR.includes(app.tool) || (app.tool === 'background' && app.tab.background === 'people') ||
        (app.tool === 'stamp' && (app.stamp.picking || !app.stamp.src));
      if (cursor.hidden) return;
      clearTimeout(previewTimer);
      const d = mode === 'tap' ? (2 * blemishRadius() * 1.35 * vp.scale) / app.geoScale : shownBrush();
      cursor.style.width = cursor.style.height = `${d}px`;
      cursor.style.left = `${x}px`;
      cursor.style.top = `${y}px`;
    },
  });
}

async function openFile(f) {
  busy('Opening photo…');
  try {
    // Copy the bytes first: some phones hand over a temporary file that can vanish later.
    const blob = new Blob([await f.arrayBuffer()], { type: f.type });
    await loadPhoto(blob);
    vp.reset();
    syncUI();
  } catch (e) {
    console.error(e);
    toast(/hei[cf]/i.test(`${f.type} ${f.name}`)
      ? 'This browser can’t open HEIC photos. Choose a JPEG, or a screenshot of the photo.'
      : 'Could not open that photo. Try a JPEG or PNG.');
  } finally {
    busy(null);
  }
}

async function loadSample() {
  const [img, meta, personBlob] = await Promise.all([
    fetch('assets/sample.jpg').then((r) => r.blob()),
    fetch('assets/sample-face.json').then((r) => r.json()).catch(() => null),
    fetch('assets/sample-person.png').then((r) => (r.ok ? r.blob() : null)).catch(() => null),
  ]);
  let person = null;
  if (personBlob) {
    const pic = await decodeImage(personBlob);
    const c = document.createElement('canvas');
    c.width = pic.width;
    c.height = pic.height;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(pic.source, 0, 0);
    pic.done();
    const d = ctx.getImageData(0, 0, c.width, c.height).data;
    const data = new Uint8ClampedArray(c.width * c.height);
    for (let i = 0; i < data.length; i++) data[i] = d[i * 4];
    person = { w: c.width, h: c.height, data };
    release(c);
  }
  await loadPhoto(img, meta ? { faces: meta.faces, person } : null);
  if (meta) applyAuto();
}

async function start() {
  moveSavedKeys();
  wire();
  prepareSaving();
  syncUI();
  if (!renderer) return;
  busy('Loading sample…');
  try {
    await loadSample();
  } catch (e) {
    console.error(e);
    toast('Open a photo to start.');
  } finally {
    busy(null);
  }
  // Text fonts load in the background; text drawn before they arrive is redrawn once they do.
  Promise.all(FONTS.map((f) => loadFont(f.id))).then(() => {
    app.fontsReady = (app.fontsReady || 0) + 1;
    render();
  });
}

if (new URLSearchParams(location.search).has('dev')) {
  window.__lumina = {
    app, vp, layers, uniforms, render, syncUI, commit, openTool, closeTool, applyAuto, loadPhoto, detectFaces, segmentPerson,
    restore, updateWarp, ensureParts, ensurePose, addPerson, closeTextSheet, openTextSheet, setTab, toPhoto, toScreen,
    redrawHair, tapRegion, applyPreset, ageAt, presets: PRESETS, sculptControls: SCULPT_CONTROLS, hairStyles: HAIR_STYLES, filters: FILTERS, findHighlights,
    geometryOf: (s) => geometry(s.crop, app.W, app.H, { text: s.texts.length > 0, stretch: s.stretch }),
    get renderer() { return renderer; },
  };
}

start();
