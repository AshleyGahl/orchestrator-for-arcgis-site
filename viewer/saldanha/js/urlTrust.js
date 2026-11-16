// urlTrust.js — which addresses the app trusts: where a sign-in's token may be sent, and where a published viewer
// may load its manifest from. No DOM, no SDK, no imports.
//
// An ArcGIS Server names its own token service (…/rest/info → authInfo.tokenServicesUrl), so that answer alone can't
// decide where a token goes: any server could name your portal's token service and be sent your token. A token goes
// only to its own token service's origin, to ArcGIS Online's hosts for an ArcGIS Online sign-in, or to the servers
// listed for that portal in CONFIG.federatedHosts (servers federated with it on another host).

/** ArcGIS Online and its hosted services (an ArcGIS Online token works across all of them). */
export const isArcGISOnlineHost = hostname => hostname === 'arcgis.com' || String(hostname).endsWith('.arcgis.com');

/** ArcGIS Online organisation portals are "<org>.maps.arcgis.com". */
const AGOL_ORG = /^([a-z0-9-]+)\.maps\.arcgis\.com$/i;

/**
 * The ArcGIS Online organisation an address belongs to ('acme' for acme.maps.arcgis.com), or '' for
 * www.arcgis.com, a hosted-service host (services7.arcgis.com) or anything that isn't ArcGIS Online.
 */
export function arcgisOnlineOrg(url) {
  try { return (new URL(url).hostname.match(AGOL_ORG)?.[1] ?? '').toLowerCase(); }
  catch { return ''; }
}

/**
 * True when a token issued by tokenUrl may go with a request to url.
 * @param federatedHosts  { '<portal host>': ['<server host>', …] }: servers federated with a portal on another host
 *                        (a leading dot allows subdomains). Only https:// requests use them.
 */
export function tokenMaySendTo(url, tokenUrl, federatedHosts = {}) {
  let u, t;
  try { u = new URL(url); t = new URL(tokenUrl); } catch { return false; }
  if (u.origin === t.origin) return true;
  if (u.protocol !== 'https:' || t.protocol !== 'https:') return false;
  if (isArcGISOnlineHost(t.hostname)) {
    if (!isArcGISOnlineHost(u.hostname)) return false;
    // ArcGIS Online refuses one organisation's token at another organisation's portal with 403, so never send it
    // there: the request succeeds without it for a public item. www.arcgis.com and the hosted-service hosts ('')
    // take any organisation's token, and a token service we can't place an organisation for keeps its old reach.
    const to = arcgisOnlineOrg(u.href), from = arcgisOnlineOrg(t.href);
    return !to || !from || to === from;
  }
  const hosts = Object.entries(federatedHosts ?? {}).find(([portal]) => portal.toLowerCase() === t.hostname)?.[1] ?? [];
  return hosts.some(h => (h.startsWith('.') ? u.hostname.endsWith(h.toLowerCase()) : u.hostname === h.toLowerCase()));
}

/**
 * The manifest address a published viewer loads (?manifest=…), resolved against the page, or null when it isn't on
 * the viewer's own site: a link with someone else's manifest would show their content and services under this site's name.
 */
export function sameOriginUrl(path, pageUrl) {
  try {
    const page = new URL(pageUrl);
    const u = new URL(String(path ?? ''), page);
    return u.origin === page.origin ? u.href : null;
  } catch { return null; }
}

/**
 * True when the map SDK must read this portal without a sign-in. One ArcGIS Online organisation's token is
 * refused at another organisation's portal with 403 "not allowed for this account", and the SDK sends it anyway
 * (its IdentityManager treats the whole of arcgis.com as one sign-in) without retrying anonymously, so the web
 * map fails to load at all ("webmap:load-portal-item"). Reading that portal anonymously loads its public items.
 * api.js does the same thing for the app's own requests by retrying without the token.
 * @param tokenUrls  the token service of every sign-in held (auth.credentials())
 */
export function portalNeedsAnonymousRead(portalUrl, tokenUrls = []) {
  const org = arcgisOnlineOrg(portalUrl);
  if (!org) return false;                                   // not an ArcGIS Online organisation portal
  const signedIn = tokenUrls.map(arcgisOnlineOrg).filter(Boolean);
  return signedIn.length > 0 && !signedIn.includes(org);
}
