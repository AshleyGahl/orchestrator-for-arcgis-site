// addDataPane.js — the viewer's Add data pane: curated collections (each one or more portal groups), portal search,
// a layer URL and local files. Pure UI: searching and adding go out through handlers (viewerApp.js decides),
// and added layers last for the session only.
import { el, fill } from './utils.js';
import { signInForm } from './authUi.js';

const TABS = [
  ['curated', 'Curated'],
  ['search', 'Search'],
  ['url', 'URL'],
  ['file', 'File']
];

/**
 * @param body  the pane's container
 * @param cfg   manifest.addData
 * @param h     { search({ groupIds, text, start }), addItem(item), addUrl(url), addFile(file), remove(id), zoomTo(id),
 *                listAdded(), signInTarget(), isSignedIn(), onSignedIn() }
 */
export function createAddDataPane(body, cfg, h) {
  const offered = TABS.filter(([id]) =>
    id === 'curated' ? cfg.collections.length : id === 'search' ? cfg.portalSearch !== 'off' : cfg[id]);
  const addedItems = new Map();         // portal item id -> added layer id, this session (the button says "Added")
  let tab = offered[0]?.[0] ?? null;
  let collectionId = cfg.collections[0]?.id ?? null;
  let lastQuery = null;                 // { groupIds, text } of the list showing

  const tabBar = el('div', { class: 'seg ad-tabs', role: 'tablist', 'aria-label': 'Add data from' });
  const tabBody = el('div', { class: 'ad-body' });
  const addedBox = el('div', { class: 'ad-added' });

  /* ---------- Item lists (curated and search) ---------- */
  const list = el('ul', { class: 'ad-items' });
  const listStatus = el('p', { class: 'pane-empty', role: 'status' });
  const moreBtn = el('button', { type: 'button', class: 'btn quiet', hidden: true }, 'Show more');

  function itemRow(item) {
    const msg = el('p', { class: 'err', hidden: true });
    const btn = el('button', {
      type: 'button', class: 'btn small', disabled: addedItems.has(item.id),
      onclick: async () => {
        btn.disabled = true; btn.textContent = 'Adding…'; msg.hidden = true;
        try {
          const r = await h.addItem(item);
          addedItems.set(item.id, r.id);
          btn.textContent = 'Added';
          renderAdded();
        } catch (e) {
          btn.disabled = false; btn.textContent = 'Add';
          msg.textContent = e.message; msg.hidden = false;
        }
      }
    }, addedItems.has(item.id) ? 'Added' : 'Add');
    return el('li', { class: 'ad-item' },
      el('div', { class: 'ad-item-text' },
        el('strong', {}, item.title),
        el('span', { class: 'muted' }, [item.type, item.owner].filter(Boolean).join(' · ')),
        item.snippet ? el('span', { class: 'ad-snippet' }, item.snippet) : null,
        msg),
      btn);
  }

  async function runSearch(query, start = 1) {
    lastQuery = query;
    if (start === 1) { list.replaceChildren(); listStatus.textContent = 'Searching…'; listStatus.hidden = false; }
    moreBtn.hidden = true;
    try {
      const res = await h.search({ ...query, start });
      if (lastQuery !== query) return;                    // a newer search started meanwhile
      list.append(...(res.results ?? []).map(itemRow));
      const shown = list.children.length;
      listStatus.textContent = shown ? `${shown} of ${res.total} item${res.total === 1 ? '' : 's'}` : 'No layers found.';
      moreBtn.hidden = !(res.nextStart > 0);
      moreBtn.onclick = () => runSearch(query, res.nextStart);
    } catch (e) {
      if (lastQuery === query) listStatus.textContent = `The search failed: ${e.message}`;
    }
  }

  /** "You're seeing public items" + a sign-in form, when signed out of the portal. */
  function signInHint(retry) {
    if (h.isSignedIn()) return null;
    const box = el('div', { class: 'ad-signin' });
    return fill(box, el('p', { class: 'muted' }, 'Signed out: only public items show. ',
      el('button', {
        type: 'button', class: 'link-btn',
        onclick: () => fill(box, signInForm({ target: h.signInTarget(), message: 'Sign in to see the items shared with you.', onSignedIn: () => { h.onSignedIn(); renderTab(); retry?.(); } }))
      }, 'Sign in')));
  }

  function curatedTab() {
    const col = cfg.collections.find(c => c.id === collectionId) ?? cfg.collections[0];
    const filter = el('input', { type: 'search', placeholder: 'Filter by name', 'aria-label': 'Filter the collection' });
    let timer = null;
    const run = () => runSearch({ groupIds: col.groupIds, text: filter.value });
    filter.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(run, 350); });
    const picker = cfg.collections.length > 1
      ? el('label', { class: 'field' }, 'Collection',
          el('select', { onchange: e => { collectionId = e.target.value; renderTab(); } },
            cfg.collections.map(c => el('option', { value: c.id, selected: c.id === col.id }, c.title))))
      : el('p', { class: 'ad-col-title' }, col.title);
    fill(tabBody, picker, col.description ? el('p', { class: 'muted' }, col.description) : null,
      filter, signInHint(run), listStatus, list, moreBtn);
    run();
  }

  function searchTab() {
    const input = el('input', { type: 'search', placeholder: 'Search for layers', 'aria-label': 'Search the portal' });
    const run = () => runSearch({ groupIds: null, text: input.value });
    input.addEventListener('keydown', e => { if (e.key === 'Enter') run(); });
    list.replaceChildren(); listStatus.textContent = ''; moreBtn.hidden = true; lastQuery = null;
    fill(tabBody,
      el('p', { class: 'tool-help' }, cfg.portalSearch === 'organization' ? 'Search this organisation\'s layers.' : 'Search the layers this portal shows.'),
      el('div', { class: 'add-row' }, input, el('button', { type: 'button', class: 'btn primary', onclick: run }, 'Search')),
      signInHint(run), listStatus, list, moreBtn);
    input.focus();
  }

  function urlTab() {
    const input = el('input', { type: 'url', placeholder: 'https://…/rest/services/…/FeatureServer/0', 'aria-label': 'Layer URL' });
    const msg = el('p', { class: 'muted', role: 'status' });
    const btn = el('button', {
      type: 'button', class: 'btn primary',
      onclick: async () => {
        const url = input.value.trim();
        if (!url) return;
        btn.disabled = true; msg.className = 'muted'; msg.textContent = 'Adding…';
        try { const r = await h.addUrl(url); msg.textContent = `Added "${r.title}".`; input.value = ''; renderAdded(); }
        catch (e) { msg.className = 'err'; msg.textContent = e.message; }
        finally { btn.disabled = false; }
      }
    }, 'Add');
    input.addEventListener('keydown', e => { if (e.key === 'Enter') btn.click(); });
    fill(tabBody,
      el('p', { class: 'tool-help' }, 'An ArcGIS REST service or layer (FeatureServer, MapServer, ImageServer, VectorTileServer), or a link to a .geojson or .csv file.'),
      el('div', { class: 'add-row' }, input, btn), msg);
  }

  function fileTab() {
    const msg = el('p', { class: 'muted', role: 'status' });
    const input = el('input', {
      type: 'file', accept: '.csv,.geojson,.json,.zip', 'aria-label': 'File to add',
      onchange: async e => {
        const file = e.target.files?.[0];
        e.target.value = '';
        if (!file) return;
        msg.className = 'muted'; msg.textContent = `Adding ${file.name}…`;
        try {
          const r = [await h.addFile(file)].flat();
          msg.textContent = `Added ${r.map(x => `"${x.title}"`).join(', ')}.`;
          renderAdded();
        } catch (err) { msg.className = 'err'; msg.textContent = err.message; }
      }
    });
    fill(tabBody,
      el('p', { class: 'tool-help' }, 'A CSV with latitude and longitude columns, a GeoJSON file, or a zipped shapefile. CSV and GeoJSON stay in your browser; a shapefile is sent to the portal to be converted, and isn\'t saved there.'),
      input, msg);
  }

  const RENDER = { curated: curatedTab, search: searchTab, url: urlTab, file: fileTab };

  function renderTab() {
    fill(tabBar, offered.map(([id, label]) => el('button', {
      type: 'button', class: 'seg-btn', role: 'tab', 'aria-selected': String(id === tab), 'aria-pressed': String(id === tab),
      onclick: () => { if (tab !== id) { tab = id; renderTab(); } }
    }, label)));
    tabBar.hidden = offered.length < 2;
    if (tab) RENDER[tab]();
  }

  /* ---------- What's been added ---------- */
  const forgetItem = addedId => { for (const [itemId, id] of addedItems) if (id === addedId) addedItems.delete(itemId); };

  function renderAdded() {
    const items = h.listAdded();
    fill(addedBox, items.length ? [
      el('p', { class: 'sub-head' }, 'Added to the map (until you close the viewer)'),
      el('ul', { class: 'plain-list' }, items.map(a => el('li', { class: 'ad-added-row' },
        el('span', {}, el('strong', {}, a.title), el('span', { class: 'muted' }, ` ${a.source}`)),
        el('span', { class: 'ad-added-actions' },
          el('button', { type: 'button', class: 'link-btn', onclick: () => h.zoomTo(a.id) }, 'Zoom to'),
          el('button', { type: 'button', class: 'link-btn danger', onclick: () => { h.remove(a.id); forgetItem(a.id); renderAdded(); } }, 'Remove')))))
    ] : null);
  }

  if (!offered.length) { fill(body, el('p', { class: 'pane-empty' }, 'Nothing is set up to add from.')); return { refresh() {} }; }
  fill(body, tabBar, tabBody, addedBox);
  renderTab();
  renderAdded();
  return { refresh() { addedItems.clear(); renderTab(); renderAdded(); } };
}
