import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { overrideContext } from '../src/domain/context.ts';
import { createMemoryStore, type MemoryStore } from '../src/store/memory.ts';
import { createMockHapana } from '../src/adapters/hapana/mock.ts';
import { issueStaffSession } from '../src/lib/auth.ts';
import { STAFF_COOKIE } from '../src/lib/http.ts';
import { ACTIVE_MEMBER, VENUE_ID } from './helpers.ts';

import bootstrapHandler from '../netlify/functions/admin-bootstrap.ts';
import staffHandler from '../netlify/functions/admin-staff.ts';

/**
 * Getting in, and deciding who else can.
 *
 * Both endpoints exist to break the same deadlock: every route into the admin
 * screen is an emailed link, and the thing being configured is email. These
 * tests are mostly about what the endpoints refuse, because a break-glass
 * credential that refuses too little is a second front door.
 */

const BASE = 'http://localhost:8888';
const TOKEN = 'a'.repeat(40);

let store: MemoryStore;

const ADMIN = {
  staffId: 'staff-admin',
  email: 'admin@example.com',
  displayName: 'Ada Admin',
  role: 'admin' as const,
  venueIds: [VENUE_ID],
  active: true,
};

function post(path: string, body: unknown, cookie?: string, method = 'POST'): Request {
  return new Request(`${BASE}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
  });
}

function get(path: string, cookie?: string): Request {
  return new Request(`${BASE}${path}`, { headers: cookie ? { cookie } : {} });
}

function cookieFor(staff: { staffId: string; email: string; displayName: string; role: 'door' | 'manager' | 'admin' }) {
  return `${STAFF_COOKIE}=${issueStaffSession({ ...staff, venueIds: [VENUE_ID] })}`;
}

beforeEach(() => {
  store = createMemoryStore();
  store.seedStaff({ ...ADMIN });
  overrideContext(store, createMockHapana({ members: [ACTIVE_MEMBER], supportsWrites: false }));
  delete process.env.ADMIN_BOOTSTRAP_TOKEN;
  delete process.env.ADMIN_BOOTSTRAP_EMAIL;
});

afterEach(() => {
  delete process.env.ADMIN_BOOTSTRAP_TOKEN;
  delete process.env.ADMIN_BOOTSTRAP_EMAIL;
});

describe('break-glass admin sign-in', () => {
  it('does not exist when no token is configured', async () => {
    const response = await bootstrapHandler(post('/api/admin/bootstrap', { token: TOKEN }));
    expect(response.status).toBe(404);
    expect((await response.json()).code).toBe('BOOTSTRAP_DISABLED');
  });

  it('refuses a token that is too short to be worth having', async () => {
    process.env.ADMIN_BOOTSTRAP_TOKEN = 'short';
    const response = await bootstrapHandler(post('/api/admin/bootstrap', { token: 'short' }));
    expect(response.status).toBe(500);
    expect((await response.json()).code).toBe('BOOTSTRAP_TOKEN_TOO_SHORT');
  });

  it('refuses the wrong token', async () => {
    process.env.ADMIN_BOOTSTRAP_TOKEN = TOKEN;
    const response = await bootstrapHandler(post('/api/admin/bootstrap', { token: 'b'.repeat(40) }));
    expect(response.status).toBe(401);
    expect(response.headers.get('set-cookie')).toBeNull();
  });

  it('refuses an empty token, which is what a missing field looks like', async () => {
    process.env.ADMIN_BOOTSTRAP_TOKEN = TOKEN;
    expect((await bootstrapHandler(post('/api/admin/bootstrap', {}))).status).toBe(401);
    expect((await bootstrapHandler(post('/api/admin/bootstrap', { token: '' }))).status).toBe(401);
  });

  it('signs in as the only active admin and sets a staff cookie', async () => {
    process.env.ADMIN_BOOTSTRAP_TOKEN = TOKEN;
    const response = await bootstrapHandler(post('/api/admin/bootstrap', { token: TOKEN }));
    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body.email).toBe(ADMIN.email);

    const cookie = response.headers.get('set-cookie') ?? '';
    expect(cookie).toContain(STAFF_COOKIE);
    expect(cookie.toLowerCase()).toContain('httponly');

    // The cookie has to actually authenticate, not merely be present.
    const value = cookie.split(';')[0];
    expect((await staffHandler(get('/api/admin/staff', value))).status).toBe(200);
  });

  it('refuses to guess when more than one admin could be meant', async () => {
    process.env.ADMIN_BOOTSTRAP_TOKEN = TOKEN;
    store.seedStaff({ ...ADMIN, staffId: 'staff-admin-2', email: 'second@example.com', displayName: 'Bo Admin' });

    const response = await bootstrapHandler(post('/api/admin/bootstrap', { token: TOKEN }));
    expect(response.status).toBe(409);
    expect((await response.json()).code).toBe('NO_BOOTSTRAP_ADMIN');
  });

  it('signs in as the named admin when there are several', async () => {
    process.env.ADMIN_BOOTSTRAP_TOKEN = TOKEN;
    process.env.ADMIN_BOOTSTRAP_EMAIL = 'second@example.com';
    store.seedStaff({ ...ADMIN, staffId: 'staff-admin-2', email: 'second@example.com', displayName: 'Bo Admin' });

    const body = await (await bootstrapHandler(post('/api/admin/bootstrap', { token: TOKEN }))).json();
    expect(body.email).toBe('second@example.com');
  });

  it('cannot reach a door account, however it is named', async () => {
    process.env.ADMIN_BOOTSTRAP_TOKEN = TOKEN;
    process.env.ADMIN_BOOTSTRAP_EMAIL = 'door@example.com';
    store.seedStaff({ ...ADMIN, staffId: 'staff-door', email: 'door@example.com', displayName: 'Dot Door', role: 'door' });

    const response = await bootstrapHandler(post('/api/admin/bootstrap', { token: TOKEN }));
    expect(response.status).toBe(409);
  });

  it('cannot reach a deactivated admin', async () => {
    process.env.ADMIN_BOOTSTRAP_TOKEN = TOKEN;
    process.env.ADMIN_BOOTSTRAP_EMAIL = ADMIN.email;
    await store.auth.setStaffActive(ADMIN.staffId, false);

    expect((await bootstrapHandler(post('/api/admin/bootstrap', { token: TOKEN }))).status).toBe(409);
  });

  it('rate limits guessing', async () => {
    process.env.ADMIN_BOOTSTRAP_TOKEN = TOKEN;
    const attempt = () =>
      bootstrapHandler(
        new Request(`${BASE}/api/admin/bootstrap`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.9' },
          body: JSON.stringify({ token: 'wrong-'.repeat(8) }),
        }),
      );

    const statuses: number[] = [];
    for (let i = 0; i < 7; i += 1) statuses.push((await attempt()).status);

    expect(statuses.slice(0, 5)).toEqual([401, 401, 401, 401, 401]);
    expect(statuses.slice(5)).toEqual([429, 429]);
  });

  it('is not a GET, so it cannot be triggered by a link somebody clicks', async () => {
    process.env.ADMIN_BOOTSTRAP_TOKEN = TOKEN;
    const response = await bootstrapHandler(get(`/api/admin/bootstrap?token=${TOKEN}`));
    expect(response.status).toBe(400);
  });
});

describe('staff accounts', () => {
  const adminCookie = () => cookieFor(ADMIN);

  it('is closed to anyone not signed in', async () => {
    expect((await staffHandler(get('/api/admin/staff'))).status).toBe(401);
  });

  it('is closed to door staff and to managers', async () => {
    for (const role of ['door', 'manager'] as const) {
      const cookie = cookieFor({ staffId: 's', email: `${role}@example.com`, displayName: role, role });
      expect((await staffHandler(get('/api/admin/staff', cookie))).status).toBe(403);
    }
  });

  it('adds someone, defaulting them to this venue', async () => {
    const body = await (await staffHandler(
      post('/api/admin/staff', { email: 'Dot@Example.com ', name: 'Dot Door', role: 'door' }, adminCookie()),
    )).json();

    expect(body.staff.email).toBe('dot@example.com');
    expect(body.staff.venueIds).toEqual([VENUE_ID]);
    expect(body.staff.active).toBe(true);
    expect(await store.auth.getStaffByEmail('dot@example.com')).not.toBeNull();
  });

  it('rejects a role it does not recognise', async () => {
    const response = await staffHandler(
      post('/api/admin/staff', { email: 'x@example.com', name: 'X', role: 'owner' }, adminCookie()),
    );
    expect(response.status).toBe(400);
  });

  it('updates in place rather than creating a second account for one address', async () => {
    await staffHandler(post('/api/admin/staff', { email: 'dot@example.com', name: 'Dot Door', role: 'door' }, adminCookie()));
    await staffHandler(post('/api/admin/staff', { email: 'dot@example.com', name: 'Dot Manager', role: 'manager' }, adminCookie()));

    const all = await store.auth.listStaff();
    expect(all.filter((s) => s.email === 'dot@example.com')).toHaveLength(1);
    expect(all.find((s) => s.email === 'dot@example.com')?.role).toBe('manager');
  });

  it('deactivates rather than deletes, so audit trails keep resolving', async () => {
    const created = await (await staffHandler(
      post('/api/admin/staff', { email: 'dot@example.com', name: 'Dot Door', role: 'door' }, adminCookie()),
    )).json();

    const response = await staffHandler(
      post('/api/admin/staff', { staffId: created.staff.staffId, active: false }, adminCookie(), 'PATCH'),
    );
    expect(response.status).toBe(200);

    // Gone for sign-in, still on the record.
    expect(await store.auth.getStaffByEmail('dot@example.com')).toBeNull();
    expect((await store.auth.listStaff()).some((s) => s.email === 'dot@example.com')).toBe(true);
  });

  it('restores a deactivated account by re-adding the address', async () => {
    const created = await (await staffHandler(
      post('/api/admin/staff', { email: 'dot@example.com', name: 'Dot Door', role: 'door' }, adminCookie()),
    )).json();
    await staffHandler(post('/api/admin/staff', { staffId: created.staff.staffId, active: false }, adminCookie(), 'PATCH'));

    const again = await (await staffHandler(
      post('/api/admin/staff', { email: 'dot@example.com', name: 'Dot Door', role: 'door' }, adminCookie()),
    )).json();

    expect(again.staff.staffId).toBe(created.staff.staffId);
    expect(again.staff.active).toBe(true);
  });

  it('refuses to let an admin lock themselves out', async () => {
    const deactivateSelf = await staffHandler(
      post('/api/admin/staff', { staffId: ADMIN.staffId, active: false }, adminCookie(), 'PATCH'),
    );
    expect(deactivateSelf.status).toBe(400);

    const demoteSelf = await staffHandler(
      post('/api/admin/staff', { email: ADMIN.email, name: ADMIN.displayName, role: 'manager' }, adminCookie()),
    );
    expect(demoteSelf.status).toBe(400);
    // The refusal happens before the write, so the account is untouched.
    expect((await store.auth.getStaffByEmail(ADMIN.email))?.role).toBe('admin');
  });

  it('refuses to deactivate the last admin, even by another admin', async () => {
    store.seedStaff({ ...ADMIN, staffId: 'staff-admin-2', email: 'second@example.com', displayName: 'Bo Admin' });
    const second = cookieFor({ staffId: 'staff-admin-2', email: 'second@example.com', displayName: 'Bo Admin', role: 'admin' });

    // Two admins: removing one is fine.
    expect(
      (await staffHandler(post('/api/admin/staff', { staffId: ADMIN.staffId, active: false }, second, 'PATCH'))).status,
    ).toBe(200);

    // One admin left, and they are the caller, so the self-lockout guard holds.
    expect(
      (await staffHandler(post('/api/admin/staff', { staffId: 'staff-admin-2', active: false }, second, 'PATCH'))).status,
    ).toBe(400);
  });

  it('404s on an account that does not exist', async () => {
    const response = await staffHandler(post('/api/admin/staff', { staffId: 'nope', active: false }, adminCookie(), 'PATCH'));
    expect(response.status).toBe(404);
  });
});
