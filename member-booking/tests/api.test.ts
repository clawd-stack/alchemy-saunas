import { beforeEach, describe, expect, it } from 'vitest';
import { overrideContext } from '../src/domain/context.ts';
import { createMemoryStore, type MemoryStore } from '../src/store/memory.ts';
import { createMockHapana } from '../src/adapters/hapana/mock.ts';
import { issueMemberSession, issueStaffSession } from '../src/lib/auth.ts';
import { MEMBER_COOKIE, STAFF_COOKIE } from '../src/lib/http.ts';
import { ACTIVE_MEMBER, PAUSED_MEMBER, futureSession, VENUE_ID } from './helpers.ts';

import sessionsHandler from '../netlify/functions/sessions.ts';
import authRequestHandler from '../netlify/functions/auth-request.ts';
import bookingsHandler from '../netlify/functions/bookings.ts';
import cancelHandler from '../netlify/functions/booking-cancel.ts';
import doorListHandler from '../netlify/functions/doorlist.ts';
import doorUpdateHandler from '../netlify/functions/door-update.ts';
import adminConfigHandler from '../netlify/functions/admin-config.ts';
import reconciliationHandler from '../netlify/functions/admin-reconciliation.ts';
import healthHandler from '../netlify/functions/health.ts';

/**
 * The API layer as HTTP: status codes, cookies, and what a caller can and
 * cannot see. The domain tests cover the rules; these cover the edges where a
 * mistake leaks something or returns the wrong shape.
 */

const BASE = 'http://localhost:8888';
let store: MemoryStore;
let session: ReturnType<typeof futureSession>;

function get(path: string, cookie?: string): Request {
  return new Request(`${BASE}${path}`, { headers: cookie ? { cookie } : {} });
}

function post(path: string, body: unknown, cookie?: string): Request {
  return new Request(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
  });
}

function memberCookie() {
  return `${MEMBER_COOKIE}=${issueMemberSession({
    memberId: ACTIVE_MEMBER.memberId,
    email: ACTIVE_MEMBER.email,
    name: 'Ada Active',
  })}`;
}

function staffCookie(role: 'door' | 'manager' | 'admin' = 'door') {
  return `${STAFF_COOKIE}=${issueStaffSession({
    staffId: 'staff-1',
    email: 'door@example.com',
    displayName: 'Door Staff',
    role,
    venueIds: [VENUE_ID],
  })}`;
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
  overrideContext(
    store,
    createMockHapana({ members: [ACTIVE_MEMBER, PAUSED_MEMBER], supportsWrites: false }),
  );
});

describe('GET /api/sessions', () => {
  it('lists availability without requiring sign-in', async () => {
    const response = await sessionsHandler(get('/api/sessions'));
    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body.ok).toBe(true);
    expect(body.signedIn).toBe(false);
    expect(body.policy.maxGuests).toBe(3);
    expect(body.sessions.length).toBeGreaterThan(0);
  });

  it('never exposes venue-wide occupancy to a member', async () => {
    const body = await (await sessionsHandler(get('/api/sessions'))).json();
    for (const view of body.sessions) {
      expect(view).not.toHaveProperty('publicBooked');
    }
  });

  it('reports the signed-in member', async () => {
    const body = await (await sessionsHandler(get('/api/sessions', memberCookie()))).json();
    expect(body.signedIn).toBe(true);
    expect(body.memberName).toBe('Ada Active');
  });
});

describe('POST /api/auth/request', () => {
  it('answers identically for a member, a paused member and a stranger', async () => {
    const bodies = [];
    for (const email of [ACTIVE_MEMBER.email, PAUSED_MEMBER.email, 'nobody@example.com']) {
      const response = await authRequestHandler(post('/api/auth/request', { email }));
      expect(response.status).toBe(200);
      bodies.push(await response.json());
    }
    // Nothing in the response distinguishes the three cases.
    expect(new Set(bodies.map((body) => JSON.stringify(body))).size).toBe(1);
  });

  it('only actually emails the active member', async () => {
    for (const email of [ACTIVE_MEMBER.email, PAUSED_MEMBER.email, 'nobody@example.com']) {
      await authRequestHandler(post('/api/auth/request', { email }));
    }
    const links = store.outboxAll().filter((entry) => entry.template === 'magic_link');
    expect(links.map((entry) => entry.toEmail)).toEqual([ACTIVE_MEMBER.email]);
  });

  it('rejects a malformed email', async () => {
    const response = await authRequestHandler(post('/api/auth/request', { email: 'not-an-email' }));
    expect(response.status).toBe(400);
  });

  it('throttles repeated requests for the same address', async () => {
    const statuses = [];
    for (let i = 0; i < 7; i += 1) {
      statuses.push((await authRequestHandler(post('/api/auth/request', { email: ACTIVE_MEMBER.email }))).status);
    }
    expect(statuses.filter((status) => status === 429).length).toBeGreaterThan(0);
  });
});

