// dashboards.js — the viewer's Dashboards: a full-page view with one tab per dashboard and a grid of
// indicators, charts and tables. Numbers come from the server (map.statistics, map.dashboardRecords); charts are
// drawn with Chart.js, which ships with the app in vendor/chartjs (no CDN; loaded by chartLoader.js). Each item's width and height are grid
// columns and rows (dashboardItems.js). In the Draft preview, Arrange (handlers.arrange, from the Orchestrator)
// lets the author drag items around and resize them; a published viewer has no Arrange.
import { CONFIG } from './config.js';
import { el, fill, hexToRgb } from './utils.js';
import { spanOf, applyLayout, summaryRows, sortRows, TABLE_TYPES } from './dashboardItems.js';
import { loadChartJs } from './chartLoader.js';

/* ---------------- Colours from the viewer's accent ---------------- */
function hexToHsl(hex) {
  const [r, g, b] = hexToRgb(hex).map(v => v / 255);
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h = 0, s = 0;
  const l = (max + min) / 2;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    h *= 60;
  }
  return [h, s * 100, l * 100];
}

/** n distinct colours that start from the accent and step around the colour wheel. */
export function palette(accent, n) {
  const [h, s, l] = hexToHsl(accent || '#2B6F7F');
  return Array.from({ length: n }, (_, i) => {
    const hue = (h + i * 137.508) % 360;                     // golden-angle steps keep neighbours apart
    const light = Math.min(62, Math.max(34, l + (i % 3) * 8 - 4));
    return `hsl(${hue.toFixed(0)} ${Math.max(35, s).toFixed(0)}% ${light.toFixed(0)}%)`;
  });
}

