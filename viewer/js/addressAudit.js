// addressAudit.js — the Address audit tool's core: how the organisation's site addresses compare with what
// OpenStreetMap (and, with the person's own key, Google) say is there. Pure: no DOM, no network.
//
// - The GIS address of a feature comes from the fields the author maps (number, street, street type, suburb, town,
//   postal code); a mapping can take one comma-separated part of a field (the municipality's Result field holds
//   "10, FIFTH, STREET, VOELKLIP, Ward 3").
// - OpenStreetMap: one Overpass query for every addr:housenumber in the view (overpassQuery), matched here, so the
//   public servers get one request per audit instead of one per address.
// - Google: the Geocoding API's answer for the GIS address (googleGeocodeUrl / parseGoogleGeocode), matched the same way.
//   Google's results are only ever shown in the table, never drawn on the (non-Google) map or kept.
// - Matching asks "where does the provider put our address?": the same number and street nearby is a match; the same
//   address further than maxDistance is misplaced; otherwise the nearest provider address says what's different.
// - The Google Maps Content Partners export (contentPartnersRows / contentPartnersCsv / contentPartnersGeoJson) writes
//   the chosen rows as address points in Google's field names: ST_NUM, HOUSE_ID, UNIT_INFO, ST_NAME, NEIGHBH,
//   LOCALITY, ADMIN, POSTAL, CNTRY, LAT, LON; CSV with every value in quotes.
import { defaultEmphasis, emphasisProblems } from './emphasis.js';

export const AUDIT_PROVIDERS = [['osm', 'OpenStreetMap'], ['google', 'Google (people enter their own API key)']];
export const AUDIT_ROLES = [
  ['number', 'Street number'], ['unit', 'Unit, flat or building'], ['street', 'Street name'], ['streetType', 'Street type (if separate)'],
  ['suburb', 'Suburb'], ['locality', 'Town'], ['postal', 'Postal code']
];
const ROLE_IDS = AUDIT_ROLES.map(([id]) => id);
export const AUDIT_WINDOW_SIZES = [['bottom', 'Docked at the bottom'], ['default', 'Movable window'], ['half', 'Half the map'], ['full', 'The whole map']];
export const AUDIT_MAX_AREA_KM2 = 6;     // the most map one audit asks Overpass about (its servers are shared)
export const AUDIT_MAX_FEATURES = 2000;  // the most GIS addresses one audit reads
export const GOOGLE_MAX = 200;           // the most addresses one audit sends to Google (each one is billed)
export const MAX_DISTANCE_LIMIT = 1000;

/** Statuses, most urgent first: [id, label, colour for the map marker]. */
export const AUDIT_STATUSES = [
  ['missing', 'Missing', '#C62828'],
  ['wrong-street', 'Different street', '#D84315'],
  ['wrong-number', 'Different number', '#EF6C00'],
  ['misplaced', 'Too far away', '#F9A825'],
  ['different', 'Another address there', '#8E24AA'],
  ['match', 'Match', '#2E7D32'],
  ['gis-incomplete', 'GIS address incomplete', '#607D8B'],
  ['error', "Couldn't check", '#9E9E9E']
];
export const statusLabel = id => AUDIT_STATUSES.find(([s]) => s === id)?.[1] ?? id;
export const statusColour = id => AUDIT_STATUSES.find(([s]) => s === id)?.[2] ?? '#9E9E9E';
/** Rows worth sending to Google to fix: anything but a match, an incomplete GIS address or a failed check. */
export const NEEDS_FIX = new Set(['missing', 'wrong-street', 'wrong-number', 'misplaced', 'different']);

const blankRole = () => ({ field: '', part: 0 });

/** The tool's settings (widgets.toolConfig['address-audit']). */
export const defaultAddressAudit = () => ({
  layer: '',
  fields: Object.fromEntries(ROLE_IDS.map(id => [id, blankRole()])),
  skipValues: ['UNKNOWN'],
  providers: ['osm'],
  maxDistance: 25,
  locality: '', admin: '', postal: '', country: 'ZA',
  windowSize: 'bottom',
  emphasis: defaultEmphasis()
});

