// Presets: colour filters (deltas fed to the grade shader), makeup palettes, styles and looks,
// hair and skin colours, hair styles, contour styles, bokeh shapes. Tints are RGB where 0.5 means "no shift".

// Age: one slider from younger (−1) to older (1), as Snapchat's Time Machine and Photoshop's Facial
// Age have, moves every part below; the Look tab lists the parts it is changing, and the Skin, Face
// and Hair tabs adjust each one (below 0 younger, above older). A part has its strength at full Older,
// where along Older it begins, and its strength at full Younger. The order follows the research
// (evidence §14): fine lines and shadows round the eyes first; hollows, fading brows and duller skin
// next; then sagging, thinner and paler lips, spots and grey hair (first at the temples); the nose,
// crepey texture and a higher hairline last. Texture, Grey hair and Temples have no younger side:
// Younger never smooths skin or recolours hair. Younger mostly works through the retouch tools' own
// effects; Older draws its own (gl.js, the age map) and warps (main.js ageSculpt).
export const AGE_PARTS = [
  // [key, label, icon, tab, at full Older, where Older begins it (0–1), at full Younger]
  ['lines', 'Wrinkles', 'wrinkles', 'skin', 0.9, 0, 1],
  ['circles', 'Dark circles', 'circles', 'skin', 0.55, 0.05, 0.7],
  ['bags', 'Eye bags', 'eyeBags', 'skin', 0.75, 0.15, 0.85],
  ['skin', 'Dull skin', 'skin', 'skin', 0.6, 0.2, 0.4],
  ['tone', 'Blotches', 'even', 'skin', 0.6, 0.3, 0.6],
  ['spots', 'Spots', 'darkSpots', 'skin', 0.65, 0.35, 0.7],
  ['texture', 'Texture', 'texture', 'skin', 0.7, 0.45, 0],
  ['volume', 'Volume', 'cheekFill', 'face', 0.6, 0.1, 0.7],
  ['brows', 'Brows', 'sc-browThickness', 'face', 0.6, 0.15, 0.5],
  ['sag', 'Sagging', 'jaw', 'face', 0.7, 0.3, 0.6],
  ['lips', 'Lips', 'lips', 'face', 0.6, 0.3, 0.45],
  ['eyes', 'Eyes', 'eyes', 'face', 0.5, 0.35, 0.5],
  ['teeth', 'Teeth', 'teeth', 'face', 0.5, 0.3, 0.4],
  ['shape', 'Proportions', 'face', 'face', 0.4, 0.4, 0.5],
  ['nose', 'Nose', 'nose', 'face', 0.5, 0.5, 0.4],
  ['grey', 'Grey hair', 'hair', 'hair', 0.9, 0.3, 0],
  ['temples', 'Temples first', 'temples', 'hair', 0.45, 0.3, 0],
  ['hairline', 'Hairline', 'sc-hairline', 'hair', 0.5, 0.5, 0.3],
];
// Where Younger and Older put the Age slider.
export const AGE_LOOKS = { younger: -0.7, older: 0.7 };

// Presets, as AirBrush's (Natural, Smooth, Aesthetic, Stylized, each with an artistic-effect and a
// background slider): one tap sets a filter, some retouching and a background treatment. Lumina's
// "Clean" stands where AirBrush has "Smooth", because no preset smooths skin. `set` holds state paths
// at full Look; `bg` the background at full Background (blur, and bright: below 0 darker).
export const PRESET_CATS = [['natural', 'Natural'], ['clean', 'Clean'], ['aesthetic', 'Aesthetic'], ['stylized', 'Stylized']];
export const PRESETS = [
  { id: 'fresh', name: 'Fresh', cat: 'natural', filter: ['clean', 0.6], set: { 'eyes.bright': 0.3, 'teeth.white': 0.3, 'adjust.vibrance': 0.12 }, bg: { blur: 0.15 } },
  { id: 'bright', name: 'Bright', cat: 'natural', filter: ['dewy', 0.7], set: { 'adjust.exposure': 0.08, 'eyes.circles': 0.4, 'eyes.bright': 0.25 }, bg: { bright: 0.15 } },
  { id: 'warmth', name: 'Warm', cat: 'natural', filter: ['honey', 0.6], set: { 'eyes.bright': 0.25, 'plump.cheeks': 0.2 }, bg: { blur: 0.2 } },
  { id: 'softportrait', name: 'Soft', cat: 'natural', filter: ['pearl', 0.55], set: { 'eyes.iris': 0.3, 'plump.sockets': 0.2 }, bg: { blur: 0.4 } },
  { id: 'rested', name: 'Rested', cat: 'clean', filter: ['satin', 0.4], set: { 'eyes.circles': 0.6, 'conceal.bags': 0.45, 'conceal.trough': 0.35, 'eyes.bright': 0.3 }, bg: {} },
  { id: 'even', name: 'Even', cat: 'clean', filter: ['clean', 0.35], set: { 'skin.redness': 0.5, 'conceal.dark': 0.35, 'eyes.circles': 0.3 }, bg: {} },
  { id: 'clearskin', name: 'Clear', cat: 'clean', filter: ['ivory', 0.35], set: { 'skin.redness': 0.35, 'conceal.dark': 0.45, 'wrinkles.under': 0.4, 'teeth.white': 0.35 }, bg: {} },
  { id: 'lifted', name: 'Lifted', cat: 'clean', filter: ['dewy', 0.4], set: { 'plump.cheeks': 0.4, 'plump.temples': 0.3, 'plump.sockets': 0.3, 'wrinkles.smile': 0.35 }, bg: {} },
  { id: 'goldenpreset', name: 'Golden', cat: 'aesthetic', filter: ['goldenhour', 0.85], set: { 'eyes.bright': 0.25, 'adjust.temperature': 0.1 }, bg: { blur: 0.35 } },
  { id: 'rosepreset', name: 'Rosé', cat: 'aesthetic', filter: ['rosehaze', 0.8], set: { 'eyes.bright': 0.2, 'plump.cheeks': 0.25 }, bg: { blur: 0.3, bright: 0.1 } },
  { id: 'seoulpreset', name: 'Seoul', cat: 'aesthetic', filter: ['seoul', 0.8], set: { 'eyes.bright': 0.35, 'eyes.circles': 0.4, 'skin.redness': 0.3 }, bg: { bright: 0.12, blur: 0.2 } },
  { id: 'filmpreset', name: 'Film', cat: 'aesthetic', filter: ['portra', 0.85], set: { 'eyes.bright': 0.2 }, bg: { blur: 0.2 } },
  { id: 'dreampreset', name: 'Dream', cat: 'aesthetic', filter: ['daydream', 0.8], set: { 'effects.soft': 0.3, 'eyes.iris': 0.25 }, bg: { blur: 0.45 } },
  { id: 'neonpreset', name: 'Neon', cat: 'stylized', filter: ['neonnight', 0.85], set: { 'adjust.contrast': 0.1 }, bg: { bright: -0.3, blur: 0.25 } },
  { id: 'vhspreset', name: 'Tape', cat: 'stylized', filter: ['vhs', 0.85], set: {}, bg: {} },
  { id: 'emberpreset', name: 'Ember', cat: 'stylized', filter: ['ember', 0.85], set: { 'effects.halation': 0.25 }, bg: { bright: -0.15 } },
  { id: 'holopreset', name: 'Holo', cat: 'stylized', filter: ['holo', 0.8], set: { 'effects.glow': 0.2 }, bg: { blur: 0.3 } },
  { id: 'noirpreset', name: 'Noir', cat: 'stylized', filter: ['noir', 0.9], set: { 'adjust.clarity': 0.2 }, bg: { bright: -0.35 } },
];

