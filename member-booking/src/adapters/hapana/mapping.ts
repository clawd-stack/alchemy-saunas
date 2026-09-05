import type { MembershipStatus } from '../../store/types.ts';
import type { HapanaMember, HapanaSession } from './types.ts';

/**
 * Field mapping, in one place per PRD 8 (maintainability).
 *
 * Hapana's API documentation is gated behind a login and could not be read from
 * the build environment, so the field names below are candidates rather than
 * confirmed. Each lookup tries several spellings and the first hit wins. Once
 * scripts/probe-hapana.mjs has dumped a real payload, replace the candidate
 * lists with the real names: that is a small, contained edit and nothing
 * outside this file needs to move.
 */

type Raw = Record<string, unknown>;

function pick(raw: Raw, candidates: string[]): unknown {
  for (const key of candidates) {
    if (key in raw && raw[key] !== null && raw[key] !== undefined && raw[key] !== '') return raw[key];
  }
  return undefined;
}

function asString(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return String(value);
}

function asNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function asDate(value: unknown): Date | null {
  if (!value) return null;
  const parsed = new Date(String(value));
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * Membership status. PRD 5.1 requires paused and suspended to be told apart
 * from active and cancelled: only 'active' may book. Anything unrecognised
 * maps to 'suspended', which is the safe direction, because an unknown state
 * refusing a booking is a support call while an unknown state permitting one
 * is an unauthorised entry.
 */
export function mapMembershipStatus(value: unknown): MembershipStatus {
  const raw = String(value ?? '').trim().toLowerCase();
  if (['active', 'current', 'live', 'ok', '1', 'true'].includes(raw)) return 'active';
  if (['paused', 'pause', 'on hold', 'onhold', 'hold', 'frozen', 'freeze', 'suspended_temporary'].includes(raw)) return 'paused';
  if (['suspended', 'suspend', 'overdue', 'failed', 'arrears', 'expired'].includes(raw)) return 'suspended';
  if (['cancelled', 'canceled', 'terminated', 'ended', 'closed', 'deleted', 'inactive', '0', 'false'].includes(raw)) return 'cancelled';
  return 'suspended';
}

export function mapMember(raw: Raw): HapanaMember | null {
  const memberId = asString(pick(raw, ['memberID', 'memberId', 'member_id', 'clientID', 'clientId', 'id', 'uuid']));
  const email = asString(pick(raw, ['email', 'emailAddress', 'email_address', 'primaryEmail']));
  if (!memberId || !email) return null;

  const statusSource = pick(raw, [
    'membershipStatus',
    'membership_status',
    'memberStatus',
    'status',
    'state',
    'accountStatus',
  ]);

  return {
    memberId,
    email: email.toLowerCase(),
    firstName: asString(pick(raw, ['firstName', 'first_name', 'givenName', 'fname'])),
    lastName: asString(pick(raw, ['lastName', 'last_name', 'surname', 'familyName', 'lname'])),
    status: mapMembershipStatus(statusSource),
    homeVenueId: asString(pick(raw, ['siteID', 'siteId', 'site_id', 'locationID', 'locationId', 'homeSite'])),
  };
}

export function mapSession(raw: Raw, fallbackVenueId: string): HapanaSession | null {
  const externalSessionId = asString(
    pick(raw, ['sessionID', 'sessionId', 'session_id', 'classSessionID', 'occurrenceID', 'id', 'uuid']),
  );
  const startsAt = asDate(pick(raw, ['startDateTime', 'startTime', 'start_time', 'startsAt', 'start', 'sessionStart']));
  if (!externalSessionId || !startsAt) return null;

  const endsAt =
    asDate(pick(raw, ['endDateTime', 'endTime', 'end_time', 'endsAt', 'end', 'sessionEnd'])) ??
    new Date(startsAt.getTime() + 60 * 60_000);

  return {
    externalSessionId,
    venueId: asString(pick(raw, ['siteID', 'siteId', 'site_id', 'locationID', 'locationId'])) ?? fallbackVenueId,
    startsAt,
    endsAt,
    booked: asNumber(pick(raw, ['booked', 'bookedCount', 'totalBooked', 'reservedCount', 'attendeeCount', 'bookings'])),
    capacity: asNumber(pick(raw, ['capacity', 'maxCapacity', 'spots', 'totalSpots', 'maxAttendees'])),
    classId: asString(pick(raw, ['classID', 'classId', 'class_id'])),
    name: asString(pick(raw, ['className', 'name', 'title', 'sessionName'])),
  };
}

export function mapBookingId(raw: Raw): string | null {
  return asString(pick(raw, ['bookingID', 'bookingId', 'booking_id', 'reservationID', 'id', 'uuid']));
}

/** Unwraps the common envelope shapes so callers always get an array of rows. */
export function unwrapList(body: unknown): Raw[] {
  if (Array.isArray(body)) return body as Raw[];
  if (body && typeof body === 'object') {
    const record = body as Raw;
    for (const key of ['data', 'results', 'items', 'records', 'response', 'payload']) {
      const value = record[key];
      if (Array.isArray(value)) return value as Raw[];
      if (value && typeof value === 'object') {
        const nested = unwrapList(value);
        if (nested.length > 0) return nested;
      }
    }
  }
  return [];
}

export function unwrapObject(body: unknown): Raw {
  if (body && typeof body === 'object' && !Array.isArray(body)) {
    const record = body as Raw;
    for (const key of ['data', 'result', 'response', 'payload']) {
      const value = record[key];
      if (value && typeof value === 'object' && !Array.isArray(value)) return value as Raw;
    }
    return record;
  }
  return {};
}
