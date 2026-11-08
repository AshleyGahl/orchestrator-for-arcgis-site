// editing.js — form-centric editing of feature layers: templates, which fields can be edited, form inputs,
// reading what people type, and working out what changed. Pure: no DOM, no SDK, no config, so it runs in
// Node tests. map.js reads and saves features; editWindow.js draws the forms; editingEditor.js sets it up.

/**
 * Form templates: [id, label, hint]. Each pairs a way of listing the records in view with a way of showing
 * the form dialog when one is clicked.
 */
export const EDIT_TEMPLATES = [
  ['classic', 'Classic list', 'A tidy list of records; the form opens as a dialog in the middle.'],
  ['cards', 'Cards', 'Records as cards with their key values; a wide two-column form.'],
  ['grid', 'Table', 'A sortable table of records; the form slides in from the side.'],
  ['split', 'List and form', 'The list and the form side by side; pick a record and edit it next to the list.'],
  ['guided', 'Guided steps', 'One small group of fields at a time with large controls, for tablets and field crews.']
];
export const isEditTemplate = id => EDIT_TEMPLATES.some(([t]) => t === id);

/** How wide the editing window opens over the map. People can switch in the viewer. */
export const EDIT_WIDTHS = [['half', 'Half: the form beside the map'], ['full', 'Full: the form over the whole map']];
export const isEditWidth = id => EDIT_WIDTHS.some(([w]) => w === id);

export const EDIT_MAX_RECORDS = 1000;    // most records the list may ask for at once
export const LIST_FIELDS_MAX = 4;        // values shown with each record, besides its title
export const GUIDED_STEP_SIZE = 4;       // fields per step in the Guided template

/** "esriFieldTypeSmallInteger" and "small-integer" are the same type: REST and SDK spell them differently. */
export function fieldType(type) {
  const t = String(type ?? '').replace(/^esriFieldType/, '').replace(/-/g, '').toLowerCase();
  return { globalid: 'global-id', smallinteger: 'small-integer', biginteger: 'big-integer', dateonly: 'date-only', timeonly: 'time-only', timestampoffset: 'timestamp-offset' }[t] ?? t;
}

const SYSTEM_TYPES = new Set(['oid', 'global-id', 'geometry', 'blob', 'raster', 'xml']);
const isShapeField = name => /^shape([._]|$)/i.test(name) || /^st_(area|length)/i.test(name);

/**
 * Fields people never type into: ObjectID, GlobalID, geometry, shape area/length and editor tracking.
 * @param info  the layer's service info (REST JSON) or an SDK FeatureLayer: fields, objectIdField, editFieldsInfo
 */
export function systemFieldNames(info) {
  const out = new Set();
  for (const f of info?.fields ?? []) if (SYSTEM_TYPES.has(fieldType(f.type)) || isShapeField(f.name)) out.add(f.name.toLowerCase());
  for (const k of ['objectIdField', 'globalIdField']) if (info?.[k]) out.add(info[k].toLowerCase());
  for (const v of Object.values(info?.editFieldsInfo ?? {})) if (typeof v === 'string' && v) out.add(v.toLowerCase());
  return out;
}

/** True when a field can be shown in a form at all (editable or read-only). */
export const isFormField = (f, system) => !system.has(f.name.toLowerCase());

/** True when the server lets people change a field (and it isn't a system field). */
export const serverEditable = (f, system) => isFormField(f, system) && f.editable !== false;

/** The fields a layer's form shows when the author hasn't chosen any: every field the server lets people edit. */
export function defaultFormFields(info) {
  const system = systemFieldNames(info);
  return (info?.fields ?? []).filter(f => serverEditable(f, system))
    .map(f => ({ name: f.name, label: f.alias || f.name, editable: true, required: f.nullable === false }));
}

/**
 * The form's fields: the author's list (labels fall back to aliases; a field the server won't edit stays
 * read-only; a field the server won't leave empty is always required), or every editable field.
 * Fields no longer on the layer are dropped.
 */
export function formFields(chosen, info) {
  const system = systemFieldNames(info);
  const byName = new Map((info?.fields ?? []).map(f => [f.name.toLowerCase(), f]));
  const list = chosen?.length ? chosen : defaultFormFields(info);
  return list.map(c => {
    const f = byName.get(String(c.name).toLowerCase());
    if (!f || !isFormField(f, system)) return null;
    const editable = c.editable !== false && serverEditable(f, system);
    return {
      name: f.name, label: c.label || f.alias || f.name, editable, required: editable && (c.required === true || f.nullable === false), field: f,
      group: c.group || '', hint: c.hint || '',
      visibleWhen: c.visibleWhen ?? null, requiredWhen: c.requiredWhen ?? null, editableWhen: c.editableWhen ?? null
    };
  }).filter(Boolean);
}

