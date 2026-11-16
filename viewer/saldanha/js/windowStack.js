// windowStack.js — keeps the viewer's windows over the map (spatial results, Attribute trace, Editing, External
// pages, Downloads, Streaming, Scene) in the order people used them: the window opened or clicked last is on top,
// so a spatial relationship run from a trace's result shows in front of the trace instead of behind it. Clicking
// the window behind brings it forward again. The z-indexes stay in the band the stylesheet gives windows (11–14),
// under the dashboard, the sign-in panel and the Draft preview badge; when more windows are open than the band
// has levels, the oldest share the bottom one.

const Z_BOTTOM = 11, Z_TOP = 14;
const order = [];                       // open windows, the one on top last

function restack() {
  for (let i = order.length - 1, z = Z_TOP; i >= 0; i--, z = Math.max(Z_BOTTOM, z - 1)) order[i].style.zIndex = String(z);
}

/** Put a window on top of the others (it must be one passed to stackWindow). */
export function raiseWindow(win) {
  if (win.hidden) return;
  if (order[order.length - 1] === win) return;
  const at = order.indexOf(win);
  if (at >= 0) order.splice(at, 1);
  order.push(win);
  restack();
}

/**
 * Join a window to the stack: it comes to the top when it opens (its `hidden` attribute is removed), when it's
 * clicked or tapped, and when something in it takes focus. Hidden, it leaves the stack and its stylesheet z-index
 * applies again.
 */
export function stackWindow(win) {
  const sync = () => {
    if (!win.hidden) { raiseWindow(win); return; }
    const at = order.indexOf(win);
    if (at >= 0) order.splice(at, 1);
    win.style.zIndex = '';
    restack();
  };
  new MutationObserver(sync).observe(win, { attributes: true, attributeFilter: ['hidden'] });
  win.addEventListener('pointerdown', () => raiseWindow(win), true);
  win.addEventListener('focusin', () => raiseWindow(win));
  if (!win.hidden) raiseWindow(win);
  return win;
}
