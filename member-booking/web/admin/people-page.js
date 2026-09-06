import { mountAdminPage } from '/admin/shell.js';
import { renderPeople } from '/admin/people.js';

mountAdminPage({
  roles: ['admin'],
  run: async ({ messages }) => {
    // No card here: the page is several of them, one per section, and
    // renderPeople is what knows where each one starts and ends.
    const host = document.getElementById('people');
    const reload = () => renderPeople(host, { messages, reload });
    await reload();
  },
});
