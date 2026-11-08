// streams.js — the Streaming widget's sections (Cameras, Drones, Tracking) and the pure helpers of its video sections:
// the kinds of stream a browser can play, checking and recognising stream addresses, embed addresses, snapshot reloads,
// the group gate and the proof-of-concept streams. Tracking's own helpers are in tracking.js; it shares the address
// check (addressProblem) and the group gate. No DOM, no SDK.

/**
 * The Streaming widget's sections, the words each one uses, and where its content comes from:
 *   manifest  the author lists it in settings (cameras: fixed stream addresses; tracking: feed addresses)
 *   viewer    the person watching pastes the address in the viewer for their session, so it's never stored in the
 *             manifest (drones: live addresses change per flight); settings can only offer the demo streams
 */
export const STREAMING_SECTIONS = {
  cameras:  { title: 'Cameras', item: 'camera', items: 'cameras', source: 'manifest', blurb: 'Live CCTV and webcam video' },
  drones:   { title: 'Drones', item: 'drone stream', items: 'drone streams', source: 'viewer', blurb: 'Live drone video from an address you paste' },
  tracking: { title: 'Tracking', item: 'feed', items: 'feeds', source: 'manifest', blurb: 'Vehicles, fleets and GPS trackers on the map' }
};
export const STREAMING_SECTION_IDS = Object.keys(STREAMING_SECTIONS);
/** The sections that play video (this module); Tracking draws on the map instead (tracking.js). */
export const VIDEO_SECTION_IDS = ['cameras', 'drones'];

export const STREAM_WIDTHS = [['half', 'Half: beside the map'], ['full', 'Full: over the map and the panel']];
export const isStreamWidth = id => STREAM_WIDTHS.some(([w]) => w === id);

export const STREAM_KINDS = [
  ['hls', 'Live video (HLS, .m3u8)'],
  ['video', 'Video file (MP4 or WebM)'],
  ['mjpeg', 'Motion JPEG (MJPEG)'],
  ['snapshot', 'Snapshot image, reloaded'],
  ['embed', 'Embedded player (YouTube, Vimeo)']
];
export const isStreamKind = id => STREAM_KINDS.some(([k]) => k === id);

export const REFRESH_MIN_S = 2;
export const REFRESH_MAX_S = 3600;
export const STREAMS_MAX = 50;

const parse = url => { try { return new URL(String(url ?? '').trim()); } catch { return null; } };
const isLocalHost = host => host === 'localhost' || host === '127.0.0.1' || host === '[::1]';
// Query parameters that carry a secret. A published manifest is readable by anyone who can open the viewer.
const SECRET_PARAM = /^(token|access_?token|key|api_?key|apikey|password|passwd|pwd|pass|secret|auth|user|username|credentials?)$/i;

const YOUTUBE_ID = /^[\w-]{6,20}$/;
/**
 * The address to put in an <iframe> for an embed stream, or null when it can't be embedded.
 * YouTube (watch, youtu.be, live, shorts, embed, a channel's live stream) and Vimeo links become their player
 * addresses, muted and playing. Any other address is used as it is when its host is on the list.
 * @param embedHosts  CONFIG.streamEmbedHosts
 */
export function embedSrc(url, embedHosts = []) {
  const u = parse(url);
  if (!u || u.protocol !== 'https:') return null;
  const host = u.hostname.toLowerCase().replace(/^(www\.|m\.)/, '');
  const allowed = embedHosts.some(h => {
    const x = String(h).toLowerCase().replace(/^www\./, '');
    return x.startsWith('.') ? host.endsWith(x) : host === x;
  });
  if (!allowed) return null;
  const parts = u.pathname.split('/').filter(Boolean);
  if (host === 'youtube.com' || host === 'youtube-nocookie.com' || host === 'youtu.be') {
    const yt = id => (YOUTUBE_ID.test(id || '') ? `https://www.youtube-nocookie.com/embed/${id}?autoplay=1&mute=1&playsinline=1` : null);
    if (host === 'youtu.be') return yt(parts[0]);
    if (parts[0] === 'embed' && parts[1] === 'live_stream') {
      const channel = u.searchParams.get('channel');
      return YOUTUBE_ID.test(channel || '') || /^UC[\w-]{10,30}$/.test(channel || '')
        ? `https://www.youtube.com/embed/live_stream?channel=${channel}&autoplay=1&mute=1` : null;
    }
    if (parts[0] === 'watch') return yt(u.searchParams.get('v'));
    if (['live', 'shorts', 'embed'].includes(parts[0])) return yt(parts[1]);
    return null;
  }
  if (host === 'vimeo.com' || host === 'player.vimeo.com') {
    const id = parts.find(p => /^\d+$/.test(p));
    return id ? `https://player.vimeo.com/video/${id}?autoplay=1&muted=1` : null;
  }
  return u.href;
}

