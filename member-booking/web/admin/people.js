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
 * Four boxes now, not four headings down one long scroll. On a phone a rule
 * between sections is invisible by the time you have scrolled past it, so each
 * section is a card that starts and ends somewhere you can see.
 *
 * Ordered by why somebody opened the page: adding one person is the thing that
 * brings people here and it is now first, then staff, which is the list that
 * gets edited, then the bulk import, then the membership, behind a search box
 * and showing a screenful at a time.
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
  // Quiet, not red. For a member this is the ordinary state between being
  // imported and first signing in, which is where most of the list sits: a
  // warning on four hundred rows is a warning about nothing.
  none: ['quiet', 'Not set yet'],
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
      card('Add someone', [addForm({ messages, reload })]),
      card('Staff', [
        staff.length
          ? table(['Person', 'Role', 'Sign-in', ''], staff.map((person) => row(person, { messages, reload })))
          : el('p', { class: 'muted', text: 'Nobody yet.' }),
      ]),
      card('Import from an export', [importPanel({ messages, reload })]),
      card(`Members (${members.length})`, membersSection(members, { messages, reload })),
    ];
  });
}

/** One section, in a box of its own, with the heading the box starts at. */
function card(title, children) {
  return el('div', { class: 'card' }, [
    el('h3', { class: 'section-heading', text: title }),
    ...children,
  ]);
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
      host.append(table(
        ['Person', 'Package', 'Role', 'Sign-in', ''],
        shown.map((person) => row(person, { messages, reload, showPackage: true })),
      ));
    }
  }

  search.addEventListener('input', draw);
  draw();

  return [el('div', { class: 'stack' }, [search, summary, host])];
}

function row(person, { messages, reload, showPackage = false }) {
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
    // What they hold in Hapana, and so which of the switches under Settings
    // decides whether they can book. Blank for somebody added by hand, and for
    // anybody imported before packages were recorded.
    showPackage
      ? el('td', { style: 'white-space:nowrap' }, [el('span', {
          class: person.membershipPackage ? 'item__meta' : 'muted',
          text: person.membershipPackage ?? 'None',
        })])
      : null,
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
 * the admin happened to open.
 *
 * A member added here sets their own password at first sign-in, exactly as an
 * imported member does. Staff cannot: the claim refuses a staff address on
 * purpose, so theirs is issued here and handed over. The button says which of
 * the two is about to happen, because it is the difference between walking
 * away and having a password to pass on.
 */
function addForm({ messages, reload }) {
  const name = el('input', { type: 'text', required: 'required', placeholder: 'Full name' });
  const email = el('input', { type: 'email', required: 'required', placeholder: 'name@example.com', autocomplete: 'off' });
  const role = el('select', {}, ROLES.map(([value, text]) => el('option', { value, text })));
  const button = el('button', { class: 'btn-quiet btn-inline', type: 'submit' });
  const hint = el('p', { class: 'hint', style: 'margin:0' });

  function describe() {
    const staff = role.value !== 'member';
    button.textContent = staff ? 'Add and issue a password' : 'Add';
    hint.textContent = staff
      ? 'A password is issued and shown once, for you to pass on.'
      : 'They set their own password the first time they sign in.';
  }
  role.addEventListener('change', describe);
  describe();

  const form = el('form', { class: 'stack' }, [
    el('div', {}, [el('label', { text: 'Name' }), name]),
    el('div', {}, [el('label', { text: 'Email' }), email]),
    el('div', {}, [el('label', { text: 'Role' }), role]),
    hint,
    button,
  ]);

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
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
      // Only staff leave here with a password to pass on. For a member there
      // is nothing to show, so say what happened instead.
      if (created.password) showPassword(document.getElementById('people'), created);
      else notice(messages, 'good', created.message);
    } catch (error) {
      notice(messages, 'bad', error.message);
    } finally {
      button.disabled = false;
    }
  });

  return form;
}
