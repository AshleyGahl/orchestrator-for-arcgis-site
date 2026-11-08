// manifest.js — the contract between Orchestration (human or AI agent) and the GIS Viewer. Pure functions.
//
// v3: the web map supplies layers, cartography, basemap, extent and popups. The manifest adds:
//   webmap     which web map (portal, item, live or snapshot), plus extraServices: ArcGIS REST services or
//              layers drawn on top of it [{ id, url, title, visible, access, groupIds }]. Their layers are keyed like
//              web map layers: "<id>" for a single layer, "<id>:<layerId>" for a map or feature service's layers.
//              access "groups": only signed-in members of any of groupIds see it; everyone else never knows it's there.
//              layerOrder: top-level layer ids (web map operational layers and extra services), top first;
//              empty = the default (extra services on top, then the web map's own order). See layerOrder.js.
//              layerVisibility: { "<top-level web map layer id>": true | false }, on or off when the viewer opens,
//              only where it differs from the web map (extra services use their own "visible").
//   branding   header colours, subtitle, logo; accent (selection) and selectionOnImagery (selection over an aerial);
//              selectionLine: the selection outline's line style (SELECTION_LINES)
//   widgets    which side-panel widgets and tools the viewer offers, and (order, toolOrder) in what order;
//              layerReorder: people may drag layers in the Layers widget to change the order for their visit;
//              restLinks: layer keys whose Layers menu has "Open REST endpoint" (none by default);
//              toolConfig: each tool's settings, e.g. dimensions { unit, areaUnit, decimals, showArea, showBearings,
//              bearingFormat, lineLength, lengthColor, areaColor, bearingColor } (see dimensions.js); vegetation { source,
//              serviceUrl, bands, scale, dateField, cloudField, indices, defaultIndex, breaks, maxCloud, opacity } (vegetation.js);
//              cursors: the map cursor while a tool or widget waits for the map { draw, pick, select, colour, size,
//              overrides: { <tool id | trace | editing | spatial>: cursor id } } (cursors.js);
//              detailsEmphasis: how a feature clicked on the map (or picked in Details) stands out (emphasis.js; plain
//              selection outline by default); toolConfig.select, toolConfig['go-to-xy'] and toolConfig.vegetation each have
//              an emphasis for their own highlight too. highlights.js lists every emphasis in a manifest.
//   bookmarks  web map bookmarks on/off, plus extra ones
//   search     the Search widget: sources = layers + fields + operators for the attribute search, each with the
//              emphasis of the result chosen (emphasis.js); boxSources = the search box above it (searchBox.js:
//              geocoding services and layers with suggestions, as in Experience Builder), boxPrimary the source it
//              opens on ('' = All), allPlaceholder its hint
//   addData    what the Add data widget offers: curated collections (each one or more portal groups),
//              portal search, a layer URL and local files. Added layers last for the session only.
//   editing    form-centric editing of feature service layers: a form template, how wide the window opens (and at half
//              width, on which side), and per layer what people may do (update, add, delete) and which fields the form shows:
//              their order, labels, hints, groups (layer.groups) and rules that show a field or group, or make a field
//              required or editable, only while another field's value matches (smart forms, editing.js).
//              emphasis: how the chosen record stands out on the map (emphasis.js).
//   scene      the 3D scene widget: how wide it opens (and at half width, on which side), and the layers drawn in it,
//              each with its height (a numeric field, a stable random height between a minimum and a maximum, or
//              none: flat on the ground).
//              Nothing comes over from the 2D map.
//   streaming  the Streaming widget: how wide its window opens (and at half width, on which side), and its three
//              sections, each switched on or off (on) with the portal group whose members may use it ('' = everyone):
//                cameras   streams [{ id, title, url, kind, refreshSeconds, location, description, credit }]
//                drones    demo (offer the demo streams). No stream addresses: people paste a live drone stream's
//                          address in the viewer, for their session only.
//                tracking  feeds of moving objects drawn on the map [{ id, title, kind, url, refreshSeconds, itemsPath,
//                          latField, lonField, idField, labelField, trail, color, visible, description, credit }]
//              (Cameras and Drones used to be two widgets with their own top-level blocks; upgrade() moves them in.)
//   externalPages  the External pages widget: other sites' pages opened inside the viewer, in a window over the map:
//              how wide it opens (and at half width, on which side), and pages [{ id, title, url, description, followMap }].
//              followMap: a GIS viewer that opens where the map is looking; its url has {lon}, {lat}, {zoom}, {scale}…
//              where the numbers go (externalPages.js).
//              New manifests (and older ones without the block) start with CONFIG.externalPageExamples.
//   downloads  the Downloads widget: lists of files people can download, each shown as a table in a window over the
//              map: how wide it opens (and at half width, on which side), and pages [{ id, title, description, source }].
//              source: { kind, url, where, listPath, fields: { name, link, count, type, date }, items, countLabel };
//              kind instantApp (a gallery Instant App's group), hubSite, featureTable, jsonApi or manual (downloads.js).
//   trace      the Attribute trace widget: chains of field relationships from a starting feature to the features it
//              may affect (trace.js): how wide its window opens (and at half width, on which side), allowUserTraces
//              (viewer users may also make their own, kept in their browser only), limits { maxSteps, maxIdsPerStep,
//              maxFinal, batchSize, concurrency, timeoutSeconds } and traces [{ id, title, description, startLayer,
//              resultLabel, confirmsImpact, steps: [{ id, from, sourceField, targetLayer, targetField, filters,
//              optional, caseInsensitive }], finalFields: [{ name, label }] }]. Layers are layer keys, as in details.
//              emphasis: how the chosen result stands out on the map (emphasis.js), as for spatial sections.
//   details    per-layer additions to Details, keyed by layer key:
//              "<operationalLayerId>" for feature layers, "<operationalLayerId>:<sublayerId>" for map service sublayers
//              { title?, hideFields?, ignoreScale?, expand?, sections?, actions? }
//              ignoreScale: identify the layer even when it's outside its visible scale range (e.g. wards)
//              expand: the layer's section opens by default in the viewer's Details pane; once any layer has it,
//                      only those layers open (with none, the top layer opens)
//              sections: 1:m data the web map popup can't show (related-table via REST, or your own API),
//                        or a spatial relationship (features of other layers related by location, run on request);
//                        a spatial section's emphasis { flash, flashTimes, highlight, fillOpacity, lift, liftHeight } says how the
//                        result people pick stands out on the map (emphasis.js)
//   layerInfo  the Layer information widget: layers { "<layer key>": { rows: [{ label, value }], service? } }
//              (the author's own labels; service: also show facts read from the layer's service), and showAddress
//              (false leaves each service's address out of those facts). See layerInfo.js.
//              (It used to be details[key].info, the (i) beside CSV; upgrade() drops that, it isn't moved.)
//   legendLabels  counts in the labels of a layer's categorized (unique value) style, e.g. "Residential Zone I (1,204)":
//              layers { "<layer key>": { mode: 'field'|'auto', countField?, part: 'all'|'before'|'after', refreshSeconds } }.
//              Symbols are never changed; a layer with no entry keeps its style's own labels. See legendLabels.js.
//   layerStyles  several styles for one layer that people switch between in the Layers list (only the renderer changes):
//              layers { "<layer key>": { start: 'webmap'|styleId, styles: [{ id, name, description, enabled, type:
//              'simple'|'uniqueValue'|'classBreaks', outlines: 'layer'|'own', field?, values?|minValue?+classes?, other, outline,
//              opacity, fill? }] } }. outlines 'layer': drawn over the layer, which keeps its own outlines.
//              A layer with no entry keeps its own style and shows no choice. See layerStyles.js.
//   disclaimer shown over the viewer once it has started, until people accept: { enabled, title, text, acceptLabel,
//              textSize: 'small'|'medium'|'large'|'xlarge', speed: 'slow'|'medium'|'fast'|'instant',
//              transition: 'left'|'top'|'center', remember: 'never'|'session'|'days', rememberDays }. text is plain text
//              (a blank line starts a paragraph; https:// addresses become links; ## heading, - list, > note,
//              | table |, **bold**: disclaimerBlocks). Accepting is kept in that browser
//              for the wording accepted: change it and people are asked again. New disclaimers (and empty ones left
//              off) start with the standard wording (STANDARD_DISCLAIMER_TEXT), off. See disclaimer.js.
//   dashboards [{ id, title, description, widgets }]: each widget is an indicator, a chart, a summary table
//              ('table': one row per group) or a features table ('records': columns, orderField, orderDirection),
//              and has a width in grid columns (cols, 1-12) and a height in rows (rows); they flow in list order.
//              (Widgets used to have a size small|medium|large|full; upgrade() turns it into cols. dashboardItems.js.)

import { CONFIG } from './config.js';
import { uid, isHex, contrastRatio, isAllowedHost, isHttpUrl, isWindowSide } from './utils.js';
import { checkExtraServices, extraServicesWarnings } from './restServices.js';
import { checkLayerOrder, checkLayerVisibility } from './layerOrder.js';
import { OPERATOR_IDS } from './query.js';
import { isSpatialRelation, isSpatialWindowSize, SPATIAL_MAX_DISTANCE_M } from './spatial.js';
import { isEditTemplate, isEditWidth, isFeatureServiceLayerUrl, EDIT_MAX_RECORDS, LIST_FIELDS_MAX, ruleProblem, GROUP_LABEL_MAX, HINT_MAX } from './editing.js';
import { isLabelMode } from './labelAngles.js';
import { dimensionsProblems } from './dimensions.js';
import { vegetationProblems } from './vegetation.js';
import { isSceneWidth, isHeightMode, isPointShape, defaultThickness, SCENE_MAX_HEIGHT_M, THICKNESS_MIN_M, THICKNESS_MAX_M } from './scene.js';
import { STREAMING_SECTIONS, STREAMING_SECTION_IDS, isStreamWidth, isStreamKind, streamUrlProblem, isLonLat, REFRESH_MIN_S, REFRESH_MAX_S, STREAMS_MAX } from './streams.js';
import { isPageWidth, pageUrlProblem, PAGES_MAX } from './externalPages.js';
import { isDownloadWidth, isSourceKind, sourceProblem, DOWNLOAD_PAGES_MAX } from './downloads.js';
import { trackUrlProblem, isPath, isPolled, FEEDS_MAX, TRAIL_MAX, TRACK_REFRESH_MIN_S, TRACK_REFRESH_MAX_S } from './tracking.js';
import { infoProblems, hasInfo } from './layerInfo.js';
import { legendLabelProblems } from './legendLabels.js';
import { layerStylesProblems, outlinesOf, WEBMAP_STYLE } from './layerStyles.js';
import { checkTrace, limitProblems, defaultTraceLimits, isTraceWidth, TRACES_MAX, START } from './trace.js';
import { defaultSpan, upgradeSpan, GRID_COLUMNS, MAX_ROWS } from './dashboardItems.js';
import { defaultDisclaimer, disclaimerProblems } from './disclaimer.js';
import { defaultCursors, cursorProblems } from './cursors.js';
import { defaultDetailsEmphasis, defaultSelectEmphasis, defaultEditingEmphasis, defaultGoToEmphasis, defaultVegetationEmphasis } from './highlights.js';
import { defaultEmphasis, emphasisProblems } from './emphasis.js';
import { upgradeSearchBox, boxSourceProblems } from './searchBox.js';
import { isResultsAt } from './resultsDock.js';
import { defaultAddressAudit, upgradeAddressAudit, addressAuditProblems } from './addressAudit.js';

