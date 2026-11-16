// traceWindow.js — the Attribute trace widget's window, at the author's width (half: beside the map, with a drag
// handle; full: over the map and the panel; narrow screens always full, like Downloads; bottom: docked along the
// bottom of the map, resultsDock.js). It opens on a card for each
// trace (and, when the author allows it, the person's own traces, kept in their browser). A trace shows as a chain of
// layers; people pick the starting feature on the map (or start from a Details card), run it, watch each step's
// progress, can cancel, and get the results as a table with each step's count, time and warnings. Choosing a result
// raises it on the map and opens it in Details. Export saves the results as Excel or CSV (exportForm.js), with any of
// the last layer's other fields read by ObjectID. Pure UI: the map, the engine and storage are reached through handlers.
import { el, fill, halfWindowLeft } from './utils.js';
import { svgIcon } from './viewer.js';
import { dataTable } from './resultsView.js';
import { traceForm, traceChain } from './traceForm.js';
import { newTrace } from './manifest.js';
import { checkTrace, TRACES_MAX } from './trace.js';
import { exportControl } from './exportForm.js';
import { exportChoices, pickedColumns } from './tableExport.js';
import { stackWindow } from './windowStack.js';
import { DOCK_DEFAULT, dockGrip, dockRect } from './resultsDock.js';

const TRACE_ICON = '<circle cx="4" cy="4" r="2"/><circle cx="16" cy="10" r="2"/><circle cx="4" cy="16" r="2"/><path d="M6 4h4a2 2 0 0 1 2 2v2a2 2 0 0 0 2 2M6 16h4a2 2 0 0 0 2-2v-2a2 2 0 0 1 2-2"/>';
const HALF_MIN = 0.3, HALF_MAX = 0.7;
const NARROW_PX = 640;
const STEP_ROWS_SHOWN = 500;            // most rows an intermediate step's table shows

/**
 * @param host      the positioned element to float in (.viewer-body)
 * @param handlers  {
 *   onClose(), onPadding({ left?, right? }), onOpenChange(open)
 *   layers()                          the map's layers [{ key, title }]
 *   fields(key)                       Promise of a layer's fields [{ name, alias, type }]
 *   pickStart(key)                    Promise of the feature clicked on the map (a graphic), or null if cancelled
 *   cancelPick()
 *   startLabel(key, graphic)          Promise of a short name for the starting feature
 *   run(trace, attributes, { signal, onProgress })  Promise of the engine's report (trace.js runTrace)
 *   showResults(report)               draw the results on the map; Promise of how many were drawn
 *   selectResult(layerKey, id)        raise one result on the map, zoom to it and open it in Details
 *   zoomAll(), clear()                the results on the map
 *   format(value, field)              a value as text, as Details shows it
 *   loadOwn(), saveOwn(list)          the person's own traces (this browser only)
 *   csv()                             offer Export (Excel or CSV)
 *   exportRecords(layerKey, oidField, ids, outFields, { signal, onProgress })  Promise of those records' attributes,
 *                                     for export columns the trace didn't read
 * }
 */
