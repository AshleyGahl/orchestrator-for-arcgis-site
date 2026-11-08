// tracking.js — the Streaming widget's Tracking section, pure helpers: the kinds of feed (an ArcGIS stream service, an
// ArcGIS feature layer, GeoJSON, or any JSON with a latitude and a longitude), checking and recognising feed addresses,
// reading positions out of a GeoJSON or JSON answer (with dotted paths such as "attributes.latitude"), guessing those
// paths from a sample answer, keeping each object's recent track, and the public demo feeds. No DOM, no SDK.
import { addressProblem, isLonLat } from './streams.js';

export const TRACK_KINDS = [
  ['stream', 'ArcGIS stream service (live, pushed to the map)'],
  ['feature', 'ArcGIS feature layer, refreshed'],
  ['geojson', 'GeoJSON, refreshed'],
  ['json', 'JSON with latitude and longitude, refreshed']
];
export const isTrackKind = id => TRACK_KINDS.some(([k]) => k === id);
/** Kinds the viewer fetches itself on a timer (the SDK refreshes feature layers and receives stream services). */
export const isPolled = kind => kind === 'geojson' || kind === 'json';
/** Kinds that keep each object's recent positions as a line behind it. */
export const hasTrail = kind => kind !== 'feature';

export const FEEDS_MAX = 20;
export const TRAIL_MAX = 100;            // earlier positions kept per object
export const OBJECTS_MAX = 5000;         // objects drawn per feed
export const TRACK_REFRESH_MIN_S = 2;
export const TRACK_REFRESH_MAX_S = 3600;