// Filter categories (chips over the thumbnails), and the filters: deltas fed to the grade shader.
// `isolate: [hue 0–1, width]` keeps one hue range in colour (AirBrush ships a red-only filter).
// Filters with `lut` also apply a colour table computed from that recipe (see luts.js); their `p`
// adds grain, vignette or halation on top. 'saved' lists the person's favourites.
export const FILTER_CATS = [['all', 'All'], ['saved', 'Saved'], ['portrait', 'Portrait'], ['light', 'Light'], ['dreamy', 'Dreamy'], ['retro', 'Retro'],
  ['film', 'Film'], ['cinema', 'Cinema'], ['aesthetic', 'Aesthetic'], ['warm', 'Warm'], ['cool', 'Cool'], ['mood', 'Mood'], ['bw', 'B&W'],
  ['pop', 'Colour pop']];

export const FILTERS = [
  { id: 'none', name: 'Original', p: {} },
  // Light, Dreamy and Retro: a grade plus drawn layers `o` over it (gl.js ovLayer), as AirBrush's
  // filters lay light leaks, streaks and washes over their colour tables and keep faces clear.
  // A layer: { k: kind, blend, a: amount, c1, c2, pos: [x, y] (0–1 of the frame), ang (°), size }.
  {
    id: 'sunbeam', name: 'Sunbeam', cat: 'light',
    p: { warmth: 0.3, exposure: 0.05, fade: 0.1, highTint: [0.57, 0.52, 0.45], split: 0.4, vignette: 0.15 },
    o: [{ k: 'streak', c1: '#ffd27a', c2: '#ff8a5c', pos: [-0.04, -0.04], ang: 38, size: 0.42, a: 0.85 }],
  },
  {
    id: 'goldenhour', name: 'Golden hour', cat: 'light', p: { warmth: 0.35, contrast: 0.08, saturation: 0.08 },
    o: [{ k: 'wash', blend: 'soft', c1: '#ffa24f', c2: '#808080', pos: [0.5, 0], ang: 90, size: 0.55, a: 0.75 },
      { k: 'leak', c1: '#ffcf8a', c2: '#ff9a5c', pos: [0.95, 0.05], size: 0.5, a: 0.35 }],
  },
  {
    id: 'rosehaze', name: 'Rose haze', cat: 'light', p: { fade: 0.25, contrast: -0.1, tint: 0.08, exposure: 0.04 },
    o: [{ k: 'leak', c1: '#ff7fa8', c2: '#ffc2d2', pos: [0.02, 0.96], size: 0.6, a: 0.55 }],
  },
  {
    id: 'flare', name: 'Flare', cat: 'light', p: { contrast: 0.1, warmth: 0.12 },
    o: [{ k: 'flare', c1: '#fff2d6', c2: '#ff9c5e', pos: [0.86, 0.12], size: 0.55, a: 0.75 }],
  },
  {
    id: 'ember', name: 'Ember', cat: 'light', p: { warmth: 0.3, contrast: 0.12, fade: 0.1, grain: 0.15 },
    o: [{ k: 'burn', c1: '#d8360b', c2: '#ffc15e', pos: [1, 0.5], ang: 0, size: 0.4, a: 0.65 }],
  },
  {
    id: 'prismlight', name: 'Prism light', cat: 'light', p: { fade: 0.12, exposure: 0.04 },
    o: [{ k: 'sheen', blend: 'soft', c1: '#ffffff', ang: 32, size: 0.45, a: 0.35 },
      { k: 'leak', c1: '#7fe3ff', c2: '#c69bff', pos: [1.02, 0.4], size: 0.45, a: 0.35 }],
  },
  {
    id: 'daydream', name: 'Daydream', cat: 'dreamy', p: { fade: 0.2, contrast: -0.15, exposure: 0.08, saturation: -0.05 },
    o: [{ k: 'leak', c1: '#fff1e0', c2: '#ffd9c2', pos: [0.5, -0.12], size: 0.75, a: 0.45 }],
  },
  {
    id: 'stardust', name: 'Stardust', cat: 'dreamy', p: { exposure: 0.05, fade: 0.15, warmth: -0.1, highTint: [0.5, 0.5, 0.54], split: 0.35 },
    o: [{ k: 'stars', c1: '#ffffff', size: 0.3, a: 0.85, face: 0.6 },
      { k: 'leak', c1: '#9fb8ff', c2: '#d2b8ff', pos: [0.02, 0.02], size: 0.5, a: 0.3 }],
  },
  {
    id: 'holo', name: 'Holo', cat: 'dreamy', p: { fade: 0.2, saturation: -0.05, tint: 0.08 },
    o: [{ k: 'sheen', blend: 'soft', c1: '#ffffff', ang: 40, size: 0.35, a: 0.45 }],
  },
  {
    id: 'aurora', name: 'Aurora', cat: 'dreamy', p: { warmth: -0.2, contrast: 0.05 },
    o: [{ k: 'wash', blend: 'soft', c1: '#30e0b8', c2: '#9a5cff', pos: [0.5, 0.5], ang: 60, size: 0.6, a: 0.55 },
      { k: 'leak', c1: '#8affc8', c2: '#5ce1ff', pos: [0.02, 0.05], size: 0.45, a: 0.3 }],
  },
  {
    id: 'neonnight', name: 'Neon night', cat: 'dreamy',
    p: { contrast: 0.2, exposure: -0.05, shadowTint: [0.45, 0.47, 0.58], split: 0.5 },
    o: [{ k: 'wash', blend: 'overlay', c1: '#ff3cac', c2: '#2b86ff', pos: [0.5, 0.5], ang: 0, size: 0.5, a: 0.5 }],
  },
  {
    id: 'vhs', name: 'VHS', cat: 'retro', p: { saturation: -0.15, fade: 0.25, warmth: 0.1, contrast: -0.05, curve: 0.1 },
    o: [{ k: 'vhs', a: 0.8, face: 0 }, { k: 'wash', blend: 'soft', c1: '#7aa8ff', c2: '#ffb27a', pos: [0.5, 0.5], ang: 90, size: 0.5, a: 0.25 }],
  },
  {
    id: 'filmburn', name: 'Film burn', cat: 'retro', p: { fade: 0.35, warmth: 0.25, grain: 0.3, vignette: 0.25, saturation: -0.1 },
    o: [{ k: 'burn', c1: '#b8241a', c2: '#ffcc66', pos: [0, 0.62], ang: 180, size: 0.38, a: 0.65 }],
  },
  {
    id: 'disposable', name: 'Disposable', cat: 'retro', p: { exposure: 0.08, contrast: 0.2, warmth: 0.15, saturation: 0.1, vignette: 0.35, grain: 0.25 },
    o: [{ k: 'leak', c1: '#ffb36b', c2: '#ff7a59', pos: [-0.02, 0.02], size: 0.4, a: 0.3 }],
  },
  { id: 'porcelain', name: 'Porcelain', cat: 'portrait', p: { exposure: 0.12, contrast: -0.1, saturation: -0.14, warmth: -0.15, fade: 0.25, highTint: [0.49, 0.5, 0.53], split: 0.35 } },
  { id: 'peach', name: 'Peach', cat: 'portrait', p: { exposure: 0.08, warmth: 0.35, tint: 0.12, fade: 0.3, saturation: 0.05, shadowTint: [0.52, 0.48, 0.5], highTint: [0.56, 0.5, 0.46], split: 0.5 } },
  { id: 'rose', name: 'Rosé', cat: 'portrait', p: { warmth: 0.1, tint: 0.25, fade: 0.2, saturation: -0.05, highTint: [0.56, 0.48, 0.52], split: 0.5 } },
  { id: 'clean', name: 'Clean', cat: 'portrait', p: { exposure: 0.04, contrast: 0.12, vibrance: 0.3, sharpen: 0.35 } },
  { id: 'seoul', name: 'Seoul', cat: 'portrait', p: { exposure: 0.15, contrast: -0.08, tint: 0.12, saturation: -0.05, highTint: [0.53, 0.5, 0.52], split: 0.4, fade: 0.1 } },
  { id: 'bloom', name: 'Bloom', cat: 'portrait', p: { exposure: 0.1, contrast: -0.15, fade: 0.35, saturation: -0.1, tint: 0.1, highTint: [0.55, 0.5, 0.53], split: 0.4 } },
  { id: 'dewy', name: 'Dewy', cat: 'portrait', p: { exposure: 0.08, contrast: -0.05, vibrance: 0.15, tint: 0.05, highTint: [0.53, 0.5, 0.5], split: 0.3 } },
  { id: 'honey', name: 'Honey', cat: 'portrait', p: { warmth: 0.3, exposure: 0.06, saturation: 0.08, highTint: [0.57, 0.52, 0.45], split: 0.4 } },
  { id: 'blush', name: 'Blush', cat: 'portrait', p: { tint: 0.2, warmth: 0.1, fade: 0.15, highTint: [0.55, 0.49, 0.52], split: 0.4 } },
  { id: 'ivory', name: 'Ivory', cat: 'portrait', p: { exposure: 0.1, saturation: -0.2, warmth: 0.05, fade: 0.2, contrast: -0.05 } },
  { id: 'satin', name: 'Satin', cat: 'portrait', p: { contrast: 0.05, curve: 0.15, vibrance: 0.2, fade: 0.1 } },
  { id: 'pearl', name: 'Pearl', cat: 'portrait', p: { exposure: 0.14, contrast: -0.12, saturation: -0.1, warmth: -0.05, highTint: [0.5, 0.51, 0.54], split: 0.3, fade: 0.15 } },
  { id: 'film', name: 'Film 98', cat: 'film', p: { contrast: 0.08, saturation: -0.2, fade: 0.55, curve: 0.25, shadowTint: [0.46, 0.53, 0.5], highTint: [0.55, 0.52, 0.45], split: 0.7, grain: 0.35 } },
  { id: 'vintage', name: 'Vintage', cat: 'film', p: { warmth: 0.25, contrast: -0.05, saturation: -0.3, fade: 0.5, shadowTint: [0.5, 0.5, 0.44], highTint: [0.57, 0.53, 0.44], split: 0.6, grain: 0.3, vignette: 0.3 } },
  { id: 'matte', name: 'Matte', cat: 'film', p: { contrast: -0.2, fade: 0.6, saturation: -0.3, curve: 0.1 } },
  { id: 'portra', name: 'Film 400', cat: 'film', p: { warmth: 0.15, saturation: -0.08, fade: 0.3, curve: 0.15, shadowTint: [0.48, 0.51, 0.52], highTint: [0.56, 0.52, 0.46], split: 0.5, grain: 0.2 } },
  { id: 'gold200', name: 'Gold 200', cat: 'film', p: { warmth: 0.3, contrast: 0.15, saturation: 0.12, shadowTint: [0.5, 0.48, 0.44], highTint: [0.58, 0.53, 0.43], split: 0.55, grain: 0.25 } },
  { id: 'green400', name: 'Green 400', cat: 'film', p: { warmth: -0.1, tint: -0.08, contrast: 0.1, saturation: 0.05, shadowTint: [0.45, 0.52, 0.52], highTint: [0.53, 0.55, 0.48], split: 0.55, grain: 0.2 } },
  { id: 'instant', name: 'Instant', cat: 'film', p: { exposure: 0.06, fade: 0.45, contrast: -0.1, warmth: 0.12, shadowTint: [0.47, 0.5, 0.55], highTint: [0.57, 0.54, 0.45], split: 0.6, vignette: 0.25 } },
  { id: 'expired', name: 'Expired', cat: 'film', p: { warmth: 0.35, tint: 0.15, fade: 0.5, saturation: -0.25, curve: 0.2, grain: 0.45, vignette: 0.35, shadowTint: [0.55, 0.47, 0.5], split: 0.6 } },
  { id: 'cinema', name: 'Cinema', cat: 'film', p: { contrast: 0.2, saturation: -0.1, curve: 0.25, shadowTint: [0.44, 0.52, 0.56], highTint: [0.58, 0.52, 0.44], split: 0.8, vignette: 0.3 } },
  { id: 'golden', name: 'Golden', cat: 'warm', p: { warmth: 0.5, saturation: 0.15, contrast: 0.15, highTint: [0.58, 0.52, 0.42], split: 0.5, vignette: 0.25 } },
  { id: 'cocoa', name: 'Cocoa', cat: 'warm', p: { warmth: 0.3, contrast: 0.1, saturation: -0.15, fade: 0.25, shadowTint: [0.54, 0.5, 0.46], split: 0.5 } },
  { id: 'sunset', name: 'Sunset', cat: 'warm', p: { warmth: 0.45, tint: 0.15, saturation: 0.1, shadowTint: [0.52, 0.46, 0.56], highTint: [0.6, 0.5, 0.42], split: 0.7 } },
  { id: 'amber', name: 'Amber', cat: 'warm', p: { warmth: 0.55, tint: 0.05, contrast: 0.1, highTint: [0.6, 0.52, 0.42], split: 0.5 } },
  { id: 'terracotta', name: 'Terracotta', cat: 'warm', p: { warmth: 0.4, tint: 0.1, saturation: -0.05, fade: 0.2, shadowTint: [0.54, 0.47, 0.45], split: 0.5 } },
  { id: 'summer', name: 'Summer', cat: 'warm', p: { exposure: 0.1, warmth: 0.35, vibrance: 0.3, contrast: 0.05 } },
  { id: 'caramel', name: 'Caramel', cat: 'warm', p: { warmth: 0.45, saturation: -0.1, fade: 0.25, curve: 0.1, shadowTint: [0.53, 0.5, 0.45], split: 0.45 } },
  { id: 'coast', name: 'Coast', cat: 'cool', p: { exposure: 0.05, contrast: 0.08, warmth: -0.35, saturation: 0.05, shadowTint: [0.45, 0.5, 0.56], split: 0.5 } },
  { id: 'azure', name: 'Azure', cat: 'cool', p: { warmth: -0.25, contrast: 0.12, vibrance: 0.25, shadowTint: [0.46, 0.5, 0.55], split: 0.4 } },
  { id: 'arctic', name: 'Arctic', cat: 'cool', p: { warmth: -0.5, exposure: 0.08, saturation: -0.1, highTint: [0.48, 0.5, 0.56], split: 0.4 } },
  { id: 'mist', name: 'Mist', cat: 'cool', p: { warmth: -0.2, fade: 0.35, contrast: -0.15, saturation: -0.2, exposure: 0.08 } },
  { id: 'ocean', name: 'Ocean', cat: 'cool', p: { warmth: -0.3, tint: -0.1, vibrance: 0.25, contrast: 0.1, shadowTint: [0.44, 0.5, 0.56], split: 0.5 } },
  { id: 'mint', name: 'Mint', cat: 'cool', p: { tint: -0.25, warmth: -0.1, exposure: 0.06, fade: 0.15, highTint: [0.49, 0.54, 0.51], split: 0.4 } },
  { id: 'velvet', name: 'Velvet', cat: 'mood', p: { contrast: 0.25, curve: 0.2, saturation: 0.12, vignette: 0.3, shadowTint: [0.52, 0.46, 0.52], split: 0.35 } },
  { id: 'dusk', name: 'Dusk', cat: 'mood', p: { exposure: -0.1, warmth: -0.15, tint: 0.15, contrast: 0.15, shadowTint: [0.5, 0.45, 0.58], split: 0.6, vignette: 0.35 } },
  { id: 'moody', name: 'Moody', cat: 'mood', p: { exposure: -0.12, contrast: 0.25, saturation: -0.25, curve: 0.3, vignette: 0.45, shadowTint: [0.47, 0.5, 0.53], split: 0.4 } },
  { id: 'drama', name: 'Drama', cat: 'mood', p: { contrast: 0.4, curve: 0.35, saturation: 0.1, vignette: 0.5 } },
  { id: 'teal', name: 'Teal', cat: 'mood', p: { contrast: 0.15, saturation: 0.1, shadowTint: [0.42, 0.52, 0.56], highTint: [0.6, 0.52, 0.42], split: 0.9 } },
  { id: 'faded', name: 'Faded', cat: 'mood', p: { fade: 0.7, contrast: -0.25, saturation: -0.35 } },
  { id: 'night', name: 'Night', cat: 'mood', p: { exposure: -0.05, warmth: -0.35, tint: 0.1, contrast: 0.2, shadowTint: [0.45, 0.47, 0.58], split: 0.6, grain: 0.2 } },
  { id: 'mono', name: 'Mono', cat: 'bw', p: { mono: 1, contrast: 0.2, curve: 0.2 } },
  { id: 'noir', name: 'Noir', cat: 'bw', p: { mono: 1, exposure: -0.08, contrast: 0.5, curve: 0.45, vignette: 0.55, grain: 0.3 } },
  { id: 'silver', name: 'Silver', cat: 'bw', p: { mono: 1, exposure: 0.08, contrast: 0.1, fade: 0.2 } },
  { id: 'ink', name: 'Ink', cat: 'bw', p: { mono: 1, contrast: 0.6, curve: 0.5, exposure: -0.05 } },
  { id: 'highkey', name: 'High key', cat: 'bw', p: { mono: 1, exposure: 0.25, contrast: -0.1, fade: 0.1 } },
  { id: 'sepia', name: 'Sepia', cat: 'bw', p: { mono: 1, contrast: 0.05, shadowTint: [0.53, 0.49, 0.45], highTint: [0.56, 0.52, 0.45], split: 0.6 } },
  { id: 'selenium', name: 'Selenium', cat: 'bw', p: { mono: 1, contrast: 0.15, shadowTint: [0.48, 0.48, 0.54], highTint: [0.52, 0.5, 0.5], split: 0.5 } },
  // Film stocks, cinema grades and aesthetic looks, as colour tables (our own recipes).
  {
    id: 'soft400', name: 'Soft 400', cat: 'film', p: { grain: 0.18 },
    lut: [{ curve: [[0, 0.035], [0.25, 0.245], [0.5, 0.515], [0.75, 0.775], [1, 0.97]] }, { warm: 0.35 },
      { hue: [[115, 60, -12, 0.72, 0], [30, 35, 0, 0.95, 0.015], [215, 50, 0, 0.82, 0]] },
      { split: [[0.47, 0.5, 0.53], [0.56, 0.52, 0.46], 0.45] }],
  },
  {
    id: 'vivid100', name: 'Vivid 100', cat: 'film', p: { grain: 0.1 },
    lut: [{ curve: [[0, 0], [0.25, 0.2], [0.5, 0.5], [0.75, 0.81], [1, 1]] }, { sat: 1.22 },
      { hue: [[0, 35, 0, 1.12, -0.01], [215, 45, -6, 1.18, -0.02], [28, 25, 0, 0.92, 0]] }],
  },
  {
    id: 'green200', name: 'Green 200', cat: 'film', p: { grain: 0.22 },
    lut: [{ curve: [[0, 0.02], [0.25, 0.23], [0.5, 0.51], [0.75, 0.79], [1, 0.98]] }, { sat: 0.94 },
      { hue: [[120, 55, 10, 1.08, 0], [300, 50, 0, 0.9, 0]] }, { split: [[0.45, 0.53, 0.49], [0.53, 0.49, 0.52], 0.6] }],
  },
  {
    id: 'chrome64', name: 'Chrome 64', cat: 'film', p: { grain: 0.12, vignette: 0.15 },
    lut: [{ curve: [[0, 0], [0.22, 0.17], [0.5, 0.5], [0.78, 0.84], [1, 0.99]] },
      { hue: [[0, 30, 0, 1.25, -0.02], [55, 25, -8, 1.1, 0], [220, 45, 0, 1.25, -0.05], [120, 45, -15, 0.88, 0]] }, { warm: 0.15 }],
  },
  {
    id: 'velvet50', name: 'Velvet 50', cat: 'film', p: { grain: 0.06 },
    lut: [{ curve: [[0, 0], [0.25, 0.21], [0.5, 0.5], [0.75, 0.8], [1, 1]] }, { sat: 1.3 },
      { hue: [[120, 50, 5, 1.25, -0.02], [210, 50, 0, 1.25, -0.03], [25, 25, 0, 0.82, 0]] }],
  },
  {
    id: 'instant600', name: 'Instant 600', cat: 'film', p: { vignette: 0.22, grain: 0.15 },
    lut: [{ fade: 0.9 }, { curve: [[0, 0.02], [0.5, 0.53], [1, 0.96]] }, { warm: 0.45 }, { sat: 0.86 },
      { hue: [[115, 55, -10, 0.85, 0]] }, { split: [[0.46, 0.51, 0.53], [0.57, 0.53, 0.45], 0.55] }],
  },
  {
    id: 'tungsten', name: 'Tungsten 800', cat: 'cinema', p: { halation: 0.55, grain: 0.25 },
    lut: [{ warm: -1.4 }, { curve: [[0, 0.03], [0.3, 0.26], [0.6, 0.62], [1, 0.98]] },
      { hue: [[0, 30, 4, 1.2, 0]] }, { split: [[0.46, 0.5, 0.55], [0.58, 0.51, 0.43], 0.45] }],
  },
  {
    id: 'tealorange', name: 'Teal & orange', cat: 'cinema', p: { vignette: 0.2 },
    lut: [{ curve: [[0, 0], [0.25, 0.21], [0.5, 0.5], [0.75, 0.8], [1, 1]] },
      { hue: [[200, 70, -12, 1.1, 0], [140, 55, 40, 0.8, -0.02], [30, 40, -3, 1.1, 0]] },
      { split: [[0.44, 0.52, 0.56], [0.57, 0.51, 0.45], 0.7] }],
  },
  {
    id: 'bleach', name: 'Bleach bypass', cat: 'cinema', p: { grain: 0.15 },
    lut: [{ sat: 0.45 }, { curve: [[0, 0], [0.2, 0.12], [0.5, 0.5], [0.8, 0.9], [1, 1]] }, { warm: -0.2 }],
  },
  {
    id: 'moonlight', name: 'Moonlight', cat: 'cinema', p: { vignette: 0.3 },
    lut: [{ warm: -1.6 }, { sat: 0.6 }, { curve: [[0, 0], [0.3, 0.22], [0.6, 0.58], [1, 0.95]] }, { split: [[0.45, 0.47, 0.57], [0.5, 0.51, 0.53], 0.6] }],
  },
  {
    id: 'goldenhour', name: 'Golden hour', cat: 'cinema',
    lut: [{ warm: 1.1 }, { curve: [[0, 0.01], [0.3, 0.28], [0.7, 0.74], [1, 0.99]] }, { sat: 1.08 }, { split: [[0.52, 0.48, 0.51], [0.6, 0.53, 0.4], 0.6] }],
  },
  {
    id: 'nordic', name: 'Nordic', cat: 'cinema',
    lut: [{ fade: 0.6 }, { warm: -0.5 }, { sat: 0.72 }, { hue: [[210, 50, 0, 0.85, 0.02]] }, { curve: [[0, 0.02], [0.5, 0.52], [1, 0.97]] }],
  },
  {
    id: 'pastel', name: 'Pastel', cat: 'aesthetic',
    lut: [{ fade: 1 }, { curve: [[0, 0.09], [0.5, 0.56], [1, 0.95]] }, { sat: 0.8 }, { split: [[0.5, 0.49, 0.53], [0.55, 0.49, 0.52], 0.6] }],
  },
  {
    id: 'sakura', name: 'Sakura', cat: 'aesthetic',
    lut: [{ curve: [[0, 0.03], [0.5, 0.54], [1, 0.98]] }, { sat: 0.92 }, { hue: [[340, 40, 0, 1.15, 0.01]] }, { split: [[0.5, 0.48, 0.52], [0.56, 0.48, 0.53], 0.65] }],
  },
  {
    id: 'crossproc', name: 'Cross process', cat: 'aesthetic', p: { vignette: 0.25 },
    lut: [{ r: [[0, 0], [0.25, 0.18], [0.75, 0.86], [1, 1]] }, { g: [[0, 0.02], [0.5, 0.56], [1, 1]] }, { b: [[0, 0.14], [0.5, 0.44], [1, 0.8]] }, { sat: 1.1 }],
  },
  {
    id: 'infrared', name: 'Infrared', cat: 'aesthetic',
    lut: [{ hue: [[115, 70, 195, 1.3, 0.05], [65, 30, -25, 1.1, 0], [200, 45, -12, 1.15, 0]] }, { curve: [[0, 0], [0.5, 0.52], [1, 1]] }, { sat: 1.08 }],
  },
  {
    id: 'gelatin', name: 'Silver gelatin', cat: 'bw', p: { grain: 0.2 },
    lut: [{ mono: [0.5, 0.4, 0.1] }, { curve: [[0, 0.02], [0.25, 0.19], [0.5, 0.5], [0.75, 0.82], [1, 0.98]] }, { split: [[0.49, 0.5, 0.52], [0.53, 0.51, 0.48], 0.4] }],
  },
  { id: 'redpop', name: 'Red', cat: 'pop', p: { isolate: [0, 0.07], contrast: 0.1 } },
  { id: 'pinkpop', name: 'Pink', cat: 'pop', p: { isolate: [0.92, 0.07], contrast: 0.1 } },
  { id: 'orangepop', name: 'Orange', cat: 'pop', p: { isolate: [0.07, 0.05], contrast: 0.1 } },
  { id: 'yellowpop', name: 'Yellow', cat: 'pop', p: { isolate: [0.15, 0.06], contrast: 0.1 } },
  { id: 'greenpop', name: 'Green', cat: 'pop', p: { isolate: [0.33, 0.1], contrast: 0.1 } },
  { id: 'bluepop', name: 'Blue', cat: 'pop', p: { isolate: [0.6, 0.09], contrast: 0.1 } },
];

