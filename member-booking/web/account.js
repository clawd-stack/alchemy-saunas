import { api, el, money, notice } from '/api.js';
import { mountNav } from '/nav.js';
import { showPasswordChange } from '/signin.js';

mountNav();

/**
 * My account.
 *
 * Membership status, what is coming up, and what has already happened, in that
 * order. Status first because it is the thing that decides whether the rest of
 * the page is any use: a member whose membership has lapsed needs to know that
 * here, not when a booking is refused.
 */

const messages = document.getElementById('messages');
const host = document.getElementById('account');

async function load() {
  host.innerHTML = '';
  host.append(el('p', { class: 'spinner', text: 'Loading…' }));

  try {
    const data = await api.get('/api/account');
    host.innerHTML = '';
    host.append(
      membershipCard(data),
      ...upcomingSection(data),
      ...previousSection(data),
      accountCard(data),
    );
  } catch (error) {
    host.innerHTML = '';
    if (error.code === 'UNAUTHENTICATED') {
      host.append(
        el('div', { class: 'card' }, [
          el('p', { style: 'margin:0', text: 'Please sign in to see your account.' }),
          el('p', { style: 'margin:12px 0 0' }, [
            el('a', {
              class: 'btn-primary',
              href: '/booking.html',
              style: 'display:inline-block;text-decoration:none',
              text: 'Sign in',
            }),
          ]),
        ]),
      );
      return;
    }
    host.append(el('p', { class: 'muted', text: error.message }));
  }
}

function membershipCard({ member, membership, stats, policy }) {
  const active = membership.active;

  const card = el('div', { class: 'card' }, [
    el('div', { class: 'row row--between' }, [
      el('div', {}, [
        el('strong', { style: 'font-size:18px', text: member.name }),
        el('p', { class: 'muted', style: 'margin:4px 0 0', text: member.email }),
      ]),
      el('span', {
        class: `pill pill--${active ? 'good' : 'bad'}`,
        text: active ? 'Membership active' : `Membership ${membership.status}`,
      }),
    ]),
  ]);

  if (!active) {
    card.append(
      el('div', {
        class: 'notice notice--warn',
        style: 'margin:16px 0 0',
        text: 'You cannot book while the membership is not active. Speak to the team at the venue and they will sort it out.',
      }),
    );
  }

  if (membership.staleSince) {
    // Honest about the degraded case rather than silently showing a status
    // that might be hours old.
    card.append(
      el('p', {
        class: 'hint',
        style: 'margin:12px 0 0',
        text: `Membership details last confirmed ${new Date(membership.staleSince).toLocaleString('en-AU')}. They are being shown from our records while the membership system is unreachable.`,
      }),
    );
  }

  card.append(
    el('div', { class: 'totals', style: 'margin-top:20px' }, [
      el('div', {}, [el('strong', { text: String(stats.sessionsAttended) }), 'sessions attended']),
      el('div', {}, [el('strong', { text: String(stats.guestsBrought) }), 'guest spots brought']),
      el('div', {}, [el('strong', { text: `$${policy.guestPrice}` }), 'per guest, at the door']),
    ]),
    el('p', {
      class: 'hint',
      style: 'margin-top:14px',
      text: `Your own spot is included in your membership. You can bring up to ${policy.maxGuestsPerMember} guests, and cancel free up to ${policy.cancellationCutoffHours} hours before a session starts.`,
    }),
  );

  return card;
}

function upcomingSection({ upcoming }) {
  const out = [el('h2', { text: 'Coming up' })];

  if (upcoming.length === 0) {
    out.push(
      el('div', { class: 'card' }, [
        el('p', { class: 'muted', style: 'margin:0', text: 'Nothing booked yet.' }),
        el('p', { style: 'margin:12px 0 0' }, [
          el('a', {
            class: 'btn-primary',
            href: '/booking.html',
            style: 'display:inline-block;text-decoration:none',
            text: 'Book a session',
          }),
        ]),
      ]),
    );
    return out;
  }

  for (const booking of upcoming) out.push(upcomingCard(booking));
  return out;
}

