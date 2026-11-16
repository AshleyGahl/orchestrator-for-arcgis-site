// layerOrder.js — the order of the map's top-level layers (manifest webmap.layerOrder), top first. Shared by
// Orchestration (the Layer order list) and the viewer (map.js reorders the map), so both show the same order.
// Top-level layers are the web map's operational layers (a group layer moves with everything in it) and the extra
// ArcGIS REST services. Also which top-level web map layers are on when the viewer opens (webmap.layerVisibility).
// Pure: no DOM, no SDK.

/**
 * Known ids in the chosen order. `order` names ids top first; unknown and repeated ones are skipped. An id it
 * doesn't name (a layer added to the web map, or a service added, after the order was chosen) keeps its default
 * place: just below the layer above it in the default order, or at the top when nothing above it is placed.
 * An empty or missing order is the default order.
 */
export function orderLayers(defaults, order) {
  const known = new Set(defaults);
  const out = [...new Set(Array.isArray(order) ? order : [])].filter(id => known.has(id));
  const placed = new Set(out);
  defaults.forEach((id, i) => {
    if (placed.has(id)) return;
    let above = null;
    for (let j = i - 1; j >= 0 && above == null; j--) if (placed.has(defaults[j])) above = defaults[j];
    out.splice(above == null ? 0 : out.indexOf(above) + 1, 0, id);
    placed.add(id);
  });
  return out;
}

/** True when the chosen order differs from the default one. */
export const isCustomLayerOrder = (defaults, order) => orderLayers(defaults, order).some((id, i) => id !== defaults[i]);

/** The full order after moving one id by `delta` places (-1 = up, 1 = down; 'top' / 'bottom' go to an end). */
export function moveLayer(defaults, order, id, delta) {
  const ids = orderLayers(defaults, order);
  const i = ids.indexOf(id);
  if (i < 0) return ids;
  const j = delta === 'top' ? 0 : delta === 'bottom' ? ids.length - 1 : Math.max(0, Math.min(ids.length - 1, i + delta));
  ids.splice(i, 1);
  ids.splice(j, 0, id);
  return ids;
}

/**
 * Sort entries (Orchestration's flat layer list) by the top-level layer each belongs to (`topOf(entry)`), keeping
 * the order within one top-level layer. Entries whose top-level layer isn't in `ids` go last, in their own order.
 */
export function sortByLayerOrder(entries, ids, topOf) {
  const rank = new Map(ids.map((id, i) => [id, i]));
  return entries.map((e, i) => [e, rank.get(topOf(e)) ?? ids.length, i])
    .sort((a, b) => a[1] - b[1] || a[2] - b[2]).map(([e]) => e);
}

/* ---------- Starting visibility (manifest webmap.layerVisibility) ---------- */
// { "<web map layer id>": true | false }, only for layers switched differently from the web map: a top-level
// operational layer, or a layer inside a group layer by its own id (a group's own switch covers everything in it,
// and a layer inside a group only shows when its group is on too).
// Extra ArcGIS REST services keep theirs in webmap.extraServices[].visible.

/** Whether a web map layer is on when the viewer opens: the manifest's choice, else the web map's own. */
export const isLayerOn = (id, webmapOn, visibility) => (typeof visibility?.[id] === 'boolean' ? visibility[id] : webmapOn !== false);

/** A new layerVisibility with one layer set; a setting equal to the web map's own is removed, so the manifest only holds changes. */
export function setLayerOn(visibility, id, on, webmapOn) {
  const out = { ...(visibility ?? {}) };
  if (on === (webmapOn !== false)) delete out[id];
  else out[id] = on;
  return out;
}

/** Check a manifest webmap.layerVisibility. Returns error sentences (empty when fine). */
export function checkLayerVisibility(visibility, serviceIds = []) {
  if (visibility == null) return [];
  if (typeof visibility !== 'object' || Array.isArray(visibility) || Object.entries(visibility).some(([id, on]) => !id || typeof on !== 'boolean')) {
    return ['webmap.layerVisibility must map layer ids to true or false.'];
  }
  const services = Object.keys(visibility).filter(id => serviceIds.includes(id));
  return services.length ? [`webmap.layerVisibility can't set ArcGIS REST services (${services.join(', ')}); use their "visible" in webmap.extraServices.`] : [];
}

/** Check a manifest webmap.layerOrder. Returns error sentences (empty when fine). Ids it names that aren't in the map are ignored. */
export function checkLayerOrder(list) {
  if (list == null) return [];
  if (!Array.isArray(list) || list.some(id => typeof id !== 'string' || !id)) return ['webmap.layerOrder must be a list of layer ids (top first).'];
  if (new Set(list).size !== list.length) return ['webmap.layerOrder must list each layer at most once.'];
  return [];
}

/* ---------- Layers the viewer never gets (manifest webmap.layersLeftOut) ---------- */
// A flat list of layer keys. The layer isn't added to the map at all, so the Layers widget, Legend, Details,
// Search, dashboards, editing, the scene and labels never see it and its service is never asked for anything.
// Keys: a top-level web map operational layer id, a web map layer inside a group layer by its own id, an
// extraServices id, or "<id>:<n>" for a map service's sublayer or one layer of a feature service. Naming a layer
// or service leaves out everything under it. Stronger than details[key].exclude (Details only) and
// layerVisibility (starts off, people can switch it on). Settings saved for the layer are kept.

/** Is this layer key left out: named itself, or under a layer or service that is? (Same prefix rule as restServices.) */
export const isLeftOut = (key, list) => {
  const k = String(key ?? '');
  for (const id of list ?? []) if (k === id || k.startsWith(`${id}:`)) return true;
  return false;
};

/** A new layersLeftOut with one key served (`on`) or left out. Keys stay in the order given, each at most once. */
export function setLeftOut(list, key, out) {
  const kept = (list ?? []).filter(k => k !== key);
  return out ? [...kept, key] : kept;
}

/** Check a manifest webmap.layersLeftOut. Returns error sentences (empty when fine). */
export function checkLayersLeftOut(list) {
  if (list == null) return [];
  if (!Array.isArray(list) || list.some(k => typeof k !== 'string' || !k)) return ['webmap.layersLeftOut must be a list of layer keys.'];
  if (new Set(list).size !== list.length) return ['webmap.layersLeftOut must list each layer at most once.'];
  return [];
}