/** Fill in anything missing (older or hand-written settings). */
export function upgradeAddressAudit(cfg) {
  const d = defaultAddressAudit();
  const c = { ...d, ...(cfg && typeof cfg === 'object' && !Array.isArray(cfg) ? cfg : {}) };
  c.fields = Object.fromEntries(ROLE_IDS.map(id => {
    const f = c.fields?.[id];
    return [id, typeof f === 'string' ? { field: f, part: 0 } : { ...blankRole(), ...(f && typeof f === 'object' ? f : {}) }];
  }));
  if (!Array.isArray(c.skipValues)) c.skipValues = d.skipValues;
  if (!Array.isArray(c.providers)) c.providers = d.providers;
  c.emphasis ??= defaultEmphasis();
  return c;
}

/** What's wrong with the settings: plain sentences. */
export function addressAuditProblems(cfg) {
  if (!cfg || typeof cfg !== 'object') return ['the settings are missing.'];
  const out = [];
  if (typeof cfg.layer !== 'string') out.push('choose the layer of site addresses.');
  for (const id of ROLE_IDS) {
    const f = cfg.fields?.[id];
    if (!f || typeof f.field !== 'string' || !(Number.isInteger(f.part) && f.part >= 0 && f.part <= 20)) out.push(`${AUDIT_ROLES.find(([r]) => r === id)[1]}: a field and a part from 0 (the whole value) to 20.`);
  }
  if (cfg.layer && !cfg.fields?.number?.field) out.push('choose the field that holds the street number.');
  if (cfg.layer && !cfg.fields?.street?.field) out.push('choose the field that holds the street name.');
  if (!Array.isArray(cfg.skipValues) || cfg.skipValues.some(v => typeof v !== 'string')) out.push('values that mean "not known" must be a list of words.');
  if (!Array.isArray(cfg.providers) || !cfg.providers.length || cfg.providers.some(p => !AUDIT_PROVIDERS.some(([id]) => id === p))) out.push('compare with OpenStreetMap, Google or both.');
  if (!(Number.isFinite(cfg.maxDistance) && cfg.maxDistance >= 1 && cfg.maxDistance <= MAX_DISTANCE_LIMIT)) out.push(`the distance that still counts as the same place must be 1 to ${MAX_DISTANCE_LIMIT} metres.`);
  for (const k of ['locality', 'admin', 'postal']) if (typeof cfg[k] !== 'string') out.push(`${k} must be text.`);
  if (typeof cfg.country !== 'string' || !/^[A-Z]{2}$/.test(cfg.country)) out.push('the country must be a two-letter ISO code, such as ZA.');
  if (!AUDIT_WINDOW_SIZES.some(([id]) => id === cfg.windowSize)) out.push('the results open docked at the bottom, as a movable window, at half the map or over the whole map.');
  for (const p of emphasisProblems(cfg.emphasis)) out.push(p);
  return out;
}

/* ---------------- Normalising ---------------- */

const ORDINALS = ['first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth', 'tenth', 'eleventh', 'twelfth',
  'thirteenth', 'fourteenth', 'fifteenth', 'sixteenth', 'seventeenth', 'eighteenth', 'nineteenth', 'twentieth'];
const suffix = n => (n % 100 >= 11 && n % 100 <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] ?? 'th');
const ORDINAL_WORDS = new Map(ORDINALS.map((w, i) => [w, `${i + 1}${suffix(i + 1)}`]));

// Street types, written out (Google asks for them in full; OSM writes them in full), English and Afrikaans.
const STREET_TYPES = new Map(Object.entries({
  st: 'street', str: 'street', straat: 'street', rd: 'road', weg: 'road', ave: 'avenue', av: 'avenue', laan: 'avenue',
  cres: 'crescent', cr: 'crescent', dr: 'drive', rylaan: 'drive', cl: 'close', ln: 'lane', pl: 'place', plein: 'place',
  cir: 'circle', crcl: 'circle', ct: 'court', crt: 'court', hwy: 'highway', blvd: 'boulevard', sq: 'square',
  tce: 'terrace', terr: 'terrace', wy: 'way', pde: 'parade', ext: 'extension', mt: 'mount'
}));

