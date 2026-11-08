// restServices.js — ArcGIS REST services added on top of the web map (manifest webmap.extraServices):
// reading a pasted REST URL, and which service types a 2D map can show. Pure: no DOM, no SDK, no fetch.

/** Service types the map can draw, with how they're named in lists. */
export const MAP_SERVICE_TYPES = Object.freeze({
  MapServer: 'Map service',
  FeatureServer: 'Feature service',
  ImageServer: 'Image service',
  VectorTileServer: 'Vector tile service'
});
/** Services whose single layers (…/MapServer/3, …/FeatureServer/0) can be added on their own. */
export const LAYER_SERVICE_TYPES = ['MapServer', 'FeatureServer'];

export const isMapServiceType = type => Object.hasOwn(MAP_SERVICE_TYPES, type);

/** Names and addresses that mean aerial photography. Such layers are never queried or listed in Details. */
export const IMAGERY_NAME = /imagery|aerial|ortho|satellite|hybrid/i;
export const isImageryName = (...texts) => IMAGERY_NAME.test(texts.filter(Boolean).join(' '));
/** Map service sublayer types (the service JSON's `type`) that hold pixels, not features: nothing to query. */
export const RASTER_SUBLAYER_TYPES = new Set(['Raster Layer', 'Mosaic Layer']);

/**
 * Read a pasted ArcGIS Server URL. Accepts the services directory (…/rest/services), a folder, a service
 * (…/MapServer) or a layer (…/FeatureServer/0); a bare server address (https://host/arcgis) means its
 * directory. Query strings (and any ?token=) and #fragments are dropped.
 * @returns {{ kind: 'root'|'folder'|'service'|'layer', root, folder, name, type, layerId, url }}
 *   url is the canonical form; name is "Folder/Service"; layerId is a number or null.
 * @throws Error with a sentence people can act on.
 */
export function parseRestUrl(input) {
  const text = String(input ?? '').trim();
  if (!text) throw new Error('Paste an ArcGIS Server address, for example https://gis.example.gov.za/arcgis/rest/services.');
  let u;
  try { u = new URL(text); } catch { throw new Error('That isn\'t a web address. It should start with https://'); }
  if (u.protocol !== 'https:') throw new Error('Use an https:// address. Browsers block http:// services on https sites, and sign-in needs https.');
  if (/\/sharing(\/|$)/i.test(u.pathname) || /\/home(\/|$)/i.test(u.pathname)) {
    throw new Error('That is a portal address. Paste the ArcGIS Server address instead (…/arcgis/rest/services or …/server/rest/services).');
  }

  let path = u.pathname.replace(/\/+$/, '');
  const at = path.search(/\/rest\/services(\/|$)/i);
  if (at < 0) path = /\/rest$/i.test(path) ? `${path}/services` : `${path}/rest/services`;
  const base = path.slice(0, path.search(/\/rest\/services(\/|$)/i));
  const root = `${u.origin}${base}/rest/services`;
  const segs = path.slice(base.length + '/rest/services'.length).split('/').filter(Boolean).map(decodeURIComponent);

  const typeAt = segs.findIndex(s => /^[A-Za-z]+Server$/.test(s) || KNOWN_TYPES.some(k => k.toLowerCase() === s.toLowerCase()));
  if (typeAt < 0) {
    const folder = segs.join('/');
    return { kind: folder ? 'folder' : 'root', root, folder, name: '', type: '', layerId: null, url: folder ? `${root}/${encodePath(folder)}` : root };
  }
  if (typeAt === 0) throw new Error('That address names a service type but no service.');
  const name = segs.slice(0, typeAt).join('/');
  const type = canonicalType(segs[typeAt]);
  const folder = segs.slice(0, typeAt - 1).join('/');
  const serviceUrl = `${root}/${encodePath(name)}/${type}`;
  const rest = segs.slice(typeAt + 1);
  if (rest.length && /^\d+$/.test(rest[0])) {
    return { kind: 'layer', root, folder, name, type, layerId: Number(rest[0]), url: `${serviceUrl}/${rest[0]}` };
  }
  return { kind: 'service', root, folder, name, type, layerId: null, url: serviceUrl };
}

