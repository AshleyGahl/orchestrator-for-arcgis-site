// trackingLayers.js — draws the Streaming widget's tracking feeds on the map and keeps them up to date:
//   stream          an ArcGIS StreamLayer: the service pushes positions over a WebSocket; trails through its trackInfo
//   feature         an ArcGIS FeatureLayer read again every refreshSeconds (the SDK's refreshInterval)
//   geojson, json   fetched every refreshSeconds by the viewer (not while the browser tab is hidden) and drawn as
//                   graphics, with each object's recent track behind it (tracking.js readPositions, mergeTracks)
// Every feed keeps a list of its objects (id, label, position, values) for the Tracking pane, which also selects one
// (a ring on the map) and can follow it. The layers stay out of the Layers list, the Legend and Details (map.js skips
// ids starting "tracking-"). Owns its timers and layers; reset() on every new manifest.
import * as map from './map.js';
import * as api from './api.js';
import { readPositions, mergeTracks, trackPaths, hasTrail, OBJECTS_MAX } from './tracking.js';

export const LAYER_PREFIX = 'tracking-';
const TICK_MS = 1500;                    // stream and feature layers: read the objects at most this often

const feeds = new Map();                 // feed id -> state (see start)
const listeners = new Set();
let selected = null;                     // { feedId, id, last } — last: the object as last seen
let following = false;
let selLayer = null;

/** fn({ type: 'feed', feedId, state }) when a feed's status or objects change; fn({ type: 'selection', object }). */
export function onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }
const emit = e => { for (const fn of listeners) { try { fn(e); } catch (err) { console.warn('Tracking listener failed', err); } } };

const rgb = hex => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16));
const pointSymbol = (color, size = 9) => ({ type: 'simple-marker', style: 'circle', size, color: [...rgb(color), 0.95], outline: { color: [255, 255, 255, 1], width: 1.5 } });
const trailSymbol = color => ({ type: 'simple-line', color: [...rgb(color), 0.55], width: 2 });
const text = v => (v == null || v === '' ? '' : String(v));
const pick = (attrs, name) => (name ? attrs?.[name] ?? attrs?.[Object.keys(attrs ?? {}).find(k => k.toLowerCase() === String(name).toLowerCase())] : undefined);

/** The status the Tracking pane shows for a feed: { on, status: 'loading' | 'ok' | 'error', text, count, updated }. */
export function state(feedId) {
  const st = feeds.get(feedId);
  return st ? { on: true, status: st.status, text: st.text, count: st.items.length, updated: st.updated } : { on: false, status: 'off', text: '', count: 0, updated: null };
}
export const isOn = feedId => feeds.has(feedId);
/** Any feed on the map (map clicks then look for a tracked object first). */
export const isActive = () => feeds.size > 0;

function setStatus(st, status, msg = '') {
  st.status = status;
  st.text = msg;
  emit({ type: 'feed', feedId: st.feed.id, state: state(st.feed.id) });
}

/** The feed's objects changed: tell the pane, and move the selection ring (and the map, when following). */
function changed(st, note = '') {
  st.updated = new Date();
  setStatus(st, 'ok', note);
  if (selected?.feedId === st.feed.id) {
    const it = st.items.find(i => i.id === selected.id);
    if (it) selected.last = it;
    drawSelection();
    emit({ type: 'selection', object: selection() });
    if (following && it) map.getView()?.goTo({ center: [it.lon, it.lat] }, { animate: true, duration: 500 }).catch(() => {});
  }
}

/**
 * Show a feed on the map. Resolves when it has started (its first answer may come later; watch onChange).
 * @param color  the feed's colour (tracking.js feedColor)
 */
