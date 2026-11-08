// sections.js — loads Details sections: the 1:m data a web map popup can't show
// (e.g. sectional title units on a parcel). Uses api.js for data; no DOM, no SDK.
import * as api from './api.js';
import { CONFIG } from './config.js';
import { fillTemplate, encoders, isAllowedHost, attr } from './utils.js';
import { AuthRequiredError } from './auth.js';
import { formatValue } from './popup.js';

const isShape = name => /^shape([._]|$)/i.test(name) || /^st_(area|length)/i.test(name);

function pick(obj, path) {
  if (!path) return obj;
  return path.split('.').reduce((o, k) => (o == null ? o : o[k]), obj);
}

/** Columns from config, or every non-geometry key of the first row. Labels fall back to service aliases. */
function columnsFor(section, rows, aliases = new Map()) {
  if (section.fields?.length) return section.fields.map(f => ({ name: f.name, label: f.label || aliases.get(f.name) || f.name }));
  const keys = Object.keys(rows[0] ?? {}).filter(k => !isShape(k) && !/^(objectid|fid|oid)$/i.test(k));
  return keys.map(k => ({ name: k, label: aliases.get(k) || k }));
}

const NUMERIC = /integer|double|single|oid|long|smallinteger|biginteger/i;
const safeField = f => /^[A-Za-z_][\w.]*$/.test(f || '');

/** where clause from "table column = layer field" pairs, typed by the table's own field types. */
async function whereFromMatch(section, attrs) {
  const meta = new Map((await api.getFields(section.url).catch(() => [])).map(f => [f.name.toLowerCase(), f]));
  const parts = [];
  for (const { tableField, layerField } of section.match) {
    if (!safeField(tableField) || !layerField) throw new Error('This section\'s matching columns aren\'t set up.');
    const v = attr(attrs, layerField);
    if (v == null || v === '') return { missing: layerField };
    const col = meta.get(tableField.toLowerCase());
    if (meta.size && !col) throw new Error(`The table has no column called ${tableField}. Check the matching columns.`);
    const numericCol = NUMERIC.test(col?.type ?? '');
    if (numericCol && !Number.isFinite(Number(v))) {
      return { mismatch: `${layerField} is "${v}", which can't match ${tableField} because that column holds numbers. Check the matching columns.` };
    }
    parts.push(`${tableField} = ${numericCol ? Number(v) : `'${encoders.sql(v)}'`}`);
  }
  return { where: parts.join(' AND ') };
}

async function loadRelatedTable(section, attrs) {
  if (!isAllowedHost(section.url)) throw new Error('That table\'s host isn\'t on the allowed list.');
  let where;
  if ((section.matchMode ?? (section.match?.length ? 'fields' : 'where')) === 'fields' && section.match?.length) {
    const m = await whereFromMatch(section, attrs);
    if (m.missing) return { columns: [], rows: [], note: `This feature has no ${m.missing} value to match on.` };
    if (m.mismatch) throw new Error(m.mismatch);
    where = m.where;
  } else {
    where = fillTemplate(section.where, attrs, encoders.sql);
  }
  if (where == null) return { columns: [], rows: [], note: 'This feature has no value for the field the lookup needs.' };
  const res = await api.queryTable(section.url, {
    where,
    outFields: section.fields?.length ? section.fields.map(f => f.name).join(',') : '*',
    orderByFields: section.orderBy || '',
    max: Math.min(section.max || CONFIG.sectionMaxRows, CONFIG.sectionMaxRows)
  });
  const fieldMeta = new Map((res.fields ?? []).map(f => [f.name, f]));
  const aliases = new Map((res.fields ?? []).map(f => [f.name, f.alias || f.name]));
  const raw = (res.features ?? []).map(f => f.attributes ?? {});
  const columns = columnsFor(section, raw, aliases);
  const rows = raw.map(r => Object.fromEntries(columns.map(c => [c.name, { text: formatValue(r[c.name], fieldMeta.get(c.name)), raw: r[c.name] ?? null }])));
  return { columns, rows, truncated: res.exceededTransferLimit === true, where, notes: res.notes ?? [] };
}

async function loadApi(section, attrs) {
  const url = fillTemplate(section.url, attrs, encoders.url);
  if (url == null) return { columns: [], rows: [], note: 'This feature has no value for the field the lookup needs.' };
  if (!isAllowedHost(url)) throw new Error('That API\'s host isn\'t on the allowed list.');
  const json = await api.getJsonFromUrl(url);
  let raw = pick(json, section.rowsPath);
  if (raw == null) raw = [];
  if (!Array.isArray(raw)) raw = [raw];
  const columns = columnsFor(section, raw);
  const rows = raw.map(r => Object.fromEntries(columns.map(c => [c.name, { text: formatValue(r?.[c.name]), raw: r?.[c.name] ?? null }])));
  return { columns, rows };
}

/** @returns Promise<[{ section, columns, rows: [{ [name]: { text, raw } }], note?, truncated?, error? }]> in config order. */
export function loadSections(result) {
  const sections = (result.config?.sections ?? []).filter(s => s.type !== 'spatial');   // those run on request
  return Promise.all(sections.map(async section => {
    try {
      const data = section.type === 'related-table' ? await loadRelatedTable(section, result.attributes) : await loadApi(section, result.attributes);
      return { section, ...data };
    } catch (e) {
      if (e instanceof AuthRequiredError) return { section, columns: [], rows: [], auth: e.target, error: e.message };
      if (e instanceof api.QueryError) {
        const vague = /unable to complete operation|400/i.test(e.message);
        return { section, columns: [], rows: [], where: e.where, error: vague
          ? `The server couldn't run this lookup (${e.message}). This usually means a matching column has the wrong name or type, or the table doesn't support the request.`
          : e.message };
      }
      return { section, columns: [], rows: [], error: e.message };
    }
  }));
}

/** Links for a card: only http(s), values URL-encoded, skipped when a needed value is missing. */
export function buildActions(result) {
  return (result.config?.actions ?? [])
    .map(a => ({ label: a.label, href: fillTemplate(a.url, result.attributes, encoders.url) }))
    .filter(a => a.href && /^https?:\/\//i.test(a.href));
}
