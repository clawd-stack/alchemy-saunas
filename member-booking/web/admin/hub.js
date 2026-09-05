import { api, el, figures, notice } from '/ui.js';
import { mountAdminPage, accountRow } from '/admin/shell.js';

/**
 * Where a signed-in staff member lands. It answers "what can I do" with a
 * list rather than with one long page, and shows the two numbers worth
 * knowing before you touch anything: how many spots the channel is holding
 * per hour, and whether anything is misconfigured.
 */

const DESTINATIONS = [
  {
    href: '/doorlist.html',
    label: 'Door list',
    blurb: 'Who is coming, and what they owe at the door.',
  },
  {
    href: '/admin/settings.html',
    label: 'Settings',
    blurb: 'Capacity, booking window, guests and pricing.',
    roles: ['admin', 'manager'],
  },
  {
    href: '/admin/waiver.html',
    label: 'Waiver',
    blurb: 'The wording guests sign, and its version.',
    roles: ['admin', 'manager'],
  },
  {
    href: '/admin/people.html',
    label: 'People',
    blurb: 'Members, sign-in accounts and staff.',
    roles: ['admin'],
  },
  {
    href: '/admin/audit.html',
    label: 'Audit',
    blurb: 'Every booking, cancellation and refusal.',
    roles: ['admin', 'manager'],
  },
];

mountAdminPage({
  run: async ({ staff, messages, reload }) => {
    const hub = document.getElementById('hub');
    const warnings = document.getElementById('warnings');
    hub.innerHTML = '';
    warnings.innerHTML = '';

    // Door staff cannot read the config endpoint, and asking anyway would
    // put a 403 on the screen of somebody whose page is working fine.
    const canConfigure = staff.role === 'admin' || staff.role === 'manager';
    const data = canConfigure ? await api.get('/api/admin/config').catch(() => null) : null;

    for (const warning of data?.warnings ?? []) {
      warnings.append(el('div', { class: 'notice notice--warn', text: warning }));
    }

    if (data) {
      const config = data.config;
      const tiles = [
        [config.memberChannelCapacity, 'per hour'],
        [config.maxGuestsPerMember, 'guests each'],
        [`$${config.guestPrice}`, 'per guest'],
      ];
      if (config.venueMaximum !== null) tiles.push([config.venueMaximum, 'venue ceiling']);
      hub.append(el('div', { class: 'card' }, [figures(tiles)]));
    }

    hub.append(el('div', { class: 'tiles' }, DESTINATIONS
      .filter((d) => !d.roles || d.roles.includes(staff.role))
      .map((d) => el('a', { class: 'tile', href: d.href }, [
        el('span', { class: 'tile__label', text: d.label }),
        el('span', { class: 'tile__blurb', text: d.blurb }),
      ]))));

    hub.append(el('div', { class: 'card' }, [
      el('div', { class: 'row row--between' }, [
        el('div', {}, [
          el('div', { class: 'item__title', text: staff.name }),
          el('div', { class: 'item__meta', text: `${staff.email} · ${staff.role}` }),
        ]),
        accountRow({ messages, onDone: reload }),
      ]),
    ]));

    if (canConfigure) hub.append(emailCheck(messages));
  },
});

/**
 * Email fails quietly everywhere else so a send cannot take a booking down
 * with it. This is the one place that says plainly whether it works.
 */
function emailCheck(messages) {
  const result = el('div');
  const button = el('button', { class: 'btn-quiet btn-small', type: 'button', text: 'Send test email' });

  button.addEventListener('click', async () => {
    button.disabled = true;
    result.innerHTML = '';
    try {
      const outcome = await api.post('/api/admin/test-email', {});
      notice(result, outcome.ok ? 'good' : 'warn', outcome.message);
      if (outcome.error) result.append(el('p', { class: 'hint', text: outcome.error }));
    } catch (error) {
      notice(result, 'bad', error.message);
    } finally {
      button.disabled = false;
    }
  });

  return el('div', { class: 'card' }, [
    el('div', { class: 'row row--between' }, [el('strong', { text: 'Email' }), button]),
    result,
  ]);
}