export async function start(feed, color) {
  if (feeds.has(feed.id)) return;
  const view = map.getView();
  if (!view?.map) throw new Error('The map isn\'t ready yet.');
  const st = { feed, color, layer: null, timer: null, tracks: new Map(), items: [], status: 'loading', text: '', updated: null, handles: [], tickTimer: null, stopped: false };
  feeds.set(feed.id, st);
  setStatus(st, 'loading', feed.kind === 'stream' ? 'Connecting…' : 'Reading the feed…');
  try {
    if (feed.kind === 'stream' || feed.kind === 'feature') {
      // Read the service through the app's own sign-in first, so a secured one never opens the SDK's sign-in dialog.
      await api.getServiceInfo(feed.url);
      if (st.stopped) return;
    }
    if (feed.kind === 'stream') await startStream(st, view);
    else if (feed.kind === 'feature') await startFeature(st, view);
    else {
      st.layer = new (map.getSDK().GraphicsLayer)({ id: `${LAYER_PREFIX}${feed.id}`, title: feed.title, listMode: 'hide' });
      view.map.add(st.layer);
      poll(st);
    }
  } catch (e) {
    if (!st.stopped) setStatus(st, 'error', layerError(e));
  }
}

const layerError = e => {
  const m = `${e?.message ?? e ?? ''}`;
  if (e?.target?.label) return `The service is secured. Sign in to ${e.target.label} (the viewer asks when you open a secured layer or Add data), then switch the feed on again.`;
  if (/not-authorized|token|403|499|498/i.test(`${m} ${e?.details?.httpStatus ?? ''}`)) return 'The service is secured. Sign in to its portal or server, then switch the feed on again.';
  return m ? `The feed didn't load: ${m}` : 'The feed didn\'t load.';
};

/* ---------- geojson, json: fetched by the viewer ---------- */
async function poll(st) {
  if (st.stopped) return;
  if (document.hidden) { schedule(st); return; }
  try {
    // A plain GET with no custom headers needs no CORS preflight, so any feed that allows other sites to read it works.
    const data = await api.getFeed(st.feed.url);
    if (st.stopped) return;
    if (data == null) throw new Error('The answer isn\'t JSON.');
    const { items, skipped, truncated } = readPositions(data, st.feed);
    st.tracks = hasTrail(st.feed.kind) && st.feed.trail > 0 ? mergeTracks(st.tracks, items, st.feed.trail) : new Map();
    st.items = items;
    draw(st);
    changed(st, [truncated ? `only the first ${OBJECTS_MAX} are drawn` : '', skipped ? `${skipped} without a position` : ''].filter(Boolean).join(', '));
  } catch (e) {
    if (!st.stopped) setStatus(st, 'error', e.message);
  } finally {
    schedule(st);
  }
}

function schedule(st) {
  clearTimeout(st.timer);
  if (!st.stopped) st.timer = setTimeout(() => poll(st), st.feed.refreshSeconds * 1000);
}

function draw(st) {
  const { Graphic } = map.getSDK();
  const out = [];
  for (const pts of st.tracks.values()) for (const path of trackPaths(pts)) {
    out.push(new Graphic({ geometry: { type: 'polyline', paths: [path], spatialReference: { wkid: 4326 } }, symbol: trailSymbol(st.color) }));
  }
  const sym = pointSymbol(st.color);
  for (const it of st.items) out.push(new Graphic({ geometry: { type: 'point', longitude: it.lon, latitude: it.lat }, attributes: { feedId: st.feed.id, objectId: it.id }, symbol: sym }));
  st.layer.removeAll();
  st.layer.addMany(out);
}

/* ---------- stream, feature: SDK layers ---------- */
async function startStream(st, view) {
  const [StreamLayer] = await map.loadSdkModules(['esri/layers/StreamLayer']);
  const { feed, color } = st;
  const renderer = { type: 'simple', symbol: pointSymbol(color) };
  const props = {
    id: `${LAYER_PREFIX}${feed.id}`, url: feed.url, title: feed.title, listMode: 'hide', legendEnabled: false, popupEnabled: false,
    outFields: ['*'], renderer, purgeOptions: { displayCount: OBJECTS_MAX }
  };
  const trail = feed.trail > 0 ? {
    enabled: true, maxDisplayObservationsPerTrack: feed.trail + 1,
    latestObservations: { renderer }, previousObservations: { visible: false },
    trackLine: { visible: true, renderer: { type: 'simple', symbol: trailSymbol(color) } }
  } : null;
  let layer;
  try { layer = new StreamLayer(trail ? { ...props, trackInfo: trail } : props); }
  catch { layer = new StreamLayer(props); }               // an SDK without track lines still shows the positions
  st.layer = layer;
  view.map.add(layer);
  await layer.load();
  if (st.stopped) return;
  const lv = await view.whenLayerView(layer);
  if (st.stopped) return;
  st.layerView = lv;
  const tick = () => queueTick(st);
  for (const target of [layer, lv]) { try { st.handles.push(target.on('data-received', tick)); } catch { /* not an event here */ } }
  const { reactiveUtils } = map.getSDK();
  st.handles.push(reactiveUtils.watch(() => lv.connectionStatus, s => {
    if (s === 'disconnected') setStatus(st, 'error', 'The stream service disconnected. Switch the feed off and on to reconnect.');
    else if (s === 'connected' && st.status !== 'ok') setStatus(st, 'loading', 'Connected. Waiting for positions…');
  }, { initial: true }));
}

