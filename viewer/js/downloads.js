// downloads.js — the Downloads widget's pure helpers: the kinds of source a download page lists from, checking a
// source's settings, reading ArcGIS Instant App and Hub site addresses, and turning each source's answer into the rows
// of the window's table. No DOM, no SDK, no fetching (downloadsLoad.js fetches).
//
// Sources:
//   instantApp    any Instant App that lists a group's (or a folder's) content, e.g. Filter Gallery: its appid item's
//                 settings name the group; the group's items are listed. The app itself is never linked to.
//   hubSite       an ArcGIS Hub site (open data portal): its catalog's groups are listed.
//   featureTable  an ArcGIS layer or table with a name and a link field (and optionally a count, type and date).
//   jsonApi       any JSON API (CKAN, Socrata, your own): a dotted path to the list and which fields to show.
//   manual        names and links typed in settings.
// ArcGIS items have no download counter: their count is numViews, which counts item-page views and file downloads.
import { addressProblem } from './streams.js';

export const SOURCE_KINDS = [
  ['instantApp', 'ArcGIS Instant App (Filter Gallery and other galleries)'],
  ['hubSite', 'ArcGIS Hub site (open data)'],
  ['featureTable', 'ArcGIS feature layer or table'],
  ['jsonApi', 'JSON API (CKAN, Socrata or your own)'],
  ['manual', 'A list typed here']
];
export const isSourceKind = id => SOURCE_KINDS.some(([k]) => k === id);
export const DOWNLOAD_WIDTHS = [['half', 'Half: beside the map'], ['full', 'Full: over the map and the panel']];
export const isDownloadWidth = id => DOWNLOAD_WIDTHS.some(([w]) => w === id);

export const DOWNLOAD_PAGES_MAX = 20;
export const DOWNLOAD_ROWS_MAX = 1000;     // most items one page lists
export const MANUAL_ITEMS_MAX = 200;
/** The fields a featureTable or jsonApi source maps: [key, label, required]. */
export const SOURCE_FIELDS = [['name', 'Name', true], ['link', 'Link (download address)', true], ['count', 'Download count', false], ['type', 'Type', false], ['date', 'Date', false]];

/** The count column's heading when the author didn't write one. */
export const defaultCountLabel = kind => (kind === 'instantApp' || kind === 'hubSite' ? 'Views / downloads' : 'Downloads');
export const COUNT_NOTE = 'ArcGIS counts views of the item and downloads of its file together; it has no separate download count.';

/** Field-mapping presets for well-known open data APIs (jsonApi). */
export const JSON_PRESETS = [
  ['ckan', 'CKAN (…/api/3/action/package_search)', { listPath: 'result.results', fields: { name: 'title', link: 'resources.0.url', count: 'tracking_summary.total', type: 'resources.0.format', date: 'metadata_modified' } }],
  ['socrata', 'Socrata (…/api/views.json)', { listPath: '', fields: { name: 'name', link: 'id', count: 'downloadCount', type: 'viewType', date: 'rowsUpdatedAt' } }]
];

const ID32 = /^[0-9a-f]{32}$/i;
const FIELD_PATH = /^[\w$-]+(\.[\w$-]+)*$/;
const FIELD_NAME = /^[A-Za-z_][\w.]*$/;

/* ---------- Addresses ---------- */
const parse = url => { try { return new URL(String(url ?? '').trim()); } catch { return null; } };

/**
 * An Instant App's portal and item: { portalUrl, appId }, or null. Any /apps/<template>/…?appid= address
 * (/apps/instant/filtergallery/index.html?appid=…, /apps/instant/minimalist/…), on ArcGIS Online or Enterprise
 * (https://host/portal/apps/…: the portal is the part before /apps/).
 */
export function instantAppItem(url) {
  const u = parse(url);
  if (!u) return null;
  const i = u.pathname.toLowerCase().indexOf('/apps/');
  const id = u.searchParams.get('appid') ?? u.searchParams.get('appId') ?? u.searchParams.get('id');
  return i >= 0 && ID32.test(id ?? '') ? { portalUrl: `${u.origin}${u.pathname.slice(0, i)}`, appId: id.toLowerCase() } : null;
}