describe('/api/bookings', () => {
  it('refuses an unauthenticated booking', async () => {
    const response = await bookingsHandler(post('/api/bookings', { sessionId: session.id }));
    expect(response.status).toBe(401);
  });

  it('creates a booking and returns 201 with the amount owed', async () => {
    const response = await bookingsHandler(
      post('/api/bookings', { sessionId: session.id, guests: [{ name: 'Guest One', email: 'g1@example.com' }] }, memberCookie()),
    );
    expect(response.status).toBe(201);

    const body = await response.json();
    expect(body.booking.spotsTotal).toBe(2);
    expect(body.booking.amountOwedAud).toBe(35);
    expect(body.message).toContain('$35.00');
  });

  it('refuses a member whose membership is no longer active', async () => {
    const cookie = `${MEMBER_COOKIE}=${issueMemberSession({
      memberId: PAUSED_MEMBER.memberId,
      email: PAUSED_MEMBER.email,
      name: 'Pat Paused',
    })}`;
    const response = await bookingsHandler(post('/api/bookings', { sessionId: session.id, guests: [] }, cookie));
    expect(response.status).toBe(403);
    expect((await response.json()).code).toBe('NO_ACTIVE_MEMBERSHIP');
  });

  it('rejects a request with no session id', async () => {
    const response = await bookingsHandler(post('/api/bookings', { guests: [] }, memberCookie()));
    expect(response.status).toBe(400);
  });

  it('lists the member\'s own bookings with a cancellable flag', async () => {
    await bookingsHandler(post('/api/bookings', { sessionId: session.id, guests: [] }, memberCookie()));
    const body = await (await bookingsHandler(get('/api/bookings', memberCookie()))).json();
    expect(body.bookings).toHaveLength(1);
    expect(body.bookings[0].canCancel).toBe(true);
    expect(body.bookings[0].sessionLabel).toBeTruthy();
  });
});

describe('/api/bookings/cancel', () => {
  it('cancels a booking the member owns', async () => {
    const created = await (await bookingsHandler(
      post('/api/bookings', { sessionId: session.id, guests: [] }, memberCookie()),
    )).json();

    const response = await cancelHandler(post('/api/bookings/cancel', { bookingId: created.booking.bookingId }, memberCookie()));
    expect(response.status).toBe(200);
    expect((await response.json()).booking.status).toBe('cancelled');
  });

  it('gives 404, not 403, for a booking belonging to someone else', async () => {
    const created = await (await bookingsHandler(
      post('/api/bookings', { sessionId: session.id, guests: [] }, memberCookie()),
    )).json();

    const otherCookie = `${MEMBER_COOKIE}=${issueMemberSession({ memberId: 'someone-else', email: 'x@example.com', name: 'X' })}`;
    const response = await cancelHandler(post('/api/bookings/cancel', { bookingId: created.booking.bookingId }, otherCookie));
    // Not 403: confirming the booking exists would leak that it does.
    expect(response.status).toBe(404);
  });
});

describe('door list', () => {
  it('requires staff authentication', async () => {
    expect((await doorListHandler(get('/api/door/list'))).status).toBe(401);
    expect((await doorUpdateHandler(post('/api/door/update', { bookingId: 'x', checkedIn: true }))).status).toBe(401);
    expect((await reconciliationHandler(get('/api/admin/reconciliation'))).status).toBe(401);
  });

  it('is not reachable with a member cookie', async () => {
    expect((await doorListHandler(get('/api/door/list', memberCookie()))).status).toBe(401);
  });

  it('shows the session with amounts owed once staff sign in', async () => {
    await bookingsHandler(
      post('/api/bookings', { sessionId: session.id, guests: [{ name: 'Guest One', email: 'g1@example.com' }] }, memberCookie()),
    );

    const body = await (await doorListHandler(get(`/api/door/list?session=${encodeURIComponent(session.id)}`, staffCookie()))).json();
    expect(body.doorList.rows).toHaveLength(1);
    expect(body.doorList.totals.owed).toBe(35);
    expect(body.doorList.rows[0].guests[0].waiverStatus).toBe('sent');
  });

  it('records payment collected', async () => {
    const created = await (await bookingsHandler(
      post('/api/bookings', { sessionId: session.id, guests: [{ name: 'G', email: 'g@example.com' }] }, memberCookie()),
    )).json();

    const response = await doorUpdateHandler(
      post('/api/door/update', { bookingId: created.booking.bookingId, paymentStatus: 'collected' }, staffCookie()),
    );
    expect(response.status).toBe(200);
    expect((await store.bookings.get(created.booking.bookingId))?.paymentStatus).toBe('collected');
  });

  it('rejects a payment status that is not one of the three allowed', async () => {
    const response = await doorUpdateHandler(
      post('/api/door/update', { bookingId: 'x', paymentStatus: 'refunded' }, staffCookie()),
    );
    expect(response.status).toBe(400);
  });

  it('exports the reconciliation CSV as a download', async () => {
    await bookingsHandler(
      post('/api/bookings', { sessionId: session.id, guests: [{ name: 'G', email: 'g@example.com' }] }, memberCookie()),
    );
    const response = await reconciliationHandler(get('/api/admin/reconciliation', staffCookie()));
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/csv');
    expect(response.headers.get('content-disposition')).toContain('attachment');
  });
});

