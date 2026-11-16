// viewer.js — the GIS Viewer shell: branded header, widget buttons (rail or header, per template),
// and the panes (Layers, Legend, Layer information, Details, Bookmarks, Search, Add data, Tools). Dashboards, Editing, Scene, Streaming,
// External pages, Downloads and Attribute trace open over the map instead of in the panel; their buttons are drawn here and handled by viewerApp.js.
// Renders a published manifest and emits user actions; it never edits the manifest or touches the SDK.
import { CONFIG } from './config.js';
import { el, fill, add, formatDateTime, parseCoordinate, slug, downloadDataUrl, inOrder } from './utils.js';
import { createResultsView, groupsFromResults } from './resultsView.js';
import { buildWhere, operatorsFor, operatorLabel, OPERATORS } from './query.js';
import { signInForm } from './authUi.js';
import { createDashboards } from './dashboards.js';
import { createAddDataPane } from './addDataPane.js';
import { createLayerInfoPane } from './layerInfoPane.js';
import { isResultsAt, DOCK_DEFAULT, dockGrip, dockRect } from './resultsDock.js';

const ICONS = {
  layers:    '<path d="M10 3 2 7l8 4 8-4-8-4Z"/><path d="m2 11 8 4 8-4"/><path d="m2 14.5 8 4 8-4"/>',
  legend:    '<rect x="3" y="4" width="4" height="3" rx=".5"/><rect x="3" y="9" width="4" height="3" rx=".5"/><rect x="3" y="14" width="4" height="3" rx=".5"/><path d="M10 5.5h7M10 10.5h7M10 15.5h7"/>',
  details:   '<circle cx="10" cy="10" r="7.5"/><path d="M10 9v5"/><circle cx="10" cy="6.3" r=".6" fill="currentColor"/>',
  layerInfo: '<path d="M8 3 1.5 6.25 8 9.5l6.5-3.25Z"/><path d="m1.5 9.75 4.5 2.25M1.5 13.25 6 15.5"/><circle cx="14" cy="14" r="4"/><path d="M14 13.4v2.6"/><circle cx="14" cy="11.7" r=".4" fill="currentColor"/>',
  bookmarks: '<path d="M5.5 3h9v14l-4.5-3.2L5.5 17Z"/>',
  search:    '<circle cx="8.5" cy="8.5" r="5"/><path d="m12.3 12.3 4.7 4.7"/>',
  tools:     '<path d="M3 14.5 14.5 3 17 5.5 5.5 17Z"/><path d="m6 11.5 1.5 1.5M8.5 9l1.5 1.5M11 6.5 12.5 8"/>',
  addData:   '<path d="M10 3 2 7l8 4 8-4-8-4Z"/><path d="m2 11 8 4 3.5-1.75"/><path d="M15.5 12v6M12.5 15h6"/>',
  dashboards: '<rect x="3" y="3" width="6" height="8" rx="1"/><rect x="11" y="3" width="6" height="5" rx="1"/><rect x="11" y="10" width="6" height="7" rx="1"/><rect x="3" y="13" width="6" height="4" rx="1"/>',
  editing:   '<path d="M3.5 16.5h4L16 8a2.1 2.1 0 0 0-3-3l-8.5 8.5Z"/><path d="m11.5 6.5 3 3"/><path d="M10.5 16.5h6"/>',
  scene:     '<path d="M10 2.5 3 6.25v7.5L10 17.5l7-3.75v-7.5Z"/><path d="M3 6.25 10 10l7-3.75M10 10v7.5"/>',
  cameras:   '<rect x="2.5" y="4.5" width="11" height="6" rx="1" transform="rotate(-10 8 7.5)"/><path d="m13.6 6 3.9-1.2v4.6l-3.6-.8"/><path d="M7 11.3V15H3.5M3.5 12.5v5"/>',
  drones:    '<circle cx="5" cy="5" r="2.5"/><circle cx="15" cy="5" r="2.5"/><circle cx="5" cy="15" r="2.5"/><circle cx="15" cy="15" r="2.5"/><rect x="8" y="8" width="4" height="4" rx="1"/><path d="M6.8 6.8 8 8M13.2 6.8 12 8M6.8 13.2 8 12M13.2 13.2 12 12"/>',
  tracking:  '<path d="M4 16.5c2.5 0 3-3 6-3s2.5-4 5.5-4"/><circle cx="4" cy="16.5" r="1.5"/><path d="M15.5 9.5s3-2.6 3-4.8a3 3 0 0 0-6 0c0 2.2 3 4.8 3 4.8Z"/><circle cx="15.5" cy="4.7" r=".8" fill="currentColor"/>',
  streaming: '<circle cx="10" cy="10" r="1.8"/><path d="M6.8 13.2a4.5 4.5 0 0 1 0-6.4M13.2 6.8a4.5 4.5 0 0 1 0 6.4"/><path d="M4.3 15.7a8 8 0 0 1 0-11.4M15.7 4.3a8 8 0 0 1 0 11.4"/>',
  externalPages: '<rect x="2.5" y="3.5" width="15" height="13" rx="1.5"/><path d="M2.5 7h15"/><path d="M8.5 10.5h4v4"/><path d="m12.5 10.5-5 5"/>',
  downloads: '<path d="M10 3v9"/><path d="m6.5 8.5 3.5 3.5 3.5-3.5"/><path d="M3.5 13.5v2a1 1 0 0 0 1 1h11a1 1 0 0 0 1-1v-2"/>',
  trace:     '<circle cx="4" cy="4" r="2"/><circle cx="16" cy="10" r="2"/><circle cx="4" cy="16" r="2"/><path d="M6 4h4a2 2 0 0 1 2 2v2a2 2 0 0 0 2 2M6 16h4a2 2 0 0 0 2-2v-2a2 2 0 0 1 2-2"/>',
  widen:     '<path d="M3 10h14"/><path d="m6 7-3 3 3 3"/><path d="m14 7 3 3-3 3"/>',
  close:     '<path d="m5 5 10 10M15 5 5 15"/>'
};
/** A 20px line icon from SVG path markup (trusted, written in code). */
export const svgIcon = paths => {
  const span = el('span', { class: 'ico', 'aria-hidden': 'true' });
  span.innerHTML = `<svg viewBox="0 0 20 20" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round">${paths}</svg>`;
  return span;
};
export const icon = name => svgIcon(ICONS[name]);

