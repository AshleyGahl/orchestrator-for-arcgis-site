// map.js — the only module that drives the map view. Loads the web map (live or snapshot),
// identifies features for Details using the web map's popups, highlights selections and moves the view.
// Also reads and saves the records of editable feature layers for the Editing window.
// (widgets.js mounts the SDK's own widgets onto the view this module creates.)
import { CONFIG } from './config.js';
import { hexToRgb, formatLatLon } from './utils.js';
import { renderFeature, formatValue } from './popup.js';
import { spatialQueryParams, spatialColumns, spatialOutFields, exportFieldChoices, exportColumns } from './spatial.js';
import { orderLayers, isLayerOn } from './layerOrder.js';
import { isImageryName, RASTER_SUBLAYER_TYPES } from './restServices.js';
import { recordsOrder, sortRows } from './dashboardItems.js';
import { emphasisSymbols, emphasisRgb, flashBeats, normalizeEmphasis, extrusion, shadeRgb, LIFT_EFFECT, EDGE_RGBA, isThin, selectionSymbols, plainEmphasis } from './emphasis.js';
import { defaultCursors, normalizeCursors, cursorFor, toolActivity, cursorRules } from './cursors.js';

let view = null;
let SDK = null;
let ready = null;
let manifest = null;
let identifyEnabled = true;
let coordsNode = null;
let pointerHandle = null;
let accentRgb = [43, 111, 127];
let imageryRgb = accentRgb;             // selection colour while an aerial / imagery layer is showing
let lastHighlight = null;               // the highlighted geometry, redrawn when the selection colour changes
const subFeatureLayers = new Map();     // sublayer url -> FeatureLayer (for Arcade $layer and Search)
let shapeLayer = null;                  // temporary layer for "Select features" shapes
let shapeVM = null;
let sketchLayer = null;                 // the Draw tool's graphics
let spatialLayer = null;                // outlines of a spatial relationship's results
let streamLayer = null;                 // Streaming, Cameras and Drones: where each stream is, while it is listed
let traceLayer = null;                  // Attribute trace: the results
const traceShapes = new Map();          // Attribute trace: result ObjectID -> its geometry
let coordsFormat = 'dd';
const added = new Map();                // Add data: id -> { layer, title, source, blobUrl }
const hidden = new Map();               // Label orientation: target key -> how to show its hidden features again
const styleOverlays = [];               // Layer styles: [{ layer, handles }], display-only copies drawn over a layer (per map)
const STYLE_OVERLAY = 'style-';         // their ids: "style-<layer key>"

const MODULES = {
  esriConfig: 'esri/config', IdentityManager: 'esri/identity/IdentityManager', Map: 'esri/Map', WebMap: 'esri/WebMap', MapView: 'esri/views/MapView', Graphic: 'esri/Graphic',
  FeatureLayer: 'esri/layers/FeatureLayer', arcade: 'esri/arcade', reactiveUtils: 'esri/core/reactiveUtils',
  Layer: 'esri/layers/Layer', CSVLayer: 'esri/layers/CSVLayer', GeoJSONLayer: 'esri/layers/GeoJSONLayer', Field: 'esri/layers/support/Field', rendererJsonUtils: 'esri/renderers/support/jsonUtils',
  GraphicsLayer: 'esri/layers/GraphicsLayer', SketchViewModel: 'esri/widgets/Sketch/SketchViewModel', Sketch: 'esri/widgets/Sketch',
  Print: 'esri/widgets/Print', Basemap: 'esri/Basemap', LocalBasemapsSource: 'esri/widgets/BasemapGallery/support/LocalBasemapsSource',
  LayerList: 'esri/widgets/LayerList', Legend: 'esri/widgets/Legend', Search: 'esri/widgets/Search', BasemapGallery: 'esri/widgets/BasemapGallery',
  Swipe: 'esri/widgets/Swipe', ElevationProfile: 'esri/widgets/ElevationProfile', geometryEngine: 'esri/geometry/geometryEngine', DistanceMeasurement2D: 'esri/widgets/DistanceMeasurement2D', AreaMeasurement2D: 'esri/widgets/AreaMeasurement2D'
};

/** Load SDK modules by AMD path (sceneView.js loads the 3D ones this way, only when the scene is first opened). */
export function loadSdkModules(paths) {
  if (typeof window.require !== 'function') {
    return Promise.reject(new Error('The ArcGIS Maps SDK didn\'t load. Check the js.arcgis.com script tag and your network.'));
  }
  return new Promise((resolve, reject) => window.require(paths, (...m) => resolve(m), reject));
}

/** Create the view once. Call when the viewer container is visible (a hidden container has no size). */
export function init(container) {
  if (ready) return ready;
  ready = (async () => {
    const names = Object.keys(MODULES);
    const mods = await loadSdkModules(Object.values(MODULES));
    SDK = Object.fromEntries(names.map((n, i) => [n, mods[i]]));
    mapEl = container;
    createView(new SDK.Map({ basemap: 'gray-vector' }), { center: [19.2345, -34.4187], zoom: 10 });
    await view.when();
    return view;
  })();
  return ready;
}

let mapEl = null;                       // the page's map element; each view draws in its own child node
let viewHandles = [];                   // the current view's own watches and events
let webmapShown = false;                // the view has shown a web map (the next one gets a new view)
const clickCallbacks = [];              // onMapClick
const viewWatchers = new Set();         // onViewChange: { callback, handle }

/**
 * A new MapView for `webmap`. SDK 4.30 keeps a web map alive after view.map is set to another one (even destroyed),
 * so each Update preview in the Orchestrator kept the previous web map with all its layers: about 9 MB of JS heap and
 * 70 MB of page and GPU memory each time, until the tab crashed after about 7 updates. A destroyed view lets its map
 * go. Click callbacks and onViewChange watchers move to the new view.
 */
function createView(webmap, at = {}) {
  if (view) {
    viewHandles.forEach(h => h.remove());
    pointerHandle?.remove(); pointerHandle = null;
    if (coordsNode) view.ui.remove(coordsNode);
    const old = view;
    view = null;
    old.container?.remove();
    old.destroy();                               // and its map, with every layer
  }
  const node = document.createElement('div');
  node.className = 'map-view';
  mapEl.append(node);
  view = new SDK.MapView({ container: node, map: webmap, ...at, popupEnabled: false });   // Details lives in the side panel, not in a map popup
  viewHandles = [
    SDK.reactiveUtils.watch(() => imageryShowing(), recolourSelection),   // the selection colour follows aerials coming on or off
    view.on('click', e => { if (identifyEnabled && manifest) clickCallbacks.forEach(cb => cb(e.mapPoint)); })
  ];
  for (const w of viewWatchers) watchView(w);
  applyPadding();
  applyCursor();
}

export const isReady = () => view != null;
export const getView = () => view;
export const getSDK = () => SDK;

/** Hand the app's sign-ins (tokens only) to the SDK, so secured web maps, layers and widgets work. */
export function registerCredentials(list) {
  if (!SDK?.IdentityManager) return;
  for (const c of list) {
    // Windows (web-tier) sign-in: the SDK sends the browser's network identity to these hosts.
    if (c.windows && SDK.esriConfig?.request) {
      const trusted = SDK.esriConfig.request.trustedServers ?? (SDK.esriConfig.request.trustedServers = []);
      for (const h of c.hosts ?? []) if (!trusted.includes(h)) trusted.push(h);
    }
    if (!c.token) continue;
    for (const server of c.servers ?? []) {
      try { SDK.IdentityManager.registerToken({ server, token: c.token, expires: c.expires, userId: c.user, ssl: true }); }
      catch (e) { console.warn('Couldn\'t register sign-in for', server, e); }
    }
  }
}

/** True when an SDK error means "needs sign-in" rather than a broken map. */
export const isAuthError = e => /not-authorized|identity-manager|token required|invalid token|499|498|403/i.test(`${e?.name ?? ''} ${e?.message ?? ''} ${e?.details?.httpStatus ?? ''}`);

/**
 * Load the manifest's web map into the view, then its extra ArcGIS REST services on top, then put the top-level
 * layers in the manifest's webmap.layerOrder (drawing, Layers, Legend and Details all follow the map's order) and
 * switch them on or off as webmap.layerVisibility says.
 * @param skipServices  ids of extra services to leave out (secured ones people chose not to sign in to)
 * @returns {{ errors: Map<layerId,string>, bookmarks: [{ name, viewpoint }], title }}
 */
export async function apply(m, { skipServices = new Set() } = {}) {
  await ready;
  manifest = m;
  accentRgb = hexToRgb(m.branding?.accent);
  imageryRgb = m.branding?.selectionOnImagery ? hexToRgb(m.branding.selectionOnImagery) : accentRgb;
  setCursorRules(m);
  unqueryable.clear();
  subFeatureLayers.clear();
  clearHighlight();
  cancelShape();
  shapeLayer = null;
  sketchLayer = null;
  spatialLayer = null;
  streamLayer = null;
  clearTrace();
  traceLayer = null;
  clearChosen();
  chosenSlot.layer = null;
  clearSlot(selectionSlot);
  selectionSlot.layer = null;
  lastHighlight = null;
  hidden.clear();                                // filters belonged to the previous map's layers
  for (const o of styleOverlays.splice(0)) o.handles.forEach(h => h?.remove());

  SDK.esriConfig.portalUrl = m.webmap.portalUrl;
  const webmap = m.webmap.mode === 'snapshot' && m.webmap.snapshot
    ? SDK.WebMap.fromJSON(m.webmap.snapshot)
    : new SDK.WebMap({ portalItem: { id: m.webmap.itemId, portal: { url: m.webmap.portalUrl } } });

  forgetAdded();                                  // added layers belonged to the previous map
  if (webmapShown) createView(webmap, { extent: view.extent });   // a new view: the old one lets its web map go
  else view.map = webmap;
  webmapShown = true;
  await webmap.load();
  await webmap.loadAll().catch(() => {});        // individual layer failures are reported below
  const vp = webmap.initialViewProperties?.viewpoint;
  if (vp) view.goTo(vp, { animate: false }).catch(() => {});

  const errors = new Map();
  for (const l of webmap.allLayers.toArray()) {
    if (l.loadStatus === 'failed') errors.set(l.id, l.loadError?.message ?? 'The layer failed to load.');
  }
  await addExtraServices(webmap, (m.webmap.extraServices ?? []).filter(s => !skipServices.has(s.id)), errors);
  drawAerialsAsJpeg(webmap);
  applyLayerOrder(webmap, m.webmap.layerOrder);
  applyLayerVisibility(webmap, m.webmap.layerVisibility, m.webmap.extraServices);
  coordsFormat = m.widgets?.toolConfig?.coordinates?.format ?? 'dd';
  setCoordinatesVisible(m.widgets?.tools?.includes('coordinates'));
  return {
    errors,
    title: webmap.portalItem?.title ?? m.webmap.title,
    bookmarks: (webmap.bookmarks?.toArray?.() ?? []).map(b => ({ name: b.name, viewpoint: b.viewpoint }))
  };
}

/**
 * ArcGIS REST services the manifest adds on top of the web map (first in the list = top). Layer ids follow the
 * manifest's keys, so Details, Search and Editing settings find them: the service id for a single layer or a
 * map service (its sublayers become "<id>:<n>"), and "<id>:<n>" for each layer of a feature service.
 */
