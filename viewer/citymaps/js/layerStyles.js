// layerStyles.js — Layer styles: several styles for one layer (e.g. parcels by valuation, by type, outline only) that
// people switch between in the viewer's Layers list. The service is never published twice: a style is drawn over the
// layer (keeping its own outlines) or replaces the layer's renderer.
// Pure: no DOM, no SDK, no fetch. Builds ArcGIS REST renderer JSON (drawingInfo.renderer) that the viewer hands to the
// SDK's renderer jsonUtils, and the statistics queries the Orchestrator runs while the author sets a style up, so the
// published viewer never asks the service for statistics.
//   manifest.layerStyles.layers["<layer key>"] = { start, styles: [style] }
//   start     'webmap' (the web map's own style) or the id of an enabled style: what the viewer opens with
//   style     { id, name, description, enabled, type, field?, values?|minValue?+classes?, other, outline, opacity, fill? }
//     simple       one symbol: fill (#rrggbb, or null for outline only)
//     uniqueValue  values: [{ value, label, color }] (value null = features with no value), on one field
//     classBreaks  minValue and classes: [{ upTo, label, color }], upTo ascending. The first class is
//                  minValue <= x <= upTo; each next one is previous upTo < x <= its upTo (ArcGIS's own rule), so
//                  classes can neither overlap nor leave gaps.
//     other        { show, label, color }: features no class matches (show false: they aren't drawn)
//     outlines     'layer': on a polygon layer, the style's colours are drawn over the layer, which keeps drawing as in the
//                  web map (its own outlines show through: the colours are blended over it); 'own': the style replaces
//                  the layer's style, with its own outline. Points and lines always replace (they have no outlines to keep).
//     outline      { color, width }: polygon outlines and point edges ('own'); a line layer's lines are outline.width wide
//     opacity      0..1, applied to fills (polygons) or to the whole symbol (points, lines), so outlines stay crisp
// A layer with no entry keeps its own style and shows no style choice.

export const WEBMAP_STYLE = 'webmap';
export const WEBMAP_STYLE_NAME = "The web map's style";
export const STYLE_TYPES = Object.freeze({
  simple: 'One symbol', uniqueValue: 'Categories (one colour per value)', classBreaks: 'Ranges of numbers (graduated colours)'
});
export const STYLES_MAX = 12;
export const VALUES_MAX = 100;
export const CLASSES_MAX = 10;
export const NAME_MAX = 60;
export const DESCRIPTION_MAX = 200;
export const LABEL_MAX = 80;
export const NULL_VALUE = '<Null>';             // how ArcGIS renderers name "no value" in a unique value style

export const isStyleType = v => Object.hasOwn(STYLE_TYPES, v);
const isHex = v => /^#[0-9a-f]{6}$/i.test(v || '');

/* ---------------- Colours ---------------- */

/** Ranges run light to dark; categories are the Okabe-Ito colours, readable with colour blindness. */
export const RAMPS = Object.freeze({
  'yellow-red': { name: 'Yellow to red', stops: ['#ffffb2', '#fecc5c', '#fd8d3c', '#f03b20', '#bd0026'] },
  blues: { name: 'Blues', stops: ['#eff3ff', '#bdd7e7', '#6baed6', '#3182bd', '#08519c'] },
  greens: { name: 'Greens', stops: ['#edf8e9', '#bae4b3', '#74c476', '#31a354', '#006d2c'] },
  purples: { name: 'Purples', stops: ['#f2f0f7', '#cbc9e2', '#9e9ac8', '#756bb1', '#54278f'] },
  viridis: { name: 'Purple to yellow', stops: ['#440154', '#3b528b', '#21918c', '#5ec962', '#fde725'] }
});
export const CATEGORY_COLORS = Object.freeze(['#e69f00', '#56b4e9', '#009e73', '#f0e442', '#0072b2', '#d55e00', '#cc79a7', '#999999']);