/** Esri icon-font glyph for a tool (see CONFIG.toolIcons). */
export const toolIcon = id => el('span', { class: `ico tool-ico ${CONFIG.toolIcons[id] ?? 'esri-icon-applications'}`, 'aria-hidden': 'true' });

const WIDE_PANES = new Set(['details', 'search']);

export function createViewer({ section, brand, panel }, handlers) {
  const notice = el('div', { class: 'notice', role: 'status', hidden: true });
  const paneHost = el('div', { class: 'panes' });
  const content = el('div', { class: 'vp-content' }, notice, paneHost);
  const rail = el('nav', { class: 'rail', 'aria-label': 'Map widgets' });
  const headerNav = el('nav', { class: 'header-widgets', 'aria-label': 'Map widgets' });
  panel.replaceChildren(content, rail);

  // Dashboards expand across the whole viewer (over the map and panel).
  const dashOverlay = el('div', { class: 'dash-overlay', hidden: true, role: 'region', 'aria-label': 'Dashboards' });
  section.querySelector('.viewer-body')?.append(dashOverlay);

  // Details and Search docked along the bottom of the map (layout.resultsAt 'bottom', or people's own choice): their
  // panes move into this drawer, and the side panel goes on showing the other widgets.
  const bodyEl = section.querySelector('.viewer-body') ?? section;
  const dockEl = el('section', { class: 'results-dock', role: 'region', 'aria-label': 'Results', hidden: true });
  bodyEl.append(dockEl);
  let dockRatio = DOCK_DEFAULT;
  const dockMapRect = () => {
    const hostR = bodyEl.getBoundingClientRect(), m = (bodyEl.querySelector('.map') ?? bodyEl).getBoundingClientRect();
    return { left: m.left - hostR.left, top: m.top - hostR.top, width: m.width, height: m.height };
  };
  const dockHandle = dockGrip({ host: bodyEl, mapRect: dockMapRect, get: () => dockRatio, set: r => { dockRatio = r; layoutDock(); }, label: 'results' });
  dockEl.append(dockHandle.grip);
  dockEl.addEventListener('keydown', e => { if (e.key === 'Escape' && !e.target.closest('select, input')) { e.stopPropagation(); closeDock(); } });
  window.addEventListener('resize', () => { if (!dockEl.hidden) layoutDock(); });
  let dashButton = null;
  let dashReady = false;
  let editButton = null;
  let sceneButton = null;
  let streamingButton = null;
  let pagesButton = null;
  let downloadsButton = null;
  let traceButton = null;
  const dash = createDashboards(dashOverlay, {
    runStat: w => handlers.onDashboardStat(w),
    layerTitle: key => handlers.layerTitle?.(key) ?? '',
    arrange: handlers.dashboardArrange,
    onClose: () => closeDashboards()
  });

  function openDashboards() {
    dashOverlay.hidden = false;
    for (const p of panes.values()) p.buttons.forEach(b => b.setAttribute('aria-pressed', 'false'));   // only Dashboards looks selected
    dashButton?.setAttribute('aria-pressed', 'true');
    section.classList.add('dash-open');
    if (dashReady) dash.draw();
    else dashOverlay.querySelector('.dash-grid')?.replaceChildren(el('p', { class: 'pane-empty' }, 'Loading the map…'));
  }

  function closeDashboards() {
    if (dashOverlay.hidden) return;
    dashOverlay.hidden = true;
    dash.destroy();
    dashButton?.setAttribute('aria-pressed', 'false');
    section.classList.remove('dash-open');
    // Back to the map: the pane that was open underneath looks selected again.
    if (current && panes.has(current) && !panel.classList.contains('collapsed')) panes.get(current).buttons.forEach(b => b.setAttribute('aria-pressed', 'true'));
  }

  let manifest = null;
  let panes = new Map();
  let current = null;
  let toolsState = null;
  let detailsView = null;
  let layerInfoPane = null;   // the Layer information pane (layerInfoPane.js), when that widget is on
  let searchState = null;
  let fieldsAs = 'rows';          // viewer-wide: feature tables show fields as rows (Field | Value) or columns
  let resultsAt = 'panel';        // viewer-wide: Details and Search in the side panel or docked at the bottom
  let dockName = null;            // the pane showing in the dock

  const fieldsAsKey = () => `gis-orchestrator.fieldsAs.${manifest?.id ?? ''}`;

  function setFieldsAs(value) {
    fieldsAs = value;
    try { localStorage.setItem(fieldsAsKey(), value); } catch { /* storage blocked */ }
    paneHost.querySelectorAll('.fields-as button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.value === value)));
    detailsView?.refresh();
    searchState?.view.refresh();
  }

  const resultsAtKey = () => `gis-orchestrator.resultsAt.${manifest?.id ?? ''}`;
  const docked = name => resultsAt === 'bottom' && WIDE_PANES.has(name) && panes.has(name);

  function layoutDock() {
    if (dockEl.hidden) { handlers.onDockPadding?.(0); return; }
    const r = dockRect(dockMapRect(), dockRatio);
    Object.assign(dockEl.style, { left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` });
    dockHandle.sync();
    handlers.onDockPadding?.(r.height);
  }

  function openDock(name) {
    dockName = name;
    for (const [n, p] of panes) {
      if (!docked(n)) continue;
      if (p.pane.parentElement !== dockEl) dockEl.append(p.pane);
      p.pane.hidden = n !== name;
      p.buttons.forEach(b => b.setAttribute('aria-pressed', String(n === name)));
    }
    dockEl.hidden = false;
    layoutDock();
  }

  function closeDock() {
    if (dockEl.hidden) return;
    dockEl.hidden = true;
    dockName = null;
    for (const [n, p] of panes) if (docked(n)) p.buttons.forEach(b => b.setAttribute('aria-pressed', 'false'));
    layoutDock();
  }

  /** Details and Search move between the side panel and the bottom of the map; people's choice is remembered. */
  function setResultsAt(value) {
    if (!isResultsAt(value) || value === resultsAt) return;
    const inDock = dockEl.hidden ? null : dockName;
    const inPanel = !panel.classList.contains('collapsed') && WIDE_PANES.has(current) ? current : null;
    closeDock();
    if (inPanel) close();
    resultsAt = value;
    try { localStorage.setItem(resultsAtKey(), value); } catch { /* storage blocked */ }
    if (value === 'panel') for (const n of WIDE_PANES) { const p = panes.get(n); if (p) { p.pane.hidden = true; paneHost.append(p.pane); } }
    bodyEl.querySelectorAll('.results-at button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.value === value)));
    const reopen = inDock ?? inPanel;
    if (reopen) open(reopen);
  }

  /** The side panel / bottom switch on Details and Search. */
  function resultsAtSwitch() {
    return el('div', { class: 'fields-as results-at', role: 'group', 'aria-label': 'Show results' },
      [['panel', 'Side', 'Results in the side panel'], ['bottom', 'Bottom', 'Results docked at the bottom of the map']].map(([v, label, title]) =>
        el('button', { type: 'button', 'data-value': v, title, 'aria-pressed': String(resultsAt === v), onclick: () => setResultsAt(v) }, label)));
  }

  /** The one rows/columns switch, shown in the panes that display feature details. */
  function fieldsAsSwitch() {
    return el('div', { class: 'fields-as', role: 'group', 'aria-label': 'Show fields as' },
      [['rows', 'Rows', 'Fields as rows (Field | Value)'], ['columns', 'Columns', 'Fields as columns (one row)']].map(([v, label, title]) =>
        el('button', { type: 'button', 'data-value': v, title, 'aria-pressed': String(fieldsAs === v), onclick: () => setFieldsAs(v) }, label)));
  }

  /* ---------------- Brand header ---------------- */
  function renderBrand(m) {
    const b = m?.branding ?? CONFIG.defaultBranding;
    section.style.setProperty('--brand-bg', b.headerBg);
    section.style.setProperty('--brand-text', b.headerText);
    section.style.setProperty('--accent', b.accent);
    fill(brand,
      b.logo ? el('img', { class: 'brand-logo', src: b.logo, alt: '' }) : null,
      el('div', { class: 'brand-text' },
        el('span', { class: 'brand-title', title: m ? `Version ${m.version}, published ${formatDateTime(m.publishedAt)}` : '' }, m?.title ?? 'GIS Viewer'),
        b.subtitle ? el('span', { class: 'brand-subtitle' }, b.subtitle) : null),
      headerNav);
  }
  renderBrand(null);

  /* ---------------- Opening and closing panes ---------------- */
  function open(name) {
    if (name === 'dashboards') { openDashboards(); return; }
    if (!panes.has(name)) return;
    closeDashboards();
    if (docked(name)) { openDock(name); return; }
    current = name;
    panel.classList.remove('collapsed');
    panel.classList.toggle('wide', WIDE_PANES.has(name) && panel.dataset.wide === 'yes');
    for (const [n, p] of panes) {
      if (docked(n)) continue;          // Details / Search at the bottom stay as they are
      const on = n === name;
      p.pane.hidden = !on;
      p.buttons.forEach(b => { b.setAttribute('aria-pressed', String(on)); });
    }
  }

  function close() {
    panel.classList.add('collapsed');
    for (const [n, p] of panes) if (!docked(n)) p.buttons.forEach(b => b.setAttribute('aria-pressed', 'false'));
  }

  const toggle = name => {
    if (docked(name)) {
      if (!dashOverlay.hidden) { closeDashboards(); if (!dockEl.hidden && dockName === name) return; }
      return !dockEl.hidden && dockName === name ? closeDock() : open(name);
    }
    if (!dashOverlay.hidden) { closeDashboards(); if (current === name && !panel.classList.contains('collapsed')) return; }
    return current === name && !panel.classList.contains('collapsed') ? close() : open(name);
  };
  const placeholder = text => el('p', { class: 'pane-empty' }, text);

  function widenButton() {
    return el('button', {
      type: 'button', class: 'icon-btn widen', 'aria-pressed': String(panel.dataset.wide === 'yes'), title: 'Wider panel for tables',
      onclick: () => {
        const on = panel.dataset.wide !== 'yes';
        panel.dataset.wide = on ? 'yes' : 'no';
        panel.classList.toggle('wide', on);
        paneHost.querySelectorAll('.widen').forEach(b => b.setAttribute('aria-pressed', String(on)));
      }
    }, icon('widen'), el('span', { class: 'sr-only' }, 'Wider panel'));
  }

  /* ---------------- Details ---------------- */
  const resultsHandlers = onClear => ({
    onSelect: (row, result, { zoom }) => handlers.onSelectFeature(result, { zoom, emphasis: row.emphasis }),   // search rows carry their search's emphasis
    loadSections: handlers.loadSections,
    buildActions: handlers.buildActions,
    onRunSpatial: handlers.onRunSpatial,
    tracesFor: handlers.tracesFor,
    onRunTrace: handlers.onRunTrace,
    onSignedIn: handlers.onSignedIn,
    onClear,
    csv: manifest?.widgets.tools.includes('export-results') ?? false,
    getFieldsAs: () => fieldsAs,
    expandKeys: () => new Set(Object.entries(manifest?.details ?? {}).filter(([, c]) => c?.expand === true).map(([k]) => k))
  });

  /** "Back to n search results" while Search holds results (until they're cleared); null when it holds none. */
  function searchBackLabel() {
    const n = searchState?.lastGroups?.reduce((t, g) => t + g.rows.length, 0) ?? 0;
    return n ? `Back to ${n} search result${n === 1 ? '' : 's'}` : null;
  }

  /** The link back to Search over map-click results in Details, so a click on the map doesn't lose the way back. */
  function searchBackBar() {
    const label = searchBackLabel();
    return label ? el('div', { class: 'results-bar search-back-bar' },
      el('button', { type: 'button', class: 'back-btn', onclick: () => open('search') }, `← ${label}`)) : null;
  }

  /** A new search or Clear in Search: links back already in Details show the new count, or go. */
  function syncSearchBack() {
    const label = searchBackLabel();
    paneHost.querySelectorAll('.back-btn').forEach(b => {    // Details' only back links lead to Search
      if (label) b.textContent = `← ${label}`;
      else if (b.parentElement.classList.contains('search-back-bar')) b.parentElement.remove();
      else b.replaceWith(el('span'));            // showSingle's bar keeps its Clear on the right
    });
  }

  function showDetails(results, { emptyText, report = null } = {}) {
    if (!detailsView) return;
    if (results === 'loading') { detailsView.loading('Finding features…', searchBackBar()); return; }
    if (!results.length) { detailsView.empty(emptyText ?? 'Click the map to see the features there.', searchBackBar(), report); return; }
    detailsView.show(groupsFromResults(results), { describe: row => Promise.resolve(row.result), compact: true, report, toolbar: searchBackBar() });
  }

  /** A search result (attribute search or search box) opened in Details, with a link back to the search. */
  function openFromSearch(row) {
    if (!detailsView) return false;
    open('details');
    detailsView.showSingle(row, {
      describe: handlers.describeSearchRow,
      backLabel: searchBackLabel() ?? 'Back to search',
      onBack: () => open('search')
    });
    return true;
  }

  /* ---------------- Search (attribute query builder) ---------------- */
  const newCondition = source => ({ field: source.fields[0]?.name, op: source.defaultOperator, value: '', value2: '' });

  function renderSearch() {
    const s = searchState;
    if (!s) return;
    const source = s.sources.find(x => x.key === s.key);
    const toolbar = el('div', { class: 'query' });
    if (s.boxNode) toolbar.append(el('div', { class: 'search-box' }, s.boxNode));
    const opts = { toolbar, emptyText: 'No features match.', describe: handlers.describeSearchRow, onOpen: detailsView ? row => openFromSearch(row) : null };
    if (!source) {                         // the search box on its own: its results show below it
      s.toolbar = toolbar;
      if (s.lastGroups) s.view.show(s.lastGroups, opts);
      else if (s.boxNode) s.view.empty(s.ran ? 'Nothing found.' : 'Type in the box to search.', toolbar);
      else fill(s.body, toolbar, placeholder('No search is set up for this map.'));
      return;
    }

    const fieldByName = new Map(source.fields.map(f => [f.name, f]));
    const condRow = (c, i) => {
      const f = fieldByName.get(c.field) ?? source.fields[0];
      const ops = operatorsFor(f.kind, source.operators);
      if (!ops.includes(c.op)) c.op = ops.includes(source.defaultOperator) ? source.defaultOperator : ops[0];
      const arity = OPERATORS[c.op]?.arity ?? 1;
      const valueIn = (prop, ph) => el('input', {
        type: f.kind === 'date' ? 'date' : 'text', value: c[prop] ?? '', placeholder: ph, 'aria-label': ph,
        inputmode: f.kind === 'number' ? 'decimal' : null,
        oninput: e => { c[prop] = e.target.value; },
        onkeydown: e => { if (e.key === 'Enter') run(); }
      });
      return el('div', { class: 'cond' },
        el('select', { 'aria-label': 'Field', onchange: e => { c.field = e.target.value; c.value = ''; c.value2 = ''; renderSearch(); } },
          source.fields.map(x => el('option', { value: x.name, selected: x.name === f.name }, x.alias))),
        el('select', { 'aria-label': 'Operator', onchange: e => { c.op = e.target.value; renderSearch(); } },
          ops.map(op => el('option', { value: op, selected: op === c.op }, operatorLabel(op, f.kind)))),
        arity >= 1 ? valueIn('value', c.op === 'in' ? 'Values, comma separated' : arity === 2 ? 'From' : 'Value') : null,
        arity === 2 ? valueIn('value2', 'To') : null,
        s.conditions.length > 1 ? el('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Remove condition', onclick: () => { s.conditions.splice(i, 1); renderSearch(); } }, '×') : null);
    };

    add(toolbar,
      s.sources.length > 1
        ? el('label', { class: 'field' }, 'Search in',
            el('select', { onchange: e => { s.key = e.target.value; s.conditions = [newCondition(s.sources.find(x => x.key === s.key))]; s.lastGroups = null; s.ran = false; renderSearch(); syncSearchBack(); } },
              s.sources.map(x => el('option', { value: x.key, selected: x.key === s.key }, x.title))))
        : el('p', { class: 'query-source' }, source.title),
      source.hint ? el('p', { class: 'muted' }, source.hint) : null,
      s.conditions.length > 1 ? el('div', { class: 'match' }, 'Match',
        ['all', 'any'].map(m => el('label', { class: 'check-row' },
          el('input', { type: 'radio', name: 'match', checked: s.match === m, onchange: () => { s.match = m; } }),
          m === 'all' ? 'all conditions' : 'any condition'))) : null,
      s.conditions.map(condRow),
      el('div', { class: 'query-actions' },
        el('button', { type: 'button', class: 'btn primary', onclick: run }, 'Search'),
        el('button', { type: 'button', class: 'btn quiet', onclick: () => { s.conditions.push(newCondition(source)); renderSearch(); } }, 'Add condition'),
        s.lastGroups ? el('button', { type: 'button', class: 'btn quiet', onclick: () => handlers.onZoomToResults(s.lastGroups) }, 'Zoom to results') : null),
      s.error ? el('p', { class: 'err' }, s.error) : null);

    s.toolbar = toolbar;
    if (s.lastGroups) s.view.show(s.lastGroups, opts);
    else s.view.empty(s.ran ? 'No features match.' : 'Choose a field and an operator, then search.', toolbar);
  }

  async function run() {
    const s = searchState;
    const source = s.sources.find(x => x.key === s.key);
    const fieldByName = new Map(source.fields.map(f => [f.name, f]));
    let where;
    try { where = buildWhere(s.conditions.map(c => ({ ...c, kind: fieldByName.get(c.field)?.kind })), s.match); }
    catch (e) { s.error = e.message; renderSearch(); return; }
    s.error = null;
    s.view.loading('Searching…', s.toolbar);
    try {
      const groups = await handlers.onRunSearch(source, where);
      s.lastGroups = groups.some(g => g.rows.length) ? groups : null;
      s.ran = true;
    } catch (e) { s.error = `The search failed: ${e.message}`; s.lastGroups = null; }
    renderSearch();
    syncSearchBack();
  }

  /* ---------------- Tools ---------------- */
  // Tools with their own small forms here; SDK tools are mounted by main.js into the slot.
  const CUSTOM_TOOL_UI = {
    select: (slot, cfg) => {
      const status = el('p', { class: 'muted' }, cfg.layers.length ? `Selects from ${cfg.layers.length} layer${cfg.layers.length > 1 ? 's' : ''}.` : 'Selects from every visible layer.');
      fill(slot,
        el('p', { class: 'tool-help' }, 'Draw a shape on the map. The features inside it open in Details as tables.'),
        el('div', { class: 'seg' }, cfg.shapes.map(shape => el('button', {
          type: 'button', class: 'seg-btn',
          onclick: async () => {
            status.textContent = shape === 'polygon' ? 'Click to add corners; double-click to finish.' : 'Draw on the map…';
            const n = await handlers.onSelectShape(shape, cfg.layers);
            status.textContent = n == null ? 'Cancelled.' : `${n} feature${n === 1 ? '' : 's'} selected.`;
          }
        }, CONFIG.selectShapes.find(([id]) => id === shape)?.[1] ?? shape))),
        status);
    },
    'go-to-xy': (slot, cfg) => {
      const lat = el('input', { type: 'text', placeholder: 'Latitude, e.g. -34.4187 or 34°25′7″S', 'aria-label': 'Latitude' });
      const lon = el('input', { type: 'text', placeholder: 'Longitude, e.g. 19.2345 or 19°14′4″E', 'aria-label': 'Longitude' });
      const msg = el('p', { class: 'muted' });
      const go = () => {
        const y = parseCoordinate(lat.value), x = parseCoordinate(lon.value);
        if (y == null || Math.abs(y) > 90) { msg.className = 'err'; msg.textContent = 'Enter a latitude between -90 and 90.'; return; }
        if (x == null || Math.abs(x) > 180) { msg.className = 'err'; msg.textContent = 'Enter a longitude between -180 and 180.'; return; }
        msg.className = 'muted'; msg.textContent = `Showing ${y.toFixed(5)}, ${x.toFixed(5)}.`;
        handlers.onGoToXY(y, x, cfg.zoom);
      };
      [lat, lon].forEach(i => i.addEventListener('keydown', e => { if (e.key === 'Enter') go(); }));
      fill(slot, el('div', { class: 'xy' }, lat, lon), el('button', { type: 'button', class: 'btn primary', onclick: go }, 'Go'), msg);
    },
    'share-link': slot => {
      const out = el('input', { type: 'text', readonly: true, 'aria-label': 'Link to this view', onfocus: e => e.target.select() });
      const msg = el('p', { class: 'muted' }, 'The link opens this viewer at the current map view.');
      const copy = async () => {
        out.value = handlers.getShareLink();
        try { await navigator.clipboard.writeText(out.value); msg.textContent = 'Copied to the clipboard.'; }
        catch { out.select(); msg.textContent = 'Select the link and copy it.'; }
      };
      fill(slot, el('div', { class: 'add-row' }, out, el('button', { type: 'button', class: 'btn primary', onclick: copy }, 'Copy link')), msg);
      out.value = handlers.getShareLink();
    },
    screenshot: (slot, cfg) => {
      const msg = el('p', { class: 'muted' }, 'Saves an image of the map as it is showing now.');
      const preview = el('div', { class: 'screenshot-preview' });
      const ext = cfg.format === 'jpg' ? 'jpg' : 'png';
      const stamp = () => new Date().toISOString().slice(0, 16).replace(/[-:]/g, '').replace('T', '-');
      const take = async area => {
        msg.className = 'muted';
        msg.textContent = area ? 'Drag a rectangle on the map…' : 'Taking the screenshot…';
        try {
          const dataUrl = await handlers.onScreenshot(ext, area);
          if (!dataUrl) { msg.textContent = 'Cancelled.'; return; }
          const name = `${slug(manifest.title || 'map')}-${stamp()}.${ext}`;
          await downloadDataUrl(dataUrl, name);
          fill(preview, el('img', { src: dataUrl, alt: 'Screenshot of the map' }));
          msg.textContent = `Saved ${name}.`;
        } catch (e) { msg.className = 'err'; msg.textContent = `The screenshot failed: ${e.message}`; }
      };
      fill(slot,
        el('p', { class: 'tool-help' }, 'Captures the map and its layers (not the panel or map buttons) and downloads it.'),
        el('div', { class: 'seg' },
          el('button', { type: 'button', class: 'seg-btn', onclick: () => take(false) }, 'Whole map'),
          el('button', { type: 'button', class: 'seg-btn', onclick: () => take(true) }, 'Choose an area')),
        msg, preview);
    }
  };

  function setTool(id) {
    if (!toolsState) return;
    const previous = toolsState.active;
    toolsState.active = id;
    for (const [tid, btn] of toolsState.buttons) {
      btn.setAttribute('aria-pressed', String(tid === id));
      toolsState.slots.get(tid).hidden = tid !== id;
    }
    if (previous && CUSTOM_TOOL_UI[previous]) fill(toolsState.slots.get(previous));
    const cfg = manifest.widgets.toolConfig?.[id] ?? {};
    if (id && CUSTOM_TOOL_UI[id]) CUSTOM_TOOL_UI[id](toolsState.slots.get(id), cfg);
    handlers.onToolChange(id, id ? toolsState.slots.get(id) : null, cfg);
  }

  /* ---------------- Panes ---------------- */
  const builders = {
    layers: body => body.append(placeholder('Loading layers…')),
    legend: body => body.append(placeholder('Loading legend…')),
    details: body => {
      detailsView = createResultsView(body, resultsHandlers(() => { handlers.onClearSelection(); showDetails([]); }));
      showDetails([]);
    },
    layerInfo: body => {
      layerInfoPane = createLayerInfoPane(body, { loadService: handlers.aboutService });
      body.append(placeholder('Loading layer information…'));
    },
    bookmarks: body => body.append(placeholder('Loading bookmarks…')),
    search: body => body.append(placeholder('Loading search…')),
    addData: (body, m) => { createAddDataPane(body, m.addData, handlers.addData); },
    tools: (body, m) => {
      toolsState = { active: null, buttons: new Map(), slots: new Map() };
      for (const [id, label] of inOrder(CONFIG.tools, m.widgets.toolOrder)) {
        if (!m.widgets.tools.includes(id) || CONFIG.passiveTools.includes(id)) continue;
        const slot = el('div', { class: 'tool-slot', hidden: true });
        const btn = el('button', { type: 'button', class: 'list-btn', 'aria-pressed': 'false', onclick: () => setTool(toolsState.active === id ? null : id) },
          toolIcon(id), label);
        toolsState.buttons.set(id, btn);
        toolsState.slots.set(id, slot);
        body.append(btn, slot);
      }
      if (m.widgets.tools.includes('coordinates')) body.append(el('p', { class: 'tool-note' }, 'Pointer coordinates show at the bottom left of the map.'));
    }
  };

  return {
    render(m) {
      manifest = m;
      renderBrand(m);
      notice.hidden = true;
      panes = new Map();
      toolsState = null;
      detailsView = null;
      layerInfoPane = null;
      searchState = null;
      paneHost.replaceChildren();
      dockEl.hidden = true;
      dockName = null;
      dockEl.replaceChildren(dockHandle.grip);
      handlers.onDockPadding?.(0);
      rail.replaceChildren();
      headerNav.replaceChildren();

      try { fieldsAs = localStorage.getItem(fieldsAsKey()) || m.layout?.fieldsAs || 'rows'; }
      catch { fieldsAs = m.layout?.fieldsAs || 'rows'; }
      if (!['rows', 'columns'].includes(fieldsAs)) fieldsAs = 'rows';
      try { resultsAt = localStorage.getItem(resultsAtKey()) || m.layout?.resultsAt || 'panel'; }
      catch { resultsAt = m.layout?.resultsAt || 'panel'; }
      if (!isResultsAt(resultsAt)) resultsAt = 'panel';

      const template = m.layout?.template ?? 'rail';
      section.dataset.template = template;
      section.dataset.side = m.layout?.panelSide ?? 'right';
      const inHeader = template !== 'rail';

      const panelTools = m.widgets.tools.filter(t => !CONFIG.passiveTools.includes(t));
      const enabled = inOrder(CONFIG.widgets, m.widgets.order).filter(([id]) => (id === 'tools' ? panelTools.length : m.widgets[id]));
      panel.classList.toggle('no-widgets', enabled.length === 0);

      closeDashboards();
      dashButton = null;
      dashReady = false;
      editButton = null;
      sceneButton = null;
      streamingButton = null;
      pagesButton = null;
      downloadsButton = null;
      traceButton = null;
      for (const [id, label] of enabled) {
        if (id === 'trace') {
          traceButton = el('button', { type: 'button', class: inHeader ? 'head-btn' : 'rail-btn', 'aria-pressed': 'false', title: 'Attribute trace (features linked to a starting feature)', onclick: () => handlers.onToggleTrace?.() },
            icon('trace'), el('span', { class: 'btn-label' }, label));
          (inHeader ? headerNav : rail).append(traceButton);
          continue;
        }
        if (id === 'downloads') {
          downloadsButton = el('button', { type: 'button', class: inHeader ? 'head-btn' : 'rail-btn', 'aria-pressed': 'false', title: 'Downloads (files to download)', onclick: () => handlers.onToggleDownloads?.() },
            icon('downloads'), el('span', { class: 'btn-label' }, label));
          (inHeader ? headerNav : rail).append(downloadsButton);
          continue;
        }
        if (id === 'externalPages') {
          pagesButton = el('button', { type: 'button', class: inHeader ? 'head-btn' : 'rail-btn', 'aria-pressed': 'false', title: 'External pages (other sites, inside the viewer)', onclick: () => handlers.onTogglePages?.() },
            icon('externalPages'), el('span', { class: 'btn-label' }, label));
          (inHeader ? headerNav : rail).append(pagesButton);
          continue;
        }
        if (id === 'streaming') {
          streamingButton = el('button', { type: 'button', class: inHeader ? 'head-btn' : 'rail-btn', 'aria-pressed': 'false', title: 'Streaming (cameras, drones and tracking)', onclick: () => handlers.onToggleStreaming?.() },
            icon('streaming'), el('span', { class: 'btn-label' }, label));
          (inHeader ? headerNav : rail).append(streamingButton);
          continue;
        }
        if (id === 'editing') {
          editButton = el('button', { type: 'button', class: inHeader ? 'head-btn' : 'rail-btn', 'aria-pressed': 'false', title: 'Editing (forms over the map)', onclick: () => handlers.onToggleEditing?.() },
            icon('editing'), el('span', { class: 'btn-label' }, label));
          (inHeader ? headerNav : rail).append(editButton);
          continue;
        }
        if (id === 'scene') {
          sceneButton = el('button', { type: 'button', class: inHeader ? 'head-btn' : 'rail-btn', 'aria-pressed': 'false', title: 'Scene (3D)', onclick: () => handlers.onToggleScene?.() },
            icon('scene'), el('span', { class: 'btn-label' }, label));
          (inHeader ? headerNav : rail).append(sceneButton);
          continue;
        }
        if (id === 'dashboards') {
          dashButton = el('button', { type: 'button', class: inHeader ? 'head-btn' : 'rail-btn', 'aria-pressed': 'false', title: 'Dashboards (full page)', onclick: () => (dashOverlay.hidden ? openDashboards() : closeDashboards()) },
            icon('dashboards'), el('span', { class: 'btn-label' }, label));
          (inHeader ? headerNav : rail).append(dashButton);
          continue;
        }
        const body = el('div', { class: `pane-body pane-${id}` });
        const pane = el('section', { class: 'pane', id: `pane-${id}`, 'aria-label': label, hidden: true },
          el('div', { class: 'pane-head' },
            el('h2', { class: 'pane-title' }, label),
            el('div', { class: 'pane-actions' },
              id === 'details' || (id === 'search' && !m.widgets.details) ? fieldsAsSwitch() : null,
              WIDE_PANES.has(id) ? resultsAtSwitch() : null,
              WIDE_PANES.has(id) ? widenButton() : null,
              el('button', { type: 'button', class: 'icon-btn', title: 'Close', onclick: () => (docked(id) ? closeDock() : close()) }, icon('close'), el('span', { class: 'sr-only' }, 'Close')))),
          body);
        const button = el('button', { type: 'button', class: inHeader ? 'head-btn' : 'rail-btn', 'aria-pressed': 'false', 'aria-controls': `pane-${id}`, title: label, onclick: () => toggle(id) },
          icon(id), el('span', { class: 'btn-label' }, label));
        (inHeader ? headerNav : rail).append(button);
        builders[id](body, m);
        panes.set(id, { pane, body, buttons: [button] });
        paneHost.append(pane);
      }
      const firstPane = enabled.find(([id]) => panes.has(id))?.[0];
      const first = panes.has(m.widgets.open) ? m.widgets.open : firstPane;
      if (panes.size && docked(first)) { close(); open(first); }   // the side panel stays shut until people open a widget
      else if (panes.size) open(first);
      else close();
    },

    open,
    has: name => (name === 'dashboards' ? Boolean(dashButton) : name === 'editing' ? Boolean(editButton) : name === 'scene' ? Boolean(sceneButton)
      : name === 'streaming' ? Boolean(streamingButton) : name === 'externalPages' ? Boolean(pagesButton)
      : name === 'downloads' ? Boolean(downloadsButton) : name === 'trace' ? Boolean(traceButton) : panes.has(name)),

    /** The Editing window opened or closed (it lives in viewerApp.js); the button shows which. */
    setEditingOpen(on) { editButton?.setAttribute('aria-pressed', String(on)); },

    /** The 3D scene opened or closed (it lives in viewerApp.js); the button shows which. */
    setSceneOpen(on) { sceneButton?.setAttribute('aria-pressed', String(on)); },

    /** The Streaming window opened or closed (it lives in viewerApp.js); the button shows which. */
    setStreamingOpen(on) { streamingButton?.setAttribute('aria-pressed', String(on)); },

    /** The External pages window opened or closed (it lives in viewerApp.js); the button shows which. */
    setPagesOpen(on) { pagesButton?.setAttribute('aria-pressed', String(on)); },

    /** The Downloads window opened or closed (it lives in viewerApp.js); the button shows which. */
    setDownloadsOpen(on) { downloadsButton?.setAttribute('aria-pressed', String(on)); },

    /** The Attribute trace window opened or closed (it lives in viewerApp.js); the button shows which. */
    setTraceOpen(on) { traceButton?.setAttribute('aria-pressed', String(on)); },

    /** Dashboards to show (call once the map is ready, so their queries can run). */
    setDashboards(list, accent) {
      dash.set(list, accent);
      dashReady = true;
      if (!dashOverlay.hidden) dash.draw();
    },
    container: name => panes.get(name)?.body ?? null,
    showDetails,

    /**
     * Search box results, in the same results table as the attribute search (Back to n results, Zoom to results), with
     * only the source's result columns. A single result is zoomed to and stands out on the map; a row opens in Details.
     */
    showSearchResults(groups) {
      const s = searchState;
      if (!s) return;
      s.lastGroups = groups.some(g => g.rows.length) ? groups : null;
      s.ran = true;
      s.error = null;
      renderSearch();
      syncSearchBack();
      const rows = groups.flatMap(g => g.rows);
      if (rows.length === 1 && detailsView) handlers.onSelectFeature({ graphic: rows[0].graphic }, { zoom: true, emphasis: rows[0].emphasis });
    },

    /** boxNode: the search box (widgets.mountSearchBox), or null when it has no sources. */
    setupSearch(sources, boxNode) {
      const body = panes.get('search')?.body;
      if (!body) return;
      const usable = sources.filter(s => s.fields.length);
      searchState = {
        body, sources: usable, key: usable[0]?.key ?? null, match: 'all', boxNode,
        conditions: usable[0] ? [newCondition(usable[0])] : [], lastGroups: null, ran: false, error: null, toolbar: null,
        view: createResultsView(body, resultsHandlers(() => { handlers.onClearSelection(); searchState.lastGroups = null; searchState.ran = false; renderSearch(); syncSearchBack(); }))
      };
      renderSearch();
    },

    /** The Layer information pane's layers: [{ key, title, info }] in layer order (call once the map is loaded). */
    setLayerInfo(layers) { layerInfoPane?.set(layers); },

    setBookmarks(list) {
      const body = panes.get('bookmarks')?.body;
      if (!body) return;
      fill(body, list.length
        ? el('ul', { class: 'plain-list' }, list.map(b =>
            el('li', {}, el('button', { type: 'button', class: 'list-btn', onclick: () => handlers.onBookmark(b) }, icon('bookmarks'), el('span', {}, b.name)))))
        : placeholder('No bookmarks in this map.'));
    },

    /** Sign-in panel over the map, for secured viewers. */
    /** skip: { label, onSkip } offers to carry on without signing in (e.g. leave out one secured service). */
    showSignIn(target, message, onSignedIn, skip = null) {
      const body = section.querySelector('.viewer-body');
      const close = () => section.querySelector('.signin-overlay')?.remove();
      close();
      body.append(el('div', { class: 'signin-overlay', role: 'dialog', 'aria-label': `Sign in to ${target.label}` },
        el('div', { class: 'signin-card' },
          el('h2', {}, 'Sign in'),
          signInForm({ target, message, onSignedIn: () => { close(); onSignedIn(); } }),
          skip ? el('button', { type: 'button', class: 'btn quiet signin-skip', onclick: () => { close(); skip.onSkip(); } }, skip.label) : null)));
      section.querySelector('.signin-overlay input')?.focus();
    },

    hideSignIn() { section.querySelector('.signin-overlay')?.remove(); },

    setEmpty(name, text) { panes.get(name)?.body.replaceChildren(placeholder(text)); },

    notify(message) {
      notice.textContent = message;
      notice.hidden = !message;
    }
  };
}
