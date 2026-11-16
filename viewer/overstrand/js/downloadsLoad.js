// downloadsLoad.js — reads a download page's list from its source (downloads.js describes them) through api.js, so
// sign-in and timeouts work as everywhere else. Used by the viewer's Downloads window and the settings' Test button.
// A secured group or layer throws auth.AuthRequiredError, for the caller to offer the sign-in.
import * as api from './api.js';
import {
  DOWNLOAD_ROWS_MAX, instantAppItem, groupPageItem, gallerySearch, hubCatalogGroups, hubPortalUrl,
  rowsFromPortalItems, rowsFromFeatures, rowsFromJson, rowsFromManual, sourceProblem
} from './downloads.js';

const PAGE = 100;    // the most a portal search returns at once

/** Every item a portal search finds (up to max), following nextStart. */
async function searchAll(portalUrl, q, max) {
  const out = [];
  let start = 1;
  while (start > 0 && out.length < max) {
    const res = await api.searchItems(portalUrl, { q, start, num: Math.min(PAGE, max - out.length) });
    out.push(...(res.results ?? []));
    start = res.nextStart ?? -1;
  }
  return { results: out, more: start > 0 };
}

const groupQuery = ids => ids.map(id => `group:"${id}"`).join(' OR ');

/**
 * The page's rows: { rows, more, from } where more = there were more than DOWNLOAD_ROWS_MAX items, and from = a short
 * line about where they came from ("group Map sheets"). Throws on a source that can't be read.
 */
export async function loadDownloads(source, { max = DOWNLOAD_ROWS_MAX } = {}) {
  const problem = sourceProblem(source);
  if (problem) throw new Error(problem);
  const url = String(source.url ?? '').trim();

  if (source.kind === 'manual') return { rows: rowsFromManual(source.items), more: false, from: '' };

  if (source.kind === 'instantApp') {
    const groupPage = groupPageItem(url);
    if (groupPage) {
      const { results, more } = await searchAll(groupPage.portalUrl, groupQuery([groupPage.groupId]), max);
      const title = await api.getGroup(groupPage.portalUrl, groupPage.groupId).then(g => g.title).catch(() => '');
      return { rows: rowsFromPortalItems(results, groupPage.portalUrl), more, from: title ? `group ${title}` : '' };
    }
    const { portalUrl, appId } = instantAppItem(url);
    const [item, data] = await Promise.all([api.getPortalItem(portalUrl, appId), api.getPortalItemData(portalUrl, appId)]);
    const what = gallerySearch(data, item?.owner);
    if (what.problem) throw new Error(what.problem);
    if (what.group) {
      const { results, more } = await searchAll(portalUrl, groupQuery([what.group]), max);
      const title = await api.getGroup(portalUrl, what.group).then(g => g.title).catch(() => '');
      return { rows: rowsFromPortalItems(results, portalUrl, { skipId: appId }), more, from: title ? `group ${title}` : '' };
    }
    const { results, more } = await searchAll(portalUrl, `ownerfolder:${what.folderId} owner:"${what.owner}"`, max);
    return { rows: rowsFromPortalItems(results, portalUrl, { skipId: appId }), more, from: `${what.owner}'s folder` };
  }

  if (source.kind === 'hubSite') {
    const site = new URL(url);
    const domain = await api.getJsonFromUrl(`https://hub.arcgis.com/api/v3/domains/${site.hostname}`);
    if (!domain?.siteId) throw new Error(`${site.hostname} isn't a Hub site Hub knows.`);
    const portalUrl = hubPortalUrl(domain);
    const groups = hubCatalogGroups(await api.getPortalItemData(portalUrl, domain.siteId));
    if (!groups.length) throw new Error('The Hub site\'s catalog has no groups.');
    const { results, more } = await searchAll(portalUrl, groupQuery(groups), max);
    return { rows: rowsFromPortalItems(results, portalUrl, { hubSite: site.origin }), more, from: `${groups.length === 1 ? 'the' : groups.length} catalog group${groups.length === 1 ? '' : 's'}` };
  }

  if (source.kind === 'featureTable') {
    const outFields = [...new Set(Object.values(source.fields ?? {}).map(f => String(f ?? '').trim()).filter(Boolean))].join(',');
    const res = await api.queryTable(url, { where: source.where?.trim() || '1=1', outFields, max });
    return { rows: rowsFromFeatures(res.features, source.fields), more: res.exceededTransferLimit === true, from: res.info?.name ? `layer ${res.info.name}` : '' };
  }

  const json = await api.getJsonFromUrl(url);
  const rows = rowsFromJson(json, source.listPath ?? '', source.fields, url);
  return { rows: rows.slice(0, max), more: rows.length > max, from: '' };
}