async function addExtraServices(webmap, services, errors) {
  const loaded = await Promise.all(services.map(async s => {
    try {
      const layer = await SDK.Layer.fromArcGISServerUrl({ url: s.url });
      layer.id = s.id;
      if (s.title) layer.title = s.title;
      layer.visible = s.visible !== false;
      await layer.load();
      if (layer.type === 'group') {                // a feature service with several layers
        await layer.loadAll().catch(() => {});
        for (const child of layer.layers.toArray()) if (child.layerId != null) child.id = `${s.id}:${child.layerId}`;
      }
      return layer;
    } catch (e) {
      errors.set(s.id, isAuthError(e) ? `"${s.title || s.url}" is secured. Sign in to its server to see it.` : `"${s.title || s.url}" didn't load: ${e.message}`);
      return null;
    }
  }));
  for (const layer of loaded.reverse()) if (layer) webmap.add(layer);
}

/**
 * Dynamic aerial map services draw as JPEG. Their default PNG32 export is ~2.5 MB per pan, and while it downloads
 * the Details queries to the same server wait behind it (5–11 s instead of under 1 s). JPEG is about 4× smaller,
 * but has no transparency: outside the photo's coverage it draws white. Tiled aerials are left as they are.
 */
function drawAerialsAsJpeg(webmap) {
  for (const layer of webmap.allLayers.toArray()) if (layer.type === 'map-image' && looksLikeImagery(layer)) layer.imageFormat = 'jpg';
}

/** Reorder the map's top-level layers to `order` (ids, top first). Layers it doesn't name keep their default place. */
function applyLayerOrder(webmap, order) {
  if (!order?.length) return;
  const wanted = orderLayers(topFirst(webmap.layers).map(l => l.id), order).reverse();   // the SDK counts from the bottom
  wanted.forEach((id, i) => { const layer = webmap.layers.find(l => l.id === id); if (layer) webmap.layers.reorder(layer, i); });
}

/** Switch top-level web map layers on or off as the manifest says (extra services were set when added). */
function applyLayerVisibility(webmap, visibility, services = []) {
  const serviceIds = new Set(services.map(s => s.id));
  for (const layer of webmap.layers.toArray()) {
    if (!serviceIds.has(layer.id)) layer.visible = isLayerOn(layer.id, layer.visible, visibility);
  }
}

/* ---------------- View helpers ---------------- */
export function goToBookmark(b) {
  if (!view) return;
  const target = b.viewpoint ?? { center: b.center, zoom: b.zoom };
  view.goTo(target).catch(() => {});
}

export function getViewState() {
  if (!view?.center) return null;
  return {
    center: [Number(view.center.longitude.toFixed(5)), Number(view.center.latitude.toFixed(5))],
    zoom: Math.round(view.zoom * 2) / 2
  };
}

/**
 * Where the map is looking, for External pages that open at the map's position: the centre, zoom and scale, and the
 * corners of the part people can see (inside the view's padding, so not under a window over the map), in WGS 84.
 * Null before the map has loaded, or when its spatial reference has no longitudes (neither Web Mercator nor WGS 84).
 */
export function getMapPosition() {
  if (!view?.center || !Number.isFinite(view.center.longitude)) return null;
  const pad = view.padding ?? {};
  const sw = view.toMap({ x: pad.left ?? 0, y: view.height - (pad.bottom ?? 0) });
  const ne = view.toMap({ x: view.width - (pad.right ?? 0), y: pad.top ?? 0 });
  return {
    lon: view.center.longitude, lat: view.center.latitude, zoom: view.zoom, scale: view.scale,
    xmin: sw?.longitude, ymin: sw?.latitude, xmax: ne?.longitude, ymax: ne?.latitude
  };
}

/* ---------------- Targets: what can be identified / searched ---------------- */
function inScale(l) {
  const sc = view.scale, min = l.minScale || 0, max = l.maxScale || 0;
  return (!min || sc <= min) && (!max || sc >= max);
}

/** Visibility switched on, here and in every parent group (scale not considered). */
function layerVisible(layer) {
  if (!layer.visible) return false;
  for (let p = layer.parent; p && p !== view.map; p = p.parent) if (p.visible === false) return false;
  return true;
}

/** Within scale range, here and in every parent group. */
function layerInScale(layer) {
  if (!inScale(layer)) return false;
  for (let p = layer.parent; p && p !== view.map; p = p.parent) if (p.minScale != null && !inScale(p)) return false;
  return true;
}

const layerShowing = layer => layerVisible(layer) && layerInScale(layer);

function sublayerVisible(layer, sub) {
  if (!layerVisible(layer)) return false;
  for (let p = sub; p && p !== layer; p = p.parent) if (!p.visible) return false;
  return true;
}

function sublayerInScale(layer, sub) {
  if (!layerInScale(layer)) return false;
  for (let p = sub; p && p !== layer; p = p.parent) if (!inScale(p)) return false;
  return true;
}

const sublayerShowing = (layer, sub) => sublayerVisible(layer, sub) && sublayerInScale(layer, sub);

async function featureLayerForSublayer(sub) {
  if (!subFeatureLayers.has(sub.url)) {
    subFeatureLayers.set(sub.url, (sub.createFeatureLayer ? sub.createFeatureLayer() : Promise.resolve(new SDK.FeatureLayer({ url: sub.url })))
      .then(async fl => { await fl.load(); return fl; }));
  }
  return subFeatureLayers.get(sub.url);
}

/** A collection top-first, the way the Layers list shows it (the SDK stores layers bottom-first). */
const topFirst = coll => [...(coll?.toArray?.() ?? [])].reverse();

/** Operational layers in layer-list order (basemap layers are never identified), including group contents. */
function operationalLayers() {
  const out = [];
  const walk = coll => topFirst(coll).forEach(l => {
    if (String(l.id).startsWith('tracking-')) return;   // Streaming's tracking feeds (trackingLayers.js) aren't map content
    if (String(l.id).startsWith(STYLE_OVERLAY)) return; // nor are Layer styles' copies (styleOverlay)
    out.push(l);
    if (l.type === 'group') walk(l.layers);
  });
  walk(view.map.layers);
  return out;
}

/** Leaf sublayers of a map image / tile layer in layer-list order. */
function leafSublayers(layer) {
  const out = [];
  const walk = coll => topFirst(coll).forEach(s => { if (s.sublayers?.length) walk(s.sublayers); else out.push(s); });
  walk(layer.sublayers);
  return out;
}

const FEATURE_LIKE = new Set(['feature', 'geojson', 'csv', 'wfs', 'ogc-feature']);
// Aerial photography is never queried: it's left out of Details and of the "Layers checked" note altogether.
// An aerial is an imagery layer, or a tiled / map / web tile layer whose name or address says imagery or aerial.
const IMAGERY_TYPES = new Set(['imagery', 'imagery-tile']);
const RASTER_TYPES = new Set(['tile', 'map-image', 'web-tile', 'wmts']);
const looksLikeImagery = l => IMAGERY_TYPES.has(l.type) || (RASTER_TYPES.has(l.type) && isImageryName(l.title, l.url, l.urlTemplate));
// A map service's raster or mosaic sublayer, or one whose service says it can't be queried.
const sublayerUnqueryable = sub => RASTER_SUBLAYER_TYPES.has(sub.sourceJSON?.type) || sub.capabilities?.operations?.supportsQuery === false;
// The service's answer when a layer turns out not to support queries (remembered in `unqueryable`).
const QUERY_UNSUPPORTED = /(doesn't|does not|don't|do not|not) support(s|ed)? (the )?quer|query.{0,20}not supported|query-not-supported/i;
const unqueryable = new Set();          // target keys whose service refused a query as unsupported (cleared per map)
const NOT_IDENTIFIABLE = { 'vector-tile': 'vector tiles hold no attributes', 'web-tile':'web tiles hold no attributes', 'base-tile': 'tiles', graphics: 'drawings', 'wms': 'WMS isn\'t supported yet', 'kml': 'KML isn\'t supported yet' };

/**
 * Every layer Details could identify, with the reason it's skipped right now (if it is).
 * Target: { key, title, template, skip?, source: { layer, sub? }, geometryType, query(params, { signal }?), fields(), arcadeLayer(), searchLayer() }
 * Also returns layers that can never be identified, so the "Layers checked" note can say why.
 */
function allTargets() {
  const out = [];
  const why = (visible, scaleOk, popupOn) => (!visible ? 'hidden' : !scaleOk ? 'out of scale at this zoom' : !popupOn ? 'popups are switched off' : null);
  // Orchestration can include a layer in Details even when it's out of scale (e.g. wards when zoomed in).
  const scaleOk = (key, inRange) => inRange || manifest?.details?.[key]?.ignoreScale === true;

  for (const layer of operationalLayers()) {
    if (layer.type === 'group' || looksLikeImagery(layer)) continue;
    if (!layer.loaded) { out.push({ key: layer.id, title: layer.title, skip: `didn't load${layer.loadError ? `: ${layer.loadError.message}` : ''}` }); continue; }

    if (FEATURE_LIKE.has(layer.type)) {
      const def = layer.definitionExpression;
      out.push({
        key: layer.id, title: layer.title, template: layer.popupTemplate ?? null, source: { layer }, geometryType: layer.geometryType,
        skip: why(layerVisible(layer), scaleOk(layer.id, layerInScale(layer)), layer.popupEnabled !== false),
        query: (p, o) => layer.queryFeatures({ ...p, where: p.where ? (def ? `(${def}) AND (${p.where})` : p.where) : (def || '1=1') }, o),
        fields: async () => layer.fields ?? [],
        arcadeLayer: async () => layer, searchLayer: async () => layer
      });
      continue;
    }

    if (layer.type === 'subtype-group') {
      for (const sub of topFirst(layer.sublayers)) {
        const where = `${layer.subtypeField} = ${typeof sub.subtypeCode === 'string' ? `'${sub.subtypeCode.replace(/'/g, "''")}'` : sub.subtypeCode}`;
        out.push({
          key: `${layer.id}:${sub.subtypeCode}`, title: sub.title, template: sub.popupTemplate ?? layer.popupTemplate ?? null,
          source: { layer }, geometryType: layer.geometryType,
          skip: why(layerVisible(layer) && sub.visible, scaleOk(`${layer.id}:${sub.subtypeCode}`, layerInScale(layer) && inScale(sub)), sub.popupEnabled !== false),
          query: (p, o) => layer.queryFeatures({ ...p, where: p.where ? `(${where}) AND (${p.where})` : where }, o),
          fields: async () => layer.fields ?? [],
          arcadeLayer: async () => layer, searchLayer: async () => layer
        });
      }
      continue;
    }

    // Map image services, and tiled services whose sublayers have popups configured in the web map.
    if (layer.type === 'map-image' || layer.type === 'tile') {
      const subs = leafSublayers(layer);
      if (layer.type === 'tile' && !subs.some(s => s.popupTemplate)) {
        out.push({ key: layer.id, title: layer.title, skip: 'a tiled layer with no popups configured' });
        continue;
      }
      for (const sub of subs) {
        if (layer.type === 'tile' && !sub.popupTemplate) continue;
        if (sublayerUnqueryable(sub)) continue;
        const key = `${layer.id}:${sub.id}`;
        out.push({
          key, title: sub.title, template: sub.popupTemplate ?? null, source: { layer, sub }, geometryType: sub.geometryType ?? null,
          skip: why(sublayerVisible(layer, sub), scaleOk(key, sublayerInScale(layer, sub)), sub.popupEnabled !== false && layer.popupEnabled !== false),
          query: async (p, o) => {
            if (layer.type === 'map-image' && sub.queryFeatures) return sub.queryFeatures({ where: '1=1', ...p }, o);
            return (await featureLayerForSublayer(sub)).queryFeatures({ where: '1=1', ...p }, o);
          },
          fields: async () => (await featureLayerForSublayer(sub)).fields ?? [],
          arcadeLayer: () => featureLayerForSublayer(sub).catch(() => null),
          searchLayer: () => featureLayerForSublayer(sub)
        });
      }
      continue;
    }

    out.push({ key: layer.id, title: layer.title, skip: `can't be identified (${NOT_IDENTIFIABLE[layer.type] ?? `${layer.type} layer`})` });
  }
  return out.filter(t => !unqueryable.has(t.key));
}

