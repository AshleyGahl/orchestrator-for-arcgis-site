// spatialWindow.js — the window that shows a spatial relationship's results over the map: one sortable table
// per layer. It opens at the size the section asks for (a movable window, half the map on the side the author
// chose, or the whole map), people can switch size from its header, and it closes with × or Esc. Choosing a row
// keeps the map's centre in the part of the map the window leaves clear, so the feature isn't zoomed to behind it.
// Each layer can be exported in full (every feature, not just the page showing) as Excel or CSV, with the columns
// people tick: the table's own to start with, plus any of the layer's other fields (exportForm.js).
// Pure UI: results come in, row selections and closing go out through handlers.
import { CONFIG } from './config.js';
import { el, fill, halfWindowLeft } from './utils.js';
import { dataTable } from './resultsView.js';
import { SPATIAL_WINDOW_SIZES } from './spatial.js';
import { exportControl } from './exportForm.js';
import { stackWindow } from './windowStack.js';
import { DOCK_DEFAULT, dockGrip, dockRect } from './resultsDock.js';

/**
 * @param host      the positioned element to float in (.viewer-body)
 * @param handlers  { onSelectRow(row), onClose(), csv(): boolean, onPadding({ left?, right?, top?, bottom? }) }
 *                  onPadding keeps the map's centre (and zooms to a result) in the part the window leaves clear;
 *                  csv() offers Export (Excel or CSV) on each layer
 */
let windows = 0;

