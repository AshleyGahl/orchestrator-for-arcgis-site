// addressAuditTool.js — the Address audit tool (Tools panel): compares the site addresses in view with OpenStreetMap
// (one Overpass query for the view) and, when the author allows it and the person enters their own Google API key,
// with Google's Geocoding API. The results open as one table (docked at the bottom by default, spatialWindow.js),
// with Excel/CSV export; the addresses are coloured on the map by what OpenStreetMap says (Google's answers are shown
// in the table only, never on this map, and never kept).
// Nothing waits for everything, and nothing waits in turn:
//  - OpenStreetMap is asked the moment the button is pressed, at the same time as the layer is read, because both take
//    about half a minute on a big view and waiting for one and then the other doubled that;
//  - the addresses in view are listed and drawn as soon as the layer answers, each marked "Checking…";
//  - the rows, the map's colours and the counts fill in as the answers arrive (OpenStreetMap in one go, Google address
//    by address), and the table keeps its sort, the chosen row and where people have scrolled to while it fills.
// An address OpenStreetMap puts somewhere else can be pinned on the map, with a line from the site to OSM's point and
// the distance on it (one chosen address, or every one that is out of place). Only OpenStreetMap's points are drawn:
// Google's terms don't allow its answers on another map, which is what the "Google's own pin" link is for.
// A chosen address can be copied and opened in Google Maps to suggest an edit, and the addresses that need a fix can be
// downloaded in Google Maps Content Partners' format.
// The matching and the formats are in addressAudit.js; the markers leave the map when the tool closes.
import * as map from './map.js';
import { CONFIG } from './config.js';
import { el, fill, downloadText } from './utils.js';
import { createSpatialWindow } from './spatialWindow.js';
import { exportChoices, rowsColumns } from './tableExport.js';
import {
  gisAddress, roleValue, AUDIT_ROLES, roleLabel, overpassQuery, parseOverpass, OVERPASS_URLS, isBbox, inBbox, bboxAreaKm2,
  AUDIT_MAX_AREA_KM2, AUDIT_MAX_FEATURES, googleGeocodeUrl, parseGoogleGeocode, GOOGLE_MAX, matchAll, matchGoogle,
  worstStatus, statusCounts, statusLabel, statusColour, NEEDS_FIX, contentPartnersRows, contentPartnersCsv,
  contentPartnersGeoJson, googleMapsLink, googlePlaceLink, osmLink, CONTENT_PARTNERS_URL, GOOGLE_FIX_HELP_URL
} from './addressAudit.js';

const KEY_STORE = 'gis-orchestrator.googleKey';     // sessionStorage: this tab only, never in the manifest or on a server
const GOOGLE_PARALLEL = 4;
const OVERPASS_WAIT_MS = 45000;                     // one server's turn (it answers in about 30 s when it is well)
const OVERPASS_TOTAL_MS = 150000;                   // every server, both rounds: how long OpenStreetMap gets in all
const OVERPASS_BUSY_WAIT_MS = 6000;                 // a full Overpass queue usually clears in a few seconds
const PAINT_MS = 500;                               // how often the table and the map redraw while answers come in
const n = v => Number(v ?? 0).toLocaleString(CONFIG.numberLocale);
const metres = d => (d == null ? '' : `${n(d)} m`);
const sleep = (ms, signal) => new Promise((done, stop) => {
  const t = setTimeout(done, ms);
  signal?.addEventListener('abort', () => { clearTimeout(t); stop(new DOMException('Cancelled', 'AbortError')); }, { once: true });
});
const readKey = () => { try { return sessionStorage.getItem(KEY_STORE) ?? ''; } catch { return ''; } };
const saveKey = k => { try { if (k) sessionStorage.setItem(KEY_STORE, k); else sessionStorage.removeItem(KEY_STORE); } catch { /* storage blocked */ } };

/** One table cell: text for the table and Excel, the raw value for sorting, a link when there is one. */
const cell = (text, raw = text, href = null) => ({ text: text === '' || text == null ? '—' : String(text), raw: raw === '' ? null : raw ?? null, ...(href ? { href } : {}) });

/**
 * Mount the tool's panel into a Tools panel slot.
 * @param cfg  widgets.toolConfig['address-audit'] (addressAudit.js)
 * @param ctx  { csv(): boolean }  whether the Export results tool is on
 * @returns { destroy() }
 */
