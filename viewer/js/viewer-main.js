// viewer-main.js — entry point of a published GIS Viewer (viewer.html / index.html in a package).
// Loads manifest.json (or ?manifest=path, on this viewer's own site only), checks it, and runs the same viewer as the
// Orchestrator's preview.
import { CONFIG } from './config.js';
import * as api from './api.js';
import { upgrade, validate } from './manifest.js';
import { createViewerApp } from './viewerApp.js';
import { sameOriginUrl } from './urlTrust.js';

const els = {
  section: document.getElementById('view-viewer'),
  brand: document.getElementById('viewer-brand'),
  panel: document.getElementById('viewer-panel'),
  mapEl: document.getElementById('map')
};

const app = createViewerApp(els, {
  shareLink(view) {
    const u = new URL(location.href);
    u.searchParams.delete('center'); u.searchParams.delete('zoom');
    if (view) { u.searchParams.set('center', view.center.join(',')); u.searchParams.set('zoom', String(view.zoom)); }
    return u.toString();
  }
});

function fatal(message) {
  els.section.querySelector('.startup')?.remove();
  els.section.classList.add('failed');
  els.mapEl.replaceChildren(Object.assign(document.createElement('div'), { className: 'viewer-error', textContent: message }));
}

try {
  if (location.protocol === 'file:') throw new Error('Open this viewer through a web server (http:// or https://). Browsers don\'t run it straight from a file.');
  const manifestUrl = sameOriginUrl(CONFIG.manifestFile, location.href);
  if (!manifestUrl) throw new Error('This viewer only loads a manifest from its own site. Use ?manifest=path/to/manifest.json.');
  const m = upgrade(await api.getManifestFile(manifestUrl));
  const check = validate(m);
  if (!check.ok) throw new Error(`The viewer's ${CONFIG.manifestFile} has problems: ${check.errors.join(' ')}`);
  document.title = m.title;
  app.show(m);
  app.start();
} catch (e) {
  fatal(e.message.startsWith('Couldn\'t reach') || /404/.test(e.message) ? `Couldn't load ${CONFIG.manifestFile} next to this page. ${e.message}` : e.message);
}
