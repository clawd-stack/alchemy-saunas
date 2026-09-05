import { el } from '/ui.js';
import { mountAdminPage } from '/admin/shell.js';
import { renderMembers } from '/admin/members.js';
import { renderCredentials } from '/admin/accounts.js';
import { renderStaff } from '/admin/staff.js';

/**
 * Members, sign-in accounts and staff: three lists that answer three
 * different questions about the same people, so they belong together.
 *
 * Each section refreshes only itself. Adding a member should not re-render
 * the staff table under somebody's cursor.
 */

const SECTIONS = [
  ['Members', 'members', renderMembers, 'Members the venue holds itself. Hapana is asked first and wins where it has an answer.'],
  ['Sign-in accounts', 'credentials', renderCredentials, 'Who can sign in, and with what.'],
  ['Staff', 'staff', renderStaff, 'What somebody can see once they are in.'],
];

mountAdminPage({
  roles: ['admin'],
  run: async ({ messages }) => {
    const host = document.getElementById('people');
    host.innerHTML = '';

    for (const [title, id, render, note] of SECTIONS) {
      const card = el('div', { class: 'card' });
      host.append(
        el('h2', { text: title }),
        el('p', { class: 'hint', style: 'margin:-8px 0 12px', text: note }),
        card,
      );
      const reload = () => render(card, { messages, reload });
      reload();
    }
  },
});
