import { beforeEach, describe, expect, it } from 'vitest';
import { overrideContext } from '../src/domain/context.ts';
import { createMemoryStore, type MemoryStore } from '../src/store/memory.ts';
import { createMockHapana } from '../src/adapters/hapana/mock.ts';
import { createUnavailableMembership } from '../src/adapters/hapana/adapter.ts';
import { issueMemberSession, issueStaffSession } from '../src/lib/auth.ts';
import { MEMBER_COOKIE, STAFF_COOKIE } from '../src/lib/http.ts';
import { ACTIVE_MEMBER, PAUSED_MEMBER, futureSession, VENUE_ID } from './helpers.ts';

import accountHandler from '../netlify/functions/account.ts';
import bookingsHandler from '../netlify/functions/bookings.ts';
import cancelHandler from '../netlify/functions/booking-cancel.ts';

/**
 * The account page's one request.
 *
 * Its job is to be a straight answer about a member's own standing, so what
 * matters is that it separates what is coming up from what has already
 * happened, reports membership honestly rather than optimistically, and shows
 * nobody anything that is not theirs.
 */

const BASE = 'http://localhost:8888';
let store: MemoryStore;
let session: ReturnType<typeof futureSession>;

function get(cookie?: string): Request {
  return new Request(`${BASE}/api/account`, { headers: cookie ? { cookie } : {} });
}

function memberCookie(member = ACTIVE_MEMBER, name = 'Ada Active') {
  return `${MEMBER_COOKIE}=${issueMemberSession({ memberId: member.memberId, email: member.email, name })}`;
}

function post(path: string, body: unknown, cookie: string): Request {
  return new Request(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  store = createMemoryStore();
  session = futureSession(48);
  store.seedSession({
    venueId: VENUE_ID,
    externalSessionId: session.id,
    startsAt: session.startsAt,
    endsAt: session.endsAt,
  });
  overrideContext(store, createMockHapana({ members: [ACTIVE_MEMBER, PAUSED_MEMBER], supportsWrites: false }));
});

describe('GET /api/account', () => {
  it('requires a member session', async () => {
    expect((await accountHandler(get())).status).toBe(401);

    // A staff cookie is not a member cookie, whatever else it opens.
    const staff = `${STAFF_COOKIE}=${issueStaffSession({
      staffId: 's1',
      email: 'admin@example.com',
      displayName: 'Ada Admin',
      role: 'admin',
      venueIds: [VENUE_ID],
    })}`;
    expect((await accountHandler(get(staff))).status).toBe(401);
  });

  it('reports an active membership with the member details', async () => {
    const body = await (await accountHandler(get(memberCookie()))).json();
    expect(body.membership.active).toBe(true);
    expect(body.membership.status).toBe('active');
    expect(body.membership.heldBy).toBe('hapana');
    expect(body.member.email).toBe(ACTIVE_MEMBER.email);
  });

  it('says so when the membership is no longer active', async () => {
    // Signed in earlier, membership lapsed since. The page has to show that
    // rather than wait for a booking to be refused.
    const body = await (await accountHandler(get(memberCookie(PAUSED_MEMBER, 'Pat Paused')))).json();
    expect(body.membership.active).toBe(false);
    expect(body.membership.status).toBe('paused');
  });

  it('marks a member the venue holds itself', async () => {
    await store.members.upsertManual({
      email: 'manual@example.com',
      firstName: 'Mo',
      lastName: 'Manual',
      status: 'active',
      homeVenueId: VENUE_ID,
    });
    const cookie = `${MEMBER_COOKIE}=${issueMemberSession({
      memberId: 'manual:manual@example.com',
      email: 'manual@example.com',
      name: 'Mo Manual',
    })}`;

    const body = await (await accountHandler(get(cookie))).json();
    expect(body.membership.active).toBe(true);
    expect(body.membership.heldBy).toBe('venue');
  });

  it('separates what is coming up from what has already happened', async () => {
    const created = await (await bookingsHandler(
      post('/api/bookings', { sessionId: session.id, guests: [{ name: 'Guest One', email: 'g1@example.com' }] }, memberCookie()),
    )).json();
    expect(created.ok).toBe(true);

    const body = await (await accountHandler(get(memberCookie()))).json();
    expect(body.upcoming).toHaveLength(1);
    expect(body.previous).toHaveLength(0);
    expect(body.upcoming[0].spotsTotal).toBe(2);
    expect(body.upcoming[0].canCancel).toBe(true);
    expect(body.stats.sessionsAttended).toBe(0);
  });

  it('moves a cancelled booking out of what is coming up', async () => {
    const created = await (await bookingsHandler(
      post('/api/bookings', { sessionId: session.id, guests: [] }, memberCookie()),
    )).json();
    const cancelled = await cancelHandler(post('/api/bookings/cancel', { bookingId: created.booking.bookingId }, memberCookie()));
    expect(cancelled.status).toBe(200);

    const body = await (await accountHandler(get(memberCookie()))).json();
    expect(body.upcoming).toHaveLength(0);
    expect(body.previous).toHaveLength(1);
    expect(body.previous[0].status).toBe('cancelled');
    // A cancelled booking is not a session attended.
    expect(body.stats.sessionsAttended).toBe(0);
  });

  it('shows nobody anybody else’s bookings', async () => {
    await bookingsHandler(post('/api/bookings', { sessionId: session.id, guests: [] }, memberCookie()));

    const other = `${MEMBER_COOKIE}=${issueMemberSession({
      memberId: PAUSED_MEMBER.memberId,
      email: PAUSED_MEMBER.email,
      name: 'Pat Paused',
    })}`;
    const body = await (await accountHandler(get(other))).json();
    expect(body.upcoming).toHaveLength(0);
    expect(body.previous).toHaveLength(0);
  });

  it('still answers when the membership system is unreachable', async () => {
    // The account page must not go blank during a Hapana outage: it is where
    // a member goes to find out what is happening.
    overrideContext(store, createUnavailableMembership('no key'));
    const response = await accountHandler(get(memberCookie()));
    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body.membership.active).toBe(false);
    expect(Array.isArray(body.upcoming)).toBe(true);
  });

  it('carries the policy the page quotes, rather than the page hard-coding it', async () => {
    const body = await (await accountHandler(get(memberCookie()))).json();
    expect(body.policy.cancellationCutoffHours).toBeGreaterThan(0);
    expect(body.policy.maxGuestsPerMember).toBeGreaterThan(0);
    expect(body.policy.guestPrice).toBeGreaterThan(0);
  });
});
