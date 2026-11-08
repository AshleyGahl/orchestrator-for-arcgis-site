// trackingPane.js — the Tracking section of the Streaming window: the feeds (switch each one on or off the map, how many
// objects it has and when it last updated, Zoom to, and a list of its objects), and the selected object's values, with
// Zoom to and Follow (keep the map centred on it as it moves). Feeds stay on the map when the window closes, until
// they're switched off. Pure UI: the map side is `source` (trackingLayers.js), handed in by viewerApp.js.
import { el, fill } from './utils.js';
import { svgIcon } from './viewer.js';
import { feedColor, trackKindLabel } from './tracking.js';

const ZOOM_ICON = '<circle cx="8.5" cy="8.5" r="5"/><path d="m12.3 12.3 4.7 4.7M8.5 6.5v4M6.5 8.5h4"/>';
const FOLLOW_ICON = '<circle cx="10" cy="10" r="2.5"/><path d="M10 2.5v3M10 14.5v3M2.5 10h3M14.5 10h3"/><circle cx="10" cy="10" r="6"/>';
const LIST_MAX = 300;           // objects listed per feed (the map draws them all)
const VALUES_MAX = 16;          // values shown for the selected object

const swatch = color => el('span', { class: 'trk-swatch', style: `background:${color}`, 'aria-hidden': 'true' });
const showValue = v => (typeof v === 'number' ? (Number.isInteger(v) ? String(v) : String(Math.round(v * 1e5) / 1e5)) : String(v)).slice(0, 120);

/**
 * @param source  trackingLayers.js: start, stop, isOn, state, objects, zoomTo, select, clearSelection, follow, onChange
 * @param handlers { onCount(text) } how many feeds are on, for the window's header
 */
