// resultsView.js — the viewer's results UI, shared by Details (map clicks) and Search:
// one clean, sortable table per layer, and the selected feature's full details underneath. Every table can be
// exported as Excel or CSV (exportForm.js).
// Pure UI: data comes in, selections and loads go out through handlers.
import { el, fill, sanitizeHtml } from './utils.js';
import { signInForm } from './authUi.js';
import { exportControl } from './exportForm.js';
import { exportChoices, rowsColumns } from './tableExport.js';

const PIN_ICON = '<svg viewBox="0 0 20 20" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M10 17.5s5-4.6 5-8.8a5 5 0 0 0-10 0c0 4.2 5 8.8 5 8.8Z"/><circle cx="10" cy="8.6" r="1.8"/></svg>';
const TRACE_ICON = '<svg viewBox="0 0 20 20" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="4" cy="4" r="2"/><circle cx="16" cy="10" r="2"/><circle cx="4" cy="16" r="2"/><path d="M6 4h4a2 2 0 0 1 2 2v2a2 2 0 0 0 2 2M6 16h4a2 2 0 0 0 2-2v-2a2 2 0 0 1 2-2"/></svg>';
const LINK_ICON = '<svg viewBox="0 0 20 20" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M8.5 11.5 11.5 8.5"/><path d="M9 6.5 10.6 5a3 3 0 0 1 4.3 4.3L13.4 11"/><path d="M11 13.5 9.4 15a3 3 0 0 1-4.3-4.3L6.6 9"/></svg>';

/** Cell text, or a link when the value came with one (only http/https reach here). */
export function cellContent(cell) {
  const link = (text, href) => el('a', { href, target: '_blank', rel: 'noopener', class: 'cell-link', onclick: e => e.stopPropagation() }, text);
  if (cell?.items?.length) {
    return el('span', { class: 'cell-list' }, cell.items.map(it => el('span', { class: 'cell-item' }, it.href ? link(it.text, it.href) : it.text)));
  }
  const text = cell?.text ?? '—';
  return cell?.href ? link(text, cell.href) : text;
}

/* ---------------- Sorting ---------------- */
// Grids open newest-first when they have one of these columns (priority order).
const DEFAULT_SORT_COLUMNS = [/^objectid$/i, /^created$/i, /^received$/i];

function defaultSort(columns) {
  for (const re of DEFAULT_SORT_COLUMNS) {
    const col = columns.find(c => re.test(c.name));
    if (col) return { name: col.name, dir: 'desc' };
  }
  return null;
}

function compare(a, b) {
  const x = a?.raw ?? null, y = b?.raw ?? null;
  if (x === y) return 0;
  if (x === null) return 1;              // empties last, whichever direction
  if (y === null) return -1;
  if (typeof x === 'number' && typeof y === 'number') return x - y;
  return String(x).localeCompare(String(y), 'en-ZA', { numeric: true, sensitivity: 'base' });
}

/**
 * Sortable table.
 * @param columns  [{ name, label }]
 * @param rows     [{ id, cells: { [name]: { text, raw } } }]
 * @param onSelect optional (row) => void; makes rows selectable
 */
