import { api, el, load, notice, table } from '/ui.js';
import { showPassword } from '/admin/password-panel.js';
import { importPanel } from '/admin/import-panel.js';

/**
 * Everybody the channel knows, in one place but not one list.
 *
 * It was one table, which was right when it held a dozen rows and wrong the
 * moment the membership was imported: four hundred members buried the five
 * people who actually run the venue, and every visit to change a door
 * account's role meant scrolling past all of them.
 *
 * So the page is ordered by how often somebody comes here to do the thing:
 * staff first because that is the list that gets edited, then the two ways to
 * add people, then the membership at the bottom, behind a search box and
 * showing a screenful at a time. It is still one role per person and one row
 * per person; it is the order and the depth that changed.
 */

/** More than a screenful, few enough to render without the page feeling slow. */
const MEMBER_PAGE = 50;

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
    const staff = data.people.filter((person) => person.role !== 'member');
    const members = data.people.filter((person) => person.role === 'member');

    return [
      data.hapanaConfigured ? null : el('div', {
        class: 'notice notice--warn',
        text: 'No Hapana key set. This list is the whole membership the channel knows.',
      }),

      el('h3', { class: 'section-heading', text: 'Staff' }),
      staff.length
        ? table(['Person', 'Role', 'Sign-in', ''], staff.map((person) => row(person, { messages, reload })))
        : el('p', { class: 'muted', text: 'Nobody yet.' }),
      addForm({ messages, reload }),
      importPanel({ messages, reload }),

      // Above the membership rather than below it: it is the rule that
      // decides which of those four hundred people can actually book.
      ...packages(data, { messages, reload }),
      ...membersSection(members, { messages, reload }),
    ];
  });
}

/**
 * The membership, at the bottom and searchable.
 *
 * Four hundred rows of controls is a slow page and an unreadable one, so a
 * screenful is rendered and the search narrows it. The count is always the
 * true one: it is the number somebody came to the page to check.
 */
function membersSection(members, { messages, reload }) {
  const host = el('div', {});
  const summary = el('p', { class: 'hint', style: 'margin:0' });
  const search = el('input', {
    type: 'search',
    placeholder: 'Search by name or email',
    autocomplete: 'off',
  });

  function draw() {
    const term = search.value.trim().toLowerCase();
    const matched = term
      ? members.filter((person) =>
          person.email.toLowerCase().includes(term) || (person.name ?? '').toLowerCase().includes(term))
      : members;
    const shown = matched.slice(0, MEMBER_PAGE);

    summary.textContent = matched.length === 0
      ? (term ? `Nobody matches "${search.value.trim()}".` : 'No members yet.')
      : shown.length < matched.length
        ? `Showing ${shown.length} of ${matched.length}${term ? ' matching' : ''}. Search to narrow it.`
        : `${matched.length} ${matched.length === 1 ? 'member' : 'members'}${term ? ' matching' : ''}.`;

    host.innerHTML = '';
    if (shown.length) {
      host.append(table(['Person', 'Role', 'Sign-in', ''], shown.map((person) => row(person, { messages, reload }))));
    }
  }

  search.addEventListener('input', draw);
  draw();

  return [
    el('h3', { class: 'section-heading', text: `Members (${members.length})` }),
    el('div', { class: 'stack' }, [search, summary, host]),
  ];
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

/**
 * Which membership packages reach this channel.
 *
 * Membership status is Hapana's answer to a different question, whether
 * somebody is paying. This is the venue's answer to this one: whether the
 * member channel is part of what they pay for. One switch per package, with
 * the number of people it would affect next to it, because that number is the
 * whole decision.
 */
function packages(data, { messages, reload }) {
  if (!data.packages?.length) return [];

  const unruled = data.packages.filter((entry) => entry.unruled);

  return [
    el('h3', { class: 'section-heading', text: 'Membership packages' }),
    el('section', { class: 'stack' }, [
      el('p', { class: 'hint', style: 'margin:0', text: data.packagesRuled
        ? 'Only the packages switched on can book. A package nobody has ruled on is closed.'
        : 'Every package can book. Switch one off and from then on only the packages left on can.' }),
      unruled.length ? el('div', { class: 'notice notice--warn', text:
        `${unruled.length === 1 ? 'One package has' : `${unruled.length} packages have`} appeared since these were set: ` +
        `${unruled.map((entry) => entry.name).join(', ')}. Nobody holding ${unruled.length === 1 ? 'it' : 'them'} can book.` }) : null,
      el('div', { class: 'stack' }, data.packages.map((entry) => packageRow(entry, { messages, reload }))),
    ]),
  ];
}

function packageRow(entry, { messages, reload }) {
  const box = el('input', { type: 'checkbox', checked: entry.allowed ? 'checked' : null });

  box.addEventListener('change', async () => {
    const wanted = box.checked;
    box.disabled = true;
    try {
      const result = await api.patch('/api/admin/people', { package: entry.name, allowed: wanted });
      notice(messages, 'good', result.message);
      await reload();
    } catch (error) {
      notice(messages, 'bad', error.message);
      box.checked = entry.allowed;
    } finally {
      box.disabled = false;
    }
  });

  return el('label', { class: 'consent row--between' }, [
    el('span', { class: 'row row--tight', style: 'gap:12px' }, [
      box,
      el('span', { text: entry.name }),
    ]),
    el('span', { class: 'muted', style: 'white-space:nowrap', text:
      `${entry.members} ${entry.members === 1 ? 'member' : 'members'}` }),
  ]);
}
