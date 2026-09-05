import { api, el, money, notice } from '/api.js';

/**
 * The member's own bookings.
 *
 * Shared by the booking page, where it sits under the picker, and by the
 * bookings page the menu links to. One implementation, because the cancel
 * confirmation and the waiver wording are the sort of thing that drifts
 * immediately once there are two.
 */

export async function renderMyBookings(host, { messages, onChanged, showPast = false } = {}) {
  host.innerHTML = '';
  host.append(el('p', { class: 'spinner', text: 'Loading…' }));

  try {
    const data = await api.get('/api/bookings');
    const live = data.bookings.filter((booking) => booking.status === 'confirmed');
    const past = data.bookings.filter((booking) => booking.status !== 'confirmed');

    host.innerHTML = '';

    if (live.length === 0) {
      host.append(
        el('div', { class: 'card' }, [
          el('p', { class: 'muted', style: 'margin:0', text: 'Nothing booked yet.' }),
          el('p', { style: 'margin:12px 0 0' }, [
            el('a', { class: 'btn-primary', href: '/booking.html', style: 'display:inline-block;text-decoration:none', text: 'Book a session' }),
          ]),
        ]),
      );
    }

    for (const booking of live) {
      host.append(bookingCard(booking, { messages, onChanged }));
    }

    if (showPast && past.length > 0) {
      host.append(
        el('h2', { text: 'Past and cancelled' }),
        ...past.slice(0, 20).map((booking) =>
          el('div', { class: 'card muted' }, [
            el('strong', { text: booking.sessionLabel }),
            el('p', { class: 'hint', style: 'margin:4px 0 0', text: booking.status === 'cancelled' ? 'Cancelled' : 'Attended' }),
          ]),
        ),
      );
    }
  } catch (error) {
    host.innerHTML = '';
    // Signing out in another tab, or a session that simply ran out, is not an
    // error worth a red banner: say what it is and offer the way back.
    if (error.code === 'UNAUTHENTICATED') {
      host.append(
        el('div', { class: 'card' }, [
          el('p', { style: 'margin:0', text: 'Please sign in to see your bookings.' }),
          el('p', { style: 'margin:12px 0 0' }, [
            el('a', { class: 'btn-primary', href: '/booking.html', style: 'display:inline-block;text-decoration:none', text: 'Sign in' }),
          ]),
        ]),
      );
      return;
    }
    host.append(el('p', { class: 'muted', text: error.message }));
  }
}

function bookingCard(booking, { messages, onChanged }) {
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
        if (messages) notice(messages, 'good', result.message);
        if (onChanged) await onChanged();
      } catch (error) {
        if (messages) notice(messages, 'warn', error.message);
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
          ? el('p', { class: 'muted', style: 'margin:4px 0 0', text: `${money(booking.amountOwedAud)} to pay by card at the venue.` })
          : null,
      ]),
      action,
    ]),
    // Only worth saying when something is outstanding. A row of "signed,
    // signed, signed" is noise on the page a member checks before leaving.
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
