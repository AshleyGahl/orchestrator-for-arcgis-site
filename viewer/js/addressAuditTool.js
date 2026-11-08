// addressAuditTool.js — the Address audit tool (Tools panel): compares the site addresses in view with OpenStreetMap
// (one Overpass query for the view) and, when the author allows it and the person enters their own Google API key,
// with Google's Geocoding API. The results open as one table (docked at the bottom by default, spatialWindow.js), with
// Excel/CSV export; the addresses are coloured on the map by what OpenStreetMap says (Google's answers are shown in the
// table only, never on this map, and never kept). A chosen address can be copied and opened in Google Maps to suggest
// an edit, and the addresses that need a fix can be downloaded in Google Maps Content Partners' format.
// The matching and the formats are in addressAudit.js; the markers leave the map when the tool closes.
import * as map from './map.js';
import { CONFIG } from './config.js';
import { el, fill, downloadText } from './utils.js';
import { createSpatialWindow } from './spatialWindow.js';
import { exportChoices, rowsColumns } from './tableExport.js';
import {
  gisAddress, overpassQuery, parseOverpass, OVERPASS_URLS, isBbox, bboxAreaKm2, AUDIT_MAX_AREA_KM2, AUDIT_MAX_FEATURES,
  googleGeocodeUrl, parseGoogleGeocode, GOOGLE_MAX, matchAll, matchGoogle, worstStatus, statusCounts, statusLabel, statusColour,
  NEEDS_FIX, contentPartnersRows, contentPartnersCsv, contentPartnersGeoJson, googleMapsLink, osmLink, CONTENT_PARTNERS_URL, GOOGLE_FIX_HELP_URL
} from './addressAudit.js';

