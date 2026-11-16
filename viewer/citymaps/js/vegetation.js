// vegetation.js — the Vegetation health tool's science and manifest contract. Pure: no SDK, no DOM.
// Health comes from real reflectance bands of a multispectral ImageServer (Sentinel-2, Landsat, or one of the map's own),
// never from the colours of an aerial photo: a tile cache or a rendered RGB mosaic has no near-infrared band.
// Each index is worked out per pixel by the server (a BandArithmetic raster function built here) for drawing and for
// area histograms, and locally from a clicked pixel's band values for the inspector. Values fall into four classes
// (bare or water, stressed, moderate, healthy) at three breaks the author sets per index.

export const VEG_SOURCES = [['sentinel2', 'Sentinel-2 (Esri Living Atlas, 10 m, every 5 days)'],
  ['landsat', 'Landsat (Esri Living Atlas, 30 m, every 8 days)'], ['service', 'An ImageServer of your own']];

/** Esri's public multispectral services. Band indexes are 0-based; reflectance is stored × scale. */
export const VEG_PRESETS = {
  sentinel2: {
    url: 'https://sentinel.arcgis.com/arcgis/rest/services/Sentinel2/ImageServer', pixelSize: 10, scale: 10000,
    bands: { blue: 1, green: 2, red: 3, nir: 7, swir1: 11, swir2: 12 }, dateField: 'acquisitiondate', cloudField: 'cloudcover',
    sceneFilter: 'category = 1', note: 'Esri keeps about the last 14 months of Sentinel-2 scenes.'
  },
  landsat: {
    url: 'https://landsat2.arcgis.com/arcgis/rest/services/Landsat/MS/ImageServer', pixelSize: 30, scale: 10000,
    bands: { blue: 1, green: 2, red: 3, nir: 4, swir1: 5, swir2: 6 }, dateField: 'AcquisitionDate', cloudField: 'CloudCover',
    sceneFilter: 'Category = 1', note: ''
  }
};

export const BAND_KEYS = ['blue', 'green', 'red', 'nir', 'swir1', 'swir2'];
export const BAND_LABELS = { blue: 'Blue', green: 'Green', red: 'Red', nir: 'Near infrared', swir1: 'Short-wave infrared 1 (≈1.6 µm)', swir2: 'Short-wave infrared 2 (≈2.2 µm)' };

/** Centre wavelength range and ideal centre (nm) used to recognise a band from the service's BandProperties. */
const WAVELENGTHS = { blue: [440, 530, 490], green: [530, 600, 560], red: [620, 690, 665], nir: [760, 900, 842], swir1: [1500, 1750, 1610], swir2: [2050, 2350, 2200] };
const NAMES = { blue: /blue/i, green: /green/i, red: /(^|[^a-z])red($|[^a-z])|^red/i, nir: /near.?infra|^nir|narrow.?nir|(^|_)nir/i, swir1: /(swir|short.?wave).*1$|swir.?1/i, swir2: /(swir|short.?wave).*2$|swir.?2/i };

/**
 * Vegetation indices. f(r) takes reflectances (0–1); expr(b, s) builds the server expression from 1-based band
 * names (b.red is "B4") and the stored scale s, so constants match scaled values.
 */
