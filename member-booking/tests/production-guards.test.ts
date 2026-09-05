import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildContext, overrideContext } from '../src/domain/context.ts';
import { createUnavailableMembership } from '../src/adapters/hapana/adapter.ts';
import { verifyMemberByEmail } from '../src/domain/membership.ts';
import { createMemoryStore, type MemoryStore } from '../src/store/memory.ts';
import { ACTIVE_MEMBER } from './helpers.ts';

/**
 * What a production deployment does before its Hapana key is set.
 *
 * This exists because of a real outage. The context refused to build at all
 * when HAPANA_API_KEY was missing in production, which sounds like a safe
 * default and is not: membership is resolved once per request for every
 * endpoint, so the missing key returned 500 from the entire API, including the
 * admin screen where the key would have been entered. The deployment could not
 * bootstrap itself out of it.
 *
 * The property worth keeping is that no member is ever served from a source
 * that cannot actually confirm them. These tests pin both halves: members are
 * refused, and everything that does not depend on membership keeps working.
 */

let store: MemoryStore;
const originalContext = process.env.CONTEXT;
const originalKey = process.env.HAPANA_API_KEY;

beforeEach(() => {
  store = createMemoryStore();
  overrideContext(null, null);
});

afterEach(() => {
  if (originalContext === undefined) delete process.env.CONTEXT;
  else process.env.CONTEXT = originalContext;
  if (originalKey === undefined) delete process.env.HAPANA_API_KEY;
  else process.env.HAPANA_API_KEY = originalKey;
  overrideContext(null, null);
});

describe('production with no Hapana key', () => {
  it('still builds a context rather than failing every request', async () => {
    process.env.CONTEXT = 'production';
    delete process.env.HAPANA_API_KEY;
    overrideContext(store, null);

    // The regression: this used to throw, and every endpoint returned 500.
    const context = await buildContext();
    expect(context.membership.name).toBe('unavailable');
  });

  it('refuses every membership lookup rather than inventing an answer', async () => {
    const membership = createUnavailableMembership('no key');
    await expect(membership.findMemberByEmail('anyone@example.com')).rejects.toThrow(/unreachable/i);
    await expect(membership.listMembers()).rejects.toThrow();
    await expect(membership.listSessions('east-fremantle', new Date(), new Date())).rejects.toThrow();
    await expect(membership.publicBookedFor('east-fremantle', 's1')).rejects.toThrow();
  });

  it('leaves no member verifiable, so nobody can sign in or book', async () => {
    // Fail closed: the outage path falls back to the cache, and an unconfigured
    // deployment has an empty one.
    const verified = await verifyMemberByEmail(
      { store, membership: createUnavailableMembership('no key'), config: { bookingBackend: 'local' } as never },
      ACTIVE_MEMBER.email,
    );
    expect(verified).toBeNull();
  });

  it('would let a cached member through only if a sync had ever run', async () => {
    // Guards the fail-closed claim honestly: the refusal above is because the
    // cache is empty, not because the cache is ignored. A deployment that had
    // synced before losing its key keeps serving its last known members, which
    // is the documented Pattern B degradation rather than a hole.
    store.seedMember({
      memberId: ACTIVE_MEMBER.memberId,
      email: ACTIVE_MEMBER.email,
      firstName: 'Ada',
      lastName: 'Active',
      status: 'active',
      homeVenueId: 'east-fremantle',
      syncedAt: new Date().toISOString(),
    });

    const verified = await verifyMemberByEmail(
      { store, membership: createUnavailableMembership('no key'), config: { bookingBackend: 'local' } as never },
      ACTIVE_MEMBER.email,
    );
    expect(verified?.staleSince).toBeTruthy();
  });

  it('does not reach for the mock, which would let anyone in', async () => {
    process.env.CONTEXT = 'production';
    delete process.env.HAPANA_API_KEY;
    overrideContext(store, null);

    const context = await buildContext();
    expect(context.membership.name).not.toBe('mock');
  });
});