/** What the server lets people do with a layer. Reads REST service info or an SDK layer's capabilities. */
export function layerCapabilities(info) {
  const ops = info?.capabilities?.operations;
  if (ops) return { query: ops.supportsQuery !== false, create: ops.supportsAdd === true, update: ops.supportsUpdate === true, delete: ops.supportsDelete === true };
  const caps = String(info?.capabilities ?? '').toLowerCase().split(',').map(s => s.trim());
  const editing = caps.includes('editing');
  // A service with plain "Editing" and no finer grain allows all three.
  const fine = ['create', 'update', 'delete'].some(c => caps.includes(c));
  return { query: caps.includes('query'), create: editing && (!fine || caps.includes('create')), update: editing && (!fine || caps.includes('update')), delete: editing && (!fine || caps.includes('delete')) };
}

/** Only hosted and enterprise feature services take edits (map service sublayers don't). */
export const isFeatureServiceLayerUrl = url => /\/FeatureServer\/\d+\/?$/i.test(url ?? '');

/** The SDK shape the Add tool draws for a layer's geometry type, or null for tables and odd types. */
export function drawShapeFor(geometryType) {
  const t = String(geometryType ?? '').replace(/^esriGeometry/, '').toLowerCase();
  return { point: 'point', multipoint: 'point', polyline: 'polyline', polygon: 'polygon' }[t] ?? null;
}

/* ---------------- Form inputs ---------------- */
const INTEGER_TYPES = new Set(['small-integer', 'integer', 'big-integer']);
const NUMBER_TYPES = new Set(['single', 'double']);
export const LONG_TEXT = 255;

/** Which control a field gets: select | integer | number | date | date-only | textarea | text. */
export function inputKind(f) {
  if (f?.domain?.type === 'coded-value' || f?.domain?.type === 'codedValue') return 'select';
  const t = fieldType(f?.type);
  if (INTEGER_TYPES.has(t)) return 'integer';
  if (NUMBER_TYPES.has(t)) return 'number';
  if (t === 'date' || t === 'timestamp-offset') return 'date';
  if (t === 'date-only') return 'date-only';
  if (t === 'string' && (f.length ?? 0) > LONG_TEXT) return 'textarea';
  return 'text';
}

const pad = n => String(n).padStart(2, '0');

/** A stored value as the text an input shows. Dates show in the browser's time zone. */
export function toInputValue(kind, value) {
  if (value == null) return '';
  if (kind === 'date') {
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return '';
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }
  if (kind === 'date-only') return typeof value === 'string' ? value.slice(0, 10) : '';
  return String(value);
}

/**
 * What people typed, as the value to store. Returns { value } or { error } (a sentence to show by the field).
 * Empty input stores null.
 */
export function fromInputValue(kind, text, f = {}) {
  const raw = String(text ?? '').trim();
  if (raw === '') return { value: null };
  const range = f.domain?.type === 'range' ? f.domain : null;
  const inRange = n => {
    if (!range) return null;
    if (range.minValue != null && n < range.minValue) return `Must be at least ${range.minValue}.`;
    if (range.maxValue != null && n > range.maxValue) return `Must be at most ${range.maxValue}.`;
    return null;
  };
  switch (kind) {
    case 'select': {
      const coded = f.domain?.codedValues ?? [];
      const hit = coded.find(c => String(c.code) === raw);
      if (!hit) return { error: 'Choose one of the listed values.' };
      return { value: hit.code };
    }
    case 'integer': {
      if (!/^[+-]?\d+$/.test(raw.replace(/[\s,]/g, ''))) return { error: 'Enter a whole number.' };
      const n = Number(raw.replace(/[\s,]/g, ''));
      if (!Number.isSafeInteger(n)) return { error: 'That number is too large.' };
      const t = fieldType(f.type);
      if (t === 'small-integer' && (n < -32768 || n > 32767)) return { error: 'Must be between -32768 and 32767.' };
      if (t === 'integer' && (n < -2147483648 || n > 2147483647)) return { error: 'That number is too large.' };
      const e = inRange(n);
      return e ? { error: e } : { value: n };
    }
    case 'number': {
      const n = Number(raw.replace(/\s/g, '').replace(',', '.'));
      if (!Number.isFinite(n)) return { error: 'Enter a number.' };
      const e = inRange(n);
      return e ? { error: e } : { value: n };
    }
    case 'date': {
      const m = raw.match(/^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?$/);
      if (!m) return { error: 'Enter a date.' };
      const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4] ?? 0), Number(m[5] ?? 0));
      return Number.isNaN(d.getTime()) ? { error: 'Enter a date.' } : { value: d.getTime() };
    }
    case 'date-only':
      return /^\d{4}-\d{2}-\d{2}$/.test(raw) ? { value: raw } : { error: 'Enter a date.' };
    default: {
      if (f.length && raw.length > f.length) return { error: `At most ${f.length} characters (now ${raw.length}).` };
      return { value: raw };
    }
  }
}