/** A portal group page's portal and group: …/home/group.html?id=… → { portalUrl, groupId }, or null. */
export function groupPageItem(url) {
  const u = parse(url);
  if (!u) return null;
  const i = u.pathname.toLowerCase().indexOf('/home/group.html');
  const id = u.searchParams.get('id');
  return i >= 0 && ID32.test(id ?? '') ? { portalUrl: `${u.origin}${u.pathname.slice(0, i)}`, groupId: id.toLowerCase() } : null;
}

/** What an Instant App lists, from its item's settings (data.values): { group } | { folderId, owner } | { problem }. */
export function gallerySearch(appData, owner = '') {
  const v = appData?.values ?? {};
  const group = [v.group, ...(Array.isArray(v.groups) ? v.groups : [])].find(g => ID32.test(String(g ?? '')));
  if (group) return { group: String(group).toLowerCase() };
  if (ID32.test(String(v.folderId ?? '')) && owner) return { folderId: v.folderId, owner };
  return { problem: 'This Instant App doesn\'t list content from a group or a folder, so it can\'t be used as a download page. Use a gallery app such as Filter Gallery.' };
}

/** Is this an ArcGIS Hub site's address (…hub.arcgis.com, or a custom domain we can't tell)? Only hub.arcgis.com sites are recognised. */
export function isHubSite(url) {
  const u = parse(url);
  return Boolean(u) && /\.hub\.arcgis\.com$/i.test(u.hostname);
}

/** A Hub site's catalog groups, from the site item's data (catalog.groups, or the newer catalogV2 filters). */
export function hubCatalogGroups(siteData) {
  const found = new Set();
  for (const g of siteData?.catalog?.groups ?? []) if (ID32.test(String(g))) found.add(String(g).toLowerCase());
  const walk = node => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach(walk); return; }
    for (const [k, v] of Object.entries(node)) {
      if (k === 'group') [].concat(v?.any ?? v?.all ?? v).forEach(g => { if (ID32.test(String(g))) found.add(String(g).toLowerCase()); });
      else walk(v);
    }
  };
  walk(siteData?.catalogV2?.scopes?.item);
  return [...found];
}

/** The portal of a Hub site's organisation (from the Hub domain lookup: { orgKey, siteId }). */
export const hubPortalUrl = domain => (domain?.orgKey && /^[\w-]+$/.test(domain.orgKey) ? `https://${domain.orgKey}.maps.arcgis.com` : 'https://www.arcgis.com');

/** Why this source can't be listed from a published viewer, or '' when it can. */
export function sourceProblem(source) {
  const s = source ?? {};
  if (!isSourceKind(s.kind)) return 'Choose where the list comes from.';
  if (s.kind === 'manual') {
    const items = Array.isArray(s.items) ? s.items : [];
    if (!items.length) return 'Add at least one item.';
    if (items.length > MANUAL_ITEMS_MAX) return `At most ${MANUAL_ITEMS_MAX} items.`;
    for (const [i, it] of items.entries()) {
      if (!String(it?.name ?? '').trim()) return `Item ${i + 1}: give it a name.`;
      const p = addressProblem(it?.url, { noun: 'file' });
      if (p) return `Item ${i + 1} (${it.name}): ${String(it?.url ?? '').trim() ? p : 'Enter its address.'}`;
    }
    return '';
  }
  const url = String(s.url ?? '').trim();
  if (!url) return 'Enter the address.';
  const problem = addressProblem(url, { noun: 'list' });
  if (problem) return problem;
  if (s.kind === 'instantApp' && !instantAppItem(url) && !groupPageItem(url)) return 'This isn\'t an Instant App address with ?appid= (or a portal group page). Copy it from the app\'s address bar.';
  if (s.kind === 'hubSite' && !isHubSite(url)) return 'Use the Hub site\'s …hub.arcgis.com address.';
  if (s.kind === 'featureTable' && !/\/(MapServer|FeatureServer)\/\d+\/?$/i.test(parse(url)?.pathname ?? '')) return 'Use a layer or table address ending in /MapServer/<n> or /FeatureServer/<n>.';
  if (s.kind === 'featureTable' || s.kind === 'jsonApi') {
    const ok = s.kind === 'featureTable' ? FIELD_NAME : FIELD_PATH;
    for (const [key, label, required] of SOURCE_FIELDS) {
      const f = String(s.fields?.[key] ?? '').trim();
      if (required && !f) return `Choose the ${label.toLowerCase()} field.`;
      if (f && !ok.test(f)) return `The ${label.toLowerCase()} field "${f}" isn't a valid ${s.kind === 'jsonApi' ? 'path (e.g. resources.0.url)' : 'field name'}.`;
    }
    if (s.kind === 'jsonApi' && s.listPath && !FIELD_PATH.test(s.listPath)) return `"${s.listPath}" isn't a valid path to the list (e.g. result.results).`;
  }
  return '';
}

