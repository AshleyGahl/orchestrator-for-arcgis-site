// tableExport.js — which columns a results export offers and how each one's values go into a spreadsheet. Shared
// by every export (spatial relationships, Attribute trace): the table's own columns start ticked, then the layer's
// other fields. Pure: no DOM, no SDK, so it runs in Node tests. exportForm.js draws the choice; xlsx.js writes Excel.

const isShape = name => /^shape([._]|$)/i.test(name) || /^st_(area|length)/i.test(name);
export const isGeometryField = f => isShape(f.name) || f.type === 'esriFieldTypeGeometry' || f.type === 'geometry';

/**
 * How a field's values go into a spreadsheet: 'number' (stays a number, so Excel can sum and filter by value),
 * 'date' (a real date) or 'text' (the value as the table shows it). Coded-value domains are text: their names.
 */
export function fieldKind(field) {
  if (!field || field.domain?.type === 'coded-value' || field.domain?.type === 'codedValue') return 'text';
  const type = String(field.type ?? '');
  if (/date-?only|time-?only|timestamp-?offset/i.test(type)) return 'text';
  if (/date/i.test(type)) return 'date';
  if (/oid|integer|double|single|long|float/i.test(type)) return 'number';
  return 'text';
}

/**
 * The columns people can tick: the table's columns first (ticked to start with, in its order, with its labels), then
 * the layer's other fields (unticked, in the layer's order). Geometry fields are left out.
 * @param shown   the table's columns [{ name, label }]
 * @param fields  the layer's fields [{ name, alias, type }]
 * @returns [{ name, label, shown }]
 */
export function exportChoices(shown, fields = []) {
  const first = shown.map(c => ({ name: c.name, label: c.label || c.name, shown: true }));
  const seen = new Set(first.map(c => c.name.toLowerCase()));
  const rest = fields.filter(f => !isGeometryField(f) && !seen.has(f.name.toLowerCase()))
    .map(f => ({ name: f.name, label: f.alias || f.name, shown: false }));
  return [...first, ...rest];
}

/**
 * The columns to export: the choices people ticked, in the choices' order, each with its kind. Names that aren't
 * choices are ignored; with no list (null), the table's own columns.
 * @returns [{ name, label, kind }]
 */
export function pickedColumns(choices, fields = [], picked = null) {
  const byName = new Map(fields.map(f => [f.name.toLowerCase(), f]));
  const want = Array.isArray(picked) ? new Set(picked.map(n => String(n).toLowerCase())) : null;
  return choices.filter(c => (want ? want.has(c.name.toLowerCase()) : c.shown))
    .map(c => ({ name: c.name, label: c.label, kind: fieldKind(byName.get(c.name.toLowerCase())) }));
}

/** An ObjectID list as where clauses of at most `size` ids each (numbers only; anything else is dropped). */
export function idWheres(oidField, ids, size = 500) {
  const nums = [...new Set(ids.filter(v => v != null && v !== '').map(Number).filter(Number.isInteger))];
  const out = [];
  for (let i = 0; i < nums.length; i += size) out.push(`${oidField} IN (${nums.slice(i, i + size).join(',')})`);
  return out;
}

/**
 * A column's kind when the layer's field isn't known (popup tables, related records): 'number' when every value is
 * a number shown as one (so a date, whose raw value is a number but shown as a date, stays text), otherwise 'text'.
 * @param rows  [{ cells: { [name]: { text, raw } } }]
 */
export function inferKind(rows, name) {
  let seen = false;
  for (const r of rows) {
    const c = r.cells?.[name];
    const raw = c?.raw;
    if (raw == null || raw === '') continue;
    if (typeof raw !== 'number' || !Number.isFinite(raw) || !/^[-+]?[\d\s,.  ']+$/.test(String(c.text ?? '').trim())) return 'text';
    seen = true;
  }
  return seen ? 'number' : 'text';
}

/**
 * Picked columns for rows already in hand: a known field's kind, otherwise the kind the values show (inferKind).
 * @returns [{ name, label, kind }]
 */
export function rowsColumns(choices, rows, fields = [], picked = null) {
  const known = new Set(fields.map(f => f.name.toLowerCase()));
  return pickedColumns(choices, fields, picked).map(c => (known.has(c.name.toLowerCase()) ? c : { ...c, kind: inferKind(rows, c.name) }));
}
