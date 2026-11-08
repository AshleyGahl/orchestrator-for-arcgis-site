// legendLabelsLive.js — Legend labels in the viewer: for each layer set up in manifest.legendLabels, reads the counts
// from the layer's service (one statistics query, one small row per category) and writes them into the labels of the
// layer's own style. Symbols are never changed. Reads again every refreshSeconds, but only while the page is visible,
// the map is on screen and the layer is showing; the style is only replaced when a label actually changed, so an
// unchanged refresh costs no redraw. Counts are read after the map's first draw, so they never hold it up.
// On a layer with Layer styles, the labels belong to the web map's style: counting pauses while another style shows,
// and the relabelled web map style is kept there to go back to.
import * as map from './map.js';
import * as styles from './layerStylesLive.js';
import { styleCategory, countQuery, readCounts, relabel, labelsOf } from './legendLabels.js';

const IDLE_CHECK_MS = 5000;     // a paused layer checks this often whether it's showing again (in the browser, no request)
let run = 0;                    // bumped by stop(): anything from an earlier start() drops out
const timers = new Set();

/** Stop every refresh (before the map is set up again). Labels already written stay until the layers are replaced. */
export function stop() {
  run++;
  for (const t of timers) clearTimeout(t);
  timers.clear();
}

/** Start counting for the layers in legendLabels ({ layers: { key: cfg } }), leaving out keys skip(key) is true for. */
export async function start(legendLabels, skip = () => false) {
  stop();
  const id = run;
  const entries = Object.entries(legendLabels?.layers ?? {}).filter(([key]) => !skip(key));
  if (!entries.length) return;
  await map.whenDrawn();
  if (id !== run) return;
  for (const [key, cfg] of entries) follow(key, cfg, id).catch(e => console.warn(`Legend labels: "${key}" keeps its own labels`, e));
}

async function follow(key, cfg, id) {
  const layer = await map.styleLayer(key);
  if (id !== run || !layer) return;                       // not in the map (a group-only or skipped service)
  if (layer.why) { console.warn(`Legend labels: "${layer.title ?? key}" keeps its own labels: ${layer.why}.`); return; }
  await styles.ready(key);                                // a start style may be on: the labels go on the web map's
  if (id !== run) return;
  const original = styles.webmapRenderer(key) ?? layer.renderer();
  const { field, why } = styleCategory(original);
  if (!field) { console.warn(`Legend labels: "${layer.title}" keeps its own labels: ${why}.`); return; }

  const query = countQuery(cfg, field, layer.objectIdField);
  let shown = labelsOf(original).join('\n');
  const later = (ms, fn) => {
    if (id !== run) return;
    const t = setTimeout(() => { timers.delete(t); fn(); }, ms);
    timers.add(t);
  };
  const tick = async () => {
    if (id !== run) return;
    if (document.hidden || !layer.showing() || !styles.showsWebmap(key)) { later(IDLE_CHECK_MS, tick); return; }
    try {
      const res = await layer.query(query);
      if (id !== run) return;
      const next = relabel(original, readCounts(res.features, field), cfg);
      const text = labelsOf(next).join('\n');
      if (text !== shown) { if (!styles.updateWebmap(key, next)) layer.setRenderer(next); shown = text; }
    } catch (e) {
      if (id !== run) return;
      console.warn(`Legend labels: counting "${layer.title}" failed`, e);
      if (map.isAuthError(e)) return;                     // no point asking again until the map is set up after a sign-in
    }
    if (cfg.refreshSeconds > 0) later(cfg.refreshSeconds * 1000, tick);
  };
  tick();
}
