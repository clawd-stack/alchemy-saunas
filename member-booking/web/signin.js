import { api, el, notice } from '/api.js';

/**
 * Sign in, and the change-password step that follows an issued one.
 *
 * Shared by the member, door and admin pages. Three copies of a login form is
 * three places for the must-change step to be quietly left out, and a password
 * that was read down a phone and never replaced is the failure this whole flow
 * exists to avoid.
 */

/**
 * Wires an email + password form to the sign-in endpoint.
 *
 * The endpoint refuses identically whatever went wrong, so there is nothing
 * useful to add here: the message it returns is deliberately the only thing a
 * signed-out caller gets to know.
 */
export function mountSignIn({ formId, buttonId, emailId, passwordId, messages, onSignedIn }) {
  const form = document.getElementById(formId);
  if (!form) return;

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = document.getElementById(buttonId);
    const label = button.textContent;
    button.disabled = true;
    button.textContent = 'Signing in…';

    try {
      const result = await api.post('/api/auth/login', {
        email: document.getElementById(emailId).value.trim(),
        password: document.getElementById(passwordId).value,
      });

      // Clear the field before anything else can go wrong or the page reloads.
      document.getElementById(passwordId).value = '';

      if (result.mustChangePassword) {
        showPasswordChange({ messages, onDone: onSignedIn, forced: true });
        return;
      }
      await onSignedIn(result);
    } catch (error) {
      notice(messages, 'bad', error.message);
    } finally {
      button.disabled = false;
      button.textContent = label;
    }
  });
}

/**
 * The change-password form.
 *
 * Shown as a required step after signing in with a manager-issued password, and
 * available on demand from the account row. Forced mode has no way out other
 * than completing it, because the password being replaced is one somebody else
 * has seen.
 */
export function showPasswordChange({ messages, onDone, forced = false, host }) {
  const target = host ?? document.getElementById('password-change') ?? createHost();
  target.classList.remove('hidden');
  target.innerHTML = '';

  const current = el('input', { type: 'password', autocomplete: 'current-password', required: 'required' });
  const next = el('input', { type: 'password', autocomplete: 'new-password', required: 'required', minlength: '12' });
  const confirm = el('input', { type: 'password', autocomplete: 'new-password', required: 'required' });
  const result = el('div');

  const form = el('form', { class: 'stack' }, [
    el('h2', { style: 'margin:0', text: forced ? 'Choose your own password' : 'Change password' }),
    el('p', {
      class: 'muted',
      style: 'margin:0',
      text: forced
        ? 'The password you just used was issued to you, so somebody else has seen it. Choose one only you know.'
        : 'You will need your current password.',
    }),
    el('div', {}, [el('label', { text: 'Current password' }), current]),
    el('div', {}, [el('label', { text: 'New password (at least 12 characters)' }), next]),
    el('div', {}, [el('label', { text: 'New password again' }), confirm]),
    el('button', { class: 'btn-primary', type: 'submit', text: 'Save new password' }),
    result,
  ]);

  if (!forced) {
    const cancel = el('button', { class: 'btn-quiet btn-small', type: 'button', text: 'Cancel' });
    cancel.addEventListener('click', () => target.classList.add('hidden'));
    form.append(cancel);
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (next.value !== confirm.value) {
      return notice(result, 'bad', 'Those two passwords are not the same.');
    }
    try {
      const saved = await api.post('/api/auth/password', {
        currentPassword: current.value,
        newPassword: next.value,
      });
      current.value = next.value = confirm.value = '';
      target.classList.add('hidden');
      notice(messages, 'good', saved.message);
      if (onDone) await onDone();
    } catch (error) {
      notice(result, 'bad', error.message);
    }
  });

  target.append(form);
  next.focus();
}

function createHost() {
  const host = el('section', { class: 'card', id: 'password-change' });
  document.getElementById('messages').after(host);
  return host;
}

/** A signed-in banner with sign-out, and a way to change your own password. */
export function accountControls({ messages, onSignedOut }) {
  const change = el('button', { class: 'btn-quiet btn-small', type: 'button', text: 'Change password' });
  change.addEventListener('click', () => showPasswordChange({ messages }));

  const out = el('button', { class: 'btn-quiet btn-small', type: 'button', text: 'Sign out' });
  out.addEventListener('click', async () => {
    await api.post('/api/auth/session', {});
    if (onSignedOut) onSignedOut();
    else location.reload();
  });

  return el('div', { class: 'row' }, [change, out]);
}
