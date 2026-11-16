// legendLabels.js — Legend labels: a count added to each label of a layer's categorized (unique value) style, e.g.
// "Residential Zone I (1,204)". Only the label text changes; the classes, symbols and colours stay the web map's (or the
// service's). Pure: no DOM, no SDK, no fetch. Works on renderer JSON (drawingInfo.renderer, or an SDK renderer's toJSON()).
//   manifest.legendLabels.layers["<layer key>"] = { mode, countField?, part, refreshSeconds }
//   mode            'field': a column on each feature holds its category's count (the largest value per category is used)
//                   'auto':  the service counts each category's features
//   part            'all' | 'before' | 'after': which side of the first colon in a label to keep ("Agricultural Zone 1: Agriculture")
//   refreshSeconds  0 = read once when the map opens, otherwise one of REFRESH_CHOICES
// A layer with no entry keeps its style's own labels.

export const COUNT_MODES = Object.freeze({ field: 'Count from a column', auto: 'Count the features automatically' });
export const LABEL_PARTS = Object.freeze({ all: 'The whole label', before: 'Only the text before the colon', after: 'Only the text after the colon' });
export const REFRESH_CHOICES = Object.freeze([
  [0, 'Only when the map opens'], [30, 'Every 30 seconds'], [60, 'Every minute'],
  [300, 'Every 5 minutes'], [900, 'Every 15 minutes'], [3600, 'Every hour']
]);
/** The statistics query's output column (unlikely to clash with a real field). */
export const COUNT_OUT_FIELD = 'legendLabelCount';

export const isCountMode = v => Object.hasOwn(COUNT_MODES, v);
export const isLabelPart = v => Object.hasOwn(LABEL_PARTS, v);
export const isRefreshSeconds = v => REFRESH_CHOICES.some(([s]) => s === v);

const COUNT_FIELD_TYPES = new Set(['esriFieldTypeSmallInteger', 'esriFieldTypeInteger', 'esriFieldTypeBigInteger', 'esriFieldTypeDouble', 'esriFieldTypeSingle',
  'small-integer', 'integer', 'big-integer', 'double', 'single']);
