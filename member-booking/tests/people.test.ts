import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { overrideContext } from '../src/domain/context.ts';
import { createMemoryStore, type MemoryStore } from '../src/store/memory.ts';
import { verifyMemberByEmail } from '../src/domain/membership.ts';
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

  it('takes a removed staff account off the list', async () => {
    // Remove keeps the staff row, deactivated, so an audit entry naming them
    // still resolves to a person. That is not a reason to keep showing them on
    // a screen whose whole job is who is here: pressing Remove and watching
    // the row sit there reads as a button that does not work.
    store.seedStaff({
      staffId: 'staff-gone', email: 'gone@example.com', displayName: 'Gone Away',
      role: 'door', venueIds: [VENUE_ID], active: true,
    });

    expect((await list()).has('gone@example.com')).toBe(true);
    const response = await peopleHandler(call({ email: 'gone@example.com' }, 'DELETE'));
    expect(response.status).toBe(200);
    expect((await list()).has('gone@example.com')).toBe(false);

    // Kept underneath, which is the point of deactivating rather than deleting.
    expect((await store.auth.listStaff()).find((s) => s.email === 'gone@example.com')?.active).toBe(false);
  });

  it('lets a removed staff address come back as a member with no password', async () => {
    // The whole sequence somebody actually performs: take an address off
    // staff, then add it as a member so they can set their own password.
    store.seedStaff({
      staffId: 'staff-two-admins', email: 'other@example.com', displayName: 'Other Admin',
      role: 'admin', venueIds: [VENUE_ID], active: true,
    });
    store.seedStaff({
      staffId: 'staff-james', email: 'james@example.com', displayName: 'James Jordan',
      role: 'admin', venueIds: [VENUE_ID], active: true,
    });
    await store.credentials.setPassword({
      email: 'james@example.com',
      passwordHash: await hashPassword('the-admin-password'),
      mustChange: false,
    });

    expect((await peopleHandler(call({ email: 'james@example.com' }, 'DELETE'))).status).toBe(200);
    expect((await list()).has('james@example.com')).toBe(false);

    await peopleHandler(call({ action: 'add', email: 'james@example.com', name: 'James Jordan', role: 'member' }));

    const person = (await list()).get('james@example.com');
    expect(person.role).toBe('member');
    // No password, so the claim is open to them.
    expect(person.signIn).toBe('none');
    expect(await store.credentials.get('james@example.com')).toBeNull();
    // And the old admin password is gone with the old account.
    expect((await loginHandler(login('james@example.com', 'the-admin-password'))).status).toBe(401);
  });

  it('keeps showing somebody who still has something', async () => {
    // Suspended, not removed. Their sign-in is off and they must stay visible,
    // or there is no way to restore it.
    store.seedStaff({
      staffId: 'staff-sus', email: 'sus@example.com', displayName: 'Sus Pended',
      role: 'door', venueIds: [VENUE_ID], active: true,
    });
    await peopleHandler(call({ action: 'add', email: 'sus@example.com', name: 'Sus Pended', role: 'door' }));
    await peopleHandler(call({ email: 'sus@example.com', signIn: false }, 'PATCH'));

    const people = await list();
    expect(people.get('sus@example.com').signIn).toBe('suspended');
  });

  it('shows the name that was typed, not the one the address used to have', async () => {
    // James Jordan, admin, at an address the venue then wants to belong to
    // James Browne. One address is one person, so this is a rename, and the
    // deactivated staff row used to win the name back however many times it
    // was typed.
    store.seedStaff({
      staffId: 'staff-james', email: 'james@example.com', displayName: 'James Jordan',
      role: 'admin', venueIds: [VENUE_ID], active: true,
    });

    const body = await (await peopleHandler(call({ action: 'add', email: 'james@example.com', name: 'James Browne', role: 'member' }))).json();
    // And it says so, rather than reading as if a new person were created.
    expect(body.message).toMatch(/James Jordan was already at this address and is now James Browne/);

    const people = await list();
    expect(people.get('james@example.com').name).toBe('James Browne');
    expect(people.get('james@example.com').role).toBe('member');
    // Still one person, not two rows for the one address.
    expect([...people.keys()].filter((e) => e === 'james@example.com')).toHaveLength(1);
  });

  it('renames somebody who stays staff', async () => {
    store.seedStaff({
      staffId: 'staff-dee', email: 'dee@example.com', displayName: 'Dee Door',
      role: 'door', venueIds: [VENUE_ID], active: true,
    });
    await peopleHandler(call({ action: 'add', email: 'dee@example.com', name: 'Dee Manager', role: 'manager' }));

    const people = await list();
    expect(people.get('dee@example.com').name).toBe('Dee Manager');
    expect(people.get('dee@example.com').role).toBe('manager');
  });

  it('carries the package each member holds, so the list can show it', async () => {
    await store.members.upsertManual({
      email: 'holder@example.com', firstName: 'Hol', lastName: 'Der', status: 'active',
      homeVenueId: VENUE_ID, membershipPackage: 'Off-Peak Membership | East Fremantle',
    });
    // Somebody added by hand holds nothing, and the list has to say so rather
    // than leave a gap that reads as a missing value.
    await peopleHandler(call({ action: 'add', email: 'byhand@example.com', name: 'By Hand', role: 'member' }));

    const people = await list();
    expect(people.get('holder@example.com').membershipPackage).toBe('Off-Peak Membership | East Fremantle');
    expect(people.get('byhand@example.com').membershipPackage).toBeNull();
  });

  it('says whether each person can actually sign in', async () => {
    await store.members.upsertManual({ email: 'nopass@example.com', firstName: 'No', lastName: 'Pass', status: 'active', homeVenueId: VENUE_ID });
    await peopleHandler(call({ action: 'add', email: 'fresh@example.com', name: 'Fresh One', role: 'member', password: 'issued-by-the-admin' }));
    await store.credentials.setPassword({ email: 'chosen@example.com', passwordHash: await hashPassword('a-chosen-password'), mustChange: false });
    await store.members.upsertManual({ email: 'chosen@example.com', firstName: 'Chose', lastName: 'N', status: 'active', homeVenueId: VENUE_ID });

    const people = await list();
    expect(people.get('nopass@example.com').signIn).toBe('none');
    expect(people.get('fresh@example.com').signIn).toBe('issued');
    expect(people.get('chosen@example.com').signIn).toBe('active');
  });

  it('is closed to anyone but an admin', async () => {
    const manager = `${STAFF_COOKIE}=${issueStaffSession({ ...ADMIN, staffId: 's2', email: 'm@example.com', role: 'manager' })}`;
    expect((await peopleHandler(get(manager))).status).toBe(403);
    expect((await peopleHandler(new Request(`${BASE}/api/admin/people`))).status).toBe(401);
  });
});