const WIDGET_IDS = CONFIG.widgets.map(([id]) => id);
const TOOL_IDS = CONFIG.tools.map(([id]) => id);
export const SECTION_TYPES = { 'related-table': 'Related table (ArcGIS REST)', api: 'Your API (JSON)', spatial: 'Spatial relationship' };
/** branding.selectionLine: [ArcGIS simple-line style, label]. */
export const SELECTION_LINES = [['solid', 'Solid'], ['dash', 'Dashed'], ['short-dash', 'Short dashes (broken)'], ['long-dash', 'Long dashes'], ['dot', 'Dotted'], ['dash-dot', 'Dash-dot']];

/** A new spatial relationship section (Details): which layers' features relate to the clicked one by location. */
export const newSpatialSection = () => ({ id: uid('sec'), title: 'Spatial relationship', type: 'spatial', render: 'table', relation: 'intersects', distance: 100, targets: [], max: 200, windowSize: 'default', windowSide: 'left', emphasis: defaultEmphasis() });
export const SECTION_RENDERS = { table: 'Table', fields: 'Field list' };

export const DEFAULT_OPERATORS = ['eq', 'ne', 'contains', 'startsWith', 'endsWith', 'gt', 'gte', 'lt', 'lte', 'between', 'in', 'empty', 'notEmpty'];

/**
 * A new search source. fields = searchable; resultFields = result table columns (empty = the searchable fields);
 * emphasis = how the result people pick stands out on the map (its own colour, or the selection colour).
 */
export const newSearchSource = layerKey => ({
  id: uid('src'), layerKey, fields: [], operators: [...DEFAULT_OPERATORS], defaultOperator: 'contains', resultFields: [], hint: '', emphasis: defaultEmphasis()
});

/** Each tool's settings; Select features, Go to coordinates and Vegetation health also say how their highlight looks. */
export const defaultToolConfig = () => {
  const t = structuredClone(CONFIG.toolDefaults);
  t.select.emphasis = defaultSelectEmphasis();
  t['go-to-xy'] = { ...(t['go-to-xy'] ?? {}), emphasis: defaultGoToEmphasis() };
  t.vegetation.emphasis = defaultVegetationEmphasis();
  t['address-audit'] = defaultAddressAudit();      // addressAudit.js
  return t;
};

/** A new dashboard widget (chart or indicator). */
export const newDashboardWidget = (type = 'bar', layerKey = '') => {
  const round = type === 'pie' || type === 'doughnut';
  return {
    id: uid('dw'), type, title: '', layerKey, categoryField: '', valueField: '', statistic: 'count',
    where: '', sort: 'value-desc', topN: type === 'records' ? 25 : 10, ...defaultSpan(type), prefix: '', suffix: '', decimals: 0,
    columns: [], orderField: '', orderDirection: 'desc',   // features tables: the fields shown, and their order ('' = newest first)
    // Appearance
    color: '',                          // '' = the viewer's accent colour
    colorMode: round ? 'palette' : 'single',
    opacity: 0.85,                      // fill transparency, 0 (clear) to 1 (solid)
    outlineColor: round ? '#FFFFFF' : '',
    outlineWidth: round ? 2 : type === 'line' ? 2 : 0,
    showValues: false,                  // value labels on bars, points and slices
    legend: 'auto',
    xTitle: '', yTitle: '',
    showGrid: true,
    labelMaxLength: 24,                 // longer category labels are shortened (full text in the tooltip)
    smooth: true, fillArea: true, pointSize: 3,   // line charts
    cutout: 55,                         // doughnut hole, % of the radius
    caption: ''                         // indicators: a line under the number
  };
};
export const newDashboard = (n = 1) => ({ id: uid('dash'), title: `Dashboard ${n}`, description: '', widgets: [] });

/** A curated collection for Add data: a name people see, and the portal groups whose items it lists. */
export const newAddDataCollection = (n = 1) => ({ id: uid('col'), title: `Collection ${n}`, description: '', groupIds: [] });

/** portalSearch: 'organization' (this organisation's items), 'all' (whatever the portal shows) or 'off'. */
export const defaultAddData = () => ({ collections: [], portalSearch: 'organization', url: true, file: true });

/**
 * Editing: one entry per layer people can edit. fields = the form, in order (empty = every field the server lets
 * people edit). titleField names each record in the list; listFields are shown with it (and are the Table columns).
 */
export const newEditLayer = layerKey => ({
  id: uid('edl'), layerKey, title: '', allowUpdate: true, allowAdd: false, allowDelete: false, titleField: '', listFields: [], fields: [], groups: []
});
export const defaultEditing = () => ({ template: 'classic', width: 'half', side: 'left', maxRecords: 200, layers: [], emphasis: defaultEditingEmphasis() });

/**
 * The 3D scene: one entry per layer drawn in it. geometry ('polygon' | 'point' | 'line', when known) picks the
 * starting thickness: a point's diameter or a wall's thickness. color '' = the branding accent.
 * minScale: only draw the layer when zoomed in past 1:minScale (0 = always).
 */
export const newSceneLayer = (layerKey, geometry = null) => ({
  id: uid('scl'), layerKey, title: '', heightMode: 'random', heightField: '', minHeight: 3, maxHeight: 12,
  color: '', pointShape: 'cylinder', thickness: defaultThickness(geometry), minScale: 0
});
export const defaultScene = () => ({ width: 'half', side: 'left', layers: [] });

/**
 * Streaming, Cameras: one entry per stream. kind = how the browser plays it (streams.js STREAM_KINDS);
 * refreshSeconds = how often a snapshot is reloaded; location = [longitude, latitude] or null (no marker on the map);
 * credit = attribution shown under the player.
 */
export const newStream = (fields = {}) => ({
  id: uid('st'), title: '', url: '', kind: 'hls', refreshSeconds: 10, location: null, description: '', credit: '', ...fields
});
/**
 * Streaming, Tracking: one entry per feed of moving objects (tracking.js TRACK_KINDS). refreshSeconds = how often a
 * feature layer, GeoJSON or JSON feed is read again (a stream service pushes); itemsPath, latField, lonField = where a
 * JSON feed keeps its list and each object's position (dotted paths); idField, labelField = which value identifies and
 * names an object ('' = the feed's own); trail = earlier positions drawn behind each object (0 = none);
 * color '' = the next colour of tracking.js TRACK_COLORS; visible = on the map when Tracking first opens.
 */
export const newFeed = (fields = {}) => ({
  id: uid('trk'), title: '', kind: 'json', url: '', refreshSeconds: 15, itemsPath: '', latField: '', lonField: '',
  idField: '', labelField: '', trail: 20, color: '', visible: true, description: '', credit: '', ...fields
});
/** The Streaming widget. Drones store no streams (they're pasted in the viewer); demo = list the demo streams too. */
export const defaultStreaming = () => ({
  width: 'half', side: 'left',
  cameras: { on: false, groupId: '', streams: [] },
  drones: { on: false, groupId: '', demo: false },
  tracking: { on: false, groupId: '', feeds: [] }
});

/**
 * External pages: one entry per page. description = a line under its name on the card people choose it from;
 * followMap = a GIS viewer opened where the map is looking (its url carries placeholders, externalPages.js), else an
 * ordinary page opened at its address.
 */
export const newExternalPage = (fields = {}) => ({ id: uid('pg'), title: '', url: '', description: '', followMap: false, ...fields });
export const defaultExternalPages = () => ({
  width: 'full', side: 'left', pages: CONFIG.externalPageExamples.map(p => newExternalPage(structuredClone(p)))
});

/**
 * Downloads: one entry per download page (a tab in its window). source: where its list comes from (downloads.js);
 * the settings for the other kinds stay when the kind is changed, so switching back loses nothing.
 */
export const newDownloadSource = (fields = {}) => ({
  kind: 'instantApp', url: '', where: '1=1', listPath: '', fields: { name: '', link: '', count: '', type: '', date: '' }, items: [], countLabel: '', ...fields
});
export const newDownloadPage = (fields = {}) => ({ id: uid('dl'), title: '', description: '', ...fields, source: newDownloadSource(fields.source) });
export const defaultDownloads = () => ({ width: 'half', side: 'left', pages: [] });

/**
 * Attribute trace: a trace starts from a feature of startLayer and follows its steps; each step matches sourceField
 * (read from the start or earlier steps, from) to targetField on targetLayer. The last step's layer holds the results.
 */
export const newTraceStep = (fields = {}) => ({
  id: uid('stp'), from: START, sourceField: '', targetLayer: '', targetField: '', filters: [], optional: false, caseInsensitive: false, ...fields
});
export const newTrace = (fields = {}) => ({
  id: uid('trc'), title: '', description: '', startLayer: '', resultLabel: '', confirmsImpact: false, steps: [], finalFields: [], ...fields
});
export const defaultTrace = () => ({ width: 'half', side: 'left', allowUserTraces: false, limits: defaultTraceLimits(), emphasis: defaultEmphasis(), traces: [] });

/** order / toolOrder: widget and tool ids in the order the viewer shows them. Empty = the default order in config.js. */
export const defaultWidgets = () => ({
  layers: true, legend: true, details: true, bookmarks: true, search: true, addData: false, dashboards: false, editing: false, scene: false,
  streaming: false, externalPages: false, downloads: false, layerInfo: false, trace: false,
  tools: ['measure-distance', 'measure-area', 'select', 'go-to-xy', 'basemap-gallery', 'share-link', 'screenshot', 'coordinates', 'export-results'],
  toolConfig: defaultToolConfig(),
  open: 'layers',
  order: [],
  toolOrder: [],
  layerReorder: false,
  restLinks: [],
  cursors: defaultCursors(),
  detailsEmphasis: defaultDetailsEmphasis()
});

export const defaultLayout = () => ({ template: 'rail', panelSide: 'right', fieldsAs: 'rows', resultsAt: 'panel' });

export function createEmpty() {
  return {
    schema: CONFIG.schemaId,
    id: uid('viewer'),
    title: 'Untitled viewer',
    description: '',
    version: 0,
    publishedAt: null,
    publishedBy: null,
    webmap: { portalUrl: CONFIG.defaultPortalUrl, itemId: '', title: '', mode: 'live', secured: false, modified: null, snapshot: null, extraServices: [], layerOrder: [], layerVisibility: {} },
    branding: { ...CONFIG.defaultBranding },
    layout: defaultLayout(),
    widgets: defaultWidgets(),
    bookmarks: { includeWebMap: true, extra: [] },
    search: { boxSources: [], boxPrimary: '', allPlaceholder: '', sources: [] },
    addData: defaultAddData(),
    editing: defaultEditing(),
    scene: defaultScene(),
    streaming: defaultStreaming(),
    externalPages: defaultExternalPages(),
    downloads: defaultDownloads(),
    trace: defaultTrace(),
    dashboards: [],
    details: {},
    layerInfo: { layers: {}, showAddress: true },
    legendLabels: { layers: {} },
    layerStyles: { layers: {} },
    disclaimer: defaultDisclaimer()
  };
}

