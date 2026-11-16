// widgets.js — mounts the ArcGIS SDK's own widgets (LayerList, Legend, address search, measuring, basemap gallery)
// and the Label orientation and Dimensions tools into containers the viewer panel provides, and owns their lifecycle so a
// re-publish starts clean. The Dimensions overlay outlives its panel: stopping the tool closes the panel only.
import * as map from './map.js';
import { el } from './utils.js';
import * as styles from './layerStylesLive.js';
import { createLabelTool } from './labelTool.js';
import { createDimensionsTool, resetDimensions } from './dimensionsTool.js';
import { createVegetationTool } from './vegetationTool.js';
import { createAddressAuditTool } from './addressAuditTool.js';

const mounted = new Map();
let activeTool = null;

function destroy(name) {
  const w = mounted.get(name);
  if (!w) return;
  try {
    // The Layers list makes a Legend in every layer's panel (the SDK's own, ListItemPanel._legend).
    if (w.operationalItems) w.operationalItems.flatten(i => i.children).forEach(i => destroyLegend(i.panel?._legend));
    if (w.declaredClass === 'esri.widgets.Legend') destroyLegend(w);
    else w.destroy();
  } catch { /* already gone */ }
  mounted.delete(name);
}

/**
 * SDK 4.30: Legend.destroy() leaves the legend's style widget (legend.style, the Classic or Card renderer) alive, and
 * that keeps the legend's layers, and through them the whole web map, in memory. Every Update preview (or re-sync
 * after a sign-in) used to keep the previous web map with all its layers: about 10 MB of JS heap and 100 MB of page
 * and GPU memory each time, until the tab ran out of memory. Destroy the style too.
 */
function destroyLegend(legend) {
  if (!legend || legend.destroyed) return;
  const style = legend.style;
  legend.destroy();
  if (style && !style.destroyed) style.destroy();
}

/** The SDK empties its container on destroy, so each widget gets its own child node. */
function freshNode(container) {
  const node = document.createElement('div');
  container.replaceChildren(node);
  return node;
}

export function destroyAll() {
  for (const name of [...mounted.keys()]) destroy(name);
  activeTool = null;
  resetDimensions();
}

/* ---------------- Layers: Experience Builder-style list ---------------- */
function transparencyControl(layer) {
  const out = el('output', {}, `${Math.round((1 - (layer.opacity ?? 1)) * 100)}%`);
  return el('label', { class: 'll-transparency' },
    el('span', {}, 'Transparency'),
    el('input', {
      type: 'range', min: 0, max: 100, value: Math.round((1 - (layer.opacity ?? 1)) * 100),
      oninput: e => { layer.opacity = 1 - Number(e.target.value) / 100; out.textContent = `${e.target.value}%`; }
    }),
    out);
}

/** The manifest's key for a list item's layer: 'layerId', or 'layerId:sublayerId' for a map service sublayer. */
const layerKey = layer => (layer.layer && typeof layer.id === 'number' ? `${layer.layer.id}:${layer.id}` : layer.id);

/** Layer styles: the style choice for one layer, filled once its styles are checked (hidden if none can be used). */
function styleControl(key) {
  const select = el('select', { 'aria-label': 'Style', disabled: true }, el('option', {}, 'Loading…'));
  const note = el('p', { class: 'll-style-note', hidden: true });
  const legendBox = el('div', { class: 'll-style-legend' });
  const box = el('div', { class: 'll-style' }, el('label', {}, el('span', {}, 'Style'), select), note, legendBox);
  const say = (text, error = false) => { note.textContent = text || ''; note.hidden = !text; note.classList.toggle('is-error', error); };
  // A style drawn over the layer is a separate (hidden) layer, so the panel's own legend doesn't show it: this one does.
  let legendWidget = null;
  const legend = () => {
    legendWidget?.destroy();
    legendWidget = null;
    const over = styles.overlayLayer(key);
    if (over) legendWidget = new (map.getSDK().Legend)({ view: map.getView(), container: freshNode(legendBox), layerInfos: [{ layer: over, title: '' }] });
    else legendBox.replaceChildren();
  };
  styles.options(key).then(o => {
    if (!o) { box.hidden = true; return; }
    const about = id => o.choices.find(c => c.id === id)?.description ?? '';
    const show = id => { select.value = id; say(about(id)); legend(); };
    select.replaceChildren(...o.choices.map(c => el('option', { value: c.id }, c.name)));
    select.disabled = false;
    show(o.active);
    styles.onChange((k, id) => { if (k === key) show(id); });       // also when the style changes elsewhere
    select.addEventListener('change', async () => {
      try { await styles.choose(key, select.value); }
      catch (e) { say(`That style couldn't be shown: ${e.message}`, true); }
    });
  });
  return box;
}