export const LIP_COLORS = [
  { id: 'nude', name: 'Nude', hex: '#b9786b' },
  { id: 'petal', name: 'Petal', hex: '#d98a8e' },
  { id: 'rose', name: 'Rose', hex: '#c4566f' },
  { id: 'coral', name: 'Coral', hex: '#e3654f' },
  { id: 'peach', name: 'Peach', hex: '#e98a6a' },
  { id: 'red', name: 'Red', hex: '#b51f2d' },
  { id: 'cherry', name: 'Cherry', hex: '#8f1530' },
  { id: 'berry', name: 'Berry', hex: '#8a2c4b' },
  { id: 'plum', name: 'Plum', hex: '#6b2b4a' },
  { id: 'mauve', name: 'Mauve', hex: '#9b5f78' },
  { id: 'brick', name: 'Brick', hex: '#9c3f2e' },
  { id: 'mocha', name: 'Mocha', hex: '#7a4a3c' },
];

// AirBrush's lipstick types (evidence §8: Matte, Satin, Moist, Highlight, Pearl, Metallight,
// BittenLips, Diamond), plus Shimmer. The order is the shader's finish index.
export const LIP_FINISHES = [
  { id: 'matte', name: 'Matte' },
  { id: 'satin', name: 'Satin' },
  { id: 'gloss', name: 'Gloss' },
  { id: 'shimmer', name: 'Shimmer' },
  { id: 'highlight', name: 'Highlight' },
  { id: 'pearl', name: 'Pearl' },
  { id: 'metallic', name: 'Metallic' },
  { id: 'gradient', name: 'Gradient' },
  { id: 'diamond', name: 'Diamond' },
];