/** Fill in anything missing (agent-written manifests can be partial). Never throws. */
export function upgrade(m) {
  if (!m || typeof m !== 'object' || m.schema !== CONFIG.schemaId) return m;
  const base = createEmpty();
  const out = structuredClone(m);
  out.webmap = { ...base.webmap, ...(out.webmap ?? {}) };
  if (Array.isArray(out.webmap.extraServices)) out.webmap.extraServices = out.webmap.extraServices.map(s => ({ title: '', visible: true, access: 'everyone', groupIds: [], ...s }));
  out.branding = { ...base.branding, ...(out.branding ?? {}) };
  out.layout = { ...base.layout, ...(out.layout ?? {}) };
  out.widgets = { ...base.widgets, ...(out.widgets ?? {}) };
  out.widgets.toolConfig = Object.fromEntries(Object.entries(base.widgets.toolConfig)
    .map(([id, def]) => [id, { ...def, ...(out.widgets.toolConfig?.[id] ?? {}) }]));
  // Dimensions used to preset its layers (and show them on opening); people now tick the layers in the viewer.
  delete out.widgets.toolConfig.dimensions.layers;
  delete out.widgets.toolConfig.dimensions.startOn;
  const cur = out.widgets.cursors;
  if (cur && typeof cur === 'object' && !Array.isArray(cur)) out.widgets.cursors = { ...defaultCursors(), ...cur, overrides: cur.overrides ?? {} };
  out.widgets.toolConfig['address-audit'] = upgradeAddressAudit(out.widgets.toolConfig['address-audit']);
  const veg = out.widgets.toolConfig.vegetation;
  veg.bands = { ...base.widgets.toolConfig.vegetation.bands, ...(veg.bands ?? {}) };
  out.bookmarks = { ...base.bookmarks, ...(out.bookmarks ?? {}) };
  const hadBox = Array.isArray(out.search?.boxSources);
  out.search = { ...base.search, ...(out.search ?? {}) };
  if (!hadBox) delete out.search.boxSources;  // upgradeSearchBox makes it from geocoder
  out.search.sources = (out.search.sources ?? []).map(src => {
    const next = { ...newSearchSource(src.layerKey), ...src };
    if (src.emphasis && typeof src.emphasis === 'object' && !Array.isArray(src.emphasis)) next.emphasis = { ...defaultEmphasis(), ...src.emphasis };
    return next;
  });
  upgradeSearchBox(out.search);               // geocoder: true -> the World Geocoder in boxSources
  out.addData = { ...base.addData, ...(out.addData ?? {}) };
  out.addData.collections = (out.addData.collections ?? []).map((c, i) => ({ ...newAddDataCollection(i + 1), ...c }));
  out.editing = { ...base.editing, ...(out.editing ?? {}) };
  out.editing.layers = (out.editing.layers ?? []).map(l => ({ ...newEditLayer(l.layerKey), ...l }));
  out.scene = { ...base.scene, ...(out.scene ?? {}) };
  out.scene.layers = (out.scene.layers ?? []).map(l => ({ ...newSceneLayer(l.layerKey), ...l }));
  upgradeStreaming(m, out, base);
  out.externalPages = { ...base.externalPages, ...(out.externalPages ?? {}) };
  if (Array.isArray(out.externalPages.pages)) out.externalPages.pages = out.externalPages.pages.map(p => ({ ...newExternalPage(), ...p }));
  out.downloads = { ...base.downloads, ...(out.downloads ?? {}) };
  if (Array.isArray(out.downloads.pages)) {
    out.downloads.pages = out.downloads.pages.map(p => {
      const src = { ...newDownloadSource(), ...(p?.source ?? {}) };
      src.fields = { ...newDownloadSource().fields, ...(p?.source?.fields ?? {}) };
      return { ...newDownloadPage(), ...p, source: src };
    });
  }
  out.trace = { ...base.trace, ...(out.trace ?? {}) };
  out.trace.limits = { ...base.trace.limits, ...(out.trace.limits ?? {}) };
  if (out.trace.emphasis && typeof out.trace.emphasis === 'object' && !Array.isArray(out.trace.emphasis)) out.trace.emphasis = { ...defaultEmphasis(), ...out.trace.emphasis };
  // Highlights that had no settings before: a partial block is filled in from its own default (as the viewer drew it).
  const fillIn = (holder, key, dflt) => { const v = holder?.[key]; if (v && typeof v === 'object' && !Array.isArray(v)) holder[key] = { ...dflt(), ...v }; };
  fillIn(out.widgets, 'detailsEmphasis', defaultDetailsEmphasis);
  fillIn(out.editing, 'emphasis', defaultEditingEmphasis);
  fillIn(out.widgets.toolConfig.select, 'emphasis', defaultSelectEmphasis);
  fillIn(out.widgets.toolConfig['go-to-xy'], 'emphasis', defaultGoToEmphasis);
  fillIn(out.widgets.toolConfig.vegetation, 'emphasis', defaultVegetationEmphasis);
  if (Array.isArray(out.trace.traces)) {
    out.trace.traces = out.trace.traces.map(t => (t && typeof t === 'object'
      ? { ...newTrace(), ...t, steps: Array.isArray(t.steps) ? t.steps.map(s => (s && typeof s === 'object' ? { ...newTraceStep(), ...s } : s)) : t.steps }
      : t));
  }
  out.dashboards = (out.dashboards ?? []).map(d => ({ ...newDashboard(), ...d, widgets: (d.widgets ?? []).map(w => upgradeSpan({ ...newDashboardWidget(w.type), cols: undefined, rows: undefined, ...w })) }));
  out.details ??= {};
  for (const cfg of Object.values(out.details)) if (cfg) delete cfg.orientation;   // replaced by layout.fieldsAs
  for (const [key, cfg] of Object.entries(out.details)) {                         // info: replaced by layerInfo (not moved)
    if (!cfg || !('info' in cfg)) continue;
    delete cfg.info;
    if (!Object.keys(cfg).length) delete out.details[key];
  }
  out.layerInfo = { ...base.layerInfo, ...(out.layerInfo ?? {}) };
  out.layerInfo.layers ??= {};
  if (typeof out.layerInfo.showAddress !== 'boolean') out.layerInfo.showAddress = true;
  out.legendLabels = { ...base.legendLabels, ...(out.legendLabels ?? {}) };
  out.legendLabels.layers ??= {};
  for (const cfg of Object.values(out.legendLabels.layers)) if (cfg && typeof cfg === 'object') { cfg.part ??= 'all'; cfg.refreshSeconds ??= 0; }
  out.layerStyles = { ...base.layerStyles, ...(out.layerStyles ?? {}) };
  out.layerStyles.layers ??= {};
  for (const cfg of Object.values(out.layerStyles.layers)) {
    if (!cfg || typeof cfg !== 'object') continue;
    cfg.start ??= WEBMAP_STYLE;
    for (const s of Array.isArray(cfg.styles) ? cfg.styles : []) if (s && typeof s === 'object') { s.description ??= ''; s.enabled ??= true; s.outlines ??= outlinesOf(s); }
  }
  for (const cfg of Object.values(out.details)) for (const s of cfg?.sections ?? []) {
    if (s?.type !== 'spatial') continue;
    s.windowSide ??= 'left';
    s.emphasis = s.emphasis == null ? defaultEmphasis() : typeof s.emphasis === 'object' && !Array.isArray(s.emphasis) ? { ...defaultEmphasis(), ...s.emphasis } : s.emphasis;
  }
  if (out.disclaimer == null || (typeof out.disclaimer === 'object' && !Array.isArray(out.disclaimer))) out.disclaimer = { ...base.disclaimer, ...(out.disclaimer ?? {}) };
  // A disclaimer left off and empty (made before the standard wording) starts with the standard wording too.
  if (out.disclaimer?.enabled === false && typeof out.disclaimer.text === 'string' && !out.disclaimer.text.trim()) out.disclaimer.text = base.disclaimer.text;
  return out;
}

/**
 * Streaming: Cameras and Drones used to be two widgets with their own top-level blocks; they're now sections of the
 * Streaming widget (with Tracking). Moves them in (each keeps its group; the window keeps the width and side of the one
 * that was switched on, Cameras first), renames them in widgets.order and widgets.open, and fills in defaults.
 */
function upgradeStreaming(m, out, base) {
  const w = out.widgets;
  const was = { cameras: w.cameras === true, drones: w.drones === true };
  if (!m.streaming && (m.cameras || m.drones || 'cameras' in w || 'drones' in w)) {
    const first = (was.cameras || !was.drones ? m.cameras ?? m.drones : m.drones ?? m.cameras) ?? {};
    const oldDrones = m.drones ?? {};
    out.streaming = {
      width: first.width ?? 'half', side: first.side ?? 'left',
      cameras: { on: was.cameras, groupId: m.cameras?.groupId ?? '', streams: m.cameras?.streams ?? [] },
      // Even earlier drone settings listed streams; addresses are now pasted in the viewer, so they're dropped here.
      drones: { on: was.drones, groupId: oldDrones.groupId ?? '', demo: typeof oldDrones.demo === 'boolean' ? oldDrones.demo : Array.isArray(oldDrones.streams) && oldDrones.streams.length > 0 },
      tracking: base.streaming.tracking
    };
    w.streaming = was.cameras || was.drones;
  }
  delete out.cameras; delete out.drones; delete w.cameras; delete w.drones;
  const rename = id => (id === 'cameras' || id === 'drones' ? 'streaming' : id);
  if (Array.isArray(w.order)) w.order = [...new Set(w.order.map(rename))];
  w.open = rename(w.open);
  const s = out.streaming = { ...base.streaming, ...(out.streaming ?? {}) };
  for (const id of STREAMING_SECTION_IDS) s[id] = { ...base.streaming[id], ...(s[id] ?? {}) };
  s.cameras.streams = (s.cameras.streams ?? []).map(st => ({ ...newStream(), ...st }));
  delete s.drones.streams;
  s.tracking.feeds = (s.tracking.feeds ?? []).map(f => ({ ...newFeed(), ...f }));
}

/** Remove a layer's details entry when nothing is customised, so the manifest stays honest. */
export function pruneDetails(details) {
  for (const [key, cfg] of Object.entries(details)) {
    const empty = !cfg?.title && !cfg?.hideFields?.length && !cfg?.sections?.length && !cfg?.actions?.length && !cfg?.ignoreScale && !cfg?.expand;
    if (empty) delete details[key];
  }
}