async function startFeature(st, view) {
  const { FeatureLayer, reactiveUtils } = map.getSDK();
  const { feed, color } = st;
  const layer = new FeatureLayer({
    id: `${LAYER_PREFIX}${feed.id}`, url: feed.url, title: feed.title, listMode: 'hide', legendEnabled: false, popupEnabled: false,
    outFields: ['*'], refreshInterval: feed.refreshSeconds / 60
  });
  st.layer = layer;
  view.map.add(layer);
  await layer.load();
  if (st.stopped) return;
  if (layer.geometryType === 'point' || layer.geometryType === 'multipoint') layer.renderer = { type: 'simple', symbol: pointSymbol(color) };
  const lv = await view.whenLayerView(layer);
  if (st.stopped) return;
  st.layerView = lv;
  st.handles.push(reactiveUtils.watch(() => lv.updating, busy => { if (!busy) queueTick(st); }, { initial: true }));
}

/** Read the objects of a stream or feature layer again, at most every TICK_MS. */
function queueTick(st) {
  if (st.tickTimer || st.stopped) return;
  st.tickTimer = setTimeout(async () => {
    st.tickTimer = null;
    if (st.stopped || !st.layerView) return;
    const lv = st.layerView;
    const q = { where: '1=1', outFields: ['*'], returnGeometry: true };
    try {
      const res = typeof lv.queryLatestObservations === 'function' ? await lv.queryLatestObservations(q) : await lv.queryFeatures(q);
      if (st.stopped) return;
      st.items = res.features.slice(0, OBJECTS_MAX).map(g => layerItem(st, g)).filter(Boolean);
      changed(st, st.feed.kind === 'feature' ? 'in the map\'s view' : '');
    } catch (e) {
      if (!st.stopped) setStatus(st, 'error', layerError(e));
    }
  }, TICK_MS);
}

/** One object of a stream or feature layer, as the pane lists it. */
function layerItem(st, g) {
  const a = g.attributes ?? {};
  const layer = st.layer;
  const idField = st.feed.idField || layer.timeInfo?.trackIdField || layer.objectIdField;
  const geom = g.geometry;
  const pt = geom?.type === 'point' ? geom : geom?.extent?.center;
  const lon = pt?.longitude, lat = pt?.latitude;
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) return null;
  const id = text(pick(a, idField)) || text(pick(a, layer.objectIdField)) || '?';
  const label = text(pick(a, st.feed.labelField || layer.displayField)) || id;
  return { id, label, lon, lat, attributes: { ...a } };
}

/* ---------- Stop, reset ---------- */
export function stop(feedId) {
  const st = feeds.get(feedId);
  if (!st) return;
  st.stopped = true;
  clearTimeout(st.timer);
  clearTimeout(st.tickTimer);
  for (const h of st.handles) { try { h.remove(); } catch { /* gone */ } }
  if (st.layer) { try { map.getView()?.map?.remove(st.layer); st.layer.destroy?.(); } catch { /* gone with the map */ } }
  feeds.delete(feedId);
  if (selected?.feedId === feedId) clearSelection();
  emit({ type: 'feed', feedId, state: state(feedId) });
}

/** Stop every feed and forget the selection (a new manifest, or a new map). */
export function reset() {
  for (const id of [...feeds.keys()]) stop(id);
  selected = null;
  following = false;
  selLayer = null;
}

