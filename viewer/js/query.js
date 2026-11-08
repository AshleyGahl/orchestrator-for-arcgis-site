// query.js — SQL operators for the viewer's attribute search. Builds safe ArcGIS "where" clauses
// (standardized SQL) from { field, operator, value } conditions, and the portal item query for Add data. Pure; no DOM, no SDK.

/** Field type (SDK or REST) -> 'text' | 'number' | 'date' | null (not searchable). */
export function fieldKind(type = '') {
  const t = String(type).replace(/^esriFieldType/i, '').toLowerCase();
  if (['string', 'guid', 'globalid', 'global-id'].includes(t)) return 'text';
  if (['integer', 'smallinteger', 'small-integer', 'biginteger', 'big-integer', 'long', 'double', 'single', 'oid'].includes(t)) return 'number';
  if (['date', 'date-only', 'dateonly', 'timestamp-offset', 'timestampoffset'].includes(t)) return 'date';
  return null;
}

export const OPERATORS = {
  eq:          { kinds: ['text', 'number', 'date'], arity: 1, label: { text: 'is', number: '=', date: 'on' } },
  ne:          { kinds: ['text', 'number', 'date'], arity: 1, label: { text: 'is not', number: '≠', date: 'not on' } },
  contains:    { kinds: ['text'], arity: 1, label: { text: 'contains' } },
  notContains: { kinds: ['text'], arity: 1, label: { text: 'does not contain' } },
  startsWith:  { kinds: ['text'], arity: 1, label: { text: 'starts with' } },
  endsWith:    { kinds: ['text'], arity: 1, label: { text: 'ends with' } },
  gt:          { kinds: ['number', 'date'], arity: 1, label: { number: '>', date: 'after' } },
  gte:         { kinds: ['number', 'date'], arity: 1, label: { number: '≥', date: 'on or after' } },
  lt:          { kinds: ['number', 'date'], arity: 1, label: { number: '<', date: 'before' } },
  lte:         { kinds: ['number', 'date'], arity: 1, label: { number: '≤', date: 'on or before' } },
  between:     { kinds: ['number', 'date'], arity: 2, label: { number: 'between', date: 'between' } },
  in:          { kinds: ['text', 'number'], arity: 1, label: { text: 'is any of', number: 'is any of' } },
  empty:       { kinds: ['text', 'number', 'date'], arity: 0, label: { text: 'is empty', number: 'is empty', date: 'is empty' } },
  notEmpty:    { kinds: ['text', 'number', 'date'], arity: 0, label: { text: 'is not empty', number: 'is not empty', date: 'is not empty' } }
};
export const OPERATOR_IDS = Object.keys(OPERATORS);

/** Short labels for Orchestration, where the field type isn't known yet. */
export const OPERATOR_NAMES = {
  eq: 'Equals', ne: 'Not equal', contains: 'Contains', notContains: 'Does not contain', startsWith: 'Starts with',
  endsWith: 'Ends with', gt: 'Greater than / after', gte: 'At least / on or after', lt: 'Less than / before',
  lte: 'At most / on or before', between: 'Between', in: 'Is any of (list)', empty: 'Is empty', notEmpty: 'Is not empty'
};

export const operatorLabel = (op, kind) => OPERATORS[op]?.label[kind] ?? OPERATOR_NAMES[op] ?? op;
export const operatorsFor = (kind, allowed = OPERATOR_IDS) => allowed.filter(op => OPERATORS[op]?.kinds.includes(kind));

/* ---------------- Literals ---------------- */
const quote = s => `'${String(s).replace(/'/g, "''")}'`;

function likeLiteral(s, pattern) {
  const v = String(s).toUpperCase();
  const needsEscape = /[%_\\]/.test(v);
  const body = needsEscape ? v.replace(/[\\%_]/g, c => `\\${c}`) : v;
  return `${quote(pattern.replace('X', body))}${needsEscape ? " ESCAPE '\\'" : ''}`;
}

function number(v, label = 'value') {
  const n = Number(String(v).trim().replace(/\s/g, '').replace(',', '.'));
  if (String(v).trim() === '' || !Number.isFinite(n)) throw new Error(`Enter a number for the ${label}.`);
  return String(n);
}

function isoDate(v) {
  const s = String(v).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || Number.isNaN(new Date(`${s}T00:00:00Z`).getTime())) throw new Error('Enter a date as YYYY-MM-DD.');
  return s;
}

function nextDay(iso) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

const dateLit = iso => `DATE '${iso}'`;
const safeField = f => {
  if (!/^[A-Za-z_][\w.]*$/.test(f || '')) throw new Error(`"${f}" isn't a valid field name.`);
  return f;
};

/* ---------------- Conditions ---------------- */
/**
 * @param c { field, kind, op, value, value2 }
 * @returns SQL fragment. Throws Error with a message fit to show the user.
 */
