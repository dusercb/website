// Line icons on a 24 px grid, drawn with the current text colour (stroke set by the .i class).

const FACE = '<path d="M12 3c3.6 0 6.2 2.9 6.2 6.9 0 4.6-3.2 10.1-6.2 10.1S5.8 14.5 5.8 9.9C5.8 5.9 8.4 3 12 3z"/>';
const EYE = '<path d="M2.5 12S6 6.5 12 6.5s9.5 5.5 9.5 5.5-3.5 5.5-9.5 5.5S2.5 12 2.5 12z"/>';
// A four-point sparkle centred on (x, y).
const SPARK = (x, y, r) => {
  const a = +(r * 0.27).toFixed(2), b = +(r * 0.73).toFixed(2);
  return `<path d="M${x} ${y - r}l${a} ${b} ${b} ${a}-${b} ${a}-${a} ${b}-${a}-${b}-${b}-${a} ${b}-${a}z"/>`;
};

const PATHS = {
  // tools
  auto: SPARK(11, 10, 7) + SPARK(18.5, 17.5, 3),
  smooth: '<path d="M12 3.5c3.2 4.1 6 7.3 6 10.6a6 6 0 0 1-12 0c0-3.3 2.8-6.5 6-10.6z"/><path d="M9.5 15a2.5 2.5 0 0 0 2.5 2.5"/>',
  blemish: '<circle cx="12" cy="12" r="8.5" stroke-dasharray="2.6 2.6"/><circle cx="12" cy="12" r="2.6" fill="currentColor" stroke="none"/>',
  eraser: '<path d="M14.5 4.5l5 5L10 19H5l-1.5-1.5a2 2 0 0 1 0-2.8z"/><path d="M8.5 10.5l5 5M10 19h10"/>',
  eyes: EYE + '<circle cx="12" cy="12" r="2.8"/>',
  teeth: '<path d="M8 3.5c-2.3 0-4 1.7-4 4.4 0 3.1 1.3 4.9 2 7.8.5 2.2.9 4.8 2.4 4.8 1.7 0 1.6-4.2 3.6-4.2s1.9 4.2 3.6 4.2c1.5 0 1.9-2.6 2.4-4.8.7-2.9 2-4.7 2-7.8 0-2.7-1.7-4.4-4-4.4-1.9 0-2.6 1-4 1s-2.1-1-4-1z"/>',
  makeup: '<path d="M9 21h6v-7.5H9z"/><path d="M9.8 13.5V8.2L14.2 4v9.5"/>',
  hair: '<path d="M6 20c-1-5 0-9 2-12 2-3 6-4.5 9-3"/><path d="M10 20c-.5-4 .5-7.5 2.5-10s5-3.5 7-3"/><path d="M14 20c0-3 .8-5.5 2.5-7.5"/>',
  reshape: '<path d="M3 12h9.5"/><path d="M9 7.5l4.5 4.5L9 16.5"/><circle cx="18" cy="12" r="3.5"/>',
  relight: '<path d="M9 18h6M10 21h4"/><path d="M12 3a6 6 0 0 0-3.6 10.8c.7.5 1.1 1.3 1.1 2.2h5c0-.9.4-1.7 1.1-2.2A6 6 0 0 0 12 3z"/>',
  background: '<rect x="3" y="4" width="18" height="16" rx="3"/><circle cx="12" cy="10.5" r="2.6"/><path d="M7.5 20c.6-3 2.3-4.6 4.5-4.6s3.9 1.6 4.5 4.6"/>',
  filters: '<circle cx="9" cy="9.5" r="5.5"/><circle cx="15" cy="9.5" r="5.5"/><circle cx="12" cy="14.5" r="5.5"/>',
  adjust: '<path d="M4 7h9M17 7h3M4 17h3M11 17h9"/><circle cx="15" cy="7" r="2"/><circle cx="9" cy="17" r="2"/>',

  // brushes and actions
  brush: '<path d="M19.5 4.5l-8 8"/><path d="M11.5 12.5c-2-.6-4.2.4-4.7 2.8-.4 2-1.4 3.3-2.8 3.9 3.2 1.2 7.1.5 8-2.3.6-1.9.3-3.4-.5-4.4z"/>',
  unbrush: '<circle cx="12" cy="12" r="8.5"/><path d="M8 12h8"/>',
  face: FACE,
  show: EYE + '<circle cx="12" cy="12" r="2.8"/>',
  tap: '<circle cx="12" cy="12" r="7.5"/><circle cx="12" cy="12" r="2.4" fill="currentColor" stroke="none"/><path d="M12 1.5v3M12 19.5v3M1.5 12h3M19.5 12h3"/>',
  find: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="M15.5 15.5L21 21"/>' + SPARK(10.5, 10.5, 3.2),
  reset: '<path d="M4.5 12a7.5 7.5 0 1 0 2.3-5.4"/><path d="M4.5 4.5v4h4"/>',
  none: '<circle cx="12" cy="12" r="8.5"/><path d="M6 18L18 6"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  photo: '<rect x="3" y="5" width="18" height="14" rx="3"/><path d="M3 15l5-5 4 4 3-3 6 6"/>',
  bookmark: '<path d="M6.5 3.5h11v17L12 16.5l-5.5 4z"/>',
  trash: '<path d="M4.5 7h15M9.5 7V4.5h5V7M6.5 7l1 13h9l1-13"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  check: '<path d="M4.5 12.5l4.8 4.8L19.5 7"/>',
  compare: '<rect x="3" y="4" width="18" height="16" rx="3"/><path d="M12 2v20"/><path d="M12 4h6a3 3 0 0 1 3 3v10a3 3 0 0 1-3 3h-6z" fill="currentColor" stroke="none"/>',
  fit: '<path d="M4 9V5h4M20 9V5h-4M4 15v4h4M20 15v4h-4"/>',
  undo: '<path d="M9 5L4 10l5 5"/><path d="M4 10h10a6 6 0 0 1 0 12h-3"/>',
  redo: '<path d="M15 5l5 5-5 5"/><path d="M20 10H10a6 6 0 0 0 0 12h3"/>',
  open: '<rect x="3" y="6" width="14" height="14" rx="3"/><path d="M3 16l4-4 4 4 2-2 4 4"/><path d="M19.5 2.5v6M16.5 5.5h6"/>',

  // smoothing, eyes, teeth
  strength: SPARK(12, 12, 8),
  even: '<circle cx="12" cy="12" r="8.5"/><path d="M12 3.5a8.5 8.5 0 0 1 0 17" fill="currentColor" fill-opacity=".25" stroke="none"/><path d="M12 3.5v17"/>',
  size: '<circle cx="12" cy="12" r="8.5" stroke-dasharray="2.4 2.4"/><circle cx="12" cy="12" r="3.6" fill="currentColor" stroke="none"/>',
  brighten: EYE + '<circle cx="12" cy="12" r="2.6"/>' + '<path d="M12 1.5v2M4.5 4l1.4 1.4M19.5 4l-1.4 1.4"/>',
  circles: '<path d="M3 9.5s3.5-4 9-4 9 4 9 4"/><path d="M5.5 14.5c1.9 1.5 4 2.2 6.5 2.2s4.6-.7 6.5-2.2" stroke-dasharray="2 2.2"/>',

  // reshape
  slim: FACE + '<path d="M1.5 13h2.5M3 11.5L4.5 13 3 14.5M22.5 13H20M21 11.5L19.5 13l1.5 1.5"/>',
  chin: '<path d="M5.5 6c0 7 3.5 13 6.5 13s6.5-6 6.5-13"/><path d="M12 9.5v6M9.5 13l2.5 2.5 2.5-2.5"/>',
  eyeSize: EYE + '<circle cx="12" cy="12" r="2.8"/><path d="M12 1.5v2.5M12 20v2.5"/>',
  nose: '<path d="M12.5 3.5c-.4 4.2-2.3 8.2-4.8 10.6-.4 2.2 1.8 3.4 4.3 3.4s4.7-1.2 4.3-3.4"/><path d="M9.5 17.5c.5.6 1.4 1 2.5 1s2-.4 2.5-1"/>',
  lips: '<path d="M3 12.5c2.5-3 5.3-4.4 7-4.4 1 0 1.5.6 2 .6s1-.6 2-.6c1.7 0 4.5 1.4 7 4.4-2.4 2.8-5.4 4.6-9 4.6s-6.6-1.8-9-4.6z"/><path d="M3 12.5h18"/>',
  push: '<path d="M4 12h12"/><path d="M12 6.5l5.5 5.5-5.5 5.5"/><path d="M20.5 5v14"/>',

  // makeup parts
  lashes: '<path d="M3 14c3-3 6-4.5 9-4.5s6 1.5 9 4.5"/><path d="M6 11.3L4.4 8.6M9 9.9L8.1 7M12 9.5V6.4M15 9.9l.9-2.9M18 11.3l1.6-2.7"/>',
  contour: FACE + '<path d="M7.6 11.5c.7 2.8 2.1 4.8 3.4 5.8"/>',
  highlight: FACE + SPARK(14.5, 9, 3),
  freckles: FACE + '<circle cx="9.5" cy="11.5" r=".6" fill="currentColor"/><circle cx="11" cy="13" r=".6" fill="currentColor"/><circle cx="14.5" cy="11.5" r=".6" fill="currentColor"/><circle cx="13" cy="13" r=".6" fill="currentColor"/>',

  // background and effects
  blur: '<circle cx="12" cy="12" r="8.5" stroke-dasharray="1.6 2.4"/><circle cx="12" cy="12" r="4.5"/>',
  bokeh: '<circle cx="8" cy="9" r="3.6"/><circle cx="16.6" cy="7.6" r="2.6"/><circle cx="14.2" cy="16" r="4.1"/>',
  mono: '<rect x="4" y="4" width="16" height="16" rx="4"/><path d="M5.2 18.8L18.8 5.2A4 4 0 0 1 20 8v8a4 4 0 0 1-4 4H8a4 4 0 0 1-2.8-1.2z" fill="currentColor" stroke="none"/>',
  blurBrush: '<path d="M19.5 4.5l-8 8"/><path d="M11.5 12.5c-2-.6-4.2.4-4.7 2.8-.4 2-1.4 3.3-2.8 3.9 3.2 1.2 7.1.5 8-2.3.6-1.9.3-3.4-.5-4.4z"/><circle cx="17.5" cy="15.5" r="2.6" stroke-dasharray="1.2 1.6"/>',
  keep: '<circle cx="12" cy="8.5" r="3.6"/><path d="M5.5 20c.8-3.6 3.3-5.5 6.5-5.5s5.7 1.9 6.5 5.5"/>',
  glow: '<circle cx="12" cy="12" r="4"/><circle cx="12" cy="12" r="8.5" stroke-dasharray="1 2.6"/>',
  softFocus: '<circle cx="12" cy="12" r="8.5" opacity=".4"/><circle cx="12" cy="12" r="5.5" opacity=".7"/><circle cx="12" cy="12" r="2.5"/>',
  leak: '<rect x="3.5" y="3.5" width="17" height="17" rx="4"/><path d="M3.5 8c4.5 0 8.5 3.8 8.5 8.5M3.5 12.5c2.2 0 4 1.8 4 4"/>',

  // adjust
  brightness: '<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2.2M12 19.3v2.2M2.5 12h2.2M19.3 12h2.2M5.3 5.3l1.6 1.6M17.1 17.1l1.6 1.6M5.3 18.7l1.6-1.6M17.1 6.9l1.6-1.6"/>',
  light: '<rect x="3.5" y="3.5" width="17" height="17" rx="4"/><path d="M6.5 17.5l11-11"/><path d="M7 9.5h4M9 7.5v4M13 15h4"/>',
  contrast: '<circle cx="12" cy="12" r="8.5"/><path d="M12 3.5a8.5 8.5 0 0 1 0 17z" fill="currentColor" stroke="none"/>',
  highlights: '<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12a8.5 8.5 0 0 1 17 0z" fill="currentColor" fill-opacity=".3" stroke="none"/><path d="M3.5 12h17"/>',
  shadows: '<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12a8.5 8.5 0 0 0 17 0z" fill="currentColor" stroke="none"/>',
  ambience: SPARK(12, 12, 5) + '<circle cx="12" cy="12" r="9" stroke-dasharray="1.5 2.8"/>',
  saturation: '<path d="M12 3.5c3.2 4.1 6 7.3 6 10.6a6 6 0 0 1-12 0c0-3.3 2.8-6.5 6-10.6z"/><path d="M12 20.1a6 6 0 0 1-6-6c0-1.2.4-2.4 1-3.6h10c.6 1.2 1 2.4 1 3.6a6 6 0 0 1-6 6z" fill="currentColor" stroke="none"/>',
  vibrance: '<path d="M10 4c2.8 3.6 5.2 6.4 5.2 9.3a5.2 5.2 0 0 1-10.4 0C4.8 10.4 7.2 7.6 10 4z"/>' + SPARK(18.5, 6.5, 3),
  temperature: '<path d="M10 14.5V5a2 2 0 0 1 4 0v9.5a4 4 0 1 1-4 0z"/><path d="M12 9v7.5"/>',
  tint: '<circle cx="9" cy="12" r="5.5"/><circle cx="15" cy="12" r="5.5"/>',
  clarity: '<path d="M12 3l8 9-8 9-8-9z"/><path d="M12 3v18"/>',
  sharpen: '<path d="M12 3.5L21 20H3z"/><path d="M12 10v5"/>',
  dehaze: '<path d="M3.5 9.5h9M3.5 13.5h17M3.5 17.5h11"/><path d="M15.5 9.5a3.5 3.5 0 1 1 5 0"/>',
  fade: '<rect x="3.5" y="3.5" width="17" height="17" rx="4"/><path d="M8 3.5v17M12 3.5v17M16 3.5v17" stroke-dasharray="1.4 2.6"/>',
  grain: [6.5, 12, 17.5].flatMap((x) => [6.5, 12, 17.5].map((y) => `<circle cx="${x + (y === 12 ? 1.2 : 0)}" cy="${y}" r="1.1" fill="currentColor" stroke="none"/>`)).join(''),
  vignette: '<rect x="3.5" y="4.5" width="17" height="15" rx="4"/><ellipse cx="12" cy="12" rx="5" ry="4"/>',
  // tools added with the second round of AirBrush features
  stamp: '<path d="M9 13.5V9.5a3 3 0 1 1 6 0v4"/><path d="M4.5 13.5h15v3.5h-15z"/><path d="M6.5 20.5h11"/>',
  wrinkles: '<path d="M4 7.5c2-1.6 3.4-1.6 5.4 0s3.4 1.6 5.2 0 3.4-1.6 5.4 0"/><path d="M4 12c2-1.6 3.4-1.6 5.4 0s3.4 1.6 5.2 0 3.4-1.6 5.4 0"/><path d="M4 16.5c2-1.6 3.4-1.6 5.4 0s3.4 1.6 5.2 0 3.4-1.6 5.4 0" opacity=".45"/>',
  conceal: '<path d="M6.5 20.5l-3-3 9-9 3 3z"/><path d="M15.5 11.5l3-3a2.1 2.1 0 0 0-3-3l-3 3"/><path d="M8 15l1.5 1.5"/>',
  matte: '<path d="M12 3.5c3 4 5.5 7 5.5 10.2a5.5 5.5 0 0 1-11 0C6.5 10.5 9 7.5 12 3.5z"/><path d="M4 20.5L20 4.5"/>',
  texture: '<circle cx="12" cy="12" r="8.5"/>' + [[8.5, 9], [12.5, 7.5], [15.5, 10.5], [9.5, 13.5], [13.5, 13], [11, 16.5], [15, 16]].map(([x, y]) => `<circle cx="${x}" cy="${y}" r="0.9" fill="currentColor" stroke="none"/>`).join(''),
  details: '<path d="M12 3l8 9-8 9-8-9z"/><path d="M12 3v18M4 12h16"/>',
  skin: '<circle cx="12" cy="12" r="8.5"/><path d="M12 3.5a8.5 8.5 0 0 1 0 17z" fill="currentColor" stroke="none"/>',
  plump: FACE + '<circle cx="8.6" cy="13.3" r="1.7"/><circle cx="15.4" cy="13.3" r="1.7"/>',
  sculpt: FACE + '<path d="M1.5 13h2.5M20 13h2.5M3 11.5L4.5 13 3 14.5M21 11.5L19.5 13l1.5 1.5"/>',
  body: '<circle cx="12" cy="4.6" r="2.1"/><path d="M8 8.6h8l-1.3 6.2H9.3z"/><path d="M9.8 14.8L9 21M14.2 14.8L15 21"/><path d="M8 8.6l-2.5 5M16 8.6l2.5 5"/>',
  crop: '<path d="M6.5 2.5V17.5h15"/><path d="M2.5 6.5h15v15"/>',
  text: '<path d="M5 6.5V4.5h14v2"/><path d="M12 4.5v15"/><path d="M9 19.5h6"/>',

  // options
  forehead: '<path d="M4 16.5a8 8 0 0 1 16 0"/><path d="M8 10h8M7 13h10"/>',
  crows: '<path d="M2.5 12s3-4 7.5-4 7.5 4 7.5 4-3 4-7.5 4-7.5-4-7.5-4z"/><circle cx="10" cy="12" r="2"/><path d="M19.5 8.5l2-1.5M20 12h2M19.5 15.5l2 1.5"/>',
  smileLines: '<path d="M9 4.5c-2 3-2.5 7-1 10"/><path d="M15 4.5c2 3 2.5 7 1 10"/><path d="M8.5 17.5c2 1.5 5 1.5 7 0"/>',
  underEye: '<path d="M3 9.5s3.5-4 9-4 9 4 9 4-3.5 4-9 4-9-4-9-4z"/><path d="M6 16c3 2 9 2 12 0"/><path d="M8 19c2.5 1.2 5.5 1.2 8 0" opacity=".5"/>',
  darkSpots: '<circle cx="12" cy="12" r="8.5"/><circle cx="9" cy="10" r="1.7" fill="currentColor" stroke="none"/><circle cx="15" cy="14.5" r="1.3" fill="currentColor" stroke="none"/>',
  lightSpots: '<circle cx="12" cy="12" r="8.5"/><circle cx="9" cy="10" r="1.9"/><circle cx="15" cy="14.5" r="1.4"/>',
  eyeBags: '<path d="M3 9s3.5-4 9-4 9 4 9 4-3.5 4-9 4-9-4-9-4z"/><circle cx="12" cy="9" r="2"/><path d="M6 15.5c3 2.6 9 2.6 12 0"/>',
  trough: '<path d="M3 9s3.5-4 9-4 9 4 9 4"/><path d="M14.5 12.5c-1.6 2.2-4.2 3.8-7.5 4.5"/>',
  hairOil: '<path d="M5 20c-1-5 0-9 2-12 2-3 6-4.5 9-3"/><path d="M17 11.5c1.4 1.8 2.6 3.3 2.6 4.8a2.6 2.6 0 0 1-5.2 0c0-1.5 1.2-3 2.6-4.8z"/><path d="M3.5 20.5L21 6" opacity=".5"/>',
  whites: EYE + '<circle cx="12" cy="12" r="2.6"/><path d="M12 1.8v2.2M5 4l1.3 1.6M19 4l-1.3 1.6"/>',
  iris: EYE + '<circle cx="12" cy="12" r="3.3" fill="currentColor" stroke="none"/>',
  redeye: EYE + '<circle cx="12" cy="12" r="2.8"/><path d="M3.5 20.5l17-17"/>',
  irisSize: EYE + '<circle cx="12" cy="12" r="2.3"/><path d="M16.5 3.5h4v4M7.5 20.5h-4v-4"/>',
  stains: '<path d="M8 3.5c-2.3 0-4 1.7-4 4.4 0 3.1 1.3 4.9 2 7.8.5 2.2.9 4.8 2.4 4.8 1.7 0 1.6-4.2 3.6-4.2s1.9 4.2 3.6 4.2c1.5 0 1.9-2.6 2.4-4.8.7-2.9 2-4.7 2-7.8 0-2.7-1.7-4.4-4-4.4-1.9 0-2.6 1-4 1s-2.1-1-4-1z"/><circle cx="9.5" cy="9" r="1.2" fill="currentColor" stroke="none"/>',
  align: '<path d="M3.5 12h17"/><path d="M7 8v8M12 6.5v11M17 8v8"/>',
  redness: '<path d="M12 3.5c3 4 5.5 7 5.5 10.2a5.5 5.5 0 0 1-11 0C6.5 10.5 9 7.5 12 3.5z"/><path d="M9.5 14h5"/>',
  temples: '<path d="M5 18.5c-1-6 1-11.5 7-12.5 6 1 8 6.5 7 12.5"/><circle cx="7.6" cy="10" r="1.7"/><circle cx="16.4" cy="10" r="1.7"/>',
  cheekFill: FACE + '<circle cx="8.6" cy="13.3" r="1.8" fill="currentColor" stroke="none" opacity=".5"/><circle cx="15.4" cy="13.3" r="1.8" fill="currentColor" stroke="none" opacity=".5"/>',
  sockets: '<path d="M3 14s3.5-4 9-4 9 4 9 4"/><path d="M5 9.5c2-3 5-4 7-4s5 1 7 4"/>',
  jaw: '<path d="M5 5c0 7.5 3 12.5 7 14 4-1.5 7-6.5 7-14"/><path d="M8.5 15.5c1 1.4 2.2 2.4 3.5 2.9" opacity=".5"/>',
  waist: '<path d="M8 3c1 4 1 6-.6 9S6.6 18 8 21M16 3c-1 4-1 6 .6 9s1 6-.6 9"/><path d="M10 12h4"/>',
  hips: '<path d="M8.5 3c0 4-3.5 7-3.5 11s2 7 3.5 7M15.5 3c0 4 3.5 7 3.5 11s-2 7-3.5 7"/>',
  legs: '<path d="M9 3l-1.2 18M15 3l1.2 18"/><path d="M6 21h3.5M14.5 21H18"/>',
  arms: '<circle cx="12" cy="4.8" r="2"/><path d="M12 7v7"/><path d="M5.5 9.5L12 8.5l6.5 1"/><path d="M5.5 9.5L3.5 17M18.5 9.5l2 7.5"/>',
  shoulders: '<circle cx="12" cy="6" r="2.6"/><path d="M3 16c1-4.2 4-6.5 9-6.5s8 2.3 9 6.5"/>',
  neck: '<circle cx="12" cy="6" r="3.5"/><path d="M10.5 9.5v4M13.5 9.5v4"/><path d="M5 20.5c1-4.2 3.5-6.7 7-6.7s6 2.5 7 6.7"/>',
  head: '<circle cx="12" cy="9" r="5.5"/><path d="M6 21c1-3.5 3-5 6-5s5 1.5 6 5"/><path d="M19 4.5l2-2M21 5V2.5h-2.5"/>',
  posture: '<circle cx="12" cy="4.6" r="2"/><path d="M12 7v13.5"/><path d="M7.5 10h9"/><path d="M9 20.5h6"/>',
  tilt: '<circle cx="12" cy="10" r="4.5"/><path d="M12 14.5v6"/><path d="M4.5 6.5A8.5 8.5 0 0 1 9 3"/><path d="M4.4 3.2v3.4h3.4"/>',
  muscle: '<path d="M5.5 15c0-4.5 2.2-8 5.5-8 1.6 0 2.2 1.1 2.2 2.2s-1.1 2.2-2.2 2.2"/><path d="M5.5 15c2.2 3.3 7.6 4.4 13 1.1-1.1-3.3-3.3-4.4-5.4-4.4"/>',
  freeze: '<path d="M12 3v18M4.2 7.5l15.6 9M19.8 7.5l-15.6 9"/><path d="M9.6 4.6L12 7l2.4-2.4M9.6 19.4L12 17l2.4 2.4"/>',
  stretch: '<path d="M12 3v18"/><path d="M8.5 6.5L12 3l3.5 3.5M8.5 17.5L12 21l3.5-3.5"/><path d="M4.5 10h15M4.5 14h15" stroke-dasharray="2 2"/>',
  shapeCircle: '<circle cx="12" cy="12" r="7.5"/>',
  shapeHex: '<path d="M12 4.2l7 4v7.6l-7 4-7-4V8.2z"/>',
  shapeTri: '<path d="M12 4.5l8 14H4z"/>',
  shapeHeart: '<path d="M12 19.5s-7.5-4.6-7.5-10A4 4 0 0 1 12 7a4 4 0 0 1 7.5 2.5c0 5.4-7.5 10-7.5 10z"/>',
  shapeStar: '<path d="M12 3.5l2.6 5.6 6 .7-4.5 4.1 1.2 6-5.3-3-5.3 3 1.2-6-4.5-4.1 6-.7z"/>',
  edge: '<rect x="4.5" y="4.5" width="15" height="15" rx="3" stroke-dasharray="2.4 2.4"/><rect x="8.5" y="8.5" width="7" height="7" rx="1.5"/>',
  soften: '<circle cx="12" cy="12" r="8" stroke-dasharray="1.5 2.5"/><circle cx="12" cy="12" r="4"/>',
  dropShadow: '<circle cx="10" cy="9" r="4.5"/><ellipse cx="13.5" cy="18.5" rx="6.5" ry="2" fill="currentColor" stroke="none" opacity=".45"/>',
  blend: '<circle cx="9" cy="12" r="5.5"/><circle cx="15" cy="12" r="5.5"/><path d="M12 7.5v9" opacity=".5"/>',
  addPerson: '<circle cx="10" cy="8" r="3.5"/><path d="M3.5 20c.8-4 3.4-6 6.5-6s5.7 2 6.5 6"/><path d="M19 6.5v6M16 9.5h6"/>',
  person: '<circle cx="12" cy="8" r="3.5"/><path d="M5.5 20c.8-4 3.4-6 6.5-6s5.7 2 6.5 6"/>',
  flip: '<path d="M12 3v18" stroke-dasharray="2 2"/><path d="M9 7L4 17h5zM15 7l5 10h-5z"/>',
  flipV: '<path d="M3 12h18" stroke-dasharray="2 2"/><path d="M7 9l10-5v5zM7 15l10 5v-5z"/>',
  rotate: '<path d="M20 12a8 8 0 1 1-2.3-5.7"/><path d="M20 4v4.5h-4.5"/>',
  straighten: '<path d="M3.5 16.5L20.5 7.5"/><path d="M3 12h18" stroke-dasharray="2 2"/>',
  persV: '<path d="M8 4.5h8l3 15H5z"/>',
  persH: '<path d="M4.5 8v8l15 3.5v-15z"/>',
  lens: '<path d="M4 6c5-2 11-2 16 0v12c-5 2-11 2-16 0z"/><path d="M8 9c2.6-.6 5.4-.6 8 0" opacity=".5"/>',
  edit: '<path d="M4 20l1-4.5L15.5 5l3.5 3.5L8.5 19z"/><path d="M13.5 7l3.5 3.5"/>',
  angle: '<path d="M4 19.5h16"/><path d="M4 19.5L16 7.5"/><path d="M11 19.5a7 7 0 0 0-2-5"/>',
  tPlain: '<path d="M6 6h12M12 6v13"/>',
  tOutline: '<path d="M6 5h12v3h-4.5v11h-3V8H6z"/>',
  tShadow: '<path d="M6 6h12M12 6v13"/><path d="M14 9h6M17 9v12" opacity=".4"/>',
  tLabel: '<rect x="3" y="6" width="18" height="12" rx="4" fill="currentColor" stroke="none" opacity=".25"/><path d="M8 9.5h8M12 9.5v6"/>',
  tNeon: '<path d="M6 6h12M12 6v13"/><path d="M4 4h16v17H4z" opacity=".3"/>',
  prism: '<path d="M12 4l7 13H5z"/><path d="M1.5 12.5l7-1"/><path d="M15.5 10.5l7-2M15.5 12l7 .5M15.5 13.5l6.5 3" opacity=".6"/>',
  glitter: SPARK(10, 10, 6) + SPARK(18, 6, 2.5) + SPARK(17, 17.5, 3),
  denoise: '<path d="M3.5 9c1.5-2.5 3-2.5 4.3 0s2.8 2.5 4.2 0 2.8-2.5 4.2 0 2.8 2.5 4.3 0" opacity=".45"/><path d="M3.5 15.5h17"/>',
  source: '<circle cx="12" cy="12" r="6.5"/><path d="M12 2v5M12 17v5M2 12h5M17 12h5"/>',
};