function upcomingCard(booking) {
  const guests = booking.guests.filter((guest) => guest.status === 'confirmed');
  const unsigned = guests.filter((guest) => guest.waiverStatus !== 'signed');

  const action = booking.canCancel
    ? el('button', { class: 'btn-danger btn-small', type: 'button', text: 'Cancel' })
    : el('span', { class: 'pill pill--quiet', text: 'Cancellation closed' });

  if (booking.canCancel) {
    action.addEventListener('click', async () => {
      if (!confirm('Cancel this booking? Any guest spots are cancelled too, and your guests will be emailed.')) return;
      action.disabled = true;
      try {
        const result = await api.post('/api/bookings/cancel', { bookingId: booking.bookingId });
        notice(messages, 'good', result.message);
        await load();
      } catch (error) {
        notice(messages, 'warn', error.message);
        action.disabled = false;
      }
    });
  }

  return el('div', { class: 'card' }, [
    el('div', { class: 'row row--between' }, [
      el('div', {}, [
        el('strong', { text: booking.sessionLabel }),
        el('p', {
          class: 'muted',
          style: 'margin:4px 0 0',
          text: `${booking.spotsTotal} spot${booking.spotsTotal === 1 ? '' : 's'}${guests.length ? `, with ${guests.map((g) => g.name).join(', ')}` : ''}`,
        }),
        booking.amountOwedAud > 0
          ? el('p', {
              class: 'muted',
              style: 'margin:4px 0 0',
              text: `${money(booking.amountOwedAud)} to pay by card at the venue.`,
            })
          : null,
      ]),
      action,
    ]),
    // Only worth a line when something is outstanding. A row reading
    // "signed, signed, signed" is noise on a screen checked before leaving.
    unsigned.length > 0
      ? el('p', {
          class: 'hint',
          style: 'margin-top:12px',
          text: `Waiver still to sign: ${unsigned.map((g) => g.name).join(', ')}. They can sign at the door.`,
        })
      : guests.length > 0
        ? el('p', { class: 'hint', style: 'margin-top:12px', text: 'All guest waivers signed.' })
        : null,
  ]);
}

function previousSection({ previous }) {
  if (previous.length === 0) return [];

  const body = el('tbody');
  for (const booking of previous.slice(0, 50)) {
    const cancelled = booking.status !== 'confirmed';
    body.append(
      el('tr', { class: cancelled ? 'muted' : '' }, [
        el('td', { text: booking.sessionLabel }),
        el('td', { text: booking.spotsGuest > 0 ? `You + ${booking.spotsGuest}` : 'You' }),
        el('td', {}, [
          el('span', {
            class: `pill pill--${cancelled ? 'warn' : 'good'}`,
            text: cancelled ? 'Cancelled' : 'Attended',
          }),
        ]),
      ]),
    );
  }

  return [
    el('h2', { text: 'Previous bookings' }),
    el('div', { class: 'card' }, [
      el('div', { class: 'scroll-x' }, [
        el('table', {}, [
          el('thead', {}, [
            el('tr', {}, [
              el('th', { text: 'Session' }),
              el('th', { text: 'Spots' }),
              el('th', { text: '' }),
            ]),
          ]),
          body,
        ]),
      ]),
      previous.length > 50
        ? el('p', { class: 'hint', style: 'margin:12px 0 0', text: `Showing the 50 most recent of ${previous.length}.` })
        : null,
    ]),
  ];
}

function accountCard() {
  const change = el('button', { class: 'btn-quiet btn-small', type: 'button', text: 'Change password' });
  change.addEventListener('click', () => showPasswordChange({ messages }));

  const out = el('button', { class: 'btn-quiet btn-small', type: 'button', text: 'Sign out' });
  out.addEventListener('click', async () => {
    await api.post('/api/auth/session', {});
    location.href = '/booking.html';
  });

  return el('div', { class: 'card' }, [
    el('div', { class: 'row row--between' }, [
      el('div', {}, [
        el('strong', { text: 'Sign in and security' }),
        el('p', { class: 'hint', style: 'margin:4px 0 0', text: 'Your password is only known to you. If you lose it, the venue can issue a new one.' }),
      ]),
      el('div', { class: 'row', style: 'gap:6px' }, [change, out]),
    ]),
  ]);
}

load();
