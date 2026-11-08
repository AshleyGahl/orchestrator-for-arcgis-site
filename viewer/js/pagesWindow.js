// pagesWindow.js — the External pages widget's window, at the author's width:
//   half: over half the map, on the author's side, with a drag handle between the window and the map (like Streaming,
//         Scene and Editing); the map stays usable beside it.
//   full: over the map and the panel.
// Narrow screens always get full width. It opens on a card for each page (with only one it goes straight in), and tabs
// in its header switch between them. Each page opens in a sandboxed frame (externalPages.js pageFrame) the first time
// it's shown and stays loaded while the window is closed or another page shows, so people don't lose their place in it;
// a new manifest starts again. A GIS viewer page (followMap) opens where the map is looking: its address is filled
// from handlers.position() the first time it's shown, and again when it's shown after the map has moved (or with Go to
// the map's position); otherwise people find it where they left it. Pure UI.
import { el, fill, halfWindowLeft } from './utils.js';
import { svgIcon } from './viewer.js';
import { pageFrame, pageHost, fillMapPosition } from './externalPages.js';
import { stackWindow } from './windowStack.js';

const PAGE_ICON = '<rect x="2.5" y="3.5" width="15" height="13" rx="1.5"/><path d="M2.5 7h15"/><circle cx="5" cy="5.25" r=".5" fill="currentColor"/><circle cx="7" cy="5.25" r=".5" fill="currentColor"/>';
const RELOAD_ICON = '<path d="M15.5 10a5.5 5.5 0 1 1-1.6-3.9"/><path d="M14.5 3v3.5H11"/>';
const MAP_ICON = '<circle cx="10" cy="10" r="5.5"/><circle cx="10" cy="10" r="1.5" fill="currentColor"/><path d="M10 2v3M10 15v3M2 10h3M15 10h3"/>';
const NEW_TAB_ICON = '<path d="M11 3.5h5.5V9"/><path d="M16.5 3.5 9.5 10.5"/><path d="M14 12v3.5a1 1 0 0 1-1 1H4.5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1H8"/>';
const HALF_MIN = 0.3, HALF_MAX = 0.7;
const NARROW_PX = 640;          // below this the map is too small to share: the window opens at full width

/**
 * @param host      the positioned element to float in (.viewer-body)
 * @param handlers  {
 *   onClose()                     people closed the window (close button or Escape)
 *   onPadding({ left?, right? })  keep the map's centre in the part the window leaves clear
 *   onOpenChange(open)
 *   position()                    Promise of where the map is looking ({ lon, lat, zoom, scale, xmin, ymin, xmax, ymax },
 *                                 WGS 84), or of null when it can't be told; asked for followMap pages only
 * }
 */
