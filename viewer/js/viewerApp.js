// viewerApp.js — the GIS Viewer runtime: panel UI + map + widgets + Details + search + tools.
// Used in two places with exactly the same code:
//   - the draft preview inside the Orchestrator (main.js)
//   - the published viewer package (viewer-main.js)
import { CONFIG } from './config.js';
import * as api from './api.js';
import * as map from './map.js';
import * as widgets from './widgets.js';
import * as auth from './auth.js';
import { loadSections, buildActions } from './sections.js';
import { createViewer } from './viewer.js';
import { createSpatialWindow } from './spatialWindow.js';
import { createEditWindow } from './editWindow.js';
import { createSceneWindow } from './sceneWindow.js';
import * as sceneView from './sceneView.js';
import { createStreamWindow } from './streamWindow.js';
import { createPagesWindow } from './pagesWindow.js';
import { createDownloadsWindow } from './downloadsWindow.js';
import { loadDownloads } from './downloadsLoad.js';
import { createTraceWindow } from './traceWindow.js';
import { runTrace, TRACES_MAX } from './trace.js';
import { idWheres, exportChoices, pickedColumns } from './tableExport.js';
import { STREAMING_SECTIONS, streamAccess, droneDemoStreams } from './streams.js';
import * as trackingLayers from './trackingLayers.js';
import * as legendLabels from './legendLabelsLive.js';
import * as layerStyles from './layerStylesLive.js';
import { formFields, layerCapabilities, drawShapeFor } from './editing.js';
import { fieldKind, portalItemQuery } from './query.js';
import { formatValue } from './popup.js';
import { formatDateTime } from './utils.js';
import { sdkSourceSettings, primaryIndex, boxColumns, RESULT_NAME, DEFAULT_ALL_PLACEHOLDER } from './searchBox.js';
import { hasGroupOnlyServices, hiddenServiceIds, isServiceLayerKey } from './restServices.js';
import { serviceFacts, hasInfo } from './layerInfo.js';
import { createStartupScreen } from './startupScreen.js';
import { showDisclaimer } from './disclaimerDialog.js';
import { showsDisclaimer, disclaimerHash, acceptanceKey, acceptanceStore, acceptanceRecord, isAccepted } from './disclaimer.js';

/** A feature's attribute by field name, whatever its case. */
const attrOf = (attrs, name) => (name in attrs ? attrs[name] : attrs[Object.keys(attrs).find(k => k.toLowerCase() === name.toLowerCase())]);

/**
 * @param els        { section, brand, panel, mapEl }
 * @param options    { shareLink(viewState) -> url, preview: true in the Orchestrator's draft preview,
 *                    dashboardArrange: the Draft preview's Arrange for dashboards (dashboardArrange.js; never in a published viewer) }
 */
