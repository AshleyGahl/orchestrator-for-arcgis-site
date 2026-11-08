// highlights.js — every place in a manifest that says how something stands out on the map (emphasis.js), in one list
// for the Orchestrator's Map highlights page: the selection colour, the widgets (Details, Editing, Attribute trace), the
// tools (Select features, Go to coordinates, Vegetation health), each spatial relationship section and each search
// source. Each entry knows where its settings live (a path into the manifest), what it is used for, and which settings
// apply to it, so the page reads and edits the same settings as the inline editors (one source of truth).
// Pure: no DOM, no SDK, so it runs in Node tests. highlightsEditor.js shows it.
import { normalizeEmphasis, plainEmphasis, ZOOM_SCALES } from './emphasis.js';

/** Every setting an emphasis has, as the table's columns: [id, label]. */
export const HIGHLIGHT_SETTINGS = [['colour', 'Colour'], ['flash', 'Flash'], ['fill', 'Fill'], ['lift', '3D lift'], ['zoom', 'Zoom']];
const ALL = HIGHLIGHT_SETTINGS.map(([id]) => id);

/** The table's groups, in order: [id, label]. */
export const HIGHLIGHT_GROUPS = [
  ['selection', 'Selection colour'],
  ['widgets', 'Widgets'],
  ['tools', 'Tools'],
  ['spatial', 'Spatial relationships'],
  ['search', 'Search']
];

/** The fixed targets: id, group, label, what it highlights, where its settings live, which settings apply, whether it's on. */
const FIXED = [
  { id: 'details', thin: true, group: 'widgets', label: 'Details', what: 'A feature clicked on the map, or picked in Details (also the Attribute trace start)',
    path: ['widgets', 'detailsEmphasis'], supports: ALL, on: m => m.widgets?.details !== false },
  { id: 'editing', thin: true, group: 'widgets', label: 'Editing', what: 'The record chosen in the Editing window',
    path: ['editing', 'emphasis'], supports: ALL, on: m => Boolean(m.widgets?.editing) },
  { id: 'trace', group: 'widgets', label: 'Attribute trace', what: 'The result chosen in the trace results',
    path: ['trace', 'emphasis'], supports: ALL, on: m => Boolean(m.widgets?.trace) },
  { id: 'select', thin: true, group: 'tools', label: 'Select features', what: 'A feature chosen from what the shape selected',
    path: ['widgets', 'toolConfig', 'select', 'emphasis'], supports: ALL, on: m => toolOn(m, 'select') },
  { id: 'go-to-xy', thin: true, group: 'tools', label: 'Go to coordinates', what: 'The place gone to (the tool sets its own zoom)',
    path: ['widgets', 'toolConfig', 'go-to-xy', 'emphasis'], supports: ['colour', 'flash', 'fill', 'lift'], on: m => toolOn(m, 'go-to-xy') },
  { id: 'vegetation', group: 'tools', label: 'Vegetation health', what: 'The spot clicked and the area measured',
    path: ['widgets', 'toolConfig', 'vegetation', 'emphasis'], supports: ['colour', 'flash', 'fill'], on: m => toolOn(m, 'vegetation') },
  { id: 'address-audit', group: 'tools', label: 'Address audit', what: 'The address chosen in the audit results',
    path: ['widgets', 'toolConfig', 'address-audit', 'emphasis'], supports: ALL, on: m => toolOn(m, 'address-audit') }
];
const toolOn = (m, id) => Array.isArray(m.widgets?.tools) && m.widgets.tools.includes(id);

/** Vegetation health's marks: its own green, as before it had settings. */
export const VEGETATION_MARK = '#10B981';

/** The defaults of the fixed targets that are new (each as the viewer drew it before it had settings). */
export const defaultDetailsEmphasis = () => plainEmphasis();
export const defaultSelectEmphasis = () => plainEmphasis();
export const defaultEditingEmphasis = () => plainEmphasis();
export const defaultGoToEmphasis = () => plainEmphasis();
export const defaultVegetationEmphasis = () => ({ ...plainEmphasis(), color: VEGETATION_MARK });

/**
 * Every highlight in a manifest, in table order. Each: { id, group, label, what, path, supports, on, thin?, layerKey? }.
 * thin: it draws the plain selection outline while it has no fill and no lift (map.js selection highlight).
 * The selection colour is the first entry (path null: it's branding.accent, selectionOnImagery and selectionLine).
 */
