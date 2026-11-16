// externalPages.js — the External pages widget's pure helpers: window widths, checking a page's address, the frame a
// page opens in, and opening GIS viewers at the map's position. Other sites' pages (Experience Builder apps, other
// councils' viewers) open inside the viewer, in a sandboxed frame. No DOM, no SDK.
//
// A page with followMap on is a GIS viewer that takes its position in its address. The author writes placeholders
// where the numbers go ({lon}, {lat}, {zoom}, {scale}, {xmin}…), and the viewer fills them from its own map each time
// the page is shown after the map moved. mapTemplate() writes them for address styles it recognises: x / y / z
// (Cape Farm Mapper), center / level (Map Viewer, Instant Apps) and Experience Builder's map widget viewpoint.
import { addressProblem } from './streams.js';

export const PAGE_WIDTHS = [['half', 'Half: beside the map'], ['full', 'Full: over the map and the panel']];
export const isPageWidth = id => PAGE_WIDTHS.some(([w]) => w === id);

export const PAGES_MAX = 20;

/**
 * The frame a page opens in. Scripts, its own storage and sign-in, forms, downloads and popups (an "open in a new
 * tab" link, an OAuth window) work as they would in a tab of their own; the page can't navigate the viewer itself.
 */
export const PAGE_FRAME = {
  sandbox: 'allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-downloads allow-modals',
  allow: 'fullscreen; geolocation; clipboard-write',
  referrerpolicy: 'strict-origin-when-cross-origin'
};

/**
 * The frame for one page (PAGE_FRAME). A page on the viewer's own site loses allow-same-origin: with scripts and the
 * viewer's origin together it could reach into the viewer and lift its own sandbox. It still runs, without storage or a
 * sign-in of its own there (Open in a new tab gives it those). An address that can't be read counts as the viewer's.
 */
export function pageFrame(url, viewerOrigin) {
  let origin = null;
  try { origin = new URL(String(url ?? '').trim(), viewerOrigin).origin; } catch { /* not an address */ }
  if (origin && origin !== 'null' && origin !== viewerOrigin) return PAGE_FRAME;
  return { ...PAGE_FRAME, sandbox: PAGE_FRAME.sandbox.split(' ').filter(t => t !== 'allow-same-origin').join(' ') };
}

/* ---------- The map's position in a page's address ---------- */

/** The placeholders a followMap address may use. Longitudes and latitudes are WGS 84 degrees. */
export const MAP_PLACEHOLDERS = [
  ['lon', 'longitude of the map\'s centre'],
  ['lat', 'latitude of the map\'s centre'],
  ['zoom', 'zoom level (0 to 23)'],
  ['scale', 'scale, e.g. 4514 for 1:4,514'],
  ['xmin', 'west edge (longitude)'],
  ['ymin', 'south edge (latitude)'],
  ['xmax', 'east edge (longitude)'],
  ['ymax', 'north edge (latitude)']
];
const NAMES = MAP_PLACEHOLDERS.map(([n]) => n);
const DIGITS = { lon: 8, lat: 8, xmin: 8, ymin: 8, xmax: 8, ymax: 8, zoom: 2, scale: 2 };
const ANY_PLACEHOLDER = /\{([A-Za-z_]+)\}/g;       // JSON braces ({"scale":…) never match: a name is letters only

/** A position used to check addresses (Hermanus), and as the example in settings. */
export const SAMPLE_POSITION = { lon: 19.23447, lat: -34.41993, zoom: 15, scale: 18055.95, xmin: 19.21, ymin: -34.43, xmax: 19.26, ymax: -34.41 };

/** The map placeholders in an address, each once, in order. */
export const mapPlaceholders = url => [...new Set([...String(url ?? '').matchAll(ANY_PLACEHOLDER)].map(m => m[1]).filter(n => NAMES.includes(n)))];
const unknownPlaceholders = url => [...new Set([...String(url ?? '').matchAll(ANY_PLACEHOLDER)].map(m => m[1]).filter(n => !NAMES.includes(n)))];

