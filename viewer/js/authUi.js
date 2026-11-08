// authUi.js — the small sign-in form shown wherever something secured needs credentials,
// and the "signed in as" list. The password field is cleared as soon as it's used.
import { el, fill, formatDateTime } from './utils.js';
import * as auth from './auth.js';
import { clearCache } from './api.js';

/**
 * @param target      { tokenUrl, key, label } from an AuthRequiredError or auth.portalTarget()
 * @param onSignedIn  called after a successful sign-in (retry the thing that needed it)
 * @param message     why sign-in is needed
 * @param windowsInline  show the Windows sign-in button under the password fields (for servers where it isn't
 *                       known up front which sign-in they use), instead of the small "uses Windows sign-in?" link
 */
export function signInForm({ target, onSignedIn, message, windowsInline = false }) {
  if (target.windows) return windowsForm({ target, onSignedIn, message });
  const user = el('input', { type: 'text', autocomplete: 'username', placeholder: 'Username', 'aria-label': `Username for ${target.label}`, required: true });
  const pass = el('input', { type: 'password', autocomplete: 'current-password', placeholder: 'Password', 'aria-label': `Password for ${target.label}`, required: true });
  const btn = el('button', { type: 'submit', class: 'btn primary' }, 'Sign in');
  const status = el('p', { class: 'status', role: 'status' });
  const winStatus = el('p', { class: 'status', role: 'status' });

  const form = el('form', {
    class: 'signin', autocomplete: 'on',
    onsubmit: async e => {
      e.preventDefault();
      btn.disabled = true;
      status.className = 'status';
      status.textContent = `Signing in to ${target.label}…`;
      try {
        try {
          await auth.signIn(target, user.value.trim(), pass.value);
        } catch (err) {
          if (!(err instanceof auth.WindowsAuthRequired)) throw err;
          pass.value = '';
          form.replaceWith(windowsForm({ target, onSignedIn, message: err.message }));
          return;
        }
        pass.value = '';
        clearCache();
        status.className = 'status ok';
        status.textContent = 'Signed in.';
        onSignedIn?.();
      } catch (err) {
        pass.value = '';
        status.className = 'status err';
        status.textContent = err.message;
      } finally {
        btn.disabled = false;
      }
    }
  },
  el('p', { class: 'signin-msg' }, message ?? `This is secured. Sign in to ${target.label}.`),
  el('div', { class: 'signin-fields' }, user, pass, btn),
  status,
  el('p', { class: 'signin-note' }, 'Your password goes only to the server\'s sign-in service and isn\'t saved. The sign-in lasts until you close this tab or it expires.'),
  target.key === 'arcgis.com' ? null
    : windowsInline ? el('div', { class: 'signin-windows' },
        el('p', { class: 'signin-msg' }, 'Or, if this server uses Windows sign-in, use your network account. No password is entered here.'),
        el('div', { class: 'signin-fields' }, windowsButton({ target, onSignedIn, status: winStatus })),
        winStatus)
    : el('button', { type: 'button', class: 'icon-btn signin-alt', onclick: () => form.replaceWith(windowsForm({ target, onSignedIn })) }, 'This portal uses Windows sign-in? Use my Windows account'));
  return form;
}

/** Windows (web-tier) sign-in: no password here; the browser uses the network account. */
export function windowsForm({ target, onSignedIn, message }) {
  const status = el('p', { class: 'status', role: 'status' });
  const btn = windowsButton({ target, onSignedIn, status, primary: true });
  return el('div', { class: 'signin' },
    el('p', { class: 'signin-msg' }, message ?? `Sign in to ${target.label} with your Windows (network) account.`),
    el('div', { class: 'signin-fields' }, btn),
    status,
    el('p', { class: 'signin-note' }, 'Your browser proves who you are with the account you\'re signed in to the network with. No password is entered or stored here. If the browser asks for your network username and password, that box is the browser\'s own.'));
}

/** "Sign in with my Windows account", reporting progress in `status`. */
function windowsButton({ target, onSignedIn, status, primary = false }) {
  const btn = el('button', {
    type: 'button', class: primary ? 'btn primary' : 'btn',
    onclick: async () => {
      btn.disabled = true;
      status.className = 'status';
      status.textContent = `Signing in to ${target.label} with your Windows account…`;
      try {
        const c = await auth.signInWindows(target);
        clearCache();
        status.className = 'status ok';
        status.textContent = `Signed in as ${c.user}.`;
        onSignedIn?.();
      } catch (err) {
        status.className = 'status err';
        status.textContent = err.message;
      } finally {
        btn.disabled = false;
      }
    }
  }, 'Sign in with my Windows account');
  return btn;
}

/** "Signed in to ArcGIS Online as ashley, until 14:35 · Sign out" for each session. Re-renders itself. */
export function sessionsList() {
  const box = el('div', { class: 'sessions' });
  const render = () => {
    const sessions = auth.list();
    fill(box, sessions.length
      ? sessions.map(s => el('div', { class: 'session' },
          el('span', {}, `Signed in to ${s.label} as `, el('strong', {}, s.user), s.windows ? ' (Windows sign-in).' : `, until ${formatDateTime(s.expires)}.`),
          el('button', { type: 'button', class: 'icon-btn', onclick: () => { auth.signOut(s.key); clearCache(); } }, 'Sign out')))
      : null);
  };
  auth.onChange(render);
  render();
  return box;
}