export function createPagesWindow(host, handlers) {
  let width = 'full';
  let side = 'left';
  let ratio = 0.5;
  let pages = [];               // [{ id, title, url, description, followMap }] in order
  let current = null;           // the page showing (null: the cards)
  let last = null;              // remembered for this manifest, so reopening goes back to it
  const frames = new Map();     // page id -> its iframe, once shown
  const shown = new Map();      // page id -> the address its frame was last sent to (followMap: with the map's position)
  let pick = 0;                 // the latest choose(), so an older one that's still waiting for the position gives way

  const title = el('strong', { class: 'pages-heading' }, 'External pages');
  const tabs = el('div', { class: 'pages-tabs', role: 'tablist', 'aria-label': 'External pages' });
  const reloadBtn = el('button', { type: 'button', class: 'icon-btn pages-act', title: 'Reload the page', 'aria-label': 'Reload the page', onclick: () => reload() }, svgIcon(RELOAD_ICON));
  const mapBtn = el('button', { type: 'button', class: 'icon-btn pages-act', title: 'Go to the map\'s position', 'aria-label': 'Go to the map\'s position', onclick: () => goToMap() }, svgIcon(MAP_ICON));
  const newTab = el('a', { class: 'icon-btn pages-act', target: '_blank', rel: 'noopener', title: 'Open in a new tab', 'aria-label': 'Open in a new tab' }, svgIcon(NEW_TAB_ICON));
  const closeBtn = el('button', { type: 'button', class: 'icon-btn pages-close', 'aria-label': 'Close External pages', title: 'Close External pages', onclick: () => handlers.onClose() }, '×');
  const head = el('header', { class: 'pages-head' }, title, tabs, el('span', { class: 'pages-gap' }), mapBtn, reloadBtn, newTab, closeBtn);

  const home = el('div', { class: 'pages-home', hidden: true });
  const stage = el('div', { class: 'pages-stage' });
  const footHost = el('span', {});
  const foot = el('p', { class: 'pages-foot muted', hidden: true }, footHost,
    ' Blank, or refusing to connect? Some sites don\'t allow being shown inside another page: open it in a new tab.');
  const FOLLOW_NOTE = ' Opens where the map is looking.';

  const handle = el('div', {
    class: 'ew-handle pages-handle', role: 'separator', tabindex: 0, 'aria-orientation': 'vertical', 'aria-label': 'Drag to share the space between External pages and the map',
    'aria-valuemin': HALF_MIN * 100, 'aria-valuemax': HALF_MAX * 100
  }, el('span', { class: 'ew-grip', 'aria-hidden': 'true' }));
  const win = el('section', { class: 'pages-window', role: 'region', 'aria-label': 'External pages', hidden: true },
    head, home, stage, foot, handle);
  host.append(win);
  stackWindow(win);                     // the window opened or clicked last is on top (windowStack.js)

  win.addEventListener('keydown', e => {
    if (e.key !== 'Escape' || document.fullscreenElement) return;
    e.stopPropagation();
    handlers.onClose();
  });
  window.addEventListener('resize', () => { if (!win.hidden) layout(); });

  /* ---------- Size and position (as the Streaming window) ---------- */
  const mapRect = () => {
    const hostR = host.getBoundingClientRect(), m = (host.querySelector('.map') ?? host).getBoundingClientRect();
    return { left: m.left - hostR.left, top: m.top - hostR.top, width: m.width, height: m.height };
  };
  const effectiveWidth = () => (width === 'half' && mapRect().width >= NARROW_PX ? 'half' : 'full');

  function layout() {
    const w = effectiveWidth();
    win.dataset.width = w;
    win.dataset.side = side;
    handle.hidden = w !== 'half';
    if (w === 'full') {
      for (const k of ['left', 'top', 'width', 'height']) win.style[k] = '';
      handlers.onPadding?.({});
      return;
    }
    const m = mapRect();
    const px = Math.round(m.width * ratio);
    Object.assign(win.style, { width: `${px}px`, height: `${m.height}px`, top: `${m.top}px`, left: `${halfWindowLeft(m, px, side)}px` });
    handle.setAttribute('aria-valuenow', String(Math.round(ratio * 100)));
    handlers.onPadding?.({ [side]: px });
  }

  // The frames would swallow the pointer while the edge is dragged over them, so they ignore it until the drag ends.
  handle.addEventListener('pointerdown', e => {
    e.preventDefault();
    handle.setPointerCapture(e.pointerId);
    win.classList.add('is-resizing');
    const move = ev => {
      const m = mapRect(), hostR = host.getBoundingClientRect();
      const x = ev.clientX - hostR.left - m.left;
      ratio = Math.min(HALF_MAX, Math.max(HALF_MIN, (side === 'left' ? x : m.width - x) / m.width));
      layout();
    };
    const up = () => {
      handle.removeEventListener('pointermove', move); handle.removeEventListener('pointerup', up);
      win.classList.remove('is-resizing');
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
  });
  handle.addEventListener('keydown', e => {
    const step = { ArrowLeft: -0.05, ArrowRight: 0.05 }[e.key];
    if (step == null) return;
    e.preventDefault();
    ratio = Math.min(HALF_MAX, Math.max(HALF_MIN, ratio + (side === 'left' ? step : -step)));
    layout();
  });

  /* ---------- Pages ---------- */
  const pageOf = id => pages.find(p => p.id === id) ?? null;

  function renderTabs() {
    tabs.hidden = pages.length < 2;
    title.textContent = pages.length === 1 ? pages[0].title : 'External pages';
    fill(tabs, ...pages.map((p, i) => el('button', {
      type: 'button', class: 'seg-btn pages-tab', role: 'tab', 'aria-selected': String(p.id === current), tabindex: p.id === current || (!current && i === 0) ? 0 : -1,
      title: p.description || pageHost(p.url),
      onclick: () => choose(p.id),
      onkeydown: e => {
        const to = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: pages.length - 1 }[e.key];
        if (to === undefined) return;
        e.preventDefault();
        choose(pages[(to + pages.length) % pages.length].id);
        tabs.querySelector('[aria-selected="true"]')?.focus();
      }
    }, el('span', {}, p.title))));
  }

  /** The header's Reload and Open in a new tab, and the footer, follow the page showing. */
  function renderActions() {
    const p = pageOf(current);
    reloadBtn.hidden = newTab.hidden = foot.hidden = !p;
    mapBtn.hidden = !p?.followMap;
    if (!p) return;
    newTab.href = shown.get(p.id) ?? (p.followMap ? fillMapPosition(p.url, null) : p.url);
    footHost.textContent = `From ${pageHost(p.url)}.${p.followMap ? FOLLOW_NOTE : ''}`;
  }

  function showHome() {
    current = null;
    stage.hidden = true;
    renderTabs();
    renderActions();
    fill(home,
      el('p', { class: 'pages-home-lead' }, 'Choose a page to open:'),
      el('div', { class: 'pages-cards' }, pages.map(p => el('button', { type: 'button', class: 'pages-card', onclick: () => choose(p.id) },
        svgIcon(PAGE_ICON),
        el('span', { class: 'pages-card-title' }, p.title),
        p.description ? el('span', { class: 'muted pages-card-blurb' }, p.description) : null,
        el('span', { class: 'pages-card-meta' }, pageHost(p.url))))));
    home.hidden = false;
    home.querySelector('.pages-card')?.focus({ preventScroll: true });
  }

  /** The address to open a page at: as written, or (followMap) with where the map is looking now. */
  const srcFor = async p => (p.followMap ? fillMapPosition(p.url, await Promise.resolve(handlers.position?.()).catch(() => null)) : p.url);

  /** Load an address in a frame from scratch (setting the same src again wouldn't reload a page that changed its own address). */
  function load(frame, src) {
    frame.src = 'about:blank';
    requestAnimationFrame(() => { frame.src = src; });
  }

  /**
   * Show a page: its frame is made (and starts loading) the first time; after that it's shown as people left it,
   * unless it follows the map and the map has moved since: then it opens again where the map is now.
   */
  async function choose(id) {
    const p = pageOf(id);
    if (!p) return;
    current = id;
    last = id;
    home.hidden = true;
    stage.hidden = false;
    for (const [fid, f] of frames) f.hidden = fid !== id;
    renderTabs();
    renderActions();
    const n = ++pick;
    const src = await srcFor(p);
    if (n !== pick || pageOf(id) !== p) return;
    const frame = frames.get(id);
    if (!frame) {
      const made = el('iframe', { class: 'pages-frame', src, title: p.title, ...pageFrame(src, location.origin) });
      made.hidden = current !== id;
      frames.set(id, made);
      stage.append(made);
    } else if (src !== shown.get(id)) load(frame, src);
    shown.set(id, src);
    renderActions();
  }

  /** Go to the map's position: the page opens again where the map is looking, even if the map hasn't moved. */
  async function goToMap() {
    const p = pageOf(current), frame = frames.get(current);
    if (!p?.followMap || !frame) return;
    const src = await srcFor(p);
    if (pageOf(current) !== p) return;
    load(frame, src);
    shown.set(p.id, src);
    renderActions();
  }

  function reload() {
    const p = pageOf(current), frame = frames.get(current);
    if (!p || !frame) return;
    load(frame, shown.get(p.id) ?? p.url);
  }

  function open(id = null) {
    const wasOpen = !win.hidden;
    if (!wasOpen) {
      win.hidden = false;
      host.classList.add('pages-open');
      layout();
      handlers.onOpenChange?.(true);
    }
    const to = pageOf(id)?.id ?? (pages.length === 1 ? pages[0].id : wasOpen ? current : last);
    if (to) choose(to);
    else showHome();
    if (!wasOpen) (tabs.querySelector('[aria-selected="true"]') ?? closeBtn).focus({ preventScroll: true });
  }

  function close() {
    if (win.hidden) return;
    win.hidden = true;
    host.classList.remove('pages-open');
    handlers.onPadding?.({});
    handlers.onOpenChange?.(false);
  }

  return {
    /**
     * The manifest's External pages settings (call on every manifest; closes the window and unloads the pages).
     * @param cfg  manifest.externalPages, or null when the widget is off
     */
    set(cfg) {
      close();
      width = cfg?.width === 'half' ? 'half' : 'full';
      side = cfg?.side === 'right' ? 'right' : 'left';
      ratio = 0.5;
      pages = cfg?.pages ?? [];
      current = last = null;
      for (const f of frames.values()) f.remove();
      frames.clear();
      shown.clear();
      pick++;
      renderTabs();
      renderActions();
    },
    /** Open the window (on page `id`, the remembered page, or the cards). */
    open,
    close,
    isOpen: () => !win.hidden,
    width: effectiveWidth
  };
}
