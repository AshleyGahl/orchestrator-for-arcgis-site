// startupScreen.js — the screen over the viewer while it starts: "Initializing application" (reading the manifest),
// then "Configuring components" (the panel and the web map), in the viewer's header colours with its logo and title.
// A published viewer has the same markup in viewer.html, so it shows before any script has loaded; this adopts it.
import { el } from './utils.js';

const STEPS = [['init', 'Initializing application'], ['config', 'Configuring components']];
const MIN_SHOWN_MS = 600;        // a fast load doesn't flash it
const FADE_MS = 320;             // as .startup.is-done in app.css

export function createStartupScreen(section) {
  let node = section.querySelector('.startup');
  if (!node) {
    node = el('div', { class: 'startup', role: 'status', 'aria-live': 'polite' },
      el('div', { class: 'startup-card' },
        el('div', { class: 'startup-brand' }, el('span', { class: 'startup-title' }, 'GIS Viewer')),
        el('div', { class: 'startup-spinner', 'aria-hidden': 'true' }),
        el('ol', { class: 'startup-steps' }, STEPS.map(([id, label], i) =>
          el('li', { 'data-step': id, class: i ? null : 'is-current' }, el('span', { class: 'startup-mark', 'aria-hidden': 'true' }), label)))));
    section.append(node);
  }
  const shownAt = performance.now();
  let finished = null;

  function step(id) {
    const at = STEPS.findIndex(([s]) => s === id);
    node.querySelectorAll('.startup-steps li').forEach((li, i) => {
      li.classList.toggle('is-done', i < at || at < 0);
      li.classList.toggle('is-current', i === at);
    });
  }

  return {
    /** Move on to Configuring components, showing the viewer's logo and title. */
    configure(m) {
      if (finished) return;
      const brand = node.querySelector('.startup-brand');
      brand.replaceChildren(
        m.branding?.logo ? el('img', { class: 'startup-logo', src: m.branding.logo, alt: '' }) : '',
        el('span', { class: 'startup-title' }, m.title || 'GIS Viewer'));
      step('config');
    },
    /** Fade out (once). Resolves when it's gone. */
    done() {
      finished ??= new Promise(resolve => {
        step(null);
        setTimeout(() => {
          node.classList.add('is-done');
          setTimeout(() => { node.remove(); resolve(); }, FADE_MS);
        }, Math.max(0, MIN_SHOWN_MS - (performance.now() - shownAt)));
      });
      return finished;
    },
    isDone: () => finished != null
  };
}