const tokens = s => String(s ?? '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
  .replace(/['’`.]/g, '').replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean);

/** A street number for comparing: "20 B", "20-b" and "20B" are all "20b". */
export const normalizeNumber = v => String(v ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

/** A street name for comparing: lower case, no punctuation, ordinals as 5th, street types written out. */
export function normalizeStreet(v) {
  return tokens(v).map(t => ORDINAL_WORDS.get(t) ?? (/^\d+(st|nd|rd|th)$/.test(t) ? t : STREET_TYPES.get(t) ?? t)).join(' ');
}

/** A street name for Google: every word capitalised, street types written out ("10TH AVENUE" -> "10th Avenue"). */
export function displayStreet(v) {
  return tokens(v).map(t => STREET_TYPES.get(t) ?? t).map(t => (/^\d/.test(t) ? t : t[0].toUpperCase() + t.slice(1))).join(' ');
}
const displayWords = v => tokens(v).map(t => (/^\d/.test(t) ? t : t[0].toUpperCase() + t.slice(1))).join(' ');

/* ---------------- GIS addresses ---------------- */

/** One mapped value: the whole field (part 0) or its nth comma-separated part (1 is the first). */
export function roleValue(attributes, role) {
  if (!role?.field) return '';
  const name = Object.keys(attributes ?? {}).find(k => k.toLowerCase() === role.field.toLowerCase());
  const raw = name == null ? null : attributes[name];
  if (raw == null) return '';
  const text = String(raw).trim();
  if (!role.part) return text;
  return (text.split(',')[role.part - 1] ?? '').trim();
}

/**
 * The GIS address of a feature, from the mapped fields.
 * @returns { number, unit, street, suburb, locality, postal, incomplete, text }
 *   street includes the street type; incomplete when the number or street is empty or a "not known" value.
 */
export function gisAddress(attributes, cfg) {
  const v = id => roleValue(attributes, cfg.fields?.[id]);
  const skip = new Set((cfg.skipValues ?? []).map(s => s.trim().toLowerCase()).filter(Boolean));
  const unknown = s => !s || skip.has(s.trim().toLowerCase());
  const name = v('street'), type = v('streetType');
  const street = [name, unknown(type) ? '' : type].filter(Boolean).join(' ');
  const a = {
    number: v('number'), unit: v('unit'), street, suburb: unknown(v('suburb')) ? '' : v('suburb'),
    locality: unknown(v('locality')) ? cfg.locality ?? '' : v('locality'), postal: unknown(v('postal')) ? cfg.postal ?? '' : v('postal')
  };
  a.incomplete = unknown(a.number) || unknown(name);
  a.text = addressText(a);
  return a;
}

/** One line for people: "10 Fifth Street, Voelklip, Hermanus, 7200". */
export function addressText(a) {
  if (!a) return '';
  const first = [a.unit ? displayWords(a.unit) : '', [a.number, displayStreet(a.street)].filter(Boolean).join(' ')].filter(Boolean).join(', ');
  return [first, displayWords(a.suburb), displayWords(a.locality), a.postal].filter(Boolean).join(', ');
}

/* ---------------- Geometry ---------------- */

/** Metres between two { lat, lon } points (haversine on a 6 371 km sphere). */
export function distanceM(a, b) {
  const r = Math.PI / 180, R = 6371008.8;
  const dLat = (b.lat - a.lat) * r, dLon = (b.lon - a.lon) * r;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Square kilometres of a { south, west, north, east } box in degrees. */
export function bboxAreaKm2(b) {
  const h = distanceM({ lat: b.south, lon: b.west }, { lat: b.north, lon: b.west });
  const mid = (b.south + b.north) / 2;
  const w = distanceM({ lat: mid, lon: b.west }, { lat: mid, lon: b.east });
  return (h * w) / 1e6;
}

export const isBbox = b => b && ['south', 'west', 'north', 'east'].every(k => Number.isFinite(b[k]))
  && b.south < b.north && b.west < b.east && b.south >= -90 && b.north <= 90 && b.west >= -180 && b.east <= 180;

/* ---------------- OpenStreetMap (Overpass) ---------------- */

/** Public Overpass servers, tried in turn when one is busy (both allow browsers to ask, CORS). */
export const OVERPASS_URLS = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter'];

/** The Overpass QL for every address in a box: nodes, ways and relations with a house number, ways at their centre. */
export function overpassQuery(b) {
  if (!isBbox(b)) throw new Error('The map view has no usable extent.');
  const f = n => Number(n.toFixed(6));
  return `[out:json][timeout:60];nwr["addr:housenumber"](${f(b.south)},${f(b.west)},${f(b.north)},${f(b.east)});out center tags;`;
}

/**
 * Overpass JSON -> provider addresses [{ id, number, street, suburb, locality, postal, lat, lon, text }].
 * Throws when Overpass ran out of time or memory (it still answers 200, with a remark).
 */
export function parseOverpass(json) {
  if (/runtime error|timed out|out of memory/i.test(json?.remark ?? '')) throw new Error(`OpenStreetMap's server gave up (${json.remark.trim()}). Zoom in and try again.`);
  const out = [];
  for (const e of json?.elements ?? []) {
    const t = e.tags ?? {};
    const lat = e.lat ?? e.center?.lat, lon = e.lon ?? e.center?.lon;
    if (!t['addr:housenumber'] || !Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    // One OSM element can carry a list ("12;14") or a range ("12-16"): each number stands for itself.
    const numbers = String(t['addr:housenumber']).split(/[;,]/).map(s => s.trim()).filter(Boolean);
    const street = t['addr:street'] ?? t['addr:place'] ?? '';
    for (const number of numbers) {
      const a = { id: `${e.type}/${e.id}`, number, street, suburb: t['addr:suburb'] ?? '', locality: t['addr:city'] ?? t['addr:town'] ?? '', postal: t['addr:postcode'] ?? '', lat, lon };
      a.text = addressText(a);
      out.push(a);
    }
  }
  return out;
}

export const osmLink = id => (id ? `https://www.openstreetmap.org/${id}` : '');

/* ---------------- Google (Geocoding API) ---------------- */

export const GOOGLE_GEOCODE_URL = 'https://maps.googleapis.com/maps/api/geocode/json';

/** The Geocoding request for a GIS address, limited to the country. The key is the person's own and never stored here. */
export function googleGeocodeUrl(a, key, country = 'ZA') {
  if (!key) throw new Error('A Google API key is needed.');
  const q = new URLSearchParams({ address: a.text, components: `country:${country}`, key });
  return `${GOOGLE_GEOCODE_URL}?${q}`;
}

/**
 * Geocoding JSON -> the provider address Google gives for it (its first result), or null for none.
 * Throws for a refused request (bad key, quota), so the row says what went wrong.
 */
export function parseGoogleGeocode(json) {
  if (json?.status === 'ZERO_RESULTS') return null;
  if (json?.status !== 'OK') throw new Error(json?.error_message || json?.status || 'Google gave no answer.');
  const r = json.results?.[0];
  if (!r) return null;
  const part = type => r.address_components?.find(c => c.types?.includes(type))?.long_name ?? '';
  const loc = r.geometry?.location ?? {};
  const a = {
    id: r.place_id ?? '', number: part('street_number'), street: part('route'),
    suburb: part('sublocality') || part('sublocality_level_1') || part('neighborhood'), locality: part('locality'), postal: part('postal_code'),
    lat: loc.lat, lon: loc.lng, partial: r.partial_match === true, precision: r.geometry?.location_type ?? ''
  };
  a.text = r.formatted_address ?? addressText(a);
  return a;
}

/** Google Maps at a place (Maps URLs): people use "Suggest an edit" there. */
export const googleMapsLink = (lat, lon) => `https://www.google.com/maps/search/?api=1&query=${Number(lat).toFixed(6)},${Number(lon).toFixed(6)}`;
export const CONTENT_PARTNERS_URL = 'https://contentpartners.maps.google.com/';
export const GOOGLE_FIX_HELP_URL = 'https://support.google.com/maps/answer/10010575';

/* ---------------- Matching ---------------- */

const sameNumber = (a, b) => normalizeNumber(a.number) !== '' && normalizeNumber(a.number) === normalizeNumber(b.number);
const sameStreet = (a, b) => normalizeStreet(a.street) !== '' && normalizeStreet(a.street) === normalizeStreet(b.street);

/**
 * How a provider sees one GIS address.
 * @param gis         gisAddress() plus { lat, lon }
 * @param candidates  provider addresses near it (parseOverpass, or Google's one answer)
 * @param maxDistance metres that still count as the same place
 * @param near        for Overpass: candidates are everything in view, so "missing" means nothing within maxDistance;
 *                    for Google: the one answer is about this address, wherever it is
 * @param own         for Overpass (matchAll): the provider addresses nearer this site than any other, the only ones
 *                    that can stand for it with a different number or street (a neighbour's house is not this one)
 * @returns { status, candidate, distance }   distance in whole metres, or null
 */
export function matchAddress(gis, candidates, maxDistance, { near = true, own = null } = {}) {
  if (gis.incomplete) return { status: 'gis-incomplete', candidate: null, distance: null };
  const withD = (candidates ?? []).map(c => ({ c, d: distanceM(gis, c) })).sort((x, y) => x.d - y.d);
  const res = (status, x) => ({ status, candidate: x?.c ?? null, distance: x ? Math.round(x.d) : null });
  const same = withD.find(x => sameNumber(gis, x.c) && sameStreet(gis, x.c));
  if (same) return res(same.d <= maxDistance ? 'match' : 'misplaced', same);
  const close = withD.filter(x => x.d <= maxDistance && (!own || own.has(x.c)));
  const pool = near ? close : withD;
  const street = pool.find(x => sameStreet(gis, x.c));
  if (street) return res('wrong-number', street);
  const number = pool.find(x => sameNumber(gis, x.c));
  if (number) return res('wrong-street', number);
  if (pool.length) return res('different', pool[0]);
  return res('missing', null);
}

/**
 * Every GIS address in view against every provider address in view (Overpass). Each provider address stands for the
 * site it is nearest to, so a house next door doesn't make this one "Different number": with nothing of its own
 * nearby, an address is missing. The same number and street counts wherever it is (misplaced when too far).
 * @param gisList  [gisAddress() plus { lat, lon }]
 * @returns [{ status, candidate, distance }] in gisList's order
 */
export function matchAll(gisList, candidates, maxDistance) {
  const owned = gisList.map(() => new Set());
  const sites = gisList.map((g, i) => [g, i]).filter(([g]) => !g.incomplete);
  for (const c of candidates ?? []) {
    let best = null, bestD = Infinity;
    for (const [g, i] of sites) { const d = distanceM(g, c); if (d < bestD) { bestD = d; best = i; } }
    if (best != null) owned[best].add(c);
  }
  return gisList.map((g, i) => matchAddress(g, candidates, maxDistance, { own: owned[i] }));
}

/**
 * How Google sees one GIS address, from its answer to that address (parseGoogleGeocode). An answer without a house
 * number (only the street, suburb or town) means Google doesn't know the address: missing, with what it did find.
 */
export function matchGoogle(gis, answer, maxDistance) {
  if (gis.incomplete) return { status: 'gis-incomplete', candidate: null, distance: null };
  if (!answer) return { status: 'missing', candidate: null, distance: null };
  const distance = Number.isFinite(answer.lat) ? Math.round(distanceM(gis, answer)) : null;
  if (!normalizeNumber(answer.number)) return { status: 'missing', candidate: answer, distance };
  return matchAddress(gis, [answer], maxDistance, { near: false });
}

/** Counts per status, in AUDIT_STATUSES order, leaving out the ones with none: [[id, label, n]]. */
export function statusCounts(statuses) {
  const n = new Map();
  for (const s of statuses) n.set(s, (n.get(s) ?? 0) + 1);
  return AUDIT_STATUSES.filter(([id]) => n.has(id)).map(([id, label]) => [id, label, n.get(id)]);
}

/** Of two providers' statuses, the one more in need of attention (for the row's overall status and marker). */
export function worstStatus(...statuses) {
  const order = AUDIT_STATUSES.map(([id]) => id);
  const s = statuses.filter(Boolean);
  return s.length ? s.reduce((a, b) => (order.indexOf(b) < order.indexOf(a) ? b : a)) : null;
}

/* ---------------- Google Maps Content Partners export ---------------- */

export const CONTENT_PARTNERS_FIELDS = ['ST_NUM', 'HOUSE_ID', 'UNIT_INFO', 'ST_NAME', 'NEIGHBH', 'LOCALITY', 'ADMIN', 'POSTAL', 'CNTRY', 'LAT', 'LON'];

/**
 * Address points in Google's field names, one per audited row (rows: { gis } with gis.lat / gis.lon).
 * Street types written out, coordinates in decimal degrees (WGS 84) to 6 places, the author's province and country.
 */
export function contentPartnersRows(rows, cfg) {
  return rows.filter(r => r.gis && !r.gis.incomplete && Number.isFinite(r.gis.lat) && Number.isFinite(r.gis.lon)).map(({ gis }) => ({
    ST_NUM: gis.number.toUpperCase(), HOUSE_ID: '', UNIT_INFO: displayWords(gis.unit), ST_NAME: displayStreet(gis.street),
    NEIGHBH: displayWords(gis.suburb), LOCALITY: displayWords(gis.locality), ADMIN: cfg.admin ?? '', POSTAL: gis.postal ?? '',
    CNTRY: cfg.country ?? '', LAT: gis.lat.toFixed(6), LON: gis.lon.toFixed(6)
  }));
}

/** CSV as Google asks for it: a header row, comma separated, every value in double quotes (UTF-8, CRLF lines). */
export function contentPartnersCsv(points) {
  const q = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
  return [CONTENT_PARTNERS_FIELDS.map(q).join(','), ...points.map(p => CONTENT_PARTNERS_FIELDS.map(f => q(p[f])).join(','))].join('\r\n') + '\r\n';
}

/** GeoJSON points (longitude, latitude; no heights), the same fields as properties. */
export function contentPartnersGeoJson(points) {
  return {
    type: 'FeatureCollection',
    features: points.map(p => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [Number(p.LON), Number(p.LAT)] },
      properties: Object.fromEntries(CONTENT_PARTNERS_FIELDS.filter(f => f !== 'LAT' && f !== 'LON').map(f => [f, p[f]]))
    }))
  };
}

/** Field guesses for a layer's fields: { role: { field, part } } for the roles a field name suggests. */
export function guessFields(fields) {
  const names = (fields ?? []).map(f => f.name);
  const find = (...res) => names.find(n => res.some(re => re.test(n))) ?? '';
  return {
    number: { field: find(/^st_?num/i, /^street_?no$/i, /^house_?n(o|um)/i, /^(erf_)?street_?number$/i, /^addr_?num/i), part: 0 },
    unit: { field: find(/^unit/i, /^flat/i, /^building_?name/i), part: 0 },
    street: { field: find(/^st_?name$/i, /^street_?name$/i, /^street$/i, /^road_?name$/i), part: 0 },
    streetType: { field: find(/^st_?type$/i, /^street_?type$/i), part: 0 },
    suburb: { field: find(/^suburb$/i, /^neighb/i, /^township$/i), part: 0 },
    locality: { field: find(/^town$/i, /^city$/i, /^locality$/i), part: 0 },
    postal: { field: find(/^postal/i, /^post_?code/i, /^zip/i), part: 0 }
  };
}
