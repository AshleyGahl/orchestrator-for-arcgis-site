// editWindow.js — the Editing window over the map. It lists the records of an editable layer that are in the
// map's view (listed again whenever people pan or zoom) and opens a form for the record people click.
// It opens over half the map (the form on the side the author chose, the map on the other, with a drag handle like
// Swipe) or over the whole map. The template (editing.js) decides how records are listed and how the form opens.
// Pure UI: records come in; selections, saves and the map's padding go out through handlers.
import { el, fill, halfWindowLeft } from './utils.js';
import { dataTable } from './resultsView.js';
import {
  EDIT_WIDTHS, inputKind, toInputValue, readForm, changedAttributes, newRecordValues,
  resolveForm, ruleValues, ruleFields, smartSteps
} from './editing.js';
import { stackWindow } from './windowStack.js';

const RELOAD_DELAY_MS = 300;
const RULE_DELAY_MS = 350;      // smart forms: redraw this long after typing pauses in a field other rules look at
const HALF_MIN = 0.3, HALF_MAX = 0.7;

/**
 * @param host      the positioned element to float in (.viewer-body)
 * @param handlers  {
 *   load(layer) -> Promise<{ title, rows, total, truncated, fields, columns, can: { add, update, remove } }>
 *       rows: [{ id, title, items: [{ label, text }], cells: { [name]: { text, raw } }, attributes, graphic }]
 *       fields: the form (editing.formFields); groups: the layer's smart form groups; columns: [{ name, label }] for the Table template
 *   format(formField, value) -> text   a read-only value as people read it
 *   onSelect(row)                      a record was chosen (highlight it on the map)
 *   onZoom(row)
 *   draw(layer) -> Promise<geometry|null>, cancelDraw()     Add: people draw the new feature first
 *   save(layer, row, changes), add(layer, geometry, attributes), remove(layer, row)  -> Promise
 *   onPadding({ left?, right? })       keep the visible map clear of the window
 *   onOpenChange(open)
 *   preview: true in the Orchestrator's draft preview (saving still changes the real data)
 * }
 */
