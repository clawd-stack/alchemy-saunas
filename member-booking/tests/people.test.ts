import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { overrideContext } from '../src/domain/context.ts';
import { createMemoryStore, type MemoryStore } from '../src/store/memory.ts';
import { createMockHapana } from '../src/adapters/hapana/mock.ts';
import { issueStaffSession } from '../src/lib/auth.ts';
import { hashPassword } from '../src/lib/password.ts';
import { STAFF_COOKIE } from '../src/lib/http.ts';
import { ACTIVE_MEMBER, VENUE_ID } from './helpers.ts';

import peopleHandler from '../netlify/functions/admin-people.ts';
import loginHandler from '../netlify/functions/auth-login.ts';

/**
 * /api/admin/people, which replaced three screens over three tables.
 *
 * The point of collapsing them is that the joining between them was left to
 * the admin, and the join was where things went wrong. So most of what is
 * pinned here is that one row now tells the whole truth about a person, and
 * that the lockout guards the three screens each carried separately survived
 * being merged into one.
 */

const BASE = 'http://localhost:8888';
let store: MemoryStore;

const ADMIN = {
  staffId: 'staff-admin',
  email: 'admin@example.com',
  displayName: 'Ada Admin',
  role: 'admin' as const,
  venueIds: [VENUE_ID],
  active: true,
};

function adminCookie() {
  return `${STAFF_COOKIE}=${issueStaffSession(ADMIN)}`;
}

function call(body: unknown, method = 'POST', cookie = adminCookie()): Request {
  return new Request(`${BASE}/api/admin/people`, {
    method,
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify(body),
  });
}

function get(cookie = adminCookie()): Request {
  return new Request(`${BASE}/api/admin/people`, { headers: { cookie } });
}

async function list(cookie = adminCookie()) {
  const body = await (await peopleHandler(get(cookie))).json();
  return new Map<string, any>(body.people.map((p: any) => [p.email, p]));
}

