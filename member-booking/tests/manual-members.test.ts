import { beforeEach, describe, expect, it } from 'vitest';
import { overrideContext } from '../src/domain/context.ts';
import { createMemoryStore, type MemoryStore } from '../src/store/memory.ts';
import { createMockHapana } from '../src/adapters/hapana/mock.ts';
import { createUnavailableMembership } from '../src/adapters/hapana/adapter.ts';
import { verifyMemberByEmail, verifyMemberById } from '../src/domain/membership.ts';
import { issueStaffSession } from '../src/lib/auth.ts';
import { STAFF_COOKIE } from '../src/lib/http.ts';
import { ACTIVE_MEMBER, PAUSED_MEMBER, VENUE_ID } from './helpers.ts';

import peopleHandler from '../netlify/functions/admin-people.ts';
import loginHandler from '../netlify/functions/auth-login.ts';

/**
 * Members the venue holds itself.
 *
 * The point of these is that the channel can open before Hapana is connected,
 * and keep working when Hapana is wrong or unreachable. The risk is that they
 * quietly become a way around membership verification, so most of what is
 * pinned here is the boundary: Hapana still wins where Hapana has an answer,
 * only an admin can create one, and removing one removes access.
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

function adminCookie() {
  return `${STAFF_COOKIE}=${issueStaffSession(ADMIN)}`;
}

const localConfig = { bookingBackend: 'local' } as never;

beforeEach(() => {
  store = createMemoryStore();
  store.seedStaff({ ...ADMIN });
  overrideContext(store, createMockHapana({ members: [ACTIVE_MEMBER, PAUSED_MEMBER], supportsWrites: false }));
});

describe('adding a member by hand', () => {
  it('creates the membership and a password together', async () => {
    const body = await (await peopleHandler(call({ action: 'add', email: 'New@Example.com', name: 'Nia New', role: 'member' }))).json();

    expect(body.email).toBe('new@example.com');
    expect(body.password).toHaveLength(20);
    expect((await store.credentials.get('new@example.com'))?.mustChange).toBe(true);

    // Both halves, or the member cannot actually do anything.
    const login = await loginHandler(new Request(`${BASE}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'new@example.com', password: body.password }),
    }));
    expect(login.status).toBe(200);
    expect((await login.json()).kind).toBe('member');
  });

  it('is closed to anyone but an admin', async () => {
    const door = `${STAFF_COOKIE}=${issueStaffSession({ ...ADMIN, role: 'door' })}`;
    expect((await peopleHandler(get(door))).status).toBe(403);
    expect((await peopleHandler(new Request(`${BASE}/api/admin/people`))).status).toBe(401);
  });

  it('updates in place rather than creating a second membership', async () => {
    await peopleHandler(call({ action: 'add', email: 'dup@example.com', name: 'One', role: 'member' }));
    await peopleHandler(call({ action: 'add', email: 'dup@example.com', name: 'Two', role: 'member' }));
    expect(await store.members.listManual()).toHaveLength(1);
  });

  it('does not reissue a password to somebody who already has one', async () => {
    const first = await (await peopleHandler(call({ action: 'add', email: 'dup@example.com', name: 'One', role: 'member' }))).json();
    const second = await (await peopleHandler(call({ action: 'add', email: 'dup@example.com', name: 'One', role: 'member' }))).json();
    expect(first.password).toBeTruthy();
    // Silently replacing a password the member is already using would lock them out.
    expect(second.password).toBeNull();
    expect((await loginHandler(new Request(`${BASE}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'dup@example.com', password: first.password }),
    }))).status).toBe(200);
  });

  it('shows on the list whether each person can actually sign in', async () => {
    await store.members.upsertManual({ email: 'nopass@example.com', firstName: null, lastName: null, status: 'active', homeVenueId: VENUE_ID });
    await peopleHandler(call({ action: 'add', email: 'haspass@example.com', name: 'Has Pass', role: 'member' }));

    const body = await (await peopleHandler(get())).json();
    const byEmail = new Map(body.people.map((p: any) => [p.email, p]));
    expect((byEmail.get('nopass@example.com') as any).signIn).toBe('none');
    expect((byEmail.get('haspass@example.com') as any).signIn).toBe('issued');
  });
});

describe('where a manual member sits against Hapana', () => {
  it('is used for an address Hapana does not know', async () => {
    await store.members.upsertManual({ email: 'manual@example.com', firstName: 'Mo', lastName: 'Manual', status: 'active', homeVenueId: VENUE_ID });

    const verified = await verifyMemberByEmail(
      { store, membership: createMockHapana({ members: [ACTIVE_MEMBER], supportsWrites: false }), config: localConfig },
      'manual@example.com',
    );
    expect(verified?.name).toBe('Mo Manual');
    expect(verified?.staleSince).toBeNull();
  });

  /**
   * The boundary that matters. Hapana remains the authority wherever it has an
   * answer: a manual entry cannot promote somebody Hapana says is paused.
   */
  it('cannot override Hapana on somebody Hapana knows about', async () => {
    await store.members.upsertManual({
      email: PAUSED_MEMBER.email,
      firstName: 'Sneaky',
      lastName: 'Override',
      status: 'active',
      homeVenueId: VENUE_ID,
    });

    const verified = await verifyMemberByEmail(
      { store, membership: createMockHapana({ members: [ACTIVE_MEMBER, PAUSED_MEMBER], supportsWrites: false }), config: localConfig },
      PAUSED_MEMBER.email,
    );
    expect(verified).toBeNull();
  });

  it('still works when Hapana cannot be reached at all', async () => {
    await store.members.upsertManual({ email: 'manual@example.com', firstName: 'Mo', lastName: null, status: 'active', homeVenueId: VENUE_ID });

    const verified = await verifyMemberByEmail(
      { store, membership: createUnavailableMembership('no key'), config: localConfig },
      'manual@example.com',
    );
    expect(verified).not.toBeNull();
    // Not stale: somebody typed it, and no sync will ever refresh it, so a
    // staleness warning on the door list would be misleading.
    expect(verified?.staleSince).toBeNull();
  });

  it('resolves by id without asking Hapana about an id it cannot have', async () => {
    const member = await store.members.upsertManual({ email: 'manual@example.com', firstName: 'Mo', lastName: null, status: 'active', homeVenueId: VENUE_ID });

    const verified = await verifyMemberById(
      { store, membership: createUnavailableMembership('no key'), config: localConfig },
      member.memberId,
    );
    expect(verified?.memberId).toBe(member.memberId);
  });

  it('stops working the moment it is paused or removed', async () => {
    const email = 'temp@example.com';
    const created = await (await peopleHandler(call({ action: 'add', email, name: 'Temp One', role: 'member' }))).json();
    const membership = createUnavailableMembership('no key');

    await peopleHandler(call({ email, status: 'paused' }, 'PATCH'));
    expect(await verifyMemberByEmail({ store, membership, config: localConfig }, email)).toBeNull();

    await peopleHandler(call({ email, status: 'active' }, 'PATCH'));
    expect(await verifyMemberByEmail({ store, membership, config: localConfig }, email)).not.toBeNull();

    await peopleHandler(call({ email }, 'DELETE'));
    expect(await verifyMemberByEmail({ store, membership, config: localConfig }, email)).toBeNull();

    // The sign-in goes with them. The old screens removed a membership and
    // left the password standing, which read as "removed" and was not.
    expect(await store.credentials.get(email)).toBeNull();
    expect(created.password).toBeTruthy();
  });

  it('a sync never clobbers or deletes a manual entry', async () => {
    await store.members.upsertManual({ email: 'manual@example.com', firstName: 'Mo', lastName: null, status: 'active', homeVenueId: VENUE_ID });

    await store.members.upsertMany([
      { memberId: ACTIVE_MEMBER.memberId, email: ACTIVE_MEMBER.email, firstName: 'Ada', lastName: 'Active', status: 'active', homeVenueId: VENUE_ID, syncedAt: new Date().toISOString(), membershipPackage: null, source: 'hapana' },
    ]);

    const manual = await store.members.listManual();
    expect(manual).toHaveLength(1);
    expect(manual[0]!.email).toBe('manual@example.com');
  });

  it('removeManual refuses to touch a synced record', async () => {
    await store.members.upsertMany([
      { memberId: 'hapana-1', email: 'synced@example.com', firstName: null, lastName: null, status: 'active', homeVenueId: VENUE_ID, syncedAt: new Date().toISOString(), membershipPackage: null, source: 'hapana' },
    ]);
    expect(await store.members.removeManual('hapana-1')).toBe(false);
    expect(await store.members.get('hapana-1')).not.toBeNull();

    // And the endpoint refuses it too: a Hapana member is not on this list at
    // all, so there is nothing here to remove.
    expect((await peopleHandler(call({ email: 'synced@example.com' }, 'DELETE'))).status).toBe(404);
  });
});
