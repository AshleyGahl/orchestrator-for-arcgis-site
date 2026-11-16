// layerInfoPane.js — the viewer's Layer information pane: one accordion section per layer that has information, in
// layer order, with the author's rows and (when switched on) facts read from the layer's service, loaded the first
// time a section opens. A filter box narrows the list. Pure UI: data comes in, service reads go out through loadService.
import { el, fill } from './utils.js';
import { infoRows } from './layerInfo.js';

/** Text with its links: [{ text, href? }] from layerInfo.js (only https: and mailto: hrefs reach here). */
const linkedText = parts => parts.map(p => (p.href ? el('a', { href: p.href, target: p.href.startsWith('mailto:') ? null : '_blank', rel: 'noopener' }, p.text) : p.text));
const list = rows => el('dl', { class: 'about-list' }, rows.map(r => [el('dt', {}, r.label), el('dd', {}, linkedText(r.parts))]));

/**
 * @param body         the pane's body
 * @param loadService  key => Promise<{ facts: [{ label, value, href? }] }>
 * @returns {{ set(layers) }}  layers: [{ key, title, info }] in layer order, only those with information
 */
export function createLayerInfoPane(body, { loadService }) {
  function section({ key, title, info }, index) {
    const rows = infoRows(info);
    const serviceBox = info.service ? el('div', { class: 'about-service' }) : null;
    const content = el('div', { class: 'acc-body', id: `info-${index}-${Math.random().toString(36).slice(2, 7)}`, hidden: true },
      rows.length ? list(rows) : null,
      serviceBox);
    let loaded = false;
    async function loadFacts() {
      if (loaded || !serviceBox) return;
      loaded = true;
      const sub = el('p', { class: 'about-sub' }, 'From the service');
      fill(serviceBox, rows.length ? sub : null, el('p', { class: 'muted' }, 'Reading the service…'));
      try {
        const { facts } = await loadService(key);
        fill(serviceBox, rows.length ? sub : null,
          facts.length ? list(facts.map(f => ({ label: f.label, parts: f.href ? [{ text: f.value, href: f.href }] : [{ text: f.value }] })))
            : el('p', { class: 'muted' }, 'This layer has no service to read.'));
      } catch (e) {
        loaded = false;
        fill(serviceBox, rows.length ? sub : null, el('p', { class: 'muted' }, `Couldn't read the service: ${e.message}`));
      }
    }
    const head = el('button', {
      type: 'button', class: 'acc-head', 'aria-expanded': 'false', 'aria-controls': content.id,
      onclick: () => setOpen(content.hidden)
    },
    el('span', { class: 'chev', 'aria-hidden': 'true' }),
    el('span', { class: 'acc-title' }, title));
    const item = el('section', { class: 'acc-item', 'aria-label': title }, el('div', { class: 'acc-bar' }, head), content);
    function setOpen(open) {
      item.classList.toggle('is-open', open);
      head.setAttribute('aria-expanded', String(open));
      content.hidden = !open;
      if (open) loadFacts();
    }
    return { item, setOpen, title: title.toLowerCase() };
  }

  return {
    set(layers) {
      if (!layers.length) { fill(body, el('p', { class: 'pane-empty' }, 'No layer information in this map.')); return; }
      const items = layers.map(section);
      const none = el('p', { class: 'pane-empty', hidden: true }, 'No layers match the filter.');
      const filter = el('input', {
        type: 'search', class: 'layer-info-filter', placeholder: 'Filter layers', 'aria-label': 'Filter layers',
        oninput: e => {
          const text = e.target.value.trim().toLowerCase();
          for (const x of items) x.item.hidden = Boolean(text) && !x.title.includes(text);
          none.hidden = items.some(x => !x.item.hidden);
        }
      });
      fill(body, layers.length > 1 ? filter : null, el('div', { class: 'accordion' }, items.map(x => x.item)), none);
      if (items.length === 1) items[0].setOpen(true);
    }
  };
}
