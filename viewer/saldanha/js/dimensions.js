// dimensions.js — the Dimensions tool's measuring and label placement, like a parcel fabric's dimension labels: the
// length (and optionally the bearing) of each polygon side and line segment, and each polygon's area. Pure: no SDK, no DOM.
// Lengths and bearings are on the WGS84 ellipsoid (Vincenty) when the map is in Web Mercator or geographic coordinates,
// so they're ground distances, not the stretched ones Web Mercator would give. Any other projected map gives grid values.
// Labels are worked out for one view: only the part of the map in view, a side shared by two parcels is labelled once
// (also when their corners differ by a hair, as digitised boundaries often do), and a side too short on screen for its
// text gets no label (zooming in shows it).

export const DIMENSION_UNITS = [['meters', 'Metres (m)'], ['feet', 'Feet (ft)']];
export const DIMENSION_AREA_UNITS = [
  ['auto', 'm² below 1 ha, then hectares'], ['square-meters', 'Square metres (m²)'], ['hectares', 'Hectares (ha)'],
  ['square-feet', 'Square feet (ft²)'], ['acres', 'Acres (ac)']
];
export const LINE_LENGTH_MODES = [['segments', 'Each segment'], ['total', 'Whole line (once per feature)']];
export const BEARING_FORMATS = [['dms', "Degrees, minutes, seconds (96°44'03\")"], ['decimal', 'Decimal degrees (96.7342°)']];
export const MAX_DECIMALS = 3;

const A = 6378137, F = 1 / 298.257223563, B = A * (1 - F), E2 = F * (2 - F);   // WGS84
const RAD = Math.PI / 180;
const inList = (v, list) => list.some(([id]) => id === v);

/* ---------------- Measuring ---------------- */

/** Web Mercator (wkid 3857 / 102100) x, y to [lon, lat] degrees. */
export const mercatorToLonLat = ([x, y]) => [x / A / RAD, (2 * Math.atan(Math.exp(y / A)) - Math.PI / 2) / RAD];

/**
 * Distance (metres) and bearing (degrees clockwise from true north, 0–360) from one [lon, lat] to another on the
 * WGS84 ellipsoid: Vincenty's inverse formula, accurate to well under a millimetre.
 */
export function geodesicInverse([lon1, lat1], [lon2, lat2]) {
  const L = (lon2 - lon1) * RAD;
  const U1 = Math.atan((1 - F) * Math.tan(lat1 * RAD)), U2 = Math.atan((1 - F) * Math.tan(lat2 * RAD));
  const sinU1 = Math.sin(U1), cosU1 = Math.cos(U1), sinU2 = Math.sin(U2), cosU2 = Math.cos(U2);
  let lambda = L, sinL = 0, cosL = 1, sinS = 0, cosS = 1, sigma = 0, cos2a = 1, cos2Sm = 0;
  for (let i = 0; i < 200; i++) {
    sinL = Math.sin(lambda); cosL = Math.cos(lambda);
    sinS = Math.hypot(cosU2 * sinL, cosU1 * sinU2 - sinU1 * cosU2 * cosL);
    if (sinS === 0) return { distance: 0, bearing: 0 };
    cosS = sinU1 * sinU2 + cosU1 * cosU2 * cosL;
    sigma = Math.atan2(sinS, cosS);
    const sinA = cosU1 * cosU2 * sinL / sinS;
    cos2a = 1 - sinA * sinA;
    cos2Sm = cos2a ? cosS - 2 * sinU1 * sinU2 / cos2a : 0;      // on the equator
    const C = F / 16 * cos2a * (4 + F * (4 - 3 * cos2a));
    const prev = lambda;
    lambda = L + (1 - C) * F * sinA * (sigma + C * sinS * (cos2Sm + C * cosS * (-1 + 2 * cos2Sm * cos2Sm)));
    if (Math.abs(lambda - prev) < 1e-12) break;
  }
  const u2 = cos2a * (A * A - B * B) / (B * B);
  const kA = 1 + u2 / 16384 * (4096 + u2 * (-768 + u2 * (320 - 175 * u2)));
  const kB = u2 / 1024 * (256 + u2 * (-128 + u2 * (74 - 47 * u2)));
  const dSigma = kB * sinS * (cos2Sm + kB / 4 * (cosS * (-1 + 2 * cos2Sm * cos2Sm)
    - kB / 6 * cos2Sm * (-3 + 4 * sinS * sinS) * (-3 + 4 * cos2Sm * cos2Sm)));
  const bearing = Math.atan2(cosU2 * sinL, cosU1 * sinU2 - sinU1 * cosU2 * cosL) / RAD;
  return { distance: B * kA * (sigma - dSigma), bearing: (bearing + 360) % 360 };
}