/** How a stream is played, worked out from its address; null when it can't be told (the author chooses). */
export function detectKind(url, embedHosts = []) {
  const u = parse(url);
  if (!u || !/^https?:$/.test(u.protocol)) return null;
  if (embedSrc(url, embedHosts)) return 'embed';
  const path = u.pathname.toLowerCase();
  if (/\.m3u8$/.test(path)) return 'hls';
  if (/\.(mp4|m4v|webm|ogv|mov)$/.test(path)) return 'video';
  if (/mjpe?g|video\.cgi|faststream/.test(path + u.search.toLowerCase())) return 'mjpeg';
  if (/\.(jpe?g|png|webp|gif)$/.test(path) || /snapshot|image\.cgi|still/.test(path)) return 'snapshot';
  return null;
}

/**
 * Why this address can't be used from a published viewer, or '' when it can: http(s) only, https:// unless it's
 * localhost (for testing a gateway), no user name and password, and no token or key in the query (a manifest is
 * readable by anyone who can open the viewer). Shared by streams and tracking feeds.
 * @param noun       what the address points at, for the messages ('stream', 'feed')
 * @param secretsOk  true for an address pasted in the viewer: it's never stored or published
 */
export function addressProblem(url, { noun = 'stream', secretsOk = false } = {}) {
  const u = parse(url);
  if (!u || !/^https?:$/.test(u.protocol)) return 'The address must start with https://';
  if (u.protocol === 'http:' && !isLocalHost(u.hostname)) return 'Use an https:// address: a viewer on HTTPS can\'t load http:// addresses (only http://localhost is allowed, for testing).';
  if (u.username || u.password) return `Remove the user name and password from the address: anyone who can open the viewer can read it. Protect the ${noun} on its server instead.`;
  const secret = secretsOk ? null : [...u.searchParams.keys()].find(k => SECRET_PARAM.test(k));
  if (secret) return `Remove "${secret}=" from the address: anyone who can open the viewer can read it. Protect the ${noun} on its server instead.`;
  return '';
}

/**
 * Why this address can't be played as this kind of stream, or '' when it can.
 * @param embedHosts  CONFIG.streamEmbedHosts (embed streams only)
 * @param secretsOk   true for an address pasted in the viewer: it's never stored or published, so a token or key in
 *                    it is the person's own business (drone platforms often hand out signed addresses)
 */
export function streamUrlProblem(url, kind, embedHosts = [], { secretsOk = false } = {}) {
  const text = String(url ?? '').trim();
  if (!text) return 'Enter the stream address.';
  if (/^(rtsps?|rtmps?):/i.test(text)) {
    return 'Browsers can\'t play RTSP or RTMP. Ask the camera system for an HLS address (…m3u8), or put a gateway such as MediaMTX or go2rtc in front of the camera to re-publish it as HLS.';
  }
  const problem = addressProblem(text, { noun: 'stream', secretsOk });
  if (problem) return problem;
  const u = parse(text);
  if (!isStreamKind(kind)) return 'Choose how the stream is played.';
  if (kind === 'embed' && !embedSrc(text, embedHosts)) {
    return `${u.hostname} isn't a site streams can be embedded from, or the link isn't a video. Allowed: ${embedHosts.join(', ') || 'none'} (streamEmbedHosts in config.js).`;
  }
  return '';
}

/** The snapshot address with a changing parameter, so the browser fetches a new picture instead of its cached one. */
export function snapshotSrc(url, now = Date.now()) {
  const u = parse(url);
  if (!u) return url;
  u.searchParams.set('_t', String(now));
  return u.href;
}

/** A name for a stream pasted in the viewer without one: its server's name, e.g. "Stream from live.example.com". */
export function sessionStreamTitle(url) {
  const u = parse(url);
  return u ? `Stream from ${u.hostname}` : 'Live stream';
}