export const VEG_INDICES = {
  ndvi: {
    label: 'NDVI', name: 'Normalised Difference Vegetation Index', needs: ['nir', 'red'], breaks: [0.2, 0.4, 0.6],
    help: 'Greenness: (NIR − Red) / (NIR + Red). The usual first look at veld and crop health.',
    f: r => ratio(r.nir - r.red, r.nir + r.red), expr: b => `(${b.nir}-${b.red})/(${b.nir}+${b.red})`
  },
  savi: {
    label: 'SAVI', name: 'Soil-Adjusted Vegetation Index', needs: ['nir', 'red'], breaks: [0.15, 0.3, 0.45],
    help: 'NDVI corrected for bare soil showing between plants (L = 0.5). Better on sparse veld, Karoo and renosterveld.',
    f: r => ratio(1.5 * (r.nir - r.red), r.nir + r.red + 0.5), expr: (b, s) => `1.5*(${b.nir}-${b.red})/(${b.nir}+${b.red}+${0.5 * s})`
  },
  ndmi: {
    label: 'NDMI', name: 'Normalised Difference Moisture Index', needs: ['nir', 'swir1'], breaks: [-0.1, 0.1, 0.3],
    help: 'Moisture in the leaves: (NIR − SWIR1) / (NIR + SWIR1). Shows drought stress before the veld browns.',
    f: r => ratio(r.nir - r.swir1, r.nir + r.swir1), expr: b => `(${b.nir}-${b.swir1})/(${b.nir}+${b.swir1})`
  },
  evi: {
    label: 'EVI', name: 'Enhanced Vegetation Index', needs: ['nir', 'red', 'blue'], breaks: [0.15, 0.3, 0.5],
    help: 'Like NDVI but keeps working over dense, green cover where NDVI levels off, and corrects for haze.',
    f: r => ratio(2.5 * (r.nir - r.red), r.nir + 6 * r.red - 7.5 * r.blue + 1),
    expr: (b, s) => `2.5*(${b.nir}-${b.red})/(${b.nir}+6*${b.red}-7.5*${b.blue}+${s})`
  },
  nbr: {
    label: 'NBR', name: 'Normalised Burn Ratio', needs: ['nir', 'swir2'], breaks: [0, 0.15, 0.35],
    help: 'Burnt and recovering veld: (NIR − SWIR2) / (NIR + SWIR2). Low after a fire, rising as the fynbos grows back.',
    f: r => ratio(r.nir - r.swir2, r.nir + r.swir2), expr: b => `(${b.nir}-${b.swir2})/(${b.nir}+${b.swir2})`
  }
};
export const VEG_INDEX_IDS = Object.keys(VEG_INDICES);

/** The four classes, lowest first, with their drawing colours. */
export const VEG_CLASSES = [
  { id: 'bare', label: 'Bare or water', color: '#3b82f6' },
  { id: 'stressed', label: 'Stressed', color: '#ef4444' },
  { id: 'moderate', label: 'Moderate', color: '#f59e0b' },
  { id: 'healthy', label: 'Healthy', color: '#10b981' }
];

export const VEG_VIEWS = [['index', 'Health classes'], ['natural', 'Natural colour'], ['false', 'False colour (vegetation red)']];
export const MAX_CLOUD_DEFAULT = 20;

function ratio(a, b) { return b === 0 || !Number.isFinite(a / b) ? null : a / b; }
const isBandIndex = v => Number.isInteger(v) && v >= 0;

/* ---------------- Sources and bands ---------------- */

/** The service a configuration draws from: its url, bands, scale, pixel size and date/cloud fields. */
export function vegSource(c) {
  const p = VEG_PRESETS[c?.source];
  if (p) return { ...p, bands: { ...p.bands } };
  return {
    url: c?.serviceUrl || '', pixelSize: null, scale: Number(c?.scale) > 0 ? Number(c.scale) : 1,
    bands: { ...(c?.bands || {}) }, dateField: c?.dateField || '', cloudField: c?.cloudField || '', sceneFilter: '', note: ''
  };
}

/**
 * Which band is which, from an ImageServer's keyProperties.BandProperties (wavelengths, then names) or, failing that,
 * its band names. Returns { blue, green, red, nir, swir1, swir2 } with 0-based indexes or null.
 */
export function detectBands(bandProperties = [], bandNames = []) {
  const out = Object.fromEntries(BAND_KEYS.map(k => [k, null]));
  const props = bandProperties.length ? bandProperties : bandNames.map(n => ({ BandName: n }));
  const best = Object.fromEntries(BAND_KEYS.map(k => [k, Infinity]));
  props.forEach((p, i) => {
    const lo = Number(p.WavelengthMin), hi = Number(p.WavelengthMax);
    const centre = lo > 0 && hi > 0 ? (lo + hi) / 2 : null;
    const name = String(p.BandName ?? '');
    for (const k of BAND_KEYS) {
      const [a, b, ideal] = WAVELENGTHS[k];
      if (centre !== null) {                  // by wavelength: the band nearest the ideal centre (B8, not red-edge B7)
        if (centre >= a && centre <= b && Math.abs(centre - ideal) < best[k]) { best[k] = Math.abs(centre - ideal); out[k] = i; }
      } else if (out[k] === null && NAMES[k].test(name) && !(k === 'red' && /edge|infra/i.test(name))) { out[k] = i; break; }
    }
  });
  // A plain 4-band orthophoto (no wavelengths, no useful names) is conventionally Red, Green, Blue, NIR.
  if (!bandProperties.some(p => Number(p.WavelengthMin) > 0) && props.length === 4 && BAND_KEYS.slice(0, 4).every(k => out[k] === null))
    Object.assign(out, { red: 0, green: 1, blue: 2, nir: 3 });
  return out;
}

