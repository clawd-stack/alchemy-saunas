import { api, el, notice } from '/ui.js';
import { mountAdminNav } from '/nav.js';
import { mountSignIn, showPasswordChange } from '/signin.js';

/**
 * Every admin page is the same shape: a sign-in form until somebody is staff,
 * then the page. Five copies of that gate is five chances for one of them to
 * show the form to somebody who is already signed in, which is how the last
 * sign-in bug looked from the outside.
 *
 * The page's own work happens in `run`, which is called with the staff session
 * so a page can lay itself out by role rather than waiting for a 403.
 */
export function mountAdminPage({ run, roles }) {
  const messages = document.getElementById('messages');
  const signinCard = document.getElementById('signin-card');
  const body = document.getElementById('page-body');
  const nav = mountAdminNav();

  mountSignIn({
    formId: 'signin-form',
    buttonId: 'signin-button',
    emailId: 'email',
    passwordId: 'password',
    messages,
    onSignedIn: start,
  });

  async function start() {
    let session;
    try {
      session = await api.get('/api/auth/session');
    } catch {
      return signedOut();
    }

    const staff = session?.staff ?? null;
    if (!staff) return signedOut();

    if (roles && !roles.includes(staff.role)) {
      signinCard.classList.add('hidden');
      body.classList.remove('hidden');
      body.innerHTML = '';
      body.append(el('p', { class: 'muted', text: 'Your account does not have access to this page.' }));
      nav?.refresh();
      return;
    }

    signinCard.classList.add('hidden');
    body.classList.remove('hidden');
    nav?.refresh();

    try {
      await run({ staff, messages, reload: start });
    } catch (error) {
      notice(messages, 'bad', error.message);
    }
  }

  function signedOut() {
    signinCard.classList.remove('hidden');
    body.classList.add('hidden');
    nav?.refresh();
  }

  start();
  return { reload: start, messages };
}

/** The sign-out and change-password pair, identical on every admin page. */
export function accountRow({ messages, onDone }) {
  const change = el('button', { class: 'btn-quiet btn-small', type: 'button', text: 'Change password' });
  change.addEventListener('click', () => showPasswordChange({ messages, onDone }));

  const out = el('button', { class: 'btn-quiet btn-small', type: 'button', text: 'Sign out' });
  out.addEventListener('click', async () => {
    await api.post('/api/auth/session', {});
    location.href = '/admin/';
  });

  return el('div', { class: 'row row--tight' }, [change, out]);
}