/** Identifiable targets, optionally only those showing with popups on. */
function targets({ onlyShowing = true } = {}) {
  return allTargets().filter(t => t.query && (!onlyShowing || !t.skip));
}

/**
 * Query a target, falling back to the most basic request if the service rejects options
 * some servers don't support (record limits, output spatial reference).
 */
async function queryRobust(target, params) {
  try {
    return await target.query(params);
  } catch (first) {
    const { num, outSpatialReference, ...basic } = params;
    try { return await target.query(basic); }
    catch { throw first; }
  }
}

/** Run a spatial query over targets and describe every feature. Returns { results, report }. */
async function queryTargets(list, params) {
  const all = allTargets();
  const chosen = new Set(list.map(t => t.key));
  const settled = await Promise.allSettled(list.map(t => queryRobust(t, params)));
  const report = [];
  const jobs = [];
  settled.forEach((r, i) => {
    const t = list[i];
    if (r.status === 'rejected') {
      // A layer that can't be queried at all (e.g. an image) is dropped for the rest of the visit, not reported as failed.
      if (QUERY_UNSUPPORTED.test(`${r.reason?.message ?? ''} ${r.reason?.details?.messages?.join?.(' ') ?? ''}`)) { unqueryable.add(t.key); return; }
      report.push({ title: t.title, status: 'failed', note: r.reason?.message ?? 'The query failed.' });
      console.warn(`Details: querying "${t.title}" failed`, r.reason);
      return;
    }
    const feats = r.value.features ?? [];
    report.push({ title: t.title, status: feats.length ? 'found' : 'none', note: feats.length ? `${feats.length} feature${feats.length === 1 ? '' : 's'}` : 'nothing at this spot' });
    for (const g of feats) jobs.push(describe(t, g, r.value.fields));
  });
  for (const t of all) if (!chosen.has(t.key) && t.skip) report.push({ title: t.title, status: 'skipped', note: t.skip });
  return { results: await Promise.all(jobs), report };
}

export const getTarget = key => (view ? targets({ onlyShowing: false }).find(t => t.key === key) ?? null : null);

/** The map's identifiable layers in layer order, top first (as Details lists them): [{ key, title }]. */
export const listLayers = () => (view ? targets({ onlyShowing: false }).map(t => ({ key: t.key, title: t.title })) : []);

/**
 * The REST URL of the layer a key names (…/FeatureServer/n or …/MapServer/n), or null when it isn't a service layer
 * of this map (a file people added). Built from the service's URL, so a map service sublayer the web map leaves out
 * still has one: the 3D scene draws its own copy of the layer from this URL.
 */
export function layerUrl(key) {
  if (!view) return null;
  const all = view.map.allLayers;
  const clean = u => u?.replace(/\/+$/, '') || null;
  const own = all.find(l => l.id === key && l.type !== 'group');
  if (own) {
    const url = clean(own.url);
    if (!url) return null;
    return /\/\d+$/.test(url) ? url : own.layerId != null ? `${url}/${own.layerId}` : null;
  }
  const at = key.lastIndexOf(':');
  const parent = at > 0 ? all.find(l => l.id === key.slice(0, at)) : null;    // a map service, or a feature service's group
  const url = clean(parent?.url);
  return url && /^\d+$/.test(key.slice(at + 1)) ? `${url.replace(/\/\d+$/, '')}/${key.slice(at + 1)}` : null;
}

/* ---------------- Details ---------------- */
export function setIdentifyEnabled(on) { identifyEnabled = on; }

/*
 * Map cursor while a tool or widget waits for the map (cursors.js, manifest widgets.cursors). What wins: a shape
 * being drawn ('draw'), then the open tool's activity, then the open window's (Attribute trace, Editing, spatial
 * relationship). The cursor id goes on the view's container as data-tool-cursor; the rules come from cursorRules.
 */
let cursorCfg = defaultCursors();
let toolOwner = null;                   // the open tool's id
let windowCursor = null;                // { owner, activity } of the open window
let shapeDrawing = false;
function applyCursor() {
  const node = view?.container;
  if (!node) return;
  const toolAct = toolActivity(toolOwner);
  const req = shapeDrawing ? { owner: toolOwner ?? windowCursor?.owner, activity: 'draw' }
    : toolAct ? { owner: toolOwner, activity: toolAct }
    : windowCursor;
  const id = req ? cursorFor(cursorCfg, req.owner, req.activity) : null;
  if (id) node.dataset.toolCursor = id;
  else delete node.dataset.toolCursor;
}
function setCursorRules(m) {
  cursorCfg = normalizeCursors(m.widgets?.cursors);
  let style = document.getElementById('tool-cursor-rules');
  if (!style) document.head.append(style = Object.assign(document.createElement('style'), { id: 'tool-cursor-rules' }));
  style.textContent = cursorRules(cursorCfg, m.branding?.accent);
  applyCursor();
}
/** The tool now open (its id), or null. */
export function setToolCursor(toolId) { toolOwner = toolId || null; applyCursor(); }
/** The window over the map that now takes map clicks: owner 'trace' | 'editing' | 'spatial', activity 'select' | 'pick'; or null. */
export function setWindowCursor(owner, activity) { windowCursor = owner ? { owner, activity } : null; applyCursor(); }

/** Register once (viewerApp.js). Clicks are ignored while a measuring tool is active. Kept when the view is replaced. */
export function onMapClick(callback) {
  clickCallbacks.push(callback);
}

/** Render one feature with its layer's web map popup and the manifest's Details config. */
export async function describe(target, graphic, fields) {
  return renderFeature({
    key: target.key, graphic, template: target.template, fields, layerTitle: target.title,
    config: manifest?.details?.[target.key],
    arcade: SDK.arcade, layer: await target.arcadeLayer(), map: view.map,
    spatialReference: view.spatialReference, cacheKey: target.key
  });
}

/** A small box around a click, in map units. Every query-capable service supports an envelope intersect. */
function clickBox(mapPoint) {
  const tol = view.resolution * CONFIG.identifyTolerancePx;
  return { type: 'extent', xmin: mapPoint.x - tol, ymin: mapPoint.y - tol, xmax: mapPoint.x + tol, ymax: mapPoint.y + tol, spatialReference: view.spatialReference };
}

/** Everything showing (with popups on) at a map point. Returns { results, report }. */
export async function identify(mapPoint) {
  return queryTargets(targets(), {
    geometry: clickBox(mapPoint),
    spatialRelationship: 'intersects',
    outFields: ['*'],
    returnGeometry: true,
    num: CONFIG.identifyMaxPerLayer,
    outSpatialReference: view.spatialReference
  });
}

/**
 * Summary statistics for a dashboard item, computed by the server (outStatistics), so even large layers
 * cost one small request. Returns { value } for an indicator, or { rows: [{ label, value, raw }] } grouped.
 */
export async function statistics(w) {
  const target = getTarget(w.layerKey);
  if (!target) throw new Error('That layer is no longer in the map.');
  const fields = await target.fields().catch(() => []);
  const byName = new Map(fields.map(f => [f.name.toLowerCase(), f]));
  const oid = fields.find(f => /oid/i.test(f.type))?.name ?? 'OBJECTID';
  const onField = w.statistic === 'count' ? (w.valueField || oid) : w.valueField;
  const params = {
    where: w.where?.trim() || '1=1',
    outStatistics: [{ statisticType: w.statistic, onStatisticField: onField, outStatisticFieldName: 'stat_value' }],
    returnGeometry: false
  };
  if (w.type !== 'indicator') params.groupByFieldsForStatistics = [w.categoryField];
  const res = await queryRobust(target, params);
  const pick = (attrs, name) => attrs[Object.keys(attrs).find(k => k.toLowerCase() === name.toLowerCase())];
  const feats = res.features ?? [];
  if (w.type === 'indicator') return { value: Number(pick(feats[0]?.attributes ?? {}, 'stat_value') ?? 0) };
  const catField = byName.get(w.categoryField.toLowerCase());
  return {
    categoryLabel: catField?.alias || w.categoryField,
    valueLabel: w.valueField ? (byName.get(w.valueField.toLowerCase())?.alias || w.valueField) : '',
    rows: feats.map(f => {
      const raw = pick(f.attributes, w.categoryField);
      const coded = catField?.domain?.type === 'coded-value' ? catField.domain.codedValues?.find(c => c.code === raw)?.name : null;
      const label = raw == null || raw === '' ? '(blank)' : coded ?? (/date/i.test(catField?.type ?? '') ? new Date(raw).toLocaleDateString('en-ZA') : String(raw));
      return { label, raw, value: Number(pick(f.attributes, 'stat_value') ?? 0) };
    })
  };
}

/**
 * A dashboard's features table: the chosen fields of the first topN features, newest first unless another order
 * was chosen. Values are formatted as Details shows them (coded values, dates).
 * @returns { columns: [{ name, label }], rows: [{ cells: [{ text, raw }] }], more }  more: the layer holds more
 */
export async function dashboardRecords(w) {
  const target = getTarget(w.layerKey);
  if (!target) throw new Error('That layer is no longer in the map.');
  const fields = await target.fields().catch(() => []);
  const byName = new Map(fields.map(f => [f.name.toLowerCase(), f]));
  const columns = w.columns.map(name => ({ name, label: byName.get(name.toLowerCase())?.alias || name, field: byName.get(name.toLowerCase()) }));
  const order = recordsOrder(w, fields);
  const max = w.topN || 25;
  const params = { where: w.where?.trim() || '1=1', outFields: w.columns, returnGeometry: false, num: max + 1 };
  let res, sorted = true;
  try { res = await queryRobust(target, order ? { ...params, orderByFields: [order] } : params); }
  catch (e) { if (!order) throw e; res = await queryRobust(target, params); sorted = false; }   // a server that can't sort
  const pick = (attrs, name) => attrs[Object.keys(attrs).find(k => k.toLowerCase() === name.toLowerCase())];
  let rows = (res.features ?? []).map(f => ({
    cells: columns.map(c => { const raw = pick(f.attributes, c.name) ?? null; return { raw, text: formatValue(raw, c.field) }; })
  }));
  const [orderField, dir] = order.split(' ');
  const at = columns.findIndex(c => c.name.toLowerCase() === orderField?.toLowerCase());
  if (!sorted && at >= 0) rows = sortRows(rows, at, dir === 'ASC' ? 'asc' : 'desc');
  return { columns: columns.map(({ name, label }) => ({ name, label })), rows: rows.slice(0, max), more: rows.length > max || res.exceededTransferLimit === true };
}

