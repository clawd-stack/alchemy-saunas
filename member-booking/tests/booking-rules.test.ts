import { describe, expect, it } from 'vitest';
import { cancelBooking, cancelGuestSpot, createBooking } from '../src/domain/booking.ts';
import { guests, makeHarness, VENUE_ID } from './helpers.ts';

const MEMBER = { memberId: 'mem-1', email: 'member1@example.com', name: 'Member One' };
const OTHER = { memberId: 'mem-2', email: 'member2@example.com', name: 'Member Two' };

describe('booking rules (PRD 5.3)', () => {
  it('accepts a member spot plus up to three guests', async () => {
    const { context, session } = makeHarness();
    const { booking } = await createBooking(context, MEMBER, { externalSessionId: session.id, guests: guests(3) });
    expect(booking.spotsTotal).toBe(4);
    expect(booking.spotsGuest).toBe(3);
    expect(booking.amountOwedAud).toBe(105);
  });

  it('refuses a fourth guest', async () => {
    const { context, session } = makeHarness();
    await expect(
      createBooking(context, MEMBER, { externalSessionId: session.id, guests: guests(4) }),
    ).rejects.toMatchObject({ code: 'GUEST_COUNT_OUT_OF_RANGE' });
  });

  it('refuses a guest without an email', async () => {
    const { context, session } = makeHarness();
    await expect(
      createBooking(context, MEMBER, {
        externalSessionId: session.id,
        guests: [{ name: 'No Email', email: '' }],
      }),
    ).rejects.toMatchObject({ code: 'GUEST_DETAILS_INCOMPLETE' });
  });

  it('refuses a second booking by the same member for the same session', async () => {
    const { context, session } = makeHarness();
    await createBooking(context, MEMBER, { externalSessionId: session.id, guests: [] });
    await expect(
      createBooking(context, MEMBER, { externalSessionId: session.id, guests: [] }),
    ).rejects.toMatchObject({ code: 'ALREADY_BOOKED' });
  });

  it('refuses a session beyond the booking window', async () => {
    const { context } = makeHarness({ config: { bookingWindowDays: 14 } });
    await expect(
      createBooking(context, MEMBER, { externalSessionId: 'east-fremantle:2099-01-01T10:00', guests: [] }),
    ).rejects.toMatchObject({ code: 'SESSION_NOT_FOUND' });
  });

  it('charges nothing for a member booking with no guests', async () => {
    const { context, session } = makeHarness();
    const { booking } = await createBooking(context, MEMBER, { externalSessionId: session.id, guests: [] });
    expect(booking.amountOwedAud).toBe(0);
    expect(booking.paymentStatus).toBe('outstanding');
  });
});

describe('cancellation (PRD 5.5)', () => {
  it('releases the member spot and every guest spot, and returns them to the channel', async () => {
    const { context, session, store } = makeHarness({ config: { memberChannelCapacity: 10 } });
    const { booking } = await createBooking(context, MEMBER, { externalSessionId: session.id, guests: guests(2) });

    const cancelled = await cancelBooking(context, MEMBER.memberId, booking.bookingId);
    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.guests.every((guest) => guest.status === 'cancelled')).toBe(true);

    const rows = await store.sessions.availability(VENUE_ID, new Date(0), new Date(Date.now() + 1e10), 10);
    const row = rows.find((candidate) => candidate.externalSessionId === session.id);
    expect(row?.booked).toBe(0);
    expect(row?.spotsRemaining).toBe(10);
  });

  it('emails each guest when their spot is released', async () => {
    const { context, session, store } = makeHarness();
    const { booking } = await createBooking(context, MEMBER, { externalSessionId: session.id, guests: guests(2) });
    await cancelBooking(context, MEMBER.memberId, booking.bookingId);

    const notices = store.outboxAll().filter((entry) => entry.template === 'guest_cancellation');
    expect(notices.map((entry) => entry.toEmail).sort()).toEqual(['guest1@example.com', 'guest2@example.com']);
  });

  it('refuses a cancellation inside the cutoff', async () => {
    const { context, session } = makeHarness({
      config: { cancellationCutoffHours: 3 },
      sessionHoursAhead: 2,
    });
    const { booking } = await createBooking(context, MEMBER, { externalSessionId: session.id, guests: [] });

    await expect(cancelBooking(context, MEMBER.memberId, booking.bookingId)).rejects.toMatchObject({
      code: 'PAST_CUTOFF',
    });
  });

  it('will not let one member cancel another member\'s booking, and does not confirm it exists', async () => {
    const { context, session } = makeHarness();
    const { booking } = await createBooking(context, MEMBER, { externalSessionId: session.id, guests: [] });

    await expect(cancelBooking(context, OTHER.memberId, booking.bookingId)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('drops a single guest spot and reprices the booking', async () => {
    const { context, session } = makeHarness();
    const { booking } = await createBooking(context, MEMBER, { externalSessionId: session.id, guests: guests(3) });
    expect(booking.amountOwedAud).toBe(105);

    const updated = await cancelGuestSpot(context, MEMBER.memberId, booking.guests[0]!.guestId);
    expect(updated.spotsTotal).toBe(3);
    expect(updated.spotsGuest).toBe(2);
    expect(updated.amountOwedAud).toBe(70);
    expect(updated.status).toBe('confirmed');
  });
});
