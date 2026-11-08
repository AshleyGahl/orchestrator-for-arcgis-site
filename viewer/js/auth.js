// auth.js — sign-in to secured portals and ArcGIS Servers with a username and password.
//
// Security rules:
//   - Passwords are sent once, straight to the server's own token service, and never kept.
//   - Only the short-lived token is kept, in sessionStorage (this browser tab, until it closes or expires).
//   - Nothing here is ever written into a manifest.
//   - A token only goes to the addresses it was issued for (urlTrust.js), whatever token service a server names.
import { CONFIG } from './config.js';
import { tokenMaySendTo } from './urlTrust.js';

const STORE_KEY = 'gis-orchestrator.tokens';
const listeners = new Set();
const infoCache = new Map();      // server root -> Promise<{ tokenUrl } | null>
let creds = load();               // key -> { key, label, tokenUrl, token, expires, user, servers: [] }

/**
 * Raised when a portal uses Windows (web-tier, IWA) sign-in: IIS answers 401 before the portal sees the
 * request, and there are no username/password tokens. Sign in with auth.signInWindows(target) instead.
 */
export class WindowsAuthRequired extends Error {
  constructor(target) {
    super(`${target.label} uses Windows sign-in (your network account), so there's no password to enter here.`);
    this.name = 'WindowsAuthRequired';
    this.target = target;
  }
}

/** Raised when a request needs a sign-in the app doesn't have yet. `target` says where to sign in. */
export class AuthRequiredError extends Error {
  constructor(target, message) {
    super(message ?? `Sign in to ${target.label} to use this.`);
    this.name = 'AuthRequiredError';
    this.target = target;
  }
}

/**
 * True when a request that failed without credentials gets an answer with them: IIS's bare 401 for Windows
 * sign-in carries no CORS headers, so the browser reports it as a failed (CORS) request, not a 401.
 */
export async function answersWithWindowsIdentity(url) {
  try { await fetch(url, { credentials: 'include' }); return true; } catch { return false; }
}

function load() {
  try {
    const all = JSON.parse(sessionStorage.getItem(STORE_KEY) || '{}');
    return Object.fromEntries(Object.entries(all).filter(([, c]) => c.expires > Date.now() + 30000));
  } catch { return {}; }
}

function save() {
  try { sessionStorage.setItem(STORE_KEY, JSON.stringify(creds)); } catch { /* storage blocked: memory only */ }
  for (const fn of listeners) fn(list());
}

export const onChange = fn => { listeners.add(fn); return () => listeners.delete(fn); };

/** ArcGIS Online tokens work across the org portal, www.arcgis.com and hosted services, so they share one key. */
function keyFor(tokenUrl) {
  const u = new URL(tokenUrl);
  return u.hostname.endsWith('.arcgis.com') || u.hostname === 'arcgis.com' ? 'arcgis.com' : `${u.origin}${u.pathname}`.toLowerCase();
}

/** The servers a token may be registered for: a server that named this token service but isn't trusted is dropped. */
const scoped = (tokenUrl, servers) => [...new Set(servers)].filter(s => tokenMaySendTo(s, tokenUrl, CONFIG.federatedHosts));

/** True when this sign-in's token may go with a request to url. */
export const tokenAllowed = (cred, url) => Boolean(cred?.tokenUrl) && tokenMaySendTo(url, cred.tokenUrl, CONFIG.federatedHosts);

function labelFor(tokenUrl) {
  const u = new URL(tokenUrl);
  return keyFor(tokenUrl) === 'arcgis.com' ? 'ArcGIS Online' : u.hostname;
}

/** Where a portal signs in. */
export function portalTarget(portalUrl) {
  const root = portalUrl.replace(/\/+$/, '').replace(/\/sharing\/rest.*$/i, '').replace(/\/home.*$/i, '');
  const tokenUrl = `${root}/sharing/rest/generateToken`;
  return { tokenUrl, key: keyFor(tokenUrl), label: labelFor(tokenUrl), servers: [`${root}/sharing/rest`] };
}

/**
 * Where a REST resource signs in: its portal (…/sharing/rest/…) or the token service an ArcGIS Server
 * advertises at …/rest/info. Returns null when the server isn't token-secured.
 */