export const SHADOW_COLORS = [
  { id: 'champagne', name: 'Champagne', hex: '#d9b48f' },
  { id: 'bronze', name: 'Bronze', hex: '#9a6236' },
  { id: 'rosegold', name: 'Rose gold', hex: '#c98a7a' },
  { id: 'mauve', name: 'Mauve', hex: '#8e5f78' },
  { id: 'plum', name: 'Plum', hex: '#5e2f4f' },
  { id: 'smoke', name: 'Smoke', hex: '#4a4a52' },
  { id: 'espresso', name: 'Espresso', hex: '#4b3428' },
  { id: 'emerald', name: 'Emerald', hex: '#2f6b55' },
  { id: 'navy', name: 'Navy', hex: '#2b3d6b' },
  { id: 'gold', name: 'Gold', hex: '#c9a14a' },
];

export const LINER_COLORS = [
  { id: 'black', name: 'Black', hex: '#141114' },
  { id: 'brown', name: 'Brown', hex: '#3d2a20' },
  { id: 'navy', name: 'Navy', hex: '#1d2a52' },
  { id: 'plum', name: 'Plum', hex: '#3e1b33' },
  { id: 'emerald', name: 'Emerald', hex: '#163f33' },
];

export const LINER_STYLES = [
  { id: 'natural', name: 'Natural' },
  { id: 'classic', name: 'Classic' },
  { id: 'wing', name: 'Wing' },
  { id: 'smoky', name: 'Smoky' },
];

