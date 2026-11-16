// exportForm.js — the Export panel every results table shares (Details, Search, spatial relationships, Attribute trace): Excel or
// CSV, every row (not just the page showing), and the columns people tick, the table's own ticked to start with.
// Excel files have a blue header row with a filter on every column (xlsx.js). Pure UI: the rows come from exportAll.
import { CONFIG } from './config.js';
import { el, toCsv, downloadText, downloadBlob, slug } from './utils.js';
import { toXlsx, sheetFromTable } from './xlsx.js';

let forms = 0;                          // numbers each form's radio group

/**
 * An Export button and its panel (hidden until the button opens it). Put `button` with the table's tools and
 * `panel` above the table.
 * @param opts {
 *   title       the table's name: the file name and the Excel sheet name
 *   total       how many rows an export holds (for "Export all N")
 *   choices     [{ name, label, shown }] (tableExport.js exportChoices); empty: no column choice, the table's columns
 *   exportAll(picked | null, { signal, onProgress(done, total) })  Promise of { columns: [{ name, label, kind }], rows }
 *   buttonClass the button's classes (default the small link style of the table tools)
 * }
 * @returns { button, panel }
 */
export function exportControl({ title, total, choices = [], exportAll, buttonClass = 'icon-btn csv-btn' }) {
  const n = v => Number(v ?? 0).toLocaleString(CONFIG.numberLocale);
  const group = `export-fmt-${++forms}`;
  const fmtXlsx = el('input', { type: 'radio', name: group, value: 'xlsx', checked: true });
  const fmtCsv = el('input', { type: 'radio', name: group, value: 'csv' });
  const boxes = choices.map(f => ({ f, box: el('input', { type: 'checkbox', value: f.name, checked: f.shown, onchange: () => counted() }) }));
  const setTicks = pick => { for (const x of boxes) x.box.checked = pick(x.f); counted(); };
  const tally = el('span', { class: 'count' });
  const status = el('p', { class: 'sw-export-status muted', role: 'status', 'aria-live': 'polite' });
  let controller = null;
  const go = el('button', { type: 'button', class: 'btn primary small', onclick: run }, `Export all ${n(total)}`);
  const cancel = el('button', {
    type: 'button', class: 'btn quiet small',
    onclick: () => { if (controller) controller.abort(); else toggle(false); }
  }, 'Cancel');

  function counted() {
    const on = boxes.filter(x => x.box.checked).length;
    tally.textContent = `${on} of ${boxes.length}`;
    go.disabled = Boolean(controller) || (boxes.length > 0 && on === 0);
  }

  async function run() {
    if (controller) return;
    controller = new AbortController();
    go.disabled = true;
    status.className = 'sw-export-status muted';
    status.textContent = `Reading ${n(total)} row${total === 1 ? '' : 's'}…`;
    try {
      const picked = boxes.length ? boxes.filter(x => x.box.checked).map(x => x.f.name) : null;
      const { columns, rows } = await exportAll(picked, {
        signal: controller.signal,
        onProgress: (done, all) => { status.textContent = `Read ${n(done)} of ${n(all)}…`; }
      });
      const file = slug(title);
      if (fmtCsv.checked) downloadText(toCsv(columns, rows), `${file}.csv`);
      else downloadBlob(toXlsx(sheetFromTable(title, columns, rows)), `${file}.xlsx`);
      status.textContent = `Exported ${n(rows.length)} row${rows.length === 1 ? '' : 's'}.`;
    } catch (e) {
      status.className = 'sw-export-status err';
      status.textContent = e?.name === 'AbortError' ? 'Export cancelled.' : `Couldn't export: ${e?.message ?? e}`;
    } finally {
      controller = null;
      counted();
    }
  }
  counted();

  const panel = el('div', { class: 'sw-export', role: 'group', 'aria-label': `Export ${title}`, hidden: true },
    el('div', { class: 'sw-export-row' },
      el('span', { class: 'sw-export-label' }, 'Format'),
      el('label', {}, fmtXlsx, ' Excel (.xlsx)'),
      el('label', {}, fmtCsv, ' CSV')),
    boxes.length ? el('div', { class: 'sw-export-extras' },
      el('div', { class: 'sw-export-row' },
        el('span', { class: 'sw-export-label' }, 'Columns'),
        tally,
        el('span', { class: 'sw-export-quick' },
          el('button', { type: 'button', class: 'icon-btn csv-btn', onclick: () => setTicks(f => f.shown) }, 'As shown'),
          el('button', { type: 'button', class: 'icon-btn csv-btn', onclick: () => setTicks(() => true) }, 'All'),
          el('button', { type: 'button', class: 'icon-btn csv-btn', onclick: () => setTicks(() => false) }, 'None'))),
      el('div', { class: 'sw-export-fields' }, boxes.map(({ f, box }) => el('label', { title: f.name }, box, ` ${f.label}`)))) : null,
    el('div', { class: 'sw-export-row' }, go, cancel),
    status);

  const button = el('button', {
    type: 'button', class: buttonClass, 'aria-expanded': 'false', title: 'Export every row as Excel or CSV',
    onclick: () => toggle(panel.hidden)
  }, 'Export…');

  function toggle(open) {
    panel.hidden = !open;
    button.setAttribute('aria-expanded', String(open));
    if (open) panel.querySelector('input')?.focus();
  }

  return { button, panel };
}
