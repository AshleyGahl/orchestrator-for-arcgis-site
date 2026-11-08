// streamWindow.js — the Streaming widget's window, at the author's width:
//   half: over half the map, on the author's side, with a drag handle between the window and the map (like Scene
//         and Editing); the map stays usable beside it.
//   full: over the map and the panel.
// Narrow screens always get full width. It opens on a card for each section the author switched on (Cameras, Drones,
// Tracking; with only one it goes straight in), and tabs in its header switch between them. Cameras and Drones play
// video (streamPane.js); Tracking lists the feeds drawn on the map (trackingPane.js). Each time a section is shown,
// viewerApp.js checks its portal group and then fills it (showStreams, showTracking) or says why not (showGate).
// Closing stops the video; tracking feeds stay on the map until they're switched off. Pure UI.
import { el, fill, halfWindowLeft } from './utils.js';
import { icon } from './viewer.js';
import { STREAMING_SECTIONS, STREAMING_SECTION_IDS, VIDEO_SECTION_IDS } from './streams.js';
import { createStreamPane } from './streamPane.js';
import { createTrackingPane } from './trackingPane.js';
import { stackWindow } from './windowStack.js';

const HALF_MIN = 0.3, HALF_MAX = 0.7;
const NARROW_PX = 640;          // below this the map is too small to share: the window opens at full width

/**
 * @param host      the positioned element to float in (.viewer-body)
 * @param options   { embedHosts, tracking: trackingLayers.js (the map side of Tracking) }
 * @param handlers  {
 *   onClose()                     people closed the window (close button or Escape)
 *   onPadding({ left?, right? })  keep the map's centre in the part the window leaves clear
 *   onSection(id)                 a section was chosen: check its group, then call showStreams, showTracking or showGate
 *   onSelectStream(id, stream)    a stream started playing (show its marker as chosen)
 *   onZoom(stream)                Show on map
 *   onLeaveVideo()                no video section is showing any more (clear the stream markers)
 *   onOpenChange(open)
 * }
 */
