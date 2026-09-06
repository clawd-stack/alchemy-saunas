import { api, el, figures, notice } from '/ui.js';
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
    const packagesHost = el('div', {});
    host.append(form, packagesHost);
    renderSettings(form, config, { messages, onSaved: reload });
    drawPackages(packagesHost, data, { messages, onChanged: reload });

    async function reload() {
      const fresh = await api.get('/api/admin/config');
      renderSettings(form, fresh.config, { messages, onSaved: reload });
      drawPackages(packagesHost, fresh, { messages, onChanged: reload });
    }
  },
});

/**
 * Which membership packages this channel is part of.
 *
 * A rule about the channel rather than about any one person, which is why it
 * is here and not on People: People is where somebody goes to deal with a
 * person. Every member is imported whatever they hold; this decides which of
 * those packages can book, and it is applied at sign-in, so switching one off
 * takes effect on the next sign-in rather than the next import.
 */
function drawPackages(host, data, { messages, onChanged }) {
  host.innerHTML = '';
  if (!data.packages?.length) return;

  const unruled = data.packages.filter((entry) => entry.unruled);

  host.append(
    el('h3', { class: 'section-heading', text: 'Membership packages' }),
    el('p', { class: 'hint', style: 'margin:0 0 18px', text: data.packagesRuled
      ? 'Only the packages switched on can book. A package nobody has ruled on is closed.'
      : 'Every package can book. Switch one off and from then on only the packages left on can.' }),
    unruled.length ? el('div', { class: 'notice notice--warn', text:
      `${unruled.length === 1 ? 'One package has' : `${unruled.length} packages have`} appeared since these were set: ` +
      `${unruled.map((entry) => entry.name).join(', ')}. Nobody holding ${unruled.length === 1 ? 'it' : 'them'} can book.` }) : null,
    el('div', { class: 'stack' }, data.packages.map((entry) => packageRow(entry, { messages, onChanged }))),
  );
}

function packageRow(entry, { messages, onChanged }) {
  const box = el('input', { type: 'checkbox', checked: entry.allowed ? 'checked' : null });

  box.addEventListener('change', async () => {
    const wanted = box.checked;
    box.disabled = true;
    try {
      const result = await api.patch('/api/admin/config', { package: entry.name, allowed: wanted });
      notice(messages, 'good', result.message);
      await onChanged();
    } catch (error) {
      notice(messages, 'bad', error.message);
      box.checked = entry.allowed;
    } finally {
      box.disabled = false;
    }
  });

  return el('label', { class: 'consent row--between' }, [
    el('span', { class: 'row row--tight', style: 'gap:12px' }, [box, el('span', { text: entry.name })]),
    el('span', { class: 'muted', style: 'white-space:nowrap', text:
      `${entry.members} ${entry.members === 1 ? 'member' : 'members'}` }),
  ]);
}