export async function targetFor(url) {
  if (/\/sharing\/rest/i.test(url)) return portalTarget(url);
  const m = url.match(/^(https?:\/\/.+?)\/rest\//i);
  if (!m) return null;
  const root = m[1];
  if (!infoCache.has(root)) {
    const read = async opts => { const r = await fetch(`${root}/rest/info?f=json`, opts); return r.ok ? r.json() : { status: r.status }; };
    infoCache.set(root, (async () => {
      let j = await read({}).catch(() => ({ status: 401 }));   // IIS's bare 401 shows as a failed (CORS) request
      // Behind Windows sign-in, IIS answers 401 until the browser sends the user's network identity.
      if (j?.status === 401) j = await read({ credentials: 'include' });
      const tokenUrl = j?.authInfo?.tokenServicesUrl;
      return tokenUrl ? { tokenUrl } : j?.status === 401 ? { tokenUrl: `${root.replace(/\/server$|\/arcgis$/i, '')}/portal/sharing/rest/generateToken`, windowsGuess: true } : null;
    })().catch(() => null));
  }
  const info = await infoCache.get(root);
  if (!info) return null;
  return { tokenUrl: info.tokenUrl, key: keyFor(info.tokenUrl), label: labelFor(info.tokenUrl), servers: [`${root}/rest/services`] };
}

/** Exchange a username and password for a token. The password is not kept anywhere. */
export async function signIn(target, username, password) {
  if (!username || !password) throw new Error('Enter your username and password.');
  if (!/^https:/i.test(target.tokenUrl)) throw new Error('Sign-in needs an https:// server, so your password is never sent in the clear.');
  const body = new URLSearchParams({
    username, password, client: 'referer', referer: location.origin,
    expiration: String(CONFIG.tokenMinutes), f: 'json'
  });
  let json, res;
  try {
    res = await fetch(target.tokenUrl, { method: 'POST', body, headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
    json = await res.json().catch(() => null);
  } catch {
    if (await answersWithWindowsIdentity(target.tokenUrl.replace(/\/generateToken$/i, '/portals/self?f=json'))) throw new WindowsAuthRequired(target);
    throw new Error(`Couldn't reach ${target.label} to sign in.`);
  }
  // A bare HTTP 401 comes from IIS in front of the portal: Windows (web-tier) sign-in, not a wrong password.
  if (res.status === 401 && !json?.error) throw new WindowsAuthRequired(target);
  if (json?.error || !json?.token) {
    const msg = json?.error?.details?.[0] || json?.error?.message || 'Sign-in failed.';
    throw new Error(/invalid|incorrect/i.test(msg) ? 'That username or password is incorrect.' : msg);
  }
  const existing = creds[target.key];
  creds[target.key] = {
    key: target.key, label: target.label, tokenUrl: target.tokenUrl, token: json.token,
    expires: json.expires ?? Date.now() + CONFIG.tokenMinutes * 60000, user: username,
    servers: scoped(target.tokenUrl, [...(existing?.servers ?? []), ...(target.servers ?? []), ...(target.key === 'arcgis.com' ? ['https://www.arcgis.com/sharing/rest'] : [])])
  };
  save();
  return creds[target.key];
}

/**
 * Windows (web-tier / IWA) sign-in: the browser proves who you are with your network account.
 * Confirms the user with the portal, then asks for a token the same way; if the portal won't issue one,
 * requests to that server simply carry the Windows identity (credentials: 'include').
 */
export async function signInWindows(target) {
  const root = target.tokenUrl.replace(/\/sharing\/rest\/generateToken$/i, '');
  let self;
  try {
    const r = await fetch(`${root}/sharing/rest/portals/self?f=json`, { credentials: 'include' });
    if (r.status === 401) throw new Error(`Windows sign-in to ${target.label} was refused. Make sure you're signed in to the network and that ${new URL(root).host} is in your browser's intranet sites.`);
    self = await r.json();
  } catch (e) {
    if (e.message.startsWith('Windows sign-in')) throw e;
    throw new Error(`Couldn't reach ${target.label} with Windows sign-in. The portal must allow this site's address (${location.origin}) in its allowed origins.`);
  }
  const user = self?.user?.username;
  if (!user) throw new Error(`${target.label} didn't recognise your Windows account. Ask your portal administrator whether you have a portal account.`);

  let token = null, expires = Date.now() + CONFIG.tokenMinutes * 60000;
  try {
    const r = await fetch(target.tokenUrl, {
      method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client: 'referer', referer: location.origin, expiration: String(CONFIG.tokenMinutes), f: 'json' })
    });
    const j = await r.json();
    if (j?.token) { token = j.token; expires = j.expires ?? expires; }
  } catch { /* no token: requests carry the Windows identity instead */ }

  const u = new URL(root);
  creds[target.key] = {
    key: target.key, label: target.label, tokenUrl: target.tokenUrl, token, expires, user, windows: true,
    hosts: [u.host], servers: scoped(target.tokenUrl, [...(creds[target.key]?.servers ?? []), ...(target.servers ?? []), `${root}/sharing/rest`])
  };
  save();
  return creds[target.key];
}

/** Hosts where requests should carry the browser's Windows identity. */
export const windowsHosts = () => [...new Set(Object.values(creds).filter(c => c.windows && valid(c)).flatMap(c => c.hosts ?? []))];

export function signOut(key) {
  delete creds[key];
  save();
}

const valid = c => c && c.expires > Date.now() + 30000;

/** Signed-in sessions, for display (no tokens). */
export const list = () => Object.values(creds).filter(valid).map(({ key, label, user, expires, windows }) => ({ key, label, user, expires, windows }));

/** All valid credentials, for registering with the map SDK (servers re-checked, for sign-ins kept from before). */
export const credentials = () => Object.values(creds).filter(valid).map(c => ({ ...c, servers: scoped(c.tokenUrl, c.servers ?? []) }));

export function credentialFor(target) {
  return target ? (valid(creds[target.key]) ? creds[target.key] : null) : null;
}