export function createTraceWindow(host, handlers) {
  let width = 'half';
  let side = 'left';
  let ratio = 0.5;
  let dockRatio = DOCK_DEFAULT;  // width 'bottom': the window's share of the map's height (people drag its grip)
  let cfg = null;                 // manifest.trace
  let own = [];                   // the person's own traces
  let view = 'home';              // 'home' | 'trace' | 'edit'
  let current = null;             // the trace showing
  let draft = null;               // { trace, isNew } while editing one of the person's own
  let run = null;                 // { traceId, start, label, status, report, progress, controller, picking }
  const fieldCache = new Map();   // layer key -> { status, fields, error }

  const title = el('strong', { class: 'pages-heading' }, 'Attribute trace');
  const backBtn = el('button', { type: 'button', class: 'btn quiet trace-back', hidden: true, onclick: () => home() }, '← All traces');
  const closeBtn = el('button', { type: 'button', class: 'icon-btn pages-close', 'aria-label': 'Close Attribute trace', title: 'Close Attribute trace', onclick: () => handlers.onClose() }, '×');
  const head = el('header', { class: 'pages-head' }, backBtn, title, el('span', { class: 'pages-gap' }), closeBtn);
  const body = el('div', { class: 'trace-body' });
  const handle = el('div', {
    class: 'ew-handle pages-handle', role: 'separator', tabindex: 0, 'aria-orientation': 'vertical', 'aria-label': 'Drag to share the space between Attribute trace and the map',
    'aria-valuemin': HALF_MIN * 100, 'aria-valuemax': HALF_MAX * 100
  }, el('span', { class: 'ew-grip', 'aria-hidden': 'true' }));
  const win = el('section', { class: 'pages-window trace-window', role: 'region', 'aria-label': 'Attribute trace', hidden: true }, head, body, handle);
  host.append(win);
  stackWindow(win);                     // the window opened or clicked last is on top (windowStack.js)
  const dock = dockGrip({ host, mapRect: () => mapRect(), get: () => dockRatio, set: r => { dockRatio = r; layout(); }, label: 'Attribute trace' });
  win.prepend(dock.grip);

  win.addEventListener('keydown', e => {
    if (e.key !== 'Escape' || e.target.closest('select, input')) return;
    e.stopPropagation();
    if (run?.picking) { handlers.cancelPick(); return; }
    handlers.onClose();
  });
  window.addEventListener('resize', () => { if (!win.hidden) layout(); });

  /* ---------- Size and position (as Downloads) ---------- */
  const mapRect = () => {
    const hostR = host.getBoundingClientRect(), m = (host.querySelector('.map') ?? host).getBoundingClientRect();
    return { left: m.left - hostR.left, top: m.top - hostR.top, width: m.width, height: m.height };
  };
  const effectiveWidth = () => (width === 'bottom' ? 'bottom' : width === 'half' && mapRect().width >= NARROW_PX ? 'half' : 'full');

  function layout() {
    const w = effectiveWidth();
    win.dataset.width = w;
    win.dataset.side = side;
    handle.hidden = w !== 'half';
    dock.grip.hidden = w !== 'bottom';
    if (w === 'bottom') {                 // along the bottom of the map, as tall as people drag it
      const r = dockRect(mapRect(), dockRatio);
      Object.assign(win.style, { width: `${r.width}px`, height: `${r.height}px`, top: `${r.top}px`, left: `${r.left}px` });
      dock.sync();
      handlers.onPadding?.({ bottom: r.height });
      return;
    }
    if (w === 'full') {
      for (const k of ['left', 'top', 'width', 'height']) win.style[k] = '';
      handlers.onPadding?.({});
      return;
    }
    const m = mapRect();
    const px = Math.round(m.width * ratio);
    Object.assign(win.style, { width: `${px}px`, height: `${m.height}px`, top: `${m.top}px`, left: `${halfWindowLeft(m, px, side)}px` });
    handle.setAttribute('aria-valuenow', String(Math.round(ratio * 100)));
    handlers.onPadding?.({ [side]: px });
  }

  handle.addEventListener('pointerdown', e => {
    e.preventDefault();
    handle.setPointerCapture(e.pointerId);
    win.classList.add('is-resizing');
    const move = ev => {
      const m = mapRect(), hostR = host.getBoundingClientRect();
      const x = ev.clientX - hostR.left - m.left;
      ratio = Math.min(HALF_MAX, Math.max(HALF_MIN, (side === 'left' ? x : m.width - x) / m.width));
      layout();
    };
    const up = () => {
      handle.removeEventListener('pointermove', move); handle.removeEventListener('pointerup', up);
      win.classList.remove('is-resizing');
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
  });
  handle.addEventListener('keydown', e => {
    const step = { ArrowLeft: -0.05, ArrowRight: 0.05 }[e.key];
    if (step == null) return;
    e.preventDefault();
    ratio = Math.min(HALF_MAX, Math.max(HALF_MIN, ratio + (side === 'left' ? step : -step)));
    layout();
  });

  /* ---------- Traces, layers and fields ---------- */
  const authorTraces = () => cfg?.traces ?? [];
  const allowOwn = () => cfg?.allowUserTraces === true;
  const traceOf = id => authorTraces().find(t => t.id === id) ?? (allowOwn() ? own.find(t => t.id === id) : null) ?? null;
  const isOwn = id => allowOwn() && own.some(t => t.id === id);
  const titleOf = key => handlers.layers().find(l => l.key === key)?.title ?? '';

  function fieldsOf(key) {
    if (!key) return null;
    if (!fieldCache.has(key)) {
      const st = { status: 'loading', fields: [], error: null };
      fieldCache.set(key, st);
      handlers.fields(key)
        .then(f => Object.assign(st, { status: 'ready', fields: f }))
        .catch(e => Object.assign(st, { status: 'error', error: e.message }))
        .finally(() => { if (!win.hidden && view !== 'home' && run?.status !== 'running') paint(); });
    }
    return fieldCache.get(key);
  }

  function saveOwn(list) {
    own = list;
    handlers.saveOwn(own);
  }

  /* ---------- Home: a card per trace ---------- */
  function home() {
    stopPicking();
    view = 'home';
    current = null;
    paint();
  }

  const card = t => el('div', { class: 'pages-card trace-card' },
    el('button', { type: 'button', class: 'trace-card-open', onclick: () => choose(t.id) },
      svgIcon(TRACE_ICON),
      el('span', { class: 'pages-card-title' }, t.title || 'Untitled trace'),
      t.description ? el('span', { class: 'muted pages-card-blurb' }, t.description) : null,
      el('span', { class: 'pages-card-meta' }, `${titleOf(t.startLayer) || 'Start layer not in the map'} → ${t.steps.length} step${t.steps.length === 1 ? '' : 's'}`)),
    isOwn(t.id) ? el('span', { class: 'btn-row trace-card-acts' },
      el('button', { type: 'button', class: 'btn quiet', onclick: () => edit(t) }, 'Edit'),
      el('button', { type: 'button', class: 'btn quiet', disabled: own.length >= TRACES_MAX, onclick: () => copy(t) }, 'Duplicate'),
      el('button', { type: 'button', class: 'btn quiet danger', onclick: () => { if (confirm(`Delete your trace "${t.title || 'Untitled trace'}"?`)) { saveOwn(own.filter(x => x.id !== t.id)); paint(); } } }, 'Delete'))
      : allowOwn() ? el('span', { class: 'btn-row trace-card-acts' },
        el('button', { type: 'button', class: 'btn quiet', disabled: own.length >= TRACES_MAX, title: 'Make your own copy to change', onclick: () => copy(t) }, 'Copy to your traces')) : null);

  function paintHome() {
    const mine = allowOwn() ? own : [];
    fill(body, el('div', { class: 'pages-home' },
      authorTraces().length ? [el('p', { class: 'pages-home-lead' }, 'Choose a trace:'), el('div', { class: 'pages-cards' }, authorTraces().map(card))]
        : allowOwn() ? null : el('p', { class: 'empty' }, 'No traces are set up for this viewer.'),
      allowOwn() ? [
        el('p', { class: 'pages-home-lead trace-own-head' }, 'Your traces', el('span', { class: 'muted' }, ' (kept in this browser only)')),
        mine.length ? el('div', { class: 'pages-cards' }, mine.map(card)) : el('p', { class: 'muted' }, 'None yet. Make one, or copy one of the traces above and change it.'),
        el('div', { class: 'btn-row' }, el('button', { type: 'button', class: 'btn', disabled: own.length >= TRACES_MAX, onclick: () => edit(null) }, 'New trace'))
      ] : null));
  }

  /* ---------- The person's own traces: new, copy, edit ---------- */
  function copy(t) {
    const c = structuredClone(t);
    c.id = newTrace().id;
    c.title = `${t.title || 'Trace'} (copy)`;
    saveOwn([...own, c]);
    edit(c);
  }

  function edit(t) {
    stopPicking();
    draft = { trace: structuredClone(t ?? newTrace({ title: '' })), isNew: !t };
    view = 'edit';
    paint();
  }

  function paintEdit() {
    const t = draft.trace;
    const problems = checkTrace(t, { limits: cfg?.limits }).errors;
    fill(body, el('div', { class: 'trace-edit' },
      el('p', { class: 'hint' }, 'Your traces stay in this browser. Choose layers and fields from this map; each step finds the features whose field matches the values read before it.'),
      traceForm({ trace: t, layers: handlers.layers(), fieldsOf, limits: cfg?.limits, onEdit: fn => { fn(draft.trace); paint(); } }),
      el('div', { class: 'btn-row trace-edit-acts' },
        el('button', { type: 'button', class: 'btn', disabled: !t.title,
          title: problems.length ? 'You can save it now and finish it later; it runs once the problems listed are fixed.' : '',
          onclick: () => {
            const i = own.findIndex(x => x.id === t.id);
            saveOwn(i >= 0 ? own.map(x => (x.id === t.id ? t : x)) : [...own, t]);
            const id = t.id;
            draft = null;
            choose(id);
          } }, 'Save'),
        el('button', { type: 'button', class: 'btn quiet', onclick: () => { draft = null; home(); } }, 'Cancel'))));
  }

  /* ---------- One trace: chain, start, run, results ---------- */
  function choose(id) {
    if (!traceOf(id)) { home(); return; }
    if (current !== id) {
      stopPicking();
      if (run?.traceId !== id) { run?.controller?.abort(); run = null; handlers.clear(); }
    }
    current = id;
    view = 'trace';
    paint();
  }

  function stopPicking() {
    if (run?.picking) { run.picking = false; handlers.cancelPick(); }
  }

  async function pick() {
    const t = traceOf(current);
    run = { traceId: t.id, picking: true };
    paint();
    const graphic = await handlers.pickStart(t.startLayer);
    if (run?.traceId !== t.id || !run.picking) return;
    run.picking = false;
    if (!graphic) { paint(); return; }
    await setStart(t, graphic);
  }

  async function setStart(t, graphic) {
    run = { traceId: t.id, start: graphic, label: '…' };
    paint();
    const label = await handlers.startLabel(t.startLayer, graphic).catch(() => 'the chosen feature');
    if (run?.start === graphic) { run.label = label; paint(); }
  }

  async function execute() {
    const t = traceOf(current);
    if (!t || !run?.start) return;
    run.controller?.abort();
    const controller = new AbortController();
    Object.assign(run, { controller, status: 'running', report: null, progress: null });
    handlers.clear();
    paint();
    const mine = run;
    const report = await handlers.run(t, [run.start.attributes ?? {}], {
      signal: controller.signal,
      onProgress: p => { if (run === mine) { mine.progress = p; paintProgress(); } }
    });
    if (run !== mine) return;
    Object.assign(run, { status: report.status, report, controller: null });
    paint();
    if (report.final?.records.length) {
      run.drawn = await handlers.showResults(report).catch(() => 0);
      if (run === mine) paint();
    }
  }

  /** Just the progress line, so a run doesn't redraw the whole window for every query. */
  function paintProgress() {
    const node = body.querySelector('.trace-progress');
    const t = traceOf(current);
    const p = run?.progress;
    if (!node || !p || !t) return;
    const layer = titleOf(t.steps[p.index]?.targetLayer) || 'a layer';
    node.textContent = `Step ${p.index + 1} of ${t.steps.length}: ${layer}. ${p.batches ? `${p.batchesDone} of ${p.batches} quer${p.batches === 1 ? 'y' : 'ies'}, ` : ''}${p.count.toLocaleString('en-US')} found so far.`;
    body.querySelector('.trace-bar span')?.style.setProperty('width', `${Math.round(((p.index + (p.batches ? p.batchesDone / p.batches : 0)) / t.steps.length) * 100)}%`);
  }

  const STATUS_CLASS = { done: 'ok', empty: '', limit: 'warn', timeout: 'warn', cancelled: 'warn', invalid: 'err', error: 'err' };

  function columnsFor(t, report) {
    const last = t.steps.at(-1);
    const fields = fieldCache.get(last.targetLayer)?.fields ?? [];
    const alias = name => fields.find(f => f.name.toLowerCase() === name.toLowerCase());
    const chosen = t.finalFields?.length ? t.finalFields : [{ name: last.targetField }];
    const cols = chosen.map(f => ({ name: f.name, label: f.label || alias(f.name)?.alias || f.name }));
    // Keep the ObjectID (newest first, as every table here), unless a column already is it.
    const oid = report.final.oidField;
    return oid && !cols.some(c => c.name.toLowerCase() === oid.toLowerCase()) ? [{ name: oid, label: alias(oid)?.alias || oid }, ...cols] : cols;
  }

  const value = (rec, name) => rec?.[name] ?? rec?.[Object.keys(rec ?? {}).find(k => k.toLowerCase() === name.toLowerCase())];

  function resultsTable(t, report) {
    const fields = fieldCache.get(t.steps.at(-1).targetLayer)?.fields ?? [];
    const fieldOf = name => fields.find(f => f.name.toLowerCase() === name.toLowerCase());
    const columns = columnsFor(t, report);
    const oid = report.final.oidField;
    const rows = report.final.records.map((rec, i) => ({
      id: oid ? String(value(rec, oid)) : `r${i}`,
      cells: Object.fromEntries(columns.map(c => [c.name, { text: handlers.format(value(rec, c.name), fieldOf(c.name)), raw: value(rec, c.name) ?? null }]))
    }));
    const label = t.resultLabel || 'results';
    const exp = handlers.csv() && rows.length ? traceExport(t, report, columns, fields) : null;
    return el('div', { class: 'trace-results' },
      el('div', { class: 'btn-row trace-result-acts' },
        el('button', { type: 'button', class: 'btn quiet', disabled: !run.drawn, onclick: () => handlers.zoomAll() }, 'Zoom to all'),
        el('button', { type: 'button', class: 'btn quiet', onclick: () => { handlers.clear(); run.drawn = 0; paint(); } }, 'Clear from the map'),
        exp?.button),
      exp?.panel,
      !oid ? el('p', { class: 'muted' }, 'This layer has no ObjectID, so its results can\'t be drawn or opened from here.') : null,
      dataTable({ columns, rows, label, onSelect: oid ? r => handlers.selectResult(t.steps.at(-1).targetLayer, r.id) : null }));
  }

  /**
   * Export the results: the table's columns ticked, and (when the layer has an ObjectID to read them by) any of the
   * last layer's other fields. Rows newest first, as the table opens.
   */
  function traceExport(t, report, columns, fields) {
    const key = t.steps.at(-1).targetLayer;
    const oid = report.final.oidField;
    const fieldOf = name => fields.find(f => f.name.toLowerCase() === name.toLowerCase());
    const canRead = Boolean(oid && handlers.exportRecords);
    const choices = exportChoices(columns, canRead ? fields : []);
    const have = new Set(columns.map(c => c.name.toLowerCase()));
    return exportControl({
      title: t.title || 'trace',
      total: report.final.records.length,
      choices,
      buttonClass: 'btn quiet',
      async exportAll(picked, { signal, onProgress }) {
        const cols = pickedColumns(choices, fields, picked);
        let recs = report.final.records;
        const missing = cols.filter(c => !have.has(c.name.toLowerCase()));
        if (missing.length && canRead) {
          const ids = recs.map(r => value(r, oid));
          const read = await handlers.exportRecords(key, oid, ids, [...new Set([oid, ...cols.map(c => c.name)])], { signal, onProgress });
          const byId = new Map(read.map(r => [Number(value(r, oid)), r]));
          recs = recs.map(r => ({ ...r, ...(byId.get(Number(value(r, oid))) ?? {}) }));
        }
        if (oid) recs = [...recs].sort((a, b) => Number(value(b, oid)) - Number(value(a, oid)));
        return {
          columns: cols,
          rows: recs.map(rec => ({ cells: Object.fromEntries(cols.map(c => [c.name, { text: handlers.format(value(rec, c.name), fieldOf(c.name)), raw: value(rec, c.name) ?? null }])) }))
        };
      }
    });
  }

  /** Each step's count, time and queries, with its features one click away. */
  function stepsReport(t, report) {
    return el('div', { class: 'trace-steps-report' },
      el('p', { class: 'sub-head' }, 'Step by step'),
      report.steps.map(s => {
        const step = t.steps[s.index];
        const recs = s.records ?? [];
        const keys = [...new Set(recs.slice(0, 50).flatMap(r => Object.keys(r)))];
        const columns = keys.map(k => ({ name: k, label: k }));
        const rows = recs.slice(0, STEP_ROWS_SHOWN).map((r, i) => ({ id: `s${s.index}-${i}`, cells: Object.fromEntries(keys.map(k => [k, { text: r[k] == null ? '—' : String(r[k]), raw: r[k] ?? null }])) }));
        const facts = [`${s.count.toLocaleString('en-US')} found`, `${s.values.toLocaleString('en-US')} value${s.values === 1 ? '' : 's'} looked up`,
          s.cachedValues ? `${s.cachedValues} already known` : '', `${s.queries} quer${s.queries === 1 ? 'y' : 'ies'}`, `${(s.ms / 1000).toFixed(1)} s`].filter(Boolean).join(', ');
        return el('details', { class: `trace-step-report is-${s.status}` },
          el('summary', {}, el('strong', {}, `${s.index + 1}. ${titleOf(step?.targetLayer) || step?.targetLayer}`), ' ', el('span', { class: 'muted' }, facts)),
          rows.length ? dataTable({ columns, rows, label: `Step ${s.index + 1}` }) : el('p', { class: 'muted' }, 'Nothing found here.'),
          recs.length > STEP_ROWS_SHOWN ? el('p', { class: 'muted' }, `Showing the first ${STEP_ROWS_SHOWN}.`) : null);
      }));
  }

  function paintTrace() {
    const t = traceOf(current);
    const counts = run?.report ? new Map(run.report.steps.map(s => [s.id, s])) : null;
    const problems = checkTrace(t, { limits: cfg?.limits }).errors;
    const busy = run?.status === 'running';
    const r = run?.report;
    const startLayer = titleOf(t.startLayer);

    fill(body, el('div', { class: 'trace-view' },
      el('div', { class: 'trace-top' },
        t.description ? el('p', { class: 'trace-desc' }, t.description) : null,
        traceChain(t, titleOf, counts),
        problems.length ? el('ul', { class: 'checks trace-checks' }, problems.map(p => el('li', { class: 'e' }, p))) : null,

        el('div', { class: 'trace-start' },
          run?.picking
            ? [el('p', { class: 'status', 'aria-live': 'polite' }, `Click a feature of ${startLayer || 'the start layer'} on the map…`),
              el('button', { type: 'button', class: 'btn quiet', onclick: () => { stopPicking(); paint(); } }, 'Stop picking')]
            : [el('p', { class: 'trace-start-text' }, run?.start ? ['Starting from ', el('strong', {}, run.label)] : `Choose a feature of ${startLayer || 'the start layer'} to start from, or use the trace's button on a Details card.`),
              el('button', { type: 'button', class: 'btn quiet', disabled: busy || !startLayer, onclick: pick }, run?.start ? 'Pick another' : 'Pick on the map')]),

        el('div', { class: 'btn-row' },
          el('button', { type: 'button', class: 'btn', disabled: busy || !run?.start || problems.length > 0, onclick: execute }, r ? 'Run again' : 'Run the trace'),
          busy ? el('button', { type: 'button', class: 'btn quiet danger', onclick: () => run.controller?.abort() }, 'Cancel') : null,
          isOwn(t.id) ? el('button', { type: 'button', class: 'btn quiet', disabled: busy, onclick: () => edit(t) }, 'Edit') : null),

        busy ? el('div', { class: 'trace-running' },
          el('div', { class: 'trace-bar', role: 'progressbar', 'aria-label': 'Trace progress' }, el('span')),
          el('p', { class: 'status trace-progress', 'aria-live': 'polite' }, 'Starting…')) : null,

        r ? el('div', { class: 'trace-outcome' },
          el('p', { class: `status ${STATUS_CLASS[r.status] ?? ''}`, role: 'status' }, r.message, ` (${(r.ms / 1000).toFixed(1)} s)`),
          r.problems?.length > 1 ? el('ul', { class: 'checks trace-checks' }, r.problems.slice(1).map(p => el('li', { class: 'e' }, p))) : null,
          r.warnings.length ? el('ul', { class: 'checks trace-checks' }, r.warnings.map(w => el('li', { class: 'w' }, w))) : null,
          r.final && !t.confirmsImpact ? el('p', { class: 'hint trace-caveat' },
            'These features are linked to the starting feature by the trace\'s keys. That alone doesn\'t mean they are affected: check the operational rules (valves, switches, other entrances) before acting on it.') : null) : null),

      r?.final ? resultsTable(t, r) : null,
      r?.steps.length ? stepsReport(t, r) : null));
    if (busy) paintProgress();
    if (r?.final) fieldsOf(t.steps.at(-1).targetLayer);   // the results table's aliases and value formats (draws again when read)
  }

  function paint() {
    const t = view === 'trace' ? traceOf(current) : null;
    backBtn.hidden = view === 'home';
    title.textContent = view === 'edit' ? (draft.isNew ? 'New trace' : 'Edit your trace') : t ? t.title || 'Untitled trace' : 'Attribute trace';
    if (view === 'edit') paintEdit();
    else if (t) paintTrace();
    else paintHome();
  }

  function open() {
    if (!win.hidden) return;
    win.hidden = false;
    host.classList.add('trace-open');
    layout();
    handlers.onOpenChange?.(true);
    // One trace and no own ones: straight in.
    if (view === 'home' && authorTraces().length === 1 && !allowOwn()) choose(authorTraces()[0].id);
    else paint();
    closeBtn.focus({ preventScroll: true });
  }

  function close() {
    if (win.hidden) return;
    stopPicking();
    run?.controller?.abort();
    win.hidden = true;
    host.classList.remove('trace-open');
    handlers.onPadding?.({});
    handlers.clear();
    if (run) { run.drawn = 0; }
    handlers.onOpenChange?.(false);
  }

  return {
    /** The manifest's trace settings (call on every manifest; closes the window and forgets the last run). */
    set(config) {
      close();
      cfg = config;
      width = cfg?.width === 'full' || cfg?.width === 'bottom' ? cfg.width : 'half';
      dockRatio = DOCK_DEFAULT;
      side = cfg?.side === 'right' ? 'right' : 'left';
      ratio = 0.5;
      own = allowOwn() ? handlers.loadOwn() : [];
      view = 'home';
      current = null;
      draft = null;
      run = null;
      fieldCache.clear();
      fill(body);
    },
    open,
    close,
    isOpen: () => !win.hidden,
    isPicking: () => Boolean(run?.picking),
    /** Traces that start from this layer (for the buttons on a Details card): [{ id, title }]. */
    tracesFrom: key => (cfg ? [...authorTraces(), ...(allowOwn() ? own : [])].filter(t => t.startLayer === key && t.steps.length).map(t => ({ id: t.id, title: t.title || 'Untitled trace' })) : []),
    /** Run a trace from a feature (a Details card's button): opens the window on it and runs at once. */
    async runFrom(id, graphic) {
      const t = traceOf(id);
      if (!t) return;
      open();
      choose(id);
      await setStart(t, graphic);
      if (!checkTrace(t, { limits: cfg?.limits }).errors.length) execute();
    }
  };
}
