// columnPicker.js — "which columns, in what order" for a results table (spatial relationship layers, related tables,
// search results, Attribute trace results): tick a field to show it, rename it, and move the chosen ones up and down.
// The chosen ones are listed first, in the order the viewer's table shows them; the rest follow in the layer's order.
// Pure UI; changes go out through onChange(next chosen list).
import { el } from './utils.js';

const key = name => String(name ?? '').toLowerCase();

/**
 * @param fields    the layer's or table's fields [{ name, alias }]
 * @param chosen    [{ name, label }] in display order; empty = the table's default columns
 * @param onChange  (next: [{ name, label }]) => void
 * @param title     the line above the table starts with this ('Columns', 'Result columns')
 * @param allText   the line above the table while none are chosen
 */
export function columnPicker({ fields, chosen = [], onChange, title = 'Columns', allText = `${title}: all fields. Tick to choose specific ones.` }) {
  const byName = new Map(fields.map(f => [key(f.name), f]));
  const picked = (chosen ?? []).filter(c => byName.has(key(c?.name)));   // fields the layer no longer has drop out on the next change
  const pickedKeys = new Set(picked.map(c => key(c.name)));
  const all = picked.length === 0;
  const labelOf = f => f.alias || f.name;
  const set = next => onChange(next.map(c => ({ ...c })));
  const move = (i, d) => { const next = [...picked]; [next[i], next[i + d]] = [next[i + d], next[i]]; set(next); };

  const row = (f, c, i) => el('tr', { class: all || c ? '' : 'is-off' },
    el('td', {}, el('input', {
      type: 'checkbox', checked: Boolean(c), 'aria-label': `Show ${labelOf(f)}`,
      onchange: e => set(e.target.checked ? [...picked, { name: f.name, label: labelOf(f) }] : picked.filter(x => key(x.name) !== key(f.name)))
    })),
    el('td', { class: 'fname' }, f.name),
    el('td', {}, el('input', {
      type: 'text', value: c?.label || labelOf(f), disabled: !c, 'aria-label': `Label for ${f.name}`,
      onchange: e => set(picked.map(x => (key(x.name) === key(f.name) ? { ...x, label: e.target.value.trim() || labelOf(f) } : x)))
    })),
    el('td', { class: 'col-order' }, c ? [
      el('button', { type: 'button', class: 'icon-btn', disabled: i === 0, title: 'Move up', 'aria-label': `Move ${c.label || f.name} up`, onclick: () => move(i, -1) }, '↑'),
      el('button', { type: 'button', class: 'icon-btn', disabled: i === picked.length - 1, title: 'Move down', 'aria-label': `Move ${c.label || f.name} down`, onclick: () => move(i, 1) }, '↓')
    ] : null));

  return el('div', { class: 'field column-picker' },
    el('span', {}, all ? allText : `${title}: ${picked.length} chosen, in this order${picked.length > 1 ? ' (↑ ↓ to reorder)' : ''}`),
    el('table', { class: 'field-table' },
      el('tbody', {},
        picked.map((c, i) => row(byName.get(key(c.name)), c, i)),
        fields.filter(f => !pickedKeys.has(key(f.name))).map(f => row(f, null, -1)))));
}