describe('admin config', () => {
  it('is closed to door staff', async () => {
    expect((await adminConfigHandler(get('/api/admin/config', staffCookie('door')))).status).toBe(403);
  });

  it('reports the live configuration to a manager, with no outstanding warnings by default', async () => {
    const body = await (await adminConfigHandler(get('/api/admin/config', staffCookie('manager')))).json();
    expect(body.ok).toBe(true);
    expect(body.config.memberChannelCapacity).toBe(10);
    // No ceiling is enforced, and the waiver is real wording rather than a
    // placeholder, so there is nothing to warn about out of the box.
    expect(body.config.venueMaximum).toBeNull();
    expect(body.warnings).toEqual([]);
  });

  it('warns when a ceiling is set without a recorded source', async () => {
    await store.config.set('venue_maximum', 40, 'setup');
    const body = await (await adminConfigHandler(get('/api/admin/config', staffCookie('manager')))).json();
    expect(body.warnings.some((warning: string) => warning.includes('no documented source'))).toBe(true);
  });

  it('rejects an allocation that breaches a configured ceiling, with a usable message', async () => {
    await store.config.set('venue_maximum', 40, 'setup', 'Certificate TOEF-1');
    await store.config.set('hapana_public_capacity', 20, 'setup');

    const response = await adminConfigHandler(
      new Request(`${BASE}/api/admin/config`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', cookie: staffCookie('admin') },
        body: JSON.stringify({ updates: { member_channel_capacity: 25 } }),
      }),
    );
    expect(response.status).toBe(400);

    const body = await response.json();
    expect(body.code).toBe('CONFIG_INVALID');
    expect(body.issues[0].message).toContain('above the venue maximum');
  });

  it('saves edited waiver wording without a deploy', async () => {
    const response = await adminConfigHandler(
      new Request(`${BASE}/api/admin/config`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', cookie: staffCookie('admin') },
        body: JSON.stringify({
          updates: {
            waiver_text: {
              version: 'ALCHEMY-TOU-2026-10',
              title: 'Guest acknowledgement',
              intro: 'Please read and sign.',
              termsUrl: 'https://alchemysaunas.com.au/terms-of-use',
              termsLabel: 'Terms of Use',
              clauses: [{ heading: 'Age', body: 'You must be 18 or over.' }],
              declaration: 'I agree.',
            },
          },
        }),
      }),
    );
    expect(response.status).toBe(200);
    expect((await response.json()).config.waiverText.clauses).toHaveLength(1);
  });

  it('refuses waiver wording with no declaration for the guest to agree to', async () => {
    const response = await adminConfigHandler(
      new Request(`${BASE}/api/admin/config`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', cookie: staffCookie('admin') },
        body: JSON.stringify({
          updates: { waiver_text: { version: 'X', clauses: [{ heading: 'A', body: 'B' }], declaration: '' } },
        }),
      }),
    );
    expect(response.status).toBe(400);
  });
});

describe('GET /api/health', () => {
  it('passes the waiver, hours and capacity checks now they are confirmed', async () => {
    const body = await (await healthHandler(get('/api/health'))).json();
    type Check = { name: string; ok: boolean; detail: string };
    const byName = new Map<string, Check>(
      (body.checks as Check[]).map((check) => [check.name, check]),
    );

    expect(byName.get('waiver_wording')?.ok).toBe(true);
    expect(byName.get('venue_maximum_source')?.ok).toBe(true);
    expect(byName.get('venue_maximum_source')?.detail).toContain('10 spots per hour');
    expect(byName.get('operating_hours')?.ok).toBe(true);
    expect(byName.get('operating_hours')?.detail).toContain('05:00');
  });

  it('still reports the channel as not ready while deployment settings are missing', async () => {
    const body = await (await healthHandler(get('/api/health'))).json();
    // No Hapana key and no real email provider in the test environment, so the
    // endpoint must not claim the channel is safe to open.
    expect(body.readyForMembers).toBe(false);
    const names = body.checks.filter((check: { ok: boolean }) => !check.ok).map((check: { name: string }) => check.name);
    expect(names).toContain('hapana_credentials');
    expect(names).toContain('email_provider');
  });
});
