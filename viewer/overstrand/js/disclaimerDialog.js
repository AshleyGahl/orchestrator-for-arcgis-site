// disclaimerDialog.js — the disclaimer over the viewer: slides in from the left, drops in from the top or appears in the
// middle (disclaimer.transition), and stays until people accept. Everything else in the host is inert meanwhile, so
// keyboard and screen-reader users stay in the dialog. Also used by the Orchestrator's Disclaimer settings to play it
// in a small frame (contained: not modal for the page).
import { el } from './utils.js';
import { disclaimerBlocks } from './disclaimer.js';

const CLOSE_MS = 220;            // as .disclaimer.is-closing in app.css
let count = 0;

const inline = parts => parts.map(p => {
  if (p.br) return el('br');
  const t = p.href ? el('a', { href: p.href, target: '_blank', rel: 'noopener noreferrer' }, p.text) : p.text;
  return p.bold ? el('strong', {}, t) : t;
});

/** One block of disclaimerBlocks() as elements (text nodes only: nothing from the manifest is parsed as HTML). */
function block(b) {
  if (b.type === 'heading') return el('h3', {}, inline(b.parts));
  if (b.type === 'list') return el('ul', {}, b.items.map(i => el('li', {}, inline(i))));
  if (b.type === 'note') return el('p', { class: 'disclaimer-note' }, inline(b.parts));
  if (b.type === 'table') return el('div', { class: 'disclaimer-table' }, el('table', {},
    b.head ? el('thead', {}, el('tr', {}, b.head.map(c => el('th', { scope: 'col' }, inline(c))))) : null,
    el('tbody', {}, b.rows.map(r => el('tr', {}, r.map(c => el('td', {}, inline(c))))))));
  return el('p', {}, inline(b.parts));
}

/**
 * @param host       element to cover (position: relative or absolute)
 * @param d          the manifest's disclaimer block
 * @param onAccept   fn() once people accept
 * @param contained  true: a preview inside a frame (no focus trap for the page)
 * @returns { close() } to take it away without accepting
 */
export function showDisclaimer(host, d, { onAccept = () => {}, contained = false } = {}) {
  const id = `disclaimer-${++count}`;
  const blocks = disclaimerBlocks(d.text);
  const accept = el('button', { type: 'button', class: 'btn primary disclaimer-accept', onclick: () => { close(); onAccept(); } }, d.acceptLabel || 'I agree');
  const card = el('div', {
    class: `disclaimer-card text-${d.textSize ?? 'medium'}${blocks.some(b => b.type === 'table') ? ' is-wide' : ''}`, role: 'dialog', 'aria-modal': contained ? null : 'true',
    'aria-labelledby': `${id}-title`, 'aria-describedby': `${id}-text`
  },
    el('h2', { class: 'disclaimer-title', id: `${id}-title` }, d.title || 'Disclaimer'),
    el('div', { class: 'disclaimer-text', id: `${id}-text`, tabindex: '0' }, blocks.map(block)),
    el('div', { class: 'disclaimer-actions' }, accept));
  const overlay = el('div', { class: `disclaimer from-${d.transition ?? 'center'} speed-${d.speed ?? 'medium'}${contained ? ' is-contained' : ''}` }, card);

  // Tab and Shift+Tab go round the dialog; Escape doesn't dismiss it (people must accept).
  card.addEventListener('keydown', e => {
    if (e.key === 'Escape') { e.preventDefault(); return; }
    if (e.key !== 'Tab') return;
    const stops = [...card.querySelectorAll('a[href], button, [tabindex="0"]')];
    const first = stops[0], last = stops[stops.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  });

  const madeInert = contained ? [] : [...host.children].filter(c => !c.inert);
  madeInert.forEach(c => { c.inert = true; });
  const before = document.activeElement;
  host.append(overlay);
  accept.focus({ preventScroll: true });

  let closed = false;
  function close() {
    if (closed) return;
    closed = true;
    madeInert.forEach(c => { c.inert = false; });
    overlay.classList.add('is-closing');
    setTimeout(() => overlay.remove(), CLOSE_MS);
    if (!contained && before instanceof HTMLElement && before.isConnected) before.focus({ preventScroll: true });
  }
  return { close };
}