/** Remove a layer's Layer information entry when it has no rows and doesn't show the service's details. */
export function pruneLayerInfo(layerInfo) {
  const layers = layerInfo?.layers ?? {};
  for (const [key, info] of Object.entries(layers)) {
    if (info?.rows && !info.rows.length) delete info.rows;
    if (!info?.rows?.length && !info?.service) delete layers[key];
  }
}

/**
 * Returns { ok, errors[], warnings[] }. Anything that produces manifests (UI or agent) must pass this.
 * ctx.layerKeys (optional Set) and ctx.layerTitles (optional Map) let Orchestration warn about, and name, layers;
 * ctx.layerUrls (optional Map) lets it check that edited layers are feature service layers.
 */
export function validate(m, ctx = {}) {
  const errors = [], warnings = [];
  const isNum = v => typeof v === 'number' && Number.isFinite(v);
  const isLonLat = c => Array.isArray(c) && c.length === 2 && isNum(c[0]) && isNum(c[1]) && Math.abs(c[0]) <= 180 && Math.abs(c[1]) <= 90;

  if (!m || typeof m !== 'object') return { ok: false, errors: ['Manifest is not a JSON object.'], warnings };

  // A manifest is shared and published, so it must never carry secrets (sign-in happens in the browser).
  const secretKeys = [];
  const scan = (v, path) => {
    if (Array.isArray(v)) v.forEach((x, i) => scan(x, `${path}[${i}]`));
    else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) {
      if (path === 'webmap.snapshot') continue;
      if (/^(password|passwd|pwd|token|access_?token|secret|api_?key|credentials?)$/i.test(k)) secretKeys.push(`${path ? `${path}.` : ''}${k}`);
      scan(x, path ? `${path}.${k}` : k);
    }
  };
  scan(m, '');
  if (secretKeys.length) errors.push(`The manifest must not contain passwords, tokens or keys (found: ${secretKeys.join(', ')}). People sign in when they open the viewer.`);
  if (/[?&]token=/i.test(JSON.stringify({ ...m, webmap: { ...m.webmap, snapshot: null } }))) errors.push('A URL in the manifest carries a token. Remove it; people sign in when they open the viewer.');
  if (m.schema !== CONFIG.schemaId) errors.push(`"schema" must be "${CONFIG.schemaId}".`);
  if (!m.title?.trim?.()) errors.push('Give the viewer a title.');

  // Web map
  const w = m.webmap;
  if (!w || typeof w !== 'object') errors.push('"webmap" is missing.');
  else {
    if (!/^[0-9a-f]{32}$/i.test(w.itemId ?? '')) errors.push('Choose a web map (a 32-character item id).');
    if (!/^https:\/\/.+/i.test(w.portalUrl ?? '')) errors.push('Portal URL must start with https://');
    if (!['live', 'snapshot'].includes(w.mode)) errors.push('Web map mode must be "live" or "snapshot".');
    if (w.snapshot != null && (typeof w.snapshot !== 'object' || !Array.isArray(w.snapshot.operationalLayers))) errors.push('The web map snapshot is not valid web map JSON.');
    errors.push(...checkExtraServices(w.extraServices));
    warnings.push(...extraServicesWarnings(w.extraServices));
    errors.push(...checkLayerOrder(w.layerOrder));
    errors.push(...checkLayerVisibility(w.layerVisibility, Array.isArray(w.extraServices) ? w.extraServices.map(x => x?.id) : []));
  }

  // Branding
  const b = m.branding ?? {};
  for (const k of ['headerBg', 'headerText', 'accent']) if (!isHex(b[k])) errors.push(`branding.${k} must be a colour like #1C2B30.`);
  if (b.selectionOnImagery != null && b.selectionOnImagery !== '' && !isHex(b.selectionOnImagery)) errors.push('branding.selectionOnImagery must be a colour like #00E5FF (or empty for the accent colour).');
  if (b.selectionLine != null && !SELECTION_LINES.some(([v]) => v === b.selectionLine)) errors.push(`branding.selectionLine must be one of ${SELECTION_LINES.map(([v]) => v).join(', ')}.`);
  if (isHex(b.headerBg) && isHex(b.headerText) && contrastRatio(b.headerBg, b.headerText) < 4.5) {
    warnings.push(`Header text and background contrast is ${contrastRatio(b.headerBg, b.headerText).toFixed(1)}:1; aim for at least 4.5:1 so the title stays readable.`);
  }
  if (b.logo) {
    if (!/^data:image\/(png|jpeg|webp|svg\+xml);base64,/i.test(b.logo) && !/^https:\/\//i.test(b.logo)) errors.push('Logo must be an uploaded PNG, JPG, WebP or SVG, or an https:// link.');
    else if (b.logo.startsWith('data:') && b.logo.length * 0.75 > CONFIG.logoMaxBytes) errors.push(`Logo is larger than ${Math.round(CONFIG.logoMaxBytes / 1024)} KB. Use a smaller file or a link.`);
  }

  // Layout
  const lay = m.layout ?? {};
  if (!CONFIG.templates.some(([id]) => id === lay.template)) errors.push(`layout.template must be one of ${CONFIG.templates.map(([id]) => id).join(', ')}.`);
  if (!['left', 'right'].includes(lay.panelSide)) errors.push('layout.panelSide must be "left" or "right".');
  if (!['rows', 'columns'].includes(lay.fieldsAs)) errors.push('layout.fieldsAs must be "rows" or "columns".');
  if (!isResultsAt(lay.resultsAt)) errors.push('layout.resultsAt must be "panel" or "bottom".');

  // Widgets
  const wd = m.widgets;
  if (!wd || typeof wd !== 'object') errors.push('"widgets" is missing.');
  else {
    for (const id of WIDGET_IDS.filter(x => x !== 'tools')) if (typeof wd[id] !== 'boolean') errors.push(`widgets.${id} must be true or false.`);
    if (!Array.isArray(wd.tools) || wd.tools.some(t => !TOOL_IDS.includes(t))) errors.push(`widgets.tools must only contain: ${TOOL_IDS.join(', ')}.`);
    if (wd.toolConfig != null && typeof wd.toolConfig !== 'object') errors.push('widgets.toolConfig must be an object keyed by tool.');
    const isOrder = (arr, ids) => Array.isArray(arr) && arr.every(id => ids.includes(id)) && new Set(arr).size === arr.length;
    if (wd.order != null && !isOrder(wd.order, WIDGET_IDS)) errors.push(`widgets.order must list each widget at most once, from: ${WIDGET_IDS.join(', ')}.`);
    if (wd.layerReorder != null && typeof wd.layerReorder !== 'boolean') errors.push('widgets.layerReorder must be true or false.');
    if (wd.restLinks != null && (!Array.isArray(wd.restLinks) || wd.restLinks.some(k => typeof k !== 'string' || !k) || new Set(wd.restLinks).size !== wd.restLinks.length)) errors.push('widgets.restLinks must list layer keys, each once.');
    if (wd.toolOrder != null && !isOrder(wd.toolOrder, TOOL_IDS)) errors.push(`widgets.toolOrder must list each tool at most once, from: ${TOOL_IDS.join(', ')}.`);
    for (const p of cursorProblems(wd.cursors)) errors.push(`widgets.cursors: ${p}`);
    for (const p of emphasisProblems(wd.detailsEmphasis)) errors.push(`Details highlight: ${p}`);
    for (const [id, name] of [['select', 'Select features'], ['go-to-xy', 'Go to coordinates'], ['vegetation', 'Vegetation health']])
      for (const p of emphasisProblems(wd.toolConfig?.[id]?.emphasis)) errors.push(`${name} highlight: ${p}`);
    const tc = wd.toolConfig ?? {};
    const inList = (v, list) => list.some(([id]) => id === v);
    const subset = (arr, list) => Array.isArray(arr) && arr.every(v => inList(v, list));
    if (tc['measure-distance'] && !inList(tc['measure-distance'].unit, CONFIG.distanceUnits)) errors.push('Measure distance: choose a valid unit.');
    if (tc['measure-area'] && !inList(tc['measure-area'].unit, CONFIG.areaUnits)) errors.push('Measure area: choose a valid unit.');
    if (tc.select) {
      if (!subset(tc.select.shapes, CONFIG.selectShapes) || !tc.select.shapes.length) errors.push('Select features: choose at least one shape.');
      if (!Array.isArray(tc.select.layers)) errors.push('Select features: layers must be a list (empty means all).');
      else if (ctx.layerKeys) tc.select.layers.filter(k => !ctx.layerKeys.has(k)).forEach(k => warnings.push(`Select features: layer ${ctx.layerTitles?.get(k) ?? k} isn't in the web map any more.`));
    }
    if (tc.elevation && !inList(tc.elevation.unit, CONFIG.distanceUnits)) errors.push('Elevation profile: choose a valid unit.');
    if (tc.swipe) {
      if (!inList(tc.swipe.direction, CONFIG.swipeDirections)) errors.push('Swipe: choose a direction.');
      if (!Array.isArray(tc.swipe.leading) || !Array.isArray(tc.swipe.trailing)) errors.push('Swipe: leading and trailing must be lists of layers.');
      else if (wd.tools?.includes('swipe')) {
        if (!tc.swipe.leading.length || !tc.swipe.trailing.length) warnings.push('Swipe is switched on but needs at least one layer on each side.');
      }
    }
    const lo = tc['label-orientation'];
    if (lo) {
      const strings = ['streetLayer', 'streetLabelField', 'pointLayer', 'labelField', 'angleField', 'saveGroupId'];
      if (strings.some(k => typeof lo[k] !== 'string')) errors.push(`Label orientation: ${strings.join(', ')} must be text (empty = people choose in the viewer).`);
      if (!isLabelMode(lo.mode)) errors.push('Label orientation: choose a starting orientation.');
      if (typeof lo.saveGroupId === 'string' && lo.saveGroupId && !/^[0-9a-f]{32}$/i.test(lo.saveGroupId)) errors.push('Label orientation: the editors’ group must be a 32-character group id.');
      if (typeof lo.autoFlip !== 'boolean') errors.push('Label orientation: "keep upright" must be true or false.');
      if (wd.tools?.includes('label-orientation')) {
        if (lo.streetLayer && lo.streetLayer === lo.pointLayer) errors.push('Label orientation: the street layer and the house number layer must be different layers.');
        if (!lo.saveGroupId) warnings.push('Label orientation: no editors’ group is set, so nobody can save angles; turned numbers are drawn for the session only.');
        for (const [k, what] of [['streetLayer', 'street'], ['pointLayer', 'house number']]) {
          if (lo[k] && ctx.layerKeys && !ctx.layerKeys.has(lo[k])) warnings.push(`Label orientation: the ${what} layer isn't in the web map any more.`);
        }
      }
    }
    if (tc.dimensions) for (const p of dimensionsProblems(tc.dimensions)) errors.push(`Dimensions: ${p}`);
    if (tc.vegetation) for (const p of vegetationProblems(tc.vegetation)) errors.push(`Vegetation health: ${p}`);
    const aa = tc['address-audit'];
    if (aa) {
      for (const p of addressAuditProblems(aa)) errors.push(`Address audit: ${p}`);
      if (wd.tools?.includes('address-audit')) {
        if (!aa.layer) warnings.push('Address audit: choose the layer of site addresses. Until then the tool says it isn\'t set up.');
        else if (ctx.layerKeys && !ctx.layerKeys.has(aa.layer)) warnings.push(`Address audit: layer ${ctx.layerTitles?.get(aa.layer) ?? aa.layer} isn't in the web map any more.`);
      }
    }
    if (tc.sketch && (!subset(tc.sketch.shapes, CONFIG.sketchShapes) || !tc.sketch.shapes.length || !isHex(tc.sketch.color))) errors.push('Draw: choose at least one shape and a colour.');
    if (tc['go-to-xy'] && !(isNum(tc['go-to-xy'].zoom) && tc['go-to-xy'].zoom >= 0 && tc['go-to-xy'].zoom <= 23)) errors.push('Go to coordinates: zoom must be 0 to 23.');
    if (tc['basemap-gallery'] && (!subset(tc['basemap-gallery'].basemaps, CONFIG.basemaps) || !tc['basemap-gallery'].basemaps.length)) errors.push('Basemap gallery: choose at least one basemap.');
    if (tc.print) {
      if (!/^https:\/\/.+\/GPServer\/.+/i.test(tc.print.serviceUrl ?? '')) errors.push('Print: the service URL must be an https://…/GPServer/… print task.');
      if (!inList(tc.print.layout, CONFIG.printLayouts)) errors.push('Print: choose a layout.');
      if (!inList(tc.print.format, CONFIG.printFormats)) errors.push('Print: choose a format.');
    }
    if (tc.screenshot && !inList(tc.screenshot.format, CONFIG.screenshotFormats)) errors.push('Screenshot: format must be PNG or JPG.');
    if (tc.coordinates && !['dd', 'dms'].includes(tc.coordinates.format)) errors.push('Pointer coordinates: format must be decimal degrees or degrees-minutes-seconds.');
    const panelTools = (wd.tools ?? []).filter(t => !CONFIG.passiveTools.includes(t));
    const enabled = WIDGET_IDS.filter(id => (id === 'tools' ? panelTools.length : wd[id]));
    if (wd.tools?.includes('export-results') && !wd.details && !wd.search) warnings.push('Export results only applies to Details and Search, and both are off.');
    if (!enabled.length) warnings.push('No widgets are switched on. The viewer will show the map only.');
    else if (!enabled.includes(wd.open)) errors.push(`widgets.open must be one of the switched-on widgets (${enabled.join(', ')}).`);
  }

  // Bookmarks
  const bm = m.bookmarks;
  if (!bm || typeof bm !== 'object' || !Array.isArray(bm.extra)) errors.push('"bookmarks" must be { includeWebMap, extra: [] }.');
  else bm.extra.forEach((x, i) => {
    if (!x?.id || !x?.name?.trim?.()) errors.push(`Bookmark ${i + 1}: needs an id and a name.`);
    if (!isLonLat(x?.center) || !isNum(x?.zoom)) errors.push(`Bookmark ${i + 1}: needs a [longitude, latitude] centre and a zoom.`);
  });

  // Search
  if (!m.search || typeof m.search !== 'object' || !Array.isArray(m.search.sources)) errors.push('"search" must be { boxSources: [], boxPrimary, allPlaceholder, sources: [] }.');
  else {
    m.search.sources.forEach((s, i) => {
      if (!s?.layerKey) errors.push(`Search source ${i + 1}: choose a layer.`);
      else if (ctx.layerKeys && !ctx.layerKeys.has(s.layerKey)) warnings.push(`Search source ${i + 1}: that layer isn't in the web map any more.`);
      if (!Array.isArray(s?.fields) || !s.fields.length) errors.push(`Search source ${i + 1}: pick at least one field to search.`);
      if (!Array.isArray(s?.operators) || !s.operators.length || s.operators.some(o => !OPERATOR_IDS.includes(o))) errors.push(`Search source ${i + 1}: operators must be some of ${OPERATOR_IDS.join(', ')}.`);
      else if (!s.operators.includes(s.defaultOperator)) errors.push(`Search source ${i + 1}: the default operator must be one of the allowed operators.`);
      if (s?.resultFields != null && (!Array.isArray(s.resultFields) || s.resultFields.some(f => !f?.name))) errors.push(`Search source ${i + 1}: each result column needs a field name.`);
      for (const p of emphasisProblems(s?.emphasis)) errors.push(`Search source ${i + 1}: ${p}`);
    });
    const box = boxSourceProblems(m.search.boxSources ?? [], ctx, m.search.boxPrimary ?? '');
    errors.push(...box.errors);
    warnings.push(...box.warnings);
    if (m.search.allPlaceholder != null && typeof m.search.allPlaceholder !== 'string') errors.push('search.allPlaceholder must be text.');
    if (wd?.search && !m.search.boxSources?.length && !m.search.sources.length) warnings.push('Search is switched on but has no layers and no search box sources.');
  }

  // Add data
  const ad = m.addData;
  if (ad != null) {
    if (typeof ad !== 'object' || !Array.isArray(ad.collections)) errors.push('"addData" must be { collections: [], portalSearch, url, file }.');
    else {
      if (!CONFIG.addDataPortalSearch.some(([v]) => v === ad.portalSearch)) errors.push(`addData.portalSearch must be one of ${CONFIG.addDataPortalSearch.map(([v]) => v).join(', ')}.`);
      for (const k of ['url', 'file']) if (typeof ad[k] !== 'boolean') errors.push(`addData.${k} must be true or false.`);
      const seen = new Set();
      ad.collections.forEach((c, i) => {
        const cn = `Add data, collection ${i + 1}${c?.title ? ` (${c.title})` : ''}`;
        if (!c?.id || !c?.title?.trim?.()) errors.push(`${cn}: needs a name.`);
        else if (seen.has(c.title.trim().toLowerCase())) errors.push(`${cn}: another collection has the same name.`);
        else seen.add(c.title.trim().toLowerCase());
        if (!Array.isArray(c?.groupIds) || c.groupIds.some(g => !/^[0-9a-f]{32}$/i.test(g))) errors.push(`${cn}: each group must be a 32-character group id.`);
        else if (!c.groupIds.length) errors.push(`${cn}: add at least one group.`);
        else if (new Set(c.groupIds.map(g => g.toLowerCase())).size !== c.groupIds.length) warnings.push(`${cn}: the same group is listed twice.`);
      });
      const offers = ad.collections.length || ad.portalSearch !== 'off' || ad.url || ad.file;
      if (wd?.addData && !offers) errors.push('Add data is switched on but offers nothing: add a curated collection or switch on a source.');
    }
  }

  // Editing
  const ed = m.editing;
  if (ed != null) {
    if (typeof ed !== 'object' || !Array.isArray(ed.layers)) errors.push('"editing" must be { template, width, side, maxRecords, layers: [] }.');
    else {
      if (!isEditTemplate(ed.template)) errors.push('Editing: choose one of the form templates.');
      for (const p of emphasisProblems(ed.emphasis)) errors.push(`Editing highlight: ${p}`);
      if (!isEditWidth(ed.width)) errors.push('Editing: the window opens at half or full width.');
      if (!isWindowSide(ed.side)) errors.push('Editing: the half-width window opens on the left or the right.');
      if (!(Number.isInteger(ed.maxRecords) && ed.maxRecords >= 1 && ed.maxRecords <= EDIT_MAX_RECORDS)) errors.push(`Editing: records listed at once must be 1 to ${EDIT_MAX_RECORDS}.`);
      const fieldOk = f => /^[A-Za-z_][\w.]*$/.test(f || '');
      const seen = new Set();
      ed.layers.forEach((l, i) => {
        const ln = `Editing, layer ${i + 1}${l?.layerKey ? ` (${ctx.layerTitles?.get(l.layerKey) ?? l.title ?? l.layerKey})` : ''}`;
        if (!l?.id || typeof l.layerKey !== 'string' || !l.layerKey) { errors.push(`${ln}: choose a layer.`); return; }
        if (seen.has(l.layerKey)) errors.push(`${ln}: the layer is listed twice.`);
        seen.add(l.layerKey);
        if (ctx.layerKeys && !ctx.layerKeys.has(l.layerKey)) warnings.push(`${ln}: that layer isn't in the web map any more.`);
        else if (ctx.layerUrls?.has(l.layerKey) && !isFeatureServiceLayerUrl(ctx.layerUrls.get(l.layerKey))) errors.push(`${ln}: only feature service layers (…/FeatureServer/n) can be edited.`);
        for (const k of ['allowUpdate', 'allowAdd', 'allowDelete']) if (typeof l[k] !== 'boolean') errors.push(`${ln}: ${k} must be true or false.`);
        if (!l.allowUpdate && !l.allowAdd && !l.allowDelete) errors.push(`${ln}: let people update, add or delete records (or remove the layer).`);
        if (l.title != null && typeof l.title !== 'string') errors.push(`${ln}: title must be text.`);
        if (l.titleField && !fieldOk(l.titleField)) errors.push(`${ln}: the record title field name isn't valid.`);
        if (!Array.isArray(l.listFields) || l.listFields.some(f => !fieldOk(f))) errors.push(`${ln}: listFields must be a list of field names.`);
        else if (l.listFields.length > LIST_FIELDS_MAX) errors.push(`${ln}: show at most ${LIST_FIELDS_MAX} values with each record.`);
        if (!Array.isArray(l.fields) || l.fields.some(f => !fieldOk(f?.name))) errors.push(`${ln}: each form field needs a valid field name.`);
        else {
          const names = l.fields.map(f => f.name.toLowerCase());
          if (new Set(names).size !== names.length) errors.push(`${ln}: a field is in the form twice.`);
          // Smart forms: groups, hints and rules.
          const groups = Array.isArray(l.groups) ? l.groups : [];
          if (l.groups != null && !Array.isArray(l.groups)) errors.push(`${ln}: groups must be a list.`);
          const groupIds = new Set();
          groups.forEach((g, k) => {
            const gn = `${ln}, group ${g?.label || k + 1}`;
            if (!g?.id || typeof g.id !== 'string') { errors.push(`${gn}: needs an id.`); return; }
            if (groupIds.has(g.id)) errors.push(`${gn}: the id ${g.id} is used twice.`);
            groupIds.add(g.id);
            if (typeof g.label !== 'string' || !g.label.trim()) errors.push(`${gn}: give the group a name.`);
            else if (g.label.length > GROUP_LABEL_MAX) errors.push(`${gn}: the name is longer than ${GROUP_LABEL_MAX} characters.`);
            if (g.collapsed != null && typeof g.collapsed !== 'boolean') errors.push(`${gn}: collapsed must be true or false.`);
            if (g.visibleWhen != null) {
              const p = ruleProblem(g.visibleWhen);
              if (p) errors.push(`${gn}: the "show only when" rule ${p}.`);
              else if (l.fields.some(f => f.group === g.id && f.name.toLowerCase() === g.visibleWhen.field.toLowerCase())) warnings.push(`${gn}: it is shown only by a field inside it, so once hidden it can't come back.`);
            }
            if (!l.fields.some(f => f.group === g.id)) warnings.push(`${gn}: has no fields, so it doesn't show.`);
          });
          l.fields.forEach(f => {
            for (const k of ['editable', 'required']) if (f[k] != null && typeof f[k] !== 'boolean') errors.push(`${ln}, field ${f.name}: ${k} must be true or false.`);
            if (f.label != null && typeof f.label !== 'string') errors.push(`${ln}, field ${f.name}: the label must be text.`);
            if (f.hint != null && typeof f.hint !== 'string') errors.push(`${ln}, field ${f.name}: the hint must be text.`);
            else if (f.hint?.length > HINT_MAX) errors.push(`${ln}, field ${f.name}: the hint is longer than ${HINT_MAX} characters.`);
            if (f.group != null && f.group !== '' && !groupIds.has(f.group)) errors.push(`${ln}, field ${f.name}: the group ${f.group} isn't in the layer's groups.`);
            for (const [k, what] of [['visibleWhen', 'show only when'], ['requiredWhen', 'required when'], ['editableWhen', 'editable when']]) {
              if (f[k] == null) continue;
              const p = ruleProblem(f[k]);
              if (p) errors.push(`${ln}, field ${f.name}: the "${what}" rule ${p}.`);
              else if (f[k].field.toLowerCase() === f.name.toLowerCase()) errors.push(`${ln}, field ${f.name}: the "${what}" rule can't depend on the field itself.`);
            }
          });
          if (l.fields.length && l.allowUpdate && !l.fields.some(f => f.editable !== false)) warnings.push(`${ln}: no field in the form can be edited, so there's nothing to update.`);
        }
      });
      if (wd?.editing && !ed.layers.length) warnings.push('Editing is switched on but no layers are set up for editing yet.');
    }
  }

  // Scene
  const sc = m.scene;
  if (sc != null) {
    if (typeof sc !== 'object' || !Array.isArray(sc.layers)) errors.push('"scene" must be { width, side, layers: [] }.');
    else {
      if (!isSceneWidth(sc.width)) errors.push('Scene: it opens at half or full width.');
      if (!isWindowSide(sc.side)) errors.push('Scene: at half width it opens on the left or the right.');
      const fieldOk = f => /^[A-Za-z_][\w.]*$/.test(f || '');
      const isMetres = v => isNum(v) && v >= 0 && v <= SCENE_MAX_HEIGHT_M;
      const seen = new Set();
      sc.layers.forEach((l, i) => {
        const ln = `Scene, layer ${i + 1}${l?.layerKey ? ` (${ctx.layerTitles?.get(l.layerKey) ?? (l.title || l.layerKey)})` : ''}`;
        if (!l?.id || typeof l.layerKey !== 'string' || !l.layerKey) { errors.push(`${ln}: choose a layer.`); return; }
        if (seen.has(l.layerKey)) errors.push(`${ln}: the layer is listed twice.`);
        seen.add(l.layerKey);
        if (ctx.layerKeys && !ctx.layerKeys.has(l.layerKey)) warnings.push(`${ln}: that layer isn't in the web map any more.`);
        if (l.title != null && typeof l.title !== 'string') errors.push(`${ln}: title must be text.`);
        if (!isHeightMode(l.heightMode)) errors.push(`${ln}: the height comes from a field, is random, or is none (flat).`);
        else if (l.heightMode === 'field' && !fieldOk(l.heightField)) errors.push(`${ln}: choose the field the height comes from.`);
        else if (l.heightMode === 'random') {
          if (!isMetres(l.minHeight) || !isMetres(l.maxHeight)) errors.push(`${ln}: the random heights must be 0 to ${SCENE_MAX_HEIGHT_M} metres.`);
          else if (l.minHeight > l.maxHeight) errors.push(`${ln}: the lowest random height is more than the highest.`);
        }
        if (l.color != null && l.color !== '' && !isHex(l.color)) errors.push(`${ln}: colour must look like #2B6F7F (or be empty for the accent colour).`);
        if (!isPointShape(l.pointShape)) errors.push(`${ln}: points are drawn as a cylinder or a cone.`);
        if (!(isNum(l.thickness) && l.thickness >= THICKNESS_MIN_M && l.thickness <= THICKNESS_MAX_M)) errors.push(`${ln}: the thickness must be ${THICKNESS_MIN_M} to ${THICKNESS_MAX_M} metres.`);
        if (!(Number.isInteger(l.minScale) && l.minScale >= 0)) errors.push(`${ln}: the zoom-in limit must be a whole scale number (0 = always draw).`);
      });
      if (wd?.scene && !sc.layers.length) warnings.push('Scene is switched on but has no layers yet.');
    }
  }

  // Streaming: Cameras, Drones and Tracking
  if ('cameras' in m || 'drones' in m) errors.push('"cameras" and "drones" are now sections of "streaming". Open the manifest in the Orchestrator (or run upgrade()) to move them.');
  const sg = m.streaming;
  if (sg != null) {
    if (typeof sg !== 'object') errors.push('"streaming" must be { width, side, cameras, drones, tracking }.');
    else {
      if (!isStreamWidth(sg.width)) errors.push('Streaming: the window opens at half or full width.');
      if (!isWindowSide(sg.side)) errors.push('Streaming: at half width the window opens on the left or the right.');
      for (const id of STREAMING_SECTION_IDS) checkStreamingSection(id, sg[id]);
      if (wd?.streaming && STREAMING_SECTION_IDS.every(id => sg[id]?.on !== true)) warnings.push('Streaming is switched on but Cameras, Drones and Tracking are all off.');
    }
  }

  function checkStreamingSection(id, sv) {
    const words = STREAMING_SECTIONS[id];
    const W = `Streaming, ${words.title}`;
    const shape = { cameras: '{ on, groupId, streams: [] }', drones: '{ on, groupId, demo }', tracking: '{ on, groupId, feeds: [] }' }[id];
    if (!sv || typeof sv !== 'object') { errors.push(`"streaming.${id}" must be ${shape}.`); return; }
    if (typeof sv.on !== 'boolean') errors.push(`${W}: "on" must be true or false.`);
    if (typeof sv.groupId !== 'string' || (sv.groupId && !/^[0-9a-f]{32}$/i.test(sv.groupId))) errors.push(`${W}: the group must be a 32-character group id (or empty for everyone).`);
    const showing = wd?.streaming === true && sv.on === true;
    if (id === 'drones') {
      if (sv.streams != null) errors.push(`${W}: stream addresses aren't stored in the manifest. People paste a live stream's address in the viewer; remove "streams".`);
      if (typeof sv.demo !== 'boolean') errors.push(`${W}: "demo" (offer the demo streams) must be true or false.`);
    }
    if (id === 'cameras') {
      if (!Array.isArray(sv.streams)) { errors.push(`"streaming.cameras" must be ${shape}.`); return; }
      if (sv.streams.length > STREAMS_MAX) errors.push(`${W}: at most ${STREAMS_MAX} streams.`);
      const ids = new Set(), urls = new Set();
      sv.streams.forEach((st, i) => {
        const sn = `${W}, stream ${i + 1}${st?.title ? ` (${st.title})` : ''}`;
        if (!st?.id || typeof st.id !== 'string') errors.push(`${sn}: needs an id.`);
        else if (ids.has(st.id)) errors.push(`${sn}: another stream has the same id.`);
        else ids.add(st.id);
        if (!st?.title?.trim?.()) errors.push(`${sn}: give it a name.`);
        if (!isStreamKind(st?.kind)) errors.push(`${sn}: choose how the stream is played.`);
        const problem = streamUrlProblem(st?.url, st?.kind, CONFIG.streamEmbedHosts);
        if (problem && !(problem.startsWith('Choose') && !isStreamKind(st?.kind))) errors.push(`${sn}: ${problem}`);
        else if (st.url && urls.has(st.url.trim())) warnings.push(`${sn}: the same address is listed twice.`);
        if (st?.url) urls.add(st.url.trim());
        if (!(Number.isInteger(st?.refreshSeconds) && st.refreshSeconds >= REFRESH_MIN_S && st.refreshSeconds <= REFRESH_MAX_S)) errors.push(`${sn}: snapshots reload every ${REFRESH_MIN_S} to ${REFRESH_MAX_S} seconds.`);
        if (st?.location != null && !isLonLat(st.location)) errors.push(`${sn}: the location must be [longitude, latitude], or empty.`);
        for (const k of ['description', 'credit']) if (st?.[k] != null && typeof st[k] !== 'string') errors.push(`${sn}: ${k} must be text.`);
      });
      if (showing && !sv.streams.length) warnings.push(`${W} is on but has no cameras yet.`);
    }
    if (id === 'tracking') {
      if (!Array.isArray(sv.feeds)) { errors.push(`"streaming.tracking" must be ${shape}.`); return; }
      if (sv.feeds.length > FEEDS_MAX) errors.push(`${W}: at most ${FEEDS_MAX} feeds.`);
      const ids = new Set(), urls = new Set();
      sv.feeds.forEach((f, i) => {
        const fn = `${W}, feed ${i + 1}${f?.title ? ` (${f.title})` : ''}`;
        if (!f?.id || typeof f.id !== 'string') errors.push(`${fn}: needs an id.`);
        else if (ids.has(f.id)) errors.push(`${fn}: another feed has the same id.`);
        else ids.add(f.id);
        if (!f?.title?.trim?.()) errors.push(`${fn}: give it a name.`);
        const problem = trackUrlProblem(f?.url, f?.kind);
        if (problem) errors.push(`${fn}: ${problem}`);
        else if (urls.has(f.url.trim())) warnings.push(`${fn}: the same address is listed twice.`);
        if (typeof f?.url === 'string') urls.add(f.url.trim());
        if (!(Number.isInteger(f?.refreshSeconds) && f.refreshSeconds >= TRACK_REFRESH_MIN_S && f.refreshSeconds <= TRACK_REFRESH_MAX_S)) errors.push(`${fn}: it's read again every ${TRACK_REFRESH_MIN_S} to ${TRACK_REFRESH_MAX_S} seconds.`);
        for (const k of ['itemsPath', 'idField', 'labelField']) if (typeof f?.[k] !== 'string' || (f[k] && !isPath(f[k]))) errors.push(`${fn}: ${k} must be a field name or a dotted path such as attributes.name (or empty).`);
        if (f?.kind === 'json') {
          for (const [k, what] of [['latField', 'latitude'], ['lonField', 'longitude']]) if (!isPath(f[k])) errors.push(`${fn}: say where each object's ${what} is (a field name or a dotted path such as attributes.${what}).`);
        } else for (const k of ['latField', 'lonField']) if (f?.[k] != null && typeof f[k] !== 'string') errors.push(`${fn}: ${k} must be text.`);
        if (!(Number.isInteger(f?.trail) && f.trail >= 0 && f.trail <= TRAIL_MAX)) errors.push(`${fn}: the trail keeps 0 to ${TRAIL_MAX} earlier positions.`);
        if (f?.color != null && f.color !== '' && !isHex(f.color)) errors.push(`${fn}: colour must look like #D9480F (or be empty for the next colour in turn).`);
        if (typeof f?.visible !== 'boolean') errors.push(`${fn}: "visible" (on the map when Tracking opens) must be true or false.`);
        for (const k of ['description', 'credit']) if (f?.[k] != null && typeof f[k] !== 'string') errors.push(`${fn}: ${k} must be text.`);
        if (showing && isPolled(f?.kind) && f.refreshSeconds < 5) warnings.push(`${fn}: every viewer with this feed on asks it for positions every ${f.refreshSeconds} s. Check the feed allows that many requests.`);
      });
      if (showing && !sv.feeds.length) warnings.push(`${W} is on but has no feeds yet.`);
    }
    if (showing) {
      const verb = id === 'tracking' ? 'see the feeds' : id === 'drones' ? 'use it' : 'watch';
      if (!sv.groupId) warnings.push(`${W}: no group is set, so anyone who can open the viewer can ${verb}.`);
      else if (id !== 'drones') warnings.push(`${W}: the group hides the ${words.items} from non-members, but their addresses are in manifest.json. Protect sensitive ${words.items} on their server too.`);
    }
  }

  // External pages
  const xp = m.externalPages;
  if (xp != null) {
    if (typeof xp !== 'object' || !Array.isArray(xp.pages)) errors.push('"externalPages" must be { width, side, pages: [] }.');
    else {
      if (!isPageWidth(xp.width)) errors.push('External pages: the window opens at half or full width.');
      if (!isWindowSide(xp.side)) errors.push('External pages: at half width the window opens on the left or the right.');
      if (xp.pages.length > PAGES_MAX) errors.push(`External pages: at most ${PAGES_MAX} pages.`);
      const ids = new Set(), urls = new Set();
      xp.pages.forEach((p, i) => {
        const pn = `External pages, page ${i + 1}${p?.title ? ` (${p.title})` : ''}`;
        if (!p?.id || typeof p.id !== 'string') errors.push(`${pn}: needs an id.`);
        else if (ids.has(p.id)) errors.push(`${pn}: another page has the same id.`);
        else ids.add(p.id);
        if (!p?.title?.trim?.()) errors.push(`${pn}: give it a name.`);
        if (typeof p?.followMap !== 'boolean') errors.push(`${pn}: followMap (open it at the map's position) must be true or false.`);
        const problem = pageUrlProblem(p?.url, p?.followMap === true);
        if (problem) errors.push(`${pn}: ${problem}`);
        else if (urls.has(p.url.trim())) warnings.push(`${pn}: the same address is listed twice.`);
        if (typeof p?.url === 'string') urls.add(p.url.trim());
        if (p?.description != null && typeof p.description !== 'string') errors.push(`${pn}: description must be text.`);
      });
      if (wd?.externalPages && !xp.pages.length) warnings.push('External pages is switched on but has no pages yet.');
    }
  }

  // Downloads
  const dl = m.downloads;
  if (dl != null) {
    if (typeof dl !== 'object' || !Array.isArray(dl.pages)) errors.push('"downloads" must be { width, side, pages: [] }.');
    else {
      if (!isDownloadWidth(dl.width)) errors.push('Downloads: the window opens at half or full width.');
      if (!isWindowSide(dl.side)) errors.push('Downloads: at half width the window opens on the left or the right.');
      if (dl.pages.length > DOWNLOAD_PAGES_MAX) errors.push(`Downloads: at most ${DOWNLOAD_PAGES_MAX} pages.`);
      const ids = new Set();
      dl.pages.forEach((p, i) => {
        const pn = `Downloads, page ${i + 1}${p?.title ? ` (${p.title})` : ''}`;
        if (!p?.id || typeof p.id !== 'string') errors.push(`${pn}: needs an id.`);
        else if (ids.has(p.id)) errors.push(`${pn}: another page has the same id.`);
        else ids.add(p.id);
        if (!p?.title?.trim?.()) errors.push(`${pn}: give it a name.`);
        if (p?.description != null && typeof p.description !== 'string') errors.push(`${pn}: description must be text.`);
        const src = p?.source;
        if (!src || typeof src !== 'object') { errors.push(`${pn}: choose where its list comes from.`); return; }
        if (!isSourceKind(src.kind)) { errors.push(`${pn}: choose where its list comes from.`); return; }
        if (src.countLabel != null && typeof src.countLabel !== 'string') errors.push(`${pn}: the count column's heading must be text.`);
        const problem = sourceProblem(src);
        if (problem) errors.push(`${pn}: ${problem}`);
        else if (src.kind === 'jsonApi') warnings.push(`${pn}: the API must allow CORS from the viewer's site, or the list stays empty.`);
      });
      if (wd?.downloads && !dl.pages.length) warnings.push('Downloads is switched on but has no pages yet.');
    }
  }

  // Attribute trace
  const tr = m.trace;
  if (tr != null) {
    if (typeof tr !== 'object' || !Array.isArray(tr.traces)) errors.push('"trace" must be { width, side, allowUserTraces, limits, traces: [] }.');
    else {
      if (!isTraceWidth(tr.width)) errors.push('Attribute trace: the window opens at half or full width, or docked at the bottom.');
      if (!isWindowSide(tr.side)) errors.push('Attribute trace: at half width the window opens on the left or the right.');
      if (tr.allowUserTraces != null && typeof tr.allowUserTraces !== 'boolean') errors.push('Attribute trace: allowUserTraces must be true or false.');
      if (tr.limits != null && (typeof tr.limits !== 'object' || Array.isArray(tr.limits))) errors.push('Attribute trace: limits must be an object.');
      else for (const p of limitProblems(tr.limits)) errors.push(`Attribute trace limits: ${p}`);
      for (const p of emphasisProblems(tr.emphasis)) errors.push(`Attribute trace: ${p}`);
      if (tr.traces.length > TRACES_MAX) errors.push(`Attribute trace: at most ${TRACES_MAX} traces.`);
      const ids = new Set();
      tr.traces.forEach((t, i) => {
        const tn = `Attribute trace ${i + 1}${t?.title ? ` (${t.title})` : ''}`;
        if (!t || typeof t !== 'object') { errors.push(`${tn}: must be an object.`); return; }
        const before = errors.length;
        if (!t.id || typeof t.id !== 'string') errors.push(`${tn}: needs an id.`);
        else if (ids.has(t.id)) errors.push(`${tn}: another trace has the same id.`);
        else ids.add(t.id);
        for (const k of ['description', 'resultLabel']) if (t[k] != null && typeof t[k] !== 'string') errors.push(`${tn}: ${k} must be text.`);
        if (t.confirmsImpact != null && typeof t.confirmsImpact !== 'boolean') errors.push(`${tn}: confirmsImpact must be true or false.`);
        if (!Array.isArray(t.steps)) { errors.push(`${tn}: steps must be a list.`); return; }
        if (t.steps.some(s => !s || typeof s !== 'object')) { errors.push(`${tn}: every step must be an object.`); return; }
        if (t.finalFields != null && (!Array.isArray(t.finalFields) || t.finalFields.some(f => typeof f?.name !== 'string' || !f.name))) errors.push(`${tn}: finalFields must be [{ name, label }].`);
        for (const s of t.steps) if (s.filters != null && !Array.isArray(s.filters)) errors.push(`${tn}: a step's filters must be a list.`);
        if (errors.length > before) return;
        for (const p of checkTrace(t, { limits: tr.limits }).errors) errors.push(`${tn}: ${p}`);
        if (ctx.layerKeys) {
          for (const key of new Set([t.startLayer, ...t.steps.map(s => s.targetLayer)].filter(Boolean))) {
            if (!ctx.layerKeys.has(key)) warnings.push(`${tn}: the layer ${key} isn't in the web map any more.`);
          }
        }
      });
      if (wd?.trace && !tr.traces.length && !tr.allowUserTraces) warnings.push('Attribute trace is switched on but has no traces yet, and viewer users may not make their own.');
    }
  }

  // Dashboards
  const DW_TYPES = CONFIG.dashboardWidgetTypes.map(([id]) => id);
  const STATS = CONFIG.dashboardStatistics.map(([id]) => id);
  const fieldOk = f => /^[A-Za-z_][\w.]*$/.test(f || '');
  if (m.dashboards != null && !Array.isArray(m.dashboards)) errors.push('"dashboards" must be a list.');
  else {
    (m.dashboards ?? []).forEach((d, di) => {
      const dn = `Dashboard ${di + 1}${d?.title ? ` (${d.title})` : ''}`;
      if (!d?.id || !d?.title?.trim?.()) errors.push(`${dn}: needs a title.`);
      if (!Array.isArray(d?.widgets)) { errors.push(`${dn}: "widgets" must be a list.`); return; }
      if (!d.widgets.length) warnings.push(`${dn} has no charts, tables or indicators yet.`);
      d.widgets.forEach((w, wi) => {
        const wn = `${dn}, item ${wi + 1}${w?.title ? ` (${w.title})` : ''}`;
        if (!DW_TYPES.includes(w?.type)) errors.push(`${wn}: type must be one of ${DW_TYPES.join(', ')}.`);
        if (!w?.layerKey) errors.push(`${wn}: choose a layer.`);
        else if (ctx.layerKeys && !ctx.layerKeys.has(w.layerKey)) warnings.push(`${wn}: that layer isn't in the web map any more.`);
        if (w?.cols != null && !(Number.isInteger(w.cols) && w.cols >= 1 && w.cols <= GRID_COLUMNS)) errors.push(`${wn}: width must be 1 to ${GRID_COLUMNS} columns.`);
        if (w?.rows != null && !(Number.isInteger(w.rows) && w.rows >= 1 && w.rows <= MAX_ROWS)) errors.push(`${wn}: height must be 1 to ${MAX_ROWS} rows.`);
        if (w?.type === 'records') {
          // A features table lists features; it has no statistic or grouping.
          if (!Array.isArray(w.columns) || !w.columns.length) errors.push(`${wn}: choose the fields the table shows.`);
          else if (!w.columns.every(fieldOk)) errors.push(`${wn}: a column's field name isn't valid.`);
          else if (new Set(w.columns).size !== w.columns.length) errors.push(`${wn}: a field is in the table twice.`);
          if (w.orderField && !fieldOk(w.orderField)) errors.push(`${wn}: the order field name isn't valid.`);
          if (w.orderDirection && !['asc', 'desc'].includes(w.orderDirection)) errors.push(`${wn}: the order must be asc or desc.`);
        } else {
          if (!STATS.includes(w?.statistic)) errors.push(`${wn}: choose a statistic.`);
          if (w?.statistic && w.statistic !== 'count' && !fieldOk(w.valueField)) errors.push(`${wn}: "${w.statistic}" needs a number field to calculate.`);
          if (w?.valueField && !fieldOk(w.valueField)) errors.push(`${wn}: the value field name isn't valid.`);
          if (w?.type && w.type !== 'indicator' && !fieldOk(w.categoryField)) errors.push(`${wn}: choose the field to group by.`);
        }
        if (w?.topN != null && !(Number.isInteger(w.topN) && w.topN >= 1 && w.topN <= 100)) errors.push(`${wn}: "show at most" must be 1 to 100.`);
        if (w?.where && /;|--|\/\*/.test(w.where)) errors.push(`${wn}: the filter can't contain ; -- or /*.`);
        if (w?.color && !isHex(w.color)) errors.push(`${wn}: colour must look like #2B6F7F (or be empty for the accent colour).`);
        if (w?.outlineColor && !isHex(w.outlineColor)) errors.push(`${wn}: outline colour must look like #FFFFFF (or be empty).`);
        if (w?.opacity != null && !(typeof w.opacity === 'number' && w.opacity >= 0 && w.opacity <= 1)) errors.push(`${wn}: transparency must be between 0% and 100%.`);
        if (w?.outlineWidth != null && !(Number.isInteger(w.outlineWidth) && w.outlineWidth >= 0 && w.outlineWidth <= 6)) errors.push(`${wn}: outline width must be 0 to 6.`);
        if (w?.legend && !CONFIG.dashboardLegend.some(([v]) => v === w.legend)) errors.push(`${wn}: legend position isn't valid.`);
        if (w?.colorMode && !CONFIG.dashboardColorModes.some(([v]) => v === w.colorMode)) errors.push(`${wn}: colour mode isn't valid.`);
        if (w?.cutout != null && !(Number.isInteger(w.cutout) && w.cutout >= 0 && w.cutout <= 90)) errors.push(`${wn}: doughnut hole must be 0 to 90%.`);
        if (w?.labelMaxLength != null && !(Number.isInteger(w.labelMaxLength) && w.labelMaxLength >= 4 && w.labelMaxLength <= 80)) errors.push(`${wn}: label length must be 4 to 80 characters.`);
      });
    });
    if (wd?.dashboards && !(m.dashboards ?? []).length) warnings.push('Dashboards is switched on but there are no dashboards yet.');
  }

  // Details
  if (m.details == null || typeof m.details !== 'object' || Array.isArray(m.details)) errors.push('"details" must be an object keyed by layer.');
  else for (const [key, raw] of Object.entries(m.details)) {
    const cfg = raw ?? {};
    const where = `Details for ${ctx.layerTitles?.get(key) ?? `layer ${key}`}`;
    if (ctx.layerKeys && !ctx.layerKeys.has(key)) warnings.push(`${where}: that layer isn't in the web map any more.`);
    if (cfg.title != null && typeof cfg.title !== 'string') errors.push(`${where}: title must be text.`);
    if (cfg.ignoreScale != null && typeof cfg.ignoreScale !== 'boolean') errors.push(`${where}: ignoreScale must be true or false.`);
    if (cfg.expand != null && typeof cfg.expand !== 'boolean') errors.push(`${where}: expand must be true or false.`);
    if (cfg.hideFields != null && (!Array.isArray(cfg.hideFields) || cfg.hideFields.some(f => typeof f !== 'string'))) errors.push(`${where}: hideFields must be a list of field names.`);
    (cfg.sections ?? []).forEach((s, i) => {
      const name = `${where}, section ${i + 1}${s?.title ? ` (${s.title})` : ''}`;
      if (!s?.id || !s?.title?.trim?.()) errors.push(`${name}: needs a title.`);
      if (!SECTION_TYPES[s?.type]) errors.push(`${name}: type must be ${Object.keys(SECTION_TYPES).join(' or ')}.`);
      if (!SECTION_RENDERS[s?.render]) errors.push(`${name}: show it as a table or a field list.`);
      if (s?.fields != null && (!Array.isArray(s.fields) || s.fields.some(f => !f?.name))) errors.push(`${name}: each column needs a field name.`);
      if (s?.type === 'related-table') {
        if (!/^https?:\/\/.+\/rest\/services\/.+\/(MapServer|FeatureServer)\/\d+\/?$/i.test(s.url ?? '')) errors.push(`${name}: table URL must end in /MapServer/n or /FeatureServer/n.`);
        else if (!isAllowedHost(s.url)) errors.push(`${name}: ${new URL(s.url).hostname} isn't on the allowed hosts list (config.js).`);
        const mode = s.matchMode ?? (s.match?.length ? 'fields' : 'where');
        if (mode === 'fields') {
          if (!Array.isArray(s.match) || !s.match.length || s.match.some(p => !p?.tableField || !p?.layerField)) errors.push(`${name}: choose the matching columns (a table column and a layer field for each pair).`);
          else if (s.match.some(p => !/^[A-Za-z_][\w.]*$/.test(p.tableField))) errors.push(`${name}: a table column name isn't valid.`);
        } else if (!s.where?.includes('{')) {
          errors.push(`${name}: the where clause must use at least one {FIELD} from the clicked feature, e.g. PRCL_KEY = '{PRCL_KEY}'.`);
        }
      }
      if (s?.type === 'api') {
        if (!isHttpUrl(s.url)) errors.push(`${name}: API URL must start with https://`);
        else if (!isAllowedHost(s.url)) errors.push(`${name}: that host isn't on the allowed hosts list (config.js).`);
        if (!s.url?.includes('{')) warnings.push(`${name}: the API URL doesn't use any {FIELD}, so every feature gets the same answer.`);
      }
      if (s?.type === 'spatial') {
        if (!isSpatialRelation(s.relation)) errors.push(`${name}: choose a spatial relationship.`);
        if (s.relation === 'within-distance' && !(isNum(s.distance) && s.distance > 0 && s.distance <= SPATIAL_MAX_DISTANCE_M)) errors.push(`${name}: the distance must be between 1 and ${SPATIAL_MAX_DISTANCE_M} metres.`);
        if (s.windowSize != null && !isSpatialWindowSize(s.windowSize)) errors.push(`${name}: the window opens as a movable window, half the map, the whole map or docked at the bottom.`);
        if (s.windowSide != null && !isWindowSide(s.windowSide)) errors.push(`${name}: the half-map window opens on the left or the right.`);
        if (s.max != null && !(Number.isInteger(s.max) && s.max >= 1 && s.max <= CONFIG.spatialMaxRows)) errors.push(`${name}: most rows must be 1 to ${CONFIG.spatialMaxRows}.`);
        for (const p of emphasisProblems(s.emphasis)) errors.push(`${name}: ${p}`);
        if (!Array.isArray(s.targets)) errors.push(`${name}: targets must be a list of layers.`);
        else if (!s.targets.length) warnings.push(`${name}: choose at least one layer to search. Until then the card doesn't show it.`);
        else s.targets.forEach((t, j) => {
          if (typeof t?.layerKey !== 'string' || !t.layerKey) errors.push(`${name}, layer ${j + 1}: needs a layer.`);
          else if (ctx.layerKeys && !ctx.layerKeys.has(t.layerKey)) warnings.push(`${name}: layer ${ctx.layerTitles?.get(t.layerKey) ?? t.layerKey} isn't in the web map any more.`);
          if (t?.fields != null && (!Array.isArray(t.fields) || t.fields.some(f => !f?.name))) errors.push(`${name}, layer ${j + 1}: each column needs a field name.`);
        });
      }
    });
    (cfg.actions ?? []).forEach((a, i) => {
      if (!a?.label?.trim?.()) errors.push(`${where}, link ${i + 1}: needs a label.`);
      if (!isHttpUrl(a?.url)) errors.push(`${where}, link ${i + 1}: URL must start with http:// or https://`);
    });
  }

  // Layer information
  const li = m.layerInfo;
  if (li == null || typeof li !== 'object' || Array.isArray(li) || li.layers == null || typeof li.layers !== 'object' || Array.isArray(li.layers)) {
    errors.push('"layerInfo" must be { layers: {} } keyed by layer.');
  } else {
    if (li.showAddress != null && typeof li.showAddress !== 'boolean') errors.push('Layer information: "showAddress" must be true or false.');
    for (const [key, info] of Object.entries(li.layers)) {
      const where = `Layer information for ${ctx.layerTitles?.get(key) ?? `layer ${key}`}`;
      if (ctx.layerKeys && !ctx.layerKeys.has(key)) warnings.push(`${where}: that layer isn't in the web map any more.`);
      for (const p of infoProblems(info)) errors.push(`${where}: ${p}`);
    }
    if (wd?.layerInfo && !Object.values(li.layers).some(hasInfo)) warnings.push('Layer information is switched on but no layer has any information yet.');
  }

  // Legend labels
  const ll = m.legendLabels;
  if (ll == null || typeof ll !== 'object' || Array.isArray(ll) || ll.layers == null || typeof ll.layers !== 'object' || Array.isArray(ll.layers)) {
    errors.push('"legendLabels" must be { layers: {} } keyed by layer.');
  } else {
    for (const [key, cfg] of Object.entries(ll.layers)) {
      const where = `Legend labels for ${ctx.layerTitles?.get(key) ?? `layer ${key}`}`;
      if (ctx.layerKeys && !ctx.layerKeys.has(key)) warnings.push(`${where}: that layer isn't in the web map any more.`);
      for (const p of legendLabelProblems(cfg)) errors.push(`${where}: ${p}`);
    }
  }

  // Layer styles
  const ls = m.layerStyles;
  if (ls == null || typeof ls !== 'object' || Array.isArray(ls) || ls.layers == null || typeof ls.layers !== 'object' || Array.isArray(ls.layers)) {
    errors.push('"layerStyles" must be { layers: {} } keyed by layer.');
  } else {
    for (const [key, cfg] of Object.entries(ls.layers)) {
      const where = `Layer styles for ${ctx.layerTitles?.get(key) ?? `layer ${key}`}`;
      if (ctx.layerKeys && !ctx.layerKeys.has(key)) warnings.push(`${where}: that layer isn't in the web map any more.`);
      for (const p of layerStylesProblems(cfg)) errors.push(`${where}: ${p}`);
    }
  }

  // Disclaimer
  for (const p of disclaimerProblems(m.disclaimer)) errors.push(`Disclaimer: ${p}`);

  return { ok: errors.length === 0, errors, warnings };
}

/** Copy of the draft ready to publish. The snapshot and modified time are filled in by main.js. */
export function stamp(draft, publishedBy = 'manual') {
  return { ...structuredClone(draft), version: (draft.version || 0) + 1, publishedAt: new Date().toISOString(), publishedBy };
}

/** True when two manifests describe the same viewer, ignoring publish metadata and the snapshot. */
export function sameContent(a, b) {
  if (!a || !b) return false;
  const strip = ({ version, publishedAt, publishedBy, webmap, ...rest }) =>
    ({ ...rest, webmap: { ...webmap, snapshot: null, modified: null } });
  return JSON.stringify(strip(a)) === JSON.stringify(strip(b));
}
