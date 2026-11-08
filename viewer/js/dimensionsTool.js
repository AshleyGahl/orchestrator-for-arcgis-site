// dimensionsTool.js — the Dimensions tool (Tools panel): the length of each polygon side and line segment in view,
// with bearings and polygon areas if wanted, like a parcel fabric's dimension labels. It is an overlay switch, not a
// tool that holds the map: once on, it redraws whenever the map comes to rest after a pan or zoom, and it stays on
// while people use Details and other tools, until they switch it off (or the viewer is shown again). Map clicks are
// left alone. A layer is measured only while the map draws it: switched on (and its group) and within its own scale
// range (and its group's), so the dimensions come and go with the layer.
// Measuring and label placement are in dimensions.js; layers and queries go through map.js.
import * as map from './map.js';
import { CONFIG } from './config.js';
import { el, fill } from './utils.js';
import { DIMENSION_UNITS, DIMENSION_AREA_UNITS, BEARING_FORMATS, LINE_LENGTH_MODES, MAX_DECIMALS, measurer, dimensionLabels } from './dimensions.js';

const HALO = [255, 255, 255, 0.95];
const FONT = { side: { size: 9, px: 12 }, area: { size: 10, px: 13 } };   // SDK sizes are points; px for fitting
const AREA_DROP = -13;                  // areas sit just under the centre, clear of the layer's own label there
const MEASURED = new Set(['polygon', 'polyline']);

const STATE_TEXT = {
  hidden: () => 'Switched off (here or its group), so not measured',
  'out-of-scale': () => 'Not drawn at this scale, so not measured: zoom in or out',
  'too-many': () => `More than ${CONFIG.dimensionsMaxFeatures} in view: zoom in`,
  missing: () => 'Not in the map',
  points: () => 'Points have no dimensions'
};

// The one overlay of this viewer, kept while the panel opens and closes:
// { cfg, on, keys, opts, layer, features, status: Map(key -> { state, count?, error? }), summary, run, stopView, watch,
//   listeners, moreOpen (the panel's other layers unfolded) }
let s = null;

function session(cfg) {
  if (s?.cfg === cfg) return s;
  resetDimensions();
  const d = CONFIG.toolDefaults.dimensions;
  s = {
    cfg, on: false, keys: new Set(), layer: null, features: [], status: new Map(), summary: '', run: 0, moreOpen: false,
    stopView: null, watch: null, listeners: new Set(),
    opts: Object.fromEntries(['unit', 'areaUnit', 'decimals', 'showArea', 'showBearings', 'bearingFormat', 'lineLength'].map(k => [k, cfg[k] ?? d[k]])),
    // Colours set in Orchestration, by label kind (dimensions.js): lengths of sides and of lines, areas, bearings.
    colors: { side: cfg.lengthColor || d.lengthColor, line: cfg.lengthColor || d.lengthColor, area: cfg.areaColor || d.areaColor, bearing: cfg.bearingColor || d.bearingColor }
  };
  return s;
}

const notify = () => s?.listeners.forEach(f => f());

/** Switch the dimensions on (the panel's button). */
export function startDimensions(cfg = {}) {
  const x = session(cfg), view = map.getView();
  if (x.on || !view) return;
  x.on = true;
  x.layer = new (map.getSDK().GraphicsLayer)({ listMode: 'hide', title: 'Dimensions' });
  view.map.add(x.layer);
  x.stopView = map.onViewChange(refresh);
  watchLayers();
  refresh();
  notify();
}

export function stopDimensions() {
  if (!s?.on) return;
  s.on = false;
  s.run++;
  s.stopView?.(); s.stopView = null;
  s.watch?.remove(); s.watch = null;
  map.getView()?.map?.remove(s.layer);
  s.layer.destroy(); s.layer = null;
  s.features = []; s.status.clear(); s.summary = '';
  notify();
}

/** Forget the overlay and people's choices (the viewer is showing a manifest again). */
export function resetDimensions() {
  stopDimensions();
  s = null;
}

/** Redraw when a chosen layer is switched on or off, or zooming takes it into or out of its scale range. */
function watchLayers() {
  s.watch?.remove();
  const layers = [...s.keys].map(k => map.dimensionLayer(k)).filter(Boolean);
  s.watch = map.getSDK().reactiveUtils.watch(() => layers.map(l => l.state()).join(), () => refresh());
}

