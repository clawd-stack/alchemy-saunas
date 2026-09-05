import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';

/**
 * Integration test against a real Postgres.
 *
 * This is the test that actually proves acceptance criterion 4. The suite in
 * capacity.test.ts describes the behaviour against the in-memory store; this
 * one runs the identical scenario through create_member_booking in
 * db/schema.sql, with twenty genuinely concurrent connections contending for
 * the same session row.
 *
 * Skipped unless DATABASE_URL is set, so `npm test` stays offline-clean:
 *   createdb member_booking_test
 *   psql -d member_booking_test -f db/schema.sql -f db/seed.sql
 *   DATABASE_URL=postgres://localhost/member_booking_test npm test
 */

const DATABASE_URL = process.env.DATABASE_URL;
const suite = DATABASE_URL ? describe : describe.skip;

const VENUE_ID = 'east-fremantle';

suite('create_member_booking against Postgres', () => {
  // A connection each, so the requests genuinely overlap rather than queueing
  // behind a small pool. Contention is the thing under test.
  const sql = postgres(DATABASE_URL ?? '', { max: 25, prepare: false, onnotice: () => {} });

  const sessionKey = () => `${VENUE_ID}:test-${Math.random().toString(36).slice(2, 10)}`;
  const startsAt = new Date(Date.now() + 48 * 3_600_000);
  const endsAt = new Date(startsAt.getTime() + 3_600_000);

  beforeAll(async () => {
    await sql`insert into venues (venue_id, name) values (${VENUE_ID}, 'Test venue') on conflict do nothing`;
  });

  afterAll(async () => {
    await sql.end({ timeout: 5 });
  });

  async function book(
    externalSessionId: string,
    memberId: string,
    guestCount: number,
    options: { capacity?: number; venueMaximum?: number | null; publicBooked?: number } = {},
  ) {
    const guests = Array.from({ length: guestCount }, (_, i) => ({
      name: `Guest ${i + 1}`,
      email: `guest${i + 1}.${memberId}@example.com`,
    }));
    const [row] = await sql<Array<{ result: { ok: boolean; code?: string } }>>`
      select create_member_booking(
        ${VENUE_ID}, ${externalSessionId}, ${startsAt}, ${endsAt},
        ${memberId}, ${`Member ${memberId}`}, ${`${memberId}@example.com`},
        ${sql.json(guests as never)},
        ${options.capacity ?? 10}, ${options.venueMaximum === undefined ? 40 : options.venueMaximum}, ${options.publicBooked ?? 20},
        ${35}, ${3}, ${memberId}
      ) as result
    `;
    return row!.result;
  }

  it('20 simultaneous requests against 3 spots produce exactly 3 bookings', async () => {
    const session = sessionKey();

    const results = await Promise.all(
      Array.from({ length: 20 }, (_, index) => book(session, `concurrent-${index}`, 0, { capacity: 3 })),
    );

    const succeeded = results.filter((result) => result.ok);
    const full = results.filter((result) => !result.ok && result.code === 'SESSION_FULL');

    expect(succeeded).toHaveLength(3);
    expect(full).toHaveLength(17);

    const rows = await sql<Array<{ booked: number }>>`
      select coalesce(sum(b.spots_total), 0)::int as booked
      from bookings b join sessions s on s.id = b.session_id
      where s.external_session_id = ${session} and b.status = 'confirmed'
    `;
    expect(Number(rows[0]!.booked)).toBe(3);
  });

  it('never oversells when concurrent requests ask for different spot counts', async () => {
    const session = sessionKey();

    // Ten members asking for 1 to 4 spots each, 25 spots requested against 10.
    await Promise.all(
      Array.from({ length: 10 }, (_, index) => book(session, `mixed-${index}`, index % 4, { capacity: 10 })),
    );

    const rows = await sql<Array<{ booked: number }>>`
      select coalesce(sum(b.spots_total), 0)::int as booked
      from bookings b join sessions s on s.id = b.session_id
      where s.external_session_id = ${session} and b.status = 'confirmed'
    `;
    expect(Number(rows[0]!.booked)).toBeLessThanOrEqual(10);
  });

  it('holds the ceiling when the public channel is already near capacity', async () => {
    const session = sessionKey();

    // 38 of 40 already sold publicly: only 2 more may ever be created.
    await Promise.all(
      Array.from({ length: 10 }, (_, index) =>
        book(session, `ceiling-${index}`, 0, { capacity: 10, venueMaximum: 40, publicBooked: 38 }),
      ),
    );

    const rows = await sql<Array<{ booked: number }>>`
      select coalesce(sum(b.spots_total), 0)::int as booked
      from bookings b join sessions s on s.id = b.session_id
      where s.external_session_id = ${session} and b.status = 'confirmed'
    `;
    expect(Number(rows[0]!.booked)).toBe(2);

    const breaches = await sql`
      select * from capacity_audit a join sessions s on s.id = a.session_id
      where s.external_session_id = ${session}
        and a.venue_total_booked_after > a.venue_maximum_at_time
    `;
    expect(breaches).toHaveLength(0);
  });

  it('refuses a second live booking by the same member for the same session', async () => {
    const session = sessionKey();
    expect((await book(session, 'dupe-1', 0)).ok).toBe(true);
    expect(await book(session, 'dupe-1', 0)).toMatchObject({ ok: false, code: 'ALREADY_BOOKED' });
  });

  it('races on the same member for the same session still yield one booking', async () => {
    const session = sessionKey();
    const results = await Promise.all(Array.from({ length: 5 }, () => book(session, 'racing-member', 0)));
    expect(results.filter((result) => result.ok)).toHaveLength(1);
  });

  it('sells its full allocation when no venue ceiling is configured', async () => {
    const session = sessionKey();

    // No ceiling and unknown public occupancy: the channel's own allocation of
    // 10 is the only limit, and it must still be honoured exactly.
    const results = await Promise.all(
      Array.from({ length: 14 }, (_, index) =>
        book(session, `noceiling-${index}`, 0, { capacity: 10, venueMaximum: null, publicBooked: -1 }),
      ),
    );
    expect(results.filter((result) => result.ok)).toHaveLength(10);
    expect(results.filter((result) => !result.ok && result.code === 'SESSION_FULL')).toHaveLength(4);

    const rows = await sql<Array<{ booked: number; ceilings: number }>>`
      select coalesce(sum(b.spots_total), 0)::int as booked,
             (select count(*) from capacity_audit a join sessions s2 on s2.id = a.session_id
               where s2.external_session_id = ${session} and a.venue_maximum_at_time is not null)::int as ceilings
      from bookings b join sessions s on s.id = b.session_id
      where s.external_session_id = ${session} and b.status = 'confirmed'
    `;
    expect(Number(rows[0]!.booked)).toBe(10);
    // The audit records that no ceiling applied, rather than inventing one.
    expect(Number(rows[0]!.ceilings)).toBe(0);
  });

  it('fails closed when occupancy is unknown and a ceiling IS configured', async () => {
    const session = sessionKey();
    expect(await book(session, 'unknown-1', 0, { publicBooked: -1 })).toMatchObject({
      ok: false,
      code: 'OCCUPANCY_UNKNOWN',
    });
  });

  it('releases the spots on cancellation and records the audit trail', async () => {
    const session = sessionKey();
    const created = await book(session, 'cancel-1', 2, { capacity: 10 });
    expect(created.ok).toBe(true);

    const bookingId = (created as unknown as { booking_id: string }).booking_id;
    const [row] = await sql<Array<{ result: { ok: boolean } }>>`
      select cancel_member_booking(${bookingId}::uuid, ${'cancel-1'}, ${3}, ${10}, ${40}, ${'test'}, ${true}, ${'test'}) as result
    `;
    expect(row!.result.ok).toBe(true);

    const rows = await sql<Array<{ booked: number }>>`
      select coalesce(sum(b.spots_total), 0)::int as booked
      from bookings b join sessions s on s.id = b.session_id
      where s.external_session_id = ${session} and b.status = 'confirmed'
    `;
    expect(Number(rows[0]!.booked)).toBe(0);

    const audit = await sql<Array<{ action: string }>>`
      select a.action from capacity_audit a join sessions s on s.id = a.session_id
      where s.external_session_id = ${session} order by a.created_at
    `;
    expect(audit.map((entry) => entry.action)).toEqual(['book', 'cancel']);
  });

  it('refuses a cancellation inside the cutoff', async () => {
    const soon = new Date(Date.now() + 2 * 3_600_000);
    const session = sessionKey();
    const [inserted] = await sql<Array<{ result: { booking_id: string } }>>`
      select create_member_booking(
        ${VENUE_ID}, ${session}, ${soon}, ${new Date(soon.getTime() + 3_600_000)},
        ${'cutoff-1'}, ${'Cutoff Member'}, ${'cutoff@example.com'},
        ${sql.json([] as never)}, ${10}, ${40}, ${20}, ${35}, ${3}, ${'cutoff-1'}
      ) as result
    `;
    const bookingId = inserted!.result.booking_id;

    const [row] = await sql<Array<{ result: { ok: boolean; code: string } }>>`
      select cancel_member_booking(${bookingId}::uuid, ${'cutoff-1'}, ${3}, ${10}, ${40}, null, ${true}, ${'test'}) as result
    `;
    expect(row!.result).toMatchObject({ ok: false, code: 'PAST_CUTOFF' });
  });
});

