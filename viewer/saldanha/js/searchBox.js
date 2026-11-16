// searchBox.js — the search box at the top of Search (the SDK's Search widget), set up as Experience Builder does:
// any number of sources, each a geocoding service (the ArcGIS World Geocoder, or a locator such as the municipality's
// own) or a layer of the map searched on chosen fields, with suggestions as people type. With more than one source
// people can search them all at once or pick one; the primary source (boxPrimary) is the one the box opens on. Each
// source has its own emphasis (emphasis.js) for the result chosen.
// Pure: no DOM, no SDK, so it runs in Node tests. searchEditor.js edits it; widgets.js mounts it.
import { uid } from './utils.js';
import { defaultEmphasis, emphasisProblems } from './emphasis.js';

// The address that answers searches without a sign-in (geocode-api.arcgis.com asks for an ArcGIS sign-in or API key).
export const WORLD_GEOCODER_URL = 'https://geocode.arcgis.com/arcgis/rest/services/World/GeocodeServer';
const SIGN_IN_WORLD_GEOCODER = /^https:\/\/geocode-api\.arcgis\.com\/arcgis\/rest\/services\/World\/GeocodeServer\/?$/i;
export const WORLD_GEOCODER_NAME = 'ArcGIS World Geocoder';
export const MAX_SUGGESTIONS_MAX = 20;
export const DEFAULT_ALL_PLACEHOLDER = 'Find an address, place or feature';

/** A geocoding service (…/GeocodeServer). countryCode: ISO codes such as 'ZA' ('' = anywhere). */
export const newLocatorSource = (url = WORLD_GEOCODER_URL, name = url === WORLD_GEOCODER_URL ? WORLD_GEOCODER_NAME : '') => ({
  id: uid('box'), type: 'locator', name, url, placeholder: '', countryCode: '', maxSuggestions: 6, resultFields: [], emphasis: defaultEmphasis()
});

/** A layer of the map: searched on searchFields (contains, or exact), results named by displayField. */
export const newLayerBoxSource = layerKey => ({
  id: uid('box'), type: 'layer', layerKey, name: '', searchFields: [], displayField: '', exactMatch: false,
  placeholder: '', maxSuggestions: 6, resultFields: [], emphasis: defaultEmphasis()
});

export const isWorldGeocoder = url => /\/\/geocode(-api)?\.arcgis\.com\/arcgis\/rest\/services\/World\/GeocodeServer\/?$/i.test(url ?? '');

