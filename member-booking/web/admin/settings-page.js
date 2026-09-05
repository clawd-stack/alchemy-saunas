import { api, el, figures } from '/ui.js';
import { mountAdminPage } from '/admin/shell.js';
import { renderSettings } from '/admin/config.js';

mountAdminPage({
  roles: ['admin', 'manager'],
  run: async ({ messages }) => {
    const warnings = document.getElementById('warnings');
    const summary = document.getElementById('summary');
    const host = document.getElementById('settings');

    const data = await api.get('/api/admin/config');

    warnings.innerHTML = '';
    for (const warning of data.warnings) {
      warnings.append(el('div', { class: 'notice notice--warn', text: warning }));
    }

    const config = data.config;
    const tiles = [
      [config.memberChannelCapacity, 'per hour'],
      [config.maxGuestsPerMember, 'guests each'],
      [`$${config.guestPrice}`, 'per guest'],
    ];
    if (config.venueMaximum !== null) tiles.push([config.venueMaximum, 'venue ceiling']);
    summary.innerHTML = '';
    summary.append(el('div', { class: 'card' }, [figures(tiles)]));

    host.innerHTML = '';
    const form = el('form', { class: 'stack' });
    host.append(form);
    renderSettings(form, config, { messages, onSaved: reload });

    async function reload() {
      const fresh = await api.get('/api/admin/config');
      renderSettings(form, fresh.config, { messages, onSaved: reload });
    }
  },
});
