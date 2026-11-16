// traceForm.js — the form for one Attribute trace: its name, the layer it starts from, its steps (where each step's
// values come from, the field read, the layer and field matched, filters, optional, case) and the results' columns,
// with the engine's own checks underneath. Shared by Orchestration (traceEditor.js) and the viewer's own traces
// (traceWindow.js), so it ships in the viewer. Also draws a trace as a chain of layers (traceChain). Pure UI: layer
// fields come in through fieldsOf, edits go out through onEdit(mutator).
import { el } from './utils.js';
import { columnPicker } from './columnPicker.js';
import { newTraceStep } from './manifest.js';
import { fieldKind, operatorsFor, operatorLabel, OPERATORS } from './query.js';
import { checkTrace, traceLimits, sourcesOf, START } from './trace.js';

/**
 * A trace as a chain: the start layer, then each step's layer with how it's matched (and, after a run, its count).
 * @param trace    a trace
 * @param titleOf  layer key -> its title
 * @param counts   optional Map(stepId -> { count, status }) from a run
 */
export function traceChain(trace, titleOf, counts = null) {
  const steps = trace.steps ?? [];
  const nameOf = id => (id === START ? titleOf(trace.startLayer) || 'the start' : `step ${steps.findIndex(s => s.id === id) + 1}`);
  return el('ol', { class: 'trace-chain' },
    el('li', { class: 'trace-link is-start' },
      el('span', { class: 'trace-link-layer' }, titleOf(trace.startLayer) || 'Choose a start layer'),
      el('span', { class: 'trace-link-how' }, 'Starting feature')),
    steps.map((s, i) => {
      const c = counts?.get(s.id);
      const from = sourcesOf(s);
      return el('li', { class: `trace-link${c ? ` is-${c.status}` : ''}` },
        el('span', { class: 'trace-link-layer' }, `${i + 1}. ${titleOf(s.targetLayer) || 'Choose a layer'}`,
          c ? el('span', { class: 'badge trace-count' }, c.count.toLocaleString('en-US')) : null),
        el('span', { class: 'trace-link-how' },
          `${s.sourceField || '?'} = ${s.targetField || '?'}`,
          from.length > 1 || from[0] !== (i ? steps[i - 1].id : START) ? ` (from ${from.map(nameOf).join(' + ')})` : '',
          s.filters?.length ? `, ${s.filters.length} filter${s.filters.length === 1 ? '' : 's'}` : '',
          s.optional ? ', optional' : ''));
    }));
}

/**
 * @param trace     the trace being edited
 * @param layers    [{ key, title, label? }] the layers it may use (label: a longer name with its group)
 * @param fieldsOf  layer key -> null | { status: 'loading'|'ready'|'error'|'auth', fields: [{ name, alias, type }], error? }
 *                  (the owner loads the fields and draws the form again when they arrive)
 * @param limits    the project's trace limits (maxSteps)
 * @param onEdit    fn(mutator) — the mutator receives the trace
 */