// Number fields the database works out from the shape (Shape.STArea(), Shape_Length, st_area(shape)…), never a count.
const SHAPE_FIELD = /^shape[._]|st_?(area|length)|\(/i;
/** The fields that can hold a category's count: numbers, not ObjectIDs or shape measures, not the category itself. */
export const countFields = (fields = [], categoryField = '') =>
  fields.filter(f => COUNT_FIELD_TYPES.has(f.type) && f.name !== categoryField && !SHAPE_FIELD.test(f.name));

/** A new layer entry, with a likely count column picked from countFields when the mode is 'field'. */
export function newLegendLabels(mode, numbers = []) {
  return mode === 'field'
    ? { mode, countField: (numbers.find(f => /count/i.test(f.name)) ?? numbers[0])?.name ?? '', part: 'all', refreshSeconds: 0 }
    : { mode: 'auto', part: 'all', refreshSeconds: 0 };
}

const STYLE_NAMES = {
  simple: 'with one symbol for every feature', classBreaks: 'by ranges of numbers', heatmap: 'as a heat map',
  dotDensity: 'as dot density', dictionary: 'from a symbol dictionary', pieChart: 'as pie charts'
};

/**
 * The field a style puts features into categories by: { field } for a unique value style on one field,
 * otherwise { field: null, why } (a sentence fragment: "its style …").
 */
export function styleCategory(renderer) {
  if (!renderer) return { field: null, why: "its style couldn't be read" };
  if (renderer.type !== 'uniqueValue') return { field: null, why: `it is drawn ${STYLE_NAMES[renderer.type] ?? 'without categories'}` };
  if (renderer.valueExpression) return { field: null, why: 'its categories come from an Arcade expression' };
  if (renderer.field2 || renderer.field3) return { field: null, why: 'its categories combine several fields' };
  const field = renderer.field1 ?? renderer.field;
  return field ? { field } : { field: null, why: 'its style names no field' };
}

/**
 * The style's classes in legend order: [{ label, values: [string] }]. A grouped style (uniqueValueGroups) is read
 * from its groups; a classic one from uniqueValueInfos.
 */
export function styleClasses(renderer) {
  const groups = renderer?.uniqueValueGroups;
  if (Array.isArray(groups) && groups.length) {
    return groups.flatMap(g => (g?.classes ?? []).map(c => ({ label: c?.label ?? '', values: (c?.values ?? []).map(v => String(Array.isArray(v) ? v[0] : v)) })));
  }
  return (renderer?.uniqueValueInfos ?? []).map(i => ({ label: i?.label ?? '', values: [String(i?.value)] }));
}

/** The labels a style shows, in order (to tell whether a refresh changed anything). */
export const labelsOf = renderer => styleClasses(renderer).map(c => c.label);

/** A label with only one side of its first colon kept ("Zone 1: Agriculture" → "Zone 1" or "Agriculture"). */
export function labelPart(text, part = 'all') {
  const s = String(text ?? '');
  const at = s.indexOf(':');
  if (part === 'all' || at < 0) return s.trim();
  return (part === 'before' ? s.slice(0, at) : s.slice(at + 1)).trim() || s.trim();
}

// A count already at the end of a label, e.g. "Agriculture (968)" written into the web map by an earlier script.
const TRAILING_COUNT = /\s*\(\d[\d,.\s\u00a0\u202f]*\)\s*$/;
/** A label without a count at its end, so a new count replaces it rather than following it. */
export const withoutCount = text => String(text ?? '').replace(TRAILING_COUNT, '');

/** "Base (1,204)"; just the base when there's no count or it's zero. */
export const countLabel = (base, count, fmt = n => n.toLocaleString()) =>
  Number.isFinite(count) && count > 0 ? `${base} (${fmt(count)})` : base;

/**
 * The statistics query that reads every category's count in one small answer (one row per category, so the
 * service's record limit never cuts categories off). Property names suit both an SDK Query and REST (see restParams).
 */
export function countQuery(cfg, field, objectIdField) {
  const stat = cfg?.mode === 'field'
    ? { statisticType: 'max', onStatisticField: cfg.countField, outStatisticFieldName: COUNT_OUT_FIELD }
    : { statisticType: 'count', onStatisticField: objectIdField || field, outStatisticFieldName: COUNT_OUT_FIELD };
  return { groupByFieldsForStatistics: [field], outStatistics: [stat], returnGeometry: false };
}

/** A countQuery as REST …/query parameters. */
export const restParams = (q, where = '1=1') => ({
  where, groupByFieldsForStatistics: q.groupByFieldsForStatistics.join(','), outStatistics: JSON.stringify(q.outStatistics), returnGeometry: 'false'
});

/** The answer to a countQuery as a Map of category value (as text) → count. Attribute names are matched in any case. */
export function readCounts(features, field) {
  const counts = new Map();
  for (const f of features ?? []) {
    const a = f?.attributes ?? {};
    const keyOf = name => Object.keys(a).find(k => k.toLowerCase() === name.toLowerCase());
    const vk = keyOf(field), ck = keyOf(COUNT_OUT_FIELD);
    if (vk == null || ck == null || a[vk] == null || a[ck] == null) continue;
    const n = Number(a[ck]);
    if (!Number.isFinite(n)) continue;
    const v = String(a[vk]);
    counts.set(v, (counts.get(v) ?? 0) + n);
  }
  return counts;
}

/**
 * A copy of the style with every class labelled from its original label (or its value when it has none) without any
 * count already at its end, the part of it cfg.part keeps, and the count of its values. Only labels change. Pass the
 * original style each time. Classic and grouped classes are both relabelled (a style can hold both).
 */
export function relabel(renderer, counts, cfg, fmt) {
  const out = structuredClone(renderer);
  const part = cfg?.part ?? 'all';
  const make = (label, values) => {
    let total = 0, any = false;
    for (const v of values) if (counts.has(v)) { total += counts.get(v); any = true; }
    const base = labelPart(withoutCount(label) || values[0] || '', part);
    return any ? countLabel(base, total, fmt) : base;
  };
  for (const info of out.uniqueValueInfos ?? []) if (info) info.label = make(info.label, [String(info.value)]);
  for (const g of out.uniqueValueGroups ?? []) {
    for (const c of g?.classes ?? []) if (c) c.label = make(c.label, (c.values ?? []).map(v => String(Array.isArray(v) ? v[0] : v)));
  }
  return out;
}

/** Labels two or more classes share (counts aside), e.g. two zones that both keep only "Town Housing". */
export function sharedLabels(renderer) {
  const seen = new Map();
  for (const c of styleClasses(renderer)) {
    const base = withoutCount(c.label);
    seen.set(base, (seen.get(base) ?? 0) + 1);
  }
  return [...seen].filter(([, n]) => n > 1).map(([base]) => base);
}

/** "Column ZoningCount, every minute" for a layer's summary line. */
export function describeLegendLabels(cfg) {
  if (!cfg) return '';
  const how = cfg.mode === 'field' ? `Column ${cfg.countField || '(none)'}` : 'Automatic';
  const when = REFRESH_CHOICES.find(([s]) => s === cfg.refreshSeconds)?.[1] ?? '';
  return [how, when.charAt(0).toLowerCase() + when.slice(1)].filter(Boolean).join(', ');
}

/** Problems with a layer's entry, as sentences (empty when it's fine). Used by manifest.js validate(). */
export function legendLabelProblems(cfg) {
  if (cfg == null || typeof cfg !== 'object' || Array.isArray(cfg)) return ['the settings must be an object.'];
  const errors = [];
  if (!isCountMode(cfg.mode)) errors.push('"mode" must be "field" (a count column) or "auto" (counted automatically).');
  if (cfg.mode === 'field' && (typeof cfg.countField !== 'string' || !cfg.countField.trim())) errors.push('choose the column that holds the counts.');
  if (cfg.part != null && !isLabelPart(cfg.part)) errors.push('"part" must be "all", "before" or "after".');
  if (cfg.refreshSeconds != null && !isRefreshSeconds(cfg.refreshSeconds)) {
    errors.push(`"refreshSeconds" must be one of ${REFRESH_CHOICES.map(([s]) => s).join(', ')} (0 = only when the map opens).`);
  }
  return errors;
}