/** Attribute search for one layer. @returns { features, fields, exceeded } */
export async function searchWhere(key, where, max = CONFIG.searchMaxResults) {
  const target = getTarget(key);
  if (!target) throw new Error('That layer is no longer in the map.');
  const res = await queryRobust(target, { where, outFields: ['*'], returnGeometry: true, num: max, outSpatialReference: view.spatialReference });
  const fields = res.fields?.length ? res.fields : await target.fields();
  return { features: res.features ?? [], fields, exceeded: res.exceededTransferLimit === true || (res.features?.length ?? 0) >= max, target };
}

/**
 * Every feature an attribute search matches, for Export (the results list stops at searchMaxResults): the ObjectIDs
 * first (an exact total), then the features by id without shapes, newest first, a page at a time.
 * @returns { total, read(outFields, { signal, onProgress }) -> Promise<[attributes]> }
 */
export async function searchExport(key, where) {
  const target = getTarget(key);
  if (!target) throw new Error('That layer is no longer in the map.');
  const fields = await target.fields().catch(() => []);
  const oid = fields.find(f => /oid/i.test(f.type))?.name;
  const ids = ((await (await target.searchLayer()).queryObjectIds({ where })) ?? []).sort((a, b) => b - a);
  const size = Math.max(1, Math.min(CONFIG.spatialMaxRows, 1000));
  return {
    total: ids.length,
    async read(outFields, { signal, onProgress } = {}) {
      const out = [];
      const fieldsOut = oid ? [...new Set([oid, ...outFields])] : outFields;
      for (let at = 0; at < ids.length; at += size) {
        if (signal?.aborted) throw new DOMException('Export cancelled.', 'AbortError');
        const chunk = ids.slice(at, at + size);
        const res = await queryRobust(target, { objectIds: chunk, outFields: fieldsOut, returnGeometry: false });
        const feats = res.features ?? [];
        if (oid) {
          const idOf = a => Number(a?.[oid] ?? a?.[Object.keys(a ?? {}).find(k => k.toLowerCase() === oid.toLowerCase())]);
          const byId = new Map(feats.map(g => [idOf(g.attributes), g.attributes ?? {}]));
          for (const id of chunk) if (byId.has(Number(id))) out.push(byId.get(Number(id)));
        } else out.push(...feats.map(g => g.attributes ?? {}));
        onProgress?.(Math.min(at + chunk.length, ids.length), ids.length);
      }
      return out;
    }
  };
}

export function zoomToGraphics(graphics) {
  const exts = graphics.map(g => g?.geometry).filter(Boolean).map(g => (g.type === 'point' ? null : g.extent)).filter(Boolean);
  const points = graphics.map(g => g?.geometry).filter(g => g?.type === 'point');
  if (!view || (!exts.length && !points.length)) return;
  if (!exts.length) { view.goTo(points.length === 1 ? { target: points[0], zoom: Math.max(view.zoom, 17) } : points).catch(() => {}); return; }
  const union = exts.slice(1).reduce((a, e) => a.union(e), exts[0].clone());
  view.goTo(points.length ? [union, ...points] : union.expand(1.3)).catch(() => {});
}

/* ---------------- Spatial relationships (Details sections run on request) ---------------- */
/**
 * Features of each target layer related by location to one clicked feature.
 * @returns [{ key, title, columns, rows: [{ id, cells, graphic }], total, truncated, offset, pageSize,
 *            exportFields: [{ name, label, shown }], exportAll(names | null, { onProgress, signal }) -> Promise<{ columns, rows }>,
 *            page?(offset) -> Promise<the same shape>, error? }] in section order. page is there when the
 *            results run past one page; it fetches the page starting at offset and draws it in place of the last.
 */
export async function runSpatial(graphic, section) {
  if (!view) throw new Error('The map is not ready yet.');
  let geometry = graphic?.geometry;
  if (!geometry) throw new Error('This feature has no shape to compare with.');
  const { spatialRelationship, bufferMeters } = spatialQueryParams(section);
  if (bufferMeters) {
    const ge = SDK.geometryEngine;
    const sr = geometry.spatialReference;
    geometry = sr?.isWebMercator || sr?.isWGS84 ? ge.geodesicBuffer(geometry, bufferMeters, 'meters') : ge.buffer(geometry, bufferMeters, 'meters');
  }
  if (geometry.type === 'point') geometry = clickBox(geometry);
  const max = Math.max(1, Math.min(section.max || 200, CONFIG.spatialMaxRows));
  clearSpatial();

  const run = ++spatialRun;
  const results = await Promise.all((section.targets ?? []).map(async ({ layerKey, fields: chosen = [] }) => {
    const target = getTarget(layerKey);
    if (!target) return { key: layerKey, title: layerKey, columns: [], rows: [], total: 0, error: 'That layer is no longer in the map.' };
    try {
      const fields = await target.fields().catch(() => []);
      const oid = fields.find(f => /oid/i.test(f.type))?.name;
      // ObjectIDs first, then the features by id: some ArcGIS Servers apply a record limit before the spatial
      // filter (a ward "contains" query with a limit comes back empty), and ids give an exact total.
      // Newest (highest ids) first, matching the tables' default ObjectID-descending sort.
      const ids = ((await (await target.searchLayer()).queryObjectIds({ geometry, spatialRelationship })) ?? []).sort((a, b) => b - a);
      const byName = new Map(fields.map(f => [f.name.toLowerCase(), f]));
      const cellsOf = (g, columns) => {
        const a = g.attributes ?? {};
        const val = name => a[name] ?? a[Object.keys(a).find(k => k.toLowerCase() === name.toLowerCase())];
        return Object.fromEntries(columns.map(c => [c.name, { text: formatValue(val(c.name), byName.get(c.name.toLowerCase())), raw: val(c.name) ?? null }]));
      };
      // Every feature (not just the page showing), with the columns people ticked (null: the table's), for Export.
      // Read by id, a page at a time and without shapes, in the tables' order (newest ObjectIDs first).
      async function exportAll(picked = null, { onProgress, signal } = {}) {
        let columns = exportColumns(chosen, fields, picked);
        const outFields = columns.length ? [...new Set([...(oid ? [oid] : []), ...columns.map(c => c.name)])] : ['*'];
        const rows = [];
        for (let at = 0; at < ids.length; at += max) {
          if (signal?.aborted) throw new DOMException('Export cancelled.', 'AbortError');
          const chunk = ids.slice(at, at + max);
          const res = await queryRobust(target, { objectIds: chunk, outFields, returnGeometry: false });
          const feats = res.features ?? [];
          if (!columns.length) columns = exportColumns(chosen, res.fields ?? [], null);   // the layer's fields couldn't be read
          if (oid) {
            const byId = new Map(feats.map(g => [Number(g.attributes?.[oid] ?? g.attributes?.[Object.keys(g.attributes ?? {}).find(k => k.toLowerCase() === oid.toLowerCase())]), g]));
            for (const id of chunk) { const g = byId.get(Number(id)); if (g) rows.push({ cells: cellsOf(g, columns) }); }
          } else for (const g of feats) rows.push({ cells: cellsOf(g, columns) });
          onProgress?.(Math.min(at + chunk.length, ids.length), ids.length);
        }
        return { columns, rows };
      }
      // One page of rows: the ids from offset, max at a time. Later pages are fetched by the same ids.
      const pageAt = async offset => {
        const res = ids.length
          ? await queryRobust(target, { objectIds: ids.slice(offset, offset + max), outFields: spatialOutFields(chosen, oid), returnGeometry: true, outSpatialReference: view.spatialReference })
          : { features: [] };
        const feats = (res.features ?? []).slice(0, max);
        const columns = spatialColumns(chosen, fields.length ? fields : (res.fields ?? []));
        const rows = feats.map((g, i) => ({ id: `${layerKey}-${offset + i}`, key: layerKey, graphic: g, cells: cellsOf(g, columns) }));
        const total = Math.max(ids.length, rows.length);
        const result = { key: layerKey, title: target.title, columns, rows, total, truncated: total > rows.length, offset, pageSize: max,
          exportFields: exportFieldChoices(chosen, fields), exportAll };
        if (total > max) result.page = async to => {
          const next = await pageAt(Math.min(Math.max(0, to), Math.floor((total - 1) / max) * max));
          if (run === spatialRun) drawSpatial(layerKey, next.rows);
          return next;
        };
        return result;
      };
      return await pageAt(0);
    } catch (e) {
      console.warn(`Spatial relationship: querying "${target.title}" failed`, e);
      return { key: layerKey, title: target.title, columns: [], rows: [], total: 0, error: e.message || 'The query failed.' };
    }
  }));

  for (const r of results) drawSpatial(r.key, r.rows);
  return results;
}

let spatialRun = 0;                     // which search is showing, so a late page from an older one isn't drawn

/** Draws one layer's rows of the spatial results, replacing that layer's earlier page. */
function drawSpatial(layerKey, rows) {
  spatialLayer = ensureLayer(spatialLayer ?? new SDK.GraphicsLayer({ listMode: 'hide', title: 'Spatial relationship' }));
  const sym = thinSymbols();
  const symbolFor = g => (g.type === 'point' || g.type === 'multipoint' ? sym.pointSymbol : g.type === 'polyline' ? sym.polylineSymbol : sym.polygonSymbol);
  spatialLayer.removeMany(spatialLayer.graphics.filter(g => g.attributes?.spatialKey === layerKey).toArray());
  spatialLayer.addMany(rows.filter(r => r.graphic.geometry)
    .map(r => new SDK.Graphic({ geometry: r.graphic.geometry, symbol: symbolFor(r.graphic.geometry), attributes: { spatialKey: layerKey } })));
}

export function clearSpatial() { spatialRun++; spatialLayer?.removeAll(); clearChosen('spatial'); }

/**
 * Details for one spatial result row, as a map click would show them. The row only carries its table's columns,
 * so the feature is read again with every field: the popup, Details config and related records need them.
 * @returns { results, report }
 */
export async function describeSpatialRow(row) {
  const target = getTarget(row.key);
  if (!target) throw new Error('That layer is no longer in the map.');
  const fields = await target.fields().catch(() => []);
  const oid = fields.find(f => /oid/i.test(f.type))?.name;
  const a = row.graphic?.attributes ?? {};
  const id = oid ? a[oid] ?? a[Object.keys(a).find(k => k.toLowerCase() === oid.toLowerCase())] : null;
  const res = id != null
    ? await queryRobust(target, { objectIds: [id], outFields: ['*'], returnGeometry: true, outSpatialReference: view.spatialReference })
    : { features: [row.graphic], fields };
  const g = res.features?.[0] ?? row.graphic;
  return { results: [await describe(target, g, res.fields?.length ? res.fields : fields)], report: [{ title: target.title, status: 'found', note: '1 feature' }] };
}

/* ---------------- Attribute trace (trace.js runs it, traceWindow.js shows it) ---------------- */
const traceTarget = key => {
  const t = view ? getTarget(key) : null;
  if (!t) throw new Error(`the layer ${key} isn't in the map`);
  return t;
};

/**
 * The trace engine's adapter: a layer's fields, and attribute-only queries (no geometry) by layer key. Queries go to
 * the server through the layer, with its filter, its sign-in and its record limit; paging uses start / num.
 */
