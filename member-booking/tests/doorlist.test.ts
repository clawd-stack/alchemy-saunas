import { describe, expect, it } from 'vitest';
import { createBooking } from '../src/domain/booking.ts';
import { buildDoorList, listSessionsForDay, reconciliationCsv } from '../src/domain/doorlist.ts';
import { localDateKey } from '../src/lib/time.ts';
import { guests, makeHarness } from './helpers.ts';

const MEMBER_A = { memberId: 'mem-a', email: 'a@example.com', name: 'Ada Active' };
const MEMBER_B = { memberId: 'mem-b', email: 'b@example.com', name: 'Bo Booker' };

/** Door list and reconciliation, PRD 5.6 and 6, acceptance criteria 1, 8 and 9. */

describe('door list', () => {
  it('shows the member, their guests, the amount owed and waiver status per guest', async () => {
    const { context, session } = makeHarness();
    await createBooking(context, MEMBER_A, { externalSessionId: session.id, guests: guests(2) });

    const doorList = await buildDoorList(context, session.id);
    expect(doorList.rows).toHaveLength(1);

    const row = doorList.rows[0]!;
    expect(row.memberName).toBe('Ada Active');
    expect(row.spots).toBe(3);
    // Acceptance criterion 1: one member plus two guests is $70 owed.
    expect(row.amountOwed).toBe(70);
    expect(row.guests.map((guest) => guest.name)).toEqual(['Guest 1', 'Guest 2']);
    expect(row.guests.every((guest) => guest.waiverStatus === 'sent')).toBe(true);
  });

  it('totals owed, collected and outstanding across the session', async () => {
    const { context, store, session } = makeHarness();
    const first = await createBooking(context, MEMBER_A, { externalSessionId: session.id, guests: guests(2) });
    await createBooking(context, MEMBER_B, { externalSessionId: session.id, guests: guests(1) });

    await store.bookings.markPayment(first.booking.bookingId, 'collected', 'door@example.com');

    const doorList = await buildDoorList(context, session.id);
    expect(doorList.totals.bookings).toBe(2);
    expect(doorList.totals.spots).toBe(5);
    expect(doorList.totals.guests).toBe(3);
    expect(doorList.totals.owed).toBe(105);
    expect(doorList.totals.collected).toBe(70);
    expect(doorList.totals.outstanding).toBe(35);
    expect(doorList.totals.waiversUnsigned).toBe(3);
  });

  it('leaves cancelled bookings off the list', async () => {
    const { context, store, session } = makeHarness();
    const { booking } = await createBooking(context, MEMBER_A, { externalSessionId: session.id, guests: guests(1) });
    await store.bookings.cancel({
      bookingId: booking.bookingId,
      memberId: MEMBER_A.memberId,
      cutoffHours: 3,
      defaultChannelCapacity: 10,
      venueMaximum: 40,
    });

    const doorList = await buildDoorList(context, session.id);
    expect(doorList.rows).toHaveLength(0);
  });

  it('surfaces membership staleness to staff under Pattern B', async () => {
    const { context, store, session } = makeHarness({ config: { bookingBackend: 'local' } });
    await createBooking(context, MEMBER_A, { externalSessionId: session.id, guests: [] });
    await store.members.upsertMany([
      { memberId: 'mem-a', email: 'a@example.com', firstName: 'Ada', lastName: 'Active', status: 'active', homeVenueId: 'east-fremantle', syncedAt: new Date().toISOString() },
    ]);

    const doorList = await buildDoorList(context, session.id);
    expect(doorList.membershipStaleSince).not.toBeNull();
  });

  it('lists the day\'s sessions for the door tablet picker', async () => {
    const { context, session } = makeHarness();
    await createBooking(context, MEMBER_A, { externalSessionId: session.id, guests: guests(1) });

    const dateKey = localDateKey(session.startsAt, context.timezone);
    const sessions = await listSessionsForDay(context, dateKey);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.spots).toBe(2);
  });
});

describe('reconciliation export', () => {
  it('exports owed against collected with a variance line', async () => {
    const { context, store, session } = makeHarness();
    const first = await createBooking(context, MEMBER_A, { externalSessionId: session.id, guests: guests(2) });
    await createBooking(context, MEMBER_B, { externalSessionId: session.id, guests: guests(1) });
    await store.bookings.markPayment(first.booking.bookingId, 'collected', 'door@example.com');

    const dateKey = localDateKey(session.startsAt, context.timezone);
    const { csv, filename } = await reconciliationCsv(context, dateKey);

    expect(filename).toContain(dateKey);
    const lines = csv.trim().split('\n');
    expect(lines[0]).toContain('amount_owed_aud,payment_status,amount_collected_aud');
    expect(lines.some((line) => line.startsWith('TOTAL'))).toBe(true);

    const total = lines.find((line) => line.startsWith('TOTAL'))!.split(',');
    const variance = lines.find((line) => line.startsWith('VARIANCE'))!.split(',');
    expect(total[9]).toBe('105.00');
    expect(total[11]).toBe('70.00');
    // The $35 still to be collected is the number the venue chases.
    expect(variance[9]).toBe('35.00');
  });

  it('quotes fields containing commas so the CSV cannot be broken by a name', async () => {
    const { context, session } = makeHarness();
    await createBooking(context, { memberId: 'mem-c', email: 'c@example.com', name: 'Smith, John' }, {
      externalSessionId: session.id,
      guests: [{ name: 'Doe, Jane', email: 'jane@example.com' }],
    });

    const { csv } = await reconciliationCsv(context, localDateKey(session.startsAt, context.timezone));
    expect(csv).toContain('"Smith, John"');
    expect(csv).toContain('"Doe, Jane"');
  });
});