/** Colours for feeds without their own, in order (readable on light and dark basemaps, distinct from each other). */
export const TRACK_COLORS = ['#D9480F', '#1971C2', '#2F9E44', '#9C36B5', '#E67700', '#C2255C', '#0C8599', '#5C940D'];
export const feedColor = (feed, index = 0) => (/^#[0-9a-f]{6}$/i.test(feed?.color || '') ? feed.color : TRACK_COLORS[index % TRACK_COLORS.length]);

const parse = url => { try { return new URL(String(url ?? '').trim()); } catch { return null; } };

/** What kind of feed an address is, worked out from its shape; null when it can't be told (the author chooses). */
export function detectTrackKind(url) {
  const u = parse(url);
  if (!u || !/^https?:$/.test(u.protocol)) return null;
  const path = u.pathname.replace(/\/+$/, '');
  if (/\/StreamServer$/i.test(path)) return 'stream';
  if (/\/(FeatureServer|MapServer)\/\d+$/i.test(path)) return 'feature';
  if (/geo\+?json/i.test(path) || /^geojson$/i.test(u.searchParams.get('f') ?? '')) return 'geojson';
  return null;
}

/** Why this feed address can't be used as this kind of feed, or '' when it can. */
export function trackUrlProblem(url, kind) {
  const text = String(url ?? '').trim();
  if (!text) return 'Enter the feed address.';
  const problem = addressProblem(text, { noun: 'feed' });
  if (problem) return problem;
  if (!isTrackKind(kind)) return 'Choose what kind of feed it is.';
  const path = parse(text).pathname.replace(/\/+$/, '');
  if (kind === 'stream' && !/\/StreamServer$/i.test(path)) return 'An ArcGIS stream service address ends in /StreamServer.';
  if (kind === 'feature' && !/\/(FeatureServer|MapServer)\/\d+$/i.test(path)) return 'An ArcGIS feature layer address ends in /FeatureServer/0 or /MapServer/0 (one layer, by number).';
  return '';
}

/** A dotted path into a JSON object: "latitude", "attributes.latitude", "position.0". */
export const isPath = p => typeof p === 'string' && /^[\w$-]+(\.[\w$-]+)*$/.test(p);
export function getPath(obj, path) {
  if (!path) return obj;
  return String(path).split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

/** The values worth showing about an object: its plain values, one level of nesting flattened to "a.b", at most 40. */
export function flatAttributes(obj, max = 40) {
  const out = {};
  const put = (k, v) => { if (Object.keys(out).length < max && (v == null || ['string', 'number', 'boolean'].includes(typeof v))) out[k] = v; };
  if (!obj || typeof obj !== 'object') return out;
  for (const [k, v] of Object.entries(obj)) {
    if (v && typeof v === 'object' && !Array.isArray(v)) for (const [k2, v2] of Object.entries(v)) put(`${k}.${k2}`, v2);
    else put(k, v);
  }
  return out;
}

const num = v => (v == null || v === '' ? NaN : Number(v));
const text = v => (v == null || v === '' ? '' : String(v));

/**
 * The objects in one answer of a GeoJSON or JSON feed.
 *   geojson  a FeatureCollection (or one Feature) of points; id from idField or the feature's id, label from labelField
 *   json     the list at itemsPath ('' = the answer itself: a list, or one object such as the ISS), each item's position
 *            at latField and lonField
 * @returns { items: [{ id, label, lon, lat, attributes }], skipped (no usable position), total, truncated }
 */
export function readPositions(data, feed) {
  const items = [];
  let skipped = 0;
  let list;
  if (feed.kind === 'geojson') {
    list = data?.type === 'Feature' ? [data] : Array.isArray(data?.features) ? data.features : null;
    if (!list) throw new Error('The answer isn\'t GeoJSON (no "features" list).');
  } else {
    const at = getPath(data, feed.itemsPath);
    if (at == null) throw new Error(feed.itemsPath ? `Nothing at "${feed.itemsPath}" in the answer.` : 'The answer is empty.');
    list = Array.isArray(at) ? at : [at];
  }
  const seen = new Set();
  for (const [i, it] of list.entries()) {
    let lon, lat, props;
    if (feed.kind === 'geojson') {
      const g = it?.geometry;
      const c = g?.type === 'Point' ? g.coordinates : g?.type === 'MultiPoint' ? g.coordinates?.[0] : null;
      [lon, lat] = [num(c?.[0]), num(c?.[1])];
      props = it?.properties ?? {};
    } else {
      [lon, lat] = [num(getPath(it, feed.lonField)), num(getPath(it, feed.latField))];
      props = it;
    }
    if (!isLonLat([lon, lat]) || (lon === 0 && lat === 0)) { skipped++; continue; }
    const rawId = feed.idField ? getPath(props, feed.idField) : feed.kind === 'geojson' ? (it?.id ?? props?.id) : undefined;
    let id = text(rawId) || String(i + 1);
    if (seen.has(id)) id = `${id} (${i + 1})`;
    seen.add(id);
    const label = text(feed.labelField ? getPath(props, feed.labelField) : '') || id;
    items.push({ id, label, lon, lat, attributes: flatAttributes(props) });
    if (items.length >= OBJECTS_MAX) break;
  }
  return { items, skipped, total: list.length, truncated: list.length > items.length + skipped };
}

const LAT = /^(lat|latitude|y|lat_deg)$/i;
const LON = /^(lon|lng|long|longitude|x|lon_deg)$/i;
const ID = /^(id|uid|vehicle_?id|vehicleid|mmsi|icao24|hex|tracker_?id|device_?id|unit_?id|trainnumber|objectid)$/i;
const LABEL = /^(label|name|title|callsign|flight|vehicle_?label|display_?name|trainnumber|run_id|route_id)$/i;

/**
 * The paths a JSON or GeoJSON feed most likely uses, from one sample answer (Test in settings fills in the ones the
 * author left empty). Looks for the list of objects (the answer, or the first list in it, one or two levels deep), then
 * for latitude and longitude, an id and a name in its first object (also one level down, e.g. "attributes.latitude").
 * @returns { kind, itemsPath, latField, lonField, idField, labelField } ('' where nothing fits)
 */
export function guessFeedPaths(data) {
  const out = { kind: 'json', itemsPath: '', latField: '', lonField: '', idField: '', labelField: '' };
  if (data?.type === 'FeatureCollection' || data?.type === 'Feature') {
    out.kind = 'geojson';
    const p = (data.features?.[0] ?? data)?.properties ?? {};
    out.idField = Object.keys(p).find(k => ID.test(k)) ?? '';
    out.labelField = Object.keys(p).find(k => LABEL.test(k) && k !== out.idField) ?? '';
    return out;
  }
  let sample = data;
  if (!Array.isArray(data) && data && typeof data === 'object') {
    const lists = [];
    for (const [k, v] of Object.entries(data)) {
      if (Array.isArray(v) && v.length && typeof v[0] === 'object') lists.push(k);
      else if (v && typeof v === 'object' && !Array.isArray(v)) {
        for (const [k2, v2] of Object.entries(v)) if (Array.isArray(v2) && v2.length && typeof v2[0] === 'object') lists.push(`${k}.${k2}`);
      }
    }
    const hasOwnPosition = Object.keys(data).some(k => LAT.test(k)) && Object.keys(data).some(k => LON.test(k));
    if (lists.length && !hasOwnPosition) out.itemsPath = lists[0];
  }
  sample = getPath(data, out.itemsPath);
  if (Array.isArray(sample)) sample = sample[0];
  if (!sample || typeof sample !== 'object') return out;
  const keys = Object.keys(flatAttributes(sample, 200));
  const find = re => keys.find(k => re.test(k.split('.').pop())) ?? '';
  out.latField = find(LAT);
  out.lonField = find(LON);
  out.idField = find(ID);
  out.labelField = keys.find(k => LABEL.test(k.split('.').pop()) && k !== out.idField) ?? '';
  return out;
}

/**
 * Each object's recent positions, newest last, after one more answer: a position is added when the object moved,
 * at most `trail` earlier positions are kept, and objects no longer in the answer are forgotten.
 * @param tracks  Map id -> [[lon, lat], ...] from the previous answer (not changed)
 * @returns a new Map
 */
export function mergeTracks(tracks, items, trail) {
  const out = new Map();
  const keep = Math.max(0, Math.min(TRAIL_MAX, trail | 0)) + 1;
  for (const it of items) {
    const before = tracks.get(it.id) ?? [];
    const last = before[before.length - 1];
    const moved = !last || last[0] !== it.lon || last[1] !== it.lat;
    out.set(it.id, (moved ? [...before, [it.lon, it.lat]] : before).slice(-keep));
  }
  return out;
}

/**
 * A track as a line the map can draw: it splits where it crosses the antimeridian (the ISS goes round the world),
 * so a jump from 179° to -179° isn't drawn across the whole map. @returns [[[lon, lat], ...], ...] paths of 2+ points
 */
export function trackPaths(points) {
  const paths = [];
  let cur = [];
  for (const p of points) {
    const prev = cur[cur.length - 1];
    if (prev && Math.abs(p[0] - prev[0]) > 180) { paths.push(cur); cur = []; }
    cur.push(p);
  }
  paths.push(cur);
  return paths.filter(p => p.length > 1);
}

/** One line under a feed's name: how it's updated. */
export function trackKindLabel(feed) {
  switch (feed?.kind) {
    case 'stream': return 'Live (stream service)';
    case 'feature': return `Feature layer, every ${feed.refreshSeconds ?? 15} s`;
    case 'geojson': return `GeoJSON, every ${feed.refreshSeconds ?? 15} s`;
    case 'json': return `JSON, every ${feed.refreshSeconds ?? 15} s`;
    default: return '';
  }
}

/**
 * Public feeds for trying Tracking out (HTTPS, open to other sites (CORS), no key; checked 2026-10-22). Public feeds
 * come and go: replace one in settings if it stops. Without id: manifest.newFeed() gives each one.
 */
export const DEMO_FEEDS = [
  {
    title: 'Los Angeles Metro buses (demo)', kind: 'stream', url: 'https://geoeventsample1.esri.com:6443/arcgis/rest/services/LABus/StreamServer',
    refreshSeconds: 15, itemsPath: '', latField: '', lonField: '', idField: 'id', labelField: 'route_id', trail: 10, color: '', visible: true,
    description: 'Esri\'s sample ArcGIS stream service: LA Metro buses, pushed to the map as they report.', credit: 'Esri sample service (LA Metro data)'
  },
  {
    title: 'US flights (demo)', kind: 'stream', url: 'https://geoeventsample1.esri.com:6443/arcgis/rest/services/FAAStream/StreamServer',
    refreshSeconds: 15, itemsPath: '', latField: '', lonField: '', idField: 'ACID', labelField: 'ACID', trail: 5, color: '', visible: false,
    description: 'Esri\'s sample ArcGIS stream service: aircraft over the United States.', credit: 'Esri sample service (FAA data)'
  },
  {
    title: 'International Space Station (demo)', kind: 'json', url: 'https://api.wheretheiss.at/v1/satellites/25544',
    refreshSeconds: 5, itemsPath: '', latField: 'latitude', lonField: 'longitude', idField: 'id', labelField: 'name', trail: 60, color: '', visible: false,
    description: 'One object from a plain JSON answer: the ISS, about 28,000 km/h. Follow it to watch it cross the map.', credit: 'wheretheiss.at'
  },
  {
    title: 'Finnish trains (demo)', kind: 'geojson', url: 'https://rata.digitraffic.fi/api/v1/train-locations.geojson/latest/',
    refreshSeconds: 15, itemsPath: '', latField: '', lonField: '', idField: 'trainNumber', labelField: 'trainNumber', trail: 20, color: '', visible: false,
    description: 'GPS positions of passenger and freight trains in Finland, as GeoJSON.', credit: 'Fintraffic / digitraffic.fi, CC BY 4.0'
  },
  {
    title: 'Boston subway and trams (demo)', kind: 'json', url: 'https://api-v3.mbta.com/vehicles?filter%5Broute_type%5D=0,1&fields%5Bvehicle%5D=label,latitude,longitude,bearing,speed,current_status,updated_at',
    refreshSeconds: 15, itemsPath: 'data', latField: 'attributes.latitude', lonField: 'attributes.longitude', idField: 'id', labelField: 'attributes.label', trail: 20, color: '', visible: false,
    description: 'A transit agency\'s JSON API: the list is under "data", positions under "attributes".', credit: 'Massachusetts Bay Transportation Authority (MBTA)'
  }
];