export function traceAdapter() {
  return {
    fields: async key => (await traceTarget(key).fields()).map(f => ({ name: f.name, type: f.type, alias: f.alias })),
    async query(key, { where, outFields, offset = 0, num, signal }) {
      const t = traceTarget(key);
      let res;
      try { res = await t.query({ where, outFields, returnGeometry: false, start: offset, num }, { signal }); }
      catch (e) {
        // Some services refuse start / num (no paging): the first page can still be read without them.
        if (offset || signal?.aborted) throw e;
        res = await t.query({ where, outFields, returnGeometry: false }, { signal });
      }
      return { records: (res.features ?? []).map(g => g.attributes ?? {}), more: res.exceededTransferLimit === true };
    }
  };
}

/** The start layer's feature at a map click, read with every field and its shape, or null when there is none. */
export async function traceStartAt(key, mapPoint) {
  const res = await queryRobust(traceTarget(key), {
    geometry: clickBox(mapPoint), spatialRelationship: 'intersects', outFields: ['*'], returnGeometry: true, outSpatialReference: view.spatialReference, num: 1
  });
  return res.features?.[0] ?? null;
}

/** A Details card's feature, read again with every field (a card may hold only some), or the card's own graphic. */
export async function traceStartFrom(key, graphic) {
  const t = traceTarget(key);
  const fields = await t.fields().catch(() => []);
  const oid = fields.find(f => /oid/i.test(f.type))?.name;
  const a = graphic?.attributes ?? {};
  const id = oid ? a[oid] ?? a[Object.keys(a).find(k => k.toLowerCase() === oid.toLowerCase())] : null;
  if (id == null) return graphic;
  const res = await queryRobust(t, { objectIds: [id], outFields: ['*'], returnGeometry: true, outSpatialReference: view.spatialReference });
  return res.features?.[0] ?? graphic;
}

let traceRun = 0;                       // which results are showing, so a late page from an older trace isn't drawn
const kindOf = g => (g.type === 'multipoint' || g.type === 'point' ? 'point' : g.type === 'polyline' ? 'polyline' : 'polygon');
const oidValue = (a, name) => a?.[name] ?? a?.[Object.keys(a ?? {}).find(k => k.toLowerCase() === name.toLowerCase())];

/**
 * Draws a trace's results. The engine reads no geometry, so the shapes are read here by ObjectID, 500 at a time.
 * @returns the number drawn
 */
export async function showTraceResults(key, oidField, ids) {
  clearTrace();
  const run = traceRun;
  if (!oidField || !ids.length) return 0;
  const t = traceTarget(key);
  traceLayer = ensureLayer(traceLayer ?? new SDK.GraphicsLayer({ listMode: 'hide', title: 'Attribute trace' }));
  const [r, g, b] = selectionRgb();
  const symbols = {
    point: { type: 'simple-marker', size: 9, color: [r, g, b, 0.35], outline: { color: [r, g, b, 1], width: 1.25 } },
    polyline: { type: 'simple-line', color: [r, g, b, 0.95], width: 2.5 },
    polygon: { type: 'simple-fill', color: [r, g, b, 0.18], outline: { color: [r, g, b, 1], width: 1.5 } }
  };
  for (let i = 0; i < ids.length; i += 500) {
    const res = await queryRobust(t, { objectIds: ids.slice(i, i + 500), outFields: [oidField], returnGeometry: true, outSpatialReference: view.spatialReference });
    if (run !== traceRun) return 0;
    for (const f of res.features ?? []) {
      if (!f.geometry) continue;
      traceShapes.set(String(oidValue(f.attributes, oidField)), f.geometry);
      traceLayer.add(new SDK.Graphic({ geometry: f.geometry, symbol: symbols[kindOf(f.geometry)] }));
    }
  }
  return traceShapes.size;
}

/*
 * Two highlights can show at once, each in its own layer on top of the map, drawn the same way (emphasis.js):
 *   chosen     the chosen result of a spatial relationship, a trace or a search
 *   selection  the selected feature: clicked on the map or picked in Details, chosen in Select features or Editing,
 *              or the place Go to coordinates went to. Thin settings (no fill, no lift) draw the plain selection
 *              outline (selectionSymbols) instead of the bold one.
 * Each is filled in its colour (its own, or the selection colour) or outlined, lifted off the map in 3D like the Scene
 * window's extrusion (a raised top with shaded walls and a soft shadow, a layer effect; drawn without the shadow where
 * effects aren't supported), and flashed once the map has arrived.
 */
const slot = (title, thin) => ({ title, thin, layer: null, owner: null, flash: null, cur: null, watch: null });
const chosenSlot = slot('Chosen result', false);
const selectionSlot = slot('Selection', true);

/**
 * Show a geometry in a slot as its settings say.
 * @param zoom  true: zoom to it (emphasis.zoomScale); false: stay; a function: it moves the map and returns a promise
 * @returns its graphic (the shape as it is, for Details), or null when there's no shape
 */
function showIn(s, geometry, emphasis, { owner = null, zoom = true } = {}) {
  clearSlot(s);
  if (!geometry || !view) return null;
  const e = normalizeEmphasis(emphasis);
  if (!s.layer) s.layer = new SDK.GraphicsLayer({ listMode: 'hide', title: s.title });
  try { s.layer.effect = e.lift ? LIFT_EFFECT : null; } catch { /* no layer effects: no shadow */ }
  ensureLayer(s.layer);
  view.map.reorder(s.layer, view.map.layers.length - 1);          // above the results and the map's own layers
  if (s !== chosenSlot && chosenSlot.layer && view.map.layers.includes(chosenSlot.layer)) view.map.reorder(chosenSlot.layer, view.map.layers.length - 1);
  s.owner = owner;
  // The lift is a number of screen pixels, so it's raised once the map has arrived (flat while it moves) and drawn
  // again whenever the map settles at a new scale or rotation.
  s.cur = { geometry, e, raised: !zoom };
  drawSlot(s);
  if (e.lift) s.watch = SDK.reactiveUtils.when(() => view.stationary && [view.scale, view.rotation], () => { if (s.cur?.raised) drawSlot(s); });
  const graphic = new SDK.Graphic({ geometry });
  const arrived = () => {
    if (s.cur?.geometry !== geometry) return;
    if (!s.cur.raised) { s.cur.raised = true; drawSlot(s); }
    flashSlot(s, flashBeats(e));
  };
  if (typeof zoom === 'function') Promise.resolve(zoom()).then(arrived, arrived);
  else if (zoom) zoomToGraphic(graphic, e.zoomScale).then(arrived);
  else arrived();
  return graphic;
}

/** The chosen result of a spatial relationship, a trace or a search. @param owner 'spatial' | 'trace' | 'search' */
export function emphasise(geometry, emphasis, { owner, zoom = true } = {}) {
  return showIn(chosenSlot, geometry, emphasis, { owner, zoom });
}

/** Map units for `px` screen pixels straight up the screen, at the view's centre. */
function screenUp(px) {
  const x = view.width / 2, y = view.height / 2;
  const a = view.toMap({ x, y }), b = view.toMap({ x, y: y - px });
  return a && b ? [b.x - a.x, b.y - a.y] : null;
}

/** A point in the view's spatial reference (Go to coordinates gives longitude and latitude), so it can be lifted. */
function inViewSr(g) {
  if (!g || g.type !== 'point' || g.spatialReference?.equals?.(view.spatialReference)) return g;
  return view.toMap(view.toScreen(g)) ?? g;
}

function drawSlot(s) {
  if (!s.cur || !s.layer) return;
  s.layer.removeAll();
  const { e } = s.cur;
  const geometry = inViewSr(s.cur.geometry);
  const rgb = emphasisRgb(e, selectionRgb());
  const kind = kindOf(geometry);
  if (s.thin && isThin(e)) {
    s.layer.add(new SDK.Graphic({ geometry, symbol: selectionSymbols(rgb, manifest?.branding?.selectionLine || 'solid')[kind] }));
    return;
  }
  const sym = emphasisSymbols(rgb, e);
  const liftable = ['point', 'multipoint', 'polygon', 'polyline'].includes(geometry.type);
  const up = e.lift && s.cur.raised && liftable && geometry.spatialReference?.equals?.(view.spatialReference) ? screenUp(e.liftHeight) : null;
  const add = (g, symbol) => s.layer.add(new SDK.Graphic({ geometry: { ...g, spatialReference: geometry.spatialReference }, symbol }));
  if (!up) { s.layer.add(new SDK.Graphic({ geometry, symbol: sym[kind] })); return; }

  if (kind === 'point') {
    // An upright column, as the Scene draws points: a shaft from the spot up to the marker.
    const pts = geometry.type === 'multipoint' ? geometry.points : [[geometry.x, geometry.y]];
    for (const [x, y] of pts) {
      add({ type: 'polyline', paths: [[[x, y], [x + up[0], y + up[1]]]] }, { type: 'simple-line', color: [...shadeRgb(rgb, 0.6), e.highlight ? e.fillOpacity : 1], width: e.highlight ? 5 : 2 });
      add({ type: 'point', x: x + up[0], y: y + up[1] }, sym.point);
    }
    return;
  }
  const { walls, top } = extrusion(kind, kind === 'polygon' ? geometry.rings : geometry.paths, up);
  const edge = { color: EDGE_RGBA, width: 0.5 };
  for (const w of walls) {
    add({ type: 'polygon', rings: [w.ring] }, e.highlight
      ? { type: 'simple-fill', color: [...shadeRgb(rgb, w.shade), e.fillOpacity], outline: edge }   // as see-through as the top
      : { type: 'simple-fill', color: [0, 0, 0, 0], outline: { color: [...rgb, 1], width: 1.25 } });
  }
  add(kind === 'polygon' ? { type: 'polygon', rings: top } : { type: 'polyline', paths: top }, sym[kind]);
}

/** Blink a slot's layer through its beats, ending fully shown. */
function flashSlot(s, beats) {
  clearTimeout(s.flash);
  const layer = s.layer;
  let i = 0;
  const step = () => {
    if (!layer) return;
    if (i >= beats.length) { layer.opacity = 1; s.flash = null; return; }
    layer.opacity = beats[i++];
    s.flash = setTimeout(step, 180);
  };
  step();
}

/** Empty a slot (only when its owner is the one named, if one is). */
function clearSlot(s, owner) {
  if (owner && s.owner !== owner) return;
  clearTimeout(s.flash);
  s.flash = null;
  s.owner = null;
  s.cur = null;
  s.watch?.remove();
  s.watch = null;
  if (s.layer) { s.layer.removeAll(); s.layer.opacity = 1; }
}

/** Remove the chosen result (only that owner's, when one is named). */
function clearChosen(owner) { clearSlot(chosenSlot, owner); }

/** A trace result by its ObjectID, emphasised. @returns its graphic, or null when its shape isn't drawn */
export function selectTraceResult(id, { zoom = true, emphasis } = {}) {
  return emphasise(traceShapes.get(String(id)), emphasis, { owner: 'trace', zoom });
}

/** A spatial relationship's result row, emphasised as its section says. */
export function selectSpatialResult(graphic, emphasis) {
  return emphasise(graphic?.geometry, emphasis, { owner: 'spatial' });
}

