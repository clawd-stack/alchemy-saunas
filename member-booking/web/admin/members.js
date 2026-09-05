import { api, el, load, notice, table } from '/ui.js';
import { showPassword } from '/admin/password-panel.js';

/**
 * Members the venue holds itself. Hapana is asked first on every sign-in and
 * wins where it has an answer; this list covers the rest.
 *
 * Adding a member issues their password in the same step, because doing it in
 * two is how half a member gets created.
 */
export async function renderMembers(host, { messages, reload }) {
  await load(host, messages, async () => {
    const data = await api.get('/api/admin/members');

    return [
      data.hapanaConfigured ? null : el('div', {
        class: 'notice notice--warn',
        text: 'No Hapana key set. This list is the only membership the channel knows.',
      }),
      data.members.length
        ? table(['Member', 'Status', 'Sign-in', ''], data.members.map((member) => el('tr', {}, [
            el('td', {}, [
              el('div', { class: 'item__title', text: member.name }),
              el('div', { class: 'item__meta', text: member.email }),
            ]),
            el('td', {}, [el('span', {
              class: `pill pill--${member.status === 'active' ? 'good' : 'warn'}`,
              text: member.status,
            })]),
            el('td', {}, [member.canSignIn
              ? el('span', { class: 'muted', text: 'Yes' })
              : el('span', { class: 'pill pill--bad', text: 'No password' })]),
            el('td', {}, [actions(member, { messages, reload })]),
          ])))
        : el('p', { class: 'muted', text: 'None yet.' }),
      addForm({ messages, reload }),
    ];
  });
}

function actions(member, { messages, reload }) {
  const active = member.status === 'active';

  const toggle = el('button', { class: 'btn-quiet btn-small', type: 'button', text: active ? 'Pause' : 'Activate' });
  toggle.addEventListener('click', async () => {
    toggle.disabled = true;
    try {
      const result = await api.patch('/api/admin/members', {
        memberId: member.memberId,
        status: active ? 'paused' : 'active',
      });
      notice(messages, 'good', result.message);
      await reload();
    } catch (error) {
      notice(messages, 'bad', error.message);
      toggle.disabled = false;
    }
  });

  const remove = el('button', { class: 'btn-quiet btn-small', type: 'button', text: 'Remove' });
  remove.addEventListener('click', async () => {
    remove.disabled = true;
    try {
      const result = await api.del('/api/admin/members', { memberId: member.memberId });
      notice(messages, 'good', result.message);
      await reload();
    } catch (error) {
      notice(messages, 'bad', error.message);
      remove.disabled = false;
    }
  });

  return el('div', { class: 'row row--tight' }, [toggle, remove]);
}

function addForm({ messages, reload }) {
  const first = el('input', { type: 'text', placeholder: 'First' });
  const last = el('input', { type: 'text', placeholder: 'Last' });
  const email = el('input', { type: 'email', required: 'required', placeholder: 'member@example.com', autocomplete: 'off' });

  const form = el('form', { class: 'stack', style: 'margin-top:20px' }, [
    el('div', {}, [el('label', { text: 'Add a member' }), el('div', { class: 'row row--tight' }, [
      el('div', { style: 'flex:1;min-width:120px' }, [first]),
      el('div', { style: 'flex:1;min-width:120px' }, [last]),
    ])]),
    email,
    el('button', { class: 'btn-quiet btn-inline', type: 'submit', text: 'Add' }),
  ]);

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = form.querySelector('button');
    const payload = {
      email: email.value.trim(),
      firstName: first.value.trim() || null,
      lastName: last.value.trim() || null,
    };
    button.disabled = true;
    try {
      const created = await api.post('/api/admin/members', payload);
      await reload();
      showPassword(document.getElementById('members'), created);
    } catch (error) {
      notice(messages, 'bad', error.message);
    } finally {
      button.disabled = false;
    }
  });

  return form;
}
