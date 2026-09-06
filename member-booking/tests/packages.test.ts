import { beforeEach, describe, expect, it } from 'vitest';
import { overrideContext } from '../src/domain/context.ts';
import { packageAllows, verifyMemberByEmail } from '../src/domain/membership.ts';
import { createMemoryStore, type MemoryStore } from '../src/store/memory.ts';
import { createMockHapana } from '../src/adapters/hapana/mock.ts';
import { issueStaffSession } from '../src/lib/auth.ts';
import { STAFF_COOKIE } from '../src/lib/http.ts';
import { CONFIG_DEFAULTS } from '../src/lib/config.ts';
import { makeHarness, VENUE_ID } from './helpers.ts';

import configHandler from '../netlify/functions/admin-config.ts';

/**
 * Membership packages, and which of them reach this channel.
 *
 * Alchemy sells ten packages at East Fremantle and not all of them include the
 * member channel. Status is Hapana's answer to whether somebody is paying;
 * this is the venue's answer to whether this benefit is part of what they pay
 * for, and it decides who can book, so the direction it fails in matters more
 * than the feature does.
 *
 * It lives in Settings, with the rest of the rules about the channel. The
 * import is deliberately not involved: everybody in an export is imported
 * whatever they hold, and this decides which of those packages can book.
 */

const BASE = 'http://localhost:8888';

const ADMIN = {
  staffId: 'staff-admin',
  email: 'admin@example.com',
  displayName: 'Ada Admin',
  role: 'admin' as const,
  venueIds: [VENUE_ID],
  active: true,
};

const cookie = () => `${STAFF_COOKIE}=${issueStaffSession(ADMIN)}`;

function patch(body: unknown): Request {
  return new Request(`${BASE}/api/admin/config`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', cookie: cookie() },
    body: JSON.stringify(body),
  });
}

async function view() {
  return (await (await configHandler(new Request(`${BASE}/api/admin/config`, { headers: { cookie: cookie() } }))).json());
}

let store: MemoryStore;

async function seedPackages() {
  await store.members.upsertManual({
    email: 'plat@example.com', firstName: 'Pat', lastName: 'Platinum',
    status: 'active', homeVenueId: VENUE_ID, membershipPackage: 'Platinum Membership | East Fremantle',
  });
  await store.members.upsertManual({
    email: 'off@example.com', firstName: 'Ollie', lastName: 'Offpeak',
    status: 'active', homeVenueId: VENUE_ID, membershipPackage: 'Off-Peak Membership | East Fremantle',
  });
  await store.members.upsertManual({
    email: 'plat2@example.com', firstName: 'Pia', lastName: 'Platinum',
    status: 'active', homeVenueId: VENUE_ID, membershipPackage: 'Platinum Membership | East Fremantle',
  });
}

beforeEach(async () => {
  store = createMemoryStore();
  store.seedStaff({ ...ADMIN });
  overrideContext(store, createMockHapana({ members: [], supportsWrites: false }));
  await seedPackages();
});

describe('the rule itself', () => {
  const allowed = (access: Record<string, boolean>, pkg: string | null) => packageAllows(access, pkg);

  it('lets everybody through until the venue has ruled on anything', () => {
    // The state every deployment is in before somebody opens the screen, so it
    // has to mean "no change", not "nobody can book".
    expect(allowed({}, 'Platinum Membership | East Fremantle')).toBe(true);
    expect(allowed({}, null)).toBe(true);
  });

  it('closes a package that has been switched off', () => {
    expect(allowed({ Platinum: false, Gold: true }, 'Platinum')).toBe(false);
  });

  it('closes a package nobody has ruled on, once ruling has started', () => {
    // The safe direction. A package that appears after the rules were set is
    // one nobody has decided about, and admitting it is an unauthorised entry
    // while turning it away is a support call.
    expect(allowed({ Gold: true }, 'A New Package')).toBe(false);
  });

  it('never turns away somebody with no package at all', () => {
    // Added by hand on the People screen, or cached before packages were read.
    // A decision about packages should not quietly revoke them.
    expect(allowed({ Gold: true }, null)).toBe(true);
  });
});

describe('who can book', () => {
  it('refuses a member whose package was switched off', async () => {
    const harness = makeHarness({
      config: { packageAccess: { 'Platinum Membership | East Fremantle': false, 'Off-Peak Membership | East Fremantle': true } },
    });
    await harness.store.members.upsertManual({
      email: 'plat@example.com', firstName: 'Pat', lastName: 'Platinum',
      status: 'active', homeVenueId: VENUE_ID, membershipPackage: 'Platinum Membership | East Fremantle',
    });

    expect(await verifyMemberByEmail(harness.context, 'plat@example.com')).toBeNull();
  });

  it('admits a member whose package is open', async () => {
    const harness = makeHarness({
      config: { packageAccess: { 'Off-Peak Membership | East Fremantle': true } },
    });
    await harness.store.members.upsertManual({
      email: 'off@example.com', firstName: 'Ollie', lastName: 'Offpeak',
      status: 'active', homeVenueId: VENUE_ID, membershipPackage: 'Off-Peak Membership | East Fremantle',
    });

    expect((await verifyMemberByEmail(harness.context, 'off@example.com'))?.email).toBe('off@example.com');
  });

  it('leaves everybody bookable while no package has been ruled on', async () => {
    const harness = makeHarness({ config: { packageAccess: {} } });
    await harness.store.members.upsertManual({
      email: 'plat@example.com', firstName: 'Pat', lastName: 'Platinum',
      status: 'active', homeVenueId: VENUE_ID, membershipPackage: 'Platinum Membership | East Fremantle',
    });

    expect((await verifyMemberByEmail(harness.context, 'plat@example.com'))?.email).toBe('plat@example.com');
  });
});