export function dataTable({ columns, rows, onSelect, selectedId = null, label = '' }) {
  let sort = defaultSort(columns);
  let selected = selectedId;
  const tbody = el('tbody');
  const headCells = new Map();

  const sorted = () => {
    if (!sort) return rows;
    const dir = sort.dir === 'desc' ? -1 : 1;
    return [...rows].sort((a, b) => {
      const c = compare(a.cells[sort.name], b.cells[sort.name]);
      return c === 0 ? 0 : (a.cells[sort.name]?.raw == null || b.cells[sort.name]?.raw == null ? c : c * dir);
    });
  };

  function paint() {
    for (const [name, th] of headCells) th.setAttribute('aria-sort', sort?.name === name ? (sort.dir === 'desc' ? 'descending' : 'ascending') : 'none');
    fill(tbody, sorted().map(r => {
      const tr = el('tr', {
        class: r.id === selected ? 'is-selected' : '',
        tabindex: onSelect ? 0 : null,
        'aria-selected': onSelect ? String(r.id === selected) : null,
        onclick: onSelect ? () => choose(r) : null,
        onkeydown: onSelect ? e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); choose(r); } } : null
      }, columns.map(c => el('td', { title: r.cells[c.name]?.text ?? '' }, cellContent(r.cells[c.name]))));
      return tr;
    }));
  }

  function choose(r) {
    selected = r.id;
    paint();
    onSelect(r);
  }

  const thead = el('thead', {}, el('tr', {}, columns.map(c => {
    const th = el('th', { scope: 'col' },
      el('button', {
        type: 'button', class: 'th-btn',
        onclick: () => { sort = sort?.name === c.name ? { name: c.name, dir: sort.dir === 'asc' ? 'desc' : 'asc' } : { name: c.name, dir: 'asc' }; paint(); }
      }, c.label, el('span', { class: 'sort-mark', 'aria-hidden': 'true' })));
    headCells.set(c.name, th);
    return th;
  })));

  const table = el('table', { class: `grid${onSelect ? ' selectable' : ''}`, 'aria-label': label || null }, thead, tbody);
  paint();
  const wrap = el('div', { class: 'grid-wrap', tabindex: 0 }, table);
  wrap.select = id => { selected = id; paint(); };
  return wrap;
}

