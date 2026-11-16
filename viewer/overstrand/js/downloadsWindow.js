// downloadsWindow.js — the Downloads widget's window, at the author's width (half: beside the map, with a drag handle;
// full: over the map and the panel; narrow screens always full), like External pages. It opens on a card for each
// download page (with only one it goes straight in), and tabs in its header switch between them. Each page is a
// table of its items (name, type, count, dates; downloads.js downloadTable), read the first time it's shown through
// handlers.load and kept until Reload or a new manifest, with a filter box over it. Pure UI.
import { el, fill, halfWindowLeft } from './utils.js';
import { svgIcon } from './viewer.js';
import { dataTable } from './resultsView.js';
import { downloadTable, filterRows, sourceHost, defaultCountLabel, itemCount, COUNT_NOTE } from './downloads.js';
import { stackWindow } from './windowStack.js';

const LIST_ICON = '<path d="M10 3v9"/><path d="m6.5 8.5 3.5 3.5 3.5-3.5"/><path d="M3.5 13.5v2a1 1 0 0 0 1 1h11a1 1 0 0 0 1-1v-2"/>';
const RELOAD_ICON = '<path d="M15.5 10a5.5 5.5 0 1 1-1.6-3.9"/><path d="M14.5 3v3.5H11"/>';
const HALF_MIN = 0.3, HALF_MAX = 0.7;
const NARROW_PX = 640;

/**
 * @param host      the positioned element to float in (.viewer-body)
 * @param handlers  {
 *   onClose()                     people closed the window (close button or Escape)
 *   onPadding({ left?, right? })  keep the map's centre in the part the window leaves clear
 *   onOpenChange(open)
 *   load(source)                  Promise of { rows, more, from } (downloadsLoad.js)
 *   signIn(error, retry)          a secured list: offer the sign-in (error: auth.AuthRequiredError), then retry()
 *   isAuthError(error)
 *   locale                        number formatting (CONFIG.numberLocale)
 * }
 */