/**
 * Area (m²) of polygon rings in [lon, lat] degrees, holes subtracted (rings wind the opposite way, as in ArcGIS JSON).
 * Each vertex is placed on an equal-area (sinusoidal) plane with the ellipsoid's radii of curvature: for parcels and
 * farms the error is far below a square metre.
 */
export function ellipsoidArea(rings) {
  const pts = rings.flat();
  if (!pts.length) return 0;
  const lon0 = pts.reduce((s, p) => s + p[0], 0) / pts.length, lat0 = pts.reduce((s, p) => s + p[1], 0) / pts.length;
  const s0 = Math.sin(lat0 * RAD), M = A * (1 - E2) / (1 - E2 * s0 * s0) ** 1.5;
  const plane = ([lon, lat]) => {
    const s = Math.sin(lat * RAD), N = A / Math.sqrt(1 - E2 * s * s);
    return [(lon - lon0) * RAD * N * Math.cos(lat * RAD), (lat - lat0) * RAD * M];
  };
  return Math.abs(rings.reduce((sum, r) => sum + shoelace(r.map(plane)), 0));
}

/** Signed area of a ring in plane coordinates (positive when it winds anticlockwise). */
function shoelace(ring) {
  let s = 0;
  for (let i = 0, n = ring.length; i < n; i++) {
    const [x1, y1] = ring[i], [x2, y2] = ring[(i + 1) % n];
    s += x1 * y2 - x2 * y1;
  }
  return s / 2;
}

/**
 * How to measure in a map's coordinates.
 * @param sr  { isWebMercator, isGeographic, metersPerUnit } (an SDK SpatialReference has these)
 * @returns {{ segment(a, b): { length, bearing }, area(rings): number, geodesic: boolean }}  metres, degrees, m²
 */
export function measurer(sr = {}) {
  if (sr.isWebMercator || sr.isGeographic) {
    const ll = sr.isWebMercator ? mercatorToLonLat : p => p;
    return {
      geodesic: true,
      segment: (a, b) => { const g = geodesicInverse(ll(a), ll(b)); return { length: g.distance, bearing: g.bearing }; },
      area: rings => ellipsoidArea(rings.map(r => r.map(ll)))
    };
  }
  const k = sr.metersPerUnit || 1;                     // a projected map: grid distances and grid bearings
  return {
    geodesic: false,
    segment: ([x1, y1], [x2, y2]) => ({ length: Math.hypot(x2 - x1, y2 - y1) * k, bearing: (Math.atan2(x2 - x1, y2 - y1) / RAD + 360) % 360 }),
    area: rings => Math.abs(rings.reduce((sum, r) => sum + shoelace(r), 0)) * k * k
  };
}

/* ---------------- Formatting ---------------- */

const number = (v, decimals, locale) => new Intl.NumberFormat(locale, { minimumFractionDigits: decimals, maximumFractionDigits: decimals }).format(v);

/** 24.36 m, or 79.92 ft. */
export const formatLength = (metres, unit = 'meters', decimals = 2, locale = 'en-US') =>
  unit === 'feet' ? `${number(metres / 0.3048, decimals, locale)} ft` : `${number(metres, decimals, locale)} m`;

/** 812.40 m², 1.2400 ha (hectares get two more decimals, so 0.01 ha isn't the finest step), 2.10 ac … */
export function formatArea(m2, unit = 'auto', decimals = 2, locale = 'en-US') {
  if (unit === 'hectares' || (unit === 'auto' && m2 >= 10000)) return `${number(m2 / 10000, decimals + 2, locale)} ha`;
  if (unit === 'square-feet') return `${number(m2 / 0.09290304, decimals, locale)} ft²`;
  if (unit === 'acres') return `${number(m2 / 4046.8564224, decimals + 2, locale)} ac`;
  return `${number(m2, decimals, locale)} m²`;
}

/**
 * A bearing, clockwise from north: whole degrees, minutes and seconds (123°45'10"), or decimal degrees to four places
 * (123.7528°, about the same precision as a second). Map text uses plain ' and " (every map font has them).
 */
export function formatBearing(deg, format = 'dms', locale = 'en-US') {
  if (format === 'decimal') {
    const v = Math.round((((deg % 360) + 360) % 360) * 10000) / 10000;
    return `${number(v >= 360 ? 0 : v, 4, locale)}°`;
  }
  let s = Math.round((((deg % 360) + 360) % 360) * 3600);
  if (s >= 360 * 3600) s = 0;
  const d = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  return `${d}°${String(m).padStart(2, '0')}'${String(s % 60).padStart(2, '0')}"`;
}

/* ---------------- Placing labels ---------------- */

