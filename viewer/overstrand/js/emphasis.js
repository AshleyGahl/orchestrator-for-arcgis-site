// emphasis.js — how a chosen result stands out on the map when people pick it (a spatial relationship's results,
// Attribute trace results): it flashes, it's filled in the selection colour, and it's lifted off the map in 3D, drawn
// like the Scene window's extrusion (a block with shaded walls standing on a soft shadow). Each spatial section, the
// trace widget and each search carry their own settings, and may have their own colour instead of the selection colour.
// Pure: no DOM, no SDK, so it runs in Node tests. map.js draws it; emphasisEditor.js edits it.

export const FLASH_TIMES_MAX = 10;
export const LIFT_HEIGHT_MIN = 4;
export const LIFT_HEIGHT_MAX = 48;
/** Scales the map can zoom a chosen result to: [scale, label]; 0 = fit the result (points: street level). */
export const ZOOM_SCALES = [[0, 'Fit the result'], [500, '1:500'], [1000, '1:1,000'], [2500, '1:2,500'], [5000, '1:5,000'], [10000, '1:10,000'], [25000, '1:25,000'], [50000, '1:50,000'], [100000, '1:100,000']];
export const ZOOM_SCALE_MAX = 50000000;

/**
 * flash: blink when the map arrives; flashTimes: how often; highlight: solid fill (off: outline only); fillOpacity 0.1–1;
 * lift: 3D, raised liftHeight screen pixels with walls and a shadow; color: '#rrggbb', or '' for the selection colour;
 * zoomScale: the map scale it zooms to (0 = fit the result).
 */
export const defaultEmphasis = () => ({ flash: true, flashTimes: 3, highlight: true, fillOpacity: 0.6, lift: true, liftHeight: 24, color: '', zoomScale: 0 });

const isHex = v => /^#[0-9a-f]{6}$/i.test(v || '');