const KEY_STORE = 'gis-orchestrator.googleKey';     // sessionStorage: this tab only, never in the manifest or on a server
const GOOGLE_PARALLEL = 4;
const OVERPASS_WAIT_MS = 90000;                     // the query's own limit is 60 s; a busy server queues it first
const n = v => Number(v ?? 0).toLocaleString(CONFIG.numberLocale);
const metres = d => (d == null ? '' : `${n(d)} m`);
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
    chosen: null, error: '', note: '', googleCache: new Map(), gone: false
  };
  if (googleAllowed && x.key) x.useGoogle = true;

  const marks = new SDK.GraphicsLayer({ listMode: 'hide', title: 'Address audit' });
  view.map.add(marks);

  const win = createSpatialWindow(host, {
    onSelectRow: row => choose(row),
    onClose: () => { map.clearAuditResult(); x.chosen = null; render(); },
    onPadding: p => map.setViewPadding(p),
    csv: () => ctx.csv?.() ?? false
  });
  const open = () => ({ size: cfg.windowSize ?? 'bottom', side: 'left' });

  /* ---------------- The panel ---------------- */
  const status = el('p', { class: 'muted', role: 'status', 'aria-live': 'polite' });
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

  function summary() {
    if (!x.rows.length) return null;
    const counts = statusCounts(x.rows.map(r => r.status));
    return el('div', { class: 'audit-summary' },
      el('ul', { class: 'audit-counts' }, counts.map(([id, label, count]) => el('li', {},
        el('span', { class: 'audit-dot', style: `background:${statusColour(id)}`, 'aria-hidden': 'true' }), `${label}: `, el('strong', {}, n(count))))),
      el('button', { type: 'button', class: 'btn quiet small', onclick: showTable }, 'Show the table'));
  }

  function chosenBlock() {
    const r = x.chosen;
    if (!r) return null;
    const text = r.gis.text;
    const msg = el('span', { class: 'muted' });
    return el('div', { class: 'audit-chosen' },
      el('p', { class: 'sub-head' }, 'Chosen address'),
      el('p', {}, el('strong', {}, text || '(no address)'), ' ', el('span', { class: 'audit-dot', style: `background:${statusColour(r.status)}`, 'aria-hidden': 'true' }), ` ${statusLabel(r.status)}`),
      el('div', { class: 'seg' },
        el('button', { type: 'button', class: 'seg-btn', onclick: async () => {
          try { await navigator.clipboard.writeText(text); msg.textContent = 'Copied.'; } catch { msg.textContent = 'Select the address above and copy it.'; }
        } }, 'Copy address'),
        el('a', { class: 'seg-btn', href: googleMapsLink(r.gis.lat, r.gis.lon), target: '_blank', rel: 'noopener' }, 'Open in Google Maps'),
        r.osm?.candidate ? el('a', { class: 'seg-btn', href: osmLink(r.osm.candidate.id), target: '_blank', rel: 'noopener' }, 'Open in OpenStreetMap') : null),
      msg,
      el('p', { class: 'hint-inline' }, 'To fix it on Google Maps: open the place, choose ', el('strong', {}, 'Suggest an edit'), ' → ',
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
      const pts = usable(which.value === 'all' ? x.rows : fix);
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
      el('p', { class: 'tool-help' }, `Compares the site addresses in view with what ${[osmAllowed && 'OpenStreetMap', googleAllowed && 'Google'].filter(Boolean).join(' and ')} say is there. Zoom in to a few streets first (at most ${AUDIT_MAX_AREA_KM2} km²).`),
      providerChecks(),
      keyForm(),
      el('div', { class: 'seg' },
        el('button', { type: 'button', class: 'btn primary', disabled: !can, onclick: run }, 'Audit this view'),
        x.running ? el('button', { type: 'button', class: 'btn quiet', onclick: () => x.running?.abort() }, 'Cancel') : null),
      status,
      x.error ? el('p', { class: 'err' }, x.error) : null,
      x.note ? el('p', { class: 'muted' }, x.note) : null,
      summary(),
      chosenBlock(),
      googleExport());
  }

  /* ---------------- Running an audit ---------------- */
  async function fetchJson(url, init, signal, what) {
    let res;
    try { res = await fetch(url, { ...init, signal }); }
    catch (e) { if (e.name === 'AbortError') throw e; throw new Error(`${what} couldn't be reached (${e.message}).`); }
    if (res.status === 429 || res.status === 504) throw new Error(`${what} is busy. Try again in a minute.`);
    if (!res.ok) throw new Error(`${what} answered ${res.status}.`);
    return res.json();
  }

  /** Every OpenStreetMap address in the box: one Overpass query, on the next server when one is busy. */
  async function osmCandidates(bbox, signal) {
    let last = null;
    for (const url of OVERPASS_URLS) {
      const limit = AbortSignal.timeout(OVERPASS_WAIT_MS);             // a server that never answers: try the next
      try { return parseOverpass(await fetchJson(url, { method: 'POST', body: new URLSearchParams({ data: overpassQuery(bbox) }) }, AbortSignal.any([signal, limit]), "OpenStreetMap's server")); }
      catch (e) {
        if (signal.aborted) throw e;
        if (limit.aborted) e = new Error("OpenStreetMap's server didn't answer in time. Try again, or zoom in.");
        else if (!/busy|reached|answered 5/.test(e.message)) throw e;
        last = e;
      }
    }
    throw last;
  }

  async function googleAnswer(gis, signal) {
    const k = gis.text;
    if (x.googleCache.has(k)) return x.googleCache.get(k);
    const answer = parseGoogleGeocode(await fetchJson(googleGeocodeUrl(gis, x.key, cfg.country || 'ZA'), {}, signal, 'Google'));
    x.googleCache.set(k, answer);                      // this visit only: Google's answers are never stored
    return answer;
  }

  /** The point a feature's address stands for: the point, or a polygon's centre, in WGS 84. */
  const pointOf = g => {
    const p = g?.type === 'point' ? g : g?.centroid ?? g?.extent?.center ?? null;
    return p && Number.isFinite(p.latitude) && Number.isFinite(p.longitude) ? { lat: p.latitude, lon: p.longitude, geometry: p } : null;
  };

  async function run() {
    const pos = map.getMapPosition();
    const bbox = pos && { south: pos.ymin, west: pos.xmin, north: pos.ymax, east: pos.xmax };
    x.error = ''; x.note = '';
    if (!isBbox(bbox)) { x.error = 'The map has no usable extent here (it needs Web Mercator or WGS 84).'; render(); return; }
    const area = bboxAreaKm2(bbox);
    if (area > AUDIT_MAX_AREA_KM2) { x.error = `The view covers ${area.toFixed(1)} km². Zoom in to ${AUDIT_MAX_AREA_KM2} km² or less, so the public OpenStreetMap servers aren't overloaded.`; render(); return; }
    const controller = new AbortController();
    x.running = controller;
    map.clearAuditResult();
    x.chosen = null;
    render();
    const say = t => { status.textContent = t; };
    try {
      say('Reading the site addresses in view…');
      x.layerInfo ??= await map.labelLayerInfo(cfg.layer);
      const feats = (await map.queryLayerInView(cfg.layer, { max: AUDIT_MAX_FEATURES }))
        .map(f => ({ f, at: pointOf(f.geometry) }))
        .filter(({ at }) => at && at.lat >= bbox.south && at.lat <= bbox.north && at.lon >= bbox.west && at.lon <= bbox.east);
      if (feats.length >= AUDIT_MAX_FEATURES) x.note = `Only the first ${n(AUDIT_MAX_FEATURES)} addresses were read. Zoom in for the rest.`;
      if (!feats.length) { say(''); x.rows = []; x.error = 'No site addresses in view. Pan to an area with addresses, or zoom out a little.'; return; }
      const gisList = feats.map(({ f, at }) => ({ f, gis: { ...gisAddress(f.attributes, cfg), lat: at.lat, lon: at.lon }, geometry: at.geometry }));

      let osm = null;
      if (x.useOsm) {
        say(`Asking OpenStreetMap about ${n(gisList.length)} addresses… (its public servers can take up to a minute)`);
        osm = await osmCandidates(bbox, controller.signal);
      }
      const google = new Map();
      if (x.useGoogle && x.key) {
        const todo = gisList.filter(r => !r.gis.incomplete).slice(0, GOOGLE_MAX);
        if (gisList.filter(r => !r.gis.incomplete).length > GOOGLE_MAX) x.note = [x.note, `Google was asked about the first ${n(GOOGLE_MAX)} addresses only.`].filter(Boolean).join(' ');
        let done = 0, i = 0;
        const worker = async () => {
          while (i < todo.length) {
            const r = todo[i++];
            if (controller.signal.aborted) return;
            try { google.set(r, matchGoogle(r.gis, await googleAnswer(r.gis, controller.signal), cfg.maxDistance)); }
            catch (e) {
              if (e.name === 'AbortError') return;
              google.set(r, { status: 'error', candidate: null, distance: null, error: e.message });
              if (/key|denied|invalid/i.test(e.message)) { x.error = `Google refused the request: ${e.message}`; i = todo.length; }
            }
            say(`Asking Google… ${n(++done)} of ${n(todo.length)}`);
          }
        };
        await Promise.all(Array.from({ length: GOOGLE_PARALLEL }, worker));
        if (controller.signal.aborted) throw new DOMException('Cancelled', 'AbortError');
      }

      const osmMatches = osm ? matchAll(gisList.map(r => r.gis), osm, cfg.maxDistance) : null;
      x.rows = gisList.map((r, i) => {
        const o = osmMatches?.[i] ?? null;
        const g = google.get(r) ?? null;
        return { ...r, osm: o, google: g, status: worstStatus(o?.status, g?.status) ?? 'gis-incomplete' };
      });
      drawMarks();
      const counts = statusCounts(x.rows.map(r => r.status));
      say(`Checked ${n(x.rows.length)} address${x.rows.length === 1 ? '' : 'es'}: ${counts.map(([, label, c]) => `${label.toLowerCase()} ${n(c)}`).join(', ')}.`);
      showTable();
    } catch (e) {
      if (e.name === 'AbortError') say('Cancelled.');
      else { say(''); x.error = e.message; }
    } finally {
      x.running = null;
      render();
    }
  }

  /* ---------------- Map and table ---------------- */
  function drawMarks() {
    marks.removeAll();
    // OpenStreetMap's verdict colours the address (Google's answers stay in the table: its terms keep them off other maps).
    for (const r of x.rows) {
      const s = r.osm?.status ?? (r.gis.incomplete ? 'gis-incomplete' : null);
      if (!s) continue;
      marks.add(new SDK.Graphic({
        geometry: r.geometry,
        symbol: { type: 'simple-marker', color: statusColour(s), size: 9, outline: { color: [255, 255, 255, 1], width: 1.25 } },
        attributes: { status: s }
      }));
    }
  }

  function tableColumns() {
    const oid = x.layerInfo?.objectIdField;
    return [
      ...(oid ? [{ name: oid, label: 'Object ID' }] : []),
      { name: 'aa_status', label: 'Status' },
      { name: 'aa_gis', label: 'GIS address' },
      ...(x.rows.some(r => r.osm) ? [{ name: 'aa_osm_status', label: 'OpenStreetMap' }, { name: 'aa_osm', label: 'OpenStreetMap address' }, { name: 'aa_osm_d', label: 'Distance (OSM)' }] : []),
      ...(x.rows.some(r => r.google) ? [{ name: 'aa_g_status', label: 'Google' }, { name: 'aa_g', label: 'Google address' }, { name: 'aa_g_d', label: 'Distance (Google)' }] : []),
      { name: 'aa_lat', label: 'Latitude' }, { name: 'aa_lon', label: 'Longitude' },
      { name: 'aa_link', label: 'Google Maps' }
    ];
  }

  function tableRows() {
    const fields = x.layerInfo?.fields ?? [];
    return x.rows.map((r, i) => {
      const cells = {};
      for (const f of fields) { const v = r.f.attributes?.[f.name]; cells[f.name] = cell(v ?? '', v ?? null); }
      Object.assign(cells, {
        aa_status: cell(statusLabel(r.status), r.status),
        aa_gis: cell(r.gis.text),
        aa_osm_status: cell(r.osm ? statusLabel(r.osm.status) : ''),
        aa_osm: cell(r.osm?.candidate?.text ?? '', r.osm?.candidate?.text ?? null, r.osm?.candidate ? osmLink(r.osm.candidate.id) : null),
        aa_osm_d: cell(metres(r.osm?.distance), r.osm?.distance ?? null),
        aa_g_status: cell(r.google ? (r.google.error ? `${statusLabel('error')}: ${r.google.error}` : statusLabel(r.google.status)) : ''),
        aa_g: cell(r.google?.candidate?.text ?? '', r.google?.candidate?.text ?? null),
        aa_g_d: cell(metres(r.google?.distance), r.google?.distance ?? null),
        aa_lat: cell(r.gis.lat.toFixed(6), r.gis.lat), aa_lon: cell(r.gis.lon.toFixed(6), r.gis.lon),
        aa_link: cell('Open', null, googleMapsLink(r.gis.lat, r.gis.lon))
      });
      return { id: i, cells, audit: r };
    });
  }

  function showTable() {
    if (!x.rows.length) return;
    const columns = tableColumns();
    const rows = tableRows();
    const fields = [...(x.layerInfo?.fields ?? [])];
    const choices = exportChoices(columns.filter(c => c.name !== 'aa_link'), fields);
    const layerTitle = x.layerInfo?.title ?? 'Addresses';
    win.show('Address audit', `${layerTitle}: ${n(rows.length)} address${rows.length === 1 ? '' : 'es'} in view`, [{
      title: `Address audit - ${layerTitle}`, columns, rows, total: rows.length,
      exportFields: choices,
      exportAll: async picked => ({ columns: rowsColumns(choices, rows, fields, picked), rows })
    }], open());
  }

  function choose(row) {
    const r = row.audit;
    if (!r) return;
    x.chosen = r;
    map.emphasise(r.geometry, cfg.emphasis, { owner: 'audit', zoom: true });
    render();
  }

  render();
  return {
    destroy() {
      x.gone = true;
      x.running?.abort();
      win.destroy();                     // closes it (clearing its padding) and takes it out of the page
      map.clearAuditResult();
      view.map.remove(marks);
      marks.destroy?.();
    }
  };
}
