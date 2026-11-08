// resultsDock.js — results tables docked at the bottom of the map: a drawer the width of the map, with a grip on its
// top edge to drag it taller or shorter (or Up / Down arrows on the grip). Details and Search (layout.resultsAt),
// spatial relationship windows (windowSize 'bottom'), Attribute trace (width 'bottom') and Address audit use it; the
// map is padded by the drawer's height, so a row's feature is zoomed to in the part of the map left clear.
// The geometry is pure (tested); dockGrip() makes the grip and only touches the DOM when called.

/** Where Details and Search show their results (manifest layout.resultsAt). People can switch in the viewer. */
export const RESULTS_PLACES = [['panel', 'In the side panel'], ['bottom', 'Docked at the bottom of the map']];
export const isResultsAt = v => RESULTS_PLACES.some(([id]) => id === v);

export const DOCK_MIN = 0.2, DOCK_MAX = 0.8, DOCK_DEFAULT = 0.4;
const DOCK_MIN_PX = 140;               // never shorter than a header and a couple of rows
const DOCK_STEP = 0.05;                // one arrow key on the grip

/** A dock height ratio (of the map's height) kept within DOCK_MIN–DOCK_MAX; anything unusable is the default. */
export const dockRatio = r => (Number.isFinite(r) ? Math.min(DOCK_MAX, Math.max(DOCK_MIN, r)) : DOCK_DEFAULT);

/**
 * The drawer's box over the map. m: the map's box in the host's coordinates { left, top, width, height }.
 * @returns { left, top, width, height } in pixels, whole numbers
 */
export function dockRect(m, ratio) {
  const h = Math.min(m.height, Math.max(Math.min(DOCK_MIN_PX, m.height), Math.round(m.height * dockRatio(ratio))));
  return { left: Math.round(m.left), top: Math.round(m.top + m.height - h), width: Math.round(m.width), height: h };
}

/** The ratio for the grip dragged to y (pixels from the host's top), the drawer's top edge following the pointer. */
export const ratioAt = (m, y) => dockRatio(m.height > 0 ? (m.top + m.height - y) / m.height : DOCK_DEFAULT);

/** The ratio after an arrow key on the grip (Up: taller, Down: shorter); null for any other key. */
export function ratioForKey(ratio, key) {
  const step = { ArrowUp: DOCK_STEP, ArrowDown: -DOCK_STEP }[key];
  return step == null ? null : dockRatio(dockRatio(ratio) + step);
}

/**
 * The grip on a docked drawer's top edge.
 * @param host      the positioned element the drawer floats in (.viewer-body)
 * @param mapRect   () => the map's box in the host's coordinates
 * @param get, set  the current ratio, and a new one (set lays the drawer out again)
 * @param label     what the grip resizes, for screen readers
 */
export function dockGrip({ host, mapRect, get, set, label = 'results' }) {
  const grip = document.createElement('div');
  grip.className = 'dock-grip';
  grip.tabIndex = 0;
  for (const [k, v] of Object.entries({ role: 'separator', 'aria-orientation': 'horizontal', 'aria-label': `Drag to make the ${label} taller or shorter`,
    'aria-valuemin': DOCK_MIN * 100, 'aria-valuemax': DOCK_MAX * 100 })) grip.setAttribute(k, String(v));
  grip.append(Object.assign(document.createElement('span'), { className: 'dock-grip-bar' }));
  grip.addEventListener('pointerdown', e => {
    e.preventDefault();
    grip.setPointerCapture(e.pointerId);
    grip.classList.add('is-resizing');
    const move = ev => set(ratioAt(mapRect(), ev.clientY - host.getBoundingClientRect().top));
    const up = () => { grip.removeEventListener('pointermove', move); grip.removeEventListener('pointerup', up); grip.classList.remove('is-resizing'); };
    grip.addEventListener('pointermove', move);
    grip.addEventListener('pointerup', up);
  });
  grip.addEventListener('keydown', e => {
    const r = ratioForKey(get(), e.key);
    if (r == null) return;
    e.preventDefault();
    set(r);
  });
  return { grip, sync: () => grip.setAttribute('aria-valuenow', String(Math.round(dockRatio(get()) * 100))) };
}
