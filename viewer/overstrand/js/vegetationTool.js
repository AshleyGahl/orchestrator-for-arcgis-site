// vegetationTool.js — the Vegetation health tool (Tools panel). It draws a vegetation index (NDVI, SAVI, NDMI, EVI,
// NBR) from a multispectral ImageServer in four health classes, or the scene in natural or false colour; a map click
// inspects one pixel (its bands, every index, its class and the scene's date); and an area (drawn, or the selected
// feature) gets a class breakdown in hectares with a chart and an Excel/CSV export. Everything is asked of the
// ImageServer from the browser: the index is worked out by the server (a BandArithmetic raster function), classes are
// drawn by a client-side renderer, so moving the stress threshold recolours without a new request.
// The science and the manifest contract are in vegetation.js; the layer leaves the map when the tool closes.
import * as map from './map.js';
import { CONFIG } from './config.js';
import { el, fill } from './utils.js';
import { loadChartJs } from './chartLoader.js';
import { exportControl } from './exportForm.js';
import { measurer } from './dimensions.js';
import { normalizeEmphasis, emphasisRgb, flashBeats } from './emphasis.js';
import { defaultVegetationEmphasis } from './highlights.js';
import {
  VEG_INDICES, VEG_CLASSES, vegSource, availableIndices, availableViews, whyNoHealth, indexRasterFunction,
  colourRasterFunction, mosaicRule, sceneQueries, nearestScene, sceneDate, parsePixelValue, pixelIndices,
  reflectances, classify, breaksFor, withThreshold, thresholdRange, classBreakInfos, histogramClasses, histogramMean, breakdownRows,
  breakdownTable, histogramPixelSize, BAND_KEYS, BAND_LABELS
} from './vegetation.js';

const MODULES = ['esri/layers/ImageryLayer', 'esri/layers/support/RasterFunction', 'esri/layers/support/MosaicRule'];
const CLOUD_CHOICES = [5, 10, 20, 30, 50, 100];

const fmt = (v, d = 2) => (v === null || v === undefined || !Number.isFinite(v) ? '—'
  : new Intl.NumberFormat(CONFIG.numberLocale, { minimumFractionDigits: d, maximumFractionDigits: d }).format(v));
const hexRgba = (hex, a) => { const n = parseInt(hex.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255, a]; };

/**
 * Mount the tool's panel into a Tools panel slot.
 * @param cfg  widgets.toolConfig.vegetation (vegetation.js)
 * @returns { destroy() }
 */