/**
 * @param dragEnabled  people can drag layers to change their order for the visit (manifest widgets.layerReorder)
 * @param restLinks    layer keys whose menu has "Open REST endpoint" (manifest widgets.restLinks); none by default
 */
export function mountLayerList(container, { dragEnabled = false, restLinks = [] } = {}) {
  const linked = new Set(restLinks);
  const { LayerList } = map.getSDK();
  const view = map.getView();
  destroy('layers');
  const widget = new LayerList({
    view,
    container: freshNode(container),
    visibilityAppearance: 'default',          // eye toggle on the right, like Experience Builder
    dragEnabled,                              // reorders the map itself, so drawing, Legend and Details follow
    listItemCreatedFunction: ({ item }) => {
      const layer = item.layer;
      if (!layer) return;
      const canZoom = layer.type !== 'group' || layer.fullExtent;
      const styled = layer.type !== 'group' && styles.has(layerKey(layer));
      item.actionsSections = [[
        ...(styled ? [{ title: 'Change style', id: 'style', icon: 'palette' }] : []),
        ...(canZoom ? [{ title: 'Zoom to', id: 'zoom-to', icon: 'zoom-to-object' }] : []),
        ...(layer.url && linked.has(layerKey(layer)) ? [{ title: 'Open REST endpoint', id: 'rest', icon: 'link' }] : [])
      ]];
      if (layer.type !== 'group' && 'opacity' in layer) {
        item.panel = {
          content: [...(styled ? [styleControl(layerKey(layer))] : []), transparencyControl(layer), 'legend'],
          icon: 'sliders-horizontal', title: styled ? 'Style, transparency and legend' : 'Transparency and legend', open: false
        };
      }
    }
  });
  widget.on('trigger-action', e => {
    const layer = e.item.layer;
    if (e.action.id === 'zoom-to') {
      const ext = layer.fullExtent ?? layer.layer?.fullExtent;
      if (ext) view.goTo(ext.clone().expand(1.1)).catch(() => {});
    }
    if (e.action.id === 'rest' && layer.url) window.open(layer.url, '_blank', 'noopener');
    if (e.action.id === 'style' && e.item.panel) e.item.panel.open = true;
  });
  mounted.set('layers', widget);
}

export function mountLegend(container) {
  const { Legend } = map.getSDK();
  destroy('legend');
  mounted.set('legend', new Legend({ view: map.getView(), container: freshNode(container), respectLayerVisibility: true }));
}

/**
 * The search box (searchBox.js): geocoding services and layers, suggestions as people type, and All when there are
 * several. Only the manifest's sources (never the portal's default geocoder). The attribute search below it is the
 * viewer's own query builder.
 * @param sources   SDK source settings (sdkSourceSettings), in the manifest's order
 * @param opts      { allPlaceholder, activeSourceIndex } the hint for All, and the source it opens on (-1 = All)
 * @param onResults ([{ index, results: [{ feature, name }] }]) => void, when a search finishes (a suggestion picked, or
 *                  Enter); index: which source. The viewer zooms and shows the results itself.
 * @returns the element holding the widget
 */
export function mountSearchBox(sources, { allPlaceholder, activeSourceIndex = -1 }, onResults) {
  const { Search } = map.getSDK();
  destroy('searchBox');
  const node = document.createElement('div');
  const widget = new Search({
    view: map.getView(), container: node, includeDefaultSources: false, sources,
    popupEnabled: false, resultGraphicEnabled: false, autoSelect: true, allPlaceholder, activeSourceIndex,
    goToOverride: () => Promise.resolve()        // the chosen result's emphasis zooms (its own scale)
  });
  widget.on('search-complete', e => onResults((e.results ?? []).map(r => ({ index: r.sourceIndex, results: r.results ?? [] }))));
  mounted.set('searchBox', widget);
  return node;
}

