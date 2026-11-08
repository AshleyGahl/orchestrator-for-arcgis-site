// sceneWindow.js — the frame the 3D scene opens in, at the width the author chose:
//   half: over half the map, on the author's side, with a drag handle between the scene and the 2D map (like Editing
//         and Swipe); the 2D map stays usable beside it, and the two move together (sceneView.startSync).
//   full: over the map and the panel, with its own rail: Back to 2D, and Sun and shadows (a panel the scene's daylight
//         controls are drawn into).
// Narrow screens always get full width. Pure UI: the scene itself is drawn into viewNode by sceneView.js (through
// viewerApp.js), and the 2D map's padding goes out through onPadding.
import { el, halfWindowLeft } from './utils.js';
import { svgIcon } from './viewer.js';
import { stackWindow } from './windowStack.js';

const MAP_ICON = '<path d="m2.5 5.5 5-2 5 2 5-2v11l-5 2-5-2-5 2Z"/><path d="M7.5 3.5v11M12.5 5.5v11"/>';
const SUN_ICON = '<circle cx="10" cy="10" r="3.5"/><path d="M10 2.5v2M10 15.5v2M2.5 10h2M15.5 10h2M4.7 4.7l1.4 1.4M13.9 13.9l1.4 1.4M4.7 15.3l1.4-1.4M13.9 6.1l1.4-1.4"/>';
const HALF_MIN = 0.3, HALF_MAX = 0.7;
const NARROW_PX = 640;          // below this the map is too small to share: the scene opens at full width

/**
 * @param host      the positioned element to float in (.viewer-body)
 * @param handlers  {
 *   onBack()               people asked to go back to the 2D map (Back to 2D, the close button or Escape)
 *   onPadding({ left?, right? })   keep the 2D map's centre in the part the scene leaves clear
 *   onSun(open, node)      Sun and shadows opened (draw its controls into node) or closed
 *   onOpenChange(open)
 * }
 */
