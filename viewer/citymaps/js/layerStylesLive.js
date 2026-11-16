// layerStylesLive.js — Layer styles in the viewer: for each layer set up in manifest.layerStyles, keeps the web map's
// own style, checks each style against the layer as it loaded for this person (a style whose field the service doesn't
// share with them is left out), and switches styles. A style with the layer's own outlines (outlines 'layer', polygon
// layers) is drawn over the layer by a display-only copy (map.js styleOverlay), so the layer keeps drawing as in the
// web map; any other style replaces the layer's renderer (a feature layer then fetches a newly needed field for what's
// in view by itself, a map service sublayer asks for a new image). Nothing is queried here. The start style is put on
// before the first draw where it can be.
import * as map from './map.js';
import { choices, fieldProblems, rendererFor, drawsOver, WEBMAP_STYLE } from './layerStyles.js';

let run = 0;                    // bumped by stop(): anything from an earlier start() drops out
const configs = new Map();      // layer key -> { start, styles } (only layers with an enabled style)
const pending = new Map();      // layer key -> Promise<state|null>
const listeners = new Set();    // (key, styleId) => void, told after every switch (the Layers list's style choices)
const settled = new Map();      // layer key -> state, once checked: { handle, webmap, styles, renderers: Map<id, json>, active, replaced }

/** Forget every layer (before the map is set up again). The renderers stay on the old layers, which are replaced. */
export function stop() {
  run++;
  configs.clear();
  pending.clear();
  settled.clear();
  listeners.clear();
}

/** Be told after the style of a layer changes: fn(key, styleId). Returns a function that stops it. */
export function onChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/**
 * Start for the layers in layerStyles ({ layers: { key: { start, styles } } }), leaving out keys skip(key) is true for.
 * Synchronous for has(): call it before the Layers list is built. Each layer then gets ready on its own.
 */
export function start(layerStyles, skip = () => false) {
  stop();
  const id = run;
  for (const [key, cfg] of Object.entries(layerStyles?.layers ?? {})) {
    if (skip(key) || !(cfg?.styles ?? []).some(s => s.enabled !== false)) continue;
    configs.set(key, cfg);
    pending.set(key, prepare(key, cfg, id)
      .catch(e => { console.warn(`Layer styles: "${key}" keeps its own style`, e); return null; })
      .then(state => { if (id === run && state) settled.set(key, state); return id === run ? state : null; }));
  }
}

async function prepare(key, cfg, id) {
  const handle = await map.styleLayer(key);
  if (id !== run || !handle) return null;                 // not in the map (a group-only or skipped service)
  if (handle.why) { console.warn(`Layer styles: "${handle.title ?? key}" keeps its own style: ${handle.why}.`); return null; }
  const renderers = new Map();
  const styles = new Map();
  for (const s of cfg.styles.filter(x => x.enabled !== false)) {
    styles.set(s.id, s);
    const { field, why } = fieldProblems(s, handle.fields, handle.geometryType);
    const json = why ? null : rendererFor(s, handle.geometryType, field);
    if (json) renderers.set(s.id, json);
    else console.warn(`Layer styles: "${s.name}" isn't offered on "${handle.title}": ${why ?? "it can't draw this layer"}.`);
  }
  if (!renderers.size) return null;
  const state = { handle, webmap: handle.renderer(), styles, renderers, active: WEBMAP_STYLE, replaced: false };
  if (cfg.start && cfg.start !== WEBMAP_STYLE && renderers.has(cfg.start)) put(state, cfg.start);
  return state;
}

/** Show a style: over the layer (its renderer back to the web map's), or in place of the layer's renderer. */
function put(state, styleId) {
  const { handle } = state;
  const json = styleId === WEBMAP_STYLE ? state.webmap : state.renderers.get(styleId);
  if (!json) throw new Error("that style isn't available on this layer");
  const style = state.styles.get(styleId);
  const over = Boolean(style && handle.overlay && drawsOver(style, handle.geometryType));
  if (over || styleId === WEBMAP_STYLE) {
    if (state.replaced) { handle.setRenderer(state.webmap); state.replaced = false; }
    if (over) handle.overlay.show(json, `${handle.title}: ${style.name}`); else handle.overlay?.hide();
  } else {
    handle.overlay?.hide();
    handle.setRenderer(json);
    state.replaced = true;
  }
  state.active = styleId;
}

/** True when the layer has styles to choose from (it may still turn out to have none once it's checked). */
export const has = key => configs.has(key);

/** Resolves once the layer is checked (and its start style is on); immediately for a layer with no styles. */
export const ready = async key => { await pending.get(key); };

/**
 * The styles people can choose on the layer, the web map's first: { active, choices: [{ id, name, description }] }.
 * Null when the layer has none it can use.
 */
export async function options(key) {
  const state = await pending.get(key);
  if (!state) return null;
  return { active: state.active, choices: choices(configs.get(key)).filter(c => c.id === WEBMAP_STYLE || state.renderers.has(c.id)) };
}

/** Switch the layer to a style. On failure the layer goes back to the style it had, and the error is thrown. */
export async function choose(key, styleId) {
  const state = await pending.get(key);
  if (!state) throw new Error('this layer has no styles');
  const before = state.active;
  try { put(state, styleId); }
  catch (e) {
    try { put(state, before); } catch { /* the earlier style stays as the SDK left it */ }
    throw e;
  } finally {
    for (const fn of listeners) fn(key, state.active);
  }
}

/** True while the layer itself draws with the web map's own style (also under a style drawn over it, and with no styles). */
export const showsWebmap = key => !settled.get(key)?.replaced;

/** The display-only copy showing the layer's style over it, or null (none showing). The Layers list shows its legend. */
export const overlayLayer = key => settled.get(key)?.handle.overlay?.layer() ?? null;

/** The web map's own style as kept here: null for a layer with no styles. Legend labels relabels this one. */
export const webmapRenderer = key => settled.get(key)?.webmap ?? null;

/**
 * Legend labels rewrote the web map's style (new counts): keep it as the one to go back to, and put it on the layer
 * only while that style is showing. Returns false when the layer has no styles (the caller sets it itself).
 */
export function updateWebmap(key, json) {
  const state = settled.get(key);
  if (!state) return false;
  state.webmap = json;
  if (!state.replaced) state.handle.setRenderer(json);
  return true;
}
