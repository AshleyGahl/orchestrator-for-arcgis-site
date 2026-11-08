// cursors.js — the map cursor while a tool or widget waits for the map (manifest widgets.cursors). Three activities,
// each with its own cursor: drawing or measuring (draw), clicking one place (pick) and choosing a feature (select).
// Any tool or widget may use its own cursor instead (overrides). The cursors are a short list: the map's own, three
// of the system's, and four drawn here as SVG with a white edge so they read on aerials and dark basemaps, in a dark
// ink or the selection colour, at normal or large size.
// Pure: no DOM, no SDK, imports nothing, so it runs in Node tests. map.js applies it; cursorsEditor.js edits it.

/** [id, label, what it covers]. */
export const CURSOR_ACTIVITIES = [
  ['draw', 'Drawing and measuring', 'Measure, Draw, Elevation profile, and any shape being drawn (Select features, Screenshot area, Editing\'s Add).'],
  ['pick', 'Clicking one place', 'Label orientation (click a street), Vegetation health (click a spot), Attribute trace while it waits for the start feature.'],
  ['select', 'Choosing a feature', 'While the Attribute trace, Editing or spatial relationship window is open: a click opens a feature.']
];

const INK = '#1B2A2F';
const HALO = '#fff';

/*
 * Each cursor: label, and either keyword (a CSS cursor, the system's own) or svg(ink) on a 32 x 32 grid with its
 * hotspot and the keyword a browser falls back to. 'map' leaves the SDK's cursor alone.
 */
const halo = (d, w = 4.5) => `<path d="${d}" fill="none" stroke="${HALO}" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round"/>`;
const line = (d, ink, w = 1.8) => `<path d="${d}" fill="none" stroke="${ink}" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round"/>`;
const dot = (ink, r) => `<circle cx="16" cy="16" r="${r}" fill="${ink}" stroke="${HALO}"/>`;
const CROSS = 'M16 2v10M16 20v10M2 16h10M20 16h10';
const TICKS = 'M16 3v6M16 23v6M3 16h6M23 16h6';
const PLUS = 'M16 6v20M6 16h20';
const ARROW = 'M5 3v19l5-4.6 3.4 7.4 3.4-1.6-3.4-7.2h6.6Z';
const BOX = 'M21 21h7v7h-7Z';

export const CURSORS = [
  { id: 'map', label: "Map's own (arrow)" },
  { id: 'cross', label: 'Crosshair, white edge', hot: [16, 16], fallback: 'crosshair',
    svg: ink => halo(CROSS) + line(CROSS, ink) + dot(ink, 1.6) },
  { id: 'target', label: 'Target ring', hot: [16, 16], fallback: 'crosshair',
    svg: ink => `<circle cx="16" cy="16" r="8" fill="none" stroke="${HALO}" stroke-width="4.5"/><circle cx="16" cy="16" r="8" fill="none" stroke="${ink}" stroke-width="1.8"/>`
      + halo(TICKS) + line(TICKS, ink) + dot(ink, 2) },
  { id: 'plus', label: 'Bold plus', hot: [16, 16], fallback: 'cell',
    svg: ink => halo(PLUS, 7) + line(PLUS, ink, 3.2) },
  { id: 'arrow', label: 'Arrow with a feature, white edge', hot: [5, 3], fallback: 'default',
    svg: ink => `<path d="${ARROW}" fill="${ink}" stroke="${HALO}" stroke-width="2" stroke-linejoin="round"/>` + halo(BOX, 4) + line(BOX, ink, 1.8) },
  { id: 'crosshair', label: 'System crosshair', keyword: 'crosshair' },
  { id: 'cell', label: 'System plus', keyword: 'cell' },
  { id: 'pointer', label: 'System hand', keyword: 'pointer' }
];
const CURSOR_IDS = CURSORS.map(c => c.id);
export const isCursor = id => CURSOR_IDS.includes(id);

/** [id, label]. dark: dark ink; selection: the viewer's selection colour (branding.accent). */
export const CURSOR_COLOURS = [['dark', 'Dark'], ['selection', 'Selection colour']];
/** [id, label, pixels]. */
export const CURSOR_SIZES = [['normal', 'Normal', 32], ['large', 'Large', 48]];

/**
 * The tools and widgets that set a cursor: id (a tool id, or trace, editing, spatial), label, their activity, and
 * whileDrawing: only while their shape is being drawn (Select features and Screenshot don't wait for the map otherwise).
 */
export const CURSOR_TARGETS = [
  { id: 'measure-distance', label: 'Measure distance', activity: 'draw', kind: 'tool' },
  { id: 'measure-area', label: 'Measure area', activity: 'draw', kind: 'tool' },
  { id: 'select', label: 'Select features', activity: 'draw', kind: 'tool', whileDrawing: true },
  { id: 'sketch', label: 'Draw', activity: 'draw', kind: 'tool' },
  { id: 'elevation', label: 'Elevation profile', activity: 'draw', kind: 'tool' },
  { id: 'screenshot', label: 'Screenshot', activity: 'draw', kind: 'tool', whileDrawing: true },
  { id: 'label-orientation', label: 'Label orientation', activity: 'pick', kind: 'tool' },
  { id: 'vegetation', label: 'Vegetation health', activity: 'pick', kind: 'tool' },
  { id: 'trace', label: 'Attribute trace', activity: 'select', kind: 'widget' },
  { id: 'editing', label: 'Editing', activity: 'select', kind: 'widget' },
  { id: 'spatial', label: 'Spatial relationship window', activity: 'select', kind: 'widget' }
];
const TARGET_IDS = CURSOR_TARGETS.map(t => t.id);