/** The colour to draw in: the emphasis's own, or the selection colour (both [r, g, b]). */
export function emphasisRgb(e, selectionRgb) {
  const { color } = normalizeEmphasis(e);
  if (!color) return selectionRgb;
  const n = parseInt(color.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** The ArcGIS layer effect that casts the lifted result's soft shadow on the map. */
export const LIFT_EFFECT = 'drop-shadow(2px, 4px, 4px, rgba(0, 0, 0, 0.45))';

/** Thin dark edges on the walls and top, as the Scene window draws its extrusions, so the faces stay apart. */
export const EDGE_RGBA = [28, 43, 48, 0.45];

const clamp = (v, lo, hi, dflt) => (Number.isFinite(Number(v)) && v !== '' && v !== null ? Math.min(hi, Math.max(lo, Number(v))) : dflt);

/** Settings with every value present and in range (missing or broken values take the default). */
export function normalizeEmphasis(e) {
  const d = defaultEmphasis();
  const src = e && typeof e === 'object' && !Array.isArray(e) ? e : {};
  const bool = (k) => (typeof src[k] === 'boolean' ? src[k] : d[k]);
  return {
    flash: bool('flash'),
    flashTimes: Math.round(clamp(src.flashTimes, 1, FLASH_TIMES_MAX, d.flashTimes)),
    highlight: bool('highlight'),
    fillOpacity: Math.round(clamp(src.fillOpacity, 0.1, 1, d.fillOpacity) * 100) / 100,
    lift: bool('lift'),
    liftHeight: Math.round(clamp(src.liftHeight, LIFT_HEIGHT_MIN, LIFT_HEIGHT_MAX, d.liftHeight)),
    color: isHex(src.color) ? src.color.toUpperCase() : '',
    zoomScale: Number.isInteger(src.zoomScale) && src.zoomScale > 0 && src.zoomScale <= ZOOM_SCALE_MAX ? src.zoomScale : 0
  };
}

/** What's wrong with an emphasis block, as sentences (empty: fine). */
export function emphasisProblems(e) {
  if (e == null) return [];
  if (typeof e !== 'object' || Array.isArray(e)) return ['emphasis must be { flash, flashTimes, highlight, fillOpacity, lift, liftHeight, color, zoomScale }.'];
  const out = [];
  for (const k of ['flash', 'highlight', 'lift']) if (e[k] != null && typeof e[k] !== 'boolean') out.push(`emphasis.${k} must be true or false.`);
  if (e.flashTimes != null && !(Number.isInteger(e.flashTimes) && e.flashTimes >= 1 && e.flashTimes <= FLASH_TIMES_MAX)) out.push(`emphasis.flashTimes must be a whole number from 1 to ${FLASH_TIMES_MAX}.`);
  if (e.fillOpacity != null && !(typeof e.fillOpacity === 'number' && e.fillOpacity >= 0.1 && e.fillOpacity <= 1)) out.push('emphasis.fillOpacity must be from 0.1 to 1.');
  if (e.zoomScale != null && !(Number.isInteger(e.zoomScale) && e.zoomScale >= 0 && e.zoomScale <= ZOOM_SCALE_MAX)) out.push('emphasis.zoomScale must be a map scale such as 2500, or 0 to fit the result.');
  if (e.color != null && e.color !== '' && !isHex(e.color)) out.push('emphasis.color must look like #D9480F (or be empty for the selection colour).');
  if (e.liftHeight != null && !(Number.isInteger(e.liftHeight) && e.liftHeight >= LIFT_HEIGHT_MIN && e.liftHeight <= LIFT_HEIGHT_MAX)) out.push(`emphasis.liftHeight must be a whole number of pixels from ${LIFT_HEIGHT_MIN} to ${LIFT_HEIGHT_MAX}.`);
  return out;
}

/**
 * Symbols (ArcGIS JSON-ish autocast objects) for the chosen result, in its colour (emphasisRgb).
 * highlight on: filled at fillOpacity (polygons and point markers; lines stay solid) with a light edge; off: a bold
 * outline and no fill.
 * @param rgb [r, g, b]
 */
export function emphasisSymbols(rgb, e) {
  const [r, g, b] = rgb;
  const { highlight, fillOpacity } = normalizeEmphasis(e);
  if (highlight) return {
    point: { type: 'simple-marker', size: 14, color: [r, g, b, fillOpacity], outline: { color: [255, 255, 255, 1], width: 2 } },
    polyline: { type: 'simple-line', color: [r, g, b, 1], width: 5, cap: 'round', join: 'round' },
    polygon: { type: 'simple-fill', color: [r, g, b, fillOpacity], outline: { color: [255, 255, 255, 0.95], width: 2 } }
  };
  return {
    point: { type: 'simple-marker', size: 14, color: [r, g, b, 0], outline: { color: [r, g, b, 1], width: 2.5 } },
    polyline: { type: 'simple-line', color: [r, g, b, 1], width: 3, cap: 'round', join: 'round' },
    polygon: { type: 'simple-fill', color: [r, g, b, 0], outline: { color: [r, g, b, 1], width: 2.5 } }
  };
}

/**
 * Settings that look like the viewer's plain selection: no flash, no fill, no lift, the selection colour, fit the
 * feature. The default for highlights that had no settings before (Details, Select features, Editing, Go to coordinates).
 */
export const plainEmphasis = () => ({ ...defaultEmphasis(), flash: false, highlight: false, lift: false });

/** Neither filled nor lifted: drawn with the thin selection outline (selectionSymbols), not the bold one. */
export const isThin = e => { const n = normalizeEmphasis(e); return !n.highlight && !n.lift; };

/**
 * The thin selection symbols (the plain highlight of a clicked feature), in rgb, with the selection line style
 * (branding.selectionLine).
 */
export function selectionSymbols(rgb, style = 'solid') {
  const [r, g, b] = rgb;
  const line = { color: [r, g, b, 0.95], width: 1.5, style };
  return {
    point: { type: 'simple-marker', size: 11, color: [r, g, b, 0.12], outline: line },
    polyline: { type: 'simple-line', color: [r, g, b, 0.95], width: 2, style },
    polygon: { type: 'simple-fill', color: [r, g, b, 0.06], outline: line }
  };
}

/**
 * The flash as layer opacities, one per beat (map.js plays them ~180 ms apart and ends fully shown).
 * flashTimes 3 -> dim, show, dim, show, dim, show.
 */
export function flashBeats(e) {
  const { flash, flashTimes } = normalizeEmphasis(e);
  if (!flash) return [];
  return Array.from({ length: flashTimes * 2 }, (_, i) => (i % 2 ? 1 : 0.1));
}

/* ---------------- 3D lift: the Scene's extrusion, drawn on a 2D map ---------------- */
const signedArea = ring => ring.reduce((a, [x, y], i) => { const [x2, y2] = ring[(i + 1) % ring.length]; return a + x * y2 - x2 * y; }, 0) / 2;

/**
 * The shape raised by `up` (map units; the direction that is up on the screen, so it follows rotation and scale),
 * with a wall along every edge that faces the viewer. Walls facing away are hidden under the top, so they're left
 * out (a see-through top then shows the map, not a dark wall). Lines get a wall along their whole length, both sides.
 * @param kind   'polygon' (parts = rings) | 'polyline' (parts = paths)
 * @param up     [dx, dy]
 * @returns { walls: [{ ring, shade }] back to front, top: parts moved up }; shade 0..1 is how lit the wall is
 *          (walls facing left are lit, facing right are in shade), to darken the colour by
 */
export function extrusion(kind, parts, up) {
  const [ux, uy] = up;
  const len = Math.hypot(ux, uy) || 1;
  const [rx, ry] = [uy / len, -ux / len];            // screen right, in map units
  const lift = ([x, y]) => [x + ux, y + uy];
  const walls = [];
  for (const part of parts ?? []) {
    if (!Array.isArray(part) || part.length < 2) continue;
    const closed = kind === 'polygon';
    const ccw = closed && signedArea(part) > 0;
    for (let i = 0; i < part.length - 1; i++) {
      const a = part[i], b = part[i + 1];
      const ex = b[0] - a[0], ey = b[1] - a[1];
      const el = Math.hypot(ex, ey);
      if (!el) continue;
      // Outward normal of a ring's edge (lines: either side, so take the one facing the viewer).
      let [nx, ny] = ccw ? [ey / el, -ex / el] : [-ey / el, ex / el];
      const facing = -(nx * ux + ny * uy) / len;      // > 0: faces down the screen, towards the viewer
      if (closed && facing <= 0) continue;
      if (!closed && facing < 0) { nx = -nx; ny = -ny; }
      const side = nx * rx + ny * ry;                 // -1 faces left, +1 faces right
      walls.push({ ring: [a, b, lift(b), lift(a), a], shade: Math.round((0.72 - 0.22 * side) * 100) / 100, depth: Math.max(a[0] * ux + a[1] * uy, b[0] * ux + b[1] * uy) });
    }
  }
  walls.sort((p, q) => q.depth - p.depth);           // farthest up the screen first, so nearer walls paint over them
  return { walls: walls.map(({ ring, shade }) => ({ ring, shade })), top: (parts ?? []).map(p => p.map(lift)) };
}

/** [r, g, b] darkened by a wall's shade (1 = as is). */
export const shadeRgb = ([r, g, b], shade) => [r, g, b].map(v => Math.round(v * shade));