/**
 * The address with the map's position in it. pos: { lon, lat, zoom, scale, xmin, ymin, xmax, ymax } (a missing value,
 * or no position at all, leaves that number empty, so the page opens where it would by itself).
 */
export function fillMapPosition(url, pos) {
  return String(url ?? '').trim().replace(ANY_PLACEHOLDER, (all, name) => {
    if (!NAMES.includes(name)) return all;
    const v = pos?.[name];
    return Number.isFinite(v) ? String(Number(v.toFixed(DIGITS[name]))) : '';
  });
}

/**
 * Why this address can't be opened as a page from a published viewer, or '' when it can: https:// (http://localhost
 * only, for testing), no user name and password, no token or key in the query, and placeholders only when the page
 * opens at the map's position (followMap). Whether the site lets other sites show it in a frame can't be checked
 * from here; the viewer offers "Open in a new tab" for that.
 */
export function pageUrlProblem(url, followMap = false) {
  const text = String(url ?? '').trim();
  if (!text) return 'Enter the page address.';
  const problem = addressProblem(fillMapPosition(text, SAMPLE_POSITION), { noun: 'page' });
  if (problem) return problem;
  const names = mapPlaceholders(text);
  if (followMap) {
    const unknown = unknownPlaceholders(text);
    if (unknown.length) return `{${unknown[0]}} isn't a map position. Use ${NAMES.map(n => `{${n}}`).join(', ')}.`;
    if (!names.length) return 'Put the map\'s position in the address: {lon}, {lat} and {zoom} or {scale} where the numbers go (Fill in the map\'s position does it for addresses it knows), or untick It\'s a GIS viewer.';
  } else if (names.length) {
    return `The address has {${names[0]}} in it: tick It's a GIS viewer, or put a number there.`;
  }
  return '';
}

/** The page's host, for the window and the settings ("gis.elsenburg.com"); '' when the address isn't valid. */
export function pageHost(url) {
  try { return new URL(String(url ?? '').trim()).hostname; } catch { return ''; }
}

/* ---------- Writing the placeholders for addresses we recognise ---------- */

/** "a=1&b=2" -> [[key, value]] as written (nothing decoded, so placeholders and encoded JSON survive). */
const splitParams = text => (text ? text.split('&').filter(Boolean).map(p => { const i = p.indexOf('='); return i < 0 ? [p, null] : [p.slice(0, i), p.slice(i + 1)]; }) : []);
const joinParams = list => list.map(([k, v]) => (v == null ? k : `${k}=${v}`)).join('&');
const isNumber = v => v != null && /^-?\d+(\.\d+)?$/.test(decodeURIComponent(v).trim());

/** Splits an address into base, query and hash, as written. */
function parts(url) {
  const text = String(url ?? '').trim();
  const h = text.indexOf('#');
  const beforeHash = h < 0 ? text : text.slice(0, h);
  const q = beforeHash.indexOf('?');
  return { base: q < 0 ? beforeHash : beforeHash.slice(0, q), query: q < 0 ? null : beforeHash.slice(q + 1), hash: h < 0 ? null : text.slice(h + 1) };
}
const build = ({ base, query, hash }) => `${base}${query != null ? `?${query}` : ''}${hash != null ? `#${hash}` : ''}`;

/** x / y / z (Cape Farm Mapper and similar): the numbers become {lon}, {lat}, {zoom}; a scale s the page works out from z is dropped. */
function xyzTemplate(params) {
  const get = k => params.find(([key]) => key.toLowerCase() === k);
  if (!isNumber(get('x')?.[1]) || !isNumber(get('y')?.[1])) return null;
  const hasZoom = Boolean(get('z'));
  return params
    .filter(([k]) => !(hasZoom && k.toLowerCase() === 's'))
    .map(([k, v]) => {
      const key = k.toLowerCase();
      return key === 'x' ? [k, '{lon}'] : key === 'y' ? [k, '{lat}'] : key === 'z' ? [k, '{zoom}'] : key === 's' ? [k, '{scale}'] : [k, v];
    });
}

