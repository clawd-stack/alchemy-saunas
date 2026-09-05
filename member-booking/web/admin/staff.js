import { api, el, load, notice, table } from '/ui.js';

/**
 * Staff accounts: what somebody can see once they are in. Admin only, because
 * a manager who could edit this could make themselves an admin.
 */
export async function renderStaff(host, { messages, reload }) {
  await load(host, messages, async () => {
    const data = await api.get('/api/admin/staff');
    return [
      table(['Who', 'Role', 'Status', ''], data.staff.map((person) => el('tr', {}, [
        el('td', {}, [
          el('div', { class: 'item__title', text: person.name }),
          el('div', { class: 'item__meta', text: person.email }),
        ]),
        el('td', { class: 'muted', text: person.role }),
        el('td', {}, [el('span', {
          class: `pill pill--${person.active ? 'good' : 'quiet'}`,
          text: person.active ? 'Active' : 'Off',
        })]),
        el('td', {}, [toggle(person, { messages, reload })]),
      ]))),
      addForm({ messages, reload }),
    ];
  });
}

function toggle(person, { messages, reload }) {
  const button = el('button', {
    class: 'btn-quiet btn-small', type: 'button',
    text: person.active ? 'Deactivate' : 'Restore',
  });
  button.addEventListener('click', async () => {
    button.disabled = true;
    try {
      const result = await api.patch('/api/admin/staff', { staffId: person.staffId, active: !person.active });
      notice(messages, 'good', result.message);
      await reload();
    } catch (error) {
      notice(messages, 'bad', error.message);
      button.disabled = false;
    }
  });
  return button;
}

function addForm({ messages, reload }) {
  const email = el('input', { type: 'email', required: 'required', placeholder: 'name@alchemysaunas.com.au', autocomplete: 'off' });
  const name = el('input', { type: 'text', required: 'required', placeholder: 'Full name' });
  const role = el('select', {}, [
    el('option', { value: 'door', text: 'Door' }),
    el('option', { value: 'manager', text: 'Manager' }),
    el('option', { value: 'admin', text: 'Admin' }),
  ]);

  const form = el('form', { class: 'stack', style: 'margin-top:20px' }, [
    el('div', {}, [el('label', { text: 'Add or update' }), name]),
    email,
    role,
    el('button', { class: 'btn-quiet btn-inline', type: 'submit', text: 'Save' }),
  ]);

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    try {
      const result = await api.post('/api/admin/staff', {
        email: email.value.trim(),
        name: name.value.trim(),
        role: role.value,
      });
      notice(messages, 'good', result.message);
      await reload();
    } catch (error) {
      notice(messages, 'bad', error.message);
    }
  });

  return form;
}