/* ---------- Objects, zooming, selection ---------- */
/** The feed's objects, by name. */
export const objects = feedId => [...(feeds.get(feedId)?.items ?? [])].sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true }));

/** Zoom to all of a feed's objects (one object: centre on it). Returns false when it has none yet. */
export function zoomTo(feedId) {
  const view = map.getView();
  const items = feeds.get(feedId)?.items ?? [];
  if (!view || !items.length) return false;
  if (items.length === 1) { view.goTo({ center: [items[0].lon, items[0].lat], zoom: Math.max(view.zoom, 5) }).catch(() => {}); return true; }
  const { Graphic } = map.getSDK();
  view.goTo(items.map(it => new Graphic({ geometry: { type: 'point', longitude: it.lon, latitude: it.lat } }))).catch(() => {});
  return true;
}

/** The selected object for the pane: { feedId, feedTitle, color, id, label, lon, lat, attributes, gone, following }, or null. */
function selection() {
  if (!selected) return null;
  const st = feeds.get(selected.feedId);
  const it = st?.items.find(i => i.id === selected.id);
  const o = it ?? selected.last;
  return o ? { feedId: selected.feedId, feedTitle: st?.feed.title ?? '', color: st?.color, ...o, gone: !it, updated: st?.updated ?? null, following } : null;
}

function drawSelection() {
  const view = map.getView();
  const o = selection();
  if (!view?.map || !o) { selLayer?.removeAll(); return; }
  if (!selLayer || !view.map.layers.includes(selLayer)) {
    selLayer = new (map.getSDK().GraphicsLayer)({ id: `${LAYER_PREFIX}selection`, title: 'Tracking selection', listMode: 'hide' });
    view.map.add(selLayer);
  }
  view.map.reorder(selLayer, view.map.layers.length - 1);
  selLayer.removeAll();
  selLayer.add(new (map.getSDK().Graphic)({
    geometry: { type: 'point', longitude: o.lon, latitude: o.lat },
    symbol: { type: 'simple-marker', style: 'circle', size: 24, color: [0, 0, 0, 0], outline: { color: [...rgb(o.color ?? '#1C2B30'), 1], width: 3 } }
  }));
}

/** Select an object (from the pane's list or a map click); zoom: centre the map on it. */
export function select(feedId, id, { zoom = false } = {}) {
  const st = feeds.get(feedId);
  const it = st?.items.find(i => i.id === id);
  if (!it) return;
  selected = { feedId, id, last: it };
  drawSelection();
  if (zoom) map.getView()?.goTo({ center: [it.lon, it.lat], zoom: Math.max(map.getView().zoom, 13) }).catch(() => {});
  emit({ type: 'selection', object: selection() });
}

export function clearSelection() {
  selected = null;
  following = false;
  selLayer?.removeAll();
  emit({ type: 'selection', object: null });
}

/** Keep the map centred on the selected object as it moves. */
export function follow(on) {
  following = Boolean(on) && Boolean(selected);
  const o = selection();
  if (following && o) map.getView()?.goTo({ center: [o.lon, o.lat] }).catch(() => {});
  emit({ type: 'selection', object: o });
}

/** The tracked object under a map click: { feedId, id }, or null. */
export async function objectAt(mapPoint) {
  const view = map.getView();
  const layers = [...feeds.values()].map(s => s.layer).filter(Boolean);
  if (!view || !layers.length) return null;
  const res = await view.hitTest(view.toScreen(mapPoint), { include: layers }).catch(() => null);
  for (const r of res?.results ?? []) {
    const g = r.graphic;
    if (g?.geometry?.type !== 'point') continue;
    const st = [...feeds.values()].find(s => s.layer === g.layer);
    if (!st) continue;
    if (st.feed.kind === 'geojson' || st.feed.kind === 'json') return { feedId: st.feed.id, id: g.attributes?.objectId };
    const it = layerItem(st, g);
    if (!it) continue;
    if (!st.items.some(i => i.id === it.id)) st.items = [...st.items, it];
    return { feedId: st.feed.id, id: it.id };
  }
  return null;
}