export const LASH_STYLES = [
  { id: 'natural', name: 'Natural' },
  { id: 'volume', name: 'Volume' },
  { id: 'dramatic', name: 'Dramatic' },
];

export const BLUSH_COLORS = [
  { id: 'peach', name: 'Peach', hex: '#f39b7f' },
  { id: 'pink', name: 'Pink', hex: '#ef7f9d' },
  { id: 'rose', name: 'Rose', hex: '#d1687c' },
  { id: 'coral', name: 'Coral', hex: '#f0785f' },
  { id: 'berry', name: 'Berry', hex: '#b04a6a' },
  { id: 'bronze', name: 'Bronze', hex: '#b8724f' },
];

export const BROW_COLORS = [
  { id: 'soft', name: 'Soft brown', hex: '#5b4034' },
  { id: 'espresso', name: 'Espresso', hex: '#2f2420' },
  { id: 'taupe', name: 'Taupe', hex: '#77634f' },
  { id: 'auburn', name: 'Auburn', hex: '#6b3324' },
  { id: 'black', name: 'Soft black', hex: '#1f1a1a' },
];

export const IRIS_COLORS = [
  { id: 'hazel', name: 'Hazel', hex: '#8a6a3a' },
  { id: 'green', name: 'Green', hex: '#4f8a5b' },
  { id: 'blue', name: 'Blue', hex: '#4a7fb8' },
  { id: 'grey', name: 'Grey', hex: '#8b97a3' },
  { id: 'violet', name: 'Violet', hex: '#7b5aa6' },
  { id: 'amber', name: 'Amber', hex: '#b07a2a' },
];