/**
 * Check a whole form. values: { [name]: text as typed }. Returns { attributes, errors: { [name]: sentence } }.
 * Only editable fields are read; required ones must not be empty.
 */
export function readForm(fields, values) {
  const attributes = {}, errors = {};
  for (const ff of fields) {
    if (!ff.editable) continue;
    const r = fromInputValue(inputKind(ff.field), values[ff.name], ff.field);
    if (r.error) errors[ff.name] = r.error;
    else if (r.value == null && ff.required) errors[ff.name] = 'Required.';
    else attributes[ff.name] = r.value;
  }
  return { attributes, errors };
}

/** Attribute values that differ from the original record (case-insensitive names; null and '' are the same). */
export function changedAttributes(original, attributes) {
  const orig = original ?? {};
  const find = name => orig[name] ?? orig[Object.keys(orig).find(k => k.toLowerCase() === name.toLowerCase())];
  const out = {};
  for (const [name, v] of Object.entries(attributes)) if ((find(name) ?? '') !== (v ?? '')) out[name] = v;
  return out;
}

/** Starting values for a new record: the field's default, or nothing. */
export function newRecordValues(fields) {
  return Object.fromEntries(fields.filter(ff => ff.editable).map(ff => [ff.name, ff.field?.defaultValue ?? null]));
}

/** Split a form's fields into Guided steps. */
export function guidedSteps(fields, size = GUIDED_STEP_SIZE) {
  const out = [];
  for (let i = 0; i < fields.length; i += size) out.push(fields.slice(i, i + size));
  return out.length ? out : [[]];
}

/* ---------------- Smart forms: groups, conditions and hints ---------------- */
// A form's fields stay one ordered list; each field may name a group (layer.groups[].id). A group shows where its
// first field is, with all its fields together. Rules ({ field, op, value }) show a field or group, make a field
// required, or let people change it, only while another field's value matches. Hidden fields are never required and
// never saved: the record keeps the value it had.

/** Rule operators: [id, label, needs a value: 'one' | 'list' | null]. */
export const RULE_OPS = [
  ['equals', 'is', 'one'],
  ['notEquals', 'is not', 'one'],
  ['oneOf', 'is one of', 'list'],
  ['isEmpty', 'is empty', null],
  ['notEmpty', 'is not empty', null]
];
const RULE_OP = new Map(RULE_OPS.map(([id, , v]) => [id, v]));
const NAME_RE = /^[A-Za-z_][\w.]*$/;
const isScalar = v => typeof v === 'string' || (typeof v === 'number' && Number.isFinite(v));
export const GROUP_LABEL_MAX = 80;
export const HINT_MAX = 300;

/** Why a rule isn't valid (a short phrase), or '' when it is. */
export function ruleProblem(rule) {
  if (!rule || typeof rule !== 'object' || Array.isArray(rule)) return 'must be { field, op, value }';
  if (!NAME_RE.test(rule.field ?? '')) return 'needs a valid field name';
  if (!RULE_OP.has(rule.op)) return `op must be one of ${RULE_OPS.map(([id]) => id).join(', ')}`;
  const need = RULE_OP.get(rule.op);
  if (need === 'one' && !isScalar(rule.value)) return 'needs a value (text or a number)';
  if (need === 'list' && !(Array.isArray(rule.value) && rule.value.length && rule.value.every(isScalar))) return 'needs a list of values';
  return '';
}

const empty = v => v == null || v === '';
function same(a, b) {
  if (empty(a) || empty(b)) return empty(a) && empty(b);
  if (typeof a === 'number' || typeof b === 'number') return Number(a) === Number(b);
  return String(a) === String(b);
}

