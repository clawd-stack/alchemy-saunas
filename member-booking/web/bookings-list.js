import { api, card, el, empty, linkButton, load, notice } from '/ui.js';

/**
 * A member's bookings. One card definition, used by the booking page and the
 * account page: the cancel confirmation and the waiver line are exactly what
 * drifts once there are two copies.
 */

export function bookingCard(booking, { messages, onChanged } = {}) {
  const guests = booking.guests.filter((guest) => guest.status === 'confirmed');
  const unsigned = guests.filter((guest) => guest.waiverStatus !== 'signed');

  const action = booking.canCancel
    ? el('button', { class: 'btn-danger btn-small', type: 'button', text: 'Cancel' })
    : el('span', { class: 'pill pill--quiet', text: 'Closed' });

  if (booking.canCancel) {
    action.addEventListener('click', async () => {
      if (!confirm('Cancel this booking? Guest spots are cancelled too.')) return;
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

  const meta = [`${booking.spotsTotal} spot${booking.spotsTotal === 1 ? '' : 's'}`];
  if (guests.length) meta.push(guests.map((g) => g.name).join(', '));
  if (booking.amountOwedAud > 0) meta.push(`$${booking.amountOwedAud.toFixed(2)} at the door`);

  return card([
    el('div', { class: 'item' }, [
      el('div', {}, [
        el('div', { class: 'item__title', text: booking.sessionLabel }),
        el('div', { class: 'item__meta', text: meta.join(' · ') }),
      ]),
      action,
    ]),
    // Only said when something is outstanding. A row of "signed, signed,
    // signed" is noise on a screen checked on the way out the door.
    unsigned.length
      ? el('p', { class: 'hint', text: `Waiver outstanding: ${unsigned.map((g) => g.name).join(', ')}` })
      : null,
  ]);
}

/** The booking page's list: what is still to come, nothing else. */
export async function renderMyBookings(host, { messages, onChanged } = {}) {
  await load(host, messages, async () => {
    const data = await api.get('/api/bookings');
    const live = data.bookings.filter((booking) => booking.status === 'confirmed');
    if (live.length === 0) return [empty('Nothing booked.')];
    return live.map((booking) => bookingCard(booking, { messages, onChanged }));
  });
}

export { linkButton };