/** A search result (from the attribute search or the search box), emphasised as its search says. */
export function selectSearchResult(graphic, emphasis, { zoom = true } = {}) {
  clearHighlight();
  return emphasise(graphic?.geometry, emphasis, { owner: 'search', zoom });
}

/** Remove the chosen search result, if that's what is chosen. */
export function clearSearchResult() { clearChosen('search'); }

/** The address chosen in Address audit's results, no longer standing out. */
export function clearAuditResult() { clearChosen('audit'); }

/** Zoom to every result drawn. */
export function zoomToTrace() {
  if (traceShapes.size) zoomToGraphics([...traceShapes.values()].map(geometry => ({ geometry })));
}

/** Clears the results and the chosen one; nothing else on the map changes. */
export function clearTrace() {
  traceRun++;
  traceShapes.clear();
  traceLayer?.removeAll();
  clearChosen('trace');
}

/* ---------------- Streaming, Cameras and Drones: stream markers ---------------- */
/**
 * Mark where each located stream is. kind 'cameras' draws circles, 'drones' diamonds; the playing one is larger.
 * @param streams  manifest streams; those without a [longitude, latitude] location are left out
 */
export function showStreamMarkers(kind, streams, selectedId = null) {
  if (!view?.map) return;
  streamLayer = ensureLayer(streamLayer ?? new SDK.GraphicsLayer({ listMode: 'hide', title: 'Stream locations' }));
  streamLayer.removeAll();
  const [r, g, b] = accentRgb;
  const located = streams.filter(s => Array.isArray(s.location) && s.location.length === 2);
  // The playing stream last, so it's drawn on top.
  located.sort((a, z) => (a.id === selectedId) - (z.id === selectedId));
  streamLayer.addMany(located.map(s => new SDK.Graphic({
    geometry: { type: 'point', longitude: s.location[0], latitude: s.location[1] },
    attributes: { streamId: s.id },
    symbol: {
      type: 'simple-marker', style: kind === 'drones' ? 'diamond' : 'circle', size: s.id === selectedId ? 20 : 13,
      color: s.id === selectedId ? [r, g, b, 1] : [r, g, b, 0.75], outline: { color: [255, 255, 255, 1], width: 2 }
    }
  })));
}

export function clearStreamMarkers() { streamLayer?.removeAll(); }

/** The id of the stream marker within a few pixels of a map click, or null. */
export function streamMarkerAt(mapPoint, tolerancePx = 12) {
  if (!view || !streamLayer?.graphics.length) return null;
  const at = view.toScreen(mapPoint);
  let best = null, bestD = tolerancePx;
  for (const gr of streamLayer.graphics) {
    const p = view.toScreen(gr.geometry);
    const d = Math.hypot(p.x - at.x, p.y - at.y);
    if (d <= bestD) { best = gr.attributes.streamId; bestD = d; }
  }
  return best;
}

/** Zoom to a [longitude, latitude] (Show on map). */
export function goToLonLat([lon, lat]) {
  if (!view) return;
  view.goTo({ center: [lon, lat], zoom: Math.max(view.zoom, 15) }).catch(() => {});
}

/* ---------------- Tools: select by shape, go to coordinates, drawings ---------------- */
const thinSymbols = () => {
  const [r, g, b] = selectionRgb();
  return {
    polygonSymbol: { type: 'simple-fill', color: [r, g, b, 0.08], outline: { color: [r, g, b, 0.9], width: 1.25, style: 'dash' } },
    polylineSymbol: { type: 'simple-line', color: [r, g, b, 0.9], width: 1.5, style: 'dash' },
    pointSymbol: { type: 'simple-marker', size: 9, color: [r, g, b, 0.15], outline: { color: [r, g, b, 0.9], width: 1.25 } }
  };
};

function ensureLayer(layer) {
  if (layer && !view.map.layers.includes(layer)) view.map.add(layer);
  return layer;
}

/** Let the user draw a shape; resolves with its geometry, or null if cancelled. */
export function drawShape(shape) {
  cancelShape();
  shapeLayer = ensureLayer(shapeLayer ?? new SDK.GraphicsLayer({ listMode: 'hide', title: 'Selection shape' }));
  shapeVM = new SDK.SketchViewModel({ view, layer: shapeLayer, ...thinSymbols() });
  shapeDrawing = true;
  applyCursor();
  return new Promise(resolve => {
    const done = geometry => { shapeDrawing = false; applyCursor(); resolve(geometry); };
    shapeVM.on('create', e => {
      if (e.state === 'complete') done(e.graphic.geometry);
      if (e.state === 'cancel') done(null);
    });
    shapeVM.create(shape);
  });
}

export function cancelShape() {
  try { shapeVM?.cancel(); shapeVM?.destroy(); } catch { /* already gone */ }
  shapeVM = null;
  shapeLayer?.removeAll();
  shapeDrawing = false;
  applyCursor();
}

/** Features of the chosen layers (empty = every showing layer) that intersect a geometry. */
export async function selectFeatures(geometry, layerKeys = []) {
  const list = targets().filter(t => !layerKeys.length || layerKeys.includes(t.key));
  return queryTargets(list, {
    geometry: geometry.type === 'point' ? clickBox(geometry) : geometry,
    spatialRelationship: 'intersects', outFields: ['*'], returnGeometry: true,
    num: CONFIG.searchMaxResults, outSpatialReference: view.spatialReference
  });
}

export function goToXY(lat, lon, zoom) {
  if (!view) return;
  const point = new SDK.Graphic({ geometry: { type: 'point', longitude: lon, latitude: lat } }).geometry;
  // Its own zoom (the tool's); the place stands out as Go to coordinates' settings say once the map has arrived.
  highlight({ geometry: point }, { emphasis: manifest?.widgets?.toolConfig?.['go-to-xy']?.emphasis, zoom: () => view.goTo({ target: point, zoom }).catch(() => {}) });
}

/**
 * Screenshot of the map (layers and graphics, not the panel or SDK widgets) as a data URL.
 * With an extent, only that rectangle of the screen is captured.
 */
export async function screenshot(format = 'png', extent = null) {
  if (!view) throw new Error('The map is still loading.');
  const opts = { format, quality: 92 };
  if (extent) {
    const a = view.toScreen({ type: 'point', x: extent.xmin, y: extent.ymax, spatialReference: extent.spatialReference });
    const b = view.toScreen({ type: 'point', x: extent.xmax, y: extent.ymin, spatialReference: extent.spatialReference });
    const x = Math.max(0, Math.round(Math.min(a.x, b.x))), y = Math.max(0, Math.round(Math.min(a.y, b.y)));
    const width = Math.min(view.width - x, Math.round(Math.abs(b.x - a.x))), height = Math.min(view.height - y, Math.round(Math.abs(b.y - a.y)));
    if (width < 4 || height < 4) throw new Error('That area is too small. Drag a bigger rectangle.');
    opts.area = { x, y, width, height };
  }
  return flatten((await view.takeScreenshot(opts)).dataUrl, format);
}

/**
 * The WebGL canvas can give back see-through pixels. They look fine on the white panel but most image viewers
 * show them as black, so the picture is drawn onto solid white before it's downloaded.
 */
async function flatten(dataUrl, format) {
  const img = new Image();
  img.src = dataUrl;
  await img.decode();
  const canvas = document.createElement('canvas');
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(img, 0, 0);
  return format === 'jpg' ? canvas.toDataURL('image/jpeg', 0.92) : canvas.toDataURL('image/png');
}

/** The Draw tool's layer (created on first use, listed in Layers as "Drawings"). */
export function getSketchLayer() {
  sketchLayer = ensureLayer(sketchLayer ?? new SDK.GraphicsLayer({ title: 'Drawings' }));
  return sketchLayer;
}

export const accentSymbols = (hex) => {
  const [r, g, b] = hexToRgb(hex);
  return {
    polygonSymbol: { type: 'simple-fill', color: [r, g, b, 0.15], outline: { color: [r, g, b, 1], width: 1.5 } },
    polylineSymbol: { type: 'simple-line', color: [r, g, b, 1], width: 2 },
    pointSymbol: { type: 'simple-marker', size: 9, color: [r, g, b, 0.9], outline: { color: [255, 255, 255, 1], width: 1 } }
  };
};

/* ---------------- Selection highlight: thin, single colour ---------------- */
/** True when an aerial or imagery basemap or layer is showing (switched on and in scale). */
function imageryShowing() {
  const map = view?.map;
  if (!map) return false;
  const base = map.basemap;
  if (base && (isImageryName(base.id, base.title) ||base.baseLayers?.some(l => l.visible && looksLikeImagery(l)))) return true;
  return operationalLayers().some(l => looksLikeImagery(l) && layerShowing(l));
}

/** The selection colour: branding.selectionOnImagery while an aerial is showing, otherwise the accent. */
const selectionRgb = () => (imageryRgb !== accentRgb && imageryShowing() ? imageryRgb : accentRgb);
/** The selection colour now, [r, g, b] (tools that draw their own marks in it). */
export const selectionColour = () => selectionRgb();

/** Redraw what's selected (highlight, spatial outlines, the shape being drawn) in the current selection colour. */
function recolourSelection() {
  drawSlot(selectionSlot);
  drawSlot(chosenSlot);
  const sym = thinSymbols();
  for (const gr of spatialLayer?.graphics?.toArray() ?? []) {
    const t = gr.geometry?.type;
    gr.symbol = t === 'point' || t === 'multipoint' ? sym.pointSymbol : t === 'polyline' ? sym.polylineSymbol : sym.polygonSymbol;
  }
  if (shapeVM) Object.assign(shapeVM, sym);
}

/**
 * The selected feature, standing out as its settings say: emphasis (Select features, Editing, Go to coordinates), or
 * widgets.detailsEmphasis for a feature clicked on the map or picked in Details.
 * @param zoom  as showIn: true zooms to it (its zoomScale), or a function that moves the map
 */
export function highlight(graphic, { emphasis = null, zoom = false } = {}) {
  clearHighlight();
  const g = graphic?.geometry;
  if (!g || !view) return;
  lastHighlight = g;
  showIn(selectionSlot, g, emphasis ?? manifest?.widgets?.detailsEmphasis ?? plainEmphasis(), { owner: 'selection', zoom });
}

export function clearHighlight() { lastHighlight = null; clearSlot(selectionSlot); }

/** The selected (highlighted) feature's geometry, or null: Vegetation health measures a selected parcel with it. */
export const highlightedGeometry = () => lastHighlight;

/** @returns a promise that settles when the map has arrived (or the move was interrupted) */
/** scale: a map scale to zoom to, centred on the graphic (0 = fit it; a point: street level). */
export function zoomToGraphic(graphic, scale = 0) {
  const g = graphic?.geometry;
  if (!g || !view) return Promise.resolve();
  if (scale > 0) return view.goTo({ target: g.type === 'point' ? g : g.extent?.center ?? g, scale }).catch(() => {});
  const target = g.type === 'point' ? { target: g, zoom: Math.max(view.zoom, 17) } : g.extent?.clone().expand(1.6) ?? g;
  return view.goTo(target).catch(() => {});
}

/* ---------------- Editing: records of a feature service layer (editWindow.js draws the forms) ---------------- */
/** The web map's feature layer for an editing layer key (the operational layer id). */
async function editLayer(key) {
  await ready;
  const layer = view.map?.allLayers.find(l => l.id === key);
  if (!layer || layer.type !== 'feature') throw new Error('That layer is no longer in the map, or it isn\'t a feature layer.');
  await layer.load();
  return layer;
}