export function buildCondition({ field, kind, op, value = '', value2 = '' }) {
  const f = safeField(field);
  const spec = OPERATORS[op];
  if (!spec) throw new Error(`Unknown operator "${op}".`);
  if (!spec.kinds.includes(kind)) throw new Error(`"${operatorLabel(op, kind)}" doesn't apply to this field.`);
  if (spec.arity >= 1 && String(value).trim() === '') throw new Error('Enter a value to search for.');
  if (spec.arity === 2 && String(value2).trim() === '') throw new Error('Enter both values for "between".');

  if (op === 'empty') return kind === 'text' ? `(${f} IS NULL OR ${f} = '')` : `${f} IS NULL`;
  if (op === 'notEmpty') return kind === 'text' ? `(${f} IS NOT NULL AND ${f} <> '')` : `${f} IS NOT NULL`;

  if (kind === 'text') {
    const col = `UPPER(${f})`;
    const v = String(value).trim();
    switch (op) {
      case 'eq': return `${col} = ${quote(v.toUpperCase())}`;
      case 'ne': return `(${col} <> ${quote(v.toUpperCase())} OR ${f} IS NULL)`;
      case 'contains': return `${col} LIKE ${likeLiteral(v, '%X%')}`;
      case 'notContains': return `(${col} NOT LIKE ${likeLiteral(v, '%X%')} OR ${f} IS NULL)`;
      case 'startsWith': return `${col} LIKE ${likeLiteral(v, 'X%')}`;
      case 'endsWith': return `${col} LIKE ${likeLiteral(v, '%X')}`;
      case 'in': {
        const items = v.split(',').map(x => x.trim()).filter(Boolean);
        if (!items.length) throw new Error('List at least one value, separated by commas.');
        return `${col} IN (${items.map(x => quote(x.toUpperCase())).join(', ')})`;
      }
    }
  }

  if (kind === 'number') {
    switch (op) {
      case 'eq': return `${f} = ${number(value)}`;
      case 'ne': return `(${f} <> ${number(value)} OR ${f} IS NULL)`;
      case 'gt': return `${f} > ${number(value)}`;
      case 'gte': return `${f} >= ${number(value)}`;
      case 'lt': return `${f} < ${number(value)}`;
      case 'lte': return `${f} <= ${number(value)}`;
      case 'between': {
        const [a, b] = [Number(number(value, 'first value')), Number(number(value2, 'second value'))].sort((x, y) => x - y);
        return `${f} BETWEEN ${a} AND ${b}`;
      }
      case 'in': {
        const items = String(value).split(',').map(x => x.trim()).filter(Boolean).map(x => number(x, 'list'));
        if (!items.length) throw new Error('List at least one number, separated by commas.');
        return `${f} IN (${items.join(', ')})`;
      }
    }
  }

  if (kind === 'date') {
    const d = isoDate(value);
    switch (op) {
      case 'eq': return `(${f} >= ${dateLit(d)} AND ${f} < ${dateLit(nextDay(d))})`;
      case 'ne': return `(${f} < ${dateLit(d)} OR ${f} >= ${dateLit(nextDay(d))} OR ${f} IS NULL)`;
      case 'gt': return `${f} >= ${dateLit(nextDay(d))}`;
      case 'gte': return `${f} >= ${dateLit(d)}`;
      case 'lt': return `${f} < ${dateLit(d)}`;
      case 'lte': return `${f} < ${dateLit(nextDay(d))}`;
      case 'between': {
        const [a, b] = [d, isoDate(value2)].sort();
        return `(${f} >= ${dateLit(a)} AND ${f} < ${dateLit(nextDay(b))})`;
      }
    }
  }
  throw new Error(`"${operatorLabel(op, kind)}" isn't supported for this field.`);
}

/** Combine conditions with AND ("all") or OR ("any"). */
export function buildWhere(conditions, match = 'all') {
  if (!conditions.length) throw new Error('Add at least one condition.');
  const parts = conditions.map(c => `(${buildCondition(c)})`);
  return parts.join(match === 'any' ? ' OR ' : ' AND ');
}

/* ---------- Portal item search (Add data) ---------- */
const GROUP_ID = /^[0-9a-f]{32}$/i;

/**
 * The q= for a portal item search: optional free text, limited to some groups (a curated collection),
 * an organisation, and the item types that can be added to a map. People's text can't change the shape
 * of the query: field syntax, quotes, brackets and wildcards are stripped, so it only matches words.
 * @param {{ text?, groupIds?, orgId?, types }} opts  groupIds: null = any group; [] is refused (nothing curated)
 */
export function portalItemQuery({ text = '', groupIds = null, orgId = '', types }) {
  const parts = [];
  if (groupIds) {
    const ids = groupIds.filter(id => GROUP_ID.test(id));
    if (!ids.length) throw new Error('This collection has no groups.');
    parts.push(`(${ids.map(id => `group:"${id.toLowerCase()}"`).join(' OR ')})`);
  }
  if (orgId) {
    if (!/^[\w-]+$/.test(orgId)) throw new Error('The portal\'s organisation id isn\'t valid.');
    parts.push(`orgid:${orgId}`);
  }
  if (!types?.length) throw new Error('No item types to search for.');
  parts.push(`(${types.map(t => `type:"${t.replace(/"/g, '')}"`).join(' OR ')})`);
  const words = text.replace(/[^\p{L}\p{N}\s_.-]+/gu, ' ').split(/\s+/)
    .filter(w => w && !/^(AND|OR|NOT|TO)$/i.test(w)).slice(0, 12);
  if (words.length) parts.push(`(${words.join(' ')})`);
  return parts.join(' AND ');
}
