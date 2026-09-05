import { api, el, load, notice, table } from '/ui.js';
import { showPassword } from '/admin/password-panel.js';

/** Sign-in accounts: who can get in, and with what. */

export async function renderCredentials(host, { messages, reload }) {
  await load(host, messages, async () => {
    const data = await api.get('/api/admin/credentials');
    const issued = data.accounts.filter((a) => a.active && a.mustChange).length;

    return [
      issued > 0 ? el('div', {
        class: 'notice notice--warn',
        text: `${issued} on an issued password.`,
      }) : null,
      table(['Account', 'Status', 'Last in', ''], data.accounts.map((account) => el('tr', {}, [
        el('td', {}, [
          el('div', { class: 'item__title', text: account.email }),
          el('div', { class: 'item__meta', text: account.role ? `${account.kind} · ${account.role}` : account.kind }),
        ]),
        el('td', {}, [el('span', {
          class: `pill pill--${account.active ? (account.mustChange ? 'warn' : 'good') : 'quiet'}`,
          text: account.active ? (account.mustChange ? 'Issued' : 'Active') : 'Suspended',
        })]),
        el('td', { class: 'muted', text: account.lastLoginAt ? new Date(account.lastLoginAt).toLocaleDateString('en-AU') : 'Never' }),
        el('td', {}, [actions(account, { messages, reload })]),
      ]))),
      issueForm({ messages, reload }),
    ];
  });
}

function actions(account, { messages, reload }) {
  const reset = el('button', { class: 'btn-quiet btn-small', type: 'button', text: 'Reset' });
  reset.addEventListener('click', () => issue(account.email, reset, { messages, reload }));

  const toggle = el('button', {
    class: 'btn-quiet btn-small', type: 'button',
    text: account.active ? 'Suspend' : 'Restore',
  });
  toggle.addEventListener('click', async () => {
    toggle.disabled = true;
    try {
      const result = await api.patch('/api/admin/credentials', { email: account.email, active: !account.active });
      notice(messages, 'good', result.message);
      await reload();
    } catch (error) {
      notice(messages, 'bad', error.message);
      toggle.disabled = false;
    }
  });

  return el('div', { class: 'row row--tight' }, [reset, toggle]);
}

function issueForm({ messages, reload }) {
  const email = el('input', { type: 'email', required: 'required', placeholder: 'name@example.com', autocomplete: 'off' });
  const form = el('form', { class: 'stack', style: 'margin-top:20px' }, [
    el('div', {}, [el('label', { text: 'Issue a password' }), email]),
    el('button', { class: 'btn-quiet btn-inline', type: 'submit', text: 'Generate' }),
  ]);

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const address = email.value.trim();
    email.value = '';
    await issue(address, form.querySelector('button'), { messages, reload });
  });

  return form;
}

async function issue(email, button, { messages, reload }) {
  if (!email) return notice(messages, 'warn', 'Enter an email address.');
  if (button) button.disabled = true;
  try {
    const created = await api.post('/api/admin/credentials', { email });
    await reload();
    showPassword(document.getElementById('credentials'), created);
  } catch (error) {
    notice(messages, 'bad', error.message);
  } finally {
    if (button) button.disabled = false;
  }
}