export function createSpatialWindow(host, handlers) {
  let size = 'default';
  let side = 'left';                    // which side half the map takes (the section's windowSide)
  let floatPos = null;                  // where the movable window was last, so switching back keeps it
  let dockRatio = DOCK_DEFAULT;         // docked at the bottom: its share of the map's height (people drag the grip)

  const titleId = `sw-title-${++windows}`;   // each results window (spatial, Address audit) labels itself
  const titleEl = el('h3', { class: 'sw-title', id: titleId });
  const subEl = el('p', { class: 'sw-sub' });
  const sizeBtns = new Map(SPATIAL_WINDOW_SIZES.map(([id, label]) => [id, el('button', {
    type: 'button', 'aria-pressed': 'false', title: label, onclick: () => setSize(id)
  }, { default: 'Window', half: 'Half', full: 'Full', bottom: 'Bottom' }[id] ?? label)]));
  const closeBtn = el('button', { type: 'button', class: 'icon-btn sw-close', 'aria-label': 'Close', onclick: () => close() }, '×');
  const head = el('header', { class: 'sw-head' },
    el('div', { class: 'sw-head-text' }, titleEl, subEl),
    el('div', { class: 'fields-as small sw-sizes', role: 'group', 'aria-label': 'Window size' }, [...sizeBtns.values()]),
    closeBtn);
  const body = el('div', { class: 'sw-body' });
  const win = el('section', { class: 'spatial-window', role: 'dialog', 'aria-labelledby': titleId, tabindex: -1, hidden: true }, head, body);
  host.append(win);
  stackWindow(win);                     // the window opened or clicked last is on top (windowStack.js)
  const dock = dockGrip({ host, mapRect: () => mapRect(), get: () => dockRatio, set: r => { dockRatio = r; layout(); }, label: 'results window' });
  win.prepend(dock.grip);

  win.addEventListener('keydown', e => { if (e.key === 'Escape') { e.stopPropagation(); close(); } });
  const onResize = () => { if (!win.hidden) layout(); };
  window.addEventListener('resize', onResize);

  /* ---------- Size and position: always over the map, never over the panel ---------- */
  const mapRect = () => {
    const hostR = host.getBoundingClientRect(), m = (host.querySelector('.map') ?? host).getBoundingClientRect();
    return { left: m.left - hostR.left, top: m.top - hostR.top, width: m.width, height: m.height };
  };
  function place(left, top) {
    const m = mapRect();
    const maxL = Math.max(m.left, m.left + m.width - win.offsetWidth), maxT = Math.max(m.top, m.top + m.height - 48);
    floatPos = { left: Math.min(Math.max(left, m.left), maxL), top: Math.min(Math.max(top, m.top), maxT) };
    win.style.left = `${floatPos.left}px`;
    win.style.top = `${floatPos.top}px`;
  }
  function layout() {
    const m = mapRect();
    win.classList.toggle('docked', size !== 'default');
    for (const [id, b] of sizeBtns) b.setAttribute('aria-pressed', String(id === size));
    dock.grip.hidden = size !== 'bottom';
    if (size === 'bottom') {                      // along the bottom of the map, as tall as people drag it
      const r = dockRect(m, dockRatio);
      win.dataset.side = 'bottom';
      Object.assign(win.style, { width: `${r.width}px`, height: `${r.height}px`, left: `${r.left}px`, top: `${r.top}px` });
      dock.sync();
      handlers.onPadding?.({ bottom: r.height });
      return;
    }
    if (size === 'default') {
      win.style.width = `${Math.min(720, Math.max(280, m.width - 32))}px`;
      win.style.height = '';
      place(floatPos?.left ?? m.left + 16, floatPos?.top ?? m.top + 16);
      handlers.onPadding?.({});
      return;
    }
    // Half: the author's side of the map. Full: the whole map.
    const w = size === 'full' ? m.width : Math.round(m.width / 2);
    win.dataset.side = side;
    win.style.width = `${w}px`;
    win.style.height = `${m.height}px`;
    win.style.left = `${size === 'half' ? halfWindowLeft(m, w, side) : m.left}px`;
    win.style.top = `${m.top}px`;
    handlers.onPadding?.(size === 'half' ? { [side]: w } : {});
  }
  /**
   * The movable window covers part of the map, so before a row zooms to its feature the map is padded on the side
   * that leaves the biggest clear area (beside, above or below the window). Half the map is padded by layout().
   */
  function keepClear() {
    if (size !== 'default' || win.hidden) return;
    const m = mapRect();
    const w = { left: win.offsetLeft, top: win.offsetTop, right: win.offsetLeft + win.offsetWidth, bottom: win.offsetTop + win.offsetHeight };
    const clamp = v => Math.max(0, Math.round(v));
    const options = [
      { pad: { left: clamp(w.right - m.left) }, area: (m.left + m.width - w.right) * m.height },
      { pad: { right: clamp(m.left + m.width - w.left) }, area: (w.left - m.left) * m.height },
      { pad: { top: clamp(w.bottom - m.top) }, area: (m.top + m.height - w.bottom) * m.width },
      { pad: { bottom: clamp(m.top + m.height - w.top) }, area: (w.top - m.top) * m.width }
    ];
    const best = options.reduce((a, b) => (b.area > a.area ? b : a));
    // A window over (almost) the whole map leaves nothing worth centring on.
    handlers.onPadding?.(best.area > 0.15 * m.width * m.height ? best.pad : {});
  }
  const selectRow = row => { keepClear(); handlers.onSelectRow(row); };

  function setSize(id) {
    size = SPATIAL_WINDOW_SIZES.some(([s]) => s === id) ? id : 'default';
    layout();
  }

  head.addEventListener('pointerdown', e => {
    if (size !== 'default' || e.target.closest('button')) return;
    const start = { x: e.clientX, y: e.clientY, left: win.offsetLeft, top: win.offsetTop };
    head.setPointerCapture(e.pointerId);
    const move = ev => place(start.left + ev.clientX - start.x, start.top + ev.clientY - start.y);
    const up = () => { head.removeEventListener('pointermove', move); head.removeEventListener('pointerup', up); };
    head.addEventListener('pointermove', move);
    head.addEventListener('pointerup', up);
  });

  function show(title, subtitle, open) {
    titleEl.textContent = title;
    subEl.textContent = subtitle;
    const wasHidden = win.hidden;
    win.hidden = false;
    side = open?.side === 'right' ? 'right' : 'left';
    if (wasHidden) setSize(open?.size);
    else layout();
    win.focus({ preventScroll: true });
  }

  function layerBlock(r) {
    const n = v => v.toLocaleString(CONFIG.numberLocale);
    const offset = r.offset ?? 0;
    const count = !r.truncated ? `${r.rows.length}`
      : offset ? `${n(offset + 1)}–${n(offset + r.rows.length)} of ${n(r.total)}`
      : `first ${n(r.rows.length)} of ${n(r.total)}`;
    const canExport = handlers.csv?.() && r.rows.length && !r.error && typeof r.exportAll === 'function';
    const exp = canExport ? exportControl({ title: r.title, total: r.total, choices: r.exportFields ?? [], exportAll: r.exportAll }) : null;
    let content;
    if (r.error) content = el('p', { class: 'err' }, `Couldn't search this layer: ${r.error}`);
    else if (!r.rows.length) content = el('p', { class: 'muted' }, 'None.');
    else content = dataTable({ columns: r.columns, rows: r.rows, label: r.title, onSelect: selectRow });
    const block = el('section', { class: 'sw-layer' },
      el('div', { class: 'sw-layer-head' },
        el('h4', {}, r.title, el('span', { class: 'count' }, ` ${r.error ? '' : count}`)),
        el('div', { class: 'sw-layer-tools' }, pager(r), exp?.button)),
      exp?.panel,
      content);
    // Previous / Next swap this layer's block for the page they fetch; the other layers stay as they are.
    function pager(r) {
      if (!r.page || r.error) return null;
      const pages = Math.ceil(r.total / r.pageSize), at = Math.floor(offset / r.pageSize);
      const go = async (to, btn) => {
        for (const b of nav.querySelectorAll('button')) b.disabled = true;
        btn.textContent = '…';
        try { block.replaceWith(layerBlock(await r.page(to))); }
        catch (e) { nav.replaceWith(el('span', { class: 'err' }, `Couldn't load that page: ${e.message}`)); }
      };
      const prev = el('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Previous page', disabled: at === 0, onclick: () => go(offset - r.pageSize, prev) }, '‹ Prev');
      const next = el('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Next page', disabled: at >= pages - 1, onclick: () => go(offset + r.pageSize, next) }, 'Next ›');
      const nav = el('div', { class: 'sw-pager', role: 'group', 'aria-label': `${r.title} pages` },
        prev, el('span', { class: 'count' }, `Page ${at + 1} of ${pages}`), next);
      return nav;
    }
    return block;
  }

  function close() {
    if (win.hidden) return;
    win.hidden = true;
    fill(body);
    handlers.onPadding?.({});
    handlers.onClose?.();
  }

  return {
    /**
     * open: { size, side }, the section's windowSize ('default' | 'half' | 'full' | 'bottom') and windowSide ('left' | 'right').
     * The size only applies when the window opens; the side applies whenever it's at half the map.
     */
    loading(title, subtitle, open) { show(title, subtitle, open); fill(body, el('p', { class: 'muted' }, 'Searching…')); },
    show(title, subtitle, results, open) { show(title, subtitle, open); fill(body, results.map(layerBlock)); },
    error(title, subtitle, message, open) { show(title, subtitle, open); fill(body, el('p', { class: 'err' }, message)); },
    close,
    isOpen: () => !win.hidden,
    /** Close and remove the window (a tool that made its own, such as Address audit, closing). */
    destroy() { close(); win.remove(); window.removeEventListener('resize', onResize); }
  };
}