/** True when a rule holds for these values ({ [lowercase name]: value }). No rule always holds. */
export function testRule(rule, values) {
  if (!rule) return true;
  const v = values?.[String(rule.field).toLowerCase()];
  switch (rule.op) {
    case 'isEmpty': return empty(v);
    case 'notEmpty': return !empty(v);
    case 'equals': return same(v, rule.value);
    case 'notEquals': return !same(v, rule.value);
    case 'oneOf': return (rule.value ?? []).some(x => same(v, x));
    default: return true;
  }
}

/**
 * The values rules look at: the record's attributes, overlaid with what people have typed in fields they can change
 * (read as stored values where they can be, as typed text where they can't yet).
 */
export function ruleValues(fields, texts, attributes) {
  const out = {};
  for (const [k, v] of Object.entries(attributes ?? {})) out[k.toLowerCase()] = v;
  for (const ff of fields) {
    if (!ff.editable || !(ff.name in (texts ?? {}))) continue;
    const r = fromInputValue(inputKind(ff.field), texts[ff.name], ff.field ?? {});
    out[ff.name.toLowerCase()] = r.error ? String(texts[ff.name]).trim() : r.value;
  }
  return out;
}

/** The fields the form's rules look at (lowercase): changing one of them redraws the form. */
export function ruleFields(fields, groups = []) {
  const out = new Set();
  for (const x of [...fields, ...(groups ?? [])]) for (const k of ['visibleWhen', 'requiredWhen', 'editableWhen']) if (x?.[k]?.field) out.add(x[k].field.toLowerCase());
  return out;
}

/**
 * Split a form into sections in form order: [{ group: { id, label, collapsed, visibleWhen } | null, fields }].
 * A group gathers all its fields where its first field is; runs of ungrouped fields are sections of their own.
 * A field naming a group that isn't listed counts as ungrouped.
 */
export function formSections(fields, groups = []) {
  const byId = new Map((groups ?? []).map(g => [g.id, g]));
  const out = [], seen = new Map();
  for (const ff of fields) {
    const g = ff.group && byId.get(ff.group);
    if (g) {
      if (!seen.has(g.id)) { const s = { group: g, fields: [] }; seen.set(g.id, s); out.push(s); }
      seen.get(g.id).fields.push(ff);
    } else if (out.length && !out.at(-1).group) out.at(-1).fields.push(ff);
    else out.push({ group: null, fields: [ff] });
  }
  return out;
}

/** The fields in section order, so each group's fields are together (the order the editor keeps). */
export const tidyFields = (fields, groups) => formSections(fields, groups).flatMap(s => s.fields);

/** Move a group's block of fields above the section before it (delta -1) or below the one after it (+1). */
export function moveSection(fields, groups, groupId, delta) {
  const sections = formSections(fields, groups);
  const i = sections.findIndex(s => s.group?.id === groupId);
  const j = i + delta;
  if (i < 0 || j < 0 || j >= sections.length) return tidyFields(fields, groups);
  [sections[i], sections[j]] = [sections[j], sections[i]];
  return sections.flatMap(s => s.fields);
}

/**
 * The form as it stands for these values: each section and field with visible, editable and required worked out.
 * A field is visible when its own rule and its group's rule hold; it can be changed when the server and the author
 * allow it and its editableWhen holds; it is required when it's visible and can be changed, and it was required
 * anyway or its requiredWhen holds.
 * @returns { sections: [{ group, visible, fields: [ff + { visible, editable, required }] }], fields: [same, flat] }
 */
export function resolveForm(fields, groups, values) {
  const sections = formSections(fields, groups).map(s => {
    const groupOn = testRule(s.group?.visibleWhen, values);
    const list = s.fields.map(ff => {
      const visible = groupOn && testRule(ff.visibleWhen, values);
      const editable = ff.editable && testRule(ff.editableWhen, values);
      const required = visible && editable && (ff.required || (ff.requiredWhen ? testRule(ff.requiredWhen, values) : false));
      return { ...ff, visible, editable, required };
    });
    return { group: s.group, visible: groupOn && list.some(f => f.visible), fields: list };
  });
  return { sections, fields: sections.flatMap(s => s.fields) };
}

/**
 * Guided steps from a resolved form: each visible group is one step (named after it); ungrouped fields go a few at
 * a time. Hidden groups and fields are skipped. Returns [{ label, fields }], at least one.
 */
