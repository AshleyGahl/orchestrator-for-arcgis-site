// urlTrust.js — which addresses the app trusts: where a sign-in's token may be sent, and where a published viewer
// may load its manifest from. No DOM, no SDK, no imports.
//
// An ArcGIS Server names its own token service (…/rest/info → authInfo.tokenServicesUrl), so that answer alone can't
// decide where a token goes: any server could name your portal's token service and be sent your token. A token goes
// only to its own token service's origin, to ArcGIS Online's hosts for an ArcGIS Online sign-in, or to the servers
// listed for that portal in CONFIG.federatedHosts (servers federated with it on another host).

/** ArcGIS Online and its hosted services (an ArcGIS Online token works across all of them). */
export const isArcGISOnlineHost = hostname => hostname === 'arcgis.com' || String(hostname).endsWith('.arcgis.com');

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
  if (isArcGISOnlineHost(t.hostname)) return isArcGISOnlineHost(u.hostname);
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