function login(email: string, password: string): Request {
  return new Request(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
}

beforeEach(() => {
  store = createMemoryStore();
  store.seedStaff({ ...ADMIN });
  overrideContext(store, createMockHapana({ members: [ACTIVE_MEMBER], supportsWrites: false }));
});

describe('one list', () => {
  it('puts staff and members in the same list, each with one role', async () => {
    await peopleHandler(call({ action: 'add', email: 'door@example.com', name: 'Dee Door', role: 'door' }));
    await peopleHandler(call({ action: 'add', email: 'mem@example.com', name: 'Mem Ber', role: 'member' }));

    const people = await list();
    expect(people.get('admin@example.com').role).toBe('admin');
    expect(people.get('door@example.com').role).toBe('door');
    expect(people.get('mem@example.com').role).toBe('member');
  });

  it('never returns password material', async () => {
    await peopleHandler(call({ action: 'add', email: 'mem@example.com', name: 'Mem Ber', role: 'member' }));
    const body = await (await peopleHandler(get())).json();
    expect(JSON.stringify(body)).not.toContain('scrypt$');
    expect(JSON.stringify(body)).not.toContain('passwordHash');
  });

  it('says whether each person can actually sign in', async () => {
    await store.members.upsertManual({ email: 'nopass@example.com', firstName: 'No', lastName: 'Pass', status: 'active', homeVenueId: VENUE_ID });
    const added = await (await peopleHandler(call({ action: 'add', email: 'fresh@example.com', name: 'Fresh One', role: 'member' }))).json();
    await store.credentials.setPassword({ email: 'chosen@example.com', passwordHash: await hashPassword('a-chosen-password'), mustChange: false });
    await store.members.upsertManual({ email: 'chosen@example.com', firstName: 'Chose', lastName: 'N', status: 'active', homeVenueId: VENUE_ID });

    const people = await list();
    expect(people.get('nopass@example.com').signIn).toBe('none');
    expect(people.get('fresh@example.com').signIn).toBe('issued');
    expect(people.get('chosen@example.com').signIn).toBe('active');
    expect(added.password).toBeTruthy();
  });

  it('is closed to anyone but an admin', async () => {
    const manager = `${STAFF_COOKIE}=${issueStaffSession({ ...ADMIN, staffId: 's2', email: 'm@example.com', role: 'manager' })}`;
    expect((await peopleHandler(get(manager))).status).toBe(403);
    expect((await peopleHandler(new Request(`${BASE}/api/admin/people`))).status).toBe(401);
  });
});

describe('roles', () => {
  it('moves somebody from member to staff, and the membership does not linger', async () => {
    await peopleHandler(call({ action: 'add', email: 'up@example.com', name: 'Up Grade', role: 'member' }));
    expect(await store.members.listManual()).toHaveLength(1);

    const response = await peopleHandler(call({ email: 'up@example.com', role: 'manager' }, 'PATCH'));
    expect(response.status).toBe(200);

    // One address cannot be both: sign-in resolves staff first, so a
    // membership left behind here would never be reached again.
    expect(await store.members.listManual()).toHaveLength(0);
    expect((await list()).get('up@example.com').role).toBe('manager');
  });

  it('moves somebody from staff back to member, and they read as a member', async () => {
    await peopleHandler(call({ action: 'add', email: 'down@example.com', name: 'Down Grade', role: 'door' }));
    await peopleHandler(call({ email: 'down@example.com', role: 'member' }, 'PATCH'));

    const person = (await list()).get('down@example.com');
    expect(person.role).toBe('member');
    expect(person.active).toBe(true);

    // The staff row is kept but switched off, so an audit trail naming them
    // still resolves to a person. getStaffByEmail only sees active rows, by
    // design, so look through the full list.
    const row = (await store.auth.listStaff()).find((s) => s.email === 'down@example.com');
    expect(row?.active).toBe(false);
  });

  it('keeps the password across a role change', async () => {
    const added = await (await peopleHandler(call({ action: 'add', email: 'keep@example.com', name: 'Keep Er', role: 'member' }))).json();
    await peopleHandler(call({ email: 'keep@example.com', role: 'manager' }, 'PATCH'));
    expect((await loginHandler(login('keep@example.com', added.password))).status).toBe(200);
  });

  it('refuses an unknown role', async () => {
    await peopleHandler(call({ action: 'add', email: 'x@example.com', name: 'Ex', role: 'member' }));
    expect((await peopleHandler(call({ email: 'x@example.com', role: 'owner' }, 'PATCH'))).status).toBe(400);
  });
});

describe('lockout guards', () => {
  it('refuses to let an admin take their own admin off', async () => {
    const response = await peopleHandler(call({ email: ADMIN.email, role: 'member' }, 'PATCH'));
    expect(response.status).toBe(400);
    expect((await store.auth.getStaffByEmail(ADMIN.email))?.role).toBe('admin');
  });

  it('refuses to demote the last admin', async () => {
    await peopleHandler(call({ action: 'add', email: 'other@example.com', name: 'Oth Er', role: 'admin' }));
    const other = `${STAFF_COOKIE}=${issueStaffSession({ ...ADMIN, staffId: 's3', email: 'other@example.com' })}`;

    // Two admins: demoting one is fine.
    expect((await peopleHandler(call({ email: ADMIN.email, role: 'member' }, 'PATCH', other))).status).toBe(200);
    // One left, and it is the caller's own, so both guards now apply.
    expect((await peopleHandler(call({ email: 'other@example.com', role: 'member' }, 'PATCH', other))).status).toBe(400);
  });

  it('refuses to suspend or remove your own sign-in', async () => {
    await store.credentials.setPassword({ email: ADMIN.email, passwordHash: await hashPassword('admin-password-x'), mustChange: false });
    expect((await peopleHandler(call({ email: ADMIN.email, signIn: false }, 'PATCH'))).status).toBe(400);
    expect((await peopleHandler(call({ email: ADMIN.email }, 'DELETE'))).status).toBe(400);
    expect((await store.credentials.get(ADMIN.email))?.active).toBe(true);
  });
});

describe('sign-in', () => {
  it('suspends and restores', async () => {
    const added = await (await peopleHandler(call({ action: 'add', email: 'sus@example.com', name: 'Sus Pect', role: 'member' }))).json();

    await peopleHandler(call({ email: 'sus@example.com', signIn: false }, 'PATCH'));
    expect((await loginHandler(login('sus@example.com', added.password))).status).toBe(401);

    await peopleHandler(call({ email: 'sus@example.com', signIn: true }, 'PATCH'));
    expect((await loginHandler(login('sus@example.com', added.password))).status).toBe(200);
  });

  it('issues a new password, once, and the old one stops working', async () => {
    const first = await (await peopleHandler(call({ action: 'add', email: 'reset@example.com', name: 'Re Set', role: 'member' }))).json();
    const second = await (await peopleHandler(call({ action: 'reset', email: 'reset@example.com' }))).json();

    expect(second.password).toBeTruthy();
    expect(second.password).not.toBe(first.password);
    expect((await loginHandler(login('reset@example.com', first.password))).status).toBe(401);
    expect((await loginHandler(login('reset@example.com', second.password))).status).toBe(200);

    // And it is not retrievable afterwards, from anywhere.
    const body = await (await peopleHandler(get())).json();
    expect(JSON.stringify(body)).not.toContain(second.password);
  });

  it('refuses to issue a password to somebody who is not on the list', async () => {
    // Sign-in refuses identically for every reason by design, which makes an
    // admin screen that stays quiet about a typo a trap: it would issue a
    // perfectly valid password for nobody.
    expect((await peopleHandler(call({ action: 'reset', email: 'typo@example.com' }))).status).toBe(404);
  });

  it('removing somebody takes the sign-in with it', async () => {
    const added = await (await peopleHandler(call({ action: 'add', email: 'gone@example.com', name: 'Al Gone', role: 'member' }))).json();
    expect((await peopleHandler(call({ email: 'gone@example.com' }, 'DELETE'))).status).toBe(200);

    expect(await store.credentials.get('gone@example.com')).toBeNull();
    expect((await loginHandler(login('gone@example.com', added.password))).status).toBe(401);
  });
});

describe('bootstrap admin from the environment', () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env.ADMIN_BOOTSTRAP_EMAIL = saved.ADMIN_BOOTSTRAP_EMAIL;
    process.env.ADMIN_BOOTSTRAP_PASSWORD = saved.ADMIN_BOOTSTRAP_PASSWORD;
    delete process.env.ADMIN_BOOTSTRAP_EMAIL;
    delete process.env.ADMIN_BOOTSTRAP_PASSWORD;
  });

  it('creates the named admin on its first sign-in, and requires a change', async () => {
    process.env.ADMIN_BOOTSTRAP_EMAIL = 'boot@alchemysaunas.com.au';
    process.env.ADMIN_BOOTSTRAP_PASSWORD = 'a-long-bootstrap-password';

    const response = await loginHandler(login('boot@alchemysaunas.com.au', 'a-long-bootstrap-password'));
    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body.role).toBe('admin');
    // A standing password, not a one-time way in: this account exists so
    // somebody can sign in with a known password without a round trip.
    expect(body.mustChangePassword).toBe(false);
  });

  it('takes over a credential already sitting on the address', async () => {
    // The state a database with history is in, and the one that made the
    // create-once version a permanent no-op: a row already there, from a
    // password issued earlier or a half-finished attempt.
    await store.credentials.setPassword({
      email: 'boot@alchemysaunas.com.au',
      passwordHash: await hashPassword('some-other-password'),
      mustChange: true,
    });

    process.env.ADMIN_BOOTSTRAP_EMAIL = 'boot@alchemysaunas.com.au';
    process.env.ADMIN_BOOTSTRAP_PASSWORD = 'a-long-bootstrap-password';

    expect((await loginHandler(login('boot@alchemysaunas.com.au', 'a-long-bootstrap-password'))).status).toBe(200);
    expect((await loginHandler(login('boot@alchemysaunas.com.au', 'some-other-password'))).status).toBe(401);
  });

  it('reinstates the staff row, so a correct password is not refused behind it', async () => {
    // A password that verifies against an address with no active staff row
    // falls through to the membership lookup and is refused anyway: the same
    // failure wearing a different hat.
    process.env.ADMIN_BOOTSTRAP_EMAIL = 'boot@alchemysaunas.com.au';
    process.env.ADMIN_BOOTSTRAP_PASSWORD = 'a-long-bootstrap-password';
    await loginHandler(login('boot@alchemysaunas.com.au', 'a-long-bootstrap-password'));

    const row = (await store.auth.listStaff()).find((s) => s.email === 'boot@alchemysaunas.com.au');
    await store.auth.setStaffActive(row!.staffId, false);

    expect((await loginHandler(login('boot@alchemysaunas.com.au', 'a-long-bootstrap-password'))).status).toBe(200);
  });

  it('stops mattering entirely once the password variable is removed', async () => {
    process.env.ADMIN_BOOTSTRAP_EMAIL = 'boot@alchemysaunas.com.au';
    process.env.ADMIN_BOOTSTRAP_PASSWORD = 'a-long-bootstrap-password';
    await loginHandler(login('boot@alchemysaunas.com.au', 'a-long-bootstrap-password'));

    // Unset it, then choose your own: nothing puts the old one back.
    delete process.env.ADMIN_BOOTSTRAP_PASSWORD;
    await store.credentials.setPassword({
      email: 'boot@alchemysaunas.com.au',
      passwordHash: await hashPassword('their-own-password'),
      mustChange: false,
    });

    expect((await loginHandler(login('boot@alchemysaunas.com.au', 'their-own-password'))).status).toBe(200);
    expect((await loginHandler(login('boot@alchemysaunas.com.au', 'a-long-bootstrap-password'))).status).toBe(401);
  });

  it('does nothing for any other address, and nothing when unset', async () => {
    process.env.ADMIN_BOOTSTRAP_EMAIL = 'boot@alchemysaunas.com.au';
    process.env.ADMIN_BOOTSTRAP_PASSWORD = 'a-long-bootstrap-password';
    expect((await loginHandler(login('someone@example.com', 'a-long-bootstrap-password'))).status).toBe(401);
    expect(await store.auth.getStaffByEmail('someone@example.com')).toBeNull();

    delete process.env.ADMIN_BOOTSTRAP_EMAIL;
    delete process.env.ADMIN_BOOTSTRAP_PASSWORD;
    expect((await loginHandler(login('boot@alchemysaunas.com.au', 'a-long-bootstrap-password'))).status).toBe(401);
  });
});