export function createAddressAuditTool(node, cfg = {}, ctx = {}) {
  const view = map.getView();
  const SDK = map.getSDK();
  const host = view.container?.closest('.viewer-body') ?? view.container?.parentElement;
  const googleAllowed = (cfg.providers ?? []).includes('google');
  const osmAllowed = (cfg.providers ?? []).includes('osm');
  const x = {
    useOsm: osmAllowed, useGoogle: false, key: readKey(), running: null, rows: [], layerInfo: null,
    chosen: null, error: '', note: '', googleCache: new Map(), gone: false,
    asked: { osm: false, google: false },          // which providers this audit is asking (the table's columns)
    bbox: null,                                    // the view this audit covers (Google's answers lean towards it)
    pinAll: false,                                 // pin every address OpenStreetMap puts somewhere else, not just the chosen one
    progress: { read: '', osm: '', google: '' }
  };
  if (googleAllowed && x.key) x.useGoogle = true;

  const marks = new SDK.GraphicsLayer({ listMode: 'hide', title: 'Address audit' });
  // Where OpenStreetMap puts an address that isn't where the GIS says: drawn above the status markers.
  const elsewhere = new SDK.GraphicsLayer({ listMode: 'hide', title: 'Address audit: OpenStreetMap' });
  view.map.add(marks);
  view.map.add(elsewhere);

  const win = createSpatialWindow(host, {
    onSelectRow: row => choose(row),
    onClose: () => { map.clearAuditResult(); x.chosen = null; paintElsewhere(); render(); },
    onPadding: p => map.setViewPadding(p),
    csv: () => ctx.csv?.() ?? false
  });
  const open = () => ({ size: cfg.windowSize ?? 'bottom', side: 'left' });

  /* ---------------- The panel ---------------- */
  const status = el('p', { class: 'muted', role: 'status', 'aria-live': 'polite' });
  const summaryBox = el('div', {});                  // the counts, redrawn on their own while answers come in
  const body = el('div', { class: 'audit-tool' });
  node.append(body);

  function providerChecks() {
    const box = (on, label, set, disabled = false) => el('label', { class: 'check-row' },
      el('input', { type: 'checkbox', checked: on, disabled, onchange: e => { set(e.target.checked); render(); } }), label);
    return el('div', { class: 'audit-providers', role: 'group', 'aria-label': 'Compare with' },
      osmAllowed ? box(x.useOsm, 'OpenStreetMap', v => { x.useOsm = v; }, Boolean(x.running)) : null,
      googleAllowed ? box(x.useGoogle, 'Google', v => { x.useGoogle = v; }, Boolean(x.running)) : null);
  }

  function keyForm() {
    if (!googleAllowed || !x.useGoogle) return null;
    const input = el('input', { type: 'password', value: x.key, placeholder: 'Your Google Maps Platform API key', 'aria-label': 'Google API key', autocomplete: 'off', spellcheck: 'false' });
    return el('div', { class: 'audit-key' },
      el('div', { class: 'add-row' }, input,
        el('button', { type: 'button', class: 'btn quiet small', onclick: () => { x.key = input.value.trim(); saveKey(x.key); x.googleCache.clear(); render(); } }, x.key ? 'Change' : 'Use'),
        x.key ? el('button', { type: 'button', class: 'btn quiet small', onclick: () => { x.key = ''; saveKey(''); x.googleCache.clear(); render(); } }, 'Forget') : null),
      el('p', { class: 'hint-inline' }, 'Your own key (with the Geocoding API on). It stays in this browser tab and goes only to Google. ',
        `Google charges per address; an audit sends at most ${n(GOOGLE_MAX)}. Google's answers are shown in the table only, not on this map.`));
  }

  /** The counts, as they stand: redrawn while the audit runs, so people watch it fill. */
  function paintSummary() {
    if (!x.rows.length) { fill(summaryBox); return; }
    const counts = statusCounts(x.rows.map(r => r.status));
    const off = x.rows.filter(outOfPlace).length;
    fill(summaryBox, el('div', { class: 'audit-summary' },
      el('ul', { class: 'audit-counts' }, counts.map(([id, label, count]) => el('li', {},
        el('span', { class: 'audit-dot', style: `background:${statusColour(id)}`, 'aria-hidden': 'true' }), `${label}: `, el('strong', {}, n(count))))),
      off ? el('label', { class: 'check-row' },
        el('input', { type: 'checkbox', checked: x.pinAll, onchange: e => { x.pinAll = e.target.checked; paintElsewhere(); paintSummary(); } }),
        `Pin where OpenStreetMap puts them (${n(off)} out of place)`) : null,
      win.isOpen() ? null : el('button', { type: 'button', class: 'btn quiet small', onclick: showTable }, 'Show the table')));
  }

  function chosenBlock() {
    const r = x.chosen;
    if (!r) return null;
    const text = r.gis.text;
    const msg = el('span', { class: 'muted' });
    return el('div', { class: 'audit-chosen' },
      el('p', { class: 'sub-head' }, 'Chosen address'),
      el('p', {}, el('strong', {}, text || '(no address)'), ' ', el('span', { class: 'audit-dot', style: `background:${statusColour(r.status)}`, 'aria-hidden': 'true' }), ` ${statusLabel(r.status)}`),
      outOfPlace(r) ? el('p', { class: 'hint-inline' }, `The line on the map runs from this site to where OpenStreetMap puts the address, ${metres(r.osm.distance)} away.`) : null,
      el('div', { class: 'seg' },
        el('button', { type: 'button', class: 'seg-btn', onclick: async () => {
          try { await navigator.clipboard.writeText(text); msg.textContent = 'Copied.'; } catch { msg.textContent = 'Select the address above and copy it.'; }
        } }, 'Copy address'),
        el('a', { class: 'seg-btn', href: googleMapsLink(r.gis.lat, r.gis.lon), target: '_blank', rel: 'noopener', title: 'Google Maps at the spot the GIS gives' }, 'Google Maps: this spot'),
        googlePlaceLink(r.google?.candidate)
          ? el('a', { class: 'seg-btn', href: googlePlaceLink(r.google.candidate), target: '_blank', rel: 'noopener', title: "The place Google returned — the one Suggest an edit acts on" }, "Google's own pin")
          : null,
        r.osm?.candidate ? el('a', { class: 'seg-btn', href: osmLink(r.osm.candidate.id), target: '_blank', rel: 'noopener' }, 'Open in OpenStreetMap') : null),
      msg,
      el('p', { class: 'hint-inline' }, "To fix it on Google Maps: open Google's own pin (not this spot), choose ", el('strong', {}, 'Suggest an edit'), ' → ',
        el('strong', {}, 'Wrong pin location or address'), ', paste the address and submit. A missing address: ', el('strong', {}, 'Menu'), ' → ',
        el('strong', {}, 'Edit the map'), ' → ', el('strong', {}, 'Wrong pin location or address'), ', and centre the map on the building. ',
        el('a', { href: GOOGLE_FIX_HELP_URL, target: '_blank', rel: 'noopener' }, 'Google\'s help')));
  }

  function googleExport() {
    if (!x.rows.length) return null;
    const fix = x.rows.filter(r => NEEDS_FIX.has(r.status));
    const usable = list => contentPartnersRows(list, cfg);
    const which = el('select', { 'aria-label': 'Addresses to include' },
      el('option', { value: 'fix' }, `Addresses that need a fix (${n(usable(fix).length)})`),
      el('option', { value: 'all' }, `Every complete address checked (${n(usable(x.rows).length)})`));
    const fmt = el('select', { 'aria-label': 'File format' }, el('option', { value: 'csv' }, 'CSV'), el('option', { value: 'geojson' }, 'GeoJSON'));
    const msg = el('span', { class: 'muted' });
    const download = () => {
      const pts = usable(which.value === 'all' ? x.rows : x.rows.filter(r => NEEDS_FIX.has(r.status)));
      if (!pts.length) { msg.textContent = 'No complete addresses to send.'; return; }
      const stamp = new Date().toISOString().slice(0, 10);
      if (fmt.value === 'csv') downloadText(contentPartnersCsv(pts), `google-address-points-${stamp}.csv`, 'text/csv;charset=utf-8');
      else downloadText(JSON.stringify(contentPartnersGeoJson(pts), null, 1), `google-address-points-${stamp}.geojson`, 'application/geo+json');
      msg.textContent = `Saved ${n(pts.length)} address point${pts.length === 1 ? '' : 's'}.`;
    };
    return el('details', { class: 'audit-google' },
      el('summary', {}, 'Send to Google Maps (many addresses)'),
      el('p', { class: 'hint-inline' }, 'Organisations and governments send address corrections in bulk through Google Maps Content Partners. ',
        'The file has Google\'s address point fields (ST_NUM, ST_NAME, NEIGHBH, LOCALITY, ADMIN, POSTAL, CNTRY, LAT, LON) with street types written out.'),
      el('div', { class: 'add-row' }, which, fmt, el('button', { type: 'button', class: 'btn primary small', onclick: download }, 'Download')),
      msg,
      el('p', {}, el('a', { href: CONTENT_PARTNERS_URL, target: '_blank', rel: 'noopener' }, 'Open Google Maps Content Partners'),
        el('span', { class: 'muted' }, ' (the organisation signs up there once; Google checks it is the authority for the area).')));
  }

  function render() {
    if (x.gone) return;
    const ready = cfg.layer && cfg.fields?.number?.field && cfg.fields?.street?.field;
    if (!ready) {
      fill(body, el('p', { class: 'muted' }, 'Address audit is not set up yet: choose the address layer and its fields in its settings.'));
      return;
    }
    const can = (x.useOsm || (x.useGoogle && x.key)) && !x.running;
    fill(body,
      el('p', { class: 'tool-help' }, `Compares the site addresses in view with what ${[osmAllowed && 'OpenStreetMap', googleAllowed && 'Google'].filter(Boolean).join(' and ')} say is there. Zoom in to a few streets first (at most ${AUDIT_MAX_AREA_KM2} km²). The addresses are listed as soon as they're read; their statuses fill in as the answers come back.`),
      providerChecks(),
      keyForm(),
      el('div', { class: 'seg' },
        el('button', { type: 'button', class: 'btn primary', disabled: !can, onclick: run }, 'Audit this view'),
        x.running ? el('button', { type: 'button', class: 'btn quiet', onclick: () => x.running?.abort() }, 'Cancel') : null),
      status,
      x.error ? el('p', { class: 'err' }, x.error) : null,
      x.note ? el('p', { class: 'muted' }, x.note) : null,
      summaryBox,
      chosenBlock(),
      x.running ? null : googleExport());
    paintSummary();
  }

  /* ---------------- Running an audit ---------------- */
  async function fetchJson(url, init, signal, what) {
    let res;
    try { res = await fetch(url, { ...init, signal }); }
    catch (e) { if (e.name === 'AbortError') throw e; throw new Error(`${what} couldn't be reached (${e.message}).`); }
    if (res.status === 429 || res.status >= 500) throw new Error(`${what} is busy (${res.status}). Try again in a minute.`);
    if (!res.ok) throw new Error(`${what} answered ${res.status}.`);
    return res.json();
  }

  /**
   * Every OpenStreetMap address in the view: one Overpass query, through the servers in turn. A server that is busy
   * or overloaded says so in a moment, so the next one is asked straight away; if none of them answers, they are all
   * given a few seconds and asked once more. The whole thing is held to OVERPASS_TOTAL_MS, so a dead mirror can't
   * hold an audit up for minutes.
   */
  async function osmCandidates(bbox, signal) {
    const deadline = Date.now() + OVERPASS_TOTAL_MS;
    let last = null;
    for (let round = 0; round < 2; round++) {
      if (round) {
        if (deadline - Date.now() < OVERPASS_BUSY_WAIT_MS + 5000) break;
        progress('osm', 'OpenStreetMap is busy; waiting a few seconds…');
        await sleep(OVERPASS_BUSY_WAIT_MS, signal);
        progress('osm', 'Asking OpenStreetMap again…');
      }
      for (const url of OVERPASS_URLS) {
        const left = deadline - Date.now();
        if (left < 5000) break;
        const limit = AbortSignal.timeout(Math.min(OVERPASS_WAIT_MS, left));   // a server that never answers: next
        try { return parseOverpass(await fetchJson(url, { method: 'POST', body: new URLSearchParams({ data: overpassQuery(bbox) }) }, AbortSignal.any([signal, limit]), "OpenStreetMap's server")); }
        catch (e) {
          if (signal.aborted) throw e;
          if (limit.aborted) { last = new Error("OpenStreetMap's server didn't answer in time."); continue; }
          if (!/busy|reached|answered 5/.test(e.message)) throw e;             // a real refusal: say what it was
          last = e;
        }
      }
    }
    throw new Error(`${last?.message ?? "OpenStreetMap couldn't be reached."} Its public servers are shared; try again in a minute, or switch OpenStreetMap off and use Google.`);
  }

  async function googleAnswer(gis, signal) {
    const k = gis.text;
    if (x.googleCache.has(k)) return x.googleCache.get(k);
    const answer = parseGoogleGeocode(await fetchJson(googleGeocodeUrl(gis, x.key, cfg.country || 'ZA', x.bbox), {}, signal, 'Google'));
    x.googleCache.set(k, answer);                      // this audit only: Google's answers are never stored
    return answer;
  }

  /** The point a feature's address stands for: the point, or a polygon's centre, in WGS 84. */
  const pointOf = g => {
    const p = g?.type === 'point' ? g : g?.centroid ?? g?.extent?.center ?? null;
    return p && Number.isFinite(p.latitude) && Number.isFinite(p.longitude) ? { lat: p.latitude, lon: p.longitude, geometry: p } : null;
  };

  /** A row's overall status: the provider that most needs attention, or "Checking…" until one has answered. */
  const rowStatus = r => (r.gis.incomplete ? 'gis-incomplete' : worstStatus(r.osm?.status, r.google?.status) ?? 'checking');

  /* ---- Showing what has come in so far ---- */
  let paintTimer = null;
  const say = () => { status.textContent = [x.progress.read, x.progress.osm, x.progress.google].filter(Boolean).join(' · '); };
  const progress = (part, text) => { x.progress[part] = text; say(); };

  /** Redraw the markers, the table and the counts; `now` for the last word, otherwise at most every PAINT_MS. */
  function refresh(now = false) {
    if (x.gone) return;
    if (now) { clearTimeout(paintTimer); paintTimer = null; paint(); return; }
    paintTimer ??= setTimeout(() => { paintTimer = null; paint(); }, PAINT_MS);
  }
  function paint() {
    syncMarks();
    paintElsewhere();
    if (win.isOpen()) { win.update([tableResult()]); win.subtitle(tableSubtitle()); }
    paintSummary();
  }

  async function run() {
    const pos = map.getMapPosition();
    const bbox = pos && { south: pos.ymin, west: pos.xmin, north: pos.ymax, east: pos.xmax };
    x.error = ''; x.note = '';
    if (!isBbox(bbox)) { x.error = 'The map has no usable extent here (it needs Web Mercator or WGS 84).'; render(); return; }
    const area = bboxAreaKm2(bbox);
    if (area > AUDIT_MAX_AREA_KM2) { x.error = `The view covers ${area.toFixed(1)} km². Zoom in to ${AUDIT_MAX_AREA_KM2} km² or less, so the public OpenStreetMap servers aren't overloaded.`; render(); return; }
    const controller = new AbortController();
    x.running = controller;
    x.rows = [];
    x.asked = { osm: x.useOsm, google: Boolean(x.useGoogle && x.key) };
    x.bbox = bbox;                    // Google leans towards the map in view, or a street name alone lands in another town
    x.progress = { read: 'Reading the site addresses in view…', osm: '', google: '' };
    marks.removeAll();
    elsewhere.removeAll();
    map.clearAuditResult();
    x.chosen = null;
    x.pinAll = false;
    render();
    // OpenStreetMap is asked now, not after the layer has been read: both take about half a minute on a wide view, and
    // one after the other doubled the wait. It never rejects, so nothing is unhandled if reading the layer fails.
    let osmTask = null;
    if (x.asked.osm) {
      progress('osm', 'Asking OpenStreetMap… (its public servers can take up to a minute)');
      osmTask = osmCandidates(bbox, controller.signal).then(list => ({ list }), error => ({ error }));
    }
    try {
      x.layerInfo ??= await map.labelLayerInfo(cfg.layer);
      const feats = (await map.queryLayerInView(cfg.layer, { max: AUDIT_MAX_FEATURES }))
        .map(f => ({ f, at: pointOf(f.geometry) }))
        .filter(({ at }) => at && inBbox(at, bbox));
      if (feats.length >= AUDIT_MAX_FEATURES) x.note = `Only the first ${n(AUDIT_MAX_FEATURES)} addresses were read. Zoom in for the rest.`;
      if (!feats.length) { progress('read', ''); x.rows = []; x.error = 'No site addresses in view. Pan to an area with addresses, or zoom out a little.'; return; }

      // Every address in view, listed and on the map straight away; the statuses fill in behind it.
      x.rows = feats.map(({ f, at }) => {
        const r = { f, gis: { ...gisAddress(f.attributes, cfg), lat: at.lat, lon: at.lon }, geometry: at.geometry, osm: null, google: null, mark: null };
        r.status = rowStatus(r);
        return r;
      });
      progress('read', `${n(x.rows.length)} address${x.rows.length === 1 ? '' : 'es'} in view`);
      syncMarks();
      showTable();
      paintSummary();

      // OpenStreetMap's one answer and Google's address by address, at the same time: each writes its own rows.
      await Promise.all([osmTask ? runOsm(osmTask, controller.signal) : null, x.asked.google ? runGoogle(controller.signal) : null]);
      if (controller.signal.aborted) throw new DOMException('Cancelled', 'AbortError');
      finishPending();
      refresh(true);
      const counts = statusCounts(x.rows.map(r => r.status));
      x.progress = { read: `Checked ${n(x.rows.length)} address${x.rows.length === 1 ? '' : 'es'}: ${counts.map(([, label, c]) => `${label.toLowerCase()} ${n(c)}`).join(', ')}.`, osm: '', google: '' };
      say();
    } catch (e) {
      if (e.name === 'AbortError') {
        const left = x.rows.filter(r => r.status === 'checking').length;
        x.progress = { read: left ? `Cancelled: ${n(left)} of ${n(x.rows.length)} addresses were left unchecked.` : 'Cancelled.', osm: '', google: '' };
        say();
        refresh(true);
      }
      else { x.progress = { read: '', osm: '', google: '' }; say(); x.error = e.message; }
    } finally {
      controller.abort();          // nothing left in flight (a layer that failed leaves the Overpass query running)
      x.running = null;
      render();
    }
  }

  /**
   * OpenStreetMap's answer for the whole view (asked for when the audit started, alongside the layer): every address
   * is settled at once. One query for the view, not several smaller ones — a public Overpass server takes about the
   * same half a minute whatever the box is, so parts of the view only multiplied the wait.
   */
  async function runOsm(task, signal) {
    const { list, error } = await task;
    if (signal.aborted) return;
    if (error) {
      if (error.name === 'AbortError') return;
      x.error = error.message;
      for (const r of x.rows) {
        if (r.osm) continue;
        r.osm = { status: 'error', candidate: null, distance: null, error: error.message };
        r.status = rowStatus(r);
      }
    } else {
      applyOsm(list);
    }
    progress('osm', '');
    refresh(true);
  }

  /** What OpenStreetMap says about each address in view (each OSM address stands for the site nearest it). */
  function applyOsm(candidates) {
    const matches = matchAll(x.rows.map(r => r.gis), candidates, cfg.maxDistance);
    x.rows.forEach((r, i) => { r.osm = matches[i]; r.status = rowStatus(r); });
  }

  /** Google, a few addresses at a time: each answer lands in its own row as it arrives. */
  async function runGoogle(signal) {
    const complete = x.rows.filter(r => !r.gis.incomplete);
    const todo = complete.slice(0, GOOGLE_MAX);
    if (complete.length > GOOGLE_MAX) x.note = [x.note, `Google was asked about the first ${n(GOOGLE_MAX)} addresses only.`].filter(Boolean).join(' ');
    let done = 0, i = 0;
    const worker = async () => {
      while (i < todo.length) {
        const r = todo[i++];
        if (signal.aborted) return;
        try { r.google = matchGoogle(r.gis, await googleAnswer(r.gis, signal), cfg.maxDistance); }
        catch (e) {
          if (e.name === 'AbortError') return;
          r.google = { status: 'error', candidate: null, distance: null, error: e.message };
          if (/key|denied|invalid/i.test(e.message)) { x.error = `Google refused the request: ${e.message}`; i = todo.length; }
        }
        r.status = rowStatus(r);
        progress('google', `Google: ${n(++done)} of ${n(todo.length)}…`);
        refresh();
      }
    };
    await Promise.all(Array.from({ length: GOOGLE_PARALLEL }, worker));
    progress('google', '');
  }

  /** Addresses Google was never asked about (past its limit) don't stay "Checking…" once the audit is over. */
  function finishPending() {
    for (const r of x.rows) {
      if (r.status !== 'checking') continue;
      const why = `Not asked: Google is sent at most ${n(GOOGLE_MAX)} addresses.`;
      r.google ??= { status: 'error', candidate: null, distance: null, error: why };
      r.status = rowStatus(r);
    }
  }

  /* ---------------- Map and table ---------------- */
  /**
   * The addresses on the map, in OpenStreetMap's colours (Google's answers stay in the table: its terms keep them off
   * other maps). Each row keeps its marker, so an answer only changes that marker's colour — no flicker as rows fill.
   */
  function syncMarks() {
    const want = r => (r.gis.incomplete ? 'gis-incomplete' : x.asked.osm ? r.osm?.status ?? 'checking' : null);
    for (const r of x.rows) {
      const s = want(r);
      if (!s) { if (r.mark) { marks.remove(r.mark); r.mark = null; r.markStatus = null; } continue; }
      if (!r.mark) {
        r.mark = new SDK.Graphic({ geometry: r.geometry, symbol: markSymbol(s), attributes: { status: s } });
        r.markStatus = s;
        marks.add(r.mark);
      } else if (r.markStatus !== s) {
        r.mark.symbol = markSymbol(s);
        r.markStatus = s;
      }
    }
  }
  const markSymbol = s => ({ type: 'simple-marker', color: statusColour(s), size: s === 'checking' ? 7 : 9, outline: { color: [255, 255, 255, 1], width: 1.25 } });

  /** Addresses OpenStreetMap has, but not where the GIS says: a line worth drawing. */
  const outOfPlace = r => Boolean(r.osm?.candidate) && r.osm.status !== 'match';
  const point4326 = (lon, lat) => ({ type: 'point', longitude: lon, latitude: lat, spatialReference: { wkid: 4326 } });

  /**
   * Pin where OpenStreetMap puts these addresses: a ring on OSM's point, a dashed line from the site to it and the
   * distance along the line. Only OpenStreetMap's own points go on the map — Google's terms keep its answers off
   * another map, so a Google answer is opened on Google's map instead ("Google's pin").
   */
  function drawElsewhere(rows) {
    elsewhere.removeAll();
    for (const r of rows) {
      const c = r.osm.candidate;
      const colour = statusColour(r.osm.status);
      elsewhere.add(new SDK.Graphic({
        geometry: { type: 'polyline', paths: [[[r.gis.lon, r.gis.lat], [c.lon, c.lat]]], spatialReference: { wkid: 4326 } },
        symbol: { type: 'simple-line', color: colour, width: 2, style: 'short-dash' }
      }));
      elsewhere.add(new SDK.Graphic({
        geometry: point4326(c.lon, c.lat),
        symbol: { type: 'simple-marker', style: 'diamond', size: 14, color: [255, 255, 255, 0.85], outline: { color: colour, width: 2 } },
        popupTemplate: null
      }));
      if (r.osm.distance != null) {
        elsewhere.add(new SDK.Graphic({
          geometry: point4326((r.gis.lon + c.lon) / 2, (r.gis.lat + c.lat) / 2),
          symbol: { type: 'text', text: metres(r.osm.distance), color: colour, yoffset: 6, font: { size: 10, weight: 'bold' }, haloColor: [255, 255, 255, 1], haloSize: 1.5 }
        }));
      }
    }
  }

  /** The chosen address, or every one out of place when the switch is on. */
  function paintElsewhere() {
    if (x.pinAll) { drawElsewhere(x.rows.filter(outOfPlace)); return; }
    drawElsewhere(x.chosen && outOfPlace(x.chosen) ? [x.chosen] : []);
  }

  /** The parts the author mapped, each its own column: what the settings picked, as the field holds it. */
  const mappedRoles = () => AUDIT_ROLES.filter(([id]) => cfg.fields?.[id]?.field).map(([id]) => id);

  function tableColumns() {
    const oid = x.layerInfo?.objectIdField;
    return [
      ...(oid ? [{ name: oid, label: 'Object ID' }] : []),
      { name: 'aa_status', label: 'Status' },
      ...mappedRoles().map(id => ({ name: `aa_part_${id}`, label: roleLabel(id) })),
      { name: 'aa_gis', label: 'GIS address (compared)' },
      ...(x.asked.osm ? [{ name: 'aa_osm_status', label: 'OpenStreetMap' }, { name: 'aa_osm', label: 'OpenStreetMap address' }, { name: 'aa_osm_d', label: 'Distance (OSM)' }] : []),
      ...(x.asked.google ? [{ name: 'aa_g_status', label: 'Google' }, { name: 'aa_g', label: 'Google address' }, { name: 'aa_g_d', label: 'Distance (Google)' }] : []),
      { name: 'aa_lat', label: 'Latitude' }, { name: 'aa_lon', label: 'Longitude' },
      { name: 'aa_link', label: 'Open in Google Maps' }
    ];
  }

  /** What one provider says in a row, or why it hasn't: "Checking…" until its answer arrives. */
  const providerCell = m => cell(m ? (m.error ? `${statusLabel('error')}: ${m.error}` : statusLabel(m.status)) : statusLabel('checking'), m?.status ?? 'checking');

  function tableRows() {
    const fields = x.layerInfo?.fields ?? [];
    return x.rows.map((r, i) => {
      const cells = {};
      for (const f of fields) { const v = r.f.attributes?.[f.name]; cells[f.name] = cell(v ?? '', v ?? null); }
      for (const id of mappedRoles()) { const v = roleValue(r.f.attributes, cfg.fields[id]); cells[`aa_part_${id}`] = cell(v, v); }
      Object.assign(cells, {
        aa_status: cell(statusLabel(r.status), r.status),
        aa_gis: cell(r.gis.text),
        aa_osm_status: providerCell(r.gis.incomplete ? { status: 'gis-incomplete' } : r.osm),
        aa_osm: cell(r.osm?.candidate?.text ?? '', r.osm?.candidate?.text ?? null, r.osm?.candidate ? osmLink(r.osm.candidate.id) : null),
        aa_osm_d: cell(metres(r.osm?.distance), r.osm?.distance ?? null),
        aa_g_status: providerCell(r.gis.incomplete ? { status: 'gis-incomplete' } : r.google),
        aa_g: cell(r.google?.candidate?.text ?? '', r.google?.candidate?.text ?? null),
        aa_g_d: cell(metres(r.google?.distance), r.google?.distance ?? null),
        aa_lat: cell(r.gis.lat.toFixed(6), r.gis.lat), aa_lon: cell(r.gis.lon.toFixed(6), r.gis.lon),
        // Google's own pin when it answered (that place is what Suggest an edit acts on), else the spot the GIS gives.
        aa_link: googlePlaceLink(r.google?.candidate)
          ? cell("Google's pin", null, googlePlaceLink(r.google.candidate))
          : cell('This spot', null, googleMapsLink(r.gis.lat, r.gis.lon))
      });
      return { id: i, cells, audit: r };
    });
  }

  const layerTitle = () => x.layerInfo?.title ?? 'Addresses';

  function tableSubtitle() {
    const left = x.rows.filter(r => r.status === 'checking').length;
    const count = `${n(x.rows.length)} address${x.rows.length === 1 ? '' : 'es'} in view`;
    return left ? `${layerTitle()}: ${count} — ${n(left)} still being checked` : `${layerTitle()}: ${count}`;
  }

  /** The table as it stands: fresh rows every time, so an update keeps the sort and the chosen row. */
  function tableResult() {
    const columns = tableColumns();
    const rows = tableRows();
    const fields = [...(x.layerInfo?.fields ?? [])];
    const choices = exportChoices(columns.filter(c => c.name !== 'aa_link'), fields);
    return {
      title: `Address audit - ${layerTitle()}`, columns, rows, total: rows.length,
      exportFields: choices,
      exportAll: async picked => {
        const live = tableRows();
        return { columns: rowsColumns(choices, live, fields, picked), rows: live };
      }
    };
  }

  function showTable() {
    if (!x.rows.length) return;
    win.show('Address audit', tableSubtitle(), [tableResult()], open());
    paintSummary();
  }

  function choose(row) {
    const r = row.audit;
    if (!r) return;
    x.chosen = r;
    paintElsewhere();
    map.emphasise(r.geometry, cfg.emphasis, { owner: 'audit', zoom: true });
    render();
  }

  render();
  return {
    destroy() {
      x.gone = true;
      clearTimeout(paintTimer);
      x.running?.abort();
      win.destroy();                     // closes it (clearing its padding) and takes it out of the page
      map.clearAuditResult();
      for (const layer of [marks, elsewhere]) { view.map.remove(layer); layer.destroy?.(); }
    }
  };
}