/**
 * The Postgres store implementation, exercised through the same interface the
 * in-memory store implements. This is what catches a field-mapping mistake in
 * pg.ts that the SQL-level tests above would never see.
 */
suite('pg store implementation', () => {
  let store: import('../src/store/types.ts').Store;

  beforeAll(async () => {
    const { createPgStore } = await import('../src/store/pg.ts');
    store = createPgStore();
    await store.config.set('member_channel_capacity', 10, 'test');
  });

  afterAll(async () => {
    await store.close();
  });

  const startsAt = new Date(Date.now() + 72 * 3_600_000);

  function makeInput(sessionId: string, memberId: string, guestCount: number) {
    return {
      venueId: VENUE_ID,
      externalSessionId: sessionId,
      startsAt,
      endsAt: new Date(startsAt.getTime() + 3_600_000),
      memberId,
      memberName: 'Store Test',
      memberEmail: `${memberId}@example.com`,
      guests: Array.from({ length: guestCount }, (_, i) => ({ name: `G${i}`, email: `g${i}.${memberId}@example.com` })),
      defaultChannelCapacity: 10,
      venueMaximum: 40,
      publicBooked: 20,
      guestPrice: 35,
      maxGuests: 3,
      actor: memberId,
    };
  }

  it('round-trips a booking with its guests', async () => {
    const sessionId = `${VENUE_ID}:store-${Math.random().toString(36).slice(2, 8)}`;
    const created = await store.bookings.create(makeInput(sessionId, 'store-1', 2));
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    expect(created.amountOwedAud).toBe(70);

    const booking = await store.bookings.get(created.bookingId);
    expect(booking).not.toBeNull();
    expect(booking?.spotsTotal).toBe(3);
    expect(booking?.spotsGuest).toBe(2);
    expect(booking?.guests).toHaveLength(2);
    expect(booking?.externalSessionId).toBe(sessionId);
    expect(booking?.paymentStatus).toBe('outstanding');
    expect(booking?.guests.every((guest) => guest.waiverStatus === 'not_sent')).toBe(true);
  });

  it('reports availability with the ringfenced allocation', async () => {
    const sessionId = `${VENUE_ID}:avail-${Math.random().toString(36).slice(2, 8)}`;
    await store.bookings.create(makeInput(sessionId, 'store-avail', 1));

    const rows = await store.sessions.availability(
      VENUE_ID,
      new Date(startsAt.getTime() - 3_600_000),
      new Date(startsAt.getTime() + 3_600_000),
      10,
    );
    const row = rows.find((candidate) => candidate.externalSessionId === sessionId);
    expect(row?.booked).toBe(2);
    expect(row?.spotsRemaining).toBe(8);
  });

  it('stores a waiver, rotates its token and records a signature', async () => {
    const sessionId = `${VENUE_ID}:waiver-${Math.random().toString(36).slice(2, 8)}`;
    const created = await store.bookings.create(makeInput(sessionId, 'store-waiver', 1));
    if (!created.ok) throw new Error('setup failed');
    const booking = await store.bookings.get(created.bookingId);

    const waiver = await store.waivers.create({
      tokenHash: `hash-${Math.random()}`,
      bookingId: created.bookingId,
      guestId: booking!.guests[0]!.guestId,
      venueId: VENUE_ID,
      sessionStartsAt: startsAt,
      guestName: 'G0',
      guestEmail: 'g0@example.com',
      waiverVersion: 'TEST-1',
    });
    expect(waiver.status).toBe('not_sent');

    await store.waivers.markSent(waiver.waiverId, false);
    const rotated = `hash-rotated-${Math.random()}`;
    await store.waivers.rotateToken(waiver.waiverId, rotated);
    expect((await store.waivers.getByTokenHash(rotated))?.waiverId).toBe(waiver.waiverId);

    const signed = await store.waivers.sign({
      waiverId: waiver.waiverId,
      signedName: 'G Zero',
      ip: '203.0.113.7',
      userAgent: 'vitest',
    });
    expect(signed?.status).toBe('signed');
    expect(signed?.signedAt).not.toBeNull();

    // The guest's waiver status must surface on the booking for the door list.
    const refreshed = await store.bookings.get(created.bookingId);
    expect(refreshed?.guests[0]?.waiverStatus).toBe('signed');
  });

  it('records payment and check-in for the door list', async () => {
    const sessionId = `${VENUE_ID}:door-${Math.random().toString(36).slice(2, 8)}`;
    const created = await store.bookings.create(makeInput(sessionId, 'store-door', 1));
    if (!created.ok) throw new Error('setup failed');

    await store.bookings.markPayment(created.bookingId, 'collected', 'door@example.com');
    await store.bookings.setCheckIn({ bookingId: created.bookingId }, true);

    const booking = await store.bookings.get(created.bookingId);
    expect(booking?.paymentStatus).toBe('collected');
    expect(booking?.memberCheckedIn).toBe(true);
  });

  it('throttles repeated sign-in attempts', async () => {
    const bucket = `throttle-${Math.random()}`;
    const outcomes: boolean[] = [];
    for (let i = 0; i < 7; i += 1) outcomes.push(await store.auth.throttle(bucket, 5, 900_000));
    expect(outcomes.filter(Boolean)).toHaveLength(5);
  });

  it('upserts the membership cache and reports the sync time', async () => {
    await store.members.upsertMany([
      {
        memberId: 'cache-1',
        email: 'Cache.One@Example.com',
        firstName: 'Cache',
        lastName: 'One',
        status: 'active',
        homeVenueId: VENUE_ID,
        syncedAt: new Date().toISOString(),
      source: 'hapana' as const,
      },
    ]);
    // Email lookup is case-insensitive: members do not type consistently.
    expect((await store.members.getByEmail('cache.one@example.com'))?.memberId).toBe('cache-1');
    expect(await store.members.lastSyncAt()).not.toBeNull();
  });

  it('queues and marks outbound email', async () => {
    const emailId = await store.outbox.enqueue({
      toEmail: 'outbox@example.com',
      template: 'test',
      payload: { subject: 'hello' },
    });
    expect((await store.outbox.pending(50)).some((entry) => entry.emailId === emailId)).toBe(true);
    await store.outbox.markSent(emailId, 'provider-1');
    expect((await store.outbox.pending(50)).some((entry) => entry.emailId === emailId)).toBe(false);
  });

  it('persists configuration with its documented source', async () => {
    await store.config.set('venue_maximum', 40, 'james@example.com', 'Certificate TOEF-TEST-1');
    const entry = (await store.config.all()).find((candidate) => candidate.key === 'venue_maximum');
    expect(entry?.value).toBe(40);
    expect(entry?.sourceNote).toContain('TOEF-TEST-1');
  });

  /**
   * Staff accounts. The upsert conflicts on the email column, which only the
   * Postgres implementation does: the in-memory store matches on a scan, so it
   * would pass whether or not the unique constraint and the ON CONFLICT target
   * actually agree.
   */
  it('creates a staff account and updates it in place on the same address', async () => {
    const email = `staff-${Math.random().toString(36).slice(2, 10)}@example.com`;

    const created = await store.auth.upsertStaff({
      email,
      displayName: 'First Name',
      role: 'door',
      venueIds: [VENUE_ID],
    });
    expect(created.active).toBe(true);
    expect(created.venueIds).toEqual([VENUE_ID]);

    const updated = await store.auth.upsertStaff({
      email,
      displayName: 'Second Name',
      role: 'manager',
      venueIds: [VENUE_ID],
    });

    // Same row, not a second account: the id is what audit trails point at.
    expect(updated.staffId).toBe(created.staffId);
    expect(updated.displayName).toBe('Second Name');
    expect(updated.role).toBe('manager');
    expect((await store.auth.listStaff()).filter((s) => s.email === email)).toHaveLength(1);
  });

  it('deactivates without deleting, and re-adding restores the same account', async () => {
    const email = `staff-${Math.random().toString(36).slice(2, 10)}@example.com`;
    const created = await store.auth.upsertStaff({ email, displayName: 'Dot', role: 'door', venueIds: [VENUE_ID] });

    await store.auth.setStaffActive(created.staffId, false);
    expect(await store.auth.getStaffByEmail(email)).toBeNull();
    expect(await store.auth.getStaff(created.staffId)).toBeNull();
    // Still on the record, so anything referencing the id still resolves.
    expect((await store.auth.listStaff()).find((s) => s.staffId === created.staffId)?.active).toBe(false);

    const restored = await store.auth.upsertStaff({ email, displayName: 'Dot', role: 'door', venueIds: [VENUE_ID] });
    expect(restored.staffId).toBe(created.staffId);
    expect(restored.active).toBe(true);
    expect(await store.auth.getStaffByEmail(email)).not.toBeNull();
  });

  it('returns null rather than throwing for an id that is not there', async () => {
    expect(await store.auth.setStaffActive('00000000-0000-0000-0000-000000000000', false)).toBeNull();
  });
});
