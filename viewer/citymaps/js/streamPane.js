// streamPane.js — one video section of the Streaming window (Cameras or Drones): the list of streams and a stage that
// plays the chosen one (one at a time; stop() stops it). A narrow window stacks the player above the list. Drones
// (source 'viewer') also get a "Live stream address" form: people paste the address of their own live stream, which
// joins the list for this page session only and is never stored. Pure UI: markers go through the handlers
// (viewerApp.js, by way of streamWindow.js).
import { el, fill } from './utils.js';
import { svgIcon } from './viewer.js';
import { createPlayer } from './streamPlayer.js';
import { kindLabel, isLonLat, STREAM_KINDS, detectKind, streamUrlProblem, sessionStreamTitle } from './streams.js';

const PIN_ICON = '<path d="M10 17.5s5.5-5 5.5-9.5a5.5 5.5 0 0 0-11 0c0 4.5 5.5 9.5 5.5 9.5Z"/><circle cx="10" cy="8" r="2"/>';
const OPEN_ICON = '<path d="M11.5 3.5h5v5"/><path d="m16.5 3.5-7 7"/><path d="M14.5 11.5v4a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1h4"/>';
const FULL_ICON = '<path d="M3.5 7.5v-4h4M12.5 3.5h4v4M16.5 12.5v4h-4M7.5 16.5h-4v-4"/>';
const SESSION_MAX = 10;         // pasted streams kept in the list at once

/**
 * @param options   { section: 'cameras' | 'drones', words: STREAMING_SECTIONS[section], embedHosts }
 * @param handlers  {
 *   onSelect(stream)   a stream started playing (show its marker as chosen)
 *   onZoom(stream)     Show on map
 *   onCount(text)      how many streams are listed, for the window's header
 * }
 */