const TOOL_FACTORIES = {
  'measure-distance': (SDK, view, node, cfg) => new SDK.DistanceMeasurement2D({ view, container: node, unit: cfg.unit || 'metric' }),
  'measure-area':     (SDK, view, node, cfg) => new SDK.AreaMeasurement2D({ view, container: node, unit: cfg.unit || 'metric' }),
  'basemap-gallery':  (SDK, view, node, cfg) => new SDK.BasemapGallery({
    view, container: node,
    source: new SDK.LocalBasemapsSource({ basemaps: (cfg.basemaps ?? []).map(id => SDK.Basemap.fromId(id)).filter(Boolean) })
  }),
  'print': (SDK, view, node, cfg, ctx) => new SDK.Print({
    view, container: node, printServiceUrl: cfg.serviceUrl,
    templateOptions: { title: cfg.title || ctx.title || '', layout: cfg.layout, format: cfg.format }
  }),
  'elevation': (SDK, view, node, cfg) => {
    // A 2D web map usually has no ground, so the profile would have nothing to sample.
    if (!view.map.ground?.layers?.length) view.map.ground = 'world-elevation';
    view.map.ground.load().catch(() => {});        // a 2D view never loads the ground by itself
    return new SDK.ElevationProfile({
      view, container: node, unit: cfg.unit || 'metric',
      profiles: [{ type: 'ground' }],
      visibleElements: { legend: true, chart: true, clearButton: true, settingsButton: false, sketchButton: true, selectButton: false, uniformChartScalingToggle: false }
    });
  },
  'swipe': (SDK, view, node, cfg) => {
    // The swipe handle sits on the map itself; the panel only carries the help text.
    const find = ids => ids.map(id => view.map.allLayers.find(l => l.id === id)).filter(Boolean);
    const leadingLayers = find(cfg.leading ?? []), trailingLayers = find(cfg.trailing ?? []);
    if (!leadingLayers.length || !trailingLayers.length) {
      node.append(el('p', { class: 'muted' }, 'Swipe is not set up yet: choose layers for both sides in its settings.'));
      return null;
    }
    [...leadingLayers, ...trailingLayers].forEach(l => { l.visible = true; });
    node.append(el('p', { class: 'tool-help' }, `Drag the handle on the map ${cfg.direction === 'vertical' ? 'up or down' : 'left or right'} to compare the layers.`));
    const widget = new SDK.Swipe({ view, leadingLayers, trailingLayers, direction: cfg.direction || 'horizontal', position: 50 });
    view.ui.add(widget);
    return widget;
  },
  // Our own tool rather than an SDK widget; it draws its panel into the node and cleans up on destroy().
  'label-orientation': (SDK, view, node, cfg, ctx) => createLabelTool(node, cfg, ctx),
  'dimensions': (SDK, view, node, cfg) => createDimensionsTool(node, cfg),
  'vegetation': (SDK, view, node, cfg) => createVegetationTool(node, cfg),
  'address-audit': (SDK, view, node, cfg, ctx) => createAddressAuditTool(node, cfg, ctx),
  'sketch': (SDK, view, node, cfg) => {
    const widget = new SDK.Sketch({
      view, container: node, layer: map.getSketchLayer(), creationMode: 'update',
      availableCreateTools: cfg.shapes,
      visibleElements: { settingsMenu: false, selectionTools: { 'lasso-selection': false } }
    });
    Object.assign(widget.viewModel, map.accentSymbols(cfg.color || '#2B6F7F'));
    return widget;
  }
};

// Tools that take over map clicks while active, so Details doesn't fire underneath them.
const BLOCKING = new Set(['measure-distance', 'measure-area', 'sketch', 'select', 'elevation', 'label-orientation', 'vegetation']);
export const blocksIdentify = id => BLOCKING.has(id);
export const hasWidget = id => id in TOOL_FACTORIES;

/** Start one SDK-backed tool in its container; any other active tool is stopped first. */
export function startTool(name, container, cfg = {}, ctx = {}) {
  stopTool();
  activeTool = name;
  const make = TOOL_FACTORIES[name];
  if (!make) return;
  const widget = make(map.getSDK(), map.getView(), freshNode(container), cfg, ctx);
  if (widget) mounted.set(`tool:${name}`, widget);
  if (name.startsWith('measure-') || name === 'elevation') widget.viewModel?.start?.();
}

export function stopTool() {
  if (!activeTool) return;
  destroy(`tool:${activeTool}`);
  activeTool = null;
}
