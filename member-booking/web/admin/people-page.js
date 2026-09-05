import { el } from '/ui.js';
import { mountAdminPage } from '/admin/shell.js';
import { renderPeople } from '/admin/people.js';

mountAdminPage({
  roles: ['admin'],
  run: async ({ messages }) => {
    const host = document.getElementById('people');
    host.innerHTML = '';
    const card = el('div', { class: 'card' });
    host.append(card);
    const reload = () => renderPeople(card, { messages, reload });
    await reload();
  },
});