const toRgb = hex => { const n = parseInt(hex.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
const toHex = rgb => `#${rgb.map(v => Math.round(v).toString(16).padStart(2, '0')).join('')}`;

/** n colours along a ramp, its ends included. */
export function rampColors(rampId, n) {
  const stops = (RAMPS[rampId] ?? RAMPS['yellow-red']).stops.map(toRgb);
  if (n <= 1) return [toHex(stops[stops.length - 1])];
  return Array.from({ length: n }, (_, i) => {
    const t = (i / (n - 1)) * (stops.length - 1);
    const a = Math.floor(t), b = Math.min(a + 1, stops.length - 1), f = t - a;
    return toHex(stops[a].map((v, k) => v + (stops[b][k] - v) * f));
  });
}

/** The colour for the i-th category (the list repeats after eight). */
export const categoryColor = i => CATEGORY_COLORS[i % CATEGORY_COLORS.length];

/* ---------------- Fields ---------------- */

const NUMBER_TYPES = new Set(['esriFieldTypeSmallInteger', 'esriFieldTypeInteger', 'esriFieldTypeBigInteger', 'esriFieldTypeDouble', 'esriFieldTypeSingle',
  'small-integer', 'integer', 'big-integer', 'double', 'single']);
const CATEGORY_TYPES = new Set([...NUMBER_TYPES, 'esriFieldTypeString', 'string']);
const SHAPE_FIELD = /^shape[._]|st_?(area|length)|\(/i;
const SYSTEM_FIELD = /^(objectid|fid|globalid|oid)$/i;

/** Fields a classBreaks style can use: numbers, not ObjectIDs or shape measures. */
export const numberFields = (fields = []) => fields.filter(f => NUMBER_TYPES.has(f.type) && !SHAPE_FIELD.test(f.name) && !SYSTEM_FIELD.test(f.name));
/** Fields a uniqueValue style can use: text and numbers, not ObjectIDs, GlobalIDs or shape measures. */
export const categoryFields = (fields = []) => fields.filter(f => CATEGORY_TYPES.has(f.type) && !SHAPE_FIELD.test(f.name) && !SYSTEM_FIELD.test(f.name));

/** Field names that suggest money or accounts: the editor warns that their values reach everyone who sees the layer. */
const FINANCIAL = /valu|price|rate|levy|levies|tariff|debt|arrear|outstand|balance|owing|amount|account|acc_?no|income|salary|municipal_?val|mv$/i;
export const looksFinancial = (name = '') => FINANCIAL.test(name);

/* ---------------- New styles ---------------- */

/** An id not yet used on this layer, from the style's name. */
export function styleId(name, taken = []) {
  const base = String(name ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'style';
  const used = new Set([WEBMAP_STYLE, ...taken]);
  if (!used.has(base)) return base;
  for (let i = 2; ; i++) if (!used.has(`${base}-${i}`)) return `${base}-${i}`;
}

const defaultOutline = () => ({ color: '#6e6e6e', width: 0 });   // none: a style's own outline is off until set

export const OUTLINE_CHOICES = Object.freeze({
  layer: "The layer's own outlines (the colours are drawn over the layer)",
  own: "The style's own outline (it replaces the layer's style)"
});
/** The style's outlines setting: 'layer' unless set, except for an outline-only style (nothing to draw over the layer). */
export const outlinesOf = style => style?.outlines ?? (style?.type === 'simple' && style.fill == null ? 'own' : 'layer');
/** True when the style is drawn over the layer (a polygon layer, keeping its own outlines) rather than replacing its style. */
export const drawsOver = (style, geometryType) => outlinesOf(style) === 'layer' && geometryKind(geometryType) === 'polygon';

/** A new style of the given type; taken: the ids already on the layer. */
export function newStyle(type, taken = []) {
  const name = { simple: 'Outline only', uniqueValue: 'By category', classBreaks: 'By value' }[type] ?? 'New style';
  const base = { id: styleId(name, taken), name, description: '', enabled: true, type, outline: defaultOutline(), opacity: 0.7 };
  if (type === 'simple') return { ...base, outlines: 'own', fill: null, outline: { color: '#333333', width: 1 } };
  if (type === 'uniqueValue') return { ...base, outlines: 'layer', field: '', values: [], other: { show: true, label: 'Other', color: '#cccccc' } };
  return { ...base, outlines: 'layer', field: '', minValue: 0, classes: [], other: { show: false, label: 'No value', color: '#cccccc' } };
}

/** A copy of a style with its own id and name. */
export function duplicateStyle(style, taken = []) {
  const name = `${style.name} (copy)`.slice(0, NAME_MAX);
  return { ...structuredClone(style), id: styleId(name, taken), name };
}

/* ---------------- Classes and categories from statistics ---------------- */

/** A number rounded to two significant figures, so class bounds read well ("1,900,000", not "1,874,312.5"). */
export function niceNumber(v) {
  if (!Number.isFinite(v) || v === 0) return v;
  const p = 10 ** (Math.floor(Math.log10(Math.abs(v))) - 1);
  return Math.round(v / p) * p;
}

/** Upper bounds of n classes of equal width between min and max (the last is max itself). */
export function equalBreaks(min, max, n) {
  if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min || n < 1) return [];
  const step = (max - min) / n;
  return uniqueAscending([...Array.from({ length: n - 1 }, (_, i) => niceNumber(min + step * (i + 1))), max]).filter(v => v > min);
}

/** Upper bounds from the service's percentiles (each class about the same number of features), then max. */
export function quantileBreaks(percentiles, min, max) {
  return uniqueAscending([...percentiles.map(niceNumber), max]).filter(v => Number.isFinite(v) && v > min && v <= max);
}

const uniqueAscending = vs => [...new Set(vs.filter(Number.isFinite))].sort((a, b) => a - b);

/** The labels a set of classes reads as: "Up to 200,000", "200,000 to 750,000", …, "3,000,000 or more" for the last. */
export function breakLabels(minValue, upTos, fmt = n => n.toLocaleString()) {
  return upTos.map((v, i) => {
    if (i === 0) return minValue > 0 ? `${fmt(minValue)} to ${fmt(v)}` : `Up to ${fmt(v)}`;
    if (i === upTos.length - 1 && upTos.length > 2) return `More than ${fmt(upTos[i - 1])}`;
    return `${fmt(upTos[i - 1])} to ${fmt(v)}`;
  });
}

/** Classes from upper bounds: labels from breakLabels, colours along the ramp. */
export function classesFrom(minValue, upTos, rampId, fmt) {
  const labels = breakLabels(minValue, upTos, fmt);
  const colors = rampColors(rampId, upTos.length);
  return upTos.map((upTo, i) => ({ upTo, label: labels[i], color: colors[i] }));
}

/** REST statistics for a number field: min, max, count and (when the service can) the percentiles for n classes. */
export function rangeQuery(field, n = 5, percentiles = false) {
  const stat = (statisticType, name, value) => ({ statisticType, onStatisticField: field, outStatisticFieldName: name, ...(value != null ? { statisticParameters: { value } } : {}) });
  const out = [stat('min', 'styleMin'), stat('max', 'styleMax'), stat('count', 'styleCount')];
  if (percentiles) for (let i = 1; i < n; i++) out.push(stat('percentile_cont', `styleP${i}`, i / n));
  return { where: '1=1', outStatistics: out, returnGeometry: false };
}

/** { min, max, count, percentiles: [] } from a rangeQuery answer's first feature. */
export function readRange(features) {
  const a = features?.[0]?.attributes ?? {};
  const get = name => { const k = Object.keys(a).find(x => x.toLowerCase() === name.toLowerCase()); return k == null || a[k] == null ? NaN : Number(a[k]); };
  const percentiles = [];
  for (let i = 1; Number.isFinite(get(`styleP${i}`)); i++) percentiles.push(get(`styleP${i}`));
  return { min: get('styleMin'), max: get('styleMax'), count: get('styleCount'), percentiles };
}

export const CLASS_METHODS = Object.freeze({ quantile: 'About the same number of features in each', equal: 'Equal ranges' });

/** Whether the service can read percentiles (needed for quantile classes) and statistics at all, from its REST JSON. */
export const canPercentiles = info => info?.advancedQueryCapabilities?.supportsPercentileStatistics === true;
export const canStatistics = info => info?.advancedQueryCapabilities?.supportsStatistics !== false && info?.supportsStatistics !== false;

/**
 * Classes from a readRange answer: quantiles when there are percentiles (method 'quantile'), else equal ranges.
 * Values never go below 0 for the lowest class when the data starts at 0.
 * @returns {{ minValue, classes, method } | { why }}  method: the one actually used
 */
export function suggestClasses(range, { method = 'quantile', n = 5, ramp = 'yellow-red', fmt } = {}) {
  const { min, max, percentiles = [] } = range ?? {};
  if (!Number.isFinite(min) || !Number.isFinite(max)) return { why: 'the field has no values' };
  if (max <= min) return { why: `every feature has the same value (${fmt ? fmt(min) : min})` };
  const used = method === 'quantile' && percentiles.length ? 'quantile' : 'equal';
  const upTos = used === 'quantile' ? quantileBreaks(percentiles, min, max) : equalBreaks(min, max, n);
  return { minValue: min, classes: classesFrom(min, upTos, ramp, fmt), method: used };
}

/** REST …/query parameters for a statistics query from rangeQuery or valuesQuery: lists as text, objects as JSON. */
export const restQuery = q => Object.fromEntries(Object.entries(q).map(([k, v]) =>
  [k, Array.isArray(v) ? (v.some(x => typeof x === 'object') ? JSON.stringify(v) : v.join(',')) : String(v)]));

/** REST statistics for a category field: one row per value with its feature count. */
export const valuesQuery = (field, objectIdField) => ({
  where: '1=1', groupByFieldsForStatistics: [field], returnGeometry: false,
  outStatistics: [{ statisticType: 'count', onStatisticField: objectIdField || field, outStatisticFieldName: 'styleCount' }]
});

/**
 * Values from a valuesQuery answer, most features first, at most VALUES_MAX, each with a colour.
 * keep: values the author already has (their labels and colours stay; new ones follow, and kept values the service
 * no longer returns, e.g. typed in for features still to come, go at the end).
 * @returns {{ values: [{ value, label, color }], counts: Map<string, number>, more: number }}
 *   counts: features per value (String(value)), for showing while editing (not kept in the manifest); more: values left out by the limit
 */
export function valuesFromCounts(features, field, keep = []) {
  const rows = (features ?? []).map(f => {
    const a = f.attributes ?? {};
    const k = Object.keys(a).find(x => x.toLowerCase() === field.toLowerCase());
    const c = Object.keys(a).find(x => x.toLowerCase() === 'stylecount');
    return { value: k == null ? null : a[k], count: Number(a[c]) || 0 };
  }).sort((x, y) => y.count - x.count);
  const known = new Map(keep.map(v => [String(v.value), v]));
  const counts = new Map(rows.map(r => [String(r.value), r.count]));
  let next = keep.length;
  const values = rows.slice(0, VALUES_MAX).map(r => {
    const had = known.get(String(r.value));
    return had ? { value: had.value, label: had.label, color: had.color } : { value: r.value, label: r.value == null ? 'No value' : String(r.value), color: categoryColor(next++) };
  });
  const listed = new Set(values.map(v => String(v.value)));
  for (const v of keep) if (!listed.has(String(v.value)) && !counts.has(String(v.value)) && values.length < VALUES_MAX) values.push({ value: v.value, label: v.label, color: v.color });
  return { values, counts, more: Math.max(0, rows.length - VALUES_MAX) };
}

/* ---------------- Checks ---------------- */

/** Problems with one style, as sentences (empty when it's fine). Shape only: the fields are checked against the layer by fieldProblems. */
export function styleProblems(style) {
  if (style == null || typeof style !== 'object' || Array.isArray(style)) return ['a style must be an object.'];
  const errors = [];
  if (typeof style.id !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(style.id)) errors.push('its id must be lower-case letters, numbers and dashes.');
  else if (style.id === WEBMAP_STYLE) errors.push(`"${WEBMAP_STYLE}" is kept for the web map's own style.`);
  if (typeof style.name !== 'string' || !style.name.trim()) errors.push('needs a name.');
  else if (style.name.length > NAME_MAX) errors.push(`the name can be at most ${NAME_MAX} characters.`);
  if (style.description != null && (typeof style.description !== 'string' || style.description.length > DESCRIPTION_MAX)) errors.push(`the description must be text of at most ${DESCRIPTION_MAX} characters.`);
  if (style.enabled != null && typeof style.enabled !== 'boolean') errors.push('"enabled" must be true or false.');
  if (!isStyleType(style.type)) return [...errors, '"type" must be "simple", "uniqueValue" or "classBreaks".'];
  if (style.opacity != null && !(typeof style.opacity === 'number' && style.opacity >= 0 && style.opacity <= 1)) errors.push('the opacity must be between 0 and 1.');
  if (style.outlines != null && !Object.hasOwn(OUTLINE_CHOICES, style.outlines)) errors.push(`"outlines" must be "layer" (the layer's own) or "own".`);
  const o = style.outline;
  if (o != null && (!isHex(o.color) || !(typeof o.width === 'number' && o.width >= 0 && o.width <= 10))) errors.push('the outline needs a colour (#rrggbb) and a width from 0 to 10.');
  if (style.type === 'simple') {
    if (style.fill != null && !isHex(style.fill)) errors.push('the fill must be a colour (#rrggbb) or none.');
    else if (style.fill == null && outlinesOf(style) === 'layer') errors.push("outline only with the layer's own outlines draws nothing: give it a fill or its own outline.");
    return errors;
  }
  if (typeof style.field !== 'string' || !style.field.trim()) errors.push('choose the field it draws from.');
  const other = style.other;
  if (other != null && (typeof other.show !== 'boolean' || (other.show && !isHex(other.color)))) errors.push('"other" needs show (true or false) and, when shown, a colour.');
  const label = (x, where) => { if (typeof x?.label !== 'string' || x.label.length > LABEL_MAX) errors.push(`${where} needs a label of at most ${LABEL_MAX} characters.`); };
  const color = (x, where) => { if (!isHex(x?.color)) errors.push(`${where} needs a colour (#rrggbb).`); };

  if (style.type === 'uniqueValue') {
    if (!Array.isArray(style.values) || !style.values.length) return [...errors, 'add at least one value.'];
    if (style.values.length > VALUES_MAX) errors.push(`at most ${VALUES_MAX} values.`);
    const seen = new Set();
    style.values.forEach((v, i) => {
      const where = `value ${i + 1}`;
      if (!(v?.value === null || typeof v?.value === 'string' || typeof v?.value === 'number')) errors.push(`${where} must be text, a number or empty (no value).`);
      else if (seen.has(String(v.value))) errors.push(`${where} ("${v.value ?? 'no value'}") is listed twice.`);
      seen.add(String(v?.value));
      label(v, where); color(v, where);
    });
    return errors;
  }

  if (typeof style.minValue !== 'number' || !Number.isFinite(style.minValue)) errors.push('the lowest value must be a number.');
  if (!Array.isArray(style.classes) || !style.classes.length) return [...errors, 'add at least one class.'];
  if (style.classes.length > CLASSES_MAX) errors.push(`at most ${CLASSES_MAX} classes.`);
  let prev = style.minValue;
  style.classes.forEach((c, i) => {
    const where = `class ${i + 1}`;
    if (typeof c?.upTo !== 'number' || !Number.isFinite(c.upTo)) errors.push(`${where} needs an upper value.`);
    else if (Number.isFinite(prev) && (i === 0 ? c.upTo < prev : c.upTo <= prev)) errors.push(`${where} must end above ${i === 0 ? 'the lowest value' : `class ${i}`} (${prev}).`);
    if (Number.isFinite(c?.upTo)) prev = c.upTo;
    label(c, where); color(c, where);
  });
  return errors;
}

/** Problems with a layer's entry ({ start, styles }), as sentences. Used by manifest.js validate(). */
export function layerStylesProblems(cfg) {
  if (cfg == null || typeof cfg !== 'object' || Array.isArray(cfg)) return ['the settings must be an object.'];
  if (!Array.isArray(cfg.styles)) return ['"styles" must be a list.'];
  const errors = [];
  if (cfg.styles.length > STYLES_MAX) errors.push(`at most ${STYLES_MAX} styles.`);
  const ids = new Set();
  cfg.styles.forEach((s, i) => {
    const where = `style ${i + 1}${s?.name ? ` (${s.name})` : ''}`;
    if (s?.id && ids.has(s.id)) errors.push(`${where}: its id "${s.id}" is used twice.`);
    ids.add(s?.id);
    for (const p of styleProblems(s)) errors.push(`${where}: ${p}`);
  });
  const start = cfg.start ?? WEBMAP_STYLE;
  if (start !== WEBMAP_STYLE) {
    const s = cfg.styles.find(x => x?.id === start);
    if (!s) errors.push(`the starting style "${start}" isn't one of its styles.`);
    else if (s.enabled === false) errors.push(`the starting style "${s.name}" is switched off.`);
  }
  return errors;
}

/**
 * Whether a style can draw on the layer as loaded: its field must be there (it may be missing for someone the
 * service shows fewer fields to) and of a type the style can use.
 * @param fields        the layer's fields ([{ name, type }]) as the service returned them to this person
 * @param geometryType  'point'|'multipoint'|'polyline'|'polygon' or the esriGeometry… names
 * @returns {{ field?: string, why?: string }}  field: the field's name as the layer spells it; why: a sentence fragment
 */
export function fieldProblems(style, fields, geometryType) {
  if (!geometryKind(geometryType)) return { why: `it can't style ${geometryType ? `${geometryType} layers` : 'a layer with no shapes'}` };
  if (style.type === 'simple') return {};
  const f = (fields ?? []).find(x => x.name.toLowerCase() === String(style.field).toLowerCase());
  if (!f) return { why: `the layer has no field ${style.field} (or doesn't share it)` };
  if (style.type === 'classBreaks' && !NUMBER_TYPES.has(f.type)) return { why: `${f.name} doesn't hold numbers` };
  if (style.type === 'uniqueValue' && !CATEGORY_TYPES.has(f.type)) return { why: `${f.name} holds neither text nor numbers` };
  return { field: f.name };
}

/** The style's one-line summary: "Ranges of Valuation, 5 classes". */
export function describeStyle(style) {
  if (style.type === 'simple') return style.fill ? 'One colour' : 'Outline only';
  if (style.type === 'uniqueValue') return `Categories of ${style.field || '(no field)'}, ${style.values?.length ?? 0} value${style.values?.length === 1 ? '' : 's'}`;
  return `Ranges of ${style.field || '(no field)'}, ${style.classes?.length ?? 0} class${style.classes?.length === 1 ? '' : 'es'}`;
}

/** The styles people can choose in the viewer: { id, name, description } for the web map's style, then the enabled ones. */
export const choices = cfg => [{ id: WEBMAP_STYLE, name: WEBMAP_STYLE_NAME, description: '' },
  ...(cfg?.styles ?? []).filter(s => s.enabled !== false).map(s => ({ id: s.id, name: s.name, description: s.description ?? '' }))];

/* ---------------- Renderers ---------------- */

const GEOMETRY_KINDS = { point: 'point', multipoint: 'point', polyline: 'line', polygon: 'polygon',
  esriGeometryPoint: 'point', esriGeometryMultipoint: 'point', esriGeometryPolyline: 'line', esriGeometryPolygon: 'polygon' };
const geometryKind = g => GEOMETRY_KINDS[g] ?? null;

const rgba = (hex, alpha = 1) => [...toRgb(hex), Math.round(Math.max(0, Math.min(1, alpha)) * 255)];

/** The REST symbol for one colour on this kind of geometry. fill null: outline only (polygons). */
function symbolFor(fill, style, kind) {
  const opacity = style.opacity ?? 1;
  const o = outlinesOf(style) === 'layer' ? { color: '#000000', width: 0 } : style.outline ?? defaultOutline();   // over the layer: its own outlines
  if (kind === 'polygon') {
    return {
      type: 'esriSFS', style: 'esriSFSSolid', color: fill ? rgba(fill, opacity) : [0, 0, 0, 0],
      outline: { type: 'esriSLS', style: 'esriSLSSolid', color: rgba(o.color, o.width ? 1 : 0), width: o.width }
    };
  }
  const color = fill ?? o.color;
  if (kind === 'line') return { type: 'esriSLS', style: 'esriSLSSolid', color: rgba(color, opacity), width: Math.max(o.width, 1) };
  return { type: 'esriSMS', style: 'esriSMSCircle', color: rgba(color, opacity), size: 8, outline: { color: rgba(o.color), width: o.width } };
}

/**
 * The style as ArcGIS REST renderer JSON for the layer's geometry, or null when it can't draw there.
 * @param field  the field's name as the layer spells it (fieldProblems().field); defaults to the style's
 */
export function rendererFor(style, geometryType, field = style.field) {
  const kind = geometryKind(geometryType);
  if (!kind) return null;
  const sym = color => symbolFor(color, style, kind);
  const other = style.other?.show ? { defaultSymbol: sym(style.other.color), defaultLabel: style.other.label } : {};
  if (style.type === 'simple') return { type: 'simple', label: style.name, symbol: sym(style.fill ?? null) };
  if (style.type === 'uniqueValue') {
    return {
      type: 'uniqueValue', field1: field, ...other,
      uniqueValueInfos: style.values.map(v => ({ value: v.value == null ? NULL_VALUE : String(v.value), label: v.label, symbol: sym(v.color) }))
    };
  }
  if (style.type === 'classBreaks') {
    return {
      type: 'classBreaks', field, minValue: style.minValue, ...other,
      classBreakInfos: style.classes.map((c, i) => ({ classMinValue: i ? style.classes[i - 1].upTo : style.minValue, classMaxValue: c.upTo, label: c.label, symbol: sym(c.color) }))
    };
  }
  return null;
}