/** center=lon,lat with level, zoom or scale (Map Viewer, Instant Apps): level or zoom is added when there's none. */
function centerTemplate(params) {
  const get = k => params.find(([key]) => key.toLowerCase() === k);
  const c = get('center')?.[1];
  if (c == null || !/^-?\d+(\.\d+)?(,|%2C)-?\d+(\.\d+)?/i.test(c)) return null;
  const out = params.map(([k, v]) => {
    const key = k.toLowerCase();
    return key === 'center' ? [k, '{lon},{lat}'] : key === 'level' || key === 'zoom' ? [k, '{zoom}'] : key === 'scale' ? [k, '{scale}'] : [k, v];
  });
  if (!['level', 'zoom', 'scale'].some(k => get(k))) out.push(['level', '{zoom}']);
  return out;
}

/** Experience Builder: is this an Experience Builder app's address? */
export function isExperienceBuilder(url) {
  try {
    const u = new URL(String(url ?? '').trim());
    return /\/apps\/experiencebuilder\/experience\/?$/i.test(u.pathname) || (u.hostname === 'experience.arcgis.com' && /^\/experience\/[0-9a-f]{32}/i.test(u.pathname));
  } catch { return false; }
}

/** Experience Builder: the portal and item behind an app's address ({ portalUrl, itemId }), or null. */
export function experienceItem(url) {
  try {
    const u = new URL(String(url ?? '').trim());
    if (u.hostname === 'experience.arcgis.com') {
      const id = u.pathname.split('/')[2];
      return /^[0-9a-f]{32}$/i.test(id ?? '') ? { portalUrl: 'https://www.arcgis.com', itemId: id } : null;
    }
    const i = u.pathname.toLowerCase().indexOf('/apps/experiencebuilder/');
    const id = u.searchParams.get('id');
    return i >= 0 && /^[0-9a-f]{32}$/i.test(id ?? '') ? { portalUrl: `${u.origin}${u.pathname.slice(0, i)}`, itemId: id } : null;
  } catch { return null; }
}

/** Experience Builder: the map widgets in an app's configuration (the item's data): [{ id, label }]. */
export const experienceMapWidgets = config => Object.entries(config?.widgets ?? {})
  .filter(([, w]) => /arcgis-map\/?$/.test(w?.uri ?? ''))
  .map(([id, w]) => ({ id, label: w.label || id }));

/**
 * Experience Builder's map widget opens at a viewpoint in the address: #<widget id>=viewpoint:{rotation, scale,
 * targetGeometry} (URL-encoded JSON). Its "center:" form isn't used: it ignores longitudes and latitudes.
 */
export function experienceViewpoint(widgetId) {
  const json = encodeURIComponent(JSON.stringify({ rotation: 0, scale: '@S', targetGeometry: { spatialReference: { wkid: 4326 }, x: '@X', y: '@Y' } }));
  return `${widgetId}=viewpoint:${json.replace('%22%40S%22', '{scale}').replace('%22%40X%22', '{lon}').replace('%22%40Y%22', '{lat}')}`;
}

/**
 * The address with placeholders for the map's position, for the styles we recognise, or null.
 * @param exbMapWidget  an Experience Builder app's map widget id (experienceMapWidgets), read from its item
 * @returns { url, style } style: 'xyz' | 'center' | 'experience'
 */
export function mapTemplate(url, { exbMapWidget = '' } = {}) {
  const p = parts(url);
  if (!p.base) return null;
  if (isExperienceBuilder(url)) {
    if (!exbMapWidget) return null;
    const keep = splitParams(p.hash).filter(([k]) => k !== exbMapWidget);
    const hash = [joinParams(keep), experienceViewpoint(exbMapWidget)].filter(Boolean).join('&');
    // On ArcGIS Enterprise the hash needs a query before it (Esri's documentation); the app address already has ?id=.
    return { url: build({ ...p, hash }), style: 'experience' };
  }
  for (const where of ['hash', 'query']) {
    const params = splitParams(p[where]);
    for (const [style, make] of [['xyz', xyzTemplate], ['center', centerTemplate]]) {
      const out = make(params);
      if (out) return { url: build({ ...p, [where]: joinParams(out) }), style };
    }
  }
  return null;
}