/* ---------- Rows ---------- */

/** Only http and https links reach the table (a JSON API can't hand people a javascript: link). */
export function safeLink(url, base = '') {
  const text = String(url ?? '').trim();
  if (!text) return '';
  try {
    const u = base ? new URL(text, base) : new URL(text);
    return /^https?:$/.test(u.protocol) ? u.href : '';
  } catch { return ''; }
}

/** A dotted path into an object: get({ a: [{ b: 1 }] }, 'a.0.b') === 1. '' = the object itself. */
export function getPath(obj, path) {
  if (!path) return obj;
  return String(path).split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

/** Item types whose file is downloaded straight from the item (…/data). */
const FILE_TYPES = new Set([
  'PDF', 'Microsoft Word', 'Microsoft Excel', 'Microsoft PowerPoint', 'Microsoft Visio', 'CSV', 'Image', 'Shapefile', 'File Geodatabase',
  'KML', 'KML Collection', 'GeoJson', 'GeoPackage', 'CAD Drawing', 'Code Attachment', 'Desktop Application', 'Layer Package', 'Map Package',
  'Tile Package', 'Vector Tile Package', 'Mobile Map Package', 'Project Package', 'Raster', 'Image Collection', 'Visio Document', 'iWork Keynote',
  'iWork Pages', 'iWork Numbers', 'Report Template', 'Statistical Data Collection', 'Geoprocessing Package', 'Scene Package'
]);

/**
 * Where a portal item's name links: its file (…/sharing/rest/content/items/<id>/data) for file items, a Document
 * Link's own address, a Hub dataset's page on the site, else the item's page. Never an Instant App's address.
 */
export function itemLink(item, portalUrl, hubSite = '') {
  const base = String(portalUrl ?? '').replace(/\/+$/, '');
  if (FILE_TYPES.has(item?.type)) return `${base}/sharing/rest/content/items/${item.id}/data`;
  if (item?.type === 'Document Link') { const own = safeLink(item.url); if (own) return own; }
  if (hubSite) return `${String(hubSite).replace(/\/+$/, '')}/datasets/${item.id}`;
  return `${base}/home/item.html?id=${item.id}`;
}

const toNumber = v => (v == null || v === '' ? null : Number.isFinite(Number(v)) ? Number(v) : null);
/** A date as milliseconds: epoch ms (ArcGIS), epoch seconds (Socrata) or an ISO / date text. */
export function toTime(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return v < 1e11 ? v * 1000 : v;
  const t = Date.parse(String(v));
  return Number.isFinite(t) ? t : null;
}

/** Portal search results → rows. The Instant App the list came from (skipId) is left out. */
export function rowsFromPortalItems(results, portalUrl, { hubSite = '', skipId = '' } = {}) {
  return (results ?? []).filter(it => it?.id && it.id !== skipId).map(it => ({
    id: it.id,
    name: it.title || it.name || it.id,
    link: itemLink(it, portalUrl, hubSite),
    type: it.type ?? '',
    count: toNumber(it.numViews),
    created: toTime(it.created),
    modified: toTime(it.modified)
  }));
}

/** One mapped record (feature attributes or a JSON object) → a row. linkBase resolves relative links. */
function mappedRow(rec, fields, i, read, linkBase) {
  const val = key => (fields?.[key] ? read(rec, fields[key]) : undefined);
  const name = val('name');
  return {
    id: String(i),
    name: name == null || name === '' ? `Item ${i + 1}` : String(name),
    link: safeLink(val('link'), linkBase),
    type: val('type') == null ? '' : String(val('type')),
    count: toNumber(val('count')),
    created: null,
    modified: toTime(val('date'))
  };
}

/** ArcGIS query features → rows. */
export const rowsFromFeatures = (features, fields) =>
  (features ?? []).map((f, i) => mappedRow(f?.attributes ?? {}, fields, i, (a, k) => a[k] ?? a[Object.keys(a).find(n => n.toLowerCase() === k.toLowerCase())], ''));

/**
 * A JSON API's answer → rows: listPath points at the array (root when ''), fields hold dotted paths in each record.
 * Throws when listPath doesn't lead to a list. A Socrata link that's just a dataset id becomes its CSV export.
 */
export function rowsFromJson(json, listPath, fields, apiUrl = '') {
  const list = getPath(json, listPath);
  if (!Array.isArray(list)) throw new Error(listPath ? `"${listPath}" in the answer isn't a list.` : 'The answer isn\'t a list. Set the path to the list (e.g. result.results).');
  const origin = parse(apiUrl)?.origin ?? '';
  return list.map((rec, i) => {
    const row = mappedRow(rec, fields, i, getPath, apiUrl);
    const raw = getPath(rec, fields?.link);
    if (origin && /^[a-z0-9]{4}-[a-z0-9]{4}$/.test(String(raw ?? ''))) row.link = `${origin}/api/views/${raw}/rows.csv?accessType=DOWNLOAD`;
    return row;
  });
}

/** Items typed in settings → rows (in the author's order; no count). */
export const rowsFromManual = items => (items ?? []).map((it, i) => ({
  id: String(i), name: String(it?.name ?? '').trim() || `Item ${i + 1}`, link: safeLink(it?.url), type: String(it?.type ?? ''), count: null, created: null, modified: null
}));

/* ---------- The table ---------- */
const DATE = new Intl.DateTimeFormat('en-ZA', { year: 'numeric', month: 'short', day: 'numeric' });
const formatDate = t => (t == null ? '' : DATE.format(new Date(t)));

/**
 * Rows → dataTable's { columns, rows }. Columns without a value in any row are left out. Created, when there is one,
 * makes the table open newest first (the grid convention); a manual list keeps the author's order.
 */
export function downloadTable(rows, { countLabel = 'Downloads', locale = 'en-US' } = {}) {
  const any = k => rows.some(r => r[k] != null && r[k] !== '');
  const columns = [
    { name: 'name', label: 'Name' },
    any('type') && { name: 'type', label: 'Type' },
    any('count') && { name: 'count', label: countLabel },
    any('created') && { name: 'created', label: 'Created' },
    any('modified') && { name: 'modified', label: 'Modified' }
  ].filter(Boolean);
  return {
    columns,
    rows: rows.map(r => ({
      id: r.id,
      cells: {
        name: { text: r.name, raw: r.name, href: r.link || undefined },
        type: { text: r.type || '—', raw: r.type || null },
        count: { text: r.count == null ? '—' : r.count.toLocaleString(locale), raw: r.count },
        created: { text: formatDate(r.created) || '—', raw: r.created },
        modified: { text: formatDate(r.modified) || '—', raw: r.modified }
      }
    }))
  };
}

/** The rows people's filter text matches (name or type, any case). */
export function filterRows(rows, text) {
  const q = String(text ?? '').trim().toLowerCase();
  return q ? rows.filter(r => `${r.name} ${r.type}`.toLowerCase().includes(q)) : rows;
}

/** "1 item", "22 items". */
export const itemCount = n => `${n.toLocaleString('en-US')} item${n === 1 ? '' : 's'}`;

/** A short line about where a page's list comes from, for its card and the settings. */
export function sourceHost(source) {
  if (source?.kind === 'manual') return `${itemCount((source.items ?? []).length)} listed here`;
  try { return new URL(String(source?.url ?? '').trim()).hostname; } catch { return ''; }
}