export function traceForm({ trace, layers, fieldsOf, limits, onEdit }) {
  const lim = traceLimits(limits);
  const steps = trace.steps ?? [];
  const layerName = key => { const l = layers.find(x => x.key === key); return l ? l.label ?? l.title : key; };
  const ready = key => (key && fieldsOf(key)?.status === 'ready' ? fieldsOf(key).fields : null);
  const layerOfSource = id => (id === START ? trace.startLayer : steps.find(s => s.id === id)?.targetLayer);

  const layerSelect = (value, label, onchange) => el('select', { 'aria-label': label, onchange: e => onchange(e.target.value) },
    el('option', { value: '', selected: !value }, 'Choose a layer'),
    value && !layers.some(l => l.key === value) ? el('option', { value, selected: true }, `${value} (not in the map)`) : null,
    layers.map(l => el('option', { value: l.key, selected: l.key === value }, l.label ?? l.title)));

  /** A field picker: keys must be text or numbers; a field that's gone stays listed so it can be seen and changed. */
  function fieldSelect(value, fields, label, onchange, { keysOnly = true } = {}) {
    if (!fields) return el('select', { 'aria-label': label, disabled: true }, el('option', {}, value || 'Choose the layer first'));
    const usable = fields.filter(f => (keysOnly ? ['text', 'number'].includes(fieldKind(f.type)) : fieldKind(f.type)));
    return el('select', { 'aria-label': label, onchange: e => onchange(e.target.value) },
      el('option', { value: '', selected: !value }, 'Choose a field'),
      value && !usable.some(f => f.name.toLowerCase() === value.toLowerCase()) ? el('option', { value, selected: true }, `${value} (not found)`) : null,
      usable.map(f => el('option', { value: f.name, selected: f.name.toLowerCase() === value?.toLowerCase() }, f.alias && f.alias !== f.name ? `${f.alias} (${f.name})` : f.name)));
  }

  /** Fields every source of a step has (a step that combines several layers reads the same field from each). */
  function sourceFields(step) {
    const lists = sourcesOf(step).map(id => ready(layerOfSource(id)));
    if (!lists.length || lists.some(l => !l)) return null;
    return lists[0].filter(f => lists.every(l => l.some(g => g.name.toLowerCase() === f.name.toLowerCase())));
  }

  const fieldsNote = key => {
    const st = key ? fieldsOf(key) : null;
    if (!st || st.status === 'ready') return null;
    if (st.status === 'loading') return el('p', { class: 'status' }, `Reading the fields of ${layerName(key)}…`);
    return el('p', { class: 'status err' }, `The fields of ${layerName(key)} couldn't be read: ${st.error}`);
  };

  function filterRow(step, i, c, j) {
    const fields = ready(step.targetLayer);
    const f = fields?.find(x => x.name.toLowerCase() === c.field?.toLowerCase());
    const kind = f ? fieldKind(f.type) : null;
    const ops = kind ? operatorsFor(kind) : Object.keys(OPERATORS);
    const editF = fn => onEdit(t => fn(t.steps[i].filters[j]));
    const arity = OPERATORS[c.op]?.arity ?? 1;
    return el('div', { class: 'trace-filter' },
      fieldSelect(c.field, fields, `Step ${i + 1} filter ${j + 1} field`, v => editF(x => { x.field = v; }), { keysOnly: false }),
      el('select', { 'aria-label': `Step ${i + 1} filter ${j + 1} operator`, onchange: e => editF(x => { x.op = e.target.value; }) },
        ops.map(op => el('option', { value: op, selected: op === c.op }, operatorLabel(op, kind)))),
      arity >= 1 ? el('input', { type: kind === 'date' ? 'date' : 'text', value: c.value ?? '', 'aria-label': `Step ${i + 1} filter ${j + 1} value`, onchange: e => editF(x => { x.value = e.target.value; }) }) : null,
      arity === 2 ? el('input', { type: kind === 'date' ? 'date' : 'text', value: c.value2 ?? '', 'aria-label': `Step ${i + 1} filter ${j + 1} second value`, onchange: e => editF(x => { x.value2 = e.target.value; }) }) : null,
      el('button', { type: 'button', class: 'icon-btn danger', 'aria-label': `Remove filter ${j + 1}`, onclick: () => onEdit(t => { t.steps[i].filters.splice(j, 1); }) }, '×'));
  }

  function stepCard(step, i) {
    const edit = fn => onEdit(t => fn(t.steps[i]));
    const from = sourcesOf(step);
    const sources = [[START, `The starting feature (${layerName(trace.startLayer) || 'start layer'})`],
      ...steps.slice(0, i).map((s, k) => [s.id, `Step ${k + 1}: ${layerName(s.targetLayer) || 'no layer yet'}`])];
    const move = d => onEdit(t => { const [s] = t.steps.splice(i, 1); t.steps.splice(i + d, 0, s); });
    return el('li', { class: 'trace-step' },
      el('div', { class: 'lc-head' },
        el('strong', { class: 'grow' }, `Step ${i + 1}`),
        // Moving a step above one it takes values from would break it: those moves are off.
        el('button', { class: 'icon-btn', type: 'button', disabled: i === 0 || from.includes(steps[i - 1].id), 'aria-label': `Move step ${i + 1} up`, onclick: () => move(-1) }, '↑'),
        el('button', { class: 'icon-btn', type: 'button', disabled: i === steps.length - 1 || sourcesOf(steps[i + 1]).includes(step.id), 'aria-label': `Move step ${i + 1} down`, onclick: () => move(1) }, '↓'),
        el('button', { class: 'icon-btn danger', type: 'button', 'aria-label': `Remove step ${i + 1}`,
          onclick: () => onEdit(t => {
            t.steps.splice(i, 1);
            for (const s of t.steps) { const f = sourcesOf(s).filter(x => x !== step.id); s.from = f.length ? (f.length === 1 ? f[0] : f) : START; }
          }) }, 'Remove')),
      el('fieldset', { class: 'trace-from' },
        el('legend', {}, 'Read values from'),
        sources.map(([id, label]) => el('label', { class: 'check-row' },
          el('input', { type: 'checkbox', checked: from.includes(id),
            onchange: e => edit(s => {
              const next = e.target.checked ? [...sourcesOf(s), id] : sourcesOf(s).filter(x => x !== id);
              const ordered = sources.map(([x]) => x).filter(x => next.includes(x));
              s.from = ordered.length > 1 ? ordered : ordered[0] ?? START;
            }) }), label))),
      el('div', { class: 'fields two' },
        el('label', { class: 'field' }, from.length > 1 ? 'Field to read (on each of those layers)' : 'Field to read',
          fieldSelect(step.sourceField, sourceFields(step), `Step ${i + 1} field to read`, v => edit(s => { s.sourceField = v; }))),
        el('label', { class: 'field' }, 'Find features in',
          layerSelect(step.targetLayer, `Step ${i + 1} layer`, v => edit(s => { s.targetLayer = v; s.targetField = ''; s.filters = []; })))),
      el('div', { class: 'fields two' },
        el('label', { class: 'field' }, 'Whose field',
          fieldSelect(step.targetField, ready(step.targetLayer), `Step ${i + 1} field to match`, v => edit(s => { s.targetField = v; }))),
        el('div', { class: 'field' }, 'Matches',
          el('label', { class: 'check-row' }, el('input', { type: 'checkbox', checked: step.caseInsensitive, onchange: e => edit(s => { s.caseInsensitive = e.target.checked; }) }), 'Ignore upper and lower case'),
          el('label', { class: 'check-row' }, el('input', { type: 'checkbox', checked: step.optional, onchange: e => edit(s => { s.optional = e.target.checked; }) }), "Optional: carry on when it finds nothing"))),
      fieldsNote(step.targetLayer),
      el('div', { class: 'trace-filters' },
        (step.filters ?? []).map((c, j) => filterRow(step, i, c, j)),
        el('button', { type: 'button', class: 'btn quiet', disabled: !ready(step.targetLayer),
          onclick: () => edit(s => { (s.filters ??= []).push({ field: '', op: 'eq', value: '' }); }) }, 'Add a filter')));
  }

  // Checks with the fields read so far: until a layer's fields arrive, only the shape of the trace is checked.
  const keys = [...new Set([trace.startLayer, ...steps.map(s => s.targetLayer)].filter(Boolean))];
  const allReady = keys.length && keys.every(k => ready(k));
  const { errors, warnings } = checkTrace(trace, { limits: lim, fieldsOf: allReady ? new Map(keys.map(k => [k, ready(k)])) : null });
  const last = steps.at(-1);
  const lastFields = last ? ready(last.targetLayer) : null;

  return el('div', { class: 'trace-form' },
    el('div', { class: 'fields two' },
      el('label', { class: 'field' }, 'Name',
        el('input', { type: 'text', value: trace.title, placeholder: 'e.g. Water maintenance impact', onchange: e => onEdit(t => { t.title = e.target.value.trim(); }) })),
      el('label', { class: 'field' }, 'What the results are called',
        el('input', { type: 'text', value: trace.resultLabel, placeholder: 'e.g. connected properties', onchange: e => onEdit(t => { t.resultLabel = e.target.value.trim(); }) }))),
    el('label', { class: 'field' }, 'Description (optional)',
      el('input', { type: 'text', value: trace.description, onchange: e => onEdit(t => { t.description = e.target.value.trim(); }) })),
    el('label', { class: 'field' }, 'Starts from a feature of',
      layerSelect(trace.startLayer, 'Start layer', v => onEdit(t => { t.startLayer = v; }))),
    fieldsNote(trace.startLayer),
    el('label', { class: 'check-row' },
      el('input', { type: 'checkbox', checked: trace.confirmsImpact, onchange: e => onEdit(t => { t.confirmsImpact = e.target.checked; }) }),
      'The filters encode the operational rules, so results are affected, not just linked'),
    el('p', { class: 'hint' }, 'Leave this off unless the steps\' filters really decide impact (closed valves, the work order\'s zone, switch states). Matching keys shows features are linked; it doesn\'t prove a physical connection or an outage.'),

    el('p', { class: 'sub-head' }, `Steps (${steps.length} of at most ${lim.maxSteps})`),
    steps.length ? el('ol', { class: 'row-list trace-steps' }, steps.map(stepCard)) : el('p', { class: 'empty' }, 'No steps yet. Add the first one below.'),
    el('div', { class: 'btn-row' },
      el('button', { class: 'btn', type: 'button', disabled: steps.length >= lim.maxSteps,
        onclick: () => onEdit(t => { t.steps.push(newTraceStep({ from: t.steps.at(-1)?.id ?? START })); }) },
      'Add a step')),

    last ? (lastFields
      ? columnPicker({
        fields: lastFields.filter(f => fieldKind(f.type)), chosen: trace.finalFields, title: 'Columns in the results',
        allText: `Columns in the results (from ${layerName(last.targetLayer) || 'the last step\'s layer'}): none chosen, so the matched field. Tick to choose them.`,
        onChange: next => onEdit(t => { t.finalFields = next; })
      })
      : el('div', { class: 'field' }, 'Columns in the results', fieldsNote(last.targetLayer))) : null,

    errors.length || warnings.length ? el('ul', { class: 'checks trace-checks' },
      errors.map(t => el('li', { class: 'e' }, t)), warnings.map(t => el('li', { class: 'w' }, t))) : el('p', { class: 'status ok' }, allReady ? 'The trace checks out.' : ''));
}