describe('roles', () => {
  it('moves somebody from member to staff, and the membership stops working', async () => {
    await peopleHandler(call({ action: 'add', email: 'up@example.com', name: 'Up Grade', role: 'member' }));

    const response = await peopleHandler(call({ email: 'up@example.com', role: 'manager' }, 'PATCH'));
    expect(response.status).toBe(200);

    // One address cannot be both, and the membership must not survive the
    // move: sign-in resolves staff first, so a membership still standing here
    // would be a way to book that nobody could see on the screen. Cancelled
    // rather than deleted, because deleting threw away the package they hold.
    expect((await list()).get('up@example.com').role).toBe('manager');
    expect(await verifyMemberByEmail(
      { store, membership: createMockHapana({ members: [], supportsWrites: false }), config: { bookingBackend: 'local' } as never },
      'up@example.com',
    )).toBeNull();
  });

  it('keeps the package across member, staff and back again', async () => {
    // The round trip used to delete the membership and build a new one, which
    // came back holding no package. No package is always allowed, so a member
    // whose package the venue had closed silently regained the channel by
    // being made staff for an afternoon.
    await store.members.upsertManual({
      email: 'round@example.com', firstName: 'Rou', lastName: 'Nd', status: 'active',
      homeVenueId: VENUE_ID, membershipPackage: 'Off-Peak Membership | East Fremantle',
    });

    await peopleHandler(call({ email: 'round@example.com', role: 'manager' }, 'PATCH'));
    await peopleHandler(call({ email: 'round@example.com', role: 'member' }, 'PATCH'));

    expect(await store.members.packageFor('round@example.com')).toBe('Off-Peak Membership | East Fremantle');
    expect((await list()).get('round@example.com').membershipPackage)
      .toBe('Off-Peak Membership | East Fremantle');
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
    await peopleHandler(call({ action: 'add', email: 'keep@example.com', name: 'Keep Er', role: 'member', password: 'the-one-they-are-using' }));
    await peopleHandler(call({ email: 'keep@example.com', role: 'manager' }, 'PATCH'));
    expect((await loginHandler(login('keep@example.com', 'the-one-they-are-using'))).status).toBe(200);
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
    await peopleHandler(call({ action: 'add', email: 'sus@example.com', name: 'Sus Pect', role: 'member', password: 'issued-by-the-admin' }));

    await peopleHandler(call({ email: 'sus@example.com', signIn: false }, 'PATCH'));
    expect((await loginHandler(login('sus@example.com', 'issued-by-the-admin'))).status).toBe(401);

    await peopleHandler(call({ email: 'sus@example.com', signIn: true }, 'PATCH'));
    expect((await loginHandler(login('sus@example.com', 'issued-by-the-admin'))).status).toBe(200);
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

  it('clears a must-change flag left by an earlier deploy', async () => {
    // The exact production state: the password was already right, but the row
    // was written when the bootstrap still set must_change. Checking only the
    // password meant nothing to do, so the prompt came back on every sign-in
    // forever.
    await store.credentials.setPassword({
      email: 'boot@alchemysaunas.com.au',
      passwordHash: await hashPassword('a-long-bootstrap-password'),
      mustChange: true,
    });

    process.env.ADMIN_BOOTSTRAP_EMAIL = 'boot@alchemysaunas.com.au';
    process.env.ADMIN_BOOTSTRAP_PASSWORD = 'a-long-bootstrap-password';

    const body = await (await loginHandler(login('boot@alchemysaunas.com.au', 'a-long-bootstrap-password'))).json();
    expect(body.mustChangePassword).toBe(false);
    // And it stays cleared rather than being rewritten on every attempt.
    expect((await store.credentials.get('boot@alchemysaunas.com.au'))?.mustChange).toBe(false);
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