export const defaultCursors = () => ({ draw: 'cross', pick: 'target', select: 'arrow', colour: 'dark', size: 'normal', overrides: {} });

const inList = (v, list) => list.some(([id]) => id === v);

/** Anything missing or broken falls back to the default; overrides keep only known tools and cursors. */
export function normalizeCursors(c) {
  const d = defaultCursors();
  if (!c || typeof c !== 'object' || Array.isArray(c)) return d;
  const overrides = c.overrides && typeof c.overrides === 'object' && !Array.isArray(c.overrides)
    ? Object.fromEntries(Object.entries(c.overrides).filter(([k, v]) => TARGET_IDS.includes(k) && isCursor(v)))
    : {};
  return {
    draw: isCursor(c.draw) ? c.draw : d.draw,
    pick: isCursor(c.pick) ? c.pick : d.pick,
    select: isCursor(c.select) ? c.select : d.select,
    colour: inList(c.colour, CURSOR_COLOURS) ? c.colour : d.colour,
    size: inList(c.size, CURSOR_SIZES) ? c.size : d.size,
    overrides
  };
}

/** What's wrong with a widgets.cursors block (empty = fine). */
export function cursorProblems(c) {
  if (c == null) return [];
  if (typeof c !== 'object' || Array.isArray(c)) return ['must be an object.'];
  const out = [];
  for (const [a] of CURSOR_ACTIVITIES) if (c[a] != null && !isCursor(c[a])) out.push(`${a} must be one of ${CURSOR_IDS.join(', ')}.`);
  if (c.colour != null && !inList(c.colour, CURSOR_COLOURS)) out.push(`colour must be one of ${CURSOR_COLOURS.map(([v]) => v).join(', ')}.`);
  if (c.size != null && !inList(c.size, CURSOR_SIZES)) out.push(`size must be one of ${CURSOR_SIZES.map(([v]) => v).join(', ')}.`);
  if (c.overrides != null) {
    if (typeof c.overrides !== 'object' || Array.isArray(c.overrides)) out.push('overrides must be an object keyed by tool or widget.');
    else for (const [k, v] of Object.entries(c.overrides)) {
      if (!TARGET_IDS.includes(k)) out.push(`overrides: "${k}" isn't a tool or widget with a cursor (${TARGET_IDS.join(', ')}).`);
      else if (!isCursor(v)) out.push(`overrides.${k} must be one of ${CURSOR_IDS.join(', ')}.`);
    }
  }
  return out;
}

/** The activity a tool sets while it's open: null for tools that don't wait for the map (or only while drawing). */
export function toolActivity(id) {
  const t = CURSOR_TARGETS.find(x => x.id === id);
  return t && !t.whileDrawing ? t.activity : null;
}

/** The cursor id for an owner (tool or widget) doing an activity: its override, else the activity's; null = the map's own. */
export function cursorFor(c, owner, activity) {
  if (!activity) return null;
  const n = normalizeCursors(c);
  const id = (owner && n.overrides[owner]) || n[activity];
  return id === 'map' ? null : id;
}

/** The SVG of a drawn cursor (null for the system's and the map's own). */
export function cursorSvg(id, { ink = INK, size = 'normal' } = {}) {
  const cur = CURSORS.find(x => x.id === id);
  if (!cur?.svg) return null;
  const px = CURSOR_SIZES.find(([s]) => s === size)?.[2] ?? 32;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${px}" height="${px}" viewBox="0 0 32 32">${cur.svg(ink)}</svg>`;
}

const isHex = v => /^#[0-9a-f]{6}$/i.test(v || '');

/** The ink for drawn cursors: dark, or the selection colour (a #rrggbb accent; anything else stays dark). */
export const cursorInk = (c, accent) => (normalizeCursors(c).colour === 'selection' && isHex(accent) ? accent : INK);

/** The CSS cursor value for a cursor id, e.g. url("data:…") 16 16, crosshair. null for the map's own. */
export function cursorCss(id, { ink = INK, size = 'normal' } = {}) {
  const cur = CURSORS.find(x => x.id === id);
  if (!cur || cur.id === 'map') return null;
  if (cur.keyword) return cur.keyword;
  const scale = (CURSOR_SIZES.find(([s]) => s === size)?.[2] ?? 32) / 32;
  const [x, y] = cur.hot.map(v => Math.round(v * scale));
  return `url("data:image/svg+xml,${encodeURIComponent(cursorSvg(id, { ink, size }))}") ${x} ${y}, ${cur.fallback}`;
}

/**
 * The style sheet map.js puts in the page: one rule per cursor, for the map container's data-tool-cursor. Only where
 * the SDK shows its plain cursor: its move and resize cursors over Sketch handles, and grabbing while panning, still show.
 */
export function cursorRules(c, accent) {
  const n = normalizeCursors(c);
  const ink = cursorInk(n, accent);
  return CURSORS.filter(x => x.id !== 'map').map(x => {
    const on = `[data-tool-cursor="${x.id}"] .esri-view-surface`;
    const sel = [':not([data-cursor])', '[data-cursor="default"]', '[data-cursor="crosshair"]']
      .map(s => `${on}${s}:not([data-navigating="true"])`).join(',\n');
    return `${sel} {\n  cursor: ${cursorCss(x.id, { ink, size: n.size })} !important;\n}`;
  }).join('\n');
}