export function createTrackingPane(source, handlers = {}) {
  let feeds = [];
  let started = false;          // the feeds marked visible are switched on the first time Tracking is shown
  const expanded = new Set();
  const rows = new Map();       // feed id -> { li, check, stateP, zoomBtn, listBtn, objects }

  const selBox = el('section', { class: 'trk-selected', hidden: true, 'aria-live': 'polite' });
  const list = el('ul', { class: 'trk-feeds', 'aria-label': 'Tracking feeds' });
  const empty = el('p', { class: 'pane-empty', hidden: true }, 'No tracking feeds are set up yet.');
  const hint = el('p', { class: 'muted trk-hint' }, 'Click a tracked object on the map, or pick one from a feed\'s list, to see its values.');
  const node = el('div', { class: 'trk-pane', hidden: true }, selBox, empty, list, hint);

  source.onChange(e => {
    if (e.type === 'feed') updateRow(e.feedId);
    else renderSelection(e.object);
  });

  const colorOf = f => feedColor(f, feeds.indexOf(f));

  function toggle(f, on) {
    if (on) source.start(f, colorOf(f)).catch(() => {});
    else { source.stop(f.id); expanded.delete(f.id); }
    updateRow(f.id);
  }

  function row(f) {
    const check = el('input', { type: 'checkbox', checked: source.isOn(f.id), onchange: e => toggle(f, e.target.checked) });
    const stateP = el('p', { class: 'trk-state', role: 'status' });
    const zoomBtn = el('button', { type: 'button', class: 'btn quiet', onclick: () => { if (!source.zoomTo(f.id)) stateP.textContent = 'Nothing to zoom to yet.'; } }, svgIcon(ZOOM_ICON), 'Zoom to');
    const listBtn = el('button', {
      type: 'button', class: 'btn quiet', 'aria-expanded': 'false',
      onclick: () => { if (expanded.has(f.id)) expanded.delete(f.id); else expanded.add(f.id); updateRow(f.id); }
    });
    const objects = el('ul', { class: 'trk-objects', hidden: true, 'aria-label': `${f.title}: objects` });
    const li = el('li', { class: 'trk-feed' },
      el('label', { class: 'check-row trk-feed-head' }, check, swatch(colorOf(f)), el('strong', {}, f.title)),
      el('p', { class: 'muted trk-kind' }, trackKindLabel(f)),
      stateP,
      f.description ? el('p', { class: 'trk-desc' }, f.description) : null,
      el('div', { class: 'trk-actions' }, zoomBtn, listBtn),
      objects,
      f.credit ? el('p', { class: 'muted trk-credit' }, `Source: ${f.credit}`) : null);
    rows.set(f.id, { li, check, stateP, zoomBtn, listBtn, objects });
    return li;
  }

  function updateRow(feedId) {
    const r = rows.get(feedId);
    const f = feeds.find(x => x.id === feedId);
    if (!r || !f) return;
    const s = source.state(feedId);
    r.check.checked = s.on;
    r.li.classList.toggle('is-off', !s.on);
    r.stateP.className = `trk-state${s.status === 'error' ? ' err' : ''}`;
    r.stateP.textContent = !s.on ? 'Not on the map.'
      : s.status === 'error' ? s.text
      : s.status === 'loading' ? s.text || 'Reading the feed…'
      : `${s.count} on the map${s.updated ? `, updated ${s.updated.toLocaleTimeString()}` : ''}${s.text ? ` (${s.text})` : ''}.`;
    r.zoomBtn.disabled = !s.on || !s.count;
    r.listBtn.disabled = !s.on || !s.count;
    const open = s.on && s.count > 0 && expanded.has(feedId);
    r.listBtn.setAttribute('aria-expanded', String(open));
    r.listBtn.textContent = open ? 'Hide the list' : `List${s.count ? ` (${s.count})` : ''}`;
    r.objects.hidden = !open;
    if (open) {
      const items = source.objects(feedId);
      fill(r.objects,
        ...items.slice(0, LIST_MAX).map(it => el('li', {},
          el('button', { type: 'button', class: 'trk-object', onclick: () => source.select(feedId, it.id, { zoom: true }) },
            it.label, it.label !== it.id ? el('span', { class: 'muted' }, ` · ${it.id}`) : null))),   // names can repeat (a bus route); the id can't
        items.length > LIST_MAX ? el('li', { class: 'muted' }, `and ${items.length - LIST_MAX} more on the map`) : null);
    }
    handlers.onCount?.(countText());
  }

  function renderSelection(o) {
    selBox.hidden = !o;
    hint.hidden = Boolean(o);
    if (!o) { selBox.replaceChildren(); return; }
    // The SDK's own bookkeeping (__esri_stream_id__ and the like) isn't the object's data.
    const values = Object.entries(o.attributes ?? {}).filter(([k, v]) => v != null && v !== '' && !k.startsWith('__')).slice(0, VALUES_MAX);
    fill(selBox,
      el('header', { class: 'trk-sel-head' },
        swatch(o.color ?? '#1C2B30'),
        el('div', { class: 'grow' }, el('strong', {}, o.label), el('span', { class: 'muted' }, ` ${o.feedTitle}`)),
        el('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Clear the selection', title: 'Clear the selection', onclick: () => source.clearSelection() }, '×')),
      el('p', { class: 'muted trk-sel-where' },
        `${o.lat.toFixed(5)}, ${o.lon.toFixed(5)}`,
        o.gone ? ' · not in the latest update' : o.updated ? ` · updated ${o.updated.toLocaleTimeString()}` : ''),
      values.length ? el('dl', { class: 'trk-values' }, values.flatMap(([k, v]) => [el('dt', {}, k), el('dd', {}, showValue(v))])) : null,
      el('div', { class: 'trk-actions' },
        el('button', { type: 'button', class: 'btn quiet', onclick: () => source.select(o.feedId, o.id, { zoom: true }) }, svgIcon(ZOOM_ICON), 'Zoom to'),
        el('button', { type: 'button', class: 'btn quiet', 'aria-pressed': String(o.following), onclick: () => source.follow(!o.following) }, svgIcon(FOLLOW_ICON), o.following ? 'Following' : 'Follow')));
  }

  function countText() {
    const on = feeds.filter(f => source.isOn(f.id)).length;
    return feeds.length ? `${on} of ${feeds.length} feed${feeds.length === 1 ? '' : 's'} on the map` : '';
  }

  return {
    node,
    /** A new manifest's feeds (the map side was reset already). */
    set(list_) {
      feeds = list_ ?? [];
      started = false;
      expanded.clear();
      rows.clear();
      fill(list, ...feeds.map(row));
      empty.hidden = feeds.length > 0;
      renderSelection(null);
      for (const f of feeds) updateRow(f.id);
    },
    /** Tracking was shown (people may see it): the first time, switch on the feeds the author marked visible. */
    show() {
      node.hidden = false;
      if (!started) {
        started = true;
        for (const f of feeds) if (f.visible && !source.isOn(f.id)) toggle(f, true);
      }
      handlers.onCount?.(countText());
    },
    countText
  };
}