/** A locator URL people can use: http(s), ends in /GeocodeServer, no token. */
export const isLocatorUrl = url => /^https?:\/\/[^\s?#]+\/GeocodeServer\/?$/i.test(String(url ?? '').trim());

/**
 * search.geocoder (true/false) became search.boxSources: true is the World Geocoder on its own.
 * Fills each source's missing values, and moves the World Geocoder off geocode-api (which needs a sign-in).
 * Changes `search` in place.
 */
export function upgradeSearchBox(search) {
  if (!Array.isArray(search.boxSources)) search.boxSources = search.geocoder === true ? [newLocatorSource()] : [];
  delete search.geocoder;
  search.allPlaceholder ??= '';
  search.boxPrimary ??= '';
  search.boxSources = search.boxSources.map(s => {
    if (!s || typeof s !== 'object') return s;
    const base = s.type === 'layer' ? newLayerBoxSource(s.layerKey) : newLocatorSource(s.url, '');
    const url = s.type === 'locator' && SIGN_IN_WORLD_GEOCODER.test(s.url ?? '') ? WORLD_GEOCODER_URL : s.url;
    return { ...base, ...s, ...(s.type === 'locator' ? { url } : {}), emphasis: s.emphasis && typeof s.emphasis === 'object' && !Array.isArray(s.emphasis) ? { ...defaultEmphasis(), ...s.emphasis } : s.emphasis ?? defaultEmphasis() };
  });
  return search;
}

/**
 * What's wrong with the box sources, as { errors, warnings } of sentences. ctx.layerKeys: the web map's layer keys.
 * primary: search.boxPrimary ('' = All, or a source's id).
 */
export function boxSourceProblems(sources, ctx = {}, primary = '') {
  const errors = [], warnings = [];
  if (!Array.isArray(sources)) return { errors: ['search.boxSources must be a list.'], warnings };
  if (typeof primary !== 'string') errors.push('search.boxPrimary must be a source id, or empty for All.');
  else if (primary && !sources.some(s => s?.id === primary)) warnings.push(`The primary search box source isn't there any more; the box opens on All.`);
  sources.forEach((s, i) => {
    const n = `Search box source ${i + 1}${s?.name ? ` (${s.name})` : ''}`;
    if (!s || typeof s !== 'object') { errors.push(`${n} must be an object.`); return; }
    if (s.type === 'locator') {
      if (/[?&]token=/i.test(s.url ?? '')) errors.push(`${n}: no tokens in the address. Sign-in is handled when the viewer runs.`);
      else if (!isLocatorUrl(s.url)) errors.push(`${n}: the address must be a geocoding service ending in /GeocodeServer.`);
      if (s.countryCode != null && !/^([A-Za-z]{2,3}(,[A-Za-z]{2,3})*)?$/.test(s.countryCode)) errors.push(`${n}: country codes look like ZA, or ZA,NA.`);
    } else if (s.type === 'layer') {
      if (!s.layerKey) errors.push(`${n}: choose a layer.`);
      else if (ctx.layerKeys && !ctx.layerKeys.has(s.layerKey)) warnings.push(`${n}: that layer isn't in the web map any more.`);
      if (!Array.isArray(s.searchFields) || !s.searchFields.length) errors.push(`${n}: pick at least one field to search.`);
      if (s.displayField != null && typeof s.displayField !== 'string') errors.push(`${n}: the display field must be a field name.`);
    } else errors.push(`${n}: type must be "locator" or "layer".`);
    if (s.maxSuggestions != null && !(Number.isInteger(s.maxSuggestions) && s.maxSuggestions >= 1 && s.maxSuggestions <= MAX_SUGGESTIONS_MAX)) errors.push(`${n}: suggestions must be a whole number from 1 to ${MAX_SUGGESTIONS_MAX}.`);
    if (s.resultFields != null && (!Array.isArray(s.resultFields) || s.resultFields.some(f => !f?.name))) errors.push(`${n}: each result column needs a field name.`);
    for (const p of emphasisProblems(s.emphasis)) errors.push(`${n}: ${p}`);
  });
  return { errors, warnings };
}

/**
 * Which source the box opens on, as the SDK's activeSourceIndex: the primary's place in `ids` (the sources the viewer
 * could set up, in order), or -1 for All. A single source is always the one; a primary that's gone means All.
 */
export function primaryIndex(primaryId, ids) {
  if (ids.length === 1) return 0;
  return primaryId ? ids.indexOf(primaryId) : -1;
}

/** The name a source shows in the box's source list. layerTitle: the layer's own title. */
export const boxSourceName = (s, layerTitle = '') => s.name?.trim() || (s.type === 'layer' ? layerTitle || 'Layer' : isWorldGeocoder(s.url) ? WORLD_GEOCODER_NAME : 'Geocoding service');

/**
 * Settings for one SDK search source (autocast by the Search widget), suggestions on.
 * A layer source needs `layer` (a FeatureLayer) and its title; a locator source needs neither.
 */
export function sdkSourceSettings(s, { layer = null, layerTitle = '' } = {}) {
  const common = {
    name: boxSourceName(s, layerTitle), placeholder: s.placeholder?.trim() || '', suggestionsEnabled: true,
    maxSuggestions: s.maxSuggestions ?? 6, popupEnabled: false, resultGraphicEnabled: false
  };
  if (s.type === 'locator') {
    return {
      ...common, url: s.url.trim().replace(/\/+$/, ''), outFields: ['*'],
      ...(isWorldGeocoder(s.url) ? { singleLineFieldName: 'SingleLine' } : {}),       // as the SDK sets for its own
      ...(s.countryCode ? { countryCode: s.countryCode.toUpperCase() } : {})
    };
  }
  return {
    ...common, layer, searchFields: [...s.searchFields], displayField: s.displayField || s.searchFields[0],
    exactMatch: s.exactMatch === true, outFields: ['*']
  };
}

/** The results table's name column: what the box called each result. */
export const RESULT_NAME = '__title';

/**
 * The results table's columns for a box source: the chosen ones, else the search fields (a layer) or just the
 * result's name (a geocoding service). meta: Map(field name -> { alias }) for the labels.
 */
export function boxColumns(s, meta = new Map()) {
  const chosen = s.resultFields?.length ? s.resultFields : s.type === 'layer' ? (s.searchFields ?? []).map(name => ({ name })) : [];
  const cols = chosen.map(c => ({ name: c.name, label: c.label || meta.get(c.name)?.alias || c.name }));
  return cols.length ? cols : [{ name: RESULT_NAME, label: 'Result' }];
}