/** The demo drone streams as the viewer lists them (they live in code, not in the manifest), with stable ids. */
export const droneDemoStreams = () => DEMO_STREAMS.drones.map((d, i) => ({ id: `demo-drone-${i + 1}`, ...d }));

/** One line under a stream's name: how it plays. */
export function kindLabel(stream) {
  switch (stream?.kind) {
    case 'hls': return 'Live video';
    case 'video': return 'Recorded video';
    case 'mjpeg': return 'Motion JPEG';
    case 'snapshot': return `Snapshot every ${stream.refreshSeconds ?? 10} s`;
    case 'embed': return 'Embedded player';
    default: return '';
  }
}

export const isLonLat = c => Array.isArray(c) && c.length === 2 && c.every(v => typeof v === 'number' && Number.isFinite(v))
  && Math.abs(c[0]) <= 180 && Math.abs(c[1]) <= 90;

/**
 * May this person watch? With no group set, anyone who can open the viewer may.
 * @param self     the portal's community/self answer (username and groups when signed in), or null
 * @param groupId  the section's groupId (streaming.cameras, .drones or .tracking)
 * @returns { allowed, reason: 'open' | 'member' | 'signed-out' | 'not-member' }
 */
export function streamAccess(self, groupId) {
  const id = String(groupId ?? '').trim().toLowerCase();
  if (!id) return { allowed: true, reason: 'open' };
  if (!self?.username) return { allowed: false, reason: 'signed-out' };
  const member = (self.groups ?? []).some(g => String(g?.id ?? '').toLowerCase() === id);
  return { allowed: member, reason: member ? 'member' : 'not-member' };
}

/**
 * Public streams for trying the widgets out (HTTPS, CORS open; checked 2026-10-22). Live public streams come and
 * go: replace one in settings if it stops. Without id: manifest.newStream() gives each one.
 */
export const DEMO_STREAMS = {
  cameras: [
    {
      title: 'I-80 west of Ashby Avenue, Berkeley (demo)', kind: 'hls', refreshSeconds: 10,
      url: 'https://wzmedia.dot.ca.gov/D4/E80_JWO_ASHBY_Av.stream/playlist.m3u8', location: [-122.29806, 37.84672],
      description: 'A public Caltrans traffic camera, live.', credit: 'Caltrans (California Department of Transportation)'
    },
    {
      title: 'I-280 at 6th Street, San Francisco (demo)', kind: 'hls', refreshSeconds: 10,
      url: 'https://wzmedia.dot.ca.gov/D4/N280_at_6th.stream/playlist.m3u8', location: [-122.3974, 37.77145],
      description: 'A public Caltrans traffic camera, live.', credit: 'Caltrans (California Department of Transportation)'
    },
    {
      title: 'Bay Bridge east tower (demo snapshot)', kind: 'snapshot', refreshSeconds: 60,
      url: 'https://cwwp2.dot.ca.gov/data/d4/cctv/image/tvd32i80baybridgesastowereast/tvd32i80baybridgesastowereast.jpg', location: [-122.35855, 37.81526],
      description: 'A still picture the camera updates every minute or so.', credit: 'Caltrans (California Department of Transportation)'
    }
  ],
  drones: [
    {
      title: 'Hermanus coastline (demo, recorded flight)', kind: 'video', refreshSeconds: 10,
      url: 'https://upload.wikimedia.org/wikipedia/commons/transcoded/8/87/Hermanus_Coastline_from_the_air_with_a_City_view.webm/Hermanus_Coastline_from_the_air_with_a_City_view.webm.480p.vp9.webm',
      location: [19.2440, -34.4214],
      description: 'A recorded drone flight along the Hermanus coast, standing in for a live drone feed.', credit: 'SkyPixels, Wikimedia Commons, CC BY-SA 4.0'
    },
    {
      title: 'Live test signal 1 (demo)', kind: 'hls', refreshSeconds: 10,
      url: 'https://demo.unified-streaming.com/k8s/live/stable/live.isml/.m3u8', location: null,
      description: 'An always-on live HLS test stream, standing in for a drone gateway\'s output.', credit: 'Unified Streaming demo'
    },
    {
      title: 'Live test signal 2 (demo)', kind: 'hls', refreshSeconds: 10,
      url: 'https://ireplay.tv/test/blender.m3u8', location: null,
      description: 'An always-on live HLS test stream, standing in for a drone gateway\'s output.', credit: 'iReplay.tv test stream (Blender open movies)'
    }
  ]
};
