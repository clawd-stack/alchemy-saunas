import { api, el, load, notice, table } from '/ui.js';
import { showPassword } from '/admin/password-panel.js';
import { importPanel } from '/admin/import-panel.js';

/**
 * Everybody, in one table.
 *
 * This was three lists, and the joining between them was left to the admin:
 * a member with no password, a password issued to an address that resolved to
 * nobody, a staff account somebody also tried to add as a member. One row per
 * person, one role each, and the row says whether they can actually get in.
 */

const ROLES = [
  ['member', 'Member'],
  ['door', 'Door'],
  ['manager', 'Manager'],
  ['admin', 'Admin'],
];

const SIGN_IN = {
  none: ['bad', 'No password'],
  issued: ['warn', 'Issued'],
  active: ['good', 'Active'],
  suspended: ['quiet', 'Suspended'],
};

export async function renderPeople(host, { messages, reload }) {
  await load(host, messages, async () => {
    const data = await api.get('/api/admin/people');

    return [
      data.hapanaConfigured ? null : el('div', {
        class: 'notice notice--warn',
        text: 'No Hapana key set. This list is the whole membership the channel knows.',
      }),
      data.people.length
        ? table(['Person', 'Role', 'Sign-in', ''], data.people.map((person) => row(person, { messages, reload })))
        : el('p', { class: 'muted', text: 'Nobody yet.' }),
      addForm({ messages, reload }),
      importPanel({ messages, reload }),
    ];
  });
}

function row(person, { messages, reload }) {
  const [tone, text] = SIGN_IN[person.signIn] ?? SIGN_IN.none;

  const roleSelect = el('select', {
    style: 'min-width:130px',
  }, ROLES.map(([value, text]) => el('option', { value, selected: value === person.role, text })));

  roleSelect.addEventListener('change', async () => {
    const next = roleSelect.value;
    roleSelect.disabled = true;
    try {
      const result = await api.patch('/api/admin/people', { email: person.email, role: next });
      notice(messages, 'good', result.message);
      await reload();
    } catch (error) {
      notice(messages, 'bad', error.message);
      roleSelect.value = person.role;
      roleSelect.disabled = false;
    }
  });

  return el('tr', {}, [
    el('td', {}, [
      el('div', { class: 'item__title', text: person.name }),
      el('div', { class: 'item__meta', text: person.email }),
    ]),
    el('td', {}, [
      roleSelect,
      // Only when it is not the obvious thing. A row that says "Member" and
      // nothing else is an active member.
      person.active ? null : el('div', { class: 'item__meta', text: person.status ?? 'inactive' }),
    ]),
    el('td', {}, [
      el('span', { class: `pill pill--${tone}`, text }),
      el('div', {
        class: 'item__meta',
        text: person.lastLoginAt ? new Date(person.lastLoginAt).toLocaleDateString('en-AU') : 'Never in',
      }),
    ]),
    el('td', {}, [actions(person, { messages, reload })]),
  ]);
}

function actions(person, { messages, reload }) {
  const reset = el('button', {
    class: 'btn-quiet btn-small', type: 'button',
    text: person.signIn === 'none' ? 'Give one' : 'Reset',
    title: person.signIn === 'none' ? 'Issue a password' : 'Issue a new password',
  });
  reset.addEventListener('click', async () => {
    reset.disabled = true;
    try {
      const created = await api.post('/api/admin/people', { action: 'reset', email: person.email });
      await reload();
      showPassword(document.getElementById('people'), created);
    } catch (error) {
      notice(messages, 'bad', error.message);
    } finally {
      reset.disabled = false;
    }
  });

  const suspend = el('button', {
    class: 'btn-quiet btn-small', type: 'button',
    text: person.signIn === 'suspended' ? 'Restore' : 'Suspend',
  });
  suspend.addEventListener('click', async () => {
    suspend.disabled = true;
    try {
      const result = await api.patch('/api/admin/people', {
        email: person.email,
        signIn: person.signIn === 'suspended',
      });
      notice(messages, 'good', result.message);
      await reload();
    } catch (error) {
      notice(messages, 'bad', error.message);
      suspend.disabled = false;
    }
  });

  const remove = el('button', { class: 'btn-danger btn-small', type: 'button', text: 'Remove' });
  remove.addEventListener('click', async () => {
    if (!confirm(`Remove ${person.email}? They lose their sign-in and, if they are a member, their ability to book.`)) return;
    remove.disabled = true;
    try {
      const result = await api.del('/api/admin/people', { email: person.email });
      notice(messages, 'good', result.message);
      await reload();
    } catch (error) {
      notice(messages, 'bad', error.message);
      remove.disabled = false;
    }
  });

  // Nothing to suspend before there is a password to suspend.
  const buttons = person.signIn === 'none' ? [reset, remove] : [reset, suspend, remove];
  return el('div', { class: 'row row--tight row--nowrap' }, buttons);
}

/**
 * One form. Role is picked here rather than implied by which of three lists
 * the admin happened to open, and the password is issued in the same step,
 * because doing it in two is how half a person gets created.
 */
function addForm({ messages, reload }) {
  const name = el('input', { type: 'text', required: 'required', placeholder: 'Full name' });
  const email = el('input', { type: 'email', required: 'required', placeholder: 'name@example.com', autocomplete: 'off' });
  const role = el('select', {}, ROLES.map(([value, text]) => el('option', { value, text })));

  const form = el('form', { class: 'stack', style: 'margin-top:28px' }, [
    el('h3', { style: 'margin:0', text: 'Add someone' }),
    el('div', {}, [el('label', { text: 'Name' }), name]),
    el('div', {}, [el('label', { text: 'Email' }), email]),
    el('div', {}, [el('label', { text: 'Role' }), role]),
    el('button', { class: 'btn-quiet btn-inline', type: 'submit', text: 'Add and issue a password' }),
  ]);

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = form.querySelector('button');
    button.disabled = true;
    try {
      const created = await api.post('/api/admin/people', {
        action: 'add',
        email: email.value.trim(),
        name: name.value.trim(),
        role: role.value,
      });
      name.value = '';
      email.value = '';
      await reload();
      showPassword(document.getElementById('people'), created);
    } catch (error) {
      notice(messages, 'bad', error.message);
    } finally {
      button.disabled = false;
    }
  });

  return form;
}