export function highlightTargets(m) {
  const out = [{ id: 'selection', group: 'selection', label: 'Selection colour', what: 'Every highlight without a colour of its own', path: null, supports: [], on: true }];
  for (const t of FIXED) out.push({ id: t.id, group: t.group, label: t.label, what: t.what, path: t.path, supports: t.supports, thin: Boolean(t.thin), on: t.on(m) });
  for (const [key, d] of Object.entries(m.details ?? {})) {
    (d?.sections ?? []).forEach((s, i) => {
      if (s?.type !== 'spatial') return;
      out.push({ id: `spatial:${key}:${s.id ?? i}`, group: 'spatial', layerKey: key, label: s.title || 'Spatial relationship',
        what: 'The result chosen in this relationship\'s window', path: ['details', key, 'sections', i, 'emphasis'], supports: ALL, on: true });
    });
  }
  (m.search?.boxSources ?? []).forEach((s, i) => out.push({
    id: `box:${s.id ?? i}`, group: 'search', layerKey: s.type === 'layer' ? s.layerKey : null,
    label: `Search box: ${s.name || (s.type === 'layer' ? 'layer' : 'geocoder')}`, what: 'The search box result chosen',
    path: ['search', 'boxSources', i, 'emphasis'], supports: ALL, on: true
  }));
  (m.search?.sources ?? []).forEach((s, i) => out.push({
    id: `search:${s.id ?? i}`, group: 'search', layerKey: s.layerKey, label: 'Attribute search', what: 'The attribute search result chosen',
    path: ['search', 'sources', i, 'emphasis'], supports: ALL, on: true
  }));
  return out;
}

/** The settings at a path (normalised; a missing block reads as its target's default). */
export function emphasisAt(m, path) {
  const v = path.reduce((o, k) => (o == null ? o : o[k]), m);
  return normalizeEmphasis(v ?? defaultFor(path));
}

function defaultFor(path) {
  const t = FIXED.find(x => x.path.join('/') === path.join('/'));
  if (!t) return undefined;                          // spatial, search and trace: emphasis.js's own default
  return { details: defaultDetailsEmphasis, editing: defaultEditingEmphasis, select: defaultSelectEmphasis, 'go-to-xy': defaultGoToEmphasis, vegetation: defaultVegetationEmphasis }[t.id]?.();
}

/**
 * Change the settings at a path in place (m is the draft): fn(emphasis) receives the block, made whole first. Parents
 * that are missing are made (toolConfig.go-to-xy on an old manifest). Returns false when the path no longer exists.
 */
export function editEmphasisAt(m, path, fn) {
  let o = m;
  for (const k of path.slice(0, -1)) {
    if (o[k] == null) {
      if (typeof k === 'number') return false;       // a section or source that's gone
      o[k] = {};
    }
    o = o[k];
    if (typeof o !== 'object') return false;
  }
  const last = path[path.length - 1];
  o[last] = emphasisAt(m, path);
  fn(o[last]);
  return true;
}

/** Copy one target's settings onto others (each keeps nothing of its own; settings that don't apply are ignored there). */
export function copyEmphasis(m, fromPath, toPaths) {
  const src = emphasisAt(m, fromPath);
  let n = 0;
  for (const p of toPaths) if (editEmphasisAt(m, p, e => Object.assign(e, structuredClone(src)))) n++;
  return n;
}

/** What one setting shows in the table, e.g. 'Off', '3 times', '60%', '24 px', '1:2,500', 'Fit'; '' where it doesn't apply. */
export function settingText(e, setting, supports = ALL) {
  if (!supports.includes(setting)) return '';
  const n = normalizeEmphasis(e);
  switch (setting) {
    case 'colour': return n.color || 'Selection';
    case 'flash': return n.flash ? `${n.flashTimes} time${n.flashTimes === 1 ? '' : 's'}` : 'Off';
    case 'fill': return n.highlight ? `${Math.round(n.fillOpacity * 100)}%` : 'Outline';
    case 'lift': return n.lift ? `${n.liftHeight} px` : 'Off';
    case 'zoom': return n.zoomScale ? (ZOOM_SCALES.find(([v]) => v === n.zoomScale)?.[1] ?? `1:${n.zoomScale.toLocaleString('en-ZA')}`) : 'Fit';
    default: return '';
  }
}