export function createViewerApp(els, options = {}) {
  let manifest = null;        // what should be showing
  let applied = null;         // what the map currently shows
  let started = false;
  let usedStartView = false;
  const editInfo = new Map();      // editing layer key -> Promise of map.editLayerInfo (for the current manifest)
  let stopWatchingView = null;
  let skippedServices = { manifest: null, ids: new Set() };   // secured extra services people chose to leave out
  let drawingForEdit = false;
  let sceneSkipped = new Set();    // scene layers on servers people chose not to sign in to (this manifest)
  let mapLoad = Promise.resolve(); // settles when the web map of the current manifest has loaded (or failed)
  const startup = createStartupScreen(els.section);
  let disclaimerShown = null;      // { hash, dialog } of the disclaimer on screen (or accepted in this preview)

  const viewer = createViewer({ section: els.section, brand: els.brand, panel: els.panel }, {
    onBookmark: b => map.goToBookmark(b),
    onDockPadding: px => map.setDockPadding(px),   // Details / Search docked at the bottom of the map
    onRunSearch: runSearch,
    // A layer's row is described like a map click; a geocoder's row carries its own (it has no layer).
    describeSearchRow: row => (row.target ? map.describe(row.target, row.graphic, row.fields) : Promise.resolve(row.result)),
    onZoomToResults: groups => map.zoomToGraphics(groups.flatMap(g => g.rows.map(r => r.graphic))),
    // A search result stands out as its search says (emphasis); anything else (map clicks) gets the thin highlight.
    onSelectFeature: (r, { zoom, emphasis }) => {
      if (emphasis) { map.selectSearchResult(r.graphic, emphasis, { zoom }); return; }
      map.clearSearchResult();
      map.highlight(r.graphic, { emphasis: r.emphasis ?? null, zoom });    // Select features' results carry its emphasis
    },
    onClearSelection: () => { map.clearHighlight(); map.clearSearchResult(); },
    loadSections,
    buildActions,
    onSignedIn: () => map.registerCredentials(auth.credentials()),
    onToolChange(toolId, container, cfg) {
      if (toolId && widgets.hasWidget(toolId)) widgets.startTool(toolId, container, cfg, { title: applied?.title, portalUrl: applied?.webmap.portalUrl, csv: () => applied?.widgets.tools.includes('export-results') ?? false });
      else widgets.stopTool();
      if (toolId !== 'select') map.cancelShape();
      map.setIdentifyEnabled(!(toolId && widgets.blocksIdentify(toolId)));
      map.setToolCursor(toolId);
    },
    async onSelectShape(shape, layerKeys) {
      const geometry = await map.drawShape(shape);
      if (!geometry) return null;
      const { results, report } = await map.selectFeatures(geometry, layerKeys);
      const emphasis = applied?.widgets.toolConfig?.select?.emphasis ?? null;      // how the one people pick stands out
      for (const r of results) r.emphasis = emphasis;
      if (viewer.has('details')) {
        viewer.open('details');
        viewer.showDetails(results, { report, emptyText: 'No features inside that shape.' });
      }
      return results.length;
    },
    onGoToXY: (lat, lon, zoom) => map.goToXY(lat, lon, zoom),
    async onScreenshot(format, area) {
      let extent = null;
      if (area) {
        const shape = await map.drawShape('rectangle');
        map.cancelShape();                                   // the dashed outline must not be in the picture
        if (!shape) return null;
        extent = shape.extent;
      }
      return map.screenshot(format, extent);
    },
    async onRunSpatial(r, section) {
      const subtitle = `For ${r.title}${r.layerTitle && r.layerTitle !== r.title ? ` (${r.layerTitle})` : ''}`;
      const open = { size: section.windowSize ?? 'default', side: section.windowSide ?? 'left' };
      spatialEmphasis = section.emphasis;
      spatialWindow.loading(section.title, subtitle, open);
      syncWindowCursor();
      try { spatialWindow.show(section.title, subtitle, await map.runSpatial(r.graphic, section), open); }
      catch (e) { spatialWindow.error(section.title, subtitle, `The search failed: ${e.message}`, open); }
    },
    tracesFor: r => traceWindow.tracesFrom(r.key),
    async onRunTrace(r, id) {
      openTrace();
      try { traceWindow.runFrom(id, await map.traceStartFrom(r.key, r.graphic)); }
      catch (e) { viewer.notify(`The trace couldn't start: ${e.message}`); }
    },
    onToggleTrace() {
      if (traceWindow.isOpen()) { traceWindow.close(); return; }
      if (!applied || !map.isReady()) { viewer.notify('The map is still loading. Try Attribute trace again in a moment.'); return; }
      openTrace();
    },
    onDashboardStat: w => (w.type === 'records' ? map.dashboardRecords(w) : map.statistics(w)),
    dashboardArrange: options.dashboardArrange ?? null,
    onToggleEditing() {
      if (!applied || !map.isReady()) { viewer.notify('The map is still loading. Try Editing again in a moment.'); return; }
      sceneWindow.close();
      streamingWindow.close();
      pagesWindow.close();
      downloadsWindow.close();
      traceWindow.close();
      editWindow.toggle();
    },
    onToggleStreaming() {
      if (streamingWindow.isOpen()) { streamingWindow.close(); return; }
      if (!applied || !map.isReady()) { viewer.notify('The map is still loading. Try Streaming again in a moment.'); return; }
      openStreaming();
    },
    onToggleScene() {
      if (sceneWindow.isOpen()) { closeScene(); return; }
      if (!applied || !map.isReady()) { viewer.notify('The map is still loading. Try the scene again in a moment.'); return; }
      openScene();
    },
    // Other sites' pages don't need the map, so they open at once.
    onTogglePages() {
      if (pagesWindow.isOpen()) { pagesWindow.close(); return; }
      editWindow.close();
      closeScene();
      streamingWindow.close();
      spatialWindow.close();
      downloadsWindow.close();
      traceWindow.close();
      pagesWindow.open();
    },
    // Download lists don't need the map either.
    onToggleDownloads() {
      if (downloadsWindow.isOpen()) { downloadsWindow.close(); return; }
      editWindow.close();
      closeScene();
      streamingWindow.close();
      spatialWindow.close();
      pagesWindow.close();
      traceWindow.close();
      downloadsWindow.open();
    },
    layerTitle: key => map.getTarget(key)?.title ?? '',
    async aboutService(key) {
      const url = map.layerUrl(key);
      if (!url) return { facts: [] };
      const [service, count] = await Promise.all([api.getServiceInfo(url), api.countFeatures(url).catch(() => null)]);
      // showAddress false keeps the server this viewer reads from out of the panel (js/layerInfo.js).
      return { facts: serviceFacts(service, count, url, n => n.toLocaleString(CONFIG.numberLocale), { address: manifest?.layerInfo?.showAddress !== false }) };
    },
    addData: addDataHandlers(),
    getShareLink: () => (options.shareLink ? options.shareLink(map.getViewState()) : location.href)
  });

  // Spatial relationship results float over the map; a row zooms to its feature and makes it stand out as the
  // section's emphasis says, and Details then shows that feature (with its related records) as if it had been clicked.
  let spatialPick = 0;
  let spatialEmphasis = null;             // the open section's emphasis settings
  async function selectSpatialRow(row) {
    map.selectSpatialResult(row.graphic, spatialEmphasis);
    if (!applied?.widgets.details || !viewer.has('details')) return;
    const pick = ++spatialPick;
    viewer.open('details');
    viewer.showDetails('loading');
    try {
      const { results, report } = await map.describeSpatialRow(row);
      if (pick === spatialPick) viewer.showDetails(results, { report, emptyText: 'This feature couldn\'t be read.' });
    } catch (e) {
      if (pick !== spatialPick) return;
      viewer.showDetails([]);
      viewer.notify(`Details couldn't load: ${e.message}`);
    }
  }
  const spatialWindow = createSpatialWindow(els.section.querySelector('.viewer-body'), {
    onSelectRow: selectSpatialRow,
    onClose: () => { map.clearSpatial(); syncWindowCursor(); },
    onPadding: p => map.setViewPadding(p),
    csv: () => applied?.widgets.tools.includes('export-results') ?? false
  });

  /* ---------------- Editing: records in view, forms, saves ---------------- */
  const layerInfo = key => {
    if (!editInfo.has(key)) editInfo.set(key, map.editLayerInfo(key).catch(e => { editInfo.delete(key); throw e; }));
    return editInfo.get(key);
  };

  /** Turns a layer's features into the editing window's records: a title, a few values, table cells. */
  function recordMaker(l, info) {
    const byName = new Map(info.fields.map(f => [f.name.toLowerCase(), f]));
    const field = name => byName.get(name.toLowerCase());
    const shown = (l.listFields?.length ? l.listFields : formFields(l.fields, info).slice(0, 2).map(f => f.name)).filter(field);
    const columns = [...new Map([info.objectIdField, l.titleField, ...shown].filter(n => n && field(n))
      .map(n => [n.toLowerCase(), { name: field(n).name, label: field(n).alias || n }])).values()];
    const make = g => {
      const a = g.attributes ?? {};
      const val = name => a[name] ?? a[Object.keys(a).find(k => k.toLowerCase() === name.toLowerCase())];
      const text = name => formatValue(val(name), field(name));
      const id = val(info.objectIdField);
      const titleValue = l.titleField ? val(l.titleField) : null;
      return {
        id, graphic: g, attributes: a,
        title: titleValue != null && titleValue !== '' ? text(l.titleField) : `Record ${id}`,
        items: shown.map(n => ({ label: field(n).alias || n, text: text(n) })),
        cells: Object.fromEntries(columns.map(c => [c.name, { text: text(c.name), raw: val(c.name) ?? null }]))
      };
    };
    return { make, columns };
  }

  async function loadEditRecords(l) {
    const info = await layerInfo(l.layerKey);
    const caps = layerCapabilities(info);
    const on = info.editingEnabled;
    const { make, columns } = recordMaker(l, info);
    const { features, total, truncated } = await map.queryEditRecords(l.layerKey, applied.editing.maxRecords);
    return {
      title: l.title || info.title, rows: features.map(make), total, truncated, columns,
      fields: formFields(l.fields, info), groups: l.groups ?? [],
      can: { add: on && caps.create && Boolean(drawShapeFor(info.geometryType)), update: on && caps.update, remove: on && caps.delete }
    };
  }

  const editWindow = createEditWindow(els.section.querySelector('.viewer-body'), {
    preview: options.preview === true,
    load: loadEditRecords,
    format: (ff, value) => formatValue(value, ff.field),
    onSelect: row => map.highlight(row.graphic, { emphasis: applied?.editing?.emphasis }),
    onZoom: row => map.highlight(row.graphic, { emphasis: applied?.editing?.emphasis, zoom: true }),
    async draw(l) {
      const shape = drawShapeFor((await layerInfo(l.layerKey)).geometryType);
      if (!shape) throw new Error('This layer has no shapes to draw.');
      map.clearHighlight();
      drawingForEdit = true;               // the clicks that draw aren't record picks or Details
      try { return await map.drawShape(shape); }
      finally { setTimeout(() => { drawingForEdit = false; }, 0); }
    },
    cancelDraw: () => map.cancelShape(),
    async save(l, row, changes) {
      const { objectIdField } = await layerInfo(l.layerKey);
      await map.saveEdit(l.layerKey, { update: { ...changes, [objectIdField]: row.id } });
    },
    async add(l, geometry, attributes) {
      await map.saveEdit(l.layerKey, { add: { geometry, attributes } });
      map.cancelShape();
    },
    async remove(l, row) {
      await map.saveEdit(l.layerKey, { remove: row.id });
      map.clearHighlight();
    },
    onPadding: p => map.setViewPadding(p),
    onOpenChange(open) {
      viewer.setEditingOpen(open);
      stopWatchingView?.();
      stopWatchingView = open ? map.onViewChange(() => editWindow.viewChanged()) : null;
      if (!open) { map.clearHighlight(); map.cancelShape(); }
      syncWindowCursor();
    }
  });

  /* ---------------- Scene: a separate 3D view of the layers chosen for it ---------------- */
  const sceneWindow = createSceneWindow(els.section.querySelector('.viewer-body'), {
    onBack: () => closeScene(),
    onPadding: p => map.setViewPadding(p),
    onSun(open, node) {
      if (!open) { sceneView.stopSun(); return; }
      sceneView.startSun(node).catch(e => sceneWindow.say(`Sun and shadows didn't start: ${e.message}`, 'err'));
    },
    onOpenChange: open => viewer.setSceneOpen(open)
  });

  async function openScene() {
    const m = applied;
    editWindow.close();
    streamingWindow.close();
    pagesWindow.close();
    downloadsWindow.close();
    traceWindow.close();
    spatialWindow.close();
    sceneWindow.open();
    sceneWindow.say('Loading the scene…', 'busy');
    await mapLoad;                     // layer URLs are read from the web map, so let it finish loading first
    if (applied !== m || !sceneWindow.isOpen()) return;
    const layers = m.scene.layers.filter(l => !sceneSkipped.has(l.id)).map(l => ({
      ...l, url: map.layerUrl(l.layerKey), title: l.title || map.getTarget(l.layerKey)?.title || ''
    }));
    // A secured layer asks for the app's sign-in first, so the SDK never opens a sign-in dialog of its own.
    const secured = await needingSignIn(layers.filter(l => l.url).map(l => ({ id: l.id, url: l.url, title: l.title || l.url.split('/rest/services/')[1] || l.url })));
    if (applied !== m || !sceneWindow.isOpen()) return;
    if (secured) {
      const one = secured.titles.length === 1;
      sceneWindow.close();
      viewer.showSignIn(secured.target, `${one ? `"${secured.titles[0]}" is` : `${secured.titles.length} scene layers are`} secured. Sign in to ${secured.target.label} to show ${one ? 'it' : 'them'} in the scene.`,
        () => { map.registerCredentials(auth.credentials()); openScene(); },
        { label: `Open the scene without ${one ? 'it' : 'them'}`, onSkip: () => { secured.ids.forEach(id => sceneSkipped.add(id)); openScene(); } });
      return;
    }
    const none = 'No layers are set up for the scene yet.';
    if (!layers.length) sceneWindow.say(none);
    try {
      const { problems } = await sceneView.show(sceneWindow.viewNode, layers, { accent: m.branding.accent, sync: sceneWindow.width() === 'half' });
      if (applied !== m || !sceneWindow.isOpen()) return;
      const n = problems.length;
      sceneWindow.say(n ? `${n === 1 ? 'A layer' : `${n} layers`} couldn't be drawn: ${problems.join('; ')}.` : layers.length ? '' : none);
    } catch (e) {
      if (applied === m) sceneWindow.say(e.message, 'err');
    }
  }

  /** Back to 2D. At full width the 2D map moves to where the scene was looking; at half width it's there already. */
  function closeScene() {
    if (!sceneWindow.isOpen()) return;
    sceneView.stopSync();
    if (sceneWindow.width() === 'full') sceneView.follow2D();
    sceneWindow.close();
  }

  /* ---------------- Streaming: Cameras, Drones and Tracking, each gated by a portal group ---------------- */
  const streamingWindow = createStreamWindow(els.section.querySelector('.viewer-body'), { embedHosts: CONFIG.streamEmbedHosts, tracking: trackingLayers }, {
    onClose: () => streamingWindow.close(),
    onPadding: p => map.setViewPadding(p),
    onSection: id => showStreamingSection(id),
    onSelectStream: (id, st) => map.showStreamMarkers(id, applied ? listedStreams(id, applied) : [], st.id),
    onZoom: st => map.goToLonLat(st.location),
    onLeaveVideo: () => map.clearStreamMarkers(),
    onOpenChange(open) {
      viewer.setStreamingOpen(open);
      if (!open) map.clearStreamMarkers();
    }
  });

  /* ---------------- External pages: other sites' pages in a window over the map ---------------- */
  const pagesWindow = createPagesWindow(els.section.querySelector('.viewer-body'), {
    onClose: () => pagesWindow.close(),
    onPadding: p => map.setViewPadding(p),
    onOpenChange: open => viewer.setPagesOpen(open),
    // A GIS viewer page opens where the map is looking, so wait for the web map's first load.
    position: async () => { await mapLoad; return map.getMapPosition(); }
  });
  // Set from show() as well as sync(), so the pages work while the map is still loading (and stay open when it's done).
  let pagesOf = null;
  function setPages(m) {
    if (pagesOf === m) return;
    pagesOf = m;
    pagesWindow.set(m.widgets.externalPages ? m.externalPages : null);
  }

  /* ---------------- Downloads: lists of files, each a table in a window over the map ---------------- */
  const downloadsWindow = createDownloadsWindow(els.section.querySelector('.viewer-body'), {
    onClose: () => downloadsWindow.close(),
    onPadding: p => map.setViewPadding(p),
    onOpenChange: open => viewer.setDownloadsOpen(open),
    load: source => loadDownloads(source),
    isAuthError: e => e instanceof auth.AuthRequiredError,
    signIn: (e, retry) => {
      downloadsWindow.close();
      viewer.showSignIn(e.target, e.message, () => { map.registerCredentials(auth.credentials()); downloadsWindow.open(); retry(); },
        { label: 'Not now', onSkip: () => downloadsWindow.open() });
    },
    locale: CONFIG.numberLocale
  });
  // Like External pages: set from show() too, so the lists work while the map is still loading.
  let downloadsOf = null;
  function setDownloads(m) {
    if (downloadsOf === m) return;
    downloadsOf = m;
    downloadsWindow.set(m.widgets.downloads ? m.downloads : null);
  }

  /* ---------------- Attribute trace: chains of field relationships from a starting feature ---------------- */
  let tracePick = null;            // { key, resolve } while the trace window waits for a feature clicked on the map
  /** The map cursor for the window over the map that takes clicks (cursors.js): picking a trace start, or choosing a feature. */
  function syncWindowCursor() {
    if (traceWindow.isOpen()) map.setWindowCursor('trace', tracePick ? 'pick' : 'select');
    else if (editWindow.isOpen()) map.setWindowCursor('editing', 'select');
    else if (spatialWindow.isOpen()) map.setWindowCursor('spatial', 'select');
    else map.setWindowCursor(null);
  }
  const ownTracesKey = () => `gis-orchestrator.traces.${applied?.id ?? ''}`;

  /** Results open in Details as if clicked; the chosen one is raised on the map (map.selectTraceResult). */
  let tracePickRow = 0;
  async function selectTraceRow(key, id) {
    const g = map.selectTraceResult(id, { emphasis: applied?.trace?.emphasis });
    if (!applied?.widgets.details || !viewer.has('details')) return;
    const pick = ++tracePickRow;
    viewer.open('details');
    viewer.showDetails('loading');
    try {
      const oid = (await map.getTarget(key)?.fields() ?? []).find(f => /oid/i.test(f.type))?.name;
      const { results, report } = await map.describeSpatialRow({ key, graphic: { geometry: g?.geometry ?? null, attributes: oid ? { [oid]: Number(id) } : {} } });
      if (pick === tracePickRow) viewer.showDetails(results, { report, emptyText: 'This feature couldn\'t be read.' });
    } catch (e) {
      if (pick !== tracePickRow) return;
      viewer.showDetails([]);
      viewer.notify(`Details couldn't load: ${e.message}`);
    }
  }

  const traceWindow = createTraceWindow(els.section.querySelector('.viewer-body'), {
    onClose: () => traceWindow.close(),
    onPadding: p => map.setViewPadding(p),
    onOpenChange(open) {
      viewer.setTraceOpen(open);
      if (!open) map.clearHighlight();
      syncWindowCursor();
    },
    layers: () => map.listLayers(),
    fields: key => map.traceAdapter().fields(key),
    pickStart: key => new Promise(resolve => {
      tracePick?.resolve(null);
      tracePick = { key, resolve };
      syncWindowCursor();
    }),
    cancelPick() { tracePick?.resolve(null); tracePick = null; syncWindowCursor(); },
    async startLabel(key, graphic) {
      map.highlight(graphic);
      const target = map.getTarget(key);
      const r = await map.describe(target, graphic, await target.fields().catch(() => []));
      return `${r.title}${r.layerTitle && r.layerTitle !== r.title ? ` (${r.layerTitle})` : ''}`;
    },
    run: (trace, start, opts) => runTrace(trace, start, map.traceAdapter(), { ...opts, limits: applied?.trace?.limits }),
    showResults: r => map.showTraceResults(r.final.layerKey, r.final.oidField,
      r.final.oidField ? r.final.records.map(rec => rec[r.final.oidField] ?? rec[Object.keys(rec).find(k => k.toLowerCase() === r.final.oidField.toLowerCase())]) : []),
    selectResult: selectTraceRow,
    zoomAll: () => map.zoomToTrace(),
    clear: () => map.clearTrace(),
    format: (value, field) => formatValue(value, field),
    // The person's own traces stay in this browser, per viewer; whatever is stored is checked again before it runs.
    loadOwn() {
      try {
        const list = JSON.parse(localStorage.getItem(ownTracesKey()) || '[]');
        return Array.isArray(list) ? list.filter(t => t && typeof t === 'object' && typeof t.id === 'string' && Array.isArray(t.steps)).slice(0, TRACES_MAX) : [];
      } catch { return []; }
    },
    saveOwn(list) {
      try { localStorage.setItem(ownTracesKey(), JSON.stringify(list)); }
      catch { viewer.notify('Your traces couldn\'t be saved in this browser (storage is blocked or full). They last until the page is closed.'); }
    },
    // Export columns the trace didn't read: the same records again by ObjectID, a few hundred ids at a time.
    async exportRecords(key, oidField, ids, outFields, { signal, onProgress } = {}) {
      const adapter = map.traceAdapter();
      const wheres = idWheres(oidField, ids);
      const out = [];
      for (const where of wheres) {
        for (let offset = 0; ; ) {
          const { records, more } = await adapter.query(key, { where, outFields, offset, num: 1000, signal });
          out.push(...records);
          offset += records.length;
          if (!more || !records.length) break;
        }
        onProgress?.(Math.min(out.length, ids.length), ids.length);
      }
      return out;
    },
    csv: () => applied?.widgets.tools.includes('export-results') ?? false
  });

  /** Open the Attribute trace window, closing the other windows over the map. */
  function openTrace() {
    editWindow.close();
    closeScene();
    streamingWindow.close();
    pagesWindow.close();
    downloadsWindow.close();
    spatialWindow.close();
    traceWindow.open();
  }

  /** A map click while the trace window waits for its starting feature. */
  async function pickTraceStart(point) {
    const p = tracePick;
    try {
      const g = await map.traceStartAt(p.key, point);
      if (tracePick !== p) return;
      if (!g) { viewer.notify(`No ${map.getTarget(p.key)?.title ?? 'feature of the start layer'} there. Click one of its features.`); return; }
      viewer.notify('');
      tracePick = null;
      syncWindowCursor();
      p.resolve(g);
    } catch (e) {
      if (tracePick !== p) return;
      tracePick = null;
      syncWindowCursor();
      viewer.notify(`Couldn't read the feature there: ${e.message}`);
      p.resolve(null);
    }
  }

  /**
   * The streams a video section lists from the manifest: the cameras set up in settings, or for drones only the demo
   * streams when switched on (live drone addresses are pasted in the viewer and kept by the window, never stored).
   */
  const listedStreams = (id, m) => (id === 'drones' ? (m.streaming.drones.demo ? droneDemoStreams() : []) : m.streaming.cameras.streams);

  /**
   * Who is signed in to the portal, and are they in the group? Asked every time a section is shown (never cached),
   * so a sign-out or a removal from the group counts at once. Returns { reason, user, group } or { reason: 'error' }.
   */
  async function checkStreamAccess(portalUrl, groupId) {
    try {
      // Signed out, the portal answers "400: Not logged in." (COM_0019) rather than an empty user.
      const self = await api.getSelf(portalUrl).catch(e => { if (e instanceof auth.AuthRequiredError || /COM_0019|not logged in/i.test(e.message)) return null; throw e; });
      const { reason } = streamAccess(self, groupId);
      const group = (self?.groups ?? []).find(g => String(g.id).toLowerCase() === groupId.toLowerCase())?.title
        ?? await api.getGroup(portalUrl, groupId).then(g => g.title).catch(() => null);
      return { reason, user: self?.username ?? null, group };
    } catch (e) { return { reason: 'error', error: e.message }; }
  }

  /** Open the Streaming window (on a section, or where people left it), closing the other windows over the map. */
  function openStreaming(section = null) {
    editWindow.close();
    closeScene();
    pagesWindow.close();
    downloadsWindow.close();
    traceWindow.close();
    spatialWindow.close();
    streamingWindow.open(section);
  }

  /** A section was chosen in the window: check its group, then fill it (or say why not). */
  async function showStreamingSection(id) {
    const m = applied;
    const cfg = m.streaming[id];
    const words = STREAMING_SECTIONS[id];
    const win = streamingWindow;
    const still = () => applied === m && win.isOpen() && win.section() === id;
    const verb = id === 'tracking' ? 'see the feeds' : 'watch';
    map.clearStreamMarkers();
    win.say('');
    if (cfg.groupId) {
      win.say(`Checking that you may ${verb}…`, 'busy');
      await mapLoad;                   // the map's first load clears sign-in panels when it finishes, so let it finish first
      if (!still()) return;
      const access = await checkStreamAccess(m.webmap.portalUrl, cfg.groupId);
      if (!still()) return;
      win.say('');
      const group = access.group ? `the "${access.group}" group` : 'a portal group';
      if (access.reason === 'signed-out') {
        win.close();
        const portal = auth.portalTarget(m.webmap.portalUrl);
        viewer.showSignIn(portal, `${words.title} ${id === 'tracking' ? 'is' : 'are'} for members of ${group}. Sign in to ${portal.label} to ${verb}.`,
          () => { map.registerCredentials(auth.credentials()); openStreaming(id); },
          { label: 'Not now', onSkip: () => {} });
        return;
      }
      if (access.reason === 'not-member') {
        win.showGate(id, `You're signed in as ${access.user}, who isn't a member of ${group}, so you can't ${id === 'tracking' ? 'see the tracking feeds' : `watch ${words.items}`}. Ask your GIS administrator to add you to the group.`);
        return;
      }
      if (access.reason === 'error') { win.showGate(id, `Couldn't check whether you may ${verb}: ${access.error}`); return; }
    }
    if (id === 'tracking') { win.showTracking(); return; }
    const listed = listedStreams(id, m);
    win.showStreams(id, listed);
    if (!listed.length) map.clearStreamMarkers();
  }

  /** A map click while Editing is open picks the active layer's record there. */
  async function pickForEditing(point) {
    const l = editWindow.activeLayer();
    if (!l) return;
    try {
      const g = await map.editRecordAt(l.layerKey, point);
      const info = await layerInfo(l.layerKey);
      if (!g) { editWindow.say(`No ${l.title || info.title} record there. Click one of its features, or choose from the list.`); return; }
      editWindow.say('');
      editWindow.openRow(recordMaker(l, info).make(g));
    } catch (e) { editWindow.say(`Couldn't read the record there: ${e.message}`); }
  }

  async function onMapClick(point) {
    if (drawingForEdit) return;
    if (tracePick && traceWindow.isOpen()) { pickTraceStart(point); return; }
    // A tracked object (Streaming, Tracking) shows its values in the Tracking section.
    const tracked = trackingLayers.isActive() ? await trackingLayers.objectAt(point) : null;
    if (tracked) {
      trackingLayers.select(tracked.feedId, tracked.id);
      if (streamingWindow.section() !== 'tracking') openStreaming('tracking');
      return;
    }
    // With Cameras or Drones showing, a click on one of their markers plays that stream.
    const markerId = streamingWindow.isOpen() ? map.streamMarkerAt(point) : null;
    if (markerId) { streamingWindow.selectStream(markerId); return; }
    if (editWindow.isOpen()) { pickForEditing(point); return; }
    if (!applied?.widgets.details) return;
    viewer.open('details');
    viewer.showDetails('loading');
    try {
      const { results, report } = await map.identify(point);
      viewer.showDetails(results, { report, emptyText: 'Nothing that can be identified at this spot.' });
      if (!results.length) map.clearHighlight();
    } catch (e) {
      viewer.showDetails([]);
      viewer.notify(`Details couldn't load: ${e.message}`);
    }
  }

  /**
   * The search box's sources, in the manifest's order: [{ source, settings, target? }]. Layers that aren't in the map
   * (or are on services left out) drop out quietly.
   */
  async function buildBoxSources(m, left) {
    const out = [];
    for (const s of m.search.boxSources ?? []) {
      if (s.type === 'locator') { out.push({ source: s, settings: sdkSourceSettings(s) }); continue; }
      const target = left(s.layerKey) ? null : map.getTarget(s.layerKey);
      const layer = target ? await target.searchLayer().catch(() => null) : null;
      if (layer) out.push({ source: s, target, settings: sdkSourceSettings(s, { layer, layerTitle: target.title }) });
    }
    return out;
  }

  /**
   * A search box search finished: its results, one table per source with that source's columns, in Search's results
   * (as an attribute search's are). A layer's row opens in Details like a map click; a geocoder's row shows the
   * columns chosen for it (or every value it returned). Each row stands out as its source's emphasis says.
   */
  let boxRun = 0;
  async function onBoxResults(found, box) {
    const run = ++boxRun;
    const groups = [];
    for (const { index, results } of found) {
      const b = box[index];
      if (!b || !results.length) continue;
      const layerFields = b.target ? await b.target.fields().catch(() => []) : [];
      const meta = new Map(layerFields.map(f => [f.name, f]));
      const columns = boxColumns(b.source, meta);
      const rows = results.map((res, j) => {
        const attrs = res.feature?.attributes ?? {};
        const cells = Object.fromEntries(columns.map(c => {
          const v = c.name === RESULT_NAME ? res.name : attrOf(attrs, c.name);
          return [c.name, { text: c.name === RESULT_NAME ? res.name ?? '' : formatValue(v, meta.get(c.name)), raw: v ?? null }];
        }));
        const row = { id: `b${run}-${index}-${j}`, cells, graphic: res.feature, emphasis: b.source.emphasis };
        if (b.target) return { ...row, target: b.target, fields: layerFields };
        const shown = columns.some(c => c.name !== RESULT_NAME) ? columns.filter(c => c.name !== RESULT_NAME).map(c => [c.name, c.label])
          : Object.keys(attrs).filter(k => attrs[k] != null && attrs[k] !== '').map(k => [k, k]);
        const fields = shown.map(([name, label]) => { const v = attrOf(attrs, name); return { name, label, value: formatValue(v), raw: v ?? null }; });
        return { ...row, result: { key: b.source.id, title: res.name ?? '', layerTitle: b.settings.name, graphic: res.feature, attributes: attrs, fields, blocks: [] } };
      });
      groups.push({ key: `box:${b.source.id}`, title: b.settings.name, columns, rows, fields: layerFields });
    }
    if (run === boxRun) viewer.showSearchResults(groups);
  }

  /** Search sources: the manifest's config plus each field's type from the live layer. */
  async function buildSearchSources(m) {
    const out = [];
    for (const s of m.search.sources) {
      const target = map.getTarget(s.layerKey);
      if (!target) continue;
      const meta = new Map((await target.fields().catch(() => [])).map(f => [f.name, f]));
      const fields = s.fields.map(name => meta.get(name)).filter(f => f && fieldKind(f.type))
        .map(f => ({ name: f.name, alias: f.alias || f.name, kind: fieldKind(f.type) }));
      const cols = (s.resultFields?.length ? s.resultFields : s.fields.map(name => ({ name })))
        .map(c => ({ name: c.name, label: c.label || meta.get(c.name)?.alias || c.name }));
      out.push({ key: s.layerKey, title: target.title, hint: s.hint || '', fields, operators: s.operators, defaultOperator: s.defaultOperator, columns: cols, emphasis: s.emphasis });
    }
    return out;
  }

  async function runSearch(source, where) {
    const { features, fields, exceeded, target } = await map.searchWhere(source.key, where);
    const meta = new Map(fields.map(f => [f.name, f]));
    const rows = features.map((g, i) => ({
      id: `s${i}`,
      cells: Object.fromEntries(source.columns.map(c => {
        const v = attrOf(g.attributes ?? {}, c.name);
        return [c.name, { text: formatValue(v, meta.get(c.name)), raw: v ?? null }];
      })),
      graphic: g, fields, target, emphasis: source.emphasis
    }));
    return [{ key: source.key, title: source.title, columns: source.columns, rows, fields, export: await searchExportOf(source, where, { features, fields, exceeded }),
      note: exceeded ? `Showing the first ${features.length}. Narrow the search to see the rest.` : null }];
  }

  /**
   * Export for an attribute search: every match (read again by ObjectID when the list stopped at its limit), with
   * the source's columns ticked and the layer's other fields offered. Newest ObjectIDs first, as the table opens.
   */
  async function searchExportOf(source, where, { features, fields, exceeded }) {
    const meta = new Map(fields.map(f => [f.name.toLowerCase(), f]));
    const oid = fields.find(f => /oid/i.test(f.type))?.name;
    const choices = exportChoices(source.columns, fields);
    const all = exceeded ? await map.searchExport(source.key, where).catch(() => null) : null;
    const rowsOf = (list, cols) => list.map(a => ({
      cells: Object.fromEntries(cols.map(c => { const v = attrOf(a, c.name); return [c.name, { text: formatValue(v, meta.get(c.name.toLowerCase())), raw: v ?? null }]; }))
    }));
    return {
      total: all?.total ?? features.length,
      choices,
      async exportAll(picked, opts) {
        const cols = pickedColumns(choices, fields, picked);
        let list = all ? await all.read(cols.map(c => c.name), opts) : features.map(g => g.attributes ?? {});
        if (!all && oid) list = [...list].sort((a, b) => Number(attrOf(b, oid)) - Number(attrOf(a, oid)));
        return { columns: cols, rows: rowsOf(list, cols) };
      }
    };
  }

  /** Add data: portal searches (curated groups or the whole portal) and adding layers for the session. */
  function addDataHandlers() {
    const portalUrl = () => manifest.webmap.portalUrl;
    const portal = () => auth.portalTarget(portalUrl());
    // Read a service through the app's own sign-in first: a secured or subscriber layer then asks people to sign in
    // here, instead of the SDK opening its own sign-in dialog and waiting on it.
    const checkAccess = async url => {
      if (!url) return;
      try { await api.getServiceInfo(url); }
      catch (e) {
        if (e instanceof auth.AuthRequiredError) throw new Error(`This layer is secured or subscriber content. Sign in to ${e.target.label} to add it.`);
        // Other failures (CORS, odd servers) are left to the SDK, which may still load the layer.
      }
    };
    return {
      async search({ groupIds, text, start }) {
        let orgId = '';
        if (!groupIds && manifest.addData.portalSearch === 'organization') {
          const self = await api.getPortalSelf(portalUrl());
          if (!self.isPortal) orgId = self.id ?? '';        // ArcGIS Enterprise is one organisation already
        }
        const q = portalItemQuery({ text, groupIds, orgId, types: CONFIG.addDataItemTypes });
        return api.searchItems(portalUrl(), { q, start });
      },
      async addItem(item) {
        await checkAccess(item.url);
        return map.addPortalItem(item, portalUrl());
      },
      async addUrl(url) {
        if (/\/rest\/services\//i.test(url)) await checkAccess(url);
        return map.addFromUrl(url);
      },
      async addFile(file) {
        if (file.size > CONFIG.addDataMaxFileBytes) throw new Error(`${file.name} is larger than ${Math.round(CONFIG.addDataMaxFileBytes / 1048576)} MB.`);
        if (!/\.zip$/i.test(file.name)) return map.addLocalFile(file);
        const fc = await api.generateFeatures(portalUrl(), file).catch(e => {
          throw new Error(e instanceof auth.AuthRequiredError ? `Converting a shapefile needs you to sign in to ${portal().label}.` : `The shapefile couldn't be read: ${e.message}`);
        });
        return map.addFeatureCollection(fc, file.name.replace(/\.zip$/i, ''));
      },
      remove: id => map.removeAdded(id),
      zoomTo: id => map.zoomToAdded(id),
      listAdded: () => map.listAdded(),
      signInTarget: portal,
      isSignedIn: () => Boolean(auth.credentialFor(portal())),
      onSignedIn: () => map.registerCredentials(auth.credentials())
    };
  }

  /**
   * The first server among these services ([{ id, url, title }]) that needs a sign-in this tab doesn't have:
   * { target, ids, titles } for its services, or null. Other failures are left to the map, which reports them.
   */
  async function needingSignIn(services) {
    const checks = await Promise.all(services.map(s =>
      api.getServiceInfo(s.url).then(() => null, e => (e instanceof auth.AuthRequiredError ? { s, target: e.target } : null))));
    const first = checks.find(Boolean);
    if (!first) return null;
    const same = checks.filter(c => c?.target.key === first.target.key);
    return { target: first.target, ids: same.map(c => c.s.id), titles: same.map(c => c.s.title) };
  }

  /**
   * Ids of the manifest's group-only services this person mustn't see. Asks the portal who is signed in on every
   * sync (a sign-in re-syncs); signed out, or any failure, hides them all (fails closed).
   */
  async function groupHiddenServices(m) {
    const services = m.webmap.extraServices ?? [];
    if (!hasGroupOnlyServices(services)) return new Set();
    const self = await api.getSelf(m.webmap.portalUrl).catch(() => null);
    return hiddenServiceIds(services, self);
  }

  /** The manifest's extra services that need a sign-in first (see needingSignIn). */
  const servicesNeedingSignIn = (m, skip) => needingSignIn((m.webmap.extraServices ?? []).filter(s => !skip.has(s.id))
    .map(s => ({ id: s.id, url: s.url, title: s.title || s.url.split('/rest/services/')[1] || s.url })));

  async function checkDrift(m) {
    if (!m.webmap.modified) return;
    try {
      const item = await api.getPortalItem(m.webmap.portalUrl, m.webmap.itemId);
      if (!item.modified || item.modified <= m.webmap.modified) return;
      viewer.notify(m.webmap.mode === 'snapshot'
        ? `The web map was edited on ${formatDateTime(item.modified)}. This viewer still shows the version frozen when it was published.`
        : `The web map was edited on ${formatDateTime(item.modified)}, after this viewer was published. You're seeing the latest web map.`);
    } catch { /* best effort */ }
  }

  async function sync() {
    const m = manifest;
    if (!m || !map.isReady() || applied === m) return;
    applied = m;
    widgets.destroyAll();
    editInfo.clear();
    editWindow.set(m.widgets.editing ? m.editing : null);
    sceneWindow.set(m.widgets.scene ? m.scene : null);
    trackingLayers.reset();
    streamingWindow.set(m.widgets.streaming ? m.streaming : null);
    setPages(m);
    setDownloads(m);
    traceWindow.set(m.widgets.trace ? m.trace : null);
    sceneView.reset();
    sceneSkipped = new Set();
    map.setIdentifyEnabled(true);
    viewer.render(m);
    viewer.setPagesOpen(pagesWindow.isOpen());     // opened while the map was loading: the new button shows it
    viewer.setDownloadsOpen(downloadsWindow.isOpen());

    const portal = auth.portalTarget(m.webmap.portalUrl);
    const askToSignIn = message => {
      applied = null;
      viewer.showSignIn(portal, message, () => { map.registerCredentials(auth.credentials()); sync(); });
    };
    if (m.webmap.secured && !auth.credentialFor(portal)) {
      askToSignIn(`"${m.title}" is a secured map. Sign in to ${portal.label} to open it.`);
      return;
    }
    map.registerCredentials(auth.credentials());

    // Extra ArcGIS REST services can sit on other servers with their own sign-in (password or Windows).
    if (skippedServices.manifest !== m) skippedServices = { manifest: m, ids: new Set() };
    // Group-only services are left out for anyone who isn't a member, without a word (and without asking them to sign in).
    const groupHidden = await groupHiddenServices(m);
    if (applied !== m) return;
    const skip = new Set([...skippedServices.ids, ...groupHidden]);
    const secured = await servicesNeedingSignIn(m, skip);
    if (secured) {
      applied = null;
      const what = secured.titles.length === 1 ? `"${secured.titles[0]}" is` : `${secured.titles.length} added services are`;
      viewer.showSignIn(secured.target, `${what} secured. Sign in to ${secured.target.label} to show ${secured.titles.length === 1 ? 'it' : 'them'} on the map.`,
        () => { map.registerCredentials(auth.credentials()); sync(); },
        { label: `Open the map without ${secured.titles.length === 1 ? 'it' : 'them'}`, onSkip: () => { secured.ids.forEach(id => skippedServices.ids.add(id)); sync(); } });
      return;
    }

    let loaded;
    spatialWindow.close();
    legendLabels.stop();
    layerStyles.stop();
    const loading = map.apply(m, { skipServices: skip });
    mapLoad = loading.catch(() => {});
    try { loaded = await loading; }
    catch (e) {
      if (map.isAuthError(e)) askToSignIn(`This map needs you to sign in to ${portal.label}.`);
      else viewer.notify(`The web map didn't load: ${e.message}`);
      return;
    }
    finishStartup();                   // the map is drawn; the widgets below fill in behind the disclaimer
    viewer.hideSignIn();
    if (CONFIG.startView && !usedStartView) { usedStartView = true; map.goToBookmark(CONFIG.startView); }
    if (loaded.errors.size) viewer.notify(`${loaded.errors.size} layer${loaded.errors.size > 1 ? 's' : ''} didn't load: ${[...loaded.errors.values()][0]}`);

    layerStyles.start(m.layerStyles, key => isServiceLayerKey(key, skip));   // before the Layers list: it asks which layers have styles
    if (viewer.has('layers')) widgets.mountLayerList(viewer.container('layers'), { dragEnabled: m.widgets.layerReorder === true, restLinks: m.widgets.restLinks ?? [] });
    if (viewer.has('legend')) widgets.mountLegend(viewer.container('legend'));
    if (viewer.has('layerInfo')) {
      const info = m.layerInfo?.layers ?? {};
      viewer.setLayerInfo(map.listLayers().filter(l => hasInfo(info[l.key])).map(l => ({ ...l, info: info[l.key] })));
    }
    if (viewer.has('bookmarks')) viewer.setBookmarks([...(m.bookmarks.includeWebMap ? loaded.bookmarks : []), ...m.bookmarks.extra]);
    // Charts and editing forms on services left out (group-only, or secured ones people skipped) drop out quietly.
    const left = key => isServiceLayerKey(key, skip);
    legendLabels.start(m.legendLabels, left);          // after the first draw; a small query per layer
    if (viewer.has('dashboards')) {
      viewer.setDashboards((m.dashboards ?? []).map(d => ({ ...d, widgets: d.widgets.filter(w => !left(w.layerKey)) }))
        .filter((d, i) => d.widgets.length || !m.dashboards[i].widgets.length), m.branding?.accent);
    }
    if (skip.size && m.widgets.editing) editWindow.set({ ...m.editing, layers: m.editing.layers.filter(l => !left(l.layerKey)) });
    if (viewer.has('editing')) {
      editWindow.setTitles(Object.fromEntries(m.editing.layers.map(l => [l.layerKey, map.getTarget(l.layerKey)?.title ?? ''])));
      if (m.widgets.open === 'editing') editWindow.open();
    }
    if (viewer.has('search')) {
      const box = await buildBoxSources(m, left);
      const boxNode = box.length ? widgets.mountSearchBox(box.map(b => b.settings), {
        allPlaceholder: m.search.allPlaceholder?.trim() || DEFAULT_ALL_PLACEHOLDER,
        activeSourceIndex: primaryIndex(m.search.boxPrimary, box.map(b => b.source.id))
      }, found => onBoxResults(found, box)) : null;
      viewer.setupSearch(await buildSearchSources(m), boxNode);
    }
    checkDrift(m);
  }

  /* ---------------- Startup screen and disclaimer ---------------- */
  function finishStartup() { startup.done().then(() => offerDisclaimer(manifest)); }

  // The browser's storage can be blocked (private windows, site settings): then the disclaimer is shown every visit.
  const storeFor = d => { try { return { session: sessionStorage, local: localStorage }[acceptanceStore(d)] ?? null; } catch { return null; } };

  /** Show the manifest's disclaimer unless it's on screen or was accepted (the draft preview never keeps an acceptance). */
  function offerDisclaimer(m) {
    const d = m?.disclaimer;
    if (!showsDisclaimer(d)) { disclaimerShown?.dialog?.close(); disclaimerShown = null; return; }
    const hash = disclaimerHash(d) + d.transition + d.speed + d.textSize;
    if (disclaimerShown?.hash === hash) return;
    disclaimerShown?.dialog?.close();
    disclaimerShown = null;
    const kept = options.preview ? null : storeFor(d);
    if (kept) { try { if (isAccepted(d, kept.getItem(acceptanceKey(m.id)), Date.now())) return; } catch { /* ask again */ } }
    const shown = { hash, dialog: null };
    shown.dialog = showDisclaimer(els.section, d, {
      onAccept() {
        shown.dialog = null;
        if (kept) { try { kept.setItem(acceptanceKey(m.id), acceptanceRecord(d, Date.now())); } catch { /* asked again next visit */ } }
      }
    });
    disclaimerShown = shown;
  }

  auth.onChange(() => map.registerCredentials(auth.credentials()));

  return {
    /** Show a manifest (renders the panel now; the map follows once started). */
    show(m) {
      manifest = m;
      if (!startup.isDone()) startup.configure(m);
      else offerDisclaimer(m);
      if (!map.isReady()) { viewer.render(m); setPages(m); setDownloads(m); }
      sync();
    },
    /** Create the map. Call once the viewer is visible (a hidden container has no size). */
    start() {
      if (started) return;
      started = true;
      map.init(els.mapEl)
        .then(() => { map.onMapClick(onMapClick); return sync(); })
        .catch(e => viewer.notify(e.message))
        .finally(finishStartup);         // also when it stopped to ask people to sign in
    },
    getViewState: () => map.getViewState(),
    notify: msg => viewer.notify(msg),
    isStarted: () => started
  };
}