const editWhere = layer => layer.definitionExpression || '1=1';

/**
 * What a layer offers the editor: its fields (SDK Field objects: domain, length, nullable, editable, defaultValue),
 * ObjectID field, geometry type and what the service allows.
 */
export async function editLayerInfo(key) {
  const layer = await editLayer(key);
  return {
    title: layer.title, fields: layer.fields ?? [], objectIdField: layer.objectIdField, globalIdField: layer.globalIdField,
    editFieldsInfo: layer.editFieldsInfo?.toJSON?.() ?? null, geometryType: layer.geometryType,
    capabilities: layer.capabilities, editingEnabled: layer.editingEnabled !== false
  };
}

/**
 * Records of a layer inside the map's current view (the part not covered by the editing window: see setViewPadding),
 * newest ObjectIDs first. @returns { features, total, truncated }
 */
export async function queryEditRecords(key, max = 200) {
  const layer = await editLayer(key);
  const oid = layer.objectIdField;
  const base = { geometry: view.extent, spatialRelationship: 'intersects', where: editWhere(layer) };
  const full = { ...base, outFields: ['*'], returnGeometry: true, num: max, orderByFields: [`${oid} DESC`], outSpatialReference: view.spatialReference };
  const [count, res] = await Promise.all([
    layer.queryFeatureCount(base).catch(() => null),
    // Some servers refuse a sort or a record limit: ask plainly, then sort and trim here.
    layer.queryFeatures(full).catch(() => layer.queryFeatures({ ...base, outFields: ['*'], returnGeometry: true, outSpatialReference: view.spatialReference }))
  ]);
  const features = [...(res.features ?? [])].sort((a, b) => (b.attributes?.[oid] ?? 0) - (a.attributes?.[oid] ?? 0)).slice(0, max);
  const total = Math.max(count ?? 0, features.length);
  return { features, total, truncated: total > features.length || (count == null && res.exceededTransferLimit === true) };
}

/** The layer's record at a map point (a click while editing), or null. */
export async function editRecordAt(key, mapPoint) {
  const layer = await editLayer(key);
  const res = await layer.queryFeatures({
    geometry: clickBox(mapPoint), spatialRelationship: 'intersects', where: editWhere(layer),
    outFields: ['*'], returnGeometry: true, num: 1, outSpatialReference: view.spatialReference
  });
  return res.features?.[0] ?? null;
}

/**
 * Save one change through the layer (the signed-in person's token is used; the service's editor tracking applies).
 * change: { add: { geometry, attributes } } | { update: attributes (with the ObjectID) } | { remove: objectId }
 * @returns { objectId }
 */
export async function saveEdit(key, change) {
  const layer = await editLayer(key);
  const edits = change.add ? { addFeatures: [new SDK.Graphic({ geometry: change.add.geometry, attributes: change.add.attributes })] }
    : change.update ? { updateFeatures: [new SDK.Graphic({ attributes: change.update })] }
    : { deleteFeatures: [{ objectId: change.remove }] };
  let r;
  try { r = await layer.applyEdits(edits); }
  catch (e) { throw new Error(isAuthError(e) ? 'You need to sign in with an account that may edit this layer.' : e.message || 'The server refused the change.'); }
  const results = [...(r.addFeatureResults ?? []), ...(r.updateFeatureResults ?? []), ...(r.deleteFeatureResults ?? [])];
  const failed = results.find(x => x.error);
  if (failed) throw new Error(failed.error.message || 'The server refused the change.');
  return { objectId: results[0]?.objectId ?? null };
}

/* ---------------- Label orientation: street lines, house number points, saving angles ---------------- */
const GEOMETRY_TYPES = { esriGeometryPoint: 'point', esriGeometryMultipoint: 'multipoint', esriGeometryPolyline: 'polyline', esriGeometryPolygon: 'polygon' };

/** Every queryable layer in the map now (web map layers and layers added this session), top-first: [{ key, title, geometryType }]. */
export const labelLayers = () => (view ? targets({ onlyShowing: false }).map(t => ({ key: t.key, title: t.title, geometryType: GEOMETRY_TYPES[t.geometryType] ?? t.geometryType ?? null })) : []);

/**
 * What the Label orientation tool needs to know about a layer: geometry, fields, ObjectID field, and whether angles
 * can be saved to it. Only a feature service layer the service lets people update can be saved to; anything else
 * (map image sublayers, GeoJSON, CSV, files, read-only layers) gets labels drawn on the map for the session.
 * @returns { key, title, geometryType, fields, objectIdField, editable, why }
 */
export async function labelLayerInfo(key) {
  const t = getTarget(key);
  if (!t) throw new Error('That layer is no longer in the map.');
  const fl = await t.searchLayer();
  await fl.load?.();
  const layer = t.source.layer;
  const why = t.source.sub ? 'it is part of a map image service, which can\'t be edited'
    : layer.type !== 'feature' ? `it is a ${layer.type === 'subtype-group' ? 'subtype group' : layer.type} layer, not a feature layer`
    : !layer.url ? 'it is a file or collection held in this browser, not a feature service'
    : layer.editingEnabled === false || layer.capabilities?.operations?.supportsUpdate !== true ? 'the service doesn\'t allow updates'
    : null;
  return {
    key, title: t.title, geometryType: GEOMETRY_TYPES[fl.geometryType] ?? fl.geometryType,
    fields: fl.fields ?? [], objectIdField: fl.objectIdField, editable: !why, why
  };
}

/** Features of a layer that touch a geometry (a point becomes a click-sized box), in the view's spatial reference. */
export async function queryLayerAt(key, geometry, { outFields = ['*'], max = CONFIG.searchMaxResults } = {}) {
  const t = getTarget(key);
  if (!t) throw new Error('That layer is no longer in the map.');
  const res = await queryRobust(t, {
    geometry: geometry.type === 'point' ? clickBox(geometry) : geometry, spatialRelationship: 'intersects',
    outFields, returnGeometry: true, num: max, outSpatialReference: view.spatialReference
  });
  return res.features ?? [];
}

/** Features of a layer in the part of the map people can see. */
export const queryLayerInView = (key, options) => queryLayerAt(key, view.extent, options);

const notIn = (field, ids) => `${field} NOT IN (${ids.map(Number).filter(Number.isFinite).join(',')})`;

/**
 * Hide some features of a layer (and their labels), so labels drawn over them don't double up; an empty list shows
 * them all again. Feature layers are filtered in the browser; a map image sublayer gets a definition expression.
 * Tiled layers can't hide single features and are left as they are.
 */
let hiding = Promise.resolve();
export function setHidden(key, objectIds = []) {
  hiding = hiding.then(() => applyHidden(key, objectIds)).catch(e => console.warn('Label orientation: hiding features failed', e));
  return hiding;
}

// One change at a time: each one restores the previous filter before setting its own.
async function applyHidden(key, objectIds) {
  const prev = hidden.get(key);
  if (prev) { hidden.delete(key); prev(); }
  if (!objectIds.length) return;
  const t = getTarget(key);
  if (!t) return;
  const { layer, sub } = t.source;
  const oid = (await t.searchLayer()).objectIdField;
  if (!oid) return;
  if (sub) {
    if (layer.type !== 'map-image') return;
    const original = sub.definitionExpression;
    sub.definitionExpression = original ? `(${original}) AND ${notIn(oid, objectIds)}` : notIn(oid, objectIds);
    hidden.set(key, () => { sub.definitionExpression = original; });
    return;
  }
  const lv = await view.whenLayerView(layer).catch(() => null);
  if (!lv || !('filter' in lv)) return;
  const original = lv.filter;
  lv.filter = { where: original?.where ? `(${original.where}) AND ${notIn(oid, objectIds)}` : notIn(oid, objectIds) };
  hidden.set(key, () => { lv.filter = original; });
}

/* ---------------- Legend labels: counts in a categorized style's labels ---------------- */

/** Resolves once the map has drawn what it first shows, so later work never competes with the first draw. */
export const whenDrawn = () => (view ? SDK.reactiveUtils.whenOnce(() => !view.updating) : Promise.resolve());

/**
 * A layer whose style Legend labels and Layer styles may replace: a feature, GeoJSON or CSV layer (styled in the browser),
 * or a map image sublayer (its style then goes with the map image requests as a dynamic layer, which the service must
 * allow). Only the renderer changes; the layer stays as it is. Null when the key isn't in the map; { title, why } when
 * the layer can't be restyled.
 * @returns {{ title, objectIdField, fields, geometryType, renderer(): json|null, setRenderer(json), showing(): boolean, query(params), overlay }}
 *   fields: the layer's fields as the service gave them to this person.
 *   overlay: { show(json, title), hide(), layer() } for drawing a style over the layer (styleOverlay), or null when it can't.
 *   showing: the map is on screen and the layer is switched on and in scale (counts are only read then).
 */
export async function styleLayer(key) {
  const t = getTarget(key);
  if (!t) return null;
  const { layer, sub } = t.source;
  const fl = await t.searchLayer();
  await fl.load?.();
  const toJSON = r => r?.toJSON?.() ?? null;
  const fromJSON = json => SDK.rendererJsonUtils.fromJSON(json);
  if (sub) {
    if (layer.type !== 'map-image') return { title: t.title, why: 'it is drawn from map tiles, which carry their style in the images' };
    if (layer.capabilities?.exportMap?.supportsDynamicLayers === false) return { title: t.title, why: "its map service doesn't allow dynamic layers, which changing a sublayer's style needs" };
    return {
      title: t.title, objectIdField: fl.objectIdField, fields: fl.fields ?? [], geometryType: fl.geometryType ?? sub.geometryType ?? null,
      renderer: () => toJSON(sub.renderer ?? fl.renderer),
      setRenderer: json => { sub.renderer = fromJSON(json); },
      showing: () => !view.suspended && sublayerShowing(layer, sub),
      query: p => t.query({ where: sub.definitionExpression || '1=1', ...p }),
      overlay: layer.url ? styleOverlay(key, layer, sub) : null
    };
  }
  if (!FEATURE_LIKE.has(layer.type)) return { title: t.title, why: `it is a ${layer.type} layer` };
  return {
    title: t.title, objectIdField: layer.objectIdField ?? fl.objectIdField, fields: layer.fields ?? [], geometryType: layer.geometryType ?? null,
    renderer: () => toJSON(layer.renderer),
    setRenderer: json => { layer.renderer = fromJSON(json); },
    showing: () => !view.suspended && layerShowing(layer),
    query: p => t.query(p),
    overlay: layer.type === 'feature' && layer.url ? styleOverlay(key, layer, null) : null
  };
}

/**
 * Layer styles: a display-only copy of a layer (or of a map service sublayer), drawn just above it with a style's
 * colours and blended (multiply) so the layer's own outlines show through. Made the first time it's shown. It isn't
 * in the Layers list, Details or Search (its id starts "style-"), and follows the layer's visibility, opacity, scale
 * range and filter. While it shows it fetches its own features for what's in view (only the style's field).
 */