export function createDownloadsWindow(host, handlers) {
  let width = 'half';
  let side = 'left';
  let ratio = 0.5;
  let pages = [];               // manifest.downloads.pages
  let current = null;
  let last = null;
  let generation = 0;           // a new manifest: answers still on their way for the old one are dropped
  const lists = new Map();      // page id -> { status: 'loading'|'ready'|'error'|'auth', rows, more, from, error, filter }

  const title = el('strong', { class: 'pages-heading' }, 'Downloads');
  const tabs = el('div', { class: 'pages-tabs', role: 'tablist', 'aria-label': 'Download pages' });
  const reloadBtn = el('button', { type: 'button', class: 'icon-btn pages-act', title: 'Read the list again', 'aria-label': 'Read the list again', onclick: () => current && read(current) }, svgIcon(RELOAD_ICON));
  const closeBtn = el('button', { type: 'button', class: 'icon-btn pages-close', 'aria-label': 'Close Downloads', title: 'Close Downloads', onclick: () => handlers.onClose() }, '×');
  const head = el('header', { class: 'pages-head' }, title, tabs, el('span', { class: 'pages-gap' }), reloadBtn, closeBtn);
  const home = el('div', { class: 'pages-home', hidden: true });
  const stage = el('div', { class: 'downloads-stage', hidden: true });
  const handle = el('div', {
    class: 'ew-handle pages-handle', role: 'separator', tabindex: 0, 'aria-orientation': 'vertical', 'aria-label': 'Drag to share the space between Downloads and the map',
    'aria-valuemin': HALF_MIN * 100, 'aria-valuemax': HALF_MAX * 100
  }, el('span', { class: 'ew-grip', 'aria-hidden': 'true' }));
  const win = el('section', { class: 'pages-window downloads-window', role: 'region', 'aria-label': 'Downloads', hidden: true }, head, home, stage, handle);
  host.append(win);
  stackWindow(win);                     // the window opened or clicked last is on top (windowStack.js)

  win.addEventListener('keydown', e => {
    if (e.key !== 'Escape') return;
    e.stopPropagation();
    handlers.onClose();
  });
  window.addEventListener('resize', () => { if (!win.hidden) layout(); });

  /* ---------- Size and position (as External pages) ---------- */
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
    title.textContent = pages.length === 1 ? pages[0].title : 'Downloads';
    fill(tabs, ...pages.map((p, i) => el('button', {
      type: 'button', class: 'seg-btn pages-tab', role: 'tab', 'aria-selected': String(p.id === current), tabindex: p.id === current || (!current && i === 0) ? 0 : -1,
      title: p.description || sourceHost(p.source),
      onclick: () => choose(p.id),
      onkeydown: e => {
        const to = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: pages.length - 1 }[e.key];
        if (to === undefined) return;
        e.preventDefault();
        choose(pages[(to + pages.length) % pages.length].id);
        tabs.querySelector('[aria-selected="true"]')?.focus();
      }
    }, el('span', {}, p.title))));
    reloadBtn.hidden = !current;
  }

  function showHome() {
    current = null;
    stage.hidden = true;
    renderTabs();
    fill(home,
      el('p', { class: 'pages-home-lead' }, 'Choose a list:'),
      el('div', { class: 'pages-cards' }, pages.map(p => el('button', { type: 'button', class: 'pages-card', onclick: () => choose(p.id) },
        svgIcon(LIST_ICON),
        el('span', { class: 'pages-card-title' }, p.title),
        p.description ? el('span', { class: 'muted pages-card-blurb' }, p.description) : null,
        el('span', { class: 'pages-card-meta' }, sourceHost(p.source))))));
    home.hidden = false;
    home.querySelector('.pages-card')?.focus({ preventScroll: true });
  }

  /** Read a page's list (again), then show it if it's still the one showing. */
  async function read(id) {
    const p = pageOf(id);
    if (!p) return;
    const n = generation;
    const filter = lists.get(id)?.filter ?? '';
    lists.set(id, { status: 'loading', rows: [], filter });
    if (current === id) paint();
    let state;
    try {
      const { rows, more, from } = await handlers.load(p.source);
      state = { status: 'ready', rows, more, from, filter };
    } catch (e) {
      state = handlers.isAuthError?.(e) ? { status: 'auth', error: e, rows: [], filter } : { status: 'error', error: e, rows: [], filter };
    }
    if (n !== generation || pageOf(id) !== p) return;
    lists.set(id, state);
    if (current === id) paint();
  }

  /** The page showing: its filter, a line about the list, and the table. */
  function paint() {
    const p = pageOf(current), st = lists.get(current);
    if (!p || !st) return;
    if (st.status === 'loading') { fill(stage, el('p', { class: 'status downloads-status' }, 'Reading the list…')); return; }
    if (st.status === 'auth') {
      fill(stage, el('div', { class: 'downloads-status' },
        el('p', {}, `This list is secured. ${st.error.message}`),
        el('button', { type: 'button', class: 'btn', onclick: () => handlers.signIn(st.error, () => read(p.id)) }, 'Sign in')));
      return;
    }
    if (st.status === 'error') {
      fill(stage, el('div', { class: 'downloads-status' },
        el('p', { class: 'status err' }, `The list couldn't be read: ${st.error.message}`),
        el('button', { type: 'button', class: 'btn', onclick: () => read(p.id) }, 'Try again')));
      return;
    }
    const countLabel = p.source.countLabel?.trim() || defaultCountLabel(p.source.kind);
    const tableHost = el('div', { class: 'downloads-table' });
    const summary = el('p', { class: 'muted downloads-summary', 'aria-live': 'polite' });
    const draw = () => {
      const shown = filterRows(st.rows, st.filter);
      const { columns, rows } = downloadTable(shown, { countLabel, locale: handlers.locale });
      summary.textContent = `${shown.length === st.rows.length ? itemCount(st.rows.length) : `${shown.length} of ${itemCount(st.rows.length)}`}${st.more ? ` (the first ${st.rows.length}; there are more)` : ''}${st.from ? `, from ${st.from}` : ''}.`;
      fill(tableHost, shown.length ? dataTable({ columns, rows, label: p.title }) : el('p', { class: 'empty' }, st.rows.length ? 'Nothing matches the filter.' : 'The list is empty.'));
      const countHead = [...tableHost.querySelectorAll('th')].find(th => th.textContent.startsWith(countLabel));
      if (countHead && (p.source.kind === 'instantApp' || p.source.kind === 'hubSite')) countHead.title = COUNT_NOTE;
    };
    fill(stage,
      el('div', { class: 'downloads-tools' },
        el('input', { type: 'search', class: 'downloads-filter', placeholder: 'Filter by name or type', 'aria-label': `Filter ${p.title}`, value: st.filter,
          oninput: e => { st.filter = e.target.value; draw(); } }),
        summary),
      tableHost,
      p.description ? el('p', { class: 'pages-foot muted' }, p.description) : null);
    draw();
  }

  function choose(id) {
    const p = pageOf(id);
    if (!p) return;
    current = id;
    last = id;
    home.hidden = true;
    stage.hidden = false;
    renderTabs();
    if (!lists.has(id)) read(id);
    else paint();
  }

  function open(id = null) {
    const wasOpen = !win.hidden;
    if (!wasOpen) {
      win.hidden = false;
      host.classList.add('downloads-open');
      layout();
      handlers.onOpenChange?.(true);
    }
    const to = pageOf(id)?.id ?? (pages.length === 1 ? pages[0].id : wasOpen ? current : last);
    if (to) choose(to);
    else showHome();
    // Focus inside the window (so Escape closes it): the tab showing, or with one page (no tabs) the Close button.
    if (!wasOpen && to) (tabs.hidden ? closeBtn : tabs.querySelector('[aria-selected="true"]') ?? closeBtn).focus({ preventScroll: true });
  }

  function close() {
    if (win.hidden) return;
    win.hidden = true;
    host.classList.remove('downloads-open');
    handlers.onPadding?.({});
    handlers.onOpenChange?.(false);
  }

  return {
    /** The manifest's Downloads settings (call on every manifest; closes the window and forgets the lists). */
    set(cfg) {
      close();
      width = cfg?.width === 'full' ? 'full' : 'half';
      side = cfg?.side === 'right' ? 'right' : 'left';
      ratio = 0.5;
      pages = cfg?.pages ?? [];
      current = last = null;
      lists.clear();
      generation++;
      fill(stage);
      renderTabs();
    },
    open,
    close,
    isOpen: () => !win.hidden
  };
}