export function createSceneWindow(host, handlers) {
  let width = 'half';
  let side = 'left';
  let ratio = 0.5;              // share of the map the half-width scene takes

  const viewNode = el('div', { class: 'scene-view', 'aria-label': '3D scene' });
  const statusText = el('span', {});
  const statusClose = el('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Dismiss', onclick: () => say('') }, '×');
  const status = el('div', { class: 'scene-status', role: 'status', hidden: true }, statusText, statusClose);
  const backBtn = el('button', { type: 'button', class: 'rail-btn', title: 'Back to the 2D map', onclick: () => handlers.onBack() },
    svgIcon(MAP_ICON), el('span', { class: 'btn-label' }, 'Back to 2D'));
  const sunBtn = el('button', { type: 'button', class: 'rail-btn', 'aria-pressed': 'false', 'aria-controls': 'scene-sun', title: 'Sun and shadows', onclick: () => setSun(sunPanel.hidden) },
    svgIcon(SUN_ICON), el('span', { class: 'btn-label' }, 'Sun and shadows'));
  const rail = el('nav', { class: 'scene-rail', 'aria-label': 'Scene' }, backBtn, sunBtn);
  const sunNode = el('div', { class: 'scene-sun-body' });
  const sunPanel = el('section', { class: 'scene-sun', id: 'scene-sun', 'aria-label': 'Sun and shadows', hidden: true },
    el('header', {}, el('strong', {}, 'Sun and shadows'),
      el('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Close sun and shadows', onclick: () => setSun(false) }, '×')),
    el('p', { class: 'muted' }, 'Choose a date and time, or press play, to move the sun and see the shadows it casts.'),
    sunNode);
  const closeBtn = el('button', { type: 'button', class: 'icon-btn scene-close', 'aria-label': 'Close the scene', title: 'Close the scene', onclick: () => handlers.onBack() }, '×');
  const head = el('header', { class: 'scene-head' }, el('strong', {}, 'Scene'), el('span', { class: 'muted' }, 'Moves with the map'), closeBtn);
  const handle = el('div', {
    class: 'ew-handle scene-handle', role: 'separator', tabindex: 0, 'aria-orientation': 'vertical', 'aria-label': 'Drag to share the space between the scene and the map',
    'aria-valuemin': HALF_MIN * 100, 'aria-valuemax': HALF_MAX * 100
  }, el('span', { class: 'ew-grip', 'aria-hidden': 'true' }));
  const win = el('section', { class: 'scene-window', role: 'region', 'aria-label': 'Scene', hidden: true },
    el('div', { class: 'scene-main' }, head, viewNode, status, sunPanel), rail, handle);
  host.append(win);
  stackWindow(win);                     // the window opened or clicked last is on top (windowStack.js)

  win.addEventListener('keydown', e => {
    if (e.key !== 'Escape') return;
    e.stopPropagation();
    if (!sunPanel.hidden) { setSun(false); sunBtn.focus(); } else handlers.onBack();
  });

  /** Sun and shadows is a full-width tool: the panel floats over the scene, beside the rail. */
  function setSun(on) {
    if (on === !sunPanel.hidden) return;
    sunPanel.hidden = !on;
    sunBtn.setAttribute('aria-pressed', String(on));
    handlers.onSun?.(on, sunNode);
  }
  window.addEventListener('resize', () => { if (!win.hidden) layout(); });

  /* ---------- Size and position ---------- */
  const mapRect = () => {
    const hostR = host.getBoundingClientRect(), m = (host.querySelector('.map') ?? host).getBoundingClientRect();
    return { left: m.left - hostR.left, top: m.top - hostR.top, width: m.width, height: m.height };
  };
  const effectiveWidth = () => (width === 'half' && mapRect().width >= NARROW_PX ? 'half' : 'full');

  function layout() {
    const w = effectiveWidth();
    win.dataset.width = w;
    win.dataset.side = side;
    handle.hidden = w !== 'half';
    if (w === 'full') {
      for (const k of ['left', 'top', 'width', 'height']) win.style[k] = '';
      handlers.onPadding?.({});
      return;
    }
    const m = mapRect();
    const px = Math.round(m.width * ratio);
    Object.assign(win.style, { width: `${px}px`, height: `${m.height}px`, top: `${m.top}px`, left: `${halfWindowLeft(m, px, side)}px` });
    handle.setAttribute('aria-valuenow', String(Math.round(ratio * 100)));
    handlers.onPadding?.({ [side]: px });
  }

  // Drag the inner edge to share the space between the scene and the map.
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
  });

  function open() {
    if (!win.hidden) return;
    win.hidden = false;
    host.classList.add('scene-open');
    layout();
    handlers.onOpenChange?.(true);
    (effectiveWidth() === 'full' ? backBtn : closeBtn).focus({ preventScroll: true });
  }

  function close() {
    if (win.hidden) return;
    setSun(false);
    win.hidden = true;
    host.classList.remove('scene-open');
    handlers.onPadding?.({});
    handlers.onOpenChange?.(false);
  }

  /** kind: '' (a note people can dismiss), 'busy' (no dismiss) or 'err'. */
  function say(text, kind = '') {
    statusText.textContent = text;
    statusClose.hidden = kind === 'busy';
    status.hidden = !text;
    status.className = `scene-status${kind ? ` ${kind}` : ''}`;
  }

  return {
    viewNode,
    /** The manifest's scene settings (call on every manifest; closes the scene). */
    set(scene) {
      close();
      width = scene?.width === 'full' ? 'full' : 'half';
      side = scene?.side === 'right' ? 'right' : 'left';
      ratio = 0.5;
      say('');
    },
    open,
    close,
    isOpen: () => !win.hidden,
    /** 'half' or 'full': how the scene is showing now (narrow screens get full). */
    width: effectiveWidth,
    /** A line over the scene: loading ('busy'), layers that didn't draw, or why the scene can't start ('err'). */
    say
  };
}