export function createStreamPane({ section, words, embedHosts = [] }, handlers) {
  const pasting = words.source === 'viewer';
  let streams = [];             // from the manifest (cameras) or the demo list (drones)
  let session = [];             // drones: addresses pasted in this page session (newest first); never stored
  let seq = 0;
  let current = null;           // the stream playing
  let lastId = null;            // remembered for this session, so reopening plays the same stream
  let player = null;
  const all = () => [...session, ...streams];

  const list = el('ul', { class: 'stream-list', 'aria-label': words.title });
  const screen = el('div', { class: 'stream-screen' });
  const badge = el('span', { class: 'stream-badge', hidden: true });
  const overlay = el('div', { class: 'stream-overlay', hidden: true });
  const stageTitle = el('h3', { class: 'stream-title' });
  const meta = el('p', { class: 'muted stream-meta' });
  const desc = el('p', { class: 'stream-desc' });
  const credit = el('p', { class: 'muted stream-credit' });
  const zoomBtn = el('button', { type: 'button', class: 'btn quiet', onclick: () => current && handlers.onZoom?.(current) }, svgIcon(PIN_ICON), 'Show on map');
  const openBtn = el('a', { class: 'btn quiet', target: '_blank', rel: 'noopener noreferrer' }, svgIcon(OPEN_ICON), 'Open in a new tab');
  const fullBtn = el('button', { type: 'button', class: 'btn quiet', onclick: () => screenBox.requestFullscreen?.().catch(() => {}) }, svgIcon(FULL_ICON), 'Full screen');
  const screenBox = el('div', { class: 'stream-screen-box' }, screen, badge, overlay);
  const info = el('div', { class: 'stream-info' }, stageTitle, meta, desc, credit, el('div', { class: 'stream-actions' }, zoomBtn, openBtn, fullBtn));
  const stage = el('div', { class: 'stream-stage' }, screenBox, info);

  /* ---------- Drones: paste a live stream's address ---------- */
  const urlIn = el('input', { type: 'url', placeholder: 'https://…/live.m3u8, or a YouTube Live link', spellcheck: 'false', 'aria-describedby': `${section}-add-hint` });
  const nameIn = el('input', { type: 'text', placeholder: 'Name (optional), e.g. Drone 1' });
  const kindIn = el('select', { 'aria-label': 'How it plays' },
    el('option', { value: '' }, 'Detect how it plays'),
    STREAM_KINDS.map(([id, label]) => el('option', { value: id }, label)));
  const addMsg = el('p', { class: 'status err', role: 'alert', hidden: true });
  const addForm = pasting ? el('form', {
    class: 'stream-add',
    onsubmit: e => { e.preventDefault(); addSession(); }
  },
  el('label', { class: 'field' }, 'Live stream address', urlIn),
  el('div', { class: 'stream-add-row' }, nameIn, kindIn, el('button', { type: 'submit', class: 'btn primary' }, 'Play')),
  addMsg,
  el('p', { class: 'muted stream-add-hint', id: `${section}-add-hint` },
    'Paste the address from the drone\'s streaming app or gateway: HLS (.m3u8), MP4 or WebM, MJPEG, or a YouTube Live link. ',
    'It\'s kept for this visit only and isn\'t saved anywhere.')) : null;

  function addSession() {
    const url = urlIn.value.trim();
    const kindChosen = kindIn.value || detectKind(url, embedHosts);
    const problem = !url ? 'Paste the stream\'s address first.'
      : streamUrlProblem(url, kindChosen || 'hls', embedHosts, { secretsOk: true })
        || (!kindChosen ? 'Couldn\'t tell how to play this address. Choose how it plays, next to the name.' : '');
    addMsg.hidden = !problem;
    addMsg.textContent = problem;
    if (problem) { urlIn.focus(); return; }
    const existing = session.find(s => s.url === url && s.kind === kindChosen);
    const st = existing ?? {
      id: `session-${++seq}`, title: nameIn.value.trim() || sessionStreamTitle(url), url, kind: kindChosen, refreshSeconds: 10,
      location: null, description: 'Pasted in this viewer; not saved.', credit: '', session: true
    };
    if (!existing) session = [st, ...session].slice(0, SESSION_MAX);
    urlIn.value = ''; nameIn.value = ''; kindIn.value = '';
    renderList();
    select(st.id, { force: true });
  }

  function removeSession(id) {
    session = session.filter(s => s.id !== id);
    if (current?.id === id) { stop(); showIdle(); }
    renderList();
    if (!current && all().length) select(all()[0].id);
  }

  const nav = el('nav', { class: 'stream-nav', 'aria-label': words.title }, addForm, list);
  const body = el('div', { class: 'stream-body' }, nav, stage);
  const empty = el('p', { class: 'pane-empty stream-empty', hidden: true }, `No ${words.items} are set up yet.`);
  const node = el('div', { class: 'stream-pane', 'data-section': section, hidden: true }, empty, body);

  /* ---------- Streams ---------- */
  function stop() {
    player?.destroy();
    player = null;
    current = null;
  }

  function showState(s) {
    overlay.hidden = s.status === 'playing';
    overlay.className = `stream-overlay${s.status === 'error' ? ' err' : ''}`;
    overlay.textContent = s.status === 'error' ? s.text : 'Connecting…';
    badge.hidden = !(s.status === 'playing' && (s.live || s.updated));
    badge.className = `stream-badge${s.live ? ' live' : ''}`;
    badge.textContent = s.live ? 'LIVE' : s.updated ? `Updated ${s.updated.toLocaleTimeString()}` : '';
  }

  /** Nothing playing (drones before anything is pasted): say what to do instead of a blank player. */
  function showIdle() {
    badge.hidden = true;
    overlay.hidden = false;
    overlay.className = 'stream-overlay idle';
    overlay.textContent = pasting ? 'Paste a live stream\'s address to watch it here.' : `Choose a ${words.item}.`;
    info.hidden = true;
  }

  function itemButton(st) {
    return el('li', { class: 'stream-li' },
      el('button', { type: 'button', class: 'stream-item', 'data-id': st.id, 'aria-pressed': String(st.id === current?.id), onclick: () => select(st.id) },
        el('span', { class: 'stream-item-title' }, st.title),
        el('span', { class: 'muted stream-item-meta' }, kindLabel(st), st.session ? ' · this visit only' : '', isLonLat(st.location) ? svgIcon(PIN_ICON) : null)),
      st.session ? el('button', { type: 'button', class: 'icon-btn stream-remove', 'aria-label': `Remove ${st.title}`, title: 'Remove from the list', onclick: () => removeSession(st.id) }, '×') : null);
  }

  function renderList() {
    const n = all().length;
    handlers.onCount?.(n ? `${n} ${n === 1 ? words.item : words.items}` : '');
    fill(list,
      ...session.map(itemButton),
      pasting && streams.length ? el('li', { class: 'stream-list-head muted' }, 'Demo streams') : null,
      ...streams.map(itemButton));
  }

  function select(id, { force = false } = {}) {
    const st = all().find(s => s.id === id);
    if (!st || (st.id === current?.id && !force)) return;
    stop();
    current = st;
    lastId = st.id;
    for (const b of list.querySelectorAll('.stream-item')) b.setAttribute('aria-pressed', String(b.dataset.id === id));
    info.hidden = false;
    stageTitle.textContent = st.title;
    meta.textContent = kindLabel(st);
    desc.textContent = st.description || '';
    desc.hidden = !st.description;
    credit.textContent = st.credit ? `Source: ${st.credit}` : '';
    credit.hidden = !st.credit;
    zoomBtn.hidden = !isLonLat(st.location);
    openBtn.href = st.url;
    fullBtn.hidden = !document.fullscreenEnabled;
    player = createPlayer(screen, st, { embedHosts, onState: showState });
    handlers.onSelect?.(st);
  }

  return {
    node,
    /** A new manifest: forget the streams pasted this visit and the remembered stream. */
    reset() {
      stop();
      lastId = null;
      streams = [];
      session = [];
      addMsg.hidden = true;
    },
    /** List the streams (plus any pasted this visit) and play the remembered one (or the first). */
    show(list_) {
      stop();
      streams = list_ ?? [];
      const any = all().length;
      node.hidden = false;
      body.hidden = !any && !pasting;
      empty.hidden = Boolean(any) || pasting;
      renderList();
      if (any) select(all().some(s => s.id === lastId) ? lastId : all()[0].id);
      else showIdle();
      if (pasting && !any) urlIn.focus({ preventScroll: true });
    },
    /** Stop the video (the section was left or the window closed). */
    stop,
    /** Play this stream (a marker on the map was clicked). */
    select,
    current: () => current,
    countText: () => { const n = all().length; return n ? `${n} ${n === 1 ? words.item : words.items}` : ''; }
  };
}
