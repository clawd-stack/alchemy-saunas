import { BookingError } from '../lib/errors.ts';
import type { Context } from './context.ts';
import type { MemberRecord, MembershipStatus } from '../store/types.ts';

/**
 * Membership verification, PRD 5.1.
 *
 * Only 'active' may book. Every other outcome, including an address we have
 * never seen, is reported to the caller as the same generic refusal, so the
 * endpoint cannot be used to work out who is a member.
 */

export interface VerifiedMember {
  memberId: string;
  email: string;
  name: string;
  status: MembershipStatus;
  /** Set under Pattern B when the answer came from the cache rather than live. */
  staleSince: string | null;
}

function displayName(first: string | null, last: string | null, email: string): string {
  const name = [first, last].filter(Boolean).join(' ').trim();
  return name.length > 0 ? name : email;
}

/**
 * Live lookup first. Under Pattern A a live read is required: membership status
 * must not be stale, because a cancellation has to take effect immediately.
 * Under Pattern B a Hapana outage falls back to the last successful sync, and
 * the staleness is carried through so the door list can show it. PRD 8.
 */
export async function verifyMemberByEmail(
  context: Pick<Context, 'store' | 'membership' | 'config'>,
  email: string,
): Promise<VerifiedMember | null> {
  try {
    const member = await context.membership.findMemberByEmail(email);
    if (member) {
      // Keep the cache warm on every live hit so the Pattern B fallback has
      // something recent to fall back to.
      await context.store.members.upsertMany([toRecord(member)]);
      return member.status === 'active'
        ? { memberId: member.memberId, email: member.email, name: displayName(member.firstName, member.lastName, member.email), status: member.status, staleSince: null }
        : null;
    }
    // Hapana answered, and does not know this address. It may still be somebody
    // the venue added by hand, which is the whole point of a manual entry: a
    // member who is not in Hapana yet, or never will be.
    return await manualMember(context, email);
  } catch (error) {
    if (context.config.bookingBackend === 'hapana') {
      // Pattern A: no local inventory to fall back to, so refuse rather than
      // guess. The caller turns this into the maintenance state.
      throw new BookingError('BACKEND_UNAVAILABLE', { cause: 'membership lookup failed' });
    }
    console.warn('[member-booking] membership lookup failed, falling back to cache', error);
    const cached = await context.store.members.getByEmail(email);
    if (!cached || cached.status !== 'active') return null;
    return {
      memberId: cached.memberId,
      email: cached.email,
      name: displayName(cached.firstName, cached.lastName, cached.email),
      status: cached.status,
      // A manual entry is current by definition: somebody typed it, and no sync
      // will refresh it. Marking it stale would put a misleading warning in
      // front of door staff on every booking.
      staleSince: cached.source === 'manual' ? null : cached.syncedAt,
    };
  }
}

/**
 * A member the venue entered by hand, rather than one Hapana knows about.
 *
 * These exist so the channel can run before the Hapana key is configured, and
 * so somebody can be let in when Hapana is wrong. They are deliberately not a
 * back door: only an admin can create one, each is listed on the admin screen
 * with its own row, and removing it removes access immediately.
 */
async function manualMember(
  context: Pick<Context, 'store'>,
  email: string,
): Promise<VerifiedMember | null> {
  const record = await context.store.members.getByEmail(email);
  if (!record || record.source !== 'manual' || record.status !== 'active') return null;
  return {
    memberId: record.memberId,
    email: record.email,
    name: displayName(record.firstName, record.lastName, record.email),
    status: record.status,
    staleSince: null,
  };
}

/** Re-checks a member on an action taken with an existing session cookie. */
export async function verifyMemberById(
  context: Pick<Context, 'store' | 'membership' | 'config'>,
  memberId: string,
): Promise<VerifiedMember | null> {
  // A manual id cannot exist in Hapana, so asking would be a guaranteed miss
  // and, while Hapana is unreachable, a guaranteed 503 for a member who is
  // perfectly valid.
  if (memberId.startsWith('manual:')) {
    const record = await context.store.members.get(memberId);
    if (!record || record.source !== 'manual' || record.status !== 'active') return null;
    return {
      memberId: record.memberId,
      email: record.email,
      name: displayName(record.firstName, record.lastName, record.email),
      status: record.status,
      staleSince: null,
    };
  }

  try {
    const member = await context.membership.getMember(memberId);
    if (!member || member.status !== 'active') return null;
    await context.store.members.upsertMany([toRecord(member)]);
    return {
      memberId: member.memberId,
      email: member.email,
      name: displayName(member.firstName, member.lastName, member.email),
      status: member.status,
      staleSince: null,
    };
  } catch (error) {
    if (context.config.bookingBackend === 'hapana') {
      throw new BookingError('BACKEND_UNAVAILABLE', { cause: 'membership lookup failed' });
    }
    console.warn('[member-booking] membership re-check failed, falling back to cache', error);
    const cached = await context.store.members.get(memberId);
    if (!cached || cached.status !== 'active') return null;
    return {
      memberId: cached.memberId,
      email: cached.email,
      name: displayName(cached.firstName, cached.lastName, cached.email),
      status: cached.status,
      staleSince: cached.syncedAt,
    };
  }
}

function toRecord(member: {
  memberId: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  status: MembershipStatus;
  homeVenueId: string | null;
}): MemberRecord {
  return { ...member, syncedAt: new Date().toISOString(), source: 'hapana' };
}

/** Pattern B scheduled sync. Returns the number of members refreshed. */
export async function syncMembers(context: Pick<Context, 'store' | 'membership'>): Promise<number> {
  const members = await context.membership.listMembers();
  await context.store.members.upsertMany(members.map(toRecord));
  return members.length;
}
