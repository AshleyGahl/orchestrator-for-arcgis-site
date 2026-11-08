// popup.js — turns a web map popup (SDK PopupTemplate) plus Orchestration overrides into the model
// a Details card renders. Arcade expressions run through the SDK's Arcade executor, so the web map's
// expressions work without Esri's popup UI. Supported content: fields, text, expression (text/fields).
// Media, attachments and relationship elements are skipped here; Details sections cover 1:m data.

import { attr, escapeHtml } from './utils.js';
import { CONFIG } from './config.js';

const executors = new Map();     // `${cacheKey}|${expression}` -> Promise<executor>

function getExecutor(arcade, cacheKey, expression) {
  const k = `${cacheKey}|${expression}`;
  if (!executors.has(k)) {
    executors.set(k, arcade.createArcadeExecutor(expression, arcade.createArcadeProfile('popup'))
      .catch(e => { executors.delete(k); throw e; }));
  }
  return executors.get(k);
}

async function runArcade(ctx, expression) {
  try {
    const exec = await getExecutor(ctx.arcade, ctx.cacheKey, expression);
    return await exec.executeAsync(
      { $feature: ctx.graphic, $layer: ctx.layer ?? null, $map: ctx.map ?? null, $datastore: ctx.layer ?? null },
      { spatialReference: ctx.spatialReference }
    );
  } catch (e) {
    console.warn('Arcade expression failed:', e);
    return null;
  }
}