// Hair colours as dyed hair looks in photos: each a ramp from its shadow (darker, warmer and richer
// than the shade) through the shade (hex) to its highlight (paler and less coloured). The natural
// shades are anchored on hair measured in photos (evidence §16): black, dark brown, light brown,
// copper and platinum; the others follow the same pattern.
export const HAIR_COLORS = [
  { id: 'black', name: 'Jet black', hex: '#15161a', dark: '#050608', light: '#4c5058' },
  { id: 'espresso', name: 'Espresso', hex: '#2f1d17', dark: '#120705', light: '#6e5a52' },
  { id: 'chocolate', name: 'Chocolate', hex: '#48291a', dark: '#1a0b04', light: '#93694f' },
  { id: 'chestnut', name: 'Chestnut', hex: '#6a3a20', dark: '#250d05', light: '#b88058' },
  { id: 'auburn', name: 'Auburn', hex: '#74291b', dark: '#2a0906', light: '#c26e55' },
  { id: 'burgundy', name: 'Burgundy', hex: '#5e1427', dark: '#1e0509', light: '#a95168' },
  { id: 'copper', name: 'Copper', hex: '#9a4a22', dark: '#3a1205', light: '#e09a66' },
  { id: 'strawberry', name: 'Strawberry', hex: '#b2765a', dark: '#4a2216', light: '#ecc4a6' },
  { id: 'honey', name: 'Honey', hex: '#9a6c3a', dark: '#3e2410', light: '#e2bf88' },
  { id: 'golden', name: 'Golden', hex: '#c4a06a', dark: '#5e4220', light: '#f2e0b6' },
  { id: 'ash', name: 'Ash blonde', hex: '#a49a88', dark: '#4e4840', light: '#e0d9cb' },
  { id: 'platinum', name: 'Platinum', hex: '#d6d2c8', dark: '#887c72', light: '#f4f2ec' },
  { id: 'silver', name: 'Silver', hex: '#a7abb1', dark: '#55595f', light: '#e6e8eb' },
  { id: 'rose', name: 'Rose', hex: '#cf86a0', dark: '#5a2636', light: '#f7d2de' },
  { id: 'lilac', name: 'Lilac', hex: '#9d88c6', dark: '#34264c', light: '#e2d9f4' },
  { id: 'teal', name: 'Teal', hex: '#2a7f88', dark: '#062428', light: '#9ad6d6' },
  { id: 'midnight', name: 'Midnight', hex: '#1d2b4c', dark: '#05080f', light: '#6c80ad' },
];