export function createEditWindow(host, handlers) {
  let config = null;              // manifest.editing
  let layerIndex = 0;
  let width = 'half';
  let side = 'left';              // which side the half-width window takes (the author's choice)
  let ratio = 0.5;                // share of the map the half-width window takes
  let data = null;                // the last load() result
  let state = 'idle';             // idle | loading | ready | error
  let errorText = '';
  let filter = '';
  let selectedId = null;
  let form = null;                // { mode: 'edit' | 'add', row, values, errors, step, geometry, busy, message, dirty, folded }
  let note = '';                  // a short message under the toolbar (saved, deleted, nothing here…)
  let seq = 0;
  let reloadTimer = null;

  const layer = () => config?.layers[layerIndex] ?? null;
  const template = () => config?.template ?? 'classic';

  /* ---------- Frame ---------- */
  const titleEl = el('h3', { class: 'ew-title', id: 'ew-title' }, 'Editing');
  const subEl = el('p', { class: 'ew-sub', role: 'status' });
  const layerPick = el('select', { class: 'ew-layer', 'aria-label': 'Layer to edit', onchange: e => switchLayer(Number(e.target.value)) });
  const sizeBtns = new Map(EDIT_WIDTHS.map(([id, label]) => [id, el('button', {
    type: 'button', 'aria-pressed': 'false', title: label, onclick: () => setWidth(id)
  }, id === 'half' ? 'Half' : 'Full')]));
  const head = el('header', { class: 'ew-head' },
    el('div', { class: 'ew-head-text' }, titleEl, subEl),
    layerPick,
    el('div', { class: 'fields-as small ew-sizes', role: 'group', 'aria-label': 'Window width' }, [...sizeBtns.values()]),
    el('button', { type: 'button', class: 'icon-btn ew-close', 'aria-label': 'Close editing', onclick: () => close() }, '×'));
  const notice = el('p', { class: 'ew-preview', hidden: !handlers.preview },
    'Draft preview: saving here changes the real data in the layer.');
  const filterIn = el('input', {
    type: 'search', placeholder: 'Filter these records', 'aria-label': 'Filter the records in view', class: 'grow',
    oninput: e => { filter = e.target.value.trim().toLowerCase(); paintRecords(); }
  });
  const addBtn = el('button', { type: 'button', class: 'btn primary small', onclick: () => startAdd() }, 'Add');
  const noteEl = el('p', { class: 'ew-note', role: 'status' });
  const toolbar = el('div', { class: 'ew-toolbar' }, filterIn, addBtn);
  const records = el('div', { class: 'ew-records' });
  const formHost = el('div', { class: 'ew-form-host' });
  const main = el('div', { class: 'ew-main' }, records, formHost);
  const handle = el('div', {
    class: 'ew-handle', role: 'separator', tabindex: 0, 'aria-orientation': 'vertical', 'aria-label': 'Drag to resize the form and the map',
    'aria-valuemin': HALF_MIN * 100, 'aria-valuemax': HALF_MAX * 100
  }, el('span', { class: 'ew-grip', 'aria-hidden': 'true' }));
  const win = el('section', { class: 'edit-window', role: 'region', 'aria-labelledby': 'ew-title', tabindex: -1, hidden: true },
    head, notice, toolbar, noteEl, main, handle);
  host.append(win);
  stackWindow(win);                     // the window opened or clicked last is on top (windowStack.js)

  win.addEventListener('keydown', e => {
    if (e.key !== 'Escape') return;
    e.stopPropagation();
    if (form) closeForm(); else close();
  });
  window.addEventListener('resize', () => { if (!win.hidden) layout(); });

  /* ---------- Size and position: over the map, never over the panel ---------- */
  const mapRect = () => {
    const hostR = host.getBoundingClientRect(), m = (host.querySelector('.map') ?? host).getBoundingClientRect();
    return { left: m.left - hostR.left, top: m.top - hostR.top, width: m.width, height: m.height };
  };
  const effectiveWidth = () => (mapRect().width < 640 ? 'full' : width);

  function layout() {
    const m = mapRect();
    const w = effectiveWidth();
    win.dataset.width = w;
    win.dataset.side = side;
    win.dataset.template = template();
    for (const [id, b] of sizeBtns) b.setAttribute('aria-pressed', String(id === w));
    const px = w === 'full' ? m.width : Math.round(m.width * ratio);
    win.style.width = `${px}px`;
    win.style.height = `${m.height}px`;
    win.style.top = `${m.top}px`;
    win.style.left = `${w === 'half' ? halfWindowLeft(m, px, side) : m.left}px`;
    handle.hidden = w !== 'half';
    handle.setAttribute('aria-valuenow', String(Math.round(ratio * 100)));
    // The map's centre and extent use the part the window leaves clear, so "in view" means what people can see.
    handlers.onPadding?.(w === 'half' ? { [side]: px } : {});
  }

  function setWidth(id) {
    width = EDIT_WIDTHS.some(([w]) => w === id) ? id : 'half';
    layout();
    scheduleReload();
  }

  // Drag the inner edge to share the space between form and map, like the Swipe tool's handle.
  handle.addEventListener('pointerdown', e => {
    e.preventDefault();
    handle.setPointerCapture(e.pointerId);
    win.classList.add('is-resizing');
    const move = ev => {
      const m = mapRect(), hostR = host.getBoundingClientRect();
      const x = ev.clientX - hostR.left - m.left;
      ratio = Math.min(HALF_MAX, Math.max(HALF_MIN, (side === 'left' ? x : m.width - x) / m.width));
      layout();
    };
    const up = () => {
      handle.removeEventListener('pointermove', move); handle.removeEventListener('pointerup', up);
      win.classList.remove('is-resizing');
      scheduleReload();
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
  });
  handle.addEventListener('keydown', e => {
    const step = { ArrowLeft: -0.05, ArrowRight: 0.05 }[e.key];
    if (step == null) return;
    e.preventDefault();
    ratio = Math.min(HALF_MAX, Math.max(HALF_MIN, ratio + (side === 'left' ? step : -step)));
    layout();
    scheduleReload();
  });

  /* ---------- Records ---------- */
  function scheduleReload() {
    clearTimeout(reloadTimer);
    reloadTimer = setTimeout(reload, RELOAD_DELAY_MS);
  }

  async function reload() {
    const l = layer();
    if (!l || win.hidden) return;
    const mine = ++seq;
    state = data ? state : 'loading';
    paintHead();
    if (!data) paintRecords();
    try {
      const d = await handlers.load(l);
      if (mine !== seq) return;            // a newer pan or zoom has already asked again
      data = d; state = 'ready'; errorText = '';
    } catch (e) {
      if (mine !== seq) return;
      state = 'error'; errorText = e.message; data = null;
    }
    paintHead();
    paintRecords();               // the form is left alone, so people can keep typing while the map moves
  }

  function switchLayer(i) {
    if (form?.dirty && !confirm('Discard the changes in the form?')) { layerPick.value = String(layerIndex); return; }
    if (form?.mode === 'add') handlers.cancelDraw?.();
    layerIndex = i; data = null; selectedId = null; form = null; note = ''; filter = ''; filterIn.value = '';
    paintForm();
    reload();
  }

  function paintHead() {
    const l = layer();
    const title = data?.title || l?.title || 'Editing';
    titleEl.textContent = `Editing: ${l?.title || title}`;
    subEl.textContent = state === 'loading' ? 'Reading the records in view…'
      : state === 'error' ? 'The records couldn\'t be read.'
      : data ? (data.total === 0 ? 'No records in this part of the map. Pan or zoom to find some.'
        : data.truncated ? `The newest ${data.rows.length} of ${data.total.toLocaleString()} records in view. Zoom in to see the rest.`
        : `${data.total} record${data.total === 1 ? '' : 's'} in view. Pan or zoom to see others.`)
      : '';
    layerPick.hidden = (config?.layers.length ?? 0) < 2;
    addBtn.hidden = !(l?.allowAdd && data?.can.add);
    noteEl.textContent = note;
    noteEl.hidden = !note;
  }

  const matches = r => !filter || [r.title, ...r.items.map(i => i.text)].join(' ').toLowerCase().includes(filter);

  function recordButton(r, big = false) {
    return el('li', {}, el('button', {
      type: 'button', class: `ew-record${big ? ' big' : ''}`, 'aria-pressed': String(r.id === selectedId),
      onclick: () => openRecord(r)
    },
    el('span', { class: 'ew-record-title' }, r.title),
    r.items.length ? el('span', { class: 'ew-record-items' }, r.items.map(i => el('span', {}, el('span', { class: 'muted' }, `${i.label}: `), i.text))) : null));
  }

  function recordCard(r) {
    return el('li', {}, el('button', { type: 'button', class: 'ew-card', 'aria-pressed': String(r.id === selectedId), onclick: () => openRecord(r) },
      el('span', { class: 'ew-record-title' }, r.title),
      r.items.length ? el('dl', {}, r.items.map(i => [el('dt', {}, i.label), el('dd', {}, i.text)])) : null));
  }

  function paintRecords() {
    if (state === 'loading' && !data) { fill(records, el('p', { class: 'muted ew-empty' }, 'Reading the records in view…')); return; }
    if (state === 'error') { fill(records, el('p', { class: 'err ew-empty' }, `Couldn't read the records: ${errorText}`)); return; }
    if (!data) { fill(records); return; }
    const rows = data.rows.filter(matches);
    if (!rows.length) {
      fill(records, el('p', { class: 'muted ew-empty' }, data.rows.length ? 'No record in view matches the filter.' : 'No records in this part of the map. Pan or zoom to find some.'));
      return;
    }
    const t = template();
    if (t === 'grid') {
      fill(records, dataTable({ columns: data.columns, rows, selectedId, label: `Records of ${data.title}`, onSelect: r => openRecord(r) }));
    } else if (t === 'cards') {
      fill(records, el('ul', { class: 'ew-cards' }, rows.map(recordCard)));
    } else {
      fill(records, el('ul', { class: 'ew-list' }, rows.map(r => recordButton(r, t === 'guided'))));
    }
  }

  /* ---------- The form ---------- */
  const textValues = (fields, attrs) => Object.fromEntries(fields.map(ff => {
    const v = attrs?.[ff.name] ?? attrs?.[Object.keys(attrs ?? {}).find(k => k.toLowerCase() === ff.name.toLowerCase())];
    return [ff.name, toInputValue(inputKind(ff.field), v)];
  }));

  function openRecord(r) {
    if (form?.dirty && form.row?.id !== r.id && !confirm('Discard the changes in the form?')) return;
    if (form?.mode === 'add') handlers.cancelDraw?.();
    selectedId = r.id;
    handlers.onSelect?.(r);
    form = { mode: 'edit', row: r, values: textValues(data?.fields ?? [], r.attributes), errors: {}, step: 0, busy: false, message: '', dirty: false, folded: startFolded() };
    paintRecords();
    paintForm({ focus: true });
  }

  async function startAdd() {
    const l = layer();
    if (!l || !data?.can.add) return;
    if (form?.dirty && !confirm('Discard the changes in the form?')) return;
    if (effectiveWidth() === 'full') setWidth('half');     // people need to see the map to draw on it
    form = null;
    paintForm();
    note = 'Draw the new feature on the map. Press Esc on the map to cancel.';
    paintHead();
    let geometry = null;
    try { geometry = await handlers.draw(l); }
    catch (e) { note = `Drawing failed: ${e.message}`; paintHead(); return; }
    note = '';
    paintHead();
    if (!geometry) return;
    const fields = data?.fields ?? [];
    form = { mode: 'add', row: null, values: textValues(fields, newRecordValues(fields)), errors: {}, step: 0, geometry, busy: false, message: '', dirty: true, folded: startFolded() };
    selectedId = null;
    paintRecords();
    paintForm({ focus: true });
  }

  function closeForm({ force = false } = {}) {
    if (!form) return;
    if (!force && form.dirty && !confirm('Discard the changes in the form?')) return;
    if (form.mode === 'add') handlers.cancelDraw?.();
    form = null;
    paintForm();
  }

  const canUpdate = () => Boolean(layer()?.allowUpdate && data?.can.update);
  // ff is a resolved field (editing.resolveForm): its editable already includes any "editable when" rule.
  const editableNow = ff => ff.editable && (form?.mode === 'add' || canUpdate());

  /* Smart forms: groups, and rules on other fields' values. */
  const groupsOf = () => data?.groups ?? [];
  const startFolded = () => new Set(groupsOf().filter(g => g.collapsed).map(g => g.id));
  const resolved = () => {
    const fields = data?.fields ?? [];
    return resolveForm(fields, groupsOf(), ruleValues(fields, form.values, form.row?.attributes ?? {}));
  };
  // A field other rules look at: when its value changes, draw the form again, keeping the focus and the caret where
  // they were. Drop-downs redraw at once; typed fields once typing pauses (never on blur, which could swallow a click).
  let ruleTimer = 0;
  let pressing = false;           // a pointer is down in the form: wait, so a click on Save isn't lost to a redraw
  formHost.addEventListener('pointerdown', () => { pressing = true; });
  window.addEventListener('pointerup', () => { pressing = false; });
  window.addEventListener('pointercancel', () => { pressing = false; });
  function ruleChanged(name, { wait = false } = {}) {
    clearTimeout(ruleTimer);
    if (!form || !ruleFields(data?.fields ?? [], groupsOf()).has(name.toLowerCase())) return;
    if (wait || pressing) { ruleTimer = setTimeout(() => ruleChanged(name), RULE_DELAY_MS); return; }
    const active = document.activeElement;
    const id = formHost.contains(active) ? active.id : '';
    let caret = null;
    try { caret = id && active.selectionStart != null ? [active.selectionStart, active.selectionEnd] : null; } catch { /* date inputs have no caret */ }
    // Errors a rule has taken away: a field now hidden or read-only, or "Required." on one no longer required.
    for (const ff of resolved().fields) {
      const e = form.errors[ff.name];
      if (e && (!ff.visible || !editableNow(ff) || (e === 'Required.' && !ff.required))) delete form.errors[ff.name];
    }
    if (!Object.keys(form.errors).length && /^Check /.test(form.message)) form.message = '';
    paintForm();
    const again = id ? document.getElementById(id) : null;
    if (!again) return;
    again.focus({ preventScroll: true });
    if (caret) try { again.setSelectionRange(...caret); } catch { /* not a text input */ }
  }

  function control(ff, big) {
    const kind = inputKind(ff.field);
    const id = `ew-f-${ff.name}`;
    const value = form.values[ff.name] ?? '';
    const onInput = e => { form.values[ff.name] = e.target.value; form.dirty = true; if (form.errors[ff.name]) { delete form.errors[ff.name]; e.target.removeAttribute('aria-invalid'); e.target.parentElement.querySelector('.ew-field-err')?.remove(); } };
    const onPick = e => { onInput(e); ruleChanged(ff.name); };                    // other fields' rules may now differ
    const onType = e => { onInput(e); ruleChanged(ff.name, { wait: true }); };
    const described = [ff.hint ? `${id}-hint` : null, form.errors[ff.name] ? `${id}-err` : null].filter(Boolean).join(' ');
    const common = { id, class: big ? 'big' : null, 'aria-invalid': form.errors[ff.name] ? 'true' : null, 'aria-describedby': described || null, required: ff.required || null };
    if (!editableNow(ff)) {
      const raw = form.row?.attributes ? Object.entries(form.row.attributes).find(([k]) => k.toLowerCase() === ff.name.toLowerCase())?.[1] : null;
      return el('div', { class: 'ew-readonly', id }, handlers.format(ff, raw));
    }
    switch (kind) {
      case 'select': return el('select', { ...common, onchange: onPick },
        el('option', { value: '' }, ff.required ? 'Choose…' : '—'),
        (ff.field.domain?.codedValues ?? []).map(c => el('option', { value: String(c.code), selected: String(c.code) === value }, c.name)));
      case 'textarea': return el('textarea', { ...common, rows: big ? 4 : 3, maxlength: ff.field.length || null, oninput: onType }, value);
      case 'date': return el('input', { ...common, type: 'datetime-local', value, oninput: onType });
      case 'date-only': return el('input', { ...common, type: 'date', value, oninput: onType });
      case 'integer': case 'number': return el('input', { ...common, type: 'text', inputmode: kind === 'integer' ? 'numeric' : 'decimal', value, oninput: onType });
      default: return el('input', { ...common, type: 'text', maxlength: ff.field.length || null, value, oninput: onType });
    }
  }

  function fieldRow(ff, big) {
    const range = ff.field.domain?.type === 'range' ? ff.field.domain : null;
    return el('div', { class: `ew-field${editableNow(ff) ? '' : ' is-readonly'}` },
      el('label', { for: `ew-f-${ff.name}` }, ff.label, ff.required && editableNow(ff) ? el('span', { class: 'ew-req', 'aria-hidden': 'true' }, ' *') : null),
      control(ff, big),
      ff.hint ? el('span', { class: 'ew-hint muted', id: `ew-f-${ff.name}-hint` }, ff.hint) : null,
      range && editableNow(ff) ? el('span', { class: 'muted' }, `${range.minValue} to ${range.maxValue}`) : null,
      form.errors[ff.name] ? el('span', { class: 'ew-field-err err', id: `ew-f-${ff.name}-err` }, form.errors[ff.name]) : null);
  }

  async function submit() {
    const l = layer();
    // Only fields people can see and change are read: hidden ones keep the record's value and are never required.
    const now = resolved();
    const { attributes, errors } = readForm(now.fields.filter(ff => ff.visible && editableNow(ff)), form.values);
    form.errors = errors;
    if (Object.keys(errors).length) {
      // Guided: go to the first step with a problem. Other templates: unfold the groups with one.
      if (template() === 'guided') form.step = smartSteps(now.sections).findIndex(s => s.fields.some(ff => errors[ff.name]));
      for (const sec of now.sections) if (sec.group && sec.fields.some(ff => errors[ff.name])) form.folded.delete(sec.group.id);
      form.message = 'Check the highlighted fields.';
      paintForm({ focus: true });
      return;
    }
    let changes = attributes;
    if (form.mode === 'edit') {
      changes = changedAttributes(form.row.attributes, attributes);
      if (!Object.keys(changes).length) { form.message = 'Nothing has changed.'; paintForm(); return; }
    }
    form.busy = true; form.message = 'Saving…'; paintForm();
    try {
      if (form.mode === 'add') await handlers.add(l, form.geometry, attributes);
      else await handlers.save(l, form.row, changes);
      note = form.mode === 'add' ? 'Added. The new record is in the list.' : `Saved ${form.row.title}.`;
      const keep = template() === 'split' && form.mode === 'edit' ? form.row.id : null;
      form = null;
      await reload();
      const again = keep != null ? data?.rows.find(r => r.id === keep) : null;
      if (again) openRecord(again); else paintForm();
    } catch (e) {
      form.busy = false; form.message = `Not saved: ${e.message}`; paintForm();
    }
  }

  async function remove() {
    if (!confirm(`Delete ${form.row.title}? This can't be undone.`)) return;
    form.busy = true; form.message = 'Deleting…'; paintForm();
    try {
      await handlers.remove(layer(), form.row);
      note = `Deleted ${form.row.title}.`;
      form = null; selectedId = null;
      paintForm();
      await reload();
    } catch (e) { form.busy = false; form.message = `Not deleted: ${e.message}`; paintForm(); }
  }

  function paintForm({ focus = false } = {}) {
    const t = template();
    const split = t === 'split';
    win.classList.toggle('form-open', Boolean(form) && !split);
    if (!form) {
      fill(formHost, split ? el('div', { class: 'ew-dialog inline' }, el('p', { class: 'muted ew-empty' }, 'Choose a record to see and edit it here.')) : null);
      return;
    }
    const l = layer();
    const fields = data?.fields ?? [];
    const guided = t === 'guided';
    const now = resolved();
    const steps = guided ? smartSteps(now.sections) : null;
    const stepCount = steps?.length ?? 1;
    form.step = Math.min(Math.max(form.step, 0), stepCount - 1);
    const last = form.step === stepCount - 1;
    const editing = form.mode === 'add' || canUpdate();
    const canDelete = form.mode === 'edit' && l?.allowDelete && data?.can.remove;

    const dialogHead = el('header', { class: 'ew-dialog-head' },
      el('div', {},
        el('h4', { id: 'ew-form-title' }, form.mode === 'add' ? `New record: ${data?.title ?? ''}` : form.row.title),
        el('p', { class: 'muted' }, form.mode === 'add' ? 'Fill in the form, then save.' : editing ? 'Change the values, then save.' : 'View only: this layer can\'t be updated here.')),
      form.mode === 'edit' ? el('button', { type: 'button', class: 'icon-btn', onclick: () => handlers.onZoom?.(form.row) }, 'Zoom to') : null,
      el('button', { type: 'button', class: 'icon-btn ew-close', 'aria-label': 'Close the form', onclick: () => closeForm() }, '×'));

    const stepLabel = guided ? steps[form.step].label : '';
    const progress = guided && (stepCount > 1 || stepLabel) ? el('div', { class: 'ew-steps' },
      el('span', {}, `Step ${form.step + 1} of ${stepCount}`, stepLabel ? [': ', el('strong', { class: 'ew-step-label' }, stepLabel)] : null),
      el('span', { class: 'ew-progress', 'aria-hidden': 'true' }, el('span', { style: `width:${Math.round(((form.step + 1) / stepCount) * 100)}%` }))) : null;

    // Groups are sections that fold (in Guided each group is a step); hidden fields and groups aren't drawn.
    const cls = `ew-fields${t === 'cards' ? ' two' : ''}`;
    const section = sec => {
      const rows = sec.fields.filter(ff => ff.visible).map(ff => fieldRow(ff, false));
      if (!sec.group) return el('div', { class: cls }, rows);
      const det = el('details', { class: 'ew-group', open: !form.folded.has(sec.group.id) },
        el('summary', {}, sec.group.label, sec.fields.some(ff => ff.visible && form.errors[ff.name]) ? el('span', { class: 'ew-req' }, ' (check)') : null),
        el('div', { class: cls }, rows));
      det.addEventListener('toggle', () => { if (det.open) form.folded.delete(sec.group.id); else form.folded.add(sec.group.id); });
      return det;
    };
    const body = !fields.length ? el('div', { class: cls }, el('p', { class: 'muted' }, 'This layer has no fields to show.'))
      : guided ? el('div', { class: cls }, steps[form.step].fields.map(ff => fieldRow(ff, true)))
      : el('div', { class: 'ew-sections' }, now.sections.filter(sec => sec.visible).map(section));

    const back = guided && form.step > 0 ? el('button', { type: 'button', class: 'btn', onclick: () => { form.step--; paintForm({ focus: true }); } }, 'Back') : null;
    const next = guided && !last ? el('button', { type: 'button', class: 'btn primary', onclick: () => { form.step++; paintForm({ focus: true }); } }, 'Next') : null;
    const save = editing && (!guided || last) ? el('button', { type: 'submit', class: 'btn primary', disabled: form.busy }, form.mode === 'add' ? 'Add record' : 'Save') : null;
    const footer = el('footer', { class: 'ew-dialog-foot' },
      canDelete ? el('button', { type: 'button', class: 'btn quiet danger ew-delete', disabled: form.busy, onclick: remove }, 'Delete') : null,
      el('p', { class: `ew-msg${/^Not |Check /.test(form.message) ? ' err' : ''}`, role: 'status' }, form.message),
      split ? null : el('button', { type: 'button', class: 'btn quiet', onclick: () => closeForm() }, editing ? 'Cancel' : 'Close'),
      back, next, save);

    const kind = split ? 'inline' : t === 'grid' ? 'sheet' : t === 'cards' ? 'centered wide' : 'centered';
    const dialog = el('form', {
      class: `ew-dialog ${kind}${guided ? ' guided' : ''}`, role: split ? 'region' : 'dialog', 'aria-modal': split ? null : 'true', 'aria-labelledby': 'ew-form-title', novalidate: true,
      onsubmit: e => { e.preventDefault(); if (!form.busy) submit(); }
    }, dialogHead, progress, body, footer);
    fill(formHost, split ? null : el('div', { class: 'ew-scrim', onclick: () => closeForm() }), dialog);
    if (focus) (dialog.querySelector('[aria-invalid="true"]') ?? dialog.querySelector('input, select, textarea') ?? dialog.querySelector('button'))?.focus({ preventScroll: true });
  }

  /* ---------- Open and close ---------- */
  function open() {
    if (!config?.layers.length) return;
    const wasHidden = win.hidden;
    win.hidden = false;
    layout();
    if (wasHidden) { handlers.onOpenChange?.(true); reload(); }
    win.focus({ preventScroll: true });
  }

  function close() {
    if (win.hidden) return;
    if (form?.dirty && !confirm('Discard the changes in the form?')) return;
    if (form?.mode === 'add') handlers.cancelDraw?.();
    form = null; selectedId = null; note = '';
    paintForm();
    win.hidden = true;
    seq++;
    clearTimeout(reloadTimer);
    handlers.onPadding?.({});
    handlers.onOpenChange?.(false);
  }

  return {
    /** The manifest's editing settings (call on every manifest; closes the window). */
    set(editing) {
      close();
      config = editing?.layers?.length ? editing : null;
      width = editing?.width ?? 'half';
      side = editing?.side === 'right' ? 'right' : 'left';
      ratio = 0.5;
      layerIndex = 0; data = null; state = 'idle'; filter = ''; filterIn.value = '';
      fill(layerPick, (config?.layers ?? []).map((l, i) => el('option', { value: i }, l.title || l.layerKey)));
    },
    /** Layer titles from the map, once it has loaded ({ [layerKey]: title }). */
    setTitles(titles) {
      for (const [i, l] of (config?.layers ?? []).entries()) if (!l.title && titles[l.layerKey]) layerPick.options[i].textContent = titles[l.layerKey];
    },
    open,
    close,
    toggle: () => (win.hidden ? open() : close()),
    isOpen: () => !win.hidden,
    hasLayers: () => Boolean(config?.layers.length),
    /** The map came to rest after a pan or zoom: list the records in view again. */
    viewChanged: () => { if (!win.hidden) scheduleReload(); },
    activeLayer: layer,
    /** A record people clicked on the map. */
    openRow: row => { if (!win.hidden) openRecord(row); },
    /** A short message under the toolbar (e.g. "Nothing to edit here"). */
    say: text => { note = text; paintHead(); }
  };
}
