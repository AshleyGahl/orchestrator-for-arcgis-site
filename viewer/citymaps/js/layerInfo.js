// layerInfo.js — a layer's information panel in Details (the (i) beside CSV): the rows the author typed in
// Orchestration (their own labels and values), and optionally facts read from the layer's service.
// Pure: no DOM, no network. Values are plain text; links and e-mail addresses are found here, and no HTML from
// the author or the service is ever shown.
//   manifest.details[key].info = { rows: [{ label, value }], service?: true }

export const INFO_ROWS_MAX = 30;
export const INFO_LABEL_MAX = 60;
export const INFO_VALUE_MAX = 2000;

/** True when the panel has something to show, so the (i) button appears. */
export const hasInfo = info => Boolean(info && (info.service === true || (info.rows ?? []).some(r => r?.label?.trim() || r?.value?.trim())));

const LINK_RE = /(https:\/\/[^\s<>"]+[^\s<>".,;:!?)\]]|[\w.+-]+@[\w-]+(?:\.[\w-]+)+)/g;

/** A value split into text and links: [{ text, href? }]. https:// addresses and e-mail addresses become links. */
export function linkParts(value) {
  const text = String(value ?? '');
  const parts = [];
  let at = 0;
  for (const m of text.matchAll(LINK_RE)) {
    if (m.index > at) parts.push({ text: text.slice(at, m.index) });
    parts.push({ text: m[0], href: m[0].includes('@') && !m[0].startsWith('https://') ? `mailto:${m[0]}` : m[0] });
    at = m.index + m[0].length;
  }
  if (at < text.length) parts.push({ text: text.slice(at) });
  return parts;
}

/** The author's rows ready to show: empty rows dropped, values split into text and links. */
export function infoRows(info) {
  return (info?.rows ?? [])
    .filter(r => r?.label?.trim() || r?.value?.trim())
    .map(r => ({ label: r.label.trim(), parts: linkParts(r.value?.trim() ?? '') }));
}

/**
 * Switches "also show the service's details" on or off for many layers at once (Orchestration's All / None
 * buttons). Switching off takes the layer out again when it has no rows of its own, so a manifest never carries
 * an entry with nothing in it.
 * @param layerInfo  draft.layerInfo ({ layers: { key: { rows, service? } } }) — changed in place
 * @param keys       the layer keys to change
 * @param on         true to show the service's details, false to stop showing them
 */
export function setServiceOn(layerInfo, keys, on) {
  layerInfo.layers ??= {};
  for (const key of keys) {
    if (on) {
      layerInfo.layers[key] ??= { rows: [] };
      layerInfo.layers[key].rows ??= [];
      layerInfo.layers[key].service = true;
    } else if (layerInfo.layers[key]) {
      delete layerInfo.layers[key].service;
      if (!(layerInfo.layers[key].rows ?? []).some(r => r?.label?.trim() || r?.value?.trim())) delete layerInfo.layers[key];
    }
  }
  return layerInfo;
}

/** Problems with a layer's info, as sentences (empty when it's fine). Used by manifest.js validate(). */
export function infoProblems(info) {
  if (info == null) return [];
  if (typeof info !== 'object' || Array.isArray(info)) return ['layer information must be an object with rows.'];
  const errors = [];
  if (info.service != null && typeof info.service !== 'boolean') errors.push('"also show the service\'s details" must be true or false.');
  if (info.rows != null && !Array.isArray(info.rows)) return [...errors, 'layer information rows must be a list.'];
  const rows = info.rows ?? [];
  if (rows.length > INFO_ROWS_MAX) errors.push(`layer information can have at most ${INFO_ROWS_MAX} rows.`);
  rows.forEach((r, i) => {
    const n = `layer information row ${i + 1}`;
    if (typeof r?.label !== 'string' || !r.label.trim()) errors.push(`${n} needs a label.`);
    else if (r.label.length > INFO_LABEL_MAX) errors.push(`${n}: the label can be at most ${INFO_LABEL_MAX} characters.`);
    if (r?.value != null && typeof r.value !== 'string') errors.push(`${n}: the value must be text.`);
    else if ((r?.value ?? '').length > INFO_VALUE_MAX) errors.push(`${n}: the value can be at most ${INFO_VALUE_MAX} characters.`);
  });
  return errors;
}

const GEOMETRY_NAMES = {
  esriGeometryPoint: 'Points', esriGeometryMultipoint: 'Points', esriGeometryPolyline: 'Lines',
  esriGeometryPolygon: 'Polygons', esriGeometryEnvelope: 'Rectangles', esriGeometryMultiPatch: '3D shapes'
};

/** Text from the HTML a service description often holds: tags removed, common entities decoded, shortened. */
export function plainText(html, max = 600) {
  const text = String(html ?? '')
    .replace(/<(br|\/p|\/div|\/li)\b[^>]*>/gi, '\n')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')
    .replace(/[ \t]+/g, ' ').replace(/ *\n[\s]*/g, '\n').trim();
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

/** The scale range in words: minScale is the farthest out it draws, maxScale the closest in (0 = no limit). */
export function scaleRange(minScale, maxScale, fmt = n => n.toLocaleString()) {
  const out = Number(minScale) || 0, close = Number(maxScale) || 0;
  if (out && close) return `Between 1:${fmt(out)} and 1:${fmt(close)}`;
  if (out) return `1:${fmt(out)} and closer`;
  if (close) return `Down to 1:${fmt(close)}`;
  return 'At every scale';
}

/**
 * Facts read from the layer's service, as rows: [{ label, value, href? }].
 * @param service  the layer's REST JSON (api.getServiceInfo)
 * @param count    the number of features, or null when it couldn't be counted
 * @param url      the layer's address
 * @param opts.address  false leaves the Service row (the layer's address) out: a public viewer need not publish
 *                      the server it reads from, while the description, type, count, scales and copyright still show
 */
export function serviceFacts(service, count, url, fmt = n => n.toLocaleString(), { address = true } = {}) {
  const s = service ?? {};
  const facts = [];
  const description = plainText(s.description);
  if (description) facts.push({ label: 'Description', value: description });
  const kind = s.type === 'Table' ? 'Table (no shapes)' : GEOMETRY_NAMES[s.geometryType];
  if (kind) facts.push({ label: 'Type', value: kind });
  if (Number.isFinite(count)) facts.push({ label: 'Features', value: fmt(count) });
  if (Array.isArray(s.fields)) facts.push({ label: 'Fields', value: fmt(s.fields.length) });
  if (s.type !== 'Table') facts.push({ label: 'Visible', value: scaleRange(s.minScale, s.maxScale, fmt) });
  const copyright = plainText(s.copyrightText, 300);
  if (copyright) facts.push({ label: 'Copyright', value: copyright });
  if (url && address) facts.push({ label: 'Service', value: url, href: url });
  return facts;
}