/** "Layers checked": every layer Details looked at, and why it did or didn't return features. */
function layerReport(report) {
  if (!report?.length) return null;
  const order = { found: 0, none: 1, failed: 2, skipped: 3 };
  const items = [...report].sort((a, b) => order[a.status] - order[b.status]);
  const failed = items.filter(i => i.status === 'failed').length;
  return el('details', { class: 'layer-report', open: failed > 0 },
    el('summary', {}, `Layers checked (${items.length})${failed ? `, ${failed} couldn't be queried` : ''}`),
    el('ul', {}, items.map(i => el('li', { class: `lr-${i.status}` },
      el('span', { class: 'lr-title' }, i.title),
      el('span', { class: 'lr-note' }, i.note)))));
}

/* ---------------- Results view ---------------- */
/**
 * @param container   element to render into
 * @param handlers    {
 *   onSelect(row, result, { zoom })      a feature was chosen (highlight / zoom)
 *   loadSections(result) -> Promise<sections>
 *   buildActions(result) -> [{ label, href }]
 *   onRunSpatial(result, section)        run a spatial relationship section (results open over the map)
 *   tracesFor(result) -> [{ id, title }]  Attribute traces that start from this feature's layer
 *   onRunTrace(result, traceId)          run one from this feature (its results open over the map)
 *   onClear()
 *   csv: boolean                          offer Export (Excel or CSV) on every table
 *   expandKeys() -> Set<layer key>        layers whose Details section opens by default (empty: the top layer opens)
 * }
 */
export function createResultsView(container, handlers) {
  const described = new Map();
  const sectionLoads = new WeakMap();
  let tables = [];

  const kvTable = rows => el('table', { class: 'grid kv-grid' },
    el('tbody', {}, rows.map(r => el('tr', {}, el('th', { scope: 'row', class: 'kv-label' }, r.label), el('td', { class: 'kv-value' }, cellContent({ text: r.value, href: r.href, items: r.items }))))));

  /**
   * A feature table, laid out by the viewer-wide "fields as" switch:
   *   kind 'kv':   rows = [{ label, value, raw, href?, items? }]
   *                fields as rows    -> Field | Value, one field per row
   *                fields as columns -> one row, a column per field
   *   kind 'grid': lists of records (zones, units, applications) keep one record per row either way,
   *                because turning a list sideways makes it unreadable.
   */
  function tableBlock({ title = '', caption, kind, rows, columns }, { csvName = 'table', tall = false } = {}) {
    const asRows = (handlers.getFieldsAs?.() ?? 'rows') === 'rows';
    let shape;
    if (kind === 'kv' && asRows) {
      shape = { vertical: true, columns: [{ name: 'label', label: 'Field' }, { name: 'value', label: 'Value' }],
        rows: rows.map((r, i) => ({ id: `k${i}`, cells: { label: { text: r.label, raw: r.label }, value: { text: r.value, raw: r.raw ?? null, href: r.href, items: r.items } } })) };
    } else if (kind === 'kv') {
      shape = { columns: rows.map((r, i) => ({ name: `f${i}`, label: r.label })),
        rows: [{ id: 'k0', cells: Object.fromEntries(rows.map((r, i) => [`f${i}`, { text: r.value, raw: r.raw ?? null, href: r.href, items: r.items }])) }] };
    } else {
      shape = { columns, rows };
    }
    const table = shape.vertical
      ? el('div', { class: `grid-wrap${tall ? ' tall' : ''}` }, kvTable(rows))
      : dataTable({ columns: shape.columns, rows: shape.rows, label: title || csvName });
    if (tall && !shape.vertical) table.classList.add('tall');
    const exp = exportFor(title || csvName, shape.columns, shape.rows);
    return collapsible(title,
      exp ? el('span', { class: 'block-actions' }, exp.button) : null,
      [exp?.panel, caption ? el('p', { class: 'block-caption' }, caption) : null, table]);
  }

  /** A titled section whose title folds it open and closed (untitled sections just show their content). */
  function collapsible(title, actions, content) {
    const body = el('div', { class: 'block-body' }, content);
    if (!title) return el('section', { class: 'detail-block' }, el('div', { class: 'block-head untitled' }, actions), body);
    const btn = el('button', {
      type: 'button', class: 'block-toggle', 'aria-expanded': 'true',
      onclick: () => { const open = btn.getAttribute('aria-expanded') !== 'true'; btn.setAttribute('aria-expanded', String(open)); body.hidden = !open; }
    }, el('span', { class: 'chev', 'aria-hidden': 'true' }), el('span', { class: 'block-title' }, title));
    return el('section', { class: 'detail-block' }, el('div', { class: 'block-head' }, btn, actions), body);
  }

  function sectionBlock(s, reload) {
    const title = `${s.section.title}${s.rows.length ? ` (${s.rows.length}${s.truncated ? '+' : ''})` : ''}`;
    if (s.auth) return collapsible(title, null, signInForm({ target: s.auth, message: `These records are secured. Sign in to ${s.auth.label} to see them.`, onSignedIn: () => { handlers.onSignedIn?.(); reload(); } }));
    if (s.error) return collapsible(title, null, [
      el('p', { class: 'err' }, `Couldn't load: ${s.error}`),
      s.where ? el('details', { class: 'tech' }, el('summary', {}, 'Technical details'), el('p', {}, 'Query sent: ', el('code', {}, s.where))) : null]);
    if (s.note) return collapsible(title, null, el('p', { class: 'muted' }, s.note));
    if (!s.rows.length) return collapsible(title, null, el('p', { class: 'muted' }, 'None.'));
    const rows = s.rows.map((r, i) => ({ id: `${s.section.id}-${i}`, cells: r }));
    if (s.section.render === 'fields') {
      return collapsible(title, null, rows.map(r => tableBlock({ kind: 'kv', rows: s.columns.map(c => ({ label: c.label, value: r.cells[c.name]?.text ?? '—', raw: r.cells[c.name]?.raw, href: r.cells[c.name]?.href })) }, { csvName: s.section.title })));
    }
    const exp = exportFor(s.section.title, s.columns, rows);
    return collapsible(title, exp ? el('span', { class: 'block-actions' }, exp.button) : null,
      [exp?.panel, dataTable({ columns: s.columns, rows, label: s.section.title })]);
  }

  /**
   * Export (Excel or CSV) for one table, or null when the Export results tool is off. `ext` (from viewerApp, e.g. a
   * search past its limit) reads every row and offers the layer's other fields: { total, choices, exportAll }.
   * Otherwise the rows in hand with the table's columns; kinds from `fields` when known, else from the values.
   */
  function exportFor(name, columns, rows, { ext = null, fields = [] } = {}) {
    if (!handlers.csv || !rows.length) return null;
    if (ext) return exportControl({ title: name, total: ext.total ?? rows.length, choices: ext.choices, exportAll: ext.exportAll });
    const choices = exportChoices(columns, []);
    return exportControl({ title: name, total: rows.length, choices, exportAll: async picked => ({ columns: rowsColumns(choices, rows, fields, picked), rows }) });
  }

  /** Render one feature's full details into `target`. */
  const openDetails = new Map();     // target element -> what it shows (so the rows/columns switch can redraw them)

  async function renderDetail(target, row, describe, { zoom, showLayer = true }) {
    openDetails.set(target, { row, describe, showLayer });
    fill(target, el('p', { class: 'muted' }, 'Loading details…'));
    if (!described.has(row.id)) described.set(row.id, describe(row));
    let r;
    try { r = await described.get(row.id); }
    catch (e) { fill(target, el('p', { class: 'err' }, `Couldn't load details: ${e.message}`)); return; }
    handlers.onSelect(row, r, { zoom });
    r.fields ??= [];
    r.blocks ??= [];

    const blocks = r.blocks.map(b => {
      if (b.kind === 'kv') return tableBlock({ title: b.title, caption: b.caption, kind: 'kv', rows: b.rows }, { csvName: b.title || r.title });
      if (b.kind === 'grid') return tableBlock({ title: b.title, caption: b.caption, kind: 'grid', columns: b.columns, rows: b.rows }, { csvName: b.title || r.title });
      if (b.kind === 'html') {
        const d = el('div', { class: 'popup-text' }); d.append(sanitizeHtml(b.html));
        return collapsible(b.title, null, d);
      }
      return collapsible(b.title, null, el('p', { class: 'muted' }, b.text));
    });
    const actions = handlers.buildActions(r);
    const loaded = (r.config?.sections ?? []).filter(s => s.type !== 'spatial');
    const spatial = handlers.onRunSpatial ? (r.config?.sections ?? []).filter(s => s.type === 'spatial' && s.targets?.length) : [];
    const sectionsSlot = loaded.length ? el('div', { class: 'detail-sections' }, el('p', { class: 'muted' }, 'Loading related records…')) : null;
    // Spatial relationships can be slow or large, so they only run when asked.
    const spatialRow = spatial.length ? el('div', { class: 'card-actions spatial-actions' }, spatial.map(s => {
      const ico = el('span', { class: 'ico', 'aria-hidden': 'true' }); ico.innerHTML = PIN_ICON;
      const label = el('span', {}, s.title);
      const btn = el('button', {
        type: 'button', class: 'spatial-btn', title: 'Show the results over the map',
        onclick: async () => {
          btn.disabled = true; label.textContent = 'Running…';
          try { await handlers.onRunSpatial(r, s); } finally { btn.disabled = false; label.textContent = s.title; }
        }
      }, ico, label);
      return btn;
    })) : null;
    const traces = handlers.onRunTrace ? handlers.tracesFor?.(r) ?? [] : [];
    const traceRow = traces.length ? el('div', { class: 'card-actions spatial-actions' }, traces.map(t => {
      const ico = el('span', { class: 'ico', 'aria-hidden': 'true' }); ico.innerHTML = TRACE_ICON;
      return el('button', { type: 'button', class: 'spatial-btn', title: 'Run this attribute trace from this feature', onclick: () => handlers.onRunTrace(r, t.id) },
        ico, el('span', {}, `Trace: ${t.title}`));
    })) : null;

    fill(target,
      el('header', { class: 'detail-head' },
        el('h3', { class: 'detail-title' }, r.title),
        showLayer ? el('span', { class: 'detail-layer' }, r.layerTitle) : null),
      // Like Experience Builder: when the popup has its own fields element(s), show the popup's elements in order;
      // otherwise lead with the attribute table.
      r.blocks.some(b => b.fromFields) ? null
        : r.fields.length ? tableBlock({ kind: 'kv', rows: r.fields }, { csvName: r.title, tall: true })
        : (r.blocks.length ? null : el('p', { class: 'muted' }, 'This feature has no attributes to show.')),
      blocks,
      actions.length ? el('div', { class: 'card-actions' }, actions.map(a => {
        const link = el('a', { href: a.href, target: '_blank', rel: 'noopener', class: 'card-link' });
        const ico = el('span', { class: 'ico', 'aria-hidden': 'true' }); ico.innerHTML = LINK_ICON;
        link.append(ico, a.label);
        return link;
      })) : null,
      spatialRow,
      traceRow,
      sectionsSlot);

    if (sectionsSlot) {
      if (!sectionLoads.has(r)) sectionLoads.set(r, handlers.loadSections(r));
      const list = await sectionLoads.get(r);
      const reload = () => { sectionLoads.delete(r); renderDetail(target, row, describe, { zoom: false, showLayer }); };
      fill(sectionsSlot, list.map(sec => sectionBlock(sec, reload)));
    }
  }

  return {
    /**
     * Result tables, one per layer.
     * @param groups [{ key, title, columns, rows: [{ id, cells, ... }], note? }]
     * @param opts   { describe(row), onOpen(row)?, toolbar, emptyText, selectFirst }
     *               onOpen given: a row click hands the feature on (e.g. to Details) instead of showing it here.
     */
    show(groups, { describe, onOpen = null, toolbar = null, emptyText = 'Nothing to show.', selectFirst = true, compact = false, report = null } = {}) {
      described.clear();
      tables = [];
      const total = groups.reduce((n, g) => n + g.rows.length, 0);
      if (!total) { fill(container, toolbar, el('p', { class: 'pane-empty' }, emptyText)); return; }
      const bar = text => el('div', { class: 'results-bar' },
        el('span', {}, text),
        el('button', { type: 'button', class: 'icon-btn', onclick: () => handlers.onClear() }, 'Clear'));

      // compact (map clicks, selections): an accordion, one section per layer in layer-list order.
      // A layer with one feature shows its details straight away; with several, a pick list and the chosen one.
      // The top layer opens, or, once the author has flagged layers to open first, only the flagged ones.
      if (compact && !onOpen) {
        openDetails.clear();
        const items = [];
        const pickColumns = [{ name: '__title', label: 'Feature' }];

        const accItem = (g, index) => {
          const body = el('div', { class: 'acc-body', id: `acc-${index}-${Math.random().toString(36).slice(2, 7)}` });
          const detail = el('div', { class: 'detail', 'aria-live': 'polite' });
          let built = false;
          const build = () => {
            if (built) return;
            built = true;
            if (g.rows.length === 1) {
              body.append(detail);
              renderDetail(detail, g.rows[0], describe, { zoom: false, showLayer: false });
              return;
            }
            const table = dataTable({ columns: pickColumns, rows: g.rows, onSelect: row => renderDetail(detail, row, describe, { zoom: true, showLayer: false }), label: g.title });
            table.classList.add('pick-list');
            table.select(g.rows[0].id);
            body.append(table, detail);
            renderDetail(detail, g.rows[0], describe, { zoom: false, showLayer: false });
          };
          const head = el('button', {
            type: 'button', class: 'acc-head', 'aria-expanded': 'false', 'aria-controls': body.id,
            onclick: () => setOpen(!item.classList.contains('is-open'))
          },
          el('span', { class: 'chev', 'aria-hidden': 'true' }),
          el('span', { class: 'acc-title' }, g.title),
          el('span', { class: 'acc-count' }, `${g.rows.length}`));
          const exp = exportFor(g.title, g.columns, g.rows, { ext: g.export, fields: g.fields });
          const item = el('section', { class: 'acc-item' },
            el('div', { class: 'acc-bar' }, head, exp?.button),
            exp?.panel,
            body);
          const setOpen = open => {
            item.classList.toggle('is-open', open);
            head.setAttribute('aria-expanded', String(open));
            body.hidden = !open;
            if (open) build();
          };
          body.hidden = true;
          items.push({ key: g.key, setOpen });
          return item;
        };

        const groupEls = groups.filter(g => g.rows.length).map(accItem);
        const flagged = handlers.expandKeys?.() ?? new Set();
        const opening = flagged.size ? items.filter(i => flagged.has(i.key)) : items.slice(0, 1);
        let allOpen = items.length > 0 && opening.length === items.length;
        const allBtn = el('button', { type: 'button', class: 'icon-btn' }, allOpen ? 'Collapse all' : 'Expand all');
        allBtn.addEventListener('click', () => { allOpen = !allOpen; items.forEach(i => i.setOpen(allOpen)); allBtn.textContent = allOpen ? 'Collapse all' : 'Expand all'; });

        fill(container,
          toolbar,
          el('div', { class: 'results-bar' },
            el('span', {}, `${total} result${total === 1 ? '' : 's'} in ${groupEls.length} layer${groupEls.length === 1 ? '' : 's'}`),
            el('span', {}, groupEls.length > 1 ? allBtn : null,
              el('button', { type: 'button', class: 'icon-btn', onclick: () => handlers.onClear() }, 'Clear'))),
          layerReport(report),
          el('div', { class: 'accordion' }, groupEls));
        opening.forEach(i => i.setOpen(true));   // the rest wait for a click
        return;
      }

      const detail = onOpen ? null : el('div', { class: 'detail', 'aria-live': 'polite' });
      const select = (row, zoom) => {
        for (const t of tables) t.select(t.rowIds.has(row.id) ? row.id : null);
        if (onOpen) onOpen(row);
        else renderDetail(detail, row, describe, { zoom, showLayer: !compact });
      };
      const pickColumns = [{ name: '__title', label: 'Feature' }];

      const groupEls = groups.filter(g => g.rows.length).map(g => {
        const table = dataTable({ columns: compact ? pickColumns : g.columns, rows: g.rows, onSelect: row => select(row, true), label: g.title });
        if (compact) table.classList.add('pick-list');
        table.rowIds = new Set(g.rows.map(r => r.id));
        tables.push(table);
        const exp = exportFor(g.title, g.columns, g.rows, { ext: g.export, fields: g.fields });
        return el('section', { class: 'result-group' },
          el('div', { class: 'group-head' },
            el('h3', { class: 'group-title' }, g.title, el('span', { class: 'count' }, ` ${g.rows.length}`)),
            exp?.button),
          exp?.panel,
          g.note ? el('p', { class: 'muted' }, g.note) : null,
          table);
      });

      fill(container,
        toolbar,
        bar(`${total} result${total === 1 ? '' : 's'}${onOpen ? '. Choose one to open it in Details.' : ''}`),
        layerReport(report),
        groupEls,
        detail);

      if (selectFirst && !onOpen) {
        const first = groups.find(g => g.rows.length).rows[0];
        for (const t of tables) t.select(t.rowIds.has(first.id) ? first.id : null);
        renderDetail(detail, first, describe, { zoom: false, showLayer: !compact });
      }
    },

    /** One feature on its own, e.g. opened from a search result, with a way back. */
    showSingle(row, { describe, backLabel, onBack }) {
      described.delete(row.id);
      const detail = el('div', { class: 'detail single', 'aria-live': 'polite' });
      fill(container,
        el('div', { class: 'results-bar' },
          onBack ? el('button', { type: 'button', class: 'back-btn', onclick: onBack }, `← ${backLabel}`) : el('span'),
          el('button', { type: 'button', class: 'icon-btn', onclick: () => handlers.onClear() }, 'Clear')),
        detail);
      renderDetail(detail, row, describe, { zoom: true });
    },

    /** Redraw the open feature (e.g. after the rows/columns switch) without querying or zooming again. */
    refresh() {
      for (const [target, d] of openDetails) {
        if (!target.isConnected) { openDetails.delete(target); continue; }
        if (target.closest('[hidden]')) continue;
        renderDetail(target, d.row, d.describe, { zoom: false, showLayer: d.showLayer });
      }
    },

    loading(text = 'Searching…', toolbar = null) { fill(container, toolbar, el('p', { class: 'pane-empty' }, text)); },
    empty(text, toolbar = null, report = null) { fill(container, toolbar, el('p', { class: 'pane-empty' }, text), layerReport(report)); }
  };
}

/** Identify / selection results (already described) -> table groups, one per layer. */
export function groupsFromResults(results) {
  const byKey = new Map();
  results.forEach((r, i) => {
    if (!byKey.has(r.key)) byKey.set(r.key, { key: r.key, title: r.layerTitle, columns: null, rows: [] });
    const g = byKey.get(r.key);
    r.fields ??= [];
    if (!g.columns) g.columns = r.fields.length ? r.fields.map(x => ({ name: x.name, label: x.label })) : [{ name: '__title', label: 'Feature' }];
    const cells = Object.fromEntries(r.fields.map(x => [x.name, { text: x.value, raw: x.raw ?? null }]));
    cells.__title = { text: r.title, raw: r.title };
    g.rows.push({ id: `r${i}`, cells, result: r });
  });
  return [...byKey.values()];
}
