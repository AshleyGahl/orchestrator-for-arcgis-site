// scene.js — the 3D scene widget's pure helpers: widths, height modes, which layers can go in the scene, and how
// tall each feature is drawn. A "random" height is worked out from the feature's ObjectID, so it is the same on
// every load; the same sum runs in JavaScript (randomHeight) and in Arcade (heightExpression). No DOM, no SDK.

export const SCENE_WIDTHS = [['half', 'Half: the scene beside the 2D map'], ['full', 'Full: the scene instead of the 2D map']];
export const isSceneWidth = id => SCENE_WIDTHS.some(([w]) => w === id);

export const HEIGHT_MODES = [['field', 'From a field (metres)'], ['random', 'Random, between two heights'], ['none', 'None: flat on the ground']];
export const isHeightMode = id => HEIGHT_MODES.some(([m]) => m === id);

export const POINT_SHAPES = [['cylinder', 'Cylinder (poles)'], ['cone', 'Cone (trees)']];
export const isPointShape = id => POINT_SHAPES.some(([s]) => s === id);

export const SCENE_MAX_HEIGHT_M = 1000;      // taller values (bad data, "no data" codes) are drawn at this height
export const THICKNESS_MIN_M = 0.1;
export const THICKNESS_MAX_M = 20;
export const SCENE_MANY_FEATURES = 20000;    // above this the settings suggest a zoom-in limit
export const SCENE_SUGGESTED_MIN_SCALE = 20000;

/** How each geometry is drawn: polygons are extruded, points stand up, lines become walls. */
const GEOMETRIES = {
  esriGeometryPolygon: 'polygon', esriGeometryPoint: 'point', esriGeometryPolyline: 'line',
  polygon: 'polygon', point: 'point', polyline: 'line'
};
export const sceneGeometry = type => GEOMETRIES[type] ?? null;
export const GEOMETRY_DRAWN_AS = { polygon: 'Polygons, extruded to the height', point: 'Points, drawn as an upright shape of the height', line: 'Lines, drawn as a wall of the height' };
/** heightMode 'none': no height, the layer lies on the ground (for context, e.g. boundaries or roads under the buildings). */
export const GEOMETRY_DRAWN_FLAT = { polygon: 'Polygons, drawn flat on the ground', point: 'Points, drawn as dots on the ground', line: 'Lines, drawn on the ground' };
export const hasHeight = layer => layer?.heightMode !== 'none';

/** Points: the shape's diameter. Lines: the wall's thickness. Polygons don't use it. */
export const defaultThickness = geometry => (geometry === 'line' ? 0.3 : 1);

/** A layer of a feature or map service: …/FeatureServer/n or …/MapServer/n (a map service sublayer is read as features). */
export const isSceneLayerUrl = url => /\/rest\/services\/.+\/(FeatureServer|MapServer)\/\d+\/?$/i.test(url || '');

/** Why a layer can't go in the scene, or '' when it can. info = the layer's REST description (optional). */
export function sceneUnsupported(url, info) {
  if (!isSceneLayerUrl(url)) return 'Only layers of a feature or map service (…/FeatureServer/n or …/MapServer/n) can go in the scene.';
  if (!info) return '';
  if (info.type === 'Table') return 'This is a table: it has no shapes to draw.';
  if (info.type && info.type !== 'Feature Layer') return `A ${info.type.toLowerCase()} can't be drawn in the scene.`;
  if (!sceneGeometry(info.geometryType)) {
    return info.geometryType === 'esriGeometryMultipoint' ? 'Multipoint layers can\'t go in the scene.' : 'The layer has no points, lines or polygons.';
  }
  if (info.capabilities && !/\bquery\b/i.test(info.capabilities)) return 'The service doesn\'t allow queries, so the scene can\'t read its features.';
  return '';
}

const NUMBER_TYPES = new Set(['esriFieldTypeSmallInteger', 'esriFieldTypeInteger', 'esriFieldTypeBigInteger', 'esriFieldTypeSingle', 'esriFieldTypeDouble',
  'small-integer', 'integer', 'big-integer', 'single', 'double']);
/** Fields a height can come from: numbers that aren't the ObjectID. */
export const isHeightField = (f, objectIdField = '') =>
  NUMBER_TYPES.has(f?.type) && f.name.toLowerCase() !== String(objectIdField).toLowerCase();

/* ---------- Stable "random" heights ---------- */
// A small hash of the ObjectID: one multiply to spread the ids, then two squarings (the non-linear part, so
// neighbouring ids get unrelated heights rather than a sawtooth). Every value stays below P < 2^26, so each product
// is below 2^53 and the sum is exact in any browser and in Arcade, which uses the same numbers.
const P = 50331653;       // a prime below 2^26
const MUL = 48271;
const C1 = 12345, C2 = 54321;

/** A number in [0, 1) that depends only on the ObjectID. */
export function stableUnit(objectId) {
  const id = objectId == null || objectId === '' ? NaN : Number(objectId);
  if (!Number.isInteger(id) || id < 0) return 0;
  let a = ((id % P) + 1) * MUL % P;
  a = (a * a + C1) % P;
  a = (a * a + C2) % P;
  return a / P;
}

/** The height (metres) a feature gets in random mode. */
export const randomHeight = (objectId, min, max) => min + stableUnit(objectId) * (max - min);

const FIELD_NAME = /^[A-Za-z_][\w.]*$/;
const fieldRef = name => {
  if (!FIELD_NAME.test(name || '')) throw new Error(`"${name}" isn't a valid field name.`);
  return `$feature["${name}"]`;
};
const num = v => (Number.isFinite(Number(v)) ? String(Number(v)) : '0');

/**
 * The Arcade valueExpression that gives each feature its height in metres (0 when heightMode is 'none').
 * Written with only the parts of Arcade that are also JavaScript (var, if, %, IsEmpty), so the tests can run it.
 * @param layer           a manifest scene layer { heightMode, heightField, minHeight, maxHeight }
 * @param objectIdField   the layer's ObjectID field (random mode)
 */
export function heightExpression(layer, objectIdField) {
  if (layer.heightMode === 'none') return 'return 0;';
  if (layer.heightMode === 'field') {
    return [
      `var h = ${fieldRef(layer.heightField)};`,
      'if (IsEmpty(h) || h < 0) { return 0; }',
      `if (h > ${SCENE_MAX_HEIGHT_M}) { return ${SCENE_MAX_HEIGHT_M}; }`,
      'return h;'
    ].join('\n');
  }
  const min = num(layer.minHeight), max = num(layer.maxHeight);
  return [
    `var id = ${fieldRef(objectIdField)};`,
    `if (IsEmpty(id) || id < 0) { return ${min}; }`,
    `var a = ((id % ${P}) + 1) * ${MUL} % ${P};`,
    `a = (a * a + ${C1}) % ${P};`,
    `a = (a * a + ${C2}) % ${P};`,
    `return ${min} + a / ${P} * (${max} - ${min});`
  ].join('\n');
}