// Sculpt's controls: the feature, with arrows for the way + moves it.
const NOSE = '<path d="M12.5 3.5c-.4 4.2-2.3 8.2-4.8 10.6-.4 2.2 1.8 3.4 4.3 3.4s4.7-1.2 4.3-3.4"/><path d="M9.5 17.5c.5.6 1.4 1 2.5 1s2-.4 2.5-1"/>';
const LIPS = '<path d="M4.5 12.5c2-2.4 4.2-3.5 5.6-3.5.8 0 1.2.5 1.9.5s1.1-.5 1.9-.5c1.4 0 3.6 1.1 5.6 3.5-1.9 2.2-4.3 3.6-7.5 3.6s-5.6-1.4-7.5-3.6z"/><path d="M4.5 12.5h15"/>';
const SMALL_EYE = '<path d="M5 12s3-4.5 7-4.5 7 4.5 7 4.5-3 4.5-7 4.5S5 12 5 12z"/><circle cx="12" cy="12" r="2"/>';
const BROW = '<path d="M3.5 14.5c2.7-3.8 9.6-5.4 17-2.8l-.6 1.7c-6.4-1.9-12.4-.9-15.1 2.2z"/>';
const JAW = '<path d="M5 5c0 7.5 3 12.5 7 14 4-1.5 7-6.5 7-14"/>';
const OUT_H = '<path d="M1.5 12h3M3 10.5L1.5 12 3 13.5M22.5 12h-3M21 10.5l1.5 1.5-1.5 1.5"/>';
const IN_H = '<path d="M1.5 12h3M3 10.5L4.5 12 3 13.5M22.5 12h-3M21 10.5L19.5 12l1.5 1.5"/>';
const UP = (x, y, l = 4) => `<path d="M${x} ${y}v-${l}M${x - 1.4} ${y - l + 1.4}l1.4-1.4 1.4 1.4"/>`;
const DOWN = (x, y, l = 4) => `<path d="M${x} ${y}v${l}M${x - 1.4} ${y + l - 1.4}l1.4 1.4 1.4-1.4"/>`;
const VERT = (x, y0, y1) => `<path d="M${x} ${y0}V${y1}M${x - 1.4} ${y0 + 1.4}l1.4-1.4 1.4 1.4M${x - 1.4} ${y1 - 1.4}l1.4 1.4 1.4-1.4"/>`;
const CORNERS = '<path d="M1.5 1.5l3 3M1.5 1.5h2.6M1.5 1.5v2.6M22.5 22.5l-3-3M22.5 22.5h-2.6M22.5 22.5v-2.6"/>';
const SPIN = '<path d="M17.5 4.2a8.5 8.5 0 0 1 2.3 4.6"/><path d="M20.3 6.2l-.5 2.6-2.4-1.2"/>';
Object.assign(PATHS, {
  'sc-turn': FACE + '<path d="M5 21.4c4.3 1.4 9.7 1.4 14 0"/><path d="M16.8 19.7l2.2 1.7-2.4 1.1"/>',
  'sc-nod': FACE + '<path d="M21.4 5c1.4 4.3 1.4 9.7 0 14"/><path d="M19.7 7.2l1.7-2.2 1.1 2.4"/>',
  'sc-headSize': '<circle cx="12" cy="10" r="5.5"/><path d="M6 22c1-3.5 3-5 6-5s5 1.5 6 5"/>' + CORNERS,
  'sc-width': FACE + OUT_H,
  'sc-slim': FACE + IN_H,
  'sc-length': FACE + VERT(21.5, 3, 20),
  'sc-size': FACE + CORNERS,
  'sc-forehead': '<path d="M4 16.5a8 8 0 0 1 16 0"/><path d="M8 10h8M7 13h10"/>' + UP(12, 6.5, 4),
  'sc-hairline': FACE + '<path d="M7.3 7.6c3-1.4 6.4-1.4 9.4 0" stroke-dasharray="2 1.5"/>' + VERT(21.5, 3, 11),
  'sc-temples': '<path d="M5 18.5c-1-6 1-11.5 7-12.5 6 1 8 6.5 7 12.5"/><circle cx="7.6" cy="10" r="1.7"/><circle cx="16.4" cy="10" r="1.7"/>',
  'sc-cheekbones': FACE + '<path d="M6.6 11.4c1 .9 2.3 1.2 3.4 1M17.4 11.4c-1 .9-2.3 1.2-3.4 1"/>' + OUT_H,
  'sc-midface': FACE + VERT(12, 8.2, 15),
  'sc-philtrum': FACE + VERT(12, 11.5, 16.5),
  'sc-lift': FACE + UP(8, 17.5, 5) + UP(16, 17.5, 5),
  'sc-lowerFace': FACE + '<path d="M8.5 15h7" stroke-dasharray="1.6 1.4"/>' + DOWN(21.5, 15, 6),
  'sc-top': '<path d="M5 21c0-4 1.2-7 3.2-8.6M19 21c0-4-1.2-7-3.2-8.6"/><path d="M6.5 12.5C6.8 8.6 9 6.5 12 6.5s5.2 2.1 5.5 6" stroke-dasharray="2 1.5"/>' + UP(12, 5.5, 4),
  'sc-jawLength': JAW + DOWN(4, 13, 6) + DOWN(20, 13, 6),
  'sc-jawShape': '<path d="M5 5c0 6 2.2 11 7 14.5C16.8 16 19 11 19 5" stroke-dasharray="2 1.6"/><path d="M8 18.5l4 3 4-3"/>',
  'sc-noseRoot': NOSE + '<path d="M5 6.5h3.2M6.8 5.1L8.2 6.5 6.8 7.9M19 6.5h-3.2M17.2 5.1l-1.4 1.4 1.4 1.4"/>',
  'sc-eyeTail': '<path d="M2.5 13s3.2-4.6 7.4-4.6S16.5 13 16.5 13s-2.4 4-6.6 4S2.5 13 2.5 13z"/>' + UP(20.5, 12, 6),
  'sc-chin': '<path d="M5.5 6c0 7 3.5 13 6.5 13s6.5-6 6.5-13"/><path d="M12 9.5v6M9.5 13l2.5 2.5 2.5-2.5"/>',
  'sc-chinWidth': '<path d="M5.5 5c0 7 3.5 13 6.5 13s6.5-6 6.5-13"/><path d="M8.5 21.5H3.5M5 20l-1.5 1.5L5 23M15.5 21.5h5M19 20l1.5 1.5L19 23"/>',
  'sc-jawAngle': JAW + '<path d="M4.5 14H1.5M2.8 12.7L1.5 14l1.3 1.3M19.5 14h3M21.2 12.7l1.3 1.3-1.3 1.3"/>',
  'sc-jawline': JAW + '<path d="M8.5 15.5c1 1.4 2.2 2.4 3.5 2.9" opacity=".5"/>' + UP(4.5, 22, 4) + UP(19.5, 22, 4),
  'sc-eyeSize': PATHS.eyeSize,
  'sc-eyeHeight': SMALL_EYE + VERT(12, 1.5, 22.5),
  'sc-eyeWidth': SMALL_EYE + OUT_H,
  'sc-eyeDistance': '<path d="M2.5 13s1.5-2.5 4-2.5 4 2.5 4 2.5-1.5 2.5-4 2.5-4-2.5-4-2.5zM13.5 13s1.5-2.5 4-2.5 4 2.5 4 2.5-1.5 2.5-4 2.5-4-2.5-4-2.5z"/><path d="M8 6.5H3M4.5 5L3 6.5 4.5 8M16 6.5h5M19.5 5L21 6.5 19.5 8"/>',
  'sc-eyeTilt': '<path d="M4 14s3.2-5.3 7.4-5.8c4.2-.5 8.1 3 8.1 3s-2.4 5-6.6 5.5C8.7 17.2 4 14 4 14z"/>' + SPIN,
  'sc-eyePosition': SMALL_EYE + UP(21, 9, 6),
  'sc-eyeInner': '<path d="M2.5 12s3-4.5 7-4.5 7 4.5 7 4.5-3 4.5-7 4.5-7-4.5-7-4.5z"/><path d="M17.5 12h5M21 10.5l1.5 1.5-1.5 1.5"/>',
  'sc-eyeOuter': '<path d="M7.5 12s3-4.5 7-4.5 7 4.5 7 4.5-3 4.5-7 4.5-7-4.5-7-4.5z"/><path d="M6.5 12h-5M3 10.5L1.5 12 3 13.5"/>',
  'sc-noseSize': NOSE + CORNERS,
  'sc-noseWidth': NOSE + '<path d="M6.5 21.5h-4M4 20l-1.5 1.5L4 23M17.5 21.5h4M20 20l1.5 1.5L20 23"/>',
  'sc-noseLength': NOSE + VERT(20.5, 4, 18),
  'sc-noseBridge': NOSE + '<path d="M9.8 6.5H6M7.4 5.1L6 6.5l1.4 1.4M15.2 6.5H19M17.6 5.1l1.4 1.4-1.4 1.4"/>',
  'sc-noseTip': NOSE + UP(20, 16, 6),
  'sc-lipSize': LIPS + CORNERS,
  'sc-lipWidth': LIPS + OUT_H,
  'sc-lipUpper': LIPS + UP(12, 7.5, 5),
  'sc-lipLower': LIPS + DOWN(12, 17, 5),
  'sc-lipPosition': LIPS + VERT(21.5, 3, 9),
  'sc-smile': '<path d="M4 9.5c2.5 3.6 5.2 5.4 8 5.4s5.5-1.8 8-5.4"/><path d="M5.5 12.6c2 1.8 4.2 2.8 6.5 2.8s4.5-1 6.5-2.8"/>' + UP(3.5, 9, 4) + UP(20.5, 9, 4),
  'sc-cupid': '<path d="M3 14c2.5-3 5.3-4.6 7-4.6 1 0 1.5.8 2 .8s1-.8 2-.8c1.7 0 4.5 1.6 7 4.6-2.4 2.8-5.4 4.6-9 4.6S5.4 16.8 3 14z"/>' + UP(9.5, 7, 4) + UP(14.5, 7, 4),
  'sc-browDistance': '<path d="M1.5 13c1.6-2.6 4.9-3.6 8-2.6M22.5 13c-1.6-2.6-4.9-3.6-8-2.6"/><path d="M9 6.5H4M5.5 5L4 6.5 5.5 8M15 6.5h5M18.5 5L20 6.5 18.5 8"/>',
  'sc-browLift': BROW + UP(12, 8, 6),
  'sc-browArch': '<path d="M3 16c2.6-5.6 7.6-8 11.6-6.6 2.2.8 4.6 3 6.4 6.6"/>' + UP(12, 6.5, 5),
  'sc-browTilt': '<path d="M3 17c3-3.6 9.6-7 17-6.6"/>' + SPIN,
  'sc-browLength': BROW + '<path d="M7 19.5H1.5M3 18l-1.5 1.5L3 21"/>',
  'sc-browThickness': BROW + VERT(12, 5, 21),
  'side-both': FACE + '<path d="M12 3v17" stroke-dasharray="1.6 1.6"/>',
  'side-left': FACE + '<path d="M12 3C8.4 3 5.8 5.9 5.8 9.9c0 4.6 3.2 10.1 6.2 10.1z" fill="currentColor" stroke="none" opacity=".4"/>',
  'side-right': FACE + '<path d="M12 3c3.6 0 6.2 2.9 6.2 6.9 0 4.6-3.2 10.1-6.2 10.1z" fill="currentColor" stroke="none" opacity=".4"/>',
  faces: '<circle cx="8" cy="9" r="3.5"/><circle cx="16.5" cy="10" r="3"/><path d="M2.5 20c.6-3.2 2.7-5 5.5-5s4.9 1.8 5.5 5M13.5 20c.4-2.4 1.6-3.8 3-3.8s2.8 1.4 3.3 3.8"/>',
  // hair
  hairShine: '<path d="M5 21c-1-5 0-9 2-12s5.5-4.5 8.5-3"/><path d="M9.5 21c-.5-4 .5-7.5 2.5-10"/>' + SPARK(17.5, 13.5, 4.5),
  hairSmooth: '<path d="M4 20c.5-6 3-11 9-15M8.5 20c.5-5 2.6-9.2 7.5-12.5M13 20c.6-4 2.3-7.2 6-9.6"/>',
  hairTexture: '<path d="M4 20c.5-6 3-11 9-15M8.5 20c.5-5 2.6-9.2 7.5-12.5M13 20c.6-4 2.3-7.2 6-9.6"/><path d="M6.2 15.5l1.5.4M7.4 11.5l1.5.5M10.4 14l1.4.6M12.5 10.4l1.3.7M15.2 13.4l1.3.8" opacity=".7"/>',
  hairEnrich: '<path d="M3.5 20c.4-6 2.8-11 8.5-15M6.5 20c.4-5.5 2.7-10 7.5-13.5M9.5 20c.5-5 2.5-9 6.5-12M12.5 20c.5-4.2 2.3-7.6 5.5-10M15.5 20c.5-3.4 2-6 4.5-7.8"/>',
  // filters, glitter, sparkle
  heart: '<path d="M12 20s-7.5-4.6-7.5-10.2A4.3 4.3 0 0 1 12 7.2a4.3 4.3 0 0 1 7.5 2.6C19.5 15.4 12 20 12 20z"/>',
  heartOn: '<path d="M12 20s-7.5-4.6-7.5-10.2A4.3 4.3 0 0 1 12 7.2a4.3 4.3 0 0 1 7.5 2.6C19.5 15.4 12 20 12 20z" fill="currentColor"/>',
  protectSkin: FACE + '<path d="M15.5 13.2l2.2 1v2.2c0 1.6-1 2.7-2.2 3.2-1.2-.5-2.2-1.6-2.2-3.2v-2.2z" fill="currentColor" stroke-width="1.2"/>',
  halation: '<circle cx="12" cy="12" r="3.5"/><circle cx="12" cy="12" r="7" opacity=".55" stroke-dasharray="1.5 2"/><circle cx="12" cy="12" r="10" opacity=".3"/>',
  dust: '<rect x="3.5" y="4" width="17" height="16" rx="2.5"/><circle cx="8" cy="9" r=".9" fill="currentColor"/><circle cx="15.5" cy="14.5" r="1.2" fill="currentColor"/><circle cx="10.5" cy="16" r=".7" fill="currentColor"/><path d="M14 6.5c.4 3 .2 6-.6 9" opacity=".6"/>',
  sp4: SPARK(12, 12, 9),
  sp6: '<path d="M12 2.5v19M3.8 7.2l16.4 9.6M3.8 16.8l16.4-9.6"/><circle cx="12" cy="12" r="1.8" fill="currentColor"/>',
  sp8: '<path d="M12 2.5v19M2.5 12h19M5.3 5.3l13.4 13.4M5.3 18.7L18.7 5.3"/><circle cx="12" cy="12" r="1.8" fill="currentColor"/>',
  spTwinkle: SPARK(12, 12, 9) + '<path d="M7.5 7.5l2 2M16.5 7.5l-2 2M7.5 16.5l2-2M16.5 16.5l-2-2" opacity=".6"/>',
  spGlow: '<circle cx="12" cy="12" r="2.5" fill="currentColor"/><circle cx="12" cy="12" r="6" opacity=".5"/><circle cx="12" cy="12" r="9.5" opacity=".25"/>',
  hairVolume: '<path d="M6 18.5C3.5 15 3.2 9 7 5.8 10.6 2.7 16 3.5 18.4 7.6 20.4 11 19.6 15.4 18 18.5"/><path d="M9 17c-.8-3.6.3-7 3-8.6 2.7 1.6 3.8 5 3 8.6"/>' + '<path d="M1.5 9.5L3.4 11M22.5 9.5L20.6 11M12 .8v2"/>',
  // Reshape
  grow: '<circle cx="12" cy="12" r="4"/><path d="M12 1.5v4M12 18.5v4M1.5 12h4M18.5 12h4"/><path d="M10 3.5l2-2 2 2M10 20.5l2 2 2-2M3.5 10l-2 2 2 2M20.5 10l2 2-2 2"/>',
  shrink: '<circle cx="12" cy="12" r="2.5"/><path d="M12 2v5.5M12 16.5V22M2 12h5.5M16.5 12H22"/><path d="M10 5.5l2 2 2-2M10 18.5l2-2 2 2M5.5 10l2 2-2 2M18.5 10l-2 2 2 2"/>',
  restore: '<path d="M5 9.5a7.5 7.5 0 1 1-.3 5"/><path d="M4.5 4.5v5h5"/><path d="M12 8.5v4l2.5 1.5"/>',
  protect: '<path d="M12 3l7 2.8v5.4c0 4.4-3 8-7 9.8-4-1.8-7-5.4-7-9.8V5.8z"/><path d="M9 12l2.2 2.2L15.5 10"/>',
  invert: '<circle cx="12" cy="12" r="8.5"/><path d="M12 3.5a8.5 8.5 0 0 1 0 17z" fill="currentColor" stroke="none"/>',
  age: '<path d="M7 3.5h10M7 20.5h10"/><path d="M8 3.5c0 4 4 5.5 4 8.5s-4 4.5-4 8.5M16 3.5c0 4-4 5.5-4 8.5s4 4.5 4 8.5"/><path d="M9.5 18.5h5" opacity=".6"/>',
  presets: '<rect x="3.5" y="5" width="17" height="14" rx="3"/><path d="M7.5 15l3-3.5 2.5 2.5 2-2 2.5 3"/>' + SPARK(17.5, 4.5, 3.5),
  tune: '<circle cx="6" cy="7" r="2.2"/><circle cx="17" cy="9" r="2.2"/><circle cx="9" cy="17" r="2.2"/><path d="M14.5 14.5l5 5M19.5 15.5v4h-4"/>',
  spacing: '<path d="M2.5 18l3-11 3 11M3.6 14.5h3.8"/><path d="M15.5 18l3-11 3 11M16.6 14.5h3.8"/><path d="M10 12.5h4M11.2 11.3L10 12.5l1.2 1.2M12.8 11.3l1.2 1.2-1.2 1.2"/>',
  light: '<path d="M4 15.5c3-4 5-6 8-6s5 2 8 6"/>',
  heavy: '<path d="M4 12.5c3-4 5-6 8-6s5 2 8 6"/><path d="M4 18c3-4 5-6 8-6s5 2 8 6"/>',
});

// A rectangle of aspect w:h, for the crop ratios.
export function aspectIcon(w, h, cls = 'i') {
  const k = 15 / Math.max(w, h), rw = w * k, rh = h * k;
  return `<svg class="${cls}" viewBox="0 0 24 24" aria-hidden="true"><rect x="${(12 - rw / 2).toFixed(1)}" y="${(12 - rh / 2).toFixed(1)}" width="${rw.toFixed(1)}" height="${rh.toFixed(1)}" rx="2"/></svg>`;
}

export function icon(name, cls = 'i') {
  return `<svg class="${cls}" viewBox="0 0 24 24" aria-hidden="true">${PATHS[name] || PATHS.none}</svg>`;
}