/** The part of segment a–b inside an extent (Liang–Barsky), or null when none of it is. */
export function clipSegment([x1, y1], [x2, y2], { xmin, ymin, xmax, ymax }) {
  const dx = x2 - x1, dy = y2 - y1;
  let t0 = 0, t1 = 1;
  for (const [p, q] of [[-dx, x1 - xmin], [dx, xmax - x1], [-dy, y1 - ymin], [dy, ymax - y1]]) {
    if (p === 0) { if (q < 0) return null; continue; }
    const t = q / p;
    if (p < 0) { if (t > t1) return null; if (t > t0) t0 = t; }
    else { if (t < t0) return null; if (t < t1) t1 = t; }
  }
  return [[x1 + t0 * dx, y1 + t0 * dy], [x1 + t1 * dx, y1 + t1 * dy]];
}

/**
 * Text angle along a segment for an SDK TextSymbol (degrees clockwise, 0 = horizontal), turned so it never reads
 * upside down, and the unit normal pointing to the text's top (labels sit just above their line).
 */
export function uprightAlong([x1, y1], [x2, y2]) {
  let dx = x2 - x1, dy = y2 - y1;
  if (dx < 0 || (dx === 0 && dy < 0)) { dx = -dx; dy = -dy; }
  const len = Math.hypot(dx, dy) || 1;
  return { angle: -Math.atan2(dy, dx) / RAD || 0, normal: [-dy / len, dx / len] };
}

/** Roughly how wide a label is on screen, in pixels. */
export const textWidthPx = (text, fontPx = 11) => text.length * fontPx * 0.6 + 8;

const GAP_PX = 6;                                     // between a length and its bearing

const inExtent = ([x, y], e) => x >= e.xmin && x <= e.xmax && y >= e.ymin && y <= e.ymax;

/** The centre of a polygon's largest ring (its area centroid), for the area label when the map gives none. */
function ringCentroid(rings) {
  let best = null, bestArea = 0;
  for (const r of rings) {
    const a = shoelace(r);
    if (Math.abs(a) > Math.abs(bestArea)) { best = r; bestArea = a; }
  }
  if (!best) return null;
  let cx = 0, cy = 0;
  for (let i = 0, n = best.length; i < n; i++) {
    const [x1, y1] = best[i], [x2, y2] = best[(i + 1) % n], c = x1 * y2 - x2 * y1;
    cx += (x1 + x2) * c; cy += (y1 + y2) * c;
  }
  return [cx / (6 * bestArea), cy / (6 * bestArea)];
}

/**
 * Every dimension label for the features in one view.
 * @param features  [{ rings } | { paths }, labelPoint?: [x, y]] in map coordinates (ArcGIS JSON geometry)
 * @param o  { measure (from measurer), extent { xmin, ymin, xmax, ymax }, resolution (map units per pixel),
 *             unit, areaUnit, decimals, showArea, showBearings, bearingFormat ('dms' | 'decimal'),
 *             lineLength ('segments' | 'total'), fontPx, locale }
 * @returns [{ kind: 'side' | 'line' | 'bearing' | 'area', x, y, angle, text }]
 *   A side's bearing is a label of its own (so it can have its own colour), after the length in reading order.
 */