describe('the Settings screen', () => {
  it('lists every package with how many people hold it', async () => {
    const body = await view();
    expect(body.packagesRuled).toBe(false);
    expect(body.packages).toEqual([
      { name: 'Platinum Membership | East Fremantle', members: 2, allowed: true, unruled: false },
      { name: 'Off-Peak Membership | East Fremantle', members: 1, allowed: true, unruled: false },
    ]);
  });

  it('writes down every package on screen when the first switch is thrown', async () => {
    // Otherwise one toggle silently locks out every other package listed,
    // which is not what pressing a single switch should mean.
    await configHandler(patch({ package: 'Off-Peak Membership | East Fremantle', allowed: false }));

    const body = await view();
    expect(body.packagesRuled).toBe(true);
    const byName = new Map<string, any>(body.packages.map((p: any) => [p.name, p]));
    expect(byName.get('Off-Peak Membership | East Fremantle').allowed).toBe(false);
    expect(byName.get('Platinum Membership | East Fremantle').allowed).toBe(true);
  });

  it('flags a package that appeared after the rules were set', async () => {
    await configHandler(patch({ package: 'Off-Peak Membership | East Fremantle', allowed: false }));
    await store.members.upsertManual({
      email: 'new@example.com', firstName: 'Nina', lastName: 'New',
      status: 'active', homeVenueId: VENUE_ID, membershipPackage: 'Founder Membership | East Fremantle',
    });

    const body = await view();
    const founder = body.packages.find((p: any) => p.name === 'Founder Membership | East Fremantle');
    expect(founder.unruled).toBe(true);
    expect(founder.allowed).toBe(false);
  });

  it('refuses anything that is not a plain yes or no', async () => {
    const response = await configHandler(patch({ package: 'Platinum Membership | East Fremantle', allowed: 'yes' }));
    expect(response.status).toBe(400);
  });

  it('is not something door staff can change', async () => {
    const doorCookie = `${STAFF_COOKIE}=${issueStaffSession({ ...ADMIN, role: 'door', staffId: 's2', email: 'door@example.com' })}`;
    const response = await configHandler(new Request(`${BASE}/api/admin/config`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', cookie: doorCookie },
      body: JSON.stringify({ package: 'Platinum Membership | East Fremantle', allowed: false }),
    }));
    expect(response.status).toBe(403);
  });
});

describe('the configuration value', () => {
  it('defaults to nobody having ruled on anything', () => {
    expect(CONFIG_DEFAULTS.packageAccess).toEqual({});
  });
});

describe('a package rule against a member Hapana resolves', () => {
  /**
   * The case that made the rule a no-op. Hapana does not return a package, so
   * the row a live hit writes carries none, and it is a different row from the
   * one the import wrote: same address, different member id. Reading the
   * package off the resolved row therefore answered "no package, so allowed"
   * for precisely the members the venue had ruled on, and only once the Hapana
   * key was set, which is not when anybody would be looking.
   */
  it('still applies when the live lookup answers, not just the cache', async () => {
    const store = createMemoryStore();
    // What the import wrote.
    await store.members.upsertManual({
      email: 'live@example.com', firstName: 'Liv', lastName: 'E', status: 'active',
      homeVenueId: VENUE_ID, membershipPackage: 'Off-Peak Membership | East Fremantle',
    });
    // What Hapana knows: the same person, its own id, no package.
    const membership = createMockHapana({
      members: [{
        memberId: 'hapana-live-1', email: 'live@example.com', firstName: 'Liv', lastName: 'E',
        status: 'active', homeVenueId: VENUE_ID,
      }],
      supportsWrites: false,
    });

    const open = { bookingBackend: 'local', packageAccess: {} } as never;
    expect(await verifyMemberByEmail({ store, membership, config: open }, 'live@example.com')).not.toBeNull();

    const closed = {
      bookingBackend: 'local',
      packageAccess: { 'Off-Peak Membership | East Fremantle': false },
    } as never;
    expect(await verifyMemberByEmail({ store, membership, config: closed }, 'live@example.com')).toBeNull();

    // And the live hit having written its own row does not change the answer.
    expect(await store.members.packageFor('live@example.com')).toBe('Off-Peak Membership | East Fremantle');
  });
});
