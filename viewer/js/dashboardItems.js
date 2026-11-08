// dashboardItems.js — where dashboard items sit and how big they are, and the tables' default order. Pure functions.
// The grid is 12 columns wide with rows of a fixed height; each item has a width (cols) and a height (rows) and
// items flow in list order, left to right. Shared by the viewer (dashboards.js, map.js), Orchestration and
// Arrange in the Draft preview (dashboardArrange.js), so they all agree on sizes.

export const GRID_COLUMNS = 12;
export const ROW_PX = 60;            // one grid row; matches .dash-grid in app.css
export const GAP_PX = 14;
export const MAX_ROWS = 12;

/** Types that are tables rather than charts. */
export const TABLE_TYPES = new Set(['table', 'records']);

/** Width presets for the Orchestration editor: [cols, label]. */
export const WIDTH_PRESETS = [[3, '¼ width'], [4, '⅓ width'], [6, '½ width'], [8, '⅔ width'], [9, '¾ width'], [12, 'Full width']];

// The old "size" setting (before items could be resized), as a width.
const SIZE_COLS = { small: 3, medium: 6, large: 8, full: 12 };

/** The width and height a new item of a type starts with. */
export function defaultSpan(type) {
  if (type === 'indicator') return { cols: 3, rows: 2 };
  if (type === 'records') return { cols: 12, rows: 6 };
  if (type === 'table') return { cols: 6, rows: 6 };
  return { cols: 6, rows: 5 };
}

const clampInt = (v, min, max, fallback) => (Number.isFinite(Number(v)) ? Math.max(min, Math.min(max, Math.round(Number(v)))) : fallback);

/** An item's width and height, kept inside the grid (an older manifest's "size" counts when there's no width). */
export function spanOf(w) {
  const d = defaultSpan(w?.type);
  const cols = w?.cols ?? SIZE_COLS[w?.size] ?? d.cols;
  return { cols: clampInt(cols, 1, GRID_COLUMNS, d.cols), rows: clampInt(w?.rows, 1, MAX_ROWS, d.rows) };
}

/** Manifest upgrade: "size" becomes cols (and rows default by type). Changes w in place and returns it. */
export function upgradeSpan(w) {
  if (!w || typeof w !== 'object') return w;
  const s = spanOf(w);
  if (w.cols == null) w.cols = s.cols;
  if (w.rows == null) w.rows = s.rows;
  delete w.size;
  return w;
}

/**
 * Changing an item's type: the width and height follow the new type's defaults, unless someone had already
 * resized the item away from its old type's defaults.
 */
export function retypeSpan(w, newType) {
  const old = defaultSpan(w.type), now = spanOf(w), next = defaultSpan(newType);
  if (now.cols === old.cols && now.rows === old.rows) { w.cols = next.cols; w.rows = next.rows; }
  return w;
}

/**
 * The span a resize ends on: the starting pixel size plus how far the pointer moved, snapped to whole columns and
 * rows. colPx is one column's width without the gap.
 */
export function resizeSpan({ widthPx, heightPx, dx, dy, colPx, rowPx = ROW_PX, gapPx = GAP_PX }) {
  const cols = Math.round((widthPx + dx + gapPx) / (colPx + gapPx));
  const rows = Math.round((heightPx + dy + gapPx) / (rowPx + gapPx));
  return { cols: clampInt(cols, 1, GRID_COLUMNS, 1), rows: clampInt(rows, 1, MAX_ROWS, 1) };
}

/**
 * Apply an arranged layout to a dashboard's items: they take its order and sizes. Items the layout doesn't name
 * (added in Orchestration meanwhile) keep their size and go after the others, in their own order.
 */
export function applyLayout(widgets, layout) {
  const byId = new Map(layout.map((l, i) => [l.id, { ...l, i }]));
  const named = widgets.filter(w => byId.has(w.id)).sort((a, b) => byId.get(a.id).i - byId.get(b.id).i);
  const rest = widgets.filter(w => !byId.has(w.id));
  return [...named.map(w => { const l = byId.get(w.id); return { ...w, ...spanOf({ ...w, cols: l.cols, rows: l.rows }) }; }), ...rest];
}

/* ---------------- Tables ---------------- */
/**
 * The order a features table asks the server for: the chosen field, or else newest-first by ObjectID, Created or
 * Received (that priority, any case; the layer's ObjectID field counts whatever it's called), as the other grids
 * open. Returns "FIELD DESC", "FIELD ASC" or ''.
 */
export function recordsOrder(w, fields = []) {
  if (w?.orderField) return `${w.orderField} ${w.orderDirection === 'asc' ? 'ASC' : 'DESC'}`;
  const named = re => fields.find(f => re.test(f.name));
  const f = fields.find(x => /oid/i.test(x.type ?? '')) ?? named(/^objectid$/i) ?? named(/^created$/i) ?? named(/^received$/i);
  return f ? `${f.name} DESC` : '';
}

/** Summary table rows: label, value and (for counts and sums, where shares add up) the share of the total. */
export function summaryRows(rows, statistic) {
  const total = rows.reduce((t, r) => t + (Number(r.value) || 0), 0);
  const share = (statistic === 'count' || statistic === 'sum') && total > 0;
  return rows.map(r => ({ label: r.label, value: r.value, share: share ? r.value / total : null }));
}

/** Sort table rows by one column: cells hold { raw }; empty values go last either way. */
export function sortRows(rows, index, dir = 'asc') {
  const sign = dir === 'desc' ? -1 : 1;
  return [...rows].sort((a, b) => {
    const x = a.cells[index]?.raw ?? null, y = b.cells[index]?.raw ?? null;
    if (x === y) return 0;
    if (x === null || x === '') return 1;
    if (y === null || y === '') return -1;
    return (typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y), 'en-ZA', { numeric: true, sensitivity: 'base' })) * sign;
  });
}
