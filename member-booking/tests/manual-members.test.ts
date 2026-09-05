import { beforeEach, describe, expect, it } from 'vitest';
import { overrideContext } from '../src/domain/context.ts';
import { createMemoryStore, type MemoryStore } from '../src/store/memory.ts';
import { createMockHapana } from '../src/adapters/hapana/mock.ts';
import { createUnavailableMembership } from '../src/adapters/hapana/adapter.ts';
import { verifyMemberByEmail, verifyMemberById } from '../src/domain/membership.ts';
import { issueStaffSession } from '../src/lib/auth.ts';
import { STAFF_COOKIE } from '../src/lib/http.ts';
import { ACTIVE_MEMBER, PAUSED_MEMBER, VENUE_ID } from './helpers.ts';

import membersHandler from '../netlify/functions/admin-members.ts';
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
  return new Request(`${BASE}/api/admin/members`, {
    method,
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify(body),
  });
}

function get(cookie = adminCookie()): Request {
  return new Request(`${BASE}/api/admin/members`, { headers: { cookie } });
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
    const body = await (await membersHandler(call({ email: 'New@Example.com', firstName: 'Nia', lastName: 'New' }))).json();

    expect(body.member.email).toBe('new@example.com');
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
    expect((await membersHandler(get(door))).status).toBe(403);
    expect((await membersHandler(new Request(`${BASE}/api/admin/members`))).status).toBe(401);
  });

  it('refuses an address that is already a staff account', async () => {
    const response = await membersHandler(call({ email: ADMIN.email }));
    expect(response.status).toBe(400);
    // Sign-in resolves staff first, so such a membership would never be reached.
    expect((await response.json()).message).toContain('staff account');
  });

  it('updates in place rather than creating a second membership', async () => {
    await membersHandler(call({ email: 'dup@example.com', firstName: 'One' }));
    await membersHandler(call({ email: 'dup@example.com', firstName: 'Two' }));
    expect(await store.members.listManual()).toHaveLength(1);
  });

  it('does not reissue a password to somebody who already has one', async () => {
    const first = await (await membersHandler(call({ email: 'dup@example.com' }))).json();
    const second = await (await membersHandler(call({ email: 'dup@example.com' }))).json();
    expect(first.password).toBeTruthy();
    // Silently replacing a password the member is already using would lock them out.
    expect(second.password).toBeNull();
  });

  it('shows on the list whether each member can actually sign in', async () => {
    await store.members.upsertManual({ email: 'nopass@example.com', firstName: null, lastName: null, status: 'active', homeVenueId: VENUE_ID });
    await membersHandler(call({ email: 'haspass@example.com' }));

    const body = await (await membersHandler(get())).json();
    const byEmail = new Map(body.members.map((m: any) => [m.email, m]));
    expect((byEmail.get('nopass@example.com') as any).canSignIn).toBe(false);
    expect((byEmail.get('haspass@example.com') as any).canSignIn).toBe(true);
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
    const created = await (await membersHandler(call({ email: 'temp@example.com' }))).json();
    const memberId = `manual:temp@example.com`;
    const membership = createUnavailableMembership('no key');

    await membersHandler(call({ memberId, status: 'paused' }, 'PATCH'));
    expect(await verifyMemberByEmail({ store, membership, config: localConfig }, 'temp@example.com')).toBeNull();

    await membersHandler(call({ memberId, status: 'active' }, 'PATCH'));
    expect(await verifyMemberByEmail({ store, membership, config: localConfig }, 'temp@example.com')).not.toBeNull();

    await membersHandler(call({ memberId }, 'DELETE'));
    expect(await verifyMemberByEmail({ store, membership, config: localConfig }, 'temp@example.com')).toBeNull();

    // The password is deliberately left alone: removing the membership is what
    // stops them booking, and deleting the credential too would be a second
    // destructive act the admin did not ask for.
    expect(await store.credentials.get('temp@example.com')).not.toBeNull();
    expect(created.password).toBeTruthy();
  });

  it('a sync never clobbers or deletes a manual entry', async () => {
    await store.members.upsertManual({ email: 'manual@example.com', firstName: 'Mo', lastName: null, status: 'active', homeVenueId: VENUE_ID });

    await store.members.upsertMany([
      { memberId: ACTIVE_MEMBER.memberId, email: ACTIVE_MEMBER.email, firstName: 'Ada', lastName: 'Active', status: 'active', homeVenueId: VENUE_ID, syncedAt: new Date().toISOString(), source: 'hapana' },
    ]);

    const manual = await store.members.listManual();
    expect(manual).toHaveLength(1);
    expect(manual[0]!.email).toBe('manual@example.com');
  });

  it('removeManual refuses to touch a synced record', async () => {
    await store.members.upsertMany([
      { memberId: 'hapana-1', email: 'synced@example.com', firstName: null, lastName: null, status: 'active', homeVenueId: VENUE_ID, syncedAt: new Date().toISOString(), source: 'hapana' },
    ]);
    expect(await store.members.removeManual('hapana-1')).toBe(false);
    expect(await store.members.get('hapana-1')).not.toBeNull();

    // And the endpoint refuses it too, rather than relying on the store alone.
    expect((await membersHandler(call({ memberId: 'hapana-1' }, 'DELETE'))).status).toBe(404);
  });
});