/* ---------------- Value formatting ---------------- */
const DATE_FORMATS = {
  shortDate:            { day: '2-digit', month: '2-digit', year: 'numeric' },
  shortDateLE:          { day: '2-digit', month: '2-digit', year: 'numeric' },
  longMonthDayYear:     { day: 'numeric', month: 'long', year: 'numeric' },
  dayShortMonthYear:    { day: 'numeric', month: 'short', year: 'numeric' },
  longDate:             { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' },
  longMonthYear:        { month: 'long', year: 'numeric' },
  shortMonthYear:       { month: 'short', year: 'numeric' },
  year:                 { year: 'numeric' }
};

function formatDate(value, fmt = 'dayShortMonthYear') {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  const base = DATE_FORMATS[fmt.replace(/(ShortTime|LongTime)(24)?$/, '')] ?? DATE_FORMATS.dayShortMonthYear;
  const time = /Time/.test(fmt) ? { hour: '2-digit', minute: '2-digit', ...(/LongTime/.test(fmt) ? { second: '2-digit' } : {}) } : {};
  return d.toLocaleString('en-ZA', { ...base, ...time });
}

export function formatValue(value, field, format) {
  if (value == null || value === '') return '—';
  const coded = field?.domain?.type === 'coded-value' ? field.domain.codedValues?.find(c => c.code === value) : null;
  if (coded) return coded.name;
  const type = field?.type ?? '';
  if (/date/i.test(type) || format?.dateFormat) return formatDate(value, format?.dateFormat);
  if (typeof value === 'number') {
    const opts = {};
    if (format?.places != null) { opts.minimumFractionDigits = format.places; opts.maximumFractionDigits = format.places; }
    else opts.maximumFractionDigits = 3;
    // Erf numbers and ids must not become "12 345": integers only get separators when the web map asks.
    opts.useGrouping = format?.digitSeparator ?? !/oid|integer|small-integer|big-integer/i.test(type);
    return value.toLocaleString(CONFIG.numberLocale, opts);
  }
  return String(value);
}

/* ---------------- Popup text / Arcade output -> tables ---------------- */
const safeHref = h => (/^https?:\/\//i.test(h || '') ? h : null);
const stripBullet = t => t.replace(/^[•·\-–]\s*/, '').trim();

/**
 * One table cell -> { text, raw, href?, items? }.
 * items: when a cell holds a list (several links, or several "• " bullets) each entry is kept separately,
 * so lists show one per line and can be paired with a neighbouring cell's list.
 */
function cellInfo(cell, fallbackLabel = '') {
  const clone = cell.cloneNode(true);
  clone.querySelectorAll('br').forEach(br => br.replaceWith('\n'));
  const links = [...cell.querySelectorAll('a[href]')]
    .map(a => ({ href: safeHref(a.getAttribute('href')), text: stripBullet(a.textContent.replace(/\s+/g, ' ').trim()) || a.querySelector('img')?.getAttribute('alt') || '' }))
    .filter(l => l.href);
  const full = clone.textContent.replace(/[ \t\r\f\v]+/g, ' ');

  if (links.length > 1) {
    const items = links.map(l => ({ text: l.text || fallbackLabel || 'Open', href: l.href }));
    return { text: items.map(i => i.text).join('\n'), raw: items.map(i => i.text).join(', '), items };
  }
  // Bullet lists, whether or not the author put line breaks between them.
  const bulletParts = full.split('•').map(x => x.replace(/\s+/g, ' ').trim()).filter(Boolean);
  if ((full.match(/•/g) ?? []).length >= 2 && bulletParts.length >= 2 && !links.length) {
    const items = bulletParts.map(text => ({ text }));
    return { text: bulletParts.join('\n'), raw: bulletParts.join(', '), items };
  }
  const lines = full.split('\n').map(l => l.replace(/\s+/g, ' ').trim()).filter(Boolean);
  let text = lines.length === 1 ? stripBullet(lines[0]) : lines.map(stripBullet).join('\n');
  if (links.length === 1) {
    const { href, text: label } = links[0];
    if (!text || text === label) text = label || fallbackLabel || 'Open link';
    return { text, raw: text, href };
  }
  return { text: text || '—', raw: text || null };
}

const isPlainLabel = cell => !cell.querySelector('a, img') && cell.textContent.trim().length <= 80;

/** Text just before a table in the same parent (e.g. <font>Service Requests</font><table>) becomes its title. */
function takeHeading(table) {
  const parts = [];
  for (let n = table.previousSibling; n; n = n.previousSibling) {
    if (n.nodeType === 1 && (n.tagName === 'TABLE' || n.querySelector?.('table'))) break;
    parts.unshift(n);
  }
  const text = parts.map(n => n.textContent).join(' ').replace(/\s+/g, ' ').trim();
  if (!text || text.length > 80) return '';
  parts.forEach(n => n.remove());
  return text;
}

/**
 * Turn popup HTML (a text element or Arcade text output) into table blocks:
 *   two-column tables whose first column is plain labels  -> 'kv'   (label | value, even when the first row uses <th>)
 *   other tables                                          -> 'grid' (a first row of <th> becomes the header)
 *   "Label: value" lines -> 'kv';  "a | b | c" or tab lines -> 'grid'
 * The heading text before a table becomes its title. Anything else stays an 'html' block.
 */
export function htmlToBlocks(html, title = '') {
  const doc = new DOMParser().parseFromString(`<div>${html}</div>`, 'text/html');
  const root = doc.body.firstChild;
  const blocks = [];

  for (const table of [...root.querySelectorAll('table')]) {
    if (table.parentElement?.closest('table')) continue;
    const heading = takeHeading(table);
    const blockTitle = heading || title;
    const trs = [...table.querySelectorAll('tr')].filter(tr => tr.closest('table') === table);
    let rowsCells = trs.map(tr => [...tr.children].filter(c => /^(TD|TH)$/.test(c.tagName))).filter(r => r.length);
    table.remove();
    if (!rowsCells.length) continue;
    const width = Math.max(...rowsCells.map(r => r.length));

    // Caption rows: a single cell across the table (e.g. "Completed between 2026-09-01 - 2026-09-30").
    const captions = [];
    while (rowsCells.length > 1 && width > 1 && (rowsCells[0].length === 1 || rowsCells[0].slice(1).every(c => !c.textContent.trim()))) {
      captions.push(rowsCells[0][0].textContent.replace(/\s+/g, ' ').trim());
      rowsCells = rowsCells.slice(1);
    }
    const caption = captions.filter(Boolean).join(' · ') || undefined;
    const firstRowIsHeader = rowsCells[0].every(c => c.tagName === 'TH');
    const label = c => c.textContent.replace(/\s+/g, ' ').trim();
    const gridFrom = (headCells, body) => {
      const columns = Array.from({ length: width }, (_, i) => ({ name: `c${i}`, label: (headCells && label(headCells[i] ?? { textContent: '' })) || `Column ${i + 1}` }));
      return { kind: 'grid', title: blockTitle, caption, columns, rows: body.map((r, ri) => ({ id: `g${ri}`, cells: Object.fromEntries(columns.map((c, i) => [c.name, r[i] ? cellInfo(r[i], c.label) : { text: '—', raw: null }])) })) };
    };

    // 1. A header row over several data rows: a real rows-and-columns table.
    if (firstRowIsHeader && rowsCells.length >= 3) { blocks.push(gridFrom(rowsCells[0], rowsCells.slice(1))); continue; }

    // 2. Header row over ONE data row.
    if (firstRowIsHeader && rowsCells.length === 2) {
      const cells = rowsCells[0].map((h, i) => (rowsCells[1][i] ? cellInfo(rowsCells[1][i], 'Open') : { text: '—', raw: null }));
      const counts = cells.map(c => c.items?.length ?? 1);
      // 2a. Matching lists side by side (zones next to their PDF links) -> one row per entry.
      if (counts.length > 1 && counts.every(n => n === counts[0]) && counts[0] >= 2) {
        const columns = rowsCells[0].map((h, i) => ({ name: `c${i}`, label: label(h) || `Column ${i + 1}` }));
        blocks.push({
          kind: 'grid', title: blockTitle, caption, columns,
          rows: Array.from({ length: counts[0] }, (_, ri) => ({ id: `g${ri}`, cells: Object.fromEntries(columns.map((c, i) => {
            const it = cells[i].items[ri];
            return [c.name, { text: it.text || '—', raw: it.text, href: it.href }];
          })) }))
        });
        continue;
      }
      // 2b. Header names the value under it (e.g. "SG Diagram" over an icon link) -> label | value.
      //     Not when the data row starts with a plain label: then the labels run down the first column (rule 3).
      if (rowsCells[1].length > 1 && !isPlainLabel(rowsCells[1][0])) {
        blocks.push({ kind: 'kv', title: blockTitle, caption, rows: rowsCells[0].map((h, i) => ({ label: label(h) || `Column ${i + 1}`, value: cells[i].text || '—', raw: cells[i].raw, href: cells[i].href, items: cells[i].items })) });
        continue;
      }
    }

    // 3. Two columns whose first column is plain labels: label | value (even when the first row uses <th>).
    if (width === 2 && rowsCells.every(r => r[0] && isPlainLabel(r[0]))) {
      blocks.push({
        kind: 'kv', title: blockTitle, caption,
        rows: rowsCells.map(([labelCell, valueCell]) => {
          const l = label(labelCell);
          const v = valueCell ? cellInfo(valueCell, l) : { text: '—', raw: null };
          return { label: l, value: v.text || '—', raw: v.raw, href: v.href, items: v.items };
        })
      });
      continue;
    }

    // 4. Anything else: rows and columns.
    blocks.push(gridFrom(firstRowIsHeader ? rowsCells[0] : null, firstRowIsHeader ? rowsCells.slice(1) : rowsCells));
  }

  // What's left after the tables: line-based shapes, or plain text.
  const rest = root.innerHTML.replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|li|h\d)>/gi, '\n');
  const lines = new DOMParser().parseFromString(`<div>${rest}</div>`, 'text/html').body.textContent
    .split('\n').map(l => l.replace(/\s+$/, '')).filter(l => l.trim());
  const kvLines = lines.map(l => l.match(/^\s*([^:|\t]{1,60}?)\s*:\s+(.*)$/));
  const sepOf = l => (l.includes('\t') ? '\t' : l.includes('|') ? '|' : null);
  const sep = lines.length >= 2 ? sepOf(lines[0]) : null;

  if (lines.length >= 2 && kvLines.filter(Boolean).length / lines.length >= 0.6) {
    const rows = [];
    lines.forEach((l, i) => {
      const m = kvLines[i];
      if (m) rows.push({ label: m[1].trim(), value: m[2].trim() || '—', raw: m[2].trim() });
      else if (rows.length) rows[rows.length - 1].value += ` ${l.trim()}`;
    });
    blocks.push({ kind: 'kv', title, rows });
  } else if (sep && lines.every(l => l.split(sep).length === lines[0].split(sep).length)) {
    const split = l => l.split(sep).map(x => x.trim());
    const columns = split(lines[0]).map((label, i) => ({ name: `c${i}`, label: label || `Column ${i + 1}` }));
    blocks.push({ kind: 'grid', title, columns, rows: lines.slice(1).map((l, ri) => ({ id: `g${ri}`, cells: Object.fromEntries(split(l).map((v, i) => [`c${i}`, { text: v || '—', raw: v }])) })) });
  } else if (lines.length) {
    const leftover = lines.join(' ').replace(/\s+/g, ' ').trim();
    const repeatsATitle = [title, ...blocks.map(b => b.title)].some(t => t && t.trim().toLowerCase() === leftover.toLowerCase());
    if (!repeatsATitle) blocks.push({ kind: 'html', title: blocks.length ? '' : title, html: root.innerHTML });
  }
  return blocks;
}

