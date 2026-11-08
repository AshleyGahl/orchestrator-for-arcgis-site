// streamPlayer.js — plays one camera or drone stream into a node, by kind: HLS (hls.js, or the browser's own HLS),
// a video file, MJPEG, a snapshot reloaded every few seconds, or an embedded player in a sandboxed frame.
// hls.js ships with the app in vendor/hlsjs (no CDN) and is loaded on first use. Used by the viewer's stream window
// and by the Orchestrator's Test button.
import { el } from './utils.js';
import { embedSrc, snapshotSrc } from './streams.js';

let hlsLoad = null;

/**
 * Load the bundled hls.js once. Like Chart.js (dashboards.js): the ArcGIS SDK puts an AMD loader (define.amd) on the
 * page, and hls.js's UMD file would register with it instead of creating window.Hls, so it runs in its own scope.
 */
export function loadHls() {
  if (window.Hls?.isSupported) return Promise.resolve(window.Hls);
  const url = new URL('../vendor/hlsjs/hls.min.js', import.meta.url).href;
  hlsLoad ??= (async () => {
    const res = await fetch(url).catch(e => { throw new Error(`hls.js couldn't load (vendor/hlsjs/hls.min.js: ${e.message}).`); });
    if (!res.ok) throw new Error(`hls.js couldn't load (vendor/hlsjs/hls.min.js: ${res.status}).`);
    const code = await res.text();
    const module = { exports: {} };
    new Function('module', 'exports', 'define', `${code}\n//# sourceURL=${url}`)(module, module.exports, undefined);
    const H = module.exports?.default ?? module.exports;
    if (typeof H?.isSupported !== 'function') throw new Error('hls.js loaded but isn\'t usable on this page.');
    return (window.Hls = H);
  })().catch(e => { hlsLoad = null; throw e; });
  return hlsLoad;
}

const OFFLINE = 'The stream didn\'t answer. It may be offline, or its server doesn\'t allow this site to play it (CORS).';

/**
 * Start playing a stream. Returns { destroy() }; call it before playing another one, so nothing keeps downloading.
 * @param node     an empty element the player fills
 * @param stream   a manifest stream { url, kind, refreshSeconds, title }
 * @param options  { embedHosts, onState({ status: 'loading' | 'playing' | 'error', live?, text?, updated? }) }
 */
export function createPlayer(node, stream, { embedHosts = [], onState = () => {} } = {}) {
  let destroyed = false;
  const cleanups = [];
  const state = s => { if (!destroyed) onState(s); };
  state({ status: 'loading' });

  const videoEl = attrs => {
    const v = el('video', { class: 'stream-media', muted: true, autoplay: true, playsinline: true, controls: true, 'aria-label': stream.title || 'Stream', ...attrs });
    v.muted = true;                                   // autoplay only starts muted
    v.addEventListener('playing', () => state({ status: 'playing', live: !Number.isFinite(v.duration) || undefined }));
    cleanups.push(() => { v.pause(); v.removeAttribute('src'); v.load(); });
    node.replaceChildren(v);
    return v;
  };

  switch (stream.kind) {
    case 'hls': {
      const v = videoEl({});              // live streams have no end: hls.js reports their duration as Infinity
      loadHls().then(Hls => {
        if (destroyed) return;
        if (!Hls.isSupported()) {
          // No Media Source Extensions (older iPhones): the browser plays HLS itself, or not at all.
          if (!v.canPlayType('application/vnd.apple.mpegurl')) { state({ status: 'error', text: 'This browser can\'t play HLS video.' }); return; }
          v.src = stream.url;
          v.addEventListener('error', () => state({ status: 'error', text: OFFLINE }));
          v.play().catch(() => {});
          return;
        }
        const hls = new Hls({ liveDurationInfinity: true, lowLatencyMode: true, manifestLoadingMaxRetry: 2, levelLoadingMaxRetry: 2 });
        let recoveries = 0;
        hls.on(Hls.Events.MANIFEST_PARSED, () => v.play().catch(() => {}));
        hls.on(Hls.Events.ERROR, (_e, data) => {
          if (!data?.fatal) return;
          if (data.type === Hls.ErrorTypes.MEDIA_ERROR && recoveries++ < 2) { hls.recoverMediaError(); return; }
          state({ status: 'error', text: data.type === Hls.ErrorTypes.NETWORK_ERROR ? OFFLINE : `The video couldn't be played (${data.details}).` });
          hls.destroy();
        });
        hls.loadSource(stream.url);
        hls.attachMedia(v);
        cleanups.unshift(() => hls.destroy());
      }).catch(e => state({ status: 'error', text: e.message }));
      break;
    }
    case 'video': {
      const v = videoEl({ src: stream.url, loop: true, preload: 'auto' });
      v.addEventListener('error', () => state({ status: 'error', text: OFFLINE }));
      break;
    }
    case 'mjpeg':
    case 'snapshot': {
      const img = el('img', { class: 'stream-media', alt: stream.title || 'Camera picture' });
      const snapshot = stream.kind === 'snapshot';
      img.addEventListener('load', () => state({ status: 'playing', live: !snapshot || undefined, updated: snapshot ? new Date() : undefined }));
      img.addEventListener('error', () => state({ status: 'error', text: snapshot ? 'The picture didn\'t load. The camera may be offline; trying again shortly.' : OFFLINE }));
      img.src = snapshot ? snapshotSrc(stream.url) : stream.url;
      if (snapshot) {
        // Reload on a timer, but not while the tab is hidden (nobody is looking, so don't download).
        const timer = setInterval(() => { if (!document.hidden) img.src = snapshotSrc(stream.url); }, Math.max(2, stream.refreshSeconds || 10) * 1000);
        cleanups.push(() => clearInterval(timer));
      }
      cleanups.push(() => { img.removeAttribute('src'); });
      node.replaceChildren(img);
      break;
    }
    case 'embed': {
      const src = embedSrc(stream.url, embedHosts);
      if (!src) { state({ status: 'error', text: 'This link can\'t be embedded (its site isn\'t on the allowed list).' }); break; }
      const frame = el('iframe', {
        class: 'stream-media', src, title: stream.title || 'Embedded stream', allowfullscreen: true,
        allow: 'autoplay; encrypted-media; picture-in-picture; fullscreen', referrerpolicy: 'strict-origin-when-cross-origin',
        sandbox: 'allow-scripts allow-same-origin allow-presentation allow-popups'
      });
      frame.addEventListener('load', () => state({ status: 'playing' }));
      cleanups.push(() => { frame.src = 'about:blank'; });
      node.replaceChildren(frame);
      break;
    }
    default:
      state({ status: 'error', text: 'This stream has no playable kind.' });
  }

  return {
    destroy() {
      if (destroyed) return;
      destroyed = true;
      for (const fn of cleanups) { try { fn(); } catch { /* already gone */ } }
      node.replaceChildren();
    }
  };
}