export function smartSteps(sections, size = GUIDED_STEP_SIZE) {
  const out = [];
  for (const s of sections) {
    const shown = s.fields.filter(f => f.visible !== false);
    if (!shown.length || s.visible === false) continue;
    if (s.group) out.push({ label: s.group.label || '', fields: shown });
    else for (const chunk of guidedSteps(shown, size)) out.push({ label: '', fields: chunk });
  }
  return out.length ? out : [{ label: '', fields: [] }];
}

/* ---------------- Field Maps forms (the web map's formInfo) ---------------- */

const FEATURE_REF = String.raw`\$feature(?:\.([A-Za-z_]\w*)|\[\s*(['"])([^'"]+)\2\s*\])`;
const LIT = String.raw`'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|-?\d+(?:\.\d+)?|null`;
const literal = s => s === 'null' ? null : /^['"]/.test(s) ? s.slice(1, -1).replace(/\\(.)/g, '$1') : Number(s);

function balanced(s) {
  let depth = 0;
  for (const ch of s) { if (ch === '(') depth++; else if (ch === ')' && --depth < 0) return false; }
  return depth === 0;
}

/**
 * A simple Arcade expression as a rule: one field compared with a value (==, !=), IsEmpty, Includes or IndexOf on
 * a list, ORs of the same field, DomainName($feature, 'F') == 'Name' (needs the layer's info), or true / false.
 * @returns { rule } | { always: true|false } | null when it is too complex to convert
 */
export function arcadeRule(expression, info) {
  let x = String(expression ?? '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '').trim();
  x = x.replace(/^return\s+/i, '').replace(/;\s*$/, '').trim();
  while (/^\(.*\)$/s.test(x) && balanced(x.slice(1, -1))) x = x.slice(1, -1).trim();
  if (/[;\n]/.test(x)) return null;
  if (/^true$/i.test(x)) return { always: true };
  if (/^false$/i.test(x)) return { always: false };

  if (x.includes('||')) {                         // a == 'x' || a == 'y'  ->  oneOf
    const parts = x.split('||').map(p => arcadeRule(p, info));
    if (parts.every(p => p?.rule?.op === 'equals') && new Set(parts.map(p => p.rule.field.toLowerCase())).size === 1) {
      return { rule: { field: parts[0].rule.field, op: 'oneOf', value: parts.map(p => p.rule.value) } };
    }
    return null;
  }
  if (/&&/.test(x)) return null;
  let m;
  const not = /^!\s*/.test(x);
  const bare = x.replace(/^!\s*/, '');
  if ((m = bare.match(new RegExp(`^IsEmpty\\(\\s*${FEATURE_REF}\\s*\\)(?:\\s*(==|!=)\\s*(true|false))?$`, 'i')))) {
    const flip = (m[4] === '!=') !== (m[5]?.toLowerCase() === 'false');
    return { rule: { field: m[1] ?? m[3], op: not !== flip ? 'notEmpty' : 'isEmpty' } };
  }
  if (not) return null;
  const list = String.raw`\[\s*((?:${LIT})(?:\s*,\s*(?:${LIT}))*)\s*\]`;
  if ((m = x.match(new RegExp(`^Includes\\(\\s*${list}\\s*,\\s*${FEATURE_REF}\\s*\\)$`, 'i'))) ||
      (m = x.match(new RegExp(`^IndexOf\\(\\s*${list}\\s*,\\s*${FEATURE_REF}\\s*\\)\\s*(?:>\\s*-1|!=\\s*-1|>=\\s*0)$`, 'i')))) {
    const values = [...m[1].matchAll(new RegExp(LIT, 'g'))].map(v => literal(v[0])).filter(v => v != null);
    return values.length ? { rule: { field: m[2] ?? m[4], op: 'oneOf', value: values } } : null;
  }
  if ((m = x.match(new RegExp(`^DomainName\\(\\s*\\$feature\\s*,\\s*(['"])([A-Za-z_]\\w*)\\1\\s*\\)\\s*(==|!=)\\s*(${LIT})$`, 'i')))) {
    const f = (info?.fields ?? []).find(y => y.name.toLowerCase() === m[2].toLowerCase());
    const hit = (f?.domain?.codedValues ?? []).find(c => c.name === literal(m[4]));
    return hit ? { rule: { field: f.name, op: m[3] === '==' ? 'equals' : 'notEquals', value: hit.code } } : null;
  }
  const cmp = (field, op, lit) => {
    const v = literal(lit);
    if (v == null || v === '') return { rule: { field, op: op === '==' ? 'isEmpty' : 'notEmpty' } };
    return { rule: { field, op: op === '==' ? 'equals' : 'notEquals', value: v } };
  };
  if ((m = x.match(new RegExp(`^${FEATURE_REF}\\s*(==|!=)=?\\s*(${LIT})$`)))) return cmp(m[1] ?? m[3], m[4], m[5]);
  if ((m = x.match(new RegExp(`^(${LIT})\\s*(==|!=)=?\\s*${FEATURE_REF}$`)))) return cmp(m[3] ?? m[5], m[2], m[1]);
  return null;
}

/**
 * A Field Maps form (a web map layer's formInfo) as this app's form: fields in order with labels, hints, groups,
 * and the visibility, required and editable expressions that convert to simple rules.
 * @param formInfo  { formElements: [field | group | other], expressionInfos: [{ name, title, expression }] }
 * @param info      the layer's service info (fields, system fields), to keep only fields a form can show
 * @returns { fields, groups, notes: [sentences about what didn't come across] }
 */
export function fieldMapsForm(formInfo, info) {
  const system = systemFieldNames(info);
  const byName = new Map((info?.fields ?? []).map(f => [f.name.toLowerCase(), f]));
  const exprs = new Map((formInfo?.expressionInfos ?? []).map(e => [e.name, e]));
  const fields = [], groups = [], notes = [];
  const used = new Set();
  let n = 0;

  // An expression reference as { rule } | { always } | null, noting the ones that don't convert.
  const convert = (name, what, where) => {
    if (!name) return null;
    const e = exprs.get(name);
    const r = e ? arcadeRule(e.expression, info) : null;
    if (!r) notes.push(`${where}: the ${what} expression "${e?.title || name}" is too complex to convert; set it by hand.`);
    return r;
  };

  const addField = (fe, groupId) => {
    const f = byName.get(String(fe.fieldName ?? '').toLowerCase());
    if (!f || !isFormField(f, system)) { notes.push(`Field ${fe.fieldName}: not on the layer (or a system field), left out.`); return; }
    if (used.has(f.name.toLowerCase())) return;
    const where = `Field ${fe.label || f.alias || f.name}`;
    const vis = convert(fe.visibilityExpression, 'visibility', where);
    if (vis?.always === false) { notes.push(`${where}: always hidden in Field Maps, left out.`); return; }
    used.add(f.name.toLowerCase());
    const out = { name: f.name, label: fe.label && fe.label !== (f.alias || f.name) ? fe.label : '', editable: serverEditable(f, system) && fe.editable !== false, required: false };
    if (groupId) out.group = groupId;
    const hint = fe.description || fe.hint;
    if (hint) out.hint = String(hint).slice(0, HINT_MAX);
    if (vis?.rule) out.visibleWhen = vis.rule;
    const req = convert(fe.requiredExpression, 'required', where);
    if (req?.always === true || fe.required === true) out.required = true;
    else if (req?.rule) out.requiredWhen = req.rule;
    const ed = convert(fe.editableExpression, 'editable', where);
    if (ed?.always === false) out.editable = false;
    else if (ed?.rule && out.editable) out.editableWhen = ed.rule;
    if (fe.valueExpression) notes.push(`${where}: calculated in Field Maps; here people type the value.`);
    fields.push(out);
  };

  for (const fe of formInfo?.formElements ?? []) {
    if (fe.type === 'field') addField(fe, '');
    else if (fe.type === 'group') {
      const g = { id: `grp-${++n}`, label: String(fe.label || `Group ${n}`).slice(0, GROUP_LABEL_MAX), collapsed: fe.initialState === 'collapsed' };
      const vis = convert(fe.visibilityExpression, 'visibility', `Group ${g.label}`);
      if (vis?.always === false) { notes.push(`Group ${g.label}: always hidden in Field Maps, left out.`); continue; }
      if (vis?.rule) g.visibleWhen = vis.rule;
      groups.push(g);
      for (const inner of fe.formElements ?? []) {
        if (inner.type === 'field') addField(inner, g.id);
        else notes.push(`Group ${g.label}: a ${inner.type ?? 'kind of'} element isn't supported here, left out.`);
      }
    } else {
      const name = fe.label || String(fe.text ?? '').replace(/<[^>]*>/g, '').trim().slice(0, 40) || 'untitled';
      notes.push(`A ${fe.type ?? 'kind of'} element (${name}) isn't supported here, left out.`);
    }
  }
  const kept = groups.filter(g => fields.some(f => f.group === g.id));
  return { fields: tidyFields(fields, kept), groups: kept, notes };
}