/** Index ids the bands allow, in the standard order. */
export const availableIndices = bands => VEG_INDEX_IDS.filter(id => VEG_INDICES[id].needs.every(k => isBandIndex(bands?.[k])));

/** Why a service can't give vegetation health (no NIR or Red), or '' when it can. */
export function whyNoHealth(bands) {
  if (!isBandIndex(bands?.nir)) return 'This service has no near-infrared band, so vegetation health can’t be worked out from it. Aerial photos and tile caches hold only colour; use Sentinel-2, Landsat or a 4-band (RGB + NIR) ImageServer.';
  if (!isBandIndex(bands?.red)) return 'This service has no red band, so NDVI can’t be worked out from it.';
  return '';
}

/**
 * The raw value that means 100% reflectance, from the service's pixel type and largest values: 8-bit imagery 255,
 * 16-bit satellite products 10000 (or 65535 when the values fill the range), floating point 1.
 */
export function suggestScale(pixelType = '', maxValues = []) {
  const t = String(pixelType).toUpperCase(), top = Math.max(0, ...maxValues.map(Number).filter(Number.isFinite));
  if (/^F/.test(t)) return 1;
  if (/8/.test(t)) return 255;
  if (/16/.test(t)) return top > 20000 ? 65535 : 10000;
  return top > 0 && top <= 1.5 ? 1 : top > 0 && top <= 255 ? 255 : 10000;
}