export function createVegetationTool(node, cfg = {}) {
  const view = map.getView();
  const SDK = map.getSDK();
  const source = vegSource(cfg);
  const indices = (cfg.indices ?? []).filter(id => availableIndices(source.bands).includes(id));
  const views = availableViews(source.bands);
  const x = {
    index: indices.includes(cfg.defaultIndex) ? cfg.defaultIndex : indices[0],
    view: views[0]?.[0] ?? null,
    breaks: Object.fromEntries(indices.map(id => [id, breaksFor(cfg, id)])),
    opacity: cfg.opacity ?? 0.7, maxCloud: cfg.maxCloud ?? 20, date: '',
    layer: null, marks: null, chart: null, handles: [], gone: false, drawing: false,
    mods: null, scene: '', inspect: null, area: null, error: ''
  };
  const refs = {};

  /* ---------------- Layer ---------------- */

  const rule = () => mosaicRule(source, { maxCloud: x.maxCloud, date: x.date || null });
  const indexFunction = () => indexRasterFunction(x.index, source.bands, source.scale);

  function renderer() {
    return {
      type: 'class-breaks', field: 'value',
      classBreakInfos: classBreakInfos(x.breaks[x.index]).map(i => ({
        minValue: i.minValue, maxValue: i.maxValue, label: i.label,
        symbol: { type: 'simple-fill', color: hexRgba(i.color, 1), outline: null }
      }))
    };
  }

  /** (Re)build the layer for the current view and scenes: index classes are drawn here, colour by the server. */
  function buildLayer() {
    const [ImageryLayer, RasterFunction, MosaicRule] = x.mods;
    removeLayer();
    const isIndex = x.view === 'index';
    const json = isIndex ? indexFunction() : colourRasterFunction(x.view, source.bands);
    const r = rule();
    x.layer = new ImageryLayer({
      url: source.url, title: isIndex ? `Vegetation health (${VEG_INDICES[x.index].label})` : `Vegetation health (${x.view === 'false' ? 'false colour' : 'natural colour'})`,
      format: isIndex ? 'lerc' : 'jpgpng', opacity: x.opacity, popupEnabled: false,
      rasterFunction: json ? RasterFunction.fromJSON(json) : null,
      ...(r ? { mosaicRule: new MosaicRule(r) } : {}),
      ...(isIndex ? { renderer: renderer() } : {})
    });
    x.layer.load().catch(e => { x.error = `The imagery service couldn't be opened: ${e?.message ?? e}`; update(); });
    view.map.add(x.layer);
    if (!x.marks) {
      x.marks = new SDK.GraphicsLayer({ listMode: 'hide', title: 'Vegetation health marks' });
      view.map.add(x.marks);
    } else view.map.reorder(x.marks, view.map.layers.length - 1);
    refreshScene();
  }

  function removeLayer() {
    if (!x.layer) return;
    view.map.remove(x.layer);
    x.layer.destroy();
    x.layer = null;
  }

  /* ---------------- Scenes ---------------- */

  /** The date of the scene the mosaic shows at a point (the map's centre by default). */
  async function sceneAt(point) {
    if (!x.layer || !source.dateField) return '';
    const times = [];
    for (const q of sceneQueries(source, { maxCloud: x.maxCloud, date: x.date || null })) {
      try {
        const fs = await x.layer.queryRasters({
          where: q.where, geometry: point, outFields: [source.dateField],
          orderByFields: [`${source.dateField} ${q.order}`], num: 1, returnGeometry: false
        });
        const t = fs?.features?.[0]?.attributes?.[source.dateField];
        if (Number.isFinite(t)) times.push(t);
      } catch { /* a service that can't be queried has no dates to show */ }
    }
    return sceneDate(nearestScene(times, x.date || null));
  }

  let sceneTimer = 0;
  function refreshScene() {
    clearTimeout(sceneTimer);
    sceneTimer = setTimeout(async () => {
      const d = await sceneAt(view.center);
      if (x.gone) return;
      x.scene = d;
      update();
    }, 600);
  }

  /* ---------------- Inspector ---------------- */

  async function inspect(point) {
    if (!x.layer || x.drawing) return;
    const [, RasterFunction] = x.mods;
    x.inspect = { busy: true, point };
    markPoint(point);
    renderResults();
    try {
      const [res, scene] = await Promise.all([
        x.layer.identify({ geometry: point, mosaicRule: x.layer.mosaicRule, rasterFunction: RasterFunction.fromJSON({ rasterFunction: 'None' }), returnCatalogItems: false, returnGeometry: false }),
        sceneAt(point)
      ]);
      if (x.gone || x.inspect?.point !== point) return;
      const values = parsePixelValue(res?.value);
      x.inspect = { point, scene, values, indices: pixelIndices(values, source.bands, source.scale), refl: reflectances(values, source.bands, source.scale) };
    } catch (e) {
      if (x.gone) return;
      x.inspect = { point, error: e?.message ?? String(e) };
    }
    renderResults();
  }

  // The spot and the area stand out as the tool's emphasis says (Map highlights): its colour (green by default, or the
  // selection colour), a fill for the area instead of a faint tint, and a flash once drawn.
  const look = normalizeEmphasis(cfg.emphasis ?? defaultVegetationEmphasis());
  const MARK = emphasisRgb(look, map.selectionColour());
  let markFlash = null;
  function flashMarks() {
    clearTimeout(markFlash);
    const beats = flashBeats(look);
    let i = 0;
    const step = () => {
      if (!x.marks || i >= beats.length) { if (x.marks) x.marks.opacity = 1; return; }
      x.marks.opacity = beats[i++];
      markFlash = setTimeout(step, 180);
    };
    step();
  }

  function markPoint(point) {
    x.marks?.graphics.removeMany(x.marks.graphics.filter(g => g.attributes?.kind === 'point').toArray());
    x.marks?.add(new SDK.Graphic({
      geometry: point, attributes: { kind: 'point' },
      symbol: { type: 'simple-marker', style: 'circle', size: 12, color: [...MARK, 0.85], outline: { color: [255, 255, 255, 1], width: 2 } }
    }));
    flashMarks();
  }

  /* ---------------- Area breakdown ---------------- */

  async function measureArea(geometry, label) {
    if (!x.layer || !geometry) return;
    if (geometry.type !== 'polygon') { x.area = { error: 'Select a polygon (a parcel or paddock) or draw an area: points and lines have no area.' }; renderResults(); return; }
    const [, RasterFunction] = x.mods;
    x.marks?.graphics.removeMany(x.marks.graphics.filter(g => g.attributes?.kind === 'area').toArray());
    x.marks?.add(new SDK.Graphic({
      geometry, attributes: { kind: 'area' },
      symbol: { type: 'simple-fill', color: [...MARK, look.highlight ? look.fillOpacity : 0.08], outline: { color: [...MARK, 1], width: 2.5 } }
    }));
    flashMarks();
    const areaM2 = measurer(geometry.spatialReference).area(geometry.rings);
    const index = x.index;
    x.area = { busy: true, label, index };
    renderResults();
    try {
      const lat = geometry.extent?.center?.latitude ?? 0;
      const px = histogramPixelSize(areaM2, source.pixelSize, lat);
      const [res, scene] = await Promise.all([
        x.layer.computeHistograms({
          geometry, mosaicRule: x.layer.mosaicRule, rasterFunction: RasterFunction.fromJSON(indexRasterFunction(index, source.bands, source.scale)),
          pixelSize: { x: px, y: px, spatialReference: { wkid: 3857 } }
        }),
        sceneAt(geometry.extent.center)
      ]);
      if (x.gone || x.area?.label !== label) return;
      const histogram = res?.histograms?.[0];
      if (!histogram?.counts?.some(Boolean)) throw new Error('the imagery has no pixels there (outside its coverage, or every scene is too cloudy: allow more cloud).');
      x.area = { label, index, histogram, areaM2, scene };
    } catch (e) {
      if (x.gone) return;
      x.area = { label, index, error: `Couldn't work out the breakdown: ${e?.message ?? e}` };
    }
    renderResults();
  }

  async function drawArea() {
    x.drawing = true;
    update();
    const geometry = await map.drawShape('polygon');
    map.cancelShape();
    x.drawing = false;
    update();
    if (geometry && !x.gone) measureArea(geometry, 'Drawn area');
  }

  /* ---------------- Panel ---------------- */

  const choice = (label, value, options, onPick) => el('label', { class: 'field' }, label,
    el('select', { onchange: e => onPick(e.target.value) }, options.map(([v, l]) => el('option', { value: v, selected: String(v) === String(value) }, l))));

  function legend() {
    const br = x.breaks[x.index];
    const range = i => (i === 0 ? `below ${fmt(br[0])}` : i === 3 ? `${fmt(br[2])} and above` : `${fmt(br[i - 1])} to ${fmt(br[i])}`);
    return el('ul', { class: 'veg-legend', 'aria-label': 'Classes' },
      VEG_CLASSES.slice().reverse().map((c, k) => el('li', {},
        el('span', { class: 'veg-swatch', style: `background:${c.color}` }), el('span', {}, c.label), el('span', { class: 'muted' }, range(3 - k)))));
  }

  function render() {
    if (!views.length || !x.view) {
      fill(node, el('div', { class: 'tool-form veg-tool' }, el('p', { class: 'err' }, whyNoHealth(source.bands) || 'This imagery service isn’t set up yet: choose its bands in the tool’s settings.')));
      return;
    }
    const isIndex = x.view === 'index', br = x.breaks[x.index];
    const today = new Date().toISOString().slice(0, 10);
    refs.status = el('p', { class: 'muted', 'aria-live': 'polite' });
    refs.results = el('div', { class: 'veg-results', 'aria-live': 'polite' });
    refs.drawBtn = el('button', { type: 'button', class: 'btn primary', onclick: drawArea }, 'Draw an area');
    refs.selBtn = el('button', { type: 'button', class: 'btn', onclick: () => measureArea(map.highlightedGeometry(), 'Selected feature') }, 'Use the selected feature');
    fill(node, el('div', { class: 'tool-form veg-tool' },
      el('p', { class: 'tool-help' }, 'Vegetation health from satellite or multispectral imagery (its near-infrared band, which aerial photos don’t have). Click the map to inspect a spot, or draw an area to see how much of it is healthy.'),
      el('div', { class: 'two-col' },
        choice('Show', x.view, views, v => { x.view = v; buildLayer(); render(); }),
        isIndex ? choice('Index', x.index, indices.map(id => [id, VEG_INDICES[id].label]), v => { x.index = v; buildLayer(); render(); }) : null),
      isIndex ? el('p', { class: 'muted veg-help' }, `${VEG_INDICES[x.index].name}. ${VEG_INDICES[x.index].help}`) : null,
      isIndex ? el('label', { class: 'field' },
        el('span', {}, 'Stressed below ', el('strong', { class: 'veg-threshold' }, fmt(br[1]))),
        el('input', {
          type: 'range', min: thresholdRange(br)[0], max: thresholdRange(br)[1], step: 0.01, value: br[1], 'aria-label': 'Stress threshold',
          oninput: e => {
            x.breaks[x.index] = withThreshold(x.breaks[x.index], Number(e.target.value));
            if (x.layer) x.layer.renderer = renderer();
            node.querySelector('.veg-threshold').textContent = fmt(x.breaks[x.index][1]);
            node.querySelector('.veg-legend')?.replaceWith(legend());
            if (x.area?.histogram) renderResults();
          }
        })) : null,
      isIndex ? legend() : null,
      el('div', { class: 'two-col' },
        source.cloudField ? choice('Most cloud', x.maxCloud, CLOUD_CHOICES.map(c => [c, c === 100 ? 'Any' : `${c}%`]), v => { x.maxCloud = Number(v); buildLayer(); }) : null,
        source.dateField ? el('label', { class: 'field' }, 'Imagery around',
          el('input', { type: 'date', value: x.date, max: today, onchange: e => { x.date = e.target.value; buildLayer(); } })) : null),
      el('label', { class: 'field' }, 'Opacity',
        el('input', { type: 'range', min: 0.1, max: 1, step: 0.05, value: x.opacity, oninput: e => { x.opacity = Number(e.target.value); if (x.layer) x.layer.opacity = x.opacity; } })),
      source.note ? el('p', { class: 'muted veg-help' }, source.note) : null,
      refs.status,
      isIndex ? el('div', { class: 'btn-row' }, refs.drawBtn, refs.selBtn) : null,
      refs.results));
    update();
    renderResults();
  }

  /** The live parts: the scene line, errors and the buttons. */
  function update() {
    if (refs.status) {
      refs.status.className = x.error ? 'err' : 'muted';
      refs.status.textContent = x.error || (x.drawing ? 'Click the map to draw the area; double-click to finish.'
        : x.scene ? `Scene in the middle of the map: ${x.scene}${x.date ? '' : ' (the newest clear enough)'}.` : '');
    }
    if (refs.drawBtn) refs.drawBtn.disabled = x.drawing;
    if (refs.selBtn) refs.selBtn.disabled = x.drawing || !map.highlightedGeometry();
  }

  function inspectBlock() {
    const i = x.inspect;
    if (!i) return null;
    const head = el('h4', {}, 'Spot ', el('span', { class: 'muted' }, `${fmt(i.point.latitude, 5)}, ${fmt(i.point.longitude, 5)}`));
    if (i.busy) return el('div', { class: 'veg-spot' }, head, el('p', { class: 'muted' }, 'Reading the pixel…'));
    if (i.error) return el('div', { class: 'veg-spot' }, head, el('p', { class: 'err' }, `Couldn't read the pixel: ${i.error}`));
    if (!i.values.length || !Object.values(i.indices).some(v => v !== null)) return el('div', { class: 'veg-spot' }, head, el('p', { class: 'muted' }, 'No imagery here (outside its coverage, or every scene is too cloudy).'));
    const cl = x.view === 'index' ? classify(i.indices[x.index], x.breaks[x.index]) : null;
    return el('div', { class: 'veg-spot' }, head,
      cl ? el('p', {}, el('span', { class: 'veg-swatch', style: `background:${cl.color}` }), ` ${cl.label} (${VEG_INDICES[x.index].label} ${fmt(i.indices[x.index])})`) : null,
      i.scene ? el('p', { class: 'muted' }, `Scene ${i.scene}`) : null,
      el('table', { class: 'veg-table' }, el('tbody', {},
        Object.entries(i.indices).map(([id, v]) => el('tr', {}, el('th', { title: VEG_INDICES[id].name }, VEG_INDICES[id].label), el('td', {}, fmt(v)))),
        BAND_KEYS.filter(k => i.refl[k] !== null).map(k => el('tr', { class: 'muted' }, el('th', {}, `${BAND_LABELS[k]} reflectance`), el('td', {}, fmt(i.refl[k], 3)))))));
  }

  function areaBlock() {
    const a = x.area;
    if (!a) return null;
    if (a.busy) return el('div', { class: 'veg-area' }, el('h4', {}, a.label), el('p', { class: 'muted' }, 'Reading the imagery inside the area…'));
    if (a.error) return el('div', { class: 'veg-area' }, el('h4', {}, a.label ?? 'Area'), el('p', { class: 'err' }, a.error));
    const breaks = x.breaks[a.index] ?? breaksFor(cfg, a.index);
    const rows = breakdownRows(histogramClasses(a.histogram, breaks), a.areaM2);
    const ix = VEG_INDICES[a.index];
    const canvas = el('canvas', { 'aria-label': `${a.label}: health classes`, role: 'img' });
    const exp = exportControl({
      title: `Vegetation health ${ix.label}`, total: rows.length, choices: [],
      exportAll: async () => breakdownTable(rows, { index: a.index, scene: a.scene, area: a.label }, CONFIG.numberLocale)
    });
    drawChart(canvas, rows);
    return el('div', { class: 'veg-area' },
      el('h4', {}, a.label, ' ', el('span', { class: 'muted' }, `${fmt(a.areaM2 / 10000)} ha`)),
      el('p', { class: 'muted' }, `${ix.label} average ${fmt(histogramMean(a.histogram))}${a.scene ? `, scene ${a.scene}` : ''}`),
      el('div', { class: 'veg-chart' }, canvas),
      el('table', { class: 'veg-table' },
        el('thead', {}, el('tr', {}, el('th', {}, 'Class'), el('th', {}, 'Hectares'), el('th', {}, '%'))),
        el('tbody', {}, rows.map(r => el('tr', {},
          el('th', {}, el('span', { class: 'veg-swatch', style: `background:${r.color}` }), ` ${r.label}`),
          el('td', {}, fmt(r.hectares)), el('td', {}, fmt(r.share * 100, 1)))))),
      el('div', { class: 'veg-export' }, exp.button), exp.panel);
  }

  async function drawChart(canvas, rows) {
    x.chart?.destroy(); x.chart = null;
    try {
      const Chart = await loadChartJs();
      if (x.gone || !canvas.isConnected) return;
      x.chart = new Chart(canvas, {
        type: 'doughnut',
        data: { labels: rows.map(r => r.label), datasets: [{ data: rows.map(r => Math.round(r.hectares * 100) / 100), backgroundColor: rows.map(r => r.color), borderWidth: 0 }] },
        options: { responsive: true, maintainAspectRatio: false, cutout: '65%', animation: false, plugins: { legend: { display: false } } }
      });
    } catch { canvas.replaceWith(el('p', { class: 'muted' }, 'The chart couldn’t be drawn; the table has the numbers.')); }
  }

  function renderResults() {
    if (!refs.results) return;
    fill(refs.results, inspectBlock(), areaBlock());
  }

  /* ---------------- Start ---------------- */

  render();
  if (views.length && x.view) {
    map.loadSdkModules(MODULES).then(mods => {
      if (x.gone) return;
      x.mods = mods;
      buildLayer();
      x.handles.push(
        view.on('click', e => { if (!x.drawing) inspect(e.mapPoint); }),
        SDK.reactiveUtils.watch(() => view.stationary, s => { if (s) refreshScene(); }));
      const poll = setInterval(update, 1500);           // the selection changes outside the tool (Details)
      x.handles.push({ remove: () => clearInterval(poll) });
    }).catch(e => { x.error = e?.message ?? String(e); update(); });
  }

  return {
    destroy() {
      x.gone = true;
      clearTimeout(markFlash);
      clearTimeout(sceneTimer);
      x.handles.forEach(h => h?.remove?.());
      x.chart?.destroy();
      if (x.drawing) map.cancelShape();
      removeLayer();
      if (x.marks) { view.map.remove(x.marks); x.marks.destroy(); }
      fill(node);
    }
  };
}