// Age › Hair › the shade grey hair turns: a tint and how much lighter or darker than silver. The
// photo's own light tints it as well (main.js sceneTint), so Ivory is only a little yellow: more,
// and mixed with brown strands it turns khaki.
export const AGE_GREYS = [
  { id: 'silver', name: 'Silver', hex: '#b9bdc3', tint: [0.97, 0.99, 1.02], lift: 0 },
  { id: 'white', name: 'White', hex: '#eceeef', tint: [1, 1, 1], lift: 0.16 },
  { id: 'steel', name: 'Steel', hex: '#7f858e', tint: [0.93, 0.97, 1.04], lift: -0.2 },
  { id: 'ivory', name: 'Ivory', hex: '#e8dfc6', tint: [1.03, 1, 0.91], lift: 0.08 },
];

export const BG_SWAPS = [
  { id: 'none', name: 'Original' },
  { id: 'white', name: 'White', hex: '#f7f6f4' },
  { id: 'grey', name: 'Grey', hex: '#8f9195' },
  { id: 'black', name: 'Black', hex: '#111113' },
  { id: 'blush', name: 'Blush', hex: '#f2c9cf' },
  { id: 'sky', name: 'Sky', hex: '#a9cbe8' },
  { id: 'sage', name: 'Sage', hex: '#b8c9a8' },
  { id: 'sunset', name: 'Sunset', hex: '#f6a96b', hex2: '#c9577a' },
  { id: 'dusk', name: 'Dusk', hex: '#2c3e6b', hex2: '#8a5aa6' },
  { id: 'photo', name: 'Your photo' },
];

// A makeup state: lip [colour, amount, finish], blush [colour, amount], shadow [colour, amount,
// shimmer], liner [style, colour, amount], lashes [style, amount], brow [colour, amount],
// contour [contour, highlight], freckles amount. Grouped as AirBrush groups its sets.
export const LOOK_GROUPS = [
  {
    id: 'natural', name: 'Natural', looks: [
      { id: 'bare', name: 'Bare', lip: ['nude', 0.35, 'satin'], blush: ['peach', 0.25], brow: ['soft', 0.2], lashes: ['natural', 0.35] },
      { id: 'fresh', name: 'Fresh', lip: ['petal', 0.4, 'gloss'], blush: ['pink', 0.35], brow: ['soft', 0.25], lashes: ['natural', 0.45], contour: [0, 0.3], freckles: 0.35 },
      { id: 'clean', name: 'Clean girl', lip: ['nude', 0.4, 'gloss'], blush: ['peach', 0.3], brow: ['taupe', 0.3], liner: ['natural', 'brown', 0.4], lashes: ['natural', 0.5], contour: [0.2, 0.35] },
    ],
  },
  {
    id: 'day', name: 'Day', looks: [
      { id: 'petal', name: 'Petal', lip: ['rose', 0.45, 'satin'], blush: ['pink', 0.4], shadow: ['rosegold', 0.35, 0.3], brow: ['soft', 0.25], lashes: ['natural', 0.5] },
      { id: 'sunkissed', name: 'Sunkissed', lip: ['coral', 0.45, 'gloss'], blush: ['bronze', 0.45], shadow: ['bronze', 0.35, 0.4], brow: ['taupe', 0.3], lashes: ['volume', 0.5], contour: [0.35, 0.45], freckles: 0.4 },
      { id: 'office', name: 'Office', lip: ['mauve', 0.45, 'satin'], blush: ['rose', 0.3], shadow: ['champagne', 0.3, 0.1], liner: ['classic', 'brown', 0.5], brow: ['soft', 0.35], lashes: ['natural', 0.55], contour: [0.3, 0.25] },
    ],
  },
  {
    id: 'night', name: 'Night', looks: [
      { id: 'evening', name: 'Evening', lip: ['red', 0.65, 'satin'], blush: ['rose', 0.25], shadow: ['espresso', 0.4, 0.2], liner: ['wing', 'black', 0.75], brow: ['espresso', 0.45], lashes: ['volume', 0.7], contour: [0.45, 0.35] },
      { id: 'smoky', name: 'Smoky', lip: ['mocha', 0.5, 'matte'], blush: ['berry', 0.2], shadow: ['smoke', 0.6, 0.2], liner: ['smoky', 'black', 0.75], brow: ['espresso', 0.4], lashes: ['dramatic', 0.7], contour: [0.5, 0.3] },
      { id: 'berry', name: 'Berry', lip: ['berry', 0.6, 'satin'], blush: ['rose', 0.3], shadow: ['plum', 0.45, 0.35], liner: ['classic', 'plum', 0.6], brow: ['espresso', 0.35], lashes: ['volume', 0.6] },
    ],
  },
  {
    id: 'festive', name: 'Festive', looks: [
      { id: 'gilded', name: 'Gilded', lip: ['cherry', 0.6, 'shimmer'], blush: ['coral', 0.3], shadow: ['gold', 0.55, 0.8], liner: ['wing', 'black', 0.7], brow: ['soft', 0.35], lashes: ['dramatic', 0.65], contour: [0.35, 0.5] },
      { id: 'emerald', name: 'Emerald', lip: ['brick', 0.55, 'satin'], blush: ['peach', 0.3], shadow: ['emerald', 0.5, 0.6], liner: ['classic', 'black', 0.65], brow: ['espresso', 0.35], lashes: ['volume', 0.65] },
      { id: 'midnight', name: 'Midnight', lip: ['plum', 0.6, 'gloss'], blush: ['berry', 0.25], shadow: ['navy', 0.55, 0.7], liner: ['smoky', 'navy', 0.7], brow: ['black', 0.35], lashes: ['dramatic', 0.7], contour: [0.4, 0.4] },
    ],
  },
];

