// utils.js — DOM helpers, ids, templating, HTML sanitising, colour maths, formatting. No fetching, no SDK.
import { CONFIG } from './config.js';

/** Element builder. Strings become text nodes, so service-supplied text is never parsed as HTML. */
export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else if (k === 'checked' || k === 'value') node[k] = v;
    else node.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

/** replaceChildren that skips null/false and flattens arrays (conditional UI pieces are common). */
export function fill(node, ...kids) {
  node.replaceChildren(...kids.flat(Infinity).filter(k => k != null && k !== false));
  return node;
}

/** append that skips null/false and flattens arrays. */
export function add(node, ...kids) {
  node.append(...kids.flat(Infinity).filter(k => k != null && k !== false));
  return node;
}

export function uid(prefix) {
  const r = globalThis.crypto?.randomUUID?.() ?? Math.random().toString(16).slice(2) + Date.now().toString(16);
  return `${prefix}-${r.replace(/-/g, '').slice(0, 8)}`;
}

export function formatDateTime(value) {
  if (!value) return '';
  return new Date(value).toLocaleString('en-ZA', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export function downloadJson(obj, filename) {
  const blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' });
  const a = el('a', { href: URL.createObjectURL(blob), download: filename });
  document.body.append(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 0);
}

/** Which side of the map a half-width window opens on (Editing, spatial relationships). Full width ignores it. */
export const WINDOW_SIDES = [['left', 'Left'], ['right', 'Right']];
export const isWindowSide = id => WINDOW_SIDES.some(([s]) => s === id);
/** The left edge of a half-width window px wide on that side of the map rect ({ left, width }). */
export const halfWindowLeft = (m, px, side) => (side === 'right' ? m.left + m.width - px : m.left);

export const slug = s => (s || 'map').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'map';

export function moveItem(arr, index, delta) {
  const j = index + delta;
  if (index < 0 || j < 0 || j >= arr.length) return;
  [arr[index], arr[j]] = [arr[j], arr[index]];
}

/**
 * Known ids in a chosen order: the ids `order` names first (unknown and repeated ones skipped), then any it
 * leaves out in their default order. An empty or missing order is the default order.
 * Works on ids or on [id, label] pairs.
 */
export function inOrder(defaults, order) {
  const idOf = x => (Array.isArray(x) ? x[0] : x);
  const byId = new Map(defaults.map(x => [idOf(x), x]));
  const first = [...new Set(Array.isArray(order) ? order : [])].filter(id => byId.has(id)).map(id => byId.get(id));
  return [...first, ...defaults.filter(x => !first.includes(x))];
}

/** Item id from a bare id, an item page URL, or a viewer URL with ?webmap= / ?id=. */
export function parseItemId(text) {
  const t = (text || '').trim();
  const m = t.match(/(?:[?&#](?:id|webmap|appid)=)?([0-9a-f]{32})/i);
  return m ? m[1].toLowerCase() : null;
}

/* ---------- Templates: {FIELD} placeholders filled from feature attributes ---------- */

/** Case-insensitive attribute lookup. */
export function attr(attrs, name) {
  if (!attrs) return undefined;
  if (name in attrs) return attrs[name];
  const key = Object.keys(attrs).find(k => k.toLowerCase() === String(name).toLowerCase());
  return key ? attrs[key] : undefined;
}

export const encoders = {
  url: v => encodeURIComponent(v ?? ''),
  sql: v => String(v ?? '').replace(/'/g, "''"),     // for values inside '...' in a where clause
  text: v => String(v ?? '')
};

/** Missing values return null so callers can refuse to run a query with a hole in it. */
export function fillTemplate(tpl, attrs, encode = encoders.text) {
  let missing = false;
  const out = String(tpl ?? '').replace(/\{([^{}]+)\}/g, (_, name) => {
    const v = attr(attrs, name.trim());
    if (v == null || v === '') { missing = true; return ''; }
    return encode(v);
  });
  return missing ? null : out;
}

/** True when a URL is http(s) and its host is on the enrichment allowlist. */
export function isAllowedHost(url) {
  try {
    const u = new URL(url.replace(/\{[^{}]+\}/g, 'x'), location.href);
    if (!/^https?:$/.test(u.protocol)) return false;
    return CONFIG.enrichmentHosts.some(h => (h.startsWith('.') ? u.hostname.endsWith(h) : u.hostname === h));
  } catch { return false; }
}

export const isHttpUrl = url => /^https?:\/\//i.test((url || '').replace(/\{[^{}]+\}/g, 'x'));

/* ---------- HTML from web map popups (text elements) ---------- */
const ALLOWED_TAGS = new Set(['A', 'B', 'STRONG', 'I', 'EM', 'U', 'BR', 'P', 'DIV', 'SPAN', 'UL', 'OL', 'LI',
  'TABLE', 'THEAD', 'TBODY', 'TR', 'TD', 'TH', 'H1', 'H2', 'H3', 'H4', 'SMALL', 'SUB', 'SUP', 'HR']);

export const escapeHtml = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** Keeps formatting tags and safe links; drops scripts, styles, event handlers and everything else. */
export function sanitizeHtml(html) {
  const doc = new DOMParser().parseFromString(`<div>${html}</div>`, 'text/html');
  const out = document.createDocumentFragment();
  const walk = (src, dest) => {
    for (const n of [...src.childNodes]) {
      if (n.nodeType === 3) { dest.append(document.createTextNode(n.textContent)); continue; }
      if (n.nodeType !== 1) continue;
      if (!ALLOWED_TAGS.has(n.tagName)) { if (!['SCRIPT', 'STYLE', 'IFRAME', 'OBJECT'].includes(n.tagName)) walk(n, dest); continue; }
      const copy = document.createElement(n.tagName.toLowerCase());
      if (n.tagName === 'A') {
        const href = n.getAttribute('href') || '';
        if (/^(https?:|mailto:)/i.test(href)) { copy.setAttribute('href', href); copy.setAttribute('target', '_blank'); copy.setAttribute('rel', 'noopener'); }
      }
      for (const a of ['colspan', 'rowspan']) if (n.hasAttribute(a)) copy.setAttribute(a, n.getAttribute(a));
      walk(n, copy);
      dest.append(copy);
    }
  };
  walk(doc.body.firstChild, out);
  return out;
}

/* ---------- Colour ---------- */
export const isHex = v => /^#[0-9a-f]{6}$/i.test(v || '');

export function hexToRgb(hex) {
  const n = parseInt((hex || '#000000').slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** WCAG 2 contrast ratio between two #rrggbb colours. */
export function contrastRatio(a, b) {
  const lum = hex => {
    const [r, g, bl] = hexToRgb(hex).map(v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; });
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [l1, l2] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (l1 + 0.05) / (l2 + 0.05);
}

export function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(new Error('Couldn\'t read that file.'));
    r.readAsDataURL(file);
  });
}

/* ---------- CSV ---------- */
const csvCell = v => {
  const s = String(v ?? '');
  return /[",\n\r;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** columns [{ name, label }], rows [{ cells: { [name]: { text } } }] -> CSV text (UTF-8 BOM for Excel). */
export function toCsv(columns, rows) {
  const lines = [columns.map(c => csvCell(c.label)).join(',')];
  for (const r of rows) lines.push(columns.map(c => csvCell(r.cells[c.name]?.text === '—' ? '' : r.cells[c.name]?.text)).join(','));
  return `\uFEFF${lines.join('\r\n')}`;
}

export function downloadText(text, filename, type = 'text/csv;charset=utf-8') {
  downloadBlob(new Blob([text], { type }), filename);
}

export function downloadBlob(blob, filename) {
  const a = el('a', { href: URL.createObjectURL(blob), download: filename });
  document.body.append(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 0);
}

/** Downloads a data: URL (e.g. a map screenshot) through a blob, which browsers handle better for large images. */
export async function downloadDataUrl(dataUrl, filename) {
  const blob = await (await fetch(dataUrl)).blob();
  const a = el('a', { href: URL.createObjectURL(blob), download: filename });
  document.body.append(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 0);
}

/* ---------- Coordinates ---------- */
export function toDMS(value, isLat) {
  const hemi = isLat ? (value < 0 ? 'S' : 'N') : (value < 0 ? 'W' : 'E');
  let v = Math.abs(value);
  const d = Math.floor(v); v = (v - d) * 60;
  const m = Math.floor(v); const s = (v - m) * 60;
  return `${d}°${String(m).padStart(2, '0')}′${s.toFixed(2).padStart(5, '0')}″${hemi}`;
}

export const formatLatLon = (lat, lon, format = 'dd') =>
  format === 'dms' ? `${toDMS(lat, true)}  ${toDMS(lon, false)}` : `${lat.toFixed(5)}, ${lon.toFixed(5)}`;

/**
 * Parse one coordinate written as decimal degrees (-34.4187) or degrees-minutes-seconds
 * (34°25'7.3"S, 34 25 7.3 S). Returns a signed number or null.
 */
export function parseCoordinate(text) {
  const t = String(text ?? '').trim().toUpperCase().replace(',', '.');
  if (!t) return null;
  if (/^[+-]?\d+(\.\d+)?$/.test(t)) return Number(t);
  const hemi = t.match(/[NSEW]/)?.[0] ?? '';
  const nums = t.replace(/[NSEW]/g, ' ').match(/[+-]?\d+(\.\d+)?/g);
  if (!nums?.length || nums.length > 3) return null;
  const [d, m = 0, s = 0] = nums.map(Number);
  if (m >= 60 || s >= 60) return null;
  const v = Math.abs(d) + m / 60 + s / 3600;
  return (d < 0 || hemi === 'S' || hemi === 'W') ? -v : v;
}
