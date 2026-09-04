import { describe, expect, it } from 'vitest';
import { createBooking } from '../src/domain/booking.ts';
import { ACTIVE_MEMBER, guests, makeHarness, VENUE_ID } from './helpers.ts';

/**
 * Capacity integrity. PRD 8 calls this the primary correctness property of the
 * build, and acceptance criteria 3, 4 and 5 are all here.
 */

function member(index: number) {
  return { memberId: `mem-${index}`, email: `member${index}@example.com`, name: `Member ${index}` };
}

describe('member channel allocation', () => {
  it('refuses the eleventh spot when the allocation is 10', async () => {
    const { context, session } = makeHarness({ config: { memberChannelCapacity: 10 } });

    // Ten single-spot bookings by ten different members fills the allocation.
    for (let i = 0; i < 10; i += 1) {
      await createBooking(context, member(i), { externalSessionId: session.id, guests: [] });
    }

    await expect(
      createBooking(context, member(99), { externalSessionId: session.id, guests: [] }),
    ).rejects.toMatchObject({ code: 'SESSION_FULL' });
  });

  it('counts guest spots against the allocation, not just members', async () => {
    const { context, session, store } = makeHarness({ config: { memberChannelCapacity: 10 } });

    // Three members bringing three guests each is 12 spots against 10.
    await createBooking(context, member(1), { externalSessionId: session.id, guests: guests(3) });
    await createBooking(context, member(2), { externalSessionId: session.id, guests: guests(3) });

    await expect(
      createBooking(context, member(3), { externalSessionId: session.id, guests: guests(3) }),
    ).rejects.toMatchObject({ code: 'SESSION_FULL' });

    const rows = await store.sessions.availability(VENUE_ID, new Date(0), new Date(Date.now() + 1e10), 10);
    const row = rows.find((candidate) => candidate.externalSessionId === session.id);
    expect(row?.booked).toBe(8);
    expect(row?.spotsRemaining).toBe(2);
  });
});

describe('concurrency', () => {
  /**
   * Acceptance criterion 4. Twenty simultaneous requests against three
   * remaining spots must produce exactly three bookings, never four.
   *
   * The in-memory store serialises per session with a promise chain, which is
   * the same shape as the SELECT ... FOR UPDATE in create_member_booking. The
   * Postgres path is covered by tests/integration.pg.test.ts, which runs the
   * identical scenario against the real function when DATABASE_URL is set.
   */
  it('20 simultaneous single-spot requests against 3 spots yield exactly 3 bookings', async () => {
    const { context, session, store } = makeHarness({ config: { memberChannelCapacity: 3 } });

    const attempts = Array.from({ length: 20 }, (_, index) =>
      createBooking(context, member(index), { externalSessionId: session.id, guests: [] })
        .then(() => 'ok' as const)
        .catch((error: { code?: string }) => error.code ?? 'ERROR'),
    );

    const outcomes = await Promise.all(attempts);
    const succeeded = outcomes.filter((outcome) => outcome === 'ok');
    const refused = outcomes.filter((outcome) => outcome === 'SESSION_FULL');

    expect(succeeded).toHaveLength(3);
    expect(refused).toHaveLength(17);

    const rows = await store.sessions.availability(VENUE_ID, new Date(0), new Date(Date.now() + 1e10), 3);
    const row = rows.find((candidate) => candidate.externalSessionId === session.id);
    expect(row?.booked).toBe(3);
    expect(row?.spotsRemaining).toBe(0);
  });

  it('never oversells when requests ask for different spot counts', async () => {
    const { context, session, store } = makeHarness({ config: { memberChannelCapacity: 10 } });

    // Eight members each asking for between 1 and 4 spots: 20 spots requested
    // against 10 available. Whatever gets through must total 10 or less.
    const attempts = Array.from({ length: 8 }, (_, index) =>
      createBooking(context, member(index), {
        externalSessionId: session.id,
        guests: guests(index % 4),
      })
        .then(() => 'ok' as const)
        .catch((error: { code?: string }) => error.code ?? 'ERROR'),
    );

    await Promise.all(attempts);

    const rows = await store.sessions.availability(VENUE_ID, new Date(0), new Date(Date.now() + 1e10), 10);
    const row = rows.find((candidate) => candidate.externalSessionId === session.id);
    expect(row!.booked).toBeLessThanOrEqual(10);
  });
});

describe('venue ceiling', () => {
  /**
   * The ceiling is enforced independently of Hapana, so a public channel that
   * has quietly oversold cannot drag total occupancy above the permitted
   * maximum through this channel. PRD 5.3 rule 5.
   */
  it('refuses when total occupancy across channels would exceed the venue maximum', async () => {
    const { context, session, hapana } = makeHarness({
      config: { memberChannelCapacity: 10, venueMaximum: 40, bookingBackend: 'hapana' },
      supportsWrites: true,
    });
    // Public channel is already holding 38 of the 40.
    hapana.setPublicBooked(session.id, 38);

    // Two spots fit exactly.
    await createBooking(context, member(1), { externalSessionId: session.id, guests: guests(1) });

    // A third would be 41.
    await expect(
      createBooking(context, member(2), { externalSessionId: session.id, guests: [] }),
    ).rejects.toMatchObject({ code: 'VENUE_CEILING' });
  });

  it('records every refusal in the capacity audit with the occupancy at the time', async () => {
    const { context, session, store } = makeHarness({ config: { memberChannelCapacity: 1 } });

    await createBooking(context, member(1), { externalSessionId: session.id, guests: [] });
    await expect(
      createBooking(context, member(2), { externalSessionId: session.id, guests: [] }),
    ).rejects.toMatchObject({ code: 'SESSION_FULL' });

    const rows = await store.audit.listForVenueBetween(VENUE_ID, new Date(0), new Date(Date.now() + 1e10));
    expect(rows.map((row) => row.action)).toEqual(['book', 'refuse']);
    expect(rows[1]?.refusalCode).toBe('SESSION_FULL');
    // The ceiling must never be shown as breached in the audit trail.
    expect(rows.every((row) => row.venueTotalBookedAfter <= row.venueMaximumAtTime)).toBe(true);
  });
});

describe('fail closed', () => {
  /**
   * PRD 8: if the ceiling check cannot be evaluated the system refuses the
   * booking. Acceptance criterion 10 is the same behaviour seen from the page.
   */
  it('refuses bookings when Hapana is unreachable under Pattern A', async () => {
    const harness = makeHarness({ config: { bookingBackend: 'hapana', memberChannelCapacity: 10 } });
    harness.hapana.setUnavailable(true);

    await expect(
      createBooking(harness.context, { memberId: ACTIVE_MEMBER.memberId, email: ACTIVE_MEMBER.email, name: 'Ada' }, {
        externalSessionId: harness.session.id,
        guests: [],
      }),
    ).rejects.toMatchObject({ code: 'BACKEND_UNAVAILABLE' });

    const bookings = await harness.store.bookings.listForSession(VENUE_ID, harness.session.id);
    expect(bookings).toHaveLength(0);
  });
});
