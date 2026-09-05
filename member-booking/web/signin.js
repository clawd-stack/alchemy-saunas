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

      // Always hand off first, whatever else is pending. An earlier version
      // returned here when a password had to be changed, which left the
      // sign-in form on screen behind the change form: from the outside that
      // is indistinguishable from a sign-in that failed, and it is the one
      // state a person cannot debug for themselves.
      await onSignedIn(result);

      // Said, not shown. Opening the change-password form over a sign-in that
      // has already succeeded is what made a failure inside it read as a
      // failed sign-in: an error appeared, the page looked stuck, and
      // reloading revealed you had been signed in the whole time. The
      // reminder points at the Change password control that is already on the
      // page, and nothing about it is in the way.
      if (result.mustChangePassword) {
        notice(
          messages,
          'info',
          'You are signed in. The password you used was issued to you: change it from Change password when you have a moment.',
        );
      }
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
 * Opened from the Change password control on the account page and the admin
 * hub, and from nowhere else.
 *
 * It used to open itself after signing in with an issued password. That was a
 * UI gate over nothing, since the session cookie already worked against every
 * endpoint, and it cost more than it bought: an error inside the form read as
 * a failed sign-in, because the form was the only thing on screen that had
 * just changed. Reloading showed you had been signed in all along. Sign-in now
 * says so in a line of text instead, and this opens when somebody asks for it.
 */
export function showPasswordChange({ messages, onDone, host }) {
  const target = host ?? document.getElementById('password-change') ?? createHost();
  target.classList.remove('hidden');
  target.innerHTML = '';

  const current = el('input', { type: 'password', autocomplete: 'current-password', required: 'required' });
  const next = el('input', { type: 'password', autocomplete: 'new-password', required: 'required', minlength: '12' });
  const confirm = el('input', { type: 'password', autocomplete: 'new-password', required: 'required' });
  const result = el('div');

  const form = el('form', { class: 'stack' }, [
    el('h2', { style: 'margin:0', text: 'Change password' }),
    el('div', {}, [el('label', { text: 'Current password' }), current]),
    el('div', {}, [el('label', { text: 'New password (at least 12 characters)' }), next]),
    el('div', {}, [el('label', { text: 'New password again' }), confirm]),
    el('button', { class: 'btn-primary', type: 'submit', text: 'Save new password' }),
    result,
  ]);

  const cancel = el('button', {
    class: 'btn-quiet btn-small',
    type: 'button',
    text: 'Cancel',
  });
  cancel.addEventListener('click', () => target.classList.add('hidden'));
  form.append(cancel);

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