function styleOverlay(key, layer, sub) {
  let ov = null, on = false;
  const src = sub ?? layer;
  const sync = () => {
    if (!ov) return;
    ov.visible = on && (sub ? sublayerVisible(layer, sub) : layer.visible);
    ov.opacity = layer.opacity * (sub?.opacity ?? 1);
    ov.minScale = src.minScale ?? 0;
    ov.maxScale = src.maxScale ?? 0;
    ov.definitionExpression = src.definitionExpression || null;
  };
  const create = () => {
    ov = new SDK.FeatureLayer({
      ...(sub ? { url: `${String(layer.url).replace(/\/+$/, '')}/${sub.id}` } : { url: layer.url, layerId: layer.layerId }),
      id: `${STYLE_OVERLAY}${key}`, listMode: 'hide', popupEnabled: false, labelsVisible: false, blendMode: 'multiply', visible: false
    });
    let placing = false;
    const place = () => {                         // directly above the layer, also after people drag layers
      const coll = layer.parent?.layers;
      const at = coll?.indexOf(layer) ?? -1;
      if (placing || at < 0 || coll.indexOf(ov) === at + 1) return;
      placing = true;
      if (coll.includes(ov)) coll.reorder(ov, coll.indexOf(ov) < at ? at : at + 1); else coll.add(ov, at + 1);
      placing = false;
    };
    place();
    styleOverlays.push({
      layer: ov,
      handles: [
        layer.parent?.layers?.on('change', place),
        SDK.reactiveUtils.watch(() => [layer.visible, layer.opacity, src.visible, src.opacity, src.minScale, src.maxScale, src.definitionExpression], sync)
      ]
    });
  };
  return {
    show(json, title) {
      if (!ov) create();
      ov.renderer = SDK.rendererJsonUtils.fromJSON(json);
      ov.title = title;
      on = true;
      sync();
    },
    hide() { on = false; sync(); },
    layer: () => (on ? ov : null)
  };
}

/**
 * Write one number field on many features in one request (the Label orientation tool's angles).
 * @param values [{ objectId, value }]
 * @returns { saved, failed: [{ objectId, message }] }
 */
export async function saveFieldValues(key, field, values) {
  const layer = await editLayer(key);
  const oid = layer.objectIdField;
  let r;
  try { r = await layer.applyEdits({ updateFeatures: values.map(v => new SDK.Graphic({ attributes: { [oid]: v.objectId, [field]: v.value } })) }); }
  catch (e) { throw new Error(isAuthError(e) ? 'You need to sign in with an account that may edit this layer.' : e.message || 'The server refused the change.'); }
  const results = r.updateFeatureResults ?? [];
  const failed = results.filter(x => x.error).map(x => ({ objectId: x.objectId, message: x.error.message || 'refused' }));
  layer.refresh?.();
  return { saved: results.length - failed.length, failed };
}

/* ---------------- Dimensions: line and polygon layers measured in view ---------------- */

/**
 * A layer the Dimensions tool measures. Null when the key isn't in the map.
 * state() follows the layer as the map draws it: 'hidden' (switched off, here or in a group, or the map is off
 * screen), 'out-of-scale' (outside its own scale range or a group's), else 'showing'. It reads SDK properties, so a
 * reactiveUtils.watch on it fires when the layer is switched on or off or zooming crosses its scale range.
 * @returns {{ title, geometryType, state(), query(params) }}
 */
export function dimensionLayer(key) {
  const t = getTarget(key);
  if (!t) return null;
  const { layer, sub } = t.source;
  const visible = () => (sub ? sublayerVisible(layer, sub) : layerVisible(layer));
  const inRange = () => (sub ? sublayerInScale(layer, sub) : layerInScale(layer));
  return {
    title: t.title, geometryType: GEOMETRY_TYPES[t.geometryType] ?? t.geometryType ?? null,
    state: () => (view.suspended || !visible() ? 'hidden' : !inRange() ? 'out-of-scale' : 'showing'),
    query: p => queryRobust(t, p)
  };
}

/** Call back whenever the map comes to rest after a pan or zoom (on a replaced view too). Returns a function that stops it. */
export function onViewChange(callback) {
  if (!view) return () => {};
  const w = { callback, handle: null };
  viewWatchers.add(w);
  watchView(w);
  return () => { w.handle?.remove(); viewWatchers.delete(w); };
}

function watchView(w) {
  w.handle?.remove();
  const v = view;
  w.handle = SDK.reactiveUtils.when(() => v.stationary, () => w.callback());
}

let windowPadding = {};                 // the window over the map's padding (setViewPadding)
let dockPadding = 0;                    // Details / Search docked at the bottom (setDockPadding)

function applyPadding() {
  if (view) view.padding = { top: 0, left: 0, right: 0, ...windowPadding, bottom: Math.max(windowPadding.bottom ?? 0, dockPadding) };
}

/**
 * Keep part of the map clear of a window over it: the view's centre, extent and goTo use the rest.
 * padding: { left, right, top, bottom } in pixels; {} clears it. Results docked at the bottom stay padded.
 */
export function setViewPadding(padding = {}) {
  windowPadding = { ...padding };
  applyPadding();
}

/** Details or Search docked along the bottom of the map: its height in pixels (0 when it closes). */
export function setDockPadding(bottom = 0) {
  dockPadding = Math.max(0, Math.round(bottom) || 0);
  applyPadding();
}

/* ---------------- Pointer coordinates ---------------- */
function setCoordinatesVisible(on) {
  if (!view) return;
  if (!on) {
    pointerHandle?.remove(); pointerHandle = null;
    if (coordsNode) view.ui.remove(coordsNode);
    return;
  }
  if (!coordsNode) {
    coordsNode = document.createElement('div');
    coordsNode.className = 'coords';
    coordsNode.textContent = 'Move the pointer over the map';
  }
  view.ui.add(coordsNode, 'bottom-left');
  pointerHandle ??= view.on('pointer-move', e => {
    const p = view.toMap({ x: e.x, y: e.y });
    if (p) coordsNode.textContent = formatLatLon(p.latitude, p.longitude, coordsFormat);
  });
}

/* ---------------- Add data: layers people add for this session ---------------- */
let addedSeq = 0;

function forgetAdded() {
  for (const a of added.values()) if (a.blobUrl) URL.revokeObjectURL(a.blobUrl);
  added.clear();
}

/** Add a layer on top of the map, wait for it to load, zoom to it, and remember it. */
async function addLayer(layer, source, blobUrl = null) {
  try {
    await layer.load();
  } catch (e) {
    if (blobUrl) URL.revokeObjectURL(blobUrl);
    throw new Error(isAuthError(e) ? 'This layer is secured. Sign in to its portal or server first.' : `The layer didn't load: ${e.message}`);
  }
  view.map.add(layer);
  const id = `added-${++addedSeq}`;
  added.set(id, { layer, title: layer.title || 'Added layer', source, blobUrl });
  const ext = layer.fullExtent;
  if (ext && ext.width > 0) view.goTo(ext.clone().expand(1.2)).catch(() => {});
  else if (ext) view.goTo(ext.center).catch(() => {});
  return { id, title: added.get(id).title, source };
}

/** A portal item (Feature Service, Map Service, Vector Tile Service, CSV item…). */
export async function addPortalItem(item, portalUrl) {
  await ready;
  let layer;
  try { layer = await SDK.Layer.fromPortalItem({ portalItem: { id: item.id, portal: { url: portalUrl } } }); }
  catch (e) { throw new Error(isAuthError(e) ? 'This item is secured. Sign in to the portal first.' : `"${item.title}" can't be added to a map: ${e.message}`); }
  return addLayer(layer, item.type);
}

/**
 * A URL: an ArcGIS REST service or layer (…/FeatureServer, …/MapServer/2, …/ImageServer, …/VectorTileServer),
 * or a GeoJSON / CSV file on the web.
 */
export async function addFromUrl(url) {
  await ready;
  const u = new URL(url);
  if (u.protocol !== 'https:') throw new Error('Use an https:// link.');
  const path = u.pathname.toLowerCase();
  if (/\/rest\/services\//.test(path)) {
    let layer;
    try { layer = await SDK.Layer.fromArcGISServerUrl({ url: u.href }); }
    catch (e) { throw new Error(isAuthError(e) ? 'This service is secured. Sign in to its server first.' : `That service couldn't be read: ${e.message}`); }
    return addLayer(layer, 'ArcGIS service');
  }
  if (/\.(geo)?json$/.test(path)) return addLayer(new SDK.GeoJSONLayer({ url: u.href, title: decodeURIComponent(u.pathname.split('/').pop()) }), 'GeoJSON');
  if (/\.csv$/.test(path)) return addLayer(new SDK.CSVLayer({ url: u.href, title: decodeURIComponent(u.pathname.split('/').pop()) }), 'CSV');
  throw new Error('Paste an ArcGIS REST service link (…/rest/services/…/FeatureServer, MapServer, ImageServer or VectorTileServer), or a link to a .geojson or .csv file.');
}

/** A CSV (with latitude/longitude columns) or GeoJSON file from the person's computer. Read in the browser only. */
export async function addLocalFile(file) {
  await ready;
  const title = file.name.replace(/\.[^.]+$/, '');
  const blobUrl = URL.createObjectURL(file);
  if (/\.csv$/i.test(file.name)) return addLayer(new SDK.CSVLayer({ url: blobUrl, title }), 'CSV file', blobUrl);
  if (/\.(geo)?json$/i.test(file.name)) return addLayer(new SDK.GeoJSONLayer({ url: blobUrl, title }), 'GeoJSON file', blobUrl);
  URL.revokeObjectURL(blobUrl);
  throw new Error('Choose a .csv, .geojson or zipped shapefile (.zip).');
}

/** A feature collection from the portal's generate operation (zipped shapefile): one layer per shapefile layer. */
export async function addFeatureCollection(fc, title) {
  await ready;
  const parts = fc?.featureCollection?.layers ?? [];
  if (!parts.length) throw new Error('The shapefile has no features.');
  const out = [];
  for (const part of parts) {
    const def = part.layerDefinition ?? {};
    const fields = (def.fields ?? []).map(f => SDK.Field.fromJSON(f));
    const oid = fields.find(f => f.type === 'oid')?.name ?? 'FID';
    const layer = new SDK.FeatureLayer({
      title: parts.length > 1 ? `${title}: ${def.name || 'layer'}` : title,
      source: (part.featureSet?.features ?? []).map(f => SDK.Graphic.fromJSON(f)),
      fields, objectIdField: oid,
      geometryType: { esriGeometryPoint: 'point', esriGeometryMultipoint: 'multipoint', esriGeometryPolyline: 'polyline', esriGeometryPolygon: 'polygon' }[def.geometryType],
      spatialReference: part.featureSet?.spatialReference ?? { wkid: 102100 },
      ...(def.drawingInfo?.renderer ? { renderer: SDK.rendererJsonUtils.fromJSON(def.drawingInfo.renderer) } : {})
    });
    out.push(await addLayer(layer, 'Shapefile'));
  }
  return out;
}

export function removeAdded(id) {
  const a = added.get(id);
  if (!a) return;
  view?.map?.remove(a.layer);
  a.layer.destroy?.();
  if (a.blobUrl) URL.revokeObjectURL(a.blobUrl);
  added.delete(id);
}

export function zoomToAdded(id) {
  const ext = added.get(id)?.layer.fullExtent;
  if (ext) view.goTo(ext.width > 0 ? ext.clone().expand(1.2) : ext.center).catch(() => {});
}

export const listAdded = () => [...added].map(([id, a]) => ({ id, title: a.title, source: a.source }));
