import { BookingError } from '../lib/errors.ts';
import type { Context } from './context.ts';
import type { HapanaMember } from '../adapters/hapana/types.ts';
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

/**
 * Whether the package a member holds reaches this channel.
 *
 * An empty map means every package does, which is what the channel did before
 * packages were recorded and is therefore what a deployment that has never
 * opened the screen keeps doing. From the first entry onwards the map is the
 * whole answer, and a package nobody has ruled on is closed: an unknown
 * package admitting somebody is an unauthorised entry, and one turning them
 * away is a support call.
 *
 * A member with no package is always allowed. That is somebody the venue added
 * by hand, or a record from before packages were read, and either way a
 * decision made about packages should not quietly revoke them.
 */
export function packageAllows(access: Record<string, boolean>, membershipPackage: string | null): boolean {
  if (!membershipPackage) return true;
  if (Object.keys(access).length === 0) return true;
  return access[membershipPackage] === true;
}

/**
 * Whether the package rules turn this member away.
 *
 * Costs nothing until the venue has actually ruled on a package: with an empty
 * map this answers immediately and never reads anything. Once there are rules,
 * a path that does not already hold the member's row pays one indexed read for
 * it, which is the price of the rule being applied at sign-in and again at
 * booking rather than only at import time.
 */
async function packageDenies(
  context: Pick<Context, 'store' | 'config'>,
  lookup: { record?: MemberRecord | null; memberId?: string; email?: string },
): Promise<boolean> {
  const access = context.config.packageAccess ?? {};
  if (Object.keys(access).length === 0) return false;

  const record = lookup.record
    ?? (lookup.memberId ? await context.store.members.get(lookup.memberId) : null)
    ?? (lookup.email ? await context.store.members.getByEmail(lookup.email) : null);

  return !packageAllows(access, record?.membershipPackage ?? null);
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
      if (member.status !== 'active') return null;
      if (await packageDenies(context, { memberId: member.memberId, email: member.email })) return null;
      return {
        memberId: member.memberId,
        email: member.email,
        name: displayName(member.firstName, member.lastName, member.email),
        status: member.status,
        staleSince: null,
      };
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
    if (await packageDenies(context, { record: cached })) return null;
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
  context: Pick<Context, 'store' | 'config'>,
  email: string,
): Promise<VerifiedMember | null> {
  const record = await context.store.members.getByEmail(email);
  if (!record || record.source !== 'manual' || record.status !== 'active') return null;
  if (await packageDenies(context, { record })) return null;
  return {
    memberId: record.memberId,
    email: record.email,
    name: displayName(record.firstName, record.lastName, record.email),
    status: record.status,
    staleSince: null,
  };
}

/**
 * Resolves a member id against Hapana, live.
 *
 * Hapana has no lookup by client id: the only member read is by email. So the
 * cached row is used for the address and the live call is made on that, which
 * keeps the re-check at booking time a real one rather than a read of a cache
 * that could be a week old. The id is compared afterwards, because an address
 * that now resolves to a different client is not the person holding the
 * session.
 */
async function liveLookup(
  context: Pick<Context, 'store' | 'membership'>,
  memberId: string,
): Promise<HapanaMember | null> {
  const cached = await context.store.members.get(memberId);
  if (cached?.email) {
    const found = await context.membership.findMemberByEmail(cached.email);
    return found && found.memberId === memberId ? found : null;
  }
  // Nothing cached to take an address from. Sources that can answer by id
  // still do; the Hapana adapter raises NotSupported and the caller falls
  // through to its cache path, which is empty here anyway.
  return context.membership.getMember(memberId);
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
    if (await packageDenies(context, { record })) return null;
    return {
      memberId: record.memberId,
      email: record.email,
      name: displayName(record.firstName, record.lastName, record.email),
      status: record.status,
      staleSince: null,
    };
  }

  try {
    const member = await liveLookup(context, memberId);
    if (!member || member.status !== 'active') return null;
    await context.store.members.upsertMany([toRecord(member)]);
    if (await packageDenies(context, { memberId: member.memberId, email: member.email })) return null;
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
    if (await packageDenies(context, { record: cached })) return null;
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
  membershipPackage?: string | null;
}): MemberRecord {
  return {
    ...member,
    membershipPackage: member.membershipPackage ?? null,
    syncedAt: new Date().toISOString(),
    source: 'hapana',
  };
}

/** Pattern B scheduled sync. Returns the number of members refreshed. */
/**
 * Refreshes the membership cache.
 *
 * A delta by default: Hapana returns everything changed on or after a given
 * moment, so the sync asks for changes since the last one rather than pulling
 * the whole membership every time. The mark is rewound by an hour, because a
 * record written while the previous sync was mid-flight would otherwise fall
 * in the gap between the two runs and never be read.
 *
 * The first run has no mark and pulls everything, which is what it is for.
 */
export async function syncMembers(
  context: Pick<Context, 'store' | 'membership'>,
  options: { full?: boolean } = {},
): Promise<{ synced: number; delta: boolean }> {
  const mark = options.full ? null : await context.store.members.lastSyncedAt();
  const since = mark ? new Date(mark.getTime() - 3_600_000) : undefined;

  const members = await context.membership.listMembers(since);
  await context.store.members.upsertMany(members.map(toRecord));
  return { synced: members.length, delta: Boolean(since) };
}