export function dimensionLabels(features, o) {
  const { measure, extent, resolution } = o;
  const fontPx = o.fontPx ?? 11, decimals = o.decimals ?? 2, locale = o.locale ?? 'en-US';
  const length = m => formatLength(m, o.unit, decimals, locale);
  const lift = (fontPx * 0.75 + 2) * resolution;     // how far above its line a label sits
  const q = resolution / 100;                        // shared corners closer than 1/100 of a pixel are the same point
  const seen = new Set();
  const out = [];
  const near = new Map();                            // text -> anchors already used, to drop near-twins of one side

  /** The visible part of a segment and how long it looks on screen, or null when it's out of view. */
  const visible = (a, b) => {
    const part = clipSegment(a, b, extent);
    return part && { part, px: Math.hypot(part[1][0] - part[0][0], part[1][1] - part[0][1]) / resolution };
  };
  /**
   * A length label just above the middle of a segment's visible part, and its bearing after it (in reading order,
   * the pair centred on the middle). A near-twin of a length already placed (the same side digitised twice) is dropped.
   */
  const place = (kind, [a, b], text, bearing = null) => {
    const { angle, normal } = uprightAlong(a, b);
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    let dir = [(b[0] - a[0]) / len, (b[1] - a[1]) / len];
    if (dir[0] < 0 || (dir[0] === 0 && dir[1] < 0)) dir = [-dir[0], -dir[1]];       // the way the text reads
    const mx = (a[0] + b[0]) / 2 + normal[0] * lift, my = (a[1] + b[1]) / 2 + normal[1] * lift;
    const twins = near.get(text) ?? [];
    if (twins.some(([tx, ty]) => Math.hypot(tx - mx, ty - my) < 1.5 * fontPx * resolution)) return;
    twins.push([mx, my]); near.set(text, twins);
    if (!bearing) { out.push({ kind, x: mx, y: my, angle, text }); return; }
    // Set apart by their likely widths (textWidthPx is generous, for deciding what fits; this is closer to the real thing).
    const wl = text.length * fontPx * 0.5, wb = bearing.length * fontPx * 0.5;
    const shift = px => [dir[0] * px * resolution, dir[1] * px * resolution];
    const [lx, ly] = shift(-(wb + GAP_PX) / 2), [bx, by] = shift((wl + GAP_PX) / 2);
    out.push({ kind, x: mx + lx, y: my + ly, angle, text }, { kind: 'bearing', x: mx + bx, y: my + by, angle, text: bearing });
  };
  const sideKey = (a, b) => {
    const k = p => `${Math.round(p[0] / q)},${Math.round(p[1] / q)}`;
    const [ka, kb] = [k(a), k(b)];
    return ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
  };

  /** One label per segment (polygon sides, or line segments), each side once however many features share it. */
  const labelSegments = (parts, kind) => {
    for (const path of parts) {
      for (let i = 1; i < path.length; i++) {
        const a = path[i - 1], b = path[i];
        if (a[0] === b[0] && a[1] === b[1]) continue;
        const key = sideKey(a, b);
        if (seen.has(key)) continue;
        seen.add(key);
        const v = visible(a, b);
        if (!v) continue;
        const seg = measure.segment(a, b);
        const dist = length(seg.length);
        const bearing = o.showBearings ? formatBearing(seg.bearing, o.bearingFormat, locale) : null;
        // Too short for length and bearing: the length alone, if that fits.
        if (bearing && textWidthPx(dist, fontPx) + GAP_PX + textWidthPx(bearing, fontPx) <= v.px) place(kind, v.part, dist, bearing);
        else if (textWidthPx(dist, fontPx) <= v.px) place(kind, v.part, dist);
      }
    }
  };

  for (const f of features) {
    if (f.rings?.length) {
      labelSegments(f.rings, 'side');
      if (!o.showArea) continue;
      const at = f.labelPoint ?? ringCentroid(f.rings);
      if (!at || !inExtent(at, extent)) continue;
      const text = formatArea(measure.area(f.rings), o.areaUnit, decimals, locale);
      const xs = f.rings.flat().map(p => p[0]), ys = f.rings.flat().map(p => p[1]);
      const wide = (Math.max(...xs) - Math.min(...xs)) / resolution, high = (Math.max(...ys) - Math.min(...ys)) / resolution;
      if (textWidthPx(text, fontPx) <= wide && fontPx * 2 <= high) out.push({ kind: 'area', x: at[0], y: at[1], angle: 0, text });
    } else if (f.paths?.length) {
      if (o.lineLength !== 'total') { labelSegments(f.paths, 'line'); continue; }
      // Whole line: its total length once, on its longest visible segment, if the line shows long enough on screen.
      let total = 0, shown = 0, best = null;
      for (const path of f.paths) {
        for (let i = 1; i < path.length; i++) {
          total += measure.segment(path[i - 1], path[i]).length;
          const v = visible(path[i - 1], path[i]);
          if (!v) continue;
          shown += v.px;
          if (!best || v.px > best.px) best = v;
        }
      }
      const text = length(total);
      if (best && textWidthPx(text, fontPx) <= shown) place('line', best.part, text);
    }
  }
  return out;
}

/* ---------------- Settings ---------------- */

/** Problems with widgets.toolConfig.dimensions, as sentences (empty = fine). */
export function dimensionsProblems(c) {
  if (!c || typeof c !== 'object') return ['the settings must be an object.'];
  const out = [];
  if (!inList(c.unit, DIMENSION_UNITS)) out.push('choose a length unit (metres or feet).');
  if (!inList(c.areaUnit, DIMENSION_AREA_UNITS)) out.push('choose an area unit.');
  if (!Number.isInteger(c.decimals) || c.decimals < 0 || c.decimals > MAX_DECIMALS) out.push(`decimals must be a whole number from 0 to ${MAX_DECIMALS}.`);
  if (!inList(c.lineLength, LINE_LENGTH_MODES)) out.push('line labels must be "segments" or "total".');
  if (!inList(c.bearingFormat, BEARING_FORMATS)) out.push('bearings must be "dms" or "decimal".');
  for (const k of ['showArea', 'showBearings']) if (typeof c[k] !== 'boolean') out.push(`${k} must be true or false.`);
  for (const k of ['lengthColor', 'areaColor', 'bearingColor']) if (!/^#[0-9a-f]{6}$/i.test(c[k] ?? '')) out.push(`${k} must be a colour such as #000000.`);
  return out;
}