const encodePath = p => p.split('/').map(encodeURIComponent).join('/');
const KNOWN_TYPES = [...Object.keys(MAP_SERVICE_TYPES), 'GPServer', 'GeocodeServer', 'GeometryServer', 'NAServer', 'SceneServer', 'GeoDataServer', 'GlobeServer', 'MobileServer', 'SchematicsServer', 'StreamServer'];
const canonicalType = t => KNOWN_TYPES.find(k => k.toLowerCase() === t.toLowerCase()) ?? t;

/** Can the map show this URL as an added service? Returns null when it can, or the reason it can't. */
export function whyNotAddable(url) {
  let p;
  try { p = parseRestUrl(url); } catch (e) { return e.message; }
  if (p.kind === 'root' || p.kind === 'folder') return 'That is a services directory or folder. List it, then add a service from it.';
  if (!isMapServiceType(p.type)) return `A ${p.type} isn't a map layer. Add a map, feature, image or vector tile service.`;
  if (p.kind === 'layer' && !LAYER_SERVICE_TYPES.includes(p.type)) return `Single layers can only be added from map and feature services, not a ${p.type}.`;
  return null;
}

/** "Folder/Name" -> "Name" (catalog entries carry their folder in the name). */
export const shortName = name => String(name ?? '').split('/').pop();

/**
 * A services directory or folder response (…/rest/services?f=json) as lists people can browse.
 * @returns {{ folders: [{ name, url }], services: [{ name, title, type, label, url }], others: number }}
 *   others counts services the map can't show (geoprocessing, geocoding…).
 */
export function readCatalog(json, root) {
  const folders = (json?.folders ?? []).filter(f => typeof f === 'string' && f)
    .map(f => ({ name: f, url: `${root}/${encodePath(f)}` }));
  const all = (json?.services ?? []).filter(s => s?.name && s?.type);
  const services = all.filter(s => isMapServiceType(s.type)).map(s => ({
    name: s.name, title: shortName(s.name), type: s.type, label: MAP_SERVICE_TYPES[s.type],
    url: `${root}/${encodePath(s.name)}/${s.type}`
  })).sort((a, b) => a.title.localeCompare(b.title, 'en', { numeric: true, sensitivity: 'base' }));
  return { folders, services, others: all.length - services.length };
}

/**
 * The layers of a map or feature service (…?f=json), for adding one on its own. Group layers are left
 * out (they hold no features); tables too (nothing to draw); raster and mosaic layers too (nothing to query).
 * @returns [{ id, name, url, path: [group names] }]
 */
export function readServiceLayers(info, serviceUrl) {
  const byId = new Map((info?.layers ?? []).map(l => [l.id, l]));
  const pathOf = l => { const out = []; let p = byId.get(l.parentLayerId); while (p) { out.unshift(p.name); p = byId.get(p.parentLayerId); } return out; };
  return (info?.layers ?? [])
    .filter(l => Number.isInteger(l.id) && !l.subLayerIds?.length && l.type !== 'Group Layer' && !RASTER_SUBLAYER_TYPES.has(l.type))
    .map(l => ({ id: l.id, name: l.name || `Layer ${l.id}`, url: `${serviceUrl}/${l.id}`, path: pathOf(l) }));
}

/** A title for an added service: the layer's or service's own name. */
export function defaultTitle(url, info) {
  const p = parseRestUrl(url);
  return (p.kind === 'layer' ? info?.name : info?.documentInfo?.Title || info?.mapName || info?.name) || shortName(p.name) || 'Added service';
}

