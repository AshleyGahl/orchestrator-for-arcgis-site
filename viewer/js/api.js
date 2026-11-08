// api.js — every fetch() in the app: portal items, ArcGIS Server REST, table queries,
// enrichment APIs, manifest files and Streaming's tracking feeds.
import { CONFIG } from './config.js';
import { targetFor, credentialFor, tokenAllowed, AuthRequiredError, windowsHosts, answersWithWindowsIdentity } from './auth.js';

const cache = new Map();
export const cleanUrl = url => url.trim().split('?')[0].replace(/\/+$/, '');

const AUTH_CODES = new Set([498, 499]);           // invalid / missing token

/**
 * GET JSON. For ArcGIS requests a token is added when the user has signed in to that server, and a
 * "token required" / "no permission while signed out" answer becomes an AuthRequiredError naming
 * where to sign in. fresh: never answer from the browser's cache (a feed that changes every few seconds).
 * anonymous: send no token (the retry when another ArcGIS Online organisation refuses ours).
 */
async function getJson(url, { arcgis = true, params = {}, form = null, fresh = false, anonymous = false } = {}) {
  const u = new URL(url, location.href);
  if (arcgis) u.searchParams.set('f', 'json');
  for (const [k, v] of Object.entries(params)) if (v != null && v !== '') u.searchParams.set(k, v);

  const target = arcgis ? await targetFor(u.href) : null;
  // A server names its own token service, so a sign-in only goes to the addresses it was issued for (urlTrust.js).
  const signedIn = anonymous ? null : credentialFor(target);
  const cred = signedIn && tokenAllowed(signedIn, u.href) ? signedIn : null;
  const withheld = Boolean(signedIn && !cred);
  if (cred?.token) {
    if (form) form.set('token', cred.token);            // POSTs carry the token in the body, not the URL
    else u.searchParams.set('token', cred.token);
  }
  // Windows (web-tier) sign-in: let the browser send the network identity to that server.
  const sendIdentity = u.origin === location.origin || (cred?.windows ?? false) || windowsHosts().includes(u.host);

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), CONFIG.requestTimeoutMs);
  let res, json;
  try {
    res = await fetch(u, { method: form ? 'POST' : 'GET', body: form ?? undefined, signal: ctrl.signal, credentials: sendIdentity ? 'include' : 'omit', cache: fresh ? 'no-store' : 'default' });
    json = await res.json().catch(() => null);
  } catch (e) {
    if (e.name === 'AbortError') throw new Error(`Timed out after ${CONFIG.requestTimeoutMs / 1000}s: ${u.pathname}`);
    if (target && !sendIdentity && !withheld && await answersWithWindowsIdentity(u.href)) {
      throw new AuthRequiredError({ ...target, windows: true }, `${target.label} uses Windows sign-in (your network account). Sign in to use it.`);
    }
    throw new Error(`Couldn't reach ${u.host}. Check the URL, and that the server allows CORS from this site.`);
  } finally {
    clearTimeout(timer);
  }

  const code = json?.error?.code ?? (res.ok ? null : res.status);
  // An ArcGIS Online token only works in its own organisation: another org's portal (<org>.maps.arcgis.com, such as a
  // Hub site's) refuses it with 403 "User not allowed for this account", even for public items. Ask again without it.
  if (cred?.token && code === 403 && /not allowed for this account/i.test(json?.error?.message ?? '')) {
    form?.delete('token');
    return getJson(url, { arcgis, params, form, fresh, anonymous: true });
  }
  if (arcgis && target && (AUTH_CODES.has(code) || ((code === 403 || code === 401) && !cred))) {
    if (withheld) throw new Error(`${u.host} asks for your ${target.label} sign-in, but it isn't one of ${target.label}'s own addresses, so your sign-in isn't sent there. If it's an ArcGIS Server federated with your portal, add its host to federatedHosts in config.js.`);
    throw new AuthRequiredError(target, cred
      ? `Your sign-in to ${target.label} has expired. Sign in again.`
      : `This is secured. Sign in to ${target.label} to use it.`);
  }
  if (arcgis && json?.error) throw new Error(`${json.error.code}: ${json.error.message}`);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}: ${u.pathname}`);
  return json;
}

/** Forget cached service metadata (after signing in, so secured services are read again). */
export function clearCache() { cache.clear(); }

function cached(key, load) {
  if (!cache.has(key)) cache.set(key, load().catch(e => { cache.delete(key); throw e; }));
  return cache.get(key);
}

/* ---------- Portal ---------- */
const sharing = portalUrl => `${cleanUrl(portalUrl)}/sharing/rest`;
export const getPortalItem     = (portalUrl, id) => getJson(`${sharing(portalUrl)}/content/items/${id}`);
export const getPortalItemData = (portalUrl, id) => getJson(`${sharing(portalUrl)}/content/items/${id}/data`);
export const portalItemPage    = (portalUrl, id) => `${cleanUrl(portalUrl)}/home/item.html?id=${id}`;
export const portalGroupPage   = (portalUrl, id) => `${cleanUrl(portalUrl)}/home/group.html?id=${id}`;
export const getPortalSelf     = portalUrl => cached(`self:${cleanUrl(portalUrl)}`, () => getJson(`${sharing(portalUrl)}/portals/self`));
export const getGroup          = (portalUrl, id) => getJson(`${sharing(portalUrl)}/community/groups/${id}`);
/** The signed-in person (username, groups) as the portal sees them; never cached, so a membership change counts. */
export const getSelf           = portalUrl => getJson(`${sharing(portalUrl)}/community/self`);

/** Portal item search (q built by query.portalItemQuery). Returns { total, nextStart, results }; nextStart is -1 at the end. */
export const searchItems = (portalUrl, { q, start = 1, num = CONFIG.addDataPageSize }) =>
  getJson(`${sharing(portalUrl)}/search`, { params: { q, start, num, sortField: 'title', sortOrder: 'asc' } });

/**
 * Convert a zipped shapefile to a feature collection with the portal's generate operation (the browser can't
 * read shapefiles itself). The file goes to the portal for conversion only; nothing is saved there.
 */
export function generateFeatures(portalUrl, file, { maxRecords = 4000 } = {}) {
  const form = new FormData();
  form.set('filetype', 'shapefile');
  form.set('publishParameters', JSON.stringify({ name: file.name.replace(/\.zip$/i, ''), targetSR: { wkid: 102100 }, maxRecordCount: maxRecords, enforceInputFileSizeLimit: true, enforceOutputJsonSizeLimit: true }));
  form.set('f', 'json');
  form.set('file', file, file.name);
  return getJson(`${sharing(portalUrl)}/content/features/generate`, { form, arcgis: true });
}

/* ---------- ArcGIS Server REST ---------- */
export const getServiceInfo = url => cached(`info:${cleanUrl(url)}`, () => getJson(cleanUrl(url)));
/** An ImageServer's key properties (BandProperties: each band's name and wavelengths), for Vegetation health. */
export const getImageKeyProperties = url => cached(`keyprops:${cleanUrl(url)}`, () => getJson(`${cleanUrl(url)}/keyProperties`));

/** How many features a layer holds (the Scene settings warn when a layer is large for 3D). */
export const countFeatures = url => cached(`count:${cleanUrl(url)}`,
  () => getJson(`${cleanUrl(url)}/query`, { params: { where: '1=1', returnCountOnly: 'true' } }).then(r => r.count ?? null));

/** A statistics query on a layer (Legend labels: Test); params are REST …/query parameters. */
export const queryStatistics = (url, params) => getJson(`${cleanUrl(url)}/query`, { params, fresh: true });

/** An attribute query on a layer (Attribute trace: Test in settings); params are REST …/query parameters. */
export const queryLayer = (url, params) => getJson(`${cleanUrl(url)}/query`, { params, fresh: true });

const SKIP_FIELD_TYPES =new Set(['esriFieldTypeGeometry', 'esriFieldTypeBlob', 'esriFieldTypeRaster', 'esriFieldTypeXML']);

/** Attribute fields of one layer or table (…/MapServer/n or …/FeatureServer/n), or a geocoding service's result fields. */
export async function getFields(layerUrl) {
  const info = await getServiceInfo(layerUrl);
  return (info.fields ?? info.candidateFields ?? [])      // a geocoding service lists what each result carries
    .filter(f => !SKIP_FIELD_TYPES.has(f.type))
    .map(f => ({ name: f.name, alias: f.alias || f.name, type: f.type }));
}

/** Attribute query against a layer or standalone table (used for 1:m Details sections). */
/** A query the server refused, with the where clause that was sent (shown to help fix the setup). */
export class QueryError extends Error {
  constructor(message, where) { super(message); this.name = 'QueryError'; this.where = where; }
}

/**
 * Attribute query against a layer or standalone table (used for 1:m Details sections).
 * Reads the layer's capabilities first and only asks for what it supports: a record limit only with
 * paging support, a sort only with order-by support. If the server still refuses, it retries with the
 * plainest possible query, then sorts and trims in the browser.
 * @returns { features, fields, exceededTransferLimit, notes: [] }
 */
export async function queryTable(url, { where, outFields = '*', orderByFields = '', max = CONFIG.sectionMaxRows }) {
  const base = cleanUrl(url);
  const info = await getServiceInfo(base).catch(e => { if (e instanceof AuthRequiredError) throw e; return null; });
  const notes = [];

  if (info?.type === 'Group Layer') {
    const subs = (info.subLayers ?? []).map(s => `${s.id} (${s.name})`).join(', ');
    throw new QueryError(`Layer ${info.id ?? ''} "${info.name}" is a group layer and holds no records.${subs ? ` Use one of its sublayers: ${subs}.` : ''}`, where);
  }
  if (info?.capabilities && !/query/i.test(info.capabilities)) {
    throw new QueryError(`"${info.name}" doesn't allow queries (its Query capability is switched off on the server).`, where);
  }

  const adv = info?.advancedQueryCapabilities ?? {};
  const canPage = adv.supportsPagination === true;
  const canSort = adv.supportsOrderBy === true || (adv.supportsOrderBy == null && info?.supportsAdvancedQueries === true);
  const params = { where, outFields, returnGeometry: 'false' };
  if (canPage) params.resultRecordCount = String(max);
  if (orderByFields && canSort) params.orderByFields = orderByFields;

  let res;
  try {
    res = await getJson(`${base}/query`, { params });
  } catch (first) {
    if (first instanceof AuthRequiredError) throw first;
    try {
      res = await getJson(`${base}/query`, { params: { where, outFields: '*', returnGeometry: 'false' } });
      notes.push('The server refused the full query, so a plain one was used.');
    } catch (second) {
      if (second instanceof AuthRequiredError) throw second;
      throw new QueryError(second.message, where);
    }
  }

  // Sort / limit in the browser when the server couldn't.
  let features = res.features ?? [];
  if (orderByFields && !params.orderByFields) {
    const [field, dir = 'ASC'] = orderByFields.trim().split(/\s+/);
    const sign = /desc/i.test(dir) ? -1 : 1;
    features = [...features].sort((a, b) => {
      const x = a.attributes?.[field], y = b.attributes?.[field];
      if (x == null) return 1; if (y == null) return -1;
      return (typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y), 'en-ZA', { numeric: true })) * sign;
    });
  }
  const exceeded = res.exceededTransferLimit === true || features.length > max;
  return { ...res, features: features.slice(0, max), exceededTransferLimit: exceeded, notes, info };
}

/* ---------- Other ---------- */
export const getJsonFromUrl  = url => getJson(url, { arcgis: false });
/** Streaming, Tracking: one answer of a GeoJSON or JSON feed, never from the cache. */
export const getFeed         = url => getJson(url, { arcgis: false, fresh: true });
export const getManifestFile = url => getJson(url, { arcgis: false });
/** authoring.json (who may author viewers), read fresh so a change on the server counts at once. */
export const getAuthoringFile = url => getJson(url, { arcgis: false, fresh: true });
