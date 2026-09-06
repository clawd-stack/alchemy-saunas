import { describe, expect, it } from 'vitest';
import { syncMembers, verifyMemberByEmail, verifyMemberById } from '../src/domain/membership.ts';
import { mapMembershipStatus } from '../src/adapters/hapana/mapping.ts';
import { ACTIVE_MEMBER, CANCELLED_MEMBER, PAUSED_MEMBER, makeHarness } from './helpers.ts';

/**
 * Membership verification, PRD 5.1 and acceptance criterion 2.
 * Only active may book, and every failure looks the same from outside.
 */

describe('membership verification', () => {
  it('admits an active member', async () => {
    const { context } = makeHarness();
    const member = await verifyMemberByEmail(context, ACTIVE_MEMBER.email);
    expect(member?.memberId).toBe(ACTIVE_MEMBER.memberId);
    expect(member?.name).toBe('Ada Active');
  });

  it('refuses paused, cancelled and unknown alike, with no way to tell them apart', async () => {
    const { context } = makeHarness();
    expect(await verifyMemberByEmail(context, PAUSED_MEMBER.email)).toBeNull();
    expect(await verifyMemberByEmail(context, CANCELLED_MEMBER.email)).toBeNull();
    expect(await verifyMemberByEmail(context, 'never-heard-of-them@example.com')).toBeNull();
  });

  it('caches every live hit so the Pattern B fallback has something recent', async () => {
    const { context, store } = makeHarness();
    await verifyMemberByEmail(context, ACTIVE_MEMBER.email);
    expect((await store.members.getByEmail(ACTIVE_MEMBER.email))?.status).toBe('active');
  });
});

describe('degradation', () => {
  it('Pattern B falls back to the last successful sync when Hapana is down', async () => {
    const harness = makeHarness({ config: { bookingBackend: 'local' } });
    await syncMembers(harness.context);
    harness.hapana.setUnavailable(true);

    const member = await verifyMemberByEmail(harness.context, ACTIVE_MEMBER.email);
    expect(member?.memberId).toBe(ACTIVE_MEMBER.memberId);
    // Staleness is carried through so the door list can show it.
    expect(member?.staleSince).not.toBeNull();
  });

  it('a member cancelled before the outage stays refused from the cache', async () => {
    const harness = makeHarness({ config: { bookingBackend: 'local' } });
    await syncMembers(harness.context);
    harness.hapana.setUnavailable(true);
    expect(await verifyMemberByEmail(harness.context, CANCELLED_MEMBER.email)).toBeNull();
  });

  it('Pattern A refuses rather than trusting a cache', async () => {
    const harness = makeHarness({ config: { bookingBackend: 'hapana' } });
    await syncMembers(harness.context);
    harness.hapana.setUnavailable(true);

    await expect(verifyMemberByEmail(harness.context, ACTIVE_MEMBER.email)).rejects.toMatchObject({
      code: 'BACKEND_UNAVAILABLE',
    });
  });
});

describe('status mapping', () => {
  it('tells paused and suspended apart from active and cancelled', () => {
    expect(mapMembershipStatus('Active')).toBe('active');
    expect(mapMembershipStatus('PAUSED')).toBe('paused');
    expect(mapMembershipStatus('on hold')).toBe('paused');
    expect(mapMembershipStatus('suspended')).toBe('suspended');
    expect(mapMembershipStatus('Cancelled')).toBe('cancelled');
  });

  it('treats an unrecognised status as not bookable', () => {
    // The safe direction: an unknown state refusing a booking is a support
    // call, an unknown state permitting one is an unauthorised entry.
    expect(mapMembershipStatus('some-new-hapana-state')).toBe('suspended');
    expect(mapMembershipStatus(undefined)).toBe('suspended');
  });
});

describe('the scheduled sync', () => {
  it('pulls everything the first time, when there is no mark to work from', async () => {
    const { context, store } = makeHarness();
    const result = await syncMembers(context);
    expect(result.delta).toBe(false);
    expect(result.synced).toBeGreaterThan(0);
    expect(await store.members.lastSyncedAt()).not.toBeNull();
  });

  it('asks only for what changed once it has synced before', async () => {
    // Hapana returns everything modified on or after a moment, so a second
    // full pull every week is a request for the whole membership when almost
    // none of it moved.
    const { context, hapana } = makeHarness();
    await syncMembers(context);

    const asked: Array<Date | undefined> = [];
    const original = hapana.listMembers.bind(hapana);
    hapana.listMembers = async (since?: Date) => {
      asked.push(since);
      return original(since);
    };

    const result = await syncMembers(context);
    expect(result.delta).toBe(true);
    expect(asked[0]).toBeInstanceOf(Date);
  });

  it('rewinds the mark, so a record written mid-sync is not skipped forever', async () => {
    const { context } = makeHarness();
    await syncMembers(context);

    let asked: Date | undefined;
    context.membership.listMembers = async (since?: Date) => {
      asked = since;
      return [];
    };
    await syncMembers(context);

    // An hour behind the last write, not exactly at it.
    expect(asked!.getTime()).toBeLessThan(Date.now() - 3_500_000);
  });

  it('pulls everything when asked to, whatever the mark says', async () => {
    const { context } = makeHarness();
    await syncMembers(context);
    expect((await syncMembers(context, { full: true })).delta).toBe(false);
  });

  it('does not let a manually added member drag the mark forward', async () => {
    // Manual rows are written by hand. Counting them would move the high-water
    // mark without anything having been read from Hapana, and the next delta
    // would start after changes it never saw.
    const { context, store } = makeHarness();
    await syncMembers(context);
    const afterSync = await store.members.lastSyncedAt();

    await store.members.upsertManual({
      email: 'walkin@example.com', firstName: 'Walk', lastName: 'In',
      status: 'active', homeVenueId: null,
    });
    expect((await store.members.lastSyncedAt())?.getTime()).toBe(afterSync?.getTime());
  });
});

describe('re-checking a member at booking time', () => {
  it('is a live call, made on the cached address because Hapana has no lookup by id', async () => {
    const { context, hapana } = makeHarness();
    await syncMembers(context);

    const asked: string[] = [];
    const original = hapana.findMemberByEmail.bind(hapana);
    hapana.findMemberByEmail = async (email: string) => {
      asked.push(email);
      return original(email);
    };

    const member = await verifyMemberById(context, ACTIVE_MEMBER.memberId);
    expect(member?.memberId).toBe(ACTIVE_MEMBER.memberId);
    expect(asked).toEqual([ACTIVE_MEMBER.email]);
    // Live, so nothing stale is carried through.
    expect(member?.staleSince).toBeNull();
  });

  it('refuses when the address now resolves to somebody else', async () => {
    // The person holding the session is identified by id. An address that has
    // been reassigned in Hapana is a different client, not this one.
    const { context, hapana } = makeHarness();
    await syncMembers(context);
    hapana.findMemberByEmail = async () => ({ ...ACTIVE_MEMBER, memberId: 'someone-else' });

    expect(await verifyMemberById(context, ACTIVE_MEMBER.memberId)).toBeNull();
  });

  it('falls back to the cache when the live call cannot be made', async () => {
    const { context, hapana } = makeHarness({ config: { bookingBackend: 'local' } });
    await syncMembers(context);
    hapana.setUnavailable(true);

    const member = await verifyMemberById(context, ACTIVE_MEMBER.memberId);
    expect(member?.memberId).toBe(ACTIVE_MEMBER.memberId);
    expect(member?.staleSince).not.toBeNull();
  });
});