/** The ImageServers a project can use: the web map's (anywhere in its groups) and the added REST services. [[url, title]] */
export function imageServersIn(operationalLayers = [], extraServices = []) {
  const out = new Map();
  const add = (url, title) => {
    const m = /^(https:\/\/[^?#]+?\/ImageServer)(?![\w])/i.exec(url || '');
    if (m && !out.has(m[1])) out.set(m[1], title || m[1].split('/').slice(-2, -1)[0]);
  };
  const walk = ops => ops.forEach(op => { add(op.url, op.title); walk(op.layers ?? []); });
  walk(operationalLayers);
  extraServices.forEach(x => add(x.url, x.title));
  return [...out];
}

/** A date and a cloud-cover field from an ImageServer's fields (as in Sentinel-2 and Landsat). */
export function detectFields(fields = []) {
  const find = re => fields.find(f => re.test(f.name))?.name || '';
  return { dateField: find(/^acq.*date$|^acquisitiondate$/i) || fields.find(f => f.type === 'esriFieldTypeDate')?.name || '', cloudField: find(/^cloud.?cover$/i) };
}

/* ---------------- Index values ---------------- */

/** Reflectances (0–1) from one pixel's raw band values. */
export function reflectances(values, bands, scale = 1) {
  const out = {};
  for (const k of BAND_KEYS) {
    const i = bands?.[k], v = isBandIndex(i) ? Number(values?.[i]) : NaN;
    out[k] = Number.isFinite(v) ? v / scale : null;
  }
  return out;
}

/** Every index the bands allow for one pixel: { ndvi: 0.62, … } (null where the pixel has no data). */
export function pixelIndices(values, bands, scale = 1) {
  const r = reflectances(values, bands, scale), out = {};
  for (const id of availableIndices(bands)) {
    const needs = VEG_INDICES[id].needs;
    out[id] = needs.every(k => r[k] !== null) && needs.some(k => r[k] !== 0) ? VEG_INDICES[id].f(r) : null;
  }
  return out;
}

/** The pixel values from an identify result's "1570, 1391, …" string (or array). NoData gives []. */
export function parsePixelValue(value) {
  if (Array.isArray(value)) return value.map(Number);
  if (typeof value !== 'string' || /nodata/i.test(value)) return [];
  return value.split(/[,\s]+/).filter(Boolean).map(Number);
}

/** The server expression for an index, e.g. "(B8-B4)/(B8+B4)" for Sentinel-2 NDVI. */
export function indexExpression(id, bands, scale = 1) {
  const ix = VEG_INDICES[id];
  if (!ix || !ix.needs.every(k => isBandIndex(bands?.[k]))) return '';
  const b = Object.fromEntries(BAND_KEYS.filter(k => isBandIndex(bands[k])).map(k => [k, `B${bands[k] + 1}`]));
  return ix.expr(b, scale);
}

/**
 * A BandArithmetic raster function that gives the index as 32-bit floats, as REST JSON (the runtime turns it into the
 * SDK's RasterFunction with fromJSON, which also handles nested functions).
 */
export function indexRasterFunction(id, bands, scale = 1) {
  const expression = indexExpression(id, bands, scale);
  if (!expression) return null;
  return { rasterFunction: 'BandArithmetic', rasterFunctionArguments: { Method: 0, BandIndexes: expression }, outputPixelType: 'F32' };
}

/**
 * Natural colour (Red, Green, Blue) or false colour (NIR, Red, Green: healthy plants show red) as REST JSON: the three
 * bands, stretched to the scenes in view (a 0.25% percent clip with dynamic range adjustment). null if a band is missing.
 */
export function colourRasterFunction(view, bands) {
  const keys = view === 'false' ? ['nir', 'red', 'green'] : view === 'natural' ? ['red', 'green', 'blue'] : null;
  if (!keys || !keys.every(k => isBandIndex(bands?.[k]))) return null;
  return {
    rasterFunction: 'Stretch',
    rasterFunctionArguments: {
      StretchType: 6, MinPercent: 0.25, MaxPercent: 0.25, DRA: true,
      Raster: { rasterFunction: 'ExtractBand', rasterFunctionArguments: { BandIDs: keys.map(k => bands[k]) } }
    },
    outputPixelType: 'U8'
  };
}

/** The views the bands allow (health classes needs NIR and Red). */
export const availableViews = bands => VEG_VIEWS.filter(([id]) => (id === 'index' ? !whyNoHealth(bands) : Boolean(colourRasterFunction(id, bands))));

/* ---------------- Classes ---------------- */

/** The class of one value at breaks [bare|stressed, stressed|moderate, moderate|healthy]. */
export function classify(value, breaks) {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  const i = breaks.findIndex(b => value < b);
  return VEG_CLASSES[i === -1 ? 3 : i];
}

/** The breaks in force for an index: the author's, or the index's defaults. */
export const breaksFor = (c, id) => (Array.isArray(c?.breaks?.[id]) && c.breaks[id].length === 3 ? c.breaks[id] : VEG_INDICES[id]?.breaks || [0, 0, 0]).slice();

/**
 * Moves the stressed|moderate break (the viewer's stress threshold), kept between the bare and healthy breaks so no
 * class disappears. thresholdRange gives the slider's ends.
 */
export function withThreshold(breaks, t) {
  const [lo, hi] = thresholdRange(breaks);
  return [breaks[0], Math.min(hi, Math.max(lo, Math.round(t * 100) / 100)), breaks[2]];
}
export const thresholdRange = breaks => [Math.round((breaks[0] + 0.01) * 100) / 100, Math.round((breaks[2] - 0.01) * 100) / 100];

/** Class-break infos for the SDK's ClassBreaksRenderer on the index (−∞..b0..b1..b2..∞, clamped to −1..1 and beyond). */
export function classBreakInfos(breaks) {
  const edges = [-1e9, ...breaks, 1e9];
  return VEG_CLASSES.map((cl, i) => ({ minValue: edges[i], maxValue: edges[i + 1], label: cl.label, color: cl.color }));
}

/**
 * Class shares inside an area from an ImageServer histogram { min, max, size, counts }: each bin goes to the class of
 * its centre. Returns { counts: { bare, stressed, moderate, healthy }, total }.
 */
export function histogramClasses(histogram, breaks) {
  const counts = Object.fromEntries(VEG_CLASSES.map(c => [c.id, 0]));
  let total = 0;
  const { min, max, counts: bins = [] } = histogram || {};
  const size = bins.length, width = size ? (max - min) / size : 0;
  bins.forEach((n, i) => {
    if (!n) return;
    const cl = classify(min + width * (i + 0.5), breaks);
    if (!cl) return;
    counts[cl.id] += n; total += n;
  });
  return { counts, total };
}

/** The mean index value from a histogram (bin centres), or null when it's empty. */
export function histogramMean(histogram) {
  const { min, max, counts: bins = [] } = histogram || {};
  const width = bins.length ? (max - min) / bins.length : 0;
  let sum = 0, n = 0;
  bins.forEach((c, i) => { sum += c * (min + width * (i + 0.5)); n += c; });
  return n ? sum / n : null;
}

/**
 * The breakdown table: per class its share and hectares. Hectares are the area's own (geodesic) size × the class's
 * share of pixels, so they add up to the area whatever the map's projection does to pixel sizes.
 */
export function breakdownRows(classCounts, areaM2) {
  const { counts, total } = classCounts;
  return VEG_CLASSES.slice().reverse().map(cl => {
    const share = total ? counts[cl.id] / total : 0;
    return { id: cl.id, label: cl.label, color: cl.color, pixels: counts[cl.id], share, hectares: share * areaM2 / 10000 };
  });
}

/* ---------------- Scenes ---------------- */

const pad = n => String(n).padStart(2, '0');
const restDate = d => `${d.getUTCFullYear()}/${pad(d.getUTCMonth() + 1)}/${pad(d.getUTCDate())}`;

/**
 * The mosaic rule (as the SDK's MosaicRule properties): scenes under the cloud limit, the one closest to the date
 * (the newest when no date is given) on top.
 */
export function mosaicRule(source, { maxCloud = MAX_CLOUD_DEFAULT, date = null } = {}) {
  const rule = {};
  if (source.cloudField && Number.isFinite(maxCloud) && maxCloud < 100) rule.where = `${source.cloudField} <= ${Math.round(maxCloud) / 100}`;
  if (source.dateField) {
    const d = date ? new Date(date) : null;
    Object.assign(rule, { method: 'attribute', sortField: source.dateField, sortValue: d && !isNaN(d) ? restDate(d) : '2099/12/31', ascending: true });
  }
  return Object.keys(rule).length ? rule : null;
}

/**
 * Where-clauses that find the scene the mosaic shows at a place (the service's own scenes, not its overviews): the
 * newest under the cloud limit, or with a date, the nearest on or before it and the nearest after it (two queries).
 * @returns [{ where, order: 'DESC' | 'ASC' }]
 */
export function sceneQueries(source, { maxCloud = MAX_CLOUD_DEFAULT, date = null } = {}) {
  if (!source.dateField) return [];
  const parts = [source.sceneFilter, mosaicRule(source, { maxCloud })?.where].filter(Boolean);
  const d = date ? new Date(date) : null;
  if (!d || isNaN(d)) return [{ where: parts.join(' AND ') || '1=1', order: 'DESC' }];
  const day = d.toISOString().slice(0, 10), next = new Date(+d + 86400000).toISOString().slice(0, 10);
  return [
    { where: [...parts, `${source.dateField} < DATE '${next}'`].join(' AND '), order: 'DESC' },
    { where: [...parts, `${source.dateField} >= DATE '${day}'`].join(' AND '), order: 'ASC' }
  ];
}

/** Of the scenes found (epoch ms), the one the mosaic shows: nearest the date, or the newest. */
export function nearestScene(times, date = null) {
  const t = times.filter(Number.isFinite);
  if (!t.length) return null;
  const d = date ? +new Date(date) : NaN;
  return Number.isFinite(d) ? t.reduce((a, b) => (Math.abs(b - d) < Math.abs(a - d) ? b : a)) : Math.max(...t);
}

/**
 * The pixel size (Web Mercator units) for an area's histogram: the service's own resolution, coarser for big areas so
 * the server reads at most about maxPixels. Web Mercator stretches by 1 / cos(latitude), so ground metres are scaled up.
 */
export function histogramPixelSize(areaM2, groundPx, latitude, maxPixels = 4e6) {
  const ground = Math.max(groundPx || 10, Math.sqrt(Math.max(areaM2, 0) / maxPixels));
  return ground / Math.cos((latitude || 0) * Math.PI / 180);
}

/** The breakdown as an export table (exportForm.js): columns and rows of { cells: { name: { text, raw } } }. */
export function breakdownTable(rows, { index, scene = '', area = '' } = {}, locale = 'en-US') {
  const num = (v, d) => new Intl.NumberFormat(locale, { minimumFractionDigits: d, maximumFractionDigits: d }).format(v);
  const columns = [
    { name: 'class', label: 'Class', kind: 'text' }, { name: 'hectares', label: 'Hectares', kind: 'number' },
    { name: 'percent', label: 'Percent', kind: 'number' }, { name: 'index', label: 'Index', kind: 'text' },
    { name: 'scene', label: 'Scene date', kind: 'text' }, { name: 'area', label: 'Area', kind: 'text' }
  ];
  const label = VEG_INDICES[index]?.label ?? index ?? '';
  return {
    columns,
    rows: rows.map(r => ({
      cells: {
        class: { text: r.label, raw: r.label }, hectares: { text: num(r.hectares, 2), raw: Math.round(r.hectares * 100) / 100 },
        percent: { text: num(r.share * 100, 1), raw: Math.round(r.share * 1000) / 10 }, index: { text: label, raw: label },
        scene: { text: scene, raw: scene }, area: { text: area, raw: area }
      }
    }))
  };
}

/** A scene's date as YYYY-MM-DD from epoch milliseconds (or ''). */
export const sceneDate = ms => (Number.isFinite(ms) ? new Date(ms).toISOString().slice(0, 10) : '');

/* ---------------- Manifest ---------------- */

export function vegetationDefaults() {
  return {
    source: 'sentinel2', serviceUrl: '', bands: Object.fromEntries(BAND_KEYS.map(k => [k, null])), scale: 1,
    dateField: '', cloudField: '', indices: VEG_INDEX_IDS.slice(), defaultIndex: 'ndvi', breaks: {},
    maxCloud: MAX_CLOUD_DEFAULT, opacity: 0.7
  };
}

/** Problems with widgets.toolConfig.vegetation, for validate(). */
export function vegetationProblems(c) {
  if (!c || typeof c !== 'object') return ['the settings must be an object.'];
  const out = [];
  if (!VEG_SOURCES.some(([id]) => id === c.source)) out.push('source must be "sentinel2", "landsat" or "service".');
  if (c.source === 'service') {
    const u = String(c.serviceUrl || '');
    if (!/^https:\/\/[^\s]+\/ImageServer\/?$/i.test(u)) out.push('serviceUrl must be an https:// address ending in /ImageServer.');
    if (/[?&]token=/i.test(u)) out.push('serviceUrl must not hold a token.');
    if (whyNoHealth(c.bands)) out.push('the bands need a near-infrared and a red band (Test the source to find them).');
    if (!(Number(c.scale) > 0)) out.push('scale must be a number above 0.');
  }
  for (const k of BAND_KEYS) { const v = c.bands?.[k]; if (v !== null && v !== undefined && !isBandIndex(v)) out.push(`bands.${k} must be a band number from 0, or null.`); }
  if (!Array.isArray(c.indices) || !c.indices.length || c.indices.some(id => !VEG_INDICES[id])) out.push(`indices must list one or more of ${VEG_INDEX_IDS.join(', ')}.`);
  else if (!c.indices.includes(c.defaultIndex)) out.push('defaultIndex must be one of the indices offered.');
  for (const [id, b] of Object.entries(c.breaks || {})) {
    if (!VEG_INDICES[id]) { out.push(`breaks.${id} isn't an index.`); continue; }
    if (!Array.isArray(b) || b.length !== 3 || b.some(v => typeof v !== 'number' || v < -1 || v > 1) || !(b[0] <= b[1] && b[1] <= b[2]))
      out.push(`breaks.${id} must be three ascending numbers from −1 to 1.`);
  }
  if (!Number.isFinite(c.maxCloud) || c.maxCloud < 0 || c.maxCloud > 100) out.push('maxCloud must be a percentage from 0 to 100.');
  if (!Number.isFinite(c.opacity) || c.opacity < 0.1 || c.opacity > 1) out.push('opacity must be from 0.1 to 1.');
  return out;
}