// Skin tone targets (Fair, Light, Medium, Deep as in AirBrush, plus a palette).
export const SKIN_TONES = [
  { id: 'fair', name: 'Fair', hex: '#f1d3c2' }, { id: 'light', name: 'Light', hex: '#e3b99c' }, { id: 'medium', name: 'Medium', hex: '#c69072' },
  { id: 'tan', name: 'Tan', hex: '#a8714f' }, { id: 'deep', name: 'Deep', hex: '#7a4b33' }, { id: 'rich', name: 'Rich', hex: '#5a3424' },
  { id: 'porcelain', name: 'Porcelain', hex: '#f6dfd3' }, { id: 'rosy', name: 'Rosy', hex: '#e8b4a4' }, { id: 'golden', name: 'Golden', hex: '#d9a774' },
  { id: 'olive', name: 'Olive', hex: '#b48c68' }, { id: 'bronze', name: 'Bronze', hex: '#9a6440' }, { id: 'espresso', name: 'Espresso', hex: '#4c2d20' },
];

// Glow Up looks (their mechanism isn't in AirBrush's package, so these are our own).
export const GLOW_TYPES = [{ id: 'tan', name: 'Tan', code: 1 }, { id: 'sunkissed', name: 'Sun-kissed', code: 2 }, { id: 'glass', name: 'Glass skin', code: 3 }];

// Contour styles (Makeup › Contour): weights for the shading maps' contour, highlight, jaw and
// stronger-contour channels.
export const SCULPT_STYLES = [
  { id: 'natural', name: 'Natural', w: [0.75, 0.6, 0.25, 0] },
  { id: 'soft', name: 'Soft', w: [0.45, 0.85, 0.15, 0] },
  { id: 'defined', name: 'Defined', w: [1, 0.7, 0.5, 0.2] },
  { id: 'sharp', name: 'Chiselled', w: [0.85, 0.35, 0.9, 0.85] },
  { id: 'glow', name: 'Glow', w: [0.2, 1, 0, 0] },
];

// Bokeh aperture shapes (the shader's uShape code).
export const BOKEH_SHAPES = [
  { id: 1, name: 'Circle', icon: 'shapeCircle' }, { id: 2, name: 'Hexagon', icon: 'shapeHex' }, { id: 3, name: 'Triangle', icon: 'shapeTri' },
  { id: 4, name: 'Heart', icon: 'shapeHeart' }, { id: 5, name: 'Star', icon: 'shapeStar' },
];

export const GLITTER_COLORS = [
  { id: 'gold', name: 'Gold', hex: '#f3d27a' }, { id: 'silver', name: 'Silver', hex: '#e8eef5' }, { id: 'rosegold', name: 'Rose gold', hex: '#f2b8a2' },
  { id: 'pink', name: 'Pink', hex: '#ff8fc2' }, { id: 'ice', name: 'Ice', hex: '#a9dcff' }, { id: 'emerald', name: 'Emerald', hex: '#5fe0a6' },
  { id: 'ruby', name: 'Ruby', hex: '#ff4d6d' }, { id: 'violet', name: 'Violet', hex: '#b48cff' }, { id: 'rainbow', name: 'Holo', hex: '#000000' },
];

// Sparkle: star glints placed on the photo's own highlights (AirBrush's Sparkle has Size, Quantity,
// Angle and Colour). The shape is the shader's code.
export const SPARKLE_SHAPES = [
  { id: 'star4', name: 'Star', code: 1, icon: 'sp4' }, { id: 'star6', name: 'Six', code: 2, icon: 'sp6' }, { id: 'star8', name: 'Eight', code: 3, icon: 'sp8' },
  { id: 'twinkle', name: 'Twinkle', code: 4, icon: 'spTwinkle' }, { id: 'glow', name: 'Glow', code: 5, icon: 'spGlow' },
];
export const SPARKLE_COLORS = [
  { id: 'white', name: 'White', hex: '#ffffff' }, { id: 'warm', name: 'Warm', hex: '#ffe2a8' }, { id: 'rose', name: 'Rose', hex: '#ffc2dc' },
  { id: 'ice', name: 'Ice', hex: '#c4e6ff' }, { id: 'rainbow', name: 'Holo', hex: '#000000' },
];

// What "Auto" turns on, at full strength. Skin smoothing is deliberately absent: smoothing only
// happens where the person paints it with the Smooth brush. Hollows get a little light, as in
// AirBrush's one-tap preset (CheekFillers with the brow arch and eye sockets), which doesn't smooth
// skin either.
export const AUTO_RECIPE = {
  'eyes.bright': 0.45,
  'eyes.iris': 0.45,
  'eyes.circles': 0.6,
  'teeth.white': 0.65,
  'plump.cheeks': 0.35,
  'plump.temples': 0.25,
  'plump.sockets': 0.25,
  'sculpt.slim': 0.3,
  'sculpt.eyeSize': 0.2,
};

// Hair › Style: each mixes the Care and Volume controls (AirBrush's own hairstyles are generated on
// its server, so these are finishes rather than new cuts).
export const HAIR_STYLE_KEYS = ['shine', 'smooth', 'texture', 'enrich', 'oil', 'volume'];
export const HAIR_STYLES = [
  { id: 'glossy', name: 'Glossy', v: { shine: 0.7, smooth: 0.3, texture: 0.1, enrich: 0.1 } },
  { id: 'sleek', name: 'Sleek', v: { smooth: 0.8, shine: 0.45, volume: -0.35 } },
  { id: 'silky', name: 'Silky', v: { smooth: 0.55, shine: 0.35, oil: 0.2 } },
  { id: 'fluffy', name: 'Fluffy', v: { volume: 0.55, texture: 0.35, smooth: 0.15 } },
  { id: 'defined', name: 'Defined', v: { texture: 0.75, shine: 0.25 } },
  { id: 'rich', name: 'Rich', v: { enrich: 0.7, shine: 0.3, texture: 0.2 } },
  { id: 'soft', name: 'Soft', v: { smooth: 0.45, oil: 0.4, shine: 0.1 } },
  { id: 'bouncy', name: 'Bouncy', v: { volume: 0.35, shine: 0.35, texture: 0.25 } },
];

export function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}