export function createStreamWindow(host, { embedHosts = [], tracking }, handlers) {
  let width = 'half';
  let side = 'left';
  let ratio = 0.5;
  let sections = [];            // the sections switched on, in order
  let current = null;           // the section showing (null: the cards)
  let last = null;              // remembered for this manifest, so reopening goes back to it
  let summaries = {};           // id -> one line on its card

  const counts = {};
  const count = el('span', { class: 'muted stream-count' });
  const showCount = () => { count.textContent = current ? counts[current] ?? '' : ''; };
  const onCount = id => text => { counts[id] = text; showCount(); };

  const panes = {
    ...Object.fromEntries(VIDEO_SECTION_IDS.map(id => [id, createStreamPane({ section: id, words: STREAMING_SECTIONS[id], embedHosts }, {
      onSelect: st => handlers.onSelectStream?.(id, st),
      onZoom: st => handlers.onZoom?.(st),
      onCount: onCount(id)
    })])),
    tracking: createTrackingPane(tracking, { onCount: onCount('tracking') })
  };

  const title = el('strong', { class: 'stream-heading' }, 'Streaming');
  const tabs = el('div', { class: 'stream-tabs', role: 'tablist', 'aria-label': 'Streaming sections' });
  const closeBtn = el('button', { type: 'button', class: 'icon-btn stream-close', 'aria-label': 'Close Streaming', title: 'Close Streaming', onclick: () => handlers.onClose() }, '×');
  const head = el('header', { class: 'stream-head' }, title, tabs, count, closeBtn);

  const statusText = el('span', {});
  const status = el('div', { class: 'stream-status', role: 'status', hidden: true }, statusText);
  const gate = el('div', { class: 'stream-gate', hidden: true });
  const home = el('div', { class: 'stream-home', hidden: true });
  const stageHost = el('div', { class: 'stream-sections' }, ...Object.values(panes).map(p => p.node));

  const handle = el('div', {
    class: 'ew-handle stream-handle', role: 'separator', tabindex: 0, 'aria-orientation': 'vertical', 'aria-label': 'Drag to share the space between Streaming and the map',
    'aria-valuemin': HALF_MIN * 100, 'aria-valuemax': HALF_MAX * 100
  }, el('span', { class: 'ew-grip', 'aria-hidden': 'true' }));
  const win = el('section', { class: 'stream-window', role: 'region', 'aria-label': 'Streaming', hidden: true },
    head, status, gate, home, stageHost, handle);
  host.append(win);
  stackWindow(win);                     // the window opened or clicked last is on top (windowStack.js)

  win.addEventListener('keydown', e => {
    if (e.key !== 'Escape' || document.fullscreenElement) return;
    e.stopPropagation();
    handlers.onClose();
  });
  window.addEventListener('resize', () => { if (!win.hidden) layout(); });

  /* ---------- Size and position (as the Scene window) ---------- */
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

  /* ---------- Sections ---------- */
  function stopVideo() { for (const id of VIDEO_SECTION_IDS) panes[id].stop(); }

  function hideContent() {
    stopVideo();
    for (const p of Object.values(panes)) p.node.hidden = true;
    gate.hidden = true;
    home.hidden = true;
  }

  function renderTabs() {
    tabs.hidden = sections.length < 2;
    title.textContent = sections.length === 1 ? STREAMING_SECTIONS[sections[0]].title : 'Streaming';
    fill(tabs, ...sections.map(id => el('button', {
      type: 'button', class: 'seg-btn stream-tab', role: 'tab', 'aria-selected': String(id === current), tabindex: id === current || (!current && id === sections[0]) ? 0 : -1,
      onclick: () => choose(id),
      onkeydown: e => {
        const i = sections.indexOf(id);
        const to = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: sections.length - 1 }[e.key];
        if (to === undefined) return;
        e.preventDefault();
        choose(sections[(to + sections.length) % sections.length]);
        tabs.querySelector('[aria-selected="true"]')?.focus();
      }
    }, icon(id), el('span', {}, STREAMING_SECTIONS[id].title))));
  }

  function showHome() {
    hideContent();
    if (current && VIDEO_SECTION_IDS.includes(current)) handlers.onLeaveVideo?.();
    current = null;
    renderTabs();
    showCount();
    fill(home,
      el('p', { class: 'stream-home-lead' }, 'Choose what to open:'),
      el('div', { class: 'stream-cards' }, sections.map(id => el('button', { type: 'button', class: 'stream-card', onclick: () => choose(id) },
        icon(id),
        el('span', { class: 'stream-card-title' }, STREAMING_SECTIONS[id].title),
        el('span', { class: 'muted stream-card-blurb' }, STREAMING_SECTIONS[id].blurb),
        summaries[id] ? el('span', { class: 'stream-card-meta' }, summaries[id]) : null))));
    home.hidden = false;
    home.querySelector('.stream-card')?.focus({ preventScroll: true });
  }

  /** Show a section: the content follows from viewerApp.js once the group check (if any) has answered. */
  function choose(id) {
    if (!sections.includes(id)) return;
    const leavingVideo = VIDEO_SECTION_IDS.includes(current) && !VIDEO_SECTION_IDS.includes(id);
    hideContent();
    current = id;
    last = id;
    renderTabs();
    showCount();
    if (leavingVideo || id === 'tracking') handlers.onLeaveVideo?.();
    handlers.onSection?.(id);
  }

  function open(id = null) {
    const wasOpen = !win.hidden;
    if (!wasOpen) {
      win.hidden = false;
      host.classList.add('stream-open');
      layout();
      handlers.onOpenChange?.(true);
    }
    const to = sections.includes(id) ? id : sections.length === 1 ? sections[0] : wasOpen ? current : last;
    if (to && (to !== current || !wasOpen)) choose(to);
    else if (!to) showHome();
    if (!wasOpen) (tabs.querySelector('[aria-selected="true"]') ?? closeBtn).focus({ preventScroll: true });
  }

  function close() {
    if (win.hidden) return;
    hideContent();
    current = null;
    win.hidden = true;
    host.classList.remove('stream-open');
    handlers.onPadding?.({});
    handlers.onOpenChange?.(false);
  }

  return {
    /**
     * The manifest's Streaming settings (call on every manifest; closes the window, forgets pasted streams and the
     * remembered section). @param cfg  manifest.streaming, or null when the widget is off
     */
    set(cfg) {
      close();
      width = cfg?.width === 'full' ? 'full' : 'half';
      side = cfg?.side === 'right' ? 'right' : 'left';
      ratio = 0.5;
      last = null;
      sections = STREAMING_SECTION_IDS.filter(id => cfg?.[id]?.on === true);
      const n = (k, one, many) => `${k} ${k === 1 ? one : many}`;
      summaries = cfg ? {
        cameras: n(cfg.cameras.streams.length, 'camera', 'cameras'),
        drones: cfg.drones.demo ? 'Paste an address, or try the demo streams' : 'Paste a live stream\'s address',
        tracking: n(cfg.tracking.feeds.length, 'feed', 'feeds')
      } : {};
      for (const id of VIDEO_SECTION_IDS) panes[id].reset();
      panes.tracking.set(cfg?.tracking?.on ? cfg.tracking.feeds : []);
      for (const k of Object.keys(counts)) delete counts[k];
      renderTabs();
    },
    /** Open the window (on `id`, the remembered section, or the cards). */
    open,
    close,
    isOpen: () => !win.hidden,
    width: effectiveWidth,
    /** The section showing, or null. */
    section: () => current,
    /** Cameras or Drones may be watched: list the streams (Drones: plus the address form). */
    showStreams(id, list) {
      if (id !== current || !VIDEO_SECTION_IDS.includes(id)) return;
      gate.hidden = true;
      panes[id].show(list);
    },
    /** Tracking may be seen: show the feeds (the first time, the ones marked visible go on the map). */
    showTracking() {
      if (current !== 'tracking') return;
      gate.hidden = true;
      panes.tracking.show();
    },
    /** People may not use this section (signed in, not in the group), or the check failed: say why. */
    showGate(id, message) {
      if (id !== current) return;
      hideContent();
      gate.replaceChildren(el('p', {}, message));
      gate.hidden = false;
    },
    /** Play this stream (a marker on the map was clicked). */
    selectStream(streamId) { if (VIDEO_SECTION_IDS.includes(current)) panes[current].select(streamId); },
    /** A line over the window: checking access ('busy'), or a problem ('err'). '' hides it. */
    say(text, kind_ = '') {
      statusText.textContent = text;
      status.hidden = !text;
      status.className = `stream-status${kind_ ? ` ${kind_}` : ''}`;
    }
  };
}