const SKIP_TYPES = new Set(['geometry', 'blob', 'raster', 'xml', 'esriFieldTypeGeometry', 'esriFieldTypeBlob']);
const isShapeField = name => /^shape([._]|$)/i.test(name) || /^st_(area|length)/i.test(name);

/**
 * @param {object} p
 * @param graphic          feature (attributes + geometry)
 * @param template         SDK PopupTemplate from the web map, or null
 * @param fields           SDK Field[] for the layer (from the query result)
 * @param layerTitle       shown under the card title
 * @param config           manifest.details[key] or undefined
 * @param arcade           the SDK's esri/arcade module
 * @param layer, map, spatialReference, cacheKey   Arcade context
 * @returns {Promise<{ key, layerTitle, title, fields, blocks, graphic, attributes, config }>}
 *   fields: [{ name, label, value, raw }]           attribute table rows
 *   blocks: [{ kind: 'kv', title, rows: [{ label, value, raw }] }                 label/value table
 *          | { kind: 'grid', title, columns, rows: [{ id, cells }] }             rows and columns
 *          | { kind: 'html', title, html } | { kind: 'note', title, text }]
 */
export async function renderFeature(p) {
  const { graphic, template, fields = [], layerTitle, config } = p;
  const attrs = graphic.attributes ?? {};
  const byName = new Map(fields.map(f => [f.name.toLowerCase(), f]));
  const tplFieldInfos = template?.fieldInfos ?? [];
  const infoByName = new Map(tplFieldInfos.map(fi => [fi.fieldName?.toLowerCase(), fi]));

  // Evaluate every Arcade expression the template declares, once.
  const exprValues = new Map();
  for (const info of template?.expressionInfos ?? []) {
    exprValues.set(info.name, await runArcade(p, info.expression));
  }

  const valueOf = name => {
    const n = String(name).trim();
    if (/^expression\//i.test(n)) {
      const v = exprValues.get(n.slice(11));
      return v == null || v === '' ? '—' : (typeof v === 'number' ? formatValue(v, null, infoByName.get(n.toLowerCase())?.format) : String(v));
    }
    return formatValue(attr(attrs, n), byName.get(n.toLowerCase()), infoByName.get(n.toLowerCase())?.format);
  };
  const rawOf = name => {
    const n = String(name).trim();
    return /^expression\//i.test(n) ? exprValues.get(n.slice(11)) ?? null : attr(attrs, n) ?? null;
  };
  const labelOf = (name, fallback) => {
    const n = String(name).toLowerCase();
    if (fallback) return fallback;
    if (n.startsWith('expression/')) return template?.expressionInfos?.find(e => `expression/${e.name}`.toLowerCase() === n)?.title ?? name;
    return infoByName.get(n)?.label || byName.get(n)?.alias || name;
  };
  const hidden = new Set((config?.hideFields ?? []).map(f => f.toLowerCase()));
  const fieldRows = infos => infos
    .filter(fi => fi.visible !== false && fi.fieldName && !hidden.has(fi.fieldName.toLowerCase()))
    .map(fi => ({ name: fi.fieldName, label: labelOf(fi.fieldName, fi.label), value: valueOf(fi.fieldName), raw: rawOf(fi.fieldName) }));
  const fillText = text => String(text ?? '').replace(/\{([^{}]+)\}/g, (_, n) => escapeHtml(valueOf(n)));

  const blocks = [];
  const content = template?.content;
  const elements = typeof content === 'string' ? [{ type: 'text', text: content }] : Array.isArray(content) ? content : [];

  for (const elmt of elements) {
    switch (elmt.type) {
      case 'fields': {
        const rows = fieldRows(elmt.fieldInfos?.length ? elmt.fieldInfos : tplFieldInfos);
        if (rows.length) {
          blocks.push({ kind: 'fields', rows });                                         // feeds the results table
          blocks.push({ kind: 'kv', title: elmt.title ?? '', rows, fromFields: true });  // shown in Details, in order
        }
        break;
      }
      case 'text':
        if (elmt.text) blocks.push(...htmlToBlocks(fillText(elmt.text), elmt.title ?? ''));
        break;
      case 'expression': {
        // Arcade content element: { type: 'text', text } or { type: 'fields', fieldInfos, attributes } (or 'media').
        const r = await runArcade(p, elmt.expressionInfo?.expression ?? '');
        const title = r?.title ?? elmt.expressionInfo?.title ?? '';
        if (r?.type === 'text' && r.text) blocks.push(...htmlToBlocks(fillText(r.text), title));
        if (r?.type === 'fields' && r.attributes) {
          const infos = r.fieldInfos?.length ? r.fieldInfos : Object.keys(r.attributes).map(k => ({ fieldName: k }));
          const rows = infos.filter(fi => !hidden.has(String(fi.fieldName).toLowerCase()))
            .map(fi => ({ label: fi.label ?? fi.fieldName, value: formatValue(r.attributes[fi.fieldName], null, fi.format), raw: r.attributes[fi.fieldName] ?? null }));
          if (rows.length) blocks.push({ kind: 'kv', title, rows });
        }
        if (r?.type === 'media') blocks.push({ kind: 'note', title, text: 'This popup has a chart, which Details doesn\'t show yet.' });
        if (r == null && elmt.expressionInfo?.expression) blocks.push({ kind: 'note', title, text: 'This Arcade expression returned nothing.' });
        break;
      }
      default:
        break;   // media, attachments, relationship: not rendered in this proof of concept
    }
  }

  // The attribute table: the web map's visible fields (template level) even when the popup body is custom
  // text, plus any fields an Arcade "fields" element returned; with no popup at all, every attribute field.
  let fieldTable;
  if (tplFieldInfos.length) fieldTable = fieldRows(tplFieldInfos);
  else if (blocks.some(b => b.kind === 'fields')) fieldTable = blocks.filter(b => b.kind === 'fields').flatMap(b => b.rows);
  // Custom-text popups often mark every field invisible; the table then falls back to all attribute fields.
  if (!fieldTable?.length) {
    const infos = fields.filter(f => !SKIP_TYPES.has(f.type) && !isShapeField(f.name))
      .map(f => ({ fieldName: f.name, label: infoByName.get(f.name.toLowerCase())?.label || f.alias }));
    fieldTable = fieldRows(infos.length ? infos : Object.keys(attrs).filter(k => !isShapeField(k)).map(k => ({ fieldName: k })));
  }

  // Title: Orchestration override, then the web map's template, then the first meaningful field.
  const tplTitle = typeof template?.title === 'string' ? template.title : '';
  let title = config?.title || tplTitle;
  if (title) title = title.replace(/\{([^{}]+)\}/g, (_, n) => valueOf(n));
  else {
    const lead = fieldTable.find(r => !/^(objectid|fid|oid)$/i.test(r.name));
    title = lead ? `${lead.label}: ${lead.value}` : layerTitle;
  }

  // fields: the attribute table. blocks: the popup's other content (Arcade and text elements) as tables where possible.
  return { key: p.key, layerTitle, title, fields: fieldTable, blocks: blocks.filter(b => b.kind !== 'fields'), graphic, attributes: attrs, config };
}
