import { api, card, el, empty, figures, linkButton, load, notice, section, table } from '/ui.js';
import { mountNav } from '/nav.js';
import { showPasswordChange } from '/signin.js';
import { bookingCard } from '/bookings-list.js';

mountNav();

const messages = document.getElementById('messages');
const host = document.getElementById('account');

/**
 * Membership first, then what is coming up, then what has happened.
 * Status leads because it decides whether the rest of the page matters.
 */
async function render() {
  await load(host, messages, async () => {
    const data = await api.get('/api/account');
    return [
      identity(data),
      ...section('Coming up', data.upcoming.length
        ? data.upcoming.map((booking) => bookingCard(booking, { messages, onChanged: render }))
        : [empty('Nothing booked.', linkButton('/booking.html', 'Book a session'))]),
      ...(data.previous.length ? section('Previous', [history(data.previous)]) : []),
      ...section('Security', [security()]),
    ];
  });
}

function identity({ member, membership, stats }) {
  const active = membership.active;
  return card([
    el('div', { class: 'item' }, [
      el('div', {}, [
        el('div', { class: 'item__title', style: 'font-size:18px', text: member.name }),
        el('div', { class: 'item__meta', text: member.email }),
      ]),
      el('span', {
        class: `pill pill--${active ? 'good' : 'bad'}`,
        text: active ? 'Active' : membership.status,
      }),
    ]),
    active ? null : el('div', {
      class: 'notice notice--warn',
      style: 'margin:16px 0 0',
      text: 'You cannot book while your membership is inactive.',
    }),
    membership.staleSince ? el('p', {
      class: 'hint',
      text: `Confirmed ${new Date(membership.staleSince).toLocaleDateString('en-AU')}.`,
    }) : null,
    el('div', { style: 'margin-top:22px' }, [
      figures([[stats.sessionsAttended, 'sessions'], [stats.guestsBrought, 'guests brought']]),
    ]),
  ], 'card--pad');
}

function history(previous) {
  return card([
    table(['Session', 'Spots', ''], previous.slice(0, 50).map((booking) => {
      const cancelled = booking.status !== 'confirmed';
      return el('tr', {}, [
        el('td', { text: booking.sessionLabel }),
        el('td', { text: booking.spotsGuest > 0 ? `You + ${booking.spotsGuest}` : 'You' }),
        el('td', {}, [el('span', {
          class: `pill pill--${cancelled ? 'quiet' : 'good'}`,
          text: cancelled ? 'Cancelled' : 'Attended',
        })]),
      ]);
    })),
  ]);
}

function security() {
  const change = el('button', { class: 'btn-quiet btn-small', type: 'button', text: 'Change password' });
  change.addEventListener('click', () => showPasswordChange({ messages }));

  const out = el('button', { class: 'btn-quiet btn-small', type: 'button', text: 'Sign out' });
  out.addEventListener('click', async () => {
    await api.post('/api/auth/session', {});
    location.href = '/booking.html';
  });

  return card([el('div', { class: 'row row--tight' }, [change, out])]);
}

render();