/** A CSS colour (hex or hsl) at a given opacity. */
function withAlpha(colour, alpha) {
  const a = Math.max(0, Math.min(1, alpha ?? 1));
  if (/^#[0-9a-f]{6}$/i.test(colour)) { const [r, g, b] = hexToRgb(colour); return `rgba(${r}, ${g}, ${b}, ${a})`; }
  const m = colour.match(/^hsl\((.+)\)$/);
  return m ? `hsl(${m[1]} / ${a})` : colour;
}

const shorten = (text, max) => (text.length > max ? `${text.slice(0, Math.max(1, max - 1))}…` : text);

/** Draws each value on its bar, point or slice (no plugin library needed). */
const valueLabels = {
  id: 'valueLabels',
  afterDatasetsDraw(chart, _args, opts) {
    if (!opts?.enabled) return;
    const { ctx } = chart;
    const round = ['pie', 'doughnut'].includes(chart.config.type);
    const horizontal = chart.options.indexAxis === 'y';
    ctx.save();
    ctx.font = `600 11px ${opts.fontFamily}`;
    chart.data.datasets.forEach((ds, di) => {
      const total = ds.data.reduce((t, v) => t + (Number(v) || 0), 0);
      chart.getDatasetMeta(di).data.forEach((elmt, i) => {
        const v = ds.data[i];
        if (v == null) return;
        if (round && total && v / total < 0.05) return;        // too thin to label; the tooltip still shows it
        const text = opts.format(v);
        let { x, y } = elmt.tooltipPosition();
        if (round) {
          ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillStyle = '#fff';
          ctx.shadowColor = 'rgba(0,0,0,.35)'; ctx.shadowBlur = 3;
        } else if (horizontal) {
          ctx.textAlign = 'left'; ctx.textBaseline = 'middle'; ctx.fillStyle = opts.color; x += 6;
        } else {
          ctx.textAlign = 'center'; ctx.textBaseline = 'bottom'; ctx.fillStyle = opts.color; y -= 5;
        }
        ctx.fillText(text, x, y);
        ctx.shadowBlur = 0;
      });
    });
    ctx.restore();
  }
};

/* ---------------- Formatting ---------------- */
const STAT_LABEL = Object.fromEntries(CONFIG.dashboardStatistics);

function fmt(value, w) {
  const d = Number.isInteger(w.decimals) ? w.decimals : 0;
  const n = Number(value ?? 0).toLocaleString(CONFIG.numberLocale, { minimumFractionDigits: d, maximumFractionDigits: d });
  return `${w.prefix ?? ''}${n}${w.suffix ?? ''}`;
}

function describe(w, layerTitle) {
  if (w.type === 'records') return `Features${layerTitle ? `, ${layerTitle}` : ''}${w.where ? ' (filtered)' : ''}`;
  const what = w.statistic === 'count' ? 'Count' : `${STAT_LABEL[w.statistic]} of ${w.valueField}`;
  return `${what}${w.type !== 'indicator' ? ` by ${w.categoryField}` : ''}${layerTitle ? `, ${layerTitle}` : ''}${w.where ? ' (filtered)' : ''}`;
}

/** Sort, keep the top N, and fold the rest into "Other" where adding them up makes sense. */
function shape(rows, w) {
  const sorted = [...rows].sort(w.sort === 'label-asc'
    ? (a, b) => String(a.label).localeCompare(String(b.label), 'en-ZA', { numeric: true })
    : w.sort === 'value-asc' ? (a, b) => a.value - b.value : (a, b) => b.value - a.value);
  const top = Math.max(1, w.topN || 10);
  if (sorted.length <= top) return sorted;
  const kept = sorted.slice(0, top);
  if (w.statistic === 'count' || w.statistic === 'sum') {
    kept.push({ label: `Other (${sorted.length - top})`, value: sorted.slice(top).reduce((t, r) => t + r.value, 0) });
  }
  return kept;
}

/** An item card's width and height on the grid (narrow items widen on smaller screens; see app.css). */
export function setCardSpan(card, { cols, rows }) {
  card.style.setProperty('--cols', cols);
  card.style.setProperty('--rows', rows);
  card.classList.toggle('narrow', cols <= 4);
  card.dataset.cols = cols;
  card.dataset.rows = rows;
}

/**
 * A table whose column headings sort it (click again for the other way).
 * columns: [{ label, numeric }], rows: [{ cells: [{ text, raw }] }] in the order they should open.
 */
function sortableTable(columns, rows, caption) {
  let sort = null;
  const table = el('table', { class: 'dash-table' });
  const render = () => {
    const shown = sort ? sortRows(rows, sort.index, sort.dir) : rows;
    fill(table,
      el('caption', { class: 'sr-only' }, caption),
      el('thead', {}, el('tr', {}, columns.map((c, i) => el('th', {
        scope: 'col', class: c.numeric ? 'num' : '',
        'aria-sort': sort?.index === i ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'
      }, el('button', {
        type: 'button', title: 'Sort by this column',
        onclick: () => { sort = { index: i, dir: sort?.index === i && sort.dir === 'asc' ? 'desc' : 'asc' }; render(); }
      }, c.label, sort?.index === i ? (sort.dir === 'asc' ? ' ▲' : ' ▼') : ''))))),
      el('tbody', {}, shown.map(r => el('tr', {}, r.cells.map((cell, i) => el('td', { class: columns[i].numeric ? 'num' : '' }, cell.text))))));
  };
  render();
  return el('div', { class: 'dash-table-wrap' }, table);
}

/**
 * @param root      element the dashboards fill (the overlay)
 * @param handlers  { runStat(widget) -> Promise, layerTitle(key) -> string, onClose(),
 *                    arrange?: { attach(grid, { onChange(layout) }) -> detach(), save(dashboardId, layout) } (Draft preview only) }
 */
export function createDashboards(root, handlers) {
  let dashboards = [];
  let accent = '#2B6F7F';
  let active = 0;
  let charts = [];
  let arranging = false;
  let detachArrange = null;
  const cache = new Map();            // widget id -> Promise<result>

  const tabs = el('div', { class: 'dash-tabs', role: 'tablist', 'aria-label': 'Dashboards' });
  const desc = el('p', { class: 'dash-desc' });
  const arrangeHint = el('p', { class: 'dash-arrange-hint', hidden: true },
    'Drag ✥ to move an item, or its bottom-right corner to resize it. With the keyboard: focus ✥, then the arrow keys move it and Shift + arrow keys resize it. Changes go into the draft as you make them.');
  const grid = el('div', { class: 'dash-grid' });
  const arrangeBtn = handlers.arrange ? el('button', {
    type: 'button', class: 'btn quiet', 'aria-pressed': 'false',
    title: 'Drag items around and resize them (Draft preview only; the layout is saved to the draft)',
    onclick: () => setArranging(!arranging)
  }, 'Arrange') : null;
  root.replaceChildren(
    el('div', { class: 'dash-head' },
      tabs,
      el('div', { class: 'dash-actions' },
        arrangeBtn,
        el('button', { type: 'button', class: 'btn quiet', onclick: () => { cache.clear(); draw(); } }, 'Refresh'),
        el('button', { type: 'button', class: 'icon-btn dash-close', 'aria-label': 'Close dashboards', title: 'Close dashboards (back to the map)', onclick: () => handlers.onClose() }, '✕ Back to map'))),
    desc,
    arrangeHint,
    grid);

  const destroyCharts = () => { charts.forEach(c => c.destroy()); charts = []; };

  function stopArrange() { detachArrange?.(); detachArrange = null; }

  /** Arrange on the dashboard showing: each move or resize changes it here and in the draft. */
  function startArrange() {
    stopArrange();
    const d = dashboards[active];
    if (!arranging || !d?.widgets.length) return;
    detachArrange = handlers.arrange.attach(grid, {
      onChange(layout) {
        d.widgets = applyLayout(d.widgets, layout);
        handlers.arrange.save(d.id, layout);
      }
    });
  }

  function setArranging(on) {
    arranging = on && Boolean(handlers.arrange);
    if (arrangeBtn) {
      arrangeBtn.setAttribute('aria-pressed', String(arranging));
      arrangeBtn.textContent = arranging ? 'Done arranging' : 'Arrange';
    }
    arrangeHint.hidden = !arranging;
    grid.classList.toggle('arranging', arranging);
    if (arranging) startArrange(); else stopArrange();
  }

  async function drawWidget(card, w) {
    const body = card.querySelector('.dash-body');
    fill(body, el('p', { class: 'muted dash-loading' }, 'Loading…'));
    if (!cache.has(w.id)) cache.set(w.id, handlers.runStat(w).catch(e => { cache.delete(w.id); throw e; }));
    let res;
    try { res = await cache.get(w.id); }
    catch (e) { fill(body, el('p', { class: 'err' }, `Couldn't load: ${e.message}`)); return; }
    if (!card.isConnected) return;

    if (w.type === 'records') {
      if (!res.rows.length) { fill(body, el('p', { class: 'muted' }, 'No features to show.')); return; }
      const numeric = res.columns.map((_, i) => res.rows.some(r => typeof r.cells[i]?.raw === 'number') && !res.rows.some(r => typeof r.cells[i]?.raw === 'string'));
      fill(body, sortableTable(res.columns.map((c, i) => ({ label: c.label, numeric: numeric[i] })), res.rows, w.title || describe(w)),
        res.more ? el('p', { class: 'dash-table-note' }, `The first ${res.rows.length}; the layer holds more.`) : null);
      return;
    }
    if (w.type === 'indicator') {
      const text = fmt(res.value, w);
      const kpi = el('div', { class: `dash-kpi${text.length > 16 ? ' xl' : text.length > 11 ? ' long' : ''}`, title: text }, text);
      if (w.color) kpi.style.color = w.color;
      fill(body, el('div', { class: 'dash-kpi-wrap' }, kpi, w.caption ? el('p', { class: 'dash-caption' }, w.caption) : null));
      return;
    }
    const rows = shape(res.rows ?? [], w);
    if (!rows.length) { fill(body, el('p', { class: 'muted' }, `No data for this ${w.type === 'table' ? 'table' : 'chart'}.`)); return; }
    if (w.type === 'table') {
      const summary = summaryRows(rows, w.statistic);
      const hasShare = summary.some(r => r.share != null);
      const valueLabel = w.statistic === 'count' ? 'Count' : `${STAT_LABEL[w.statistic]} of ${res.valueLabel || w.valueField}`;
      const pct = v => `${(v * 100).toLocaleString(CONFIG.numberLocale, { maximumFractionDigits: 1 })}%`;
      fill(body, sortableTable(
        [{ label: res.categoryLabel || w.categoryField }, { label: valueLabel, numeric: true }, ...(hasShare ? [{ label: 'Share', numeric: true }] : [])],
        summary.map(r => ({ cells: [
          { text: String(r.label), raw: String(r.label) },
          { text: fmt(r.value, w), raw: r.value },
          ...(hasShare ? [{ text: r.share == null ? '—' : pct(r.share), raw: r.share }] : [])
        ] })),
        w.title || describe(w)));
      return;
    }

    let Chart;
    try { Chart = await loadChartJs(); }
    catch (e) { fill(body, el('p', { class: 'err' }, e.message)); return; }
    if (!card.isConnected) return;

    const fullLabels = rows.map(r => String(r.label));
    const labels = fullLabels.map(l => shorten(l, w.labelMaxLength || 24));
    const canvas = el('canvas', { role: 'img', 'aria-label': `${w.title || describe(w)}: ${rows.map(r => `${r.label} ${fmt(r.value, w)}`).join(', ')}` });
    fill(body, el('div', { class: 'dash-canvas' }, canvas));

    const round = w.type === 'pie' || w.type === 'doughnut';
    const line = w.type === 'line';
    const base = w.color || accent;
    const opacity = w.opacity ?? 0.85;
    const solid = (w.colorMode ?? (round ? 'palette' : 'single')) === 'palette' ? palette(base, rows.length) : rows.map(() => base);
    const fillColours = line ? withAlpha(base, w.fillArea === false ? 0 : Math.min(opacity, 1) * 0.25) : solid.map(c => withAlpha(c, opacity));
    const outline = w.outlineColor || (round ? '#FFFFFF' : base);
    const outlineWidth = Number.isInteger(w.outlineWidth) ? w.outlineWidth : (round || line ? 2 : 0);
    const fontFamily = getComputedStyle(document.body).fontFamily;
    Chart.defaults.font.family = fontFamily;
    Chart.defaults.color = '#5B6966';

    const legendPos = w.legend && w.legend !== 'auto' ? w.legend : 'bottom';
    const legendOn = w.legend === 'none' ? false : w.legend && w.legend !== 'auto' ? true : round;
    const axisTitle = text => (text ? { display: true, text, color: '#5B6966', font: { size: 11, weight: '600' } } : { display: false });
    const catAxis = w.type === 'hbar' ? 'y' : 'x';
    const valAxis = w.type === 'hbar' ? 'x' : 'y';

    charts.push(new Chart(canvas, {
      type: round ? w.type : line ? 'line' : 'bar',
      plugins: [valueLabels],
      data: {
        labels,
        datasets: [{
          label: STAT_LABEL[w.statistic],
          data: rows.map(r => r.value),
          backgroundColor: fillColours,
          borderColor: line ? base : round ? outline : (w.outlineColor || base),
          borderWidth: line ? Math.max(1, outlineWidth) : outlineWidth,
          borderRadius: round ? 0 : 4,
          hoverBackgroundColor: line ? undefined : solid,
          fill: line && w.fillArea !== false,
          tension: line && w.smooth !== false ? 0.3 : 0,
          pointRadius: line ? (w.pointSize ?? 3) : 0,
          pointBackgroundColor: base,
          pointBorderColor: w.outlineColor || '#fff'
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        indexAxis: w.type === 'hbar' ? 'y' : 'x',
        cutout: w.type === 'doughnut' ? `${w.cutout ?? 55}%` : undefined,
        animation: { duration: 300 },
        layout: { padding: { top: w.showValues && !round ? 18 : 4, right: w.showValues && w.type === 'hbar' ? 48 : 4 } },
        plugins: {
          legend: { display: legendOn, position: legendPos, labels: { boxWidth: 12, padding: 12 } },
          tooltip: { callbacks: {
            title: items => fullLabels[items[0]?.dataIndex] ?? '',
            label: ctx => ` ${fmt(ctx.parsed?.y ?? ctx.parsed?.x ?? ctx.parsed, w)}`
          } },
          valueLabels: { enabled: Boolean(w.showValues), format: v => fmt(v, w), color: '#1C2B30', fontFamily }
        },
        scales: round ? {} : {
          [catAxis]: { grid: { display: false }, title: axisTitle(w.type === 'hbar' ? w.yTitle : w.xTitle), ticks: { autoSkip: true, maxRotation: 45 } },
          [valAxis]: { beginAtZero: true, grid: { display: w.showGrid !== false, color: '#EEF2F1' }, title: axisTitle(w.type === 'hbar' ? w.xTitle : w.yTitle), ticks: { callback: v => fmt(v, { ...w, decimals: 0 }) } }
        }
      }
    }));
  }

  function draw() {
    destroyCharts();
    stopArrange();
    const d = dashboards[active];
    tabs.querySelectorAll('button').forEach((b, i) => b.setAttribute('aria-selected', String(i === active)));
    if (!d) { fill(grid, el('p', { class: 'pane-empty' }, 'No dashboards in this map.')); desc.hidden = true; return; }
    desc.textContent = d.description || '';
    desc.hidden = !d.description;
    if (!d.widgets.length) { fill(grid, el('p', { class: 'pane-empty' }, 'This dashboard has no charts, tables or indicators yet.')); return; }
    const cards = d.widgets.map(w => {
      const card = el('article', { class: `dash-card type-${w.type}${TABLE_TYPES.has(w.type) ? ' is-table' : ''}`, 'data-id': w.id },
        el('header', { class: 'dash-card-head' },
          el('h3', {}, w.title || describe(w)),
          el('span', { class: 'dash-sub' }, describe(w, handlers.layerTitle?.(w.layerKey)))),
        el('div', { class: 'dash-body' }));
      setCardSpan(card, spanOf(w));
      return card;
    });
    fill(grid, cards);
    d.widgets.forEach((w, i) => drawWidget(cards[i], w));
    startArrange();
  }

  return {
    /** Set the dashboards to show (from the manifest). */
    set(list, accentColour) {
      dashboards = list ?? [];
      accent = accentColour || accent;
      active = Math.min(active, Math.max(0, dashboards.length - 1));
      cache.clear();
      fill(tabs, dashboards.length > 1
        ? dashboards.map((d, i) => el('button', { type: 'button', role: 'tab', class: 'dash-tab', 'aria-selected': String(i === active), onclick: () => { active = i; draw(); } }, d.title))
        : dashboards[0] ? el('h2', { class: 'dash-title' }, dashboards[0].title) : null);
    },
    draw,
    destroy() { setArranging(false); destroyCharts(); }
  };
}
