import { describe, expect, it } from 'vitest';
import { syncMembers, verifyMemberByEmail } from '../src/domain/membership.ts';
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