/** Read the chosen layers' features in view, then label them. */
async function refresh() {
  const x = s, view = map.getView();
  if (!x?.on || !view?.stationary) return;          // mid-zoom: the view comes to rest and calls again
  const run = ++x.run, max = CONFIG.dimensionsMaxFeatures;
  const status = new Map(), features = [];
  const found = await Promise.all([...x.keys].map(async key => {
    const l = map.dimensionLayer(key);
    if (!l) { status.set(key, { state: 'missing' }); return []; }
    const state = l.state();
    if (state !== 'showing') { status.set(key, { state }); return []; }
    try {
      const res = await l.query({
        geometry: view.extent, spatialRelationship: 'intersects', returnGeometry: true, outFields: [],
        num: max + 1, outSpatialReference: view.spatialReference
      });
      const feats = (res.features ?? []).filter(g => g.geometry);
      if (feats.length > max || res.exceededTransferLimit) { status.set(key, { state: 'too-many' }); return []; }
      if (feats.some(g => !MEASURED.has(g.geometry.type))) { status.set(key, { state: 'points' }); return []; }
      status.set(key, { state: 'showing', count: feats.length });
      return feats;
    } catch (e) {
      status.set(key, { state: 'failed', error: e.message || 'the query failed' });
      return [];
    }
  }));
  if (run !== x.run || !x.on) return;
  for (const g of found.flat()) {
    const c = g.geometry.type === 'polygon' ? g.geometry.centroid : null;
    features.push({ rings: g.geometry.rings, paths: g.geometry.paths, labelPoint: c ? [c.x, c.y] : undefined });
  }
  x.features = features;
  x.status = status;
  relabel();
}

/** Label the features last read (after a refresh, or when people change units or what is shown). */
function relabel() {
  const x = s, view = map.getView();
  if (!x?.on || !view) return;
  const { xmin, ymin, xmax, ymax } = view.extent, sr = view.spatialReference;
  const measure = measurer(sr);
  const labels = dimensionLabels(x.features, {
    ...x.opts, measure, extent: { xmin, ymin, xmax, ymax }, resolution: view.resolution, fontPx: FONT.side.px, locale: CONFIG.numberLocale
  });
  const { Graphic } = map.getSDK();
  x.layer.removeAll();
  x.layer.addMany(labels.map(l => {
    const font = l.kind === 'area' ? FONT.area : FONT.side;
    return new Graphic({
      geometry: { type: 'point', x: l.x, y: l.y, spatialReference: sr },
      symbol: {
        type: 'text', text: l.text, angle: l.angle, color: x.colors[l.kind], haloColor: HALO, haloSize: 1.5,
        yoffset: l.kind === 'area' ? AREA_DROP : 0,
        font: { size: font.size, weight: l.kind === 'area' ? 'bold' : 'normal' }
      }
    });
  }));
  // Layers added later (Add data) go on top; the labels belong above them.
  const layers = view.map.layers;
  if (layers.indexOf(x.layer) !== layers.length - 1) view.map.reorder(x.layer, layers.length - 1);
  const n = labels.length, shown = [...x.status.values()].reduce((sum, v) => sum + (v.count ?? 0), 0);
  // A ticked layer that has left the map (the viewer was shown again) is left out without a word.
  const missing = [...x.status.values()].filter(v => v.state === 'missing').length;
  x.summary = !x.keys.size || missing === x.keys.size ? 'Tick a layer to measure.'
    : !shown && [...x.status.values()].every(v => v.state !== 'showing') ? 'Nothing is measured until a chosen layer is switched on in Layers and drawn at this scale.'
    : !shown ? 'Nothing to measure in this part of the map.'
    : `${n.toLocaleString(CONFIG.numberLocale)} label${n === 1 ? '' : 's'} on ${shown.toLocaleString(CONFIG.numberLocale)} feature${shown === 1 ? '' : 's'}. `
      + (measure.geodesic ? 'Lengths and areas are on the ground (WGS84 ellipsoid); bearings are from true north.' : "Lengths, areas and bearings are on the map's grid.");
  notify();
}

/**
 * Mount the tool's panel into a Tools panel slot. Closing the panel (or opening another tool) leaves the dimensions on.
 * @param cfg  widgets.toolConfig.dimensions: starting layers, units, decimals, what is shown
 * @returns { destroy() }
 */