/** Check one manifest webmap.extraServices list. Returns error sentences (empty when fine). */
export function checkExtraServices(list) {
  if (list == null) return [];
  if (!Array.isArray(list)) return ['webmap.extraServices must be a list.'];
  const errors = [];
  const ids = new Set();
  list.forEach((s, i) => {
    const at = `ArcGIS REST service ${i + 1}${s?.title ? ` ("${s.title}")` : ''}`;
    if (!s || typeof s !== 'object') { errors.push(`${at} must be an object.`); return; }
    if (typeof s.id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(s.id)) errors.push(`${at}: id must be letters, numbers, - or _.`);
    else if (ids.has(s.id)) errors.push(`${at}: id "${s.id}" is used twice.`);
    else ids.add(s.id);
    if (typeof s.url !== 'string') { errors.push(`${at}: url is missing.`); return; }
    if (/[?#]/.test(s.url)) errors.push(`${at}: the url must not carry a query string (no ?token=…).`);
    const why = whyNotAddable(s.url);
    if (why) errors.push(`${at}: ${why}`);
    if (s.title != null && typeof s.title !== 'string') errors.push(`${at}: title must be text.`);
    if (s.visible != null && typeof s.visible !== 'boolean') errors.push(`${at}: visible must be true or false.`);
    if (s.access != null && !SERVICE_ACCESS.includes(s.access)) errors.push(`${at}: access must be "everyone" or "groups".`);
    if (s.groupIds != null) {
      if (!Array.isArray(s.groupIds) || s.groupIds.some(g => typeof g !== 'string' || !GROUP_ID.test(g))) errors.push(`${at}: each group must be a 32-character group id.`);
      else if (new Set(s.groupIds.map(g => g.toLowerCase())).size !== s.groupIds.length) errors.push(`${at}: the same group is listed twice.`);
    }
    if (s.access === 'groups' && !(Array.isArray(s.groupIds) && s.groupIds.length)) errors.push(`${at}: add at least one group, or let everyone see it.`);
  });
  return errors;
}

/** Warnings for a webmap.extraServices list: group-only services still have their address in manifest.json. */
export function extraServicesWarnings(list) {
  if (!Array.isArray(list)) return [];
  return list.filter(s => s?.access === 'groups').map(s => `ArcGIS REST service "${s.title || s.url}" is hidden from people outside its groups, but its address is in manifest.json. Share the service only with the group on its server too.`);
}

/* ---------------- Who sees a service ---------------- */

/** webmap.extraServices[].access: everyone, or only members of any of its groupIds. */
export const SERVICE_ACCESS = ['everyone', 'groups'];
const GROUP_ID = /^[0-9a-f]{32}$/i;

/**
 * May this person see the service? Group-only services are for signed-in members of any of their groups.
 * @param self     the portal's community/self answer (username and groups when signed in), or null
 * @param service  one webmap.extraServices entry
 * @returns { allowed, reason: 'open' | 'member' | 'signed-out' | 'not-member' }
 */
export function serviceAccess(self, service) {
  if (service?.access !== 'groups') return { allowed: true, reason: 'open' };
  if (!self?.username) return { allowed: false, reason: 'signed-out' };
  const wanted = new Set((service.groupIds ?? []).map(g => String(g).toLowerCase()));
  const member = (self.groups ?? []).some(g => wanted.has(String(g?.id ?? '').toLowerCase()));
  return { allowed: member, reason: member ? 'member' : 'not-member' };
}

/** Ids of the services this person mustn't see (the viewer leaves them out without a word). */
export const hiddenServiceIds = (services, self) => new Set((services ?? []).filter(s => !serviceAccess(self, s).allowed).map(s => s.id));

/** Is this layer key ("<id>" or "<id>:<layerId>") one of these services' layers? */
export const isServiceLayerKey = (key, ids) => {
  const k = String(key ?? '');
  for (const id of ids ?? []) if (k === id || k.startsWith(`${id}:`)) return true;
  return false;
};

/** Does any service need a membership check? */
export const hasGroupOnlyServices = services => (services ?? []).some(s => s?.access === 'groups');
