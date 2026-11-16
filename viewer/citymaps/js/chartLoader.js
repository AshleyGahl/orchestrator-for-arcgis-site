// chartLoader.js — loads the bundled Chart.js (vendor/chartjs, no CDN) once, for Dashboards and the Vegetation health
// tool, in its own scope so it doesn't clash with the ArcGIS SDK's AMD loader.

let chartLoad = null;

/**
 * Load the bundled Chart.js once, on first use.
 * The ArcGIS SDK puts an AMD loader (define.amd) on the page; Chart.js's UMD file would then register itself
 * with that loader instead of creating window.Chart. So the file is run in its own scope, with its own
 * module/exports and no `define`. Fallbacks: the SDK's own loader, then a plain script tag.
 */
export function loadChartJs() {
  if (window.Chart) return Promise.resolve(window.Chart);
  const url = new URL('../vendor/chartjs/chart.umd.min.js', import.meta.url).href;
  chartLoad ??= (async () => {
    let code = null;
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      code = await res.text();
    } catch (e) {
      throw new Error(`Chart.js couldn't load (vendor/chartjs/chart.umd.min.js: ${e.message}).`);
    }
    try {
      const module = { exports: {} };
      // eslint-disable-next-line no-new-func
      new Function('module', 'exports', 'define', code)(module, module.exports, undefined);
      const C = module.exports?.Chart?.register ? module.exports.Chart : module.exports;
      if (C?.register) return (window.Chart = C);
    } catch { /* a Content-Security-Policy without 'unsafe-eval' blocks this; try the loaders below */ }

    if (typeof window.require === 'function' && window.define?.amd) {
      const C = await new Promise((resolve, reject) => window.require([url], resolve, reject));
      if (C?.register) return (window.Chart = C);
    }
    await new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = url;
      s.onload = resolve;
      s.onerror = () => reject(new Error('Chart.js couldn\'t load.'));
      document.head.append(s);
    });
    if (window.Chart?.register) return window.Chart;
    throw new Error('Chart.js loaded but isn\'t usable on this page.');
  })().catch(e => { chartLoad = null; throw e; });
  return chartLoad;
}