export function createDimensionsTool(node, cfg = {}) {
  const x = session(cfg);
  const refs = { states: new Map() };

  const choice = (label, value, options, onPick) => el('label', { class: 'field' }, label,
    el('select', { onchange: e => onPick(e.target.value) }, options.map(([v, l]) => el('option', { value: v, selected: String(v) === String(value) }, l))));
  const setOpt = (k, v) => { x.opts[k] = v; relabel(); render(); };
  const check = (label, k) => el('label', { class: 'check-row' },
    el('input', { type: 'checkbox', checked: x.opts[k], onchange: e => setOpt(k, e.target.checked) }), label);

  function toggleLayer(key, on) {
    if (on) x.keys.add(key); else x.keys.delete(key);
    if (x.on) { watchLayers(); refresh(); }
    render();
  }

  const stateText = key => {
    const st = x.status.get(key);
    if (!x.on || !x.keys.has(key) || !st) return '';
    if (st.state === 'showing') return `${st.count.toLocaleString(CONFIG.numberLocale)} in view`;
    if (st.state === 'failed') return `Couldn't be read: ${st.error}`;
    return STATE_TEXT[st.state]?.() ?? '';
  };

  /** The live parts: the button, each layer's state and the summary (the rest is redrawn only on a change). */
  function update() {
    if (refs.toggle) {
      refs.toggle.textContent = x.on ? 'Hide dimensions' : 'Show dimensions';
      refs.toggle.className = x.on ? 'btn' : 'btn primary';
      refs.toggle.setAttribute('aria-pressed', String(x.on));
    }
    for (const [key, node] of refs.states) {
      const st = x.status.get(key)?.state;
      node.textContent = stateText(key);
      node.className = st === 'failed' || st === 'too-many' ? 'err' : 'muted';
    }
    if (refs.summary) refs.summary.textContent = x.on ? x.summary : '';
  }

  // Line and polygon layers in the map now (web map and added data), plus any chosen layer whose type isn't known yet.
  const candidates = () => map.labelLayers().filter(l => MEASURED.has(l.geometryType) || x.keys.has(l.key));

  function render() {
    const layers = candidates();
    refs.listed = layers.map(l => l.key).join();
    const hasPolygons = layers.some(l => l.geometryType === 'polygon');
    const hasLines = layers.some(l => l.geometryType === 'polyline');
    // The chosen layers first; a web map can have dozens of others, so they fold away.
    const chosen = layers.filter(l => x.keys.has(l.key)), others = layers.filter(l => !x.keys.has(l.key));
    const row = l => {
      const st = el('span', { class: 'muted' });
      refs.states.set(l.key, st);
      return el('label', { class: 'check-row' },
        el('input', { type: 'checkbox', checked: x.keys.has(l.key), onchange: e => toggleLayer(l.key, e.target.checked) }),
        el('span', {}, l.title, ' ', st));
    };
    refs.states.clear();
    refs.toggle = el('button', { type: 'button', onclick: () => (x.on ? stopDimensions() : startDimensions(cfg)) });
    refs.summary = el('p', { class: 'muted', 'aria-live': 'polite' });
    fill(node, el('div', { class: 'tool-form dim-tool' },
      el('p', { class: 'tool-help' },
        'Labels each side of the polygons and lines in view with its length, like a parcel fabric. The labels follow the map as you pan and zoom, and stay on while you use other tools. A layer is measured only while it is switched on and drawn at the current scale.'),
      el('div', { class: 'btn-row' }, refs.toggle),
      el('div', { class: 'field' }, 'Layers to measure',
        !layers.length ? el('p', { class: 'muted' }, 'This map has no line or polygon layers to measure.')
          : chosen.length ? el('div', { class: 'dim-layers' }, chosen.map(row))
          : el('p', { class: 'muted' }, 'None yet: tick a layer below.'),
        others.length ? el('details', { class: 'dim-more', open: x.moreOpen || !chosen.length, ontoggle: e => { if (chosen.length) x.moreOpen = e.target.open; } },   // opened by itself while nothing is ticked: not remembered
          el('summary', {}, `${chosen.length ? 'Other line' : 'Line'} and polygon layers (${others.length})`),
          el('div', { class: 'dim-layers' }, others.map(row))) : null),
      el('div', { class: 'two-col' },
        choice('Lengths in', x.opts.unit, DIMENSION_UNITS, v => setOpt('unit', v)),
        choice('Decimals', x.opts.decimals, Array.from({ length: MAX_DECIMALS + 1 }, (_, i) => [i, String(i)]), v => setOpt('decimals', Number(v)))),
      hasPolygons || !layers.length ? check('Show polygon areas', 'showArea') : null,
      (hasPolygons || !layers.length) && x.opts.showArea ? choice('Areas in', x.opts.areaUnit, DIMENSION_AREA_UNITS, v => setOpt('areaUnit', v)) : null,
      check('Show bearings after the lengths (clockwise from north)', 'showBearings'),
      x.opts.showBearings ? choice('Bearings as', x.opts.bearingFormat, BEARING_FORMATS, v => setOpt('bearingFormat', v)) : null,
      hasLines ? choice('Label lines with', x.opts.lineLength, LINE_LENGTH_MODES, v => setOpt('lineLength', v)) : null,
      refs.summary));
    update();
  }

  x.listeners.add(update);
  render();
  // Layers that finish loading (the panel was opened while the map loaded) or are added with Add data join the list.
  const view = map.getView();
  const loading = view && map.getSDK().reactiveUtils.watch(() => view.map?.allLayers.filter(l => l.loaded).length,
    () => { if (candidates().map(l => l.key).join() !== refs.listed) render(); });
  return { destroy() { x.listeners.delete(update); loading?.remove(); fill(node); } };
}
