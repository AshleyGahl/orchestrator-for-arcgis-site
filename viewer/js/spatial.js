// spatial.js — "Spatial relationship" sections: which features of other layers relate to the clicked feature
// by location (a ward contains parcels, hydrants within 100 m of a pipe). Pure: no DOM, no SDK, no config,
// so it runs in Node tests. map.js runs the queries; spatialWindow.js shows the results.
import { exportChoices, pickedColumns } from './tableExport.js';

/**
 * [id, label, sentence]. The sentence reads from the clicked feature's point of view, which is also how the
 * SDK reads spatialRelationship: the query geometry (the clicked feature) <relation> the layer's features.
 */
export const SPATIAL_RELATIONS = [
  ['contains', 'Contains', 'features that lie completely inside this feature'],
  ['within', 'Within', 'features that this feature lies completely inside'],
  ['intersects', 'Intersects', 'features that touch or overlap this feature in any way'],
  ['touches', 'Touches', 'features that share a boundary with this feature but don\'t overlap it'],
  ['overlaps', 'Overlaps', 'features of the same kind that partly overlap this feature'],
  ['crosses', 'Crosses', 'lines that cross this feature'],
  ['envelope-intersects', 'Envelope intersects', 'features whose bounding box meets this feature\'s bounding box (fast, approximate)'],
  ['within-distance', 'Within a distance of', 'features within the distance below of this feature']
];

export const SPATIAL_MAX_DISTANCE_M = 50000;

/** How the results window opens over the map. People can switch size from the window's header. */
export const SPATIAL_WINDOW_SIZES = [['default', 'Movable window'], ['half', 'Half the map'], ['full', 'The whole map'], ['bottom', 'Docked at the bottom']];
export const isSpatialWindowSize = id => SPATIAL_WINDOW_SIZES.some(([s]) => s === id);

const RELATION_IDS = new Set(SPATIAL_RELATIONS.map(([id]) => id));
export const isSpatialRelation = id => RELATION_IDS.has(id);
export const relationSentence = id => SPATIAL_RELATIONS.find(([r]) => r === id)?.[2] ?? '';

/**
 * Query settings for a section: { spatialRelationship, bufferMeters }.
 * "Within a distance" buffers the clicked feature (bufferMeters) and then asks for anything intersecting it,
 * which every MapServer and FeatureServer supports (unlike the query's own distance parameter).
 */
export function spatialQueryParams(section) {
  if (!isSpatialRelation(section?.relation)) throw new Error(`Unknown spatial relationship "${section?.relation}".`);
  if (section.relation === 'within-distance') {
    const d = Number(section.distance);
    if (!(d > 0 && d <= SPATIAL_MAX_DISTANCE_M)) throw new Error(`The distance must be between 1 and ${SPATIAL_MAX_DISTANCE_M} metres.`);
    return { spatialRelationship: 'intersects', bufferMeters: d };
  }
  return { spatialRelationship: section.relation, bufferMeters: 0 };
}

const isShape = name => /^shape([._]|$)/i.test(name) || /^st_(area|length)/i.test(name);

/**
 * Columns for one target layer: the author's choice, or every field except geometry ones.
 * ObjectID stays in the "all fields" case so tables open newest-first (resultsView's default sort).
 * @param chosen  [{ name, label? }] from the manifest
 * @param fields  the layer's fields [{ name, alias, type }]
 */
export function spatialColumns(chosen, fields = []) {
  const alias = new Map(fields.map(f => [f.name.toLowerCase(), f.alias || f.name]));
  if (chosen?.length) return chosen.map(f => ({ name: f.name, label: f.label || alias.get(f.name.toLowerCase()) || f.name }));
  return fields.filter(f => !isShape(f.name) && f.type !== 'esriFieldTypeGeometry' && f.type !== 'geometry')
    .map(f => ({ name: f.name, label: f.alias || f.name }));
}

/** outFields for the query: just the chosen columns (plus the ObjectID for highlighting), or everything. */
export function spatialOutFields(chosen, oidField) {
  if (!chosen?.length) return ['*'];
  return [...new Set([...(oidField ? [oidField] : []), ...chosen.map(f => f.name)])];
}

/* ---------- Export: every feature, with the columns people pick (tableExport.js) ---------- */
/** The export's column choices: the table's columns ticked, then the layer's other fields. [{ name, label, shown }] */
export const exportFieldChoices = (chosen, fields = []) => exportChoices(spatialColumns(chosen, fields), fields);

/** The columns to export (ticked names; null = the table's own), each with its kind. [{ name, label, kind }] */
export const exportColumns = (chosen, fields = [], picked = null) => pickedColumns(exportFieldChoices(chosen, fields), fields, picked);
