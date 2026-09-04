import { addDays, localDateKey, localWallClockToInstant, localWeekdayKey, MINUTE_MS } from '../lib/time.ts';
import { BookingError } from '../lib/errors.ts';
import type { AppConfig } from '../lib/config.ts';
import type { AvailabilityRow, Store } from '../store/types.ts';
import type { MembershipSource } from '../adapters/hapana/adapter.ts';
import type { Context } from './context.ts';

/**
 * Session availability, PRD 5.2.
 *
 * Under Pattern A the session list comes from Hapana (the hidden member class
 * on the East Fremantle room) and our local rows exist only to hold the
 * ringfenced count. Under Pattern B we generate the timetable from the
 * configured operating hours, because Hapana has no member class to read.
 *
 * Either way the number the member sees is spots_remaining for *this channel*,
 * never the venue maximum. PRD 5.2.
 */

export interface SessionView {
  externalSessionId: string;
  startsAt: string;
  endsAt: string;
  capacity: number;
  booked: number;
  spotsRemaining: number;
  bookable: boolean;
  /** Present only for staff views; members are never shown venue-wide occupancy. */
  publicBooked?: number;
}

/**
 * Builds the local session key under Pattern B. Deterministic, so regenerating
 * the timetable does not create duplicate sessions for the same slot.
 */
export function localSessionKey(venueId: string, startsAt: Date): string {
  return `${venueId}:${startsAt.toISOString().slice(0, 16)}`;
}

/** Generates hourly slots inside the configured operating hours for a window. */
export function generateSlots(
  config: AppConfig,
  timezone: string,
  venueId: string,
  from: Date,
  to: Date,
): Array<{ externalSessionId: string; startsAt: Date; endsAt: Date }> {
  const slots: Array<{ externalSessionId: string; startsAt: Date; endsAt: Date }> = [];
  const lengthMs = config.sessionLengthMinutes * MINUTE_MS;
  const seenDays = new Set<string>();

  for (let cursor = new Date(from); cursor <= to; cursor = addDays(cursor, 1)) {
    const dayKey = localDateKey(cursor, timezone);
    if (seenDays.has(dayKey)) continue;
    seenDays.add(dayKey);

    const weekday = localWeekdayKey(cursor, timezone);
    const hours = config.operatingHours?.[weekday];
    if (!hours) continue;

    const [openTime, closeTime] = hours;
    const open = localWallClockToInstant(dayKey, openTime, timezone);
    const close = localWallClockToInstant(dayKey, closeTime, timezone);

    for (let start = open; start.getTime() + lengthMs <= close.getTime(); start = new Date(start.getTime() + lengthMs)) {
      if (start < from || start > to) continue;
      slots.push({
        externalSessionId: localSessionKey(venueId, start),
        startsAt: new Date(start),
        endsAt: new Date(start.getTime() + lengthMs),
      });
    }
  }
  return slots;
}

async function ensureLocalSessions(
  store: Store,
  venueId: string,
  slots: Array<{ externalSessionId: string; startsAt: Date; endsAt: Date }>,
): Promise<void> {
  for (const slot of slots) {
    await store.sessions.upsert({ venueId, ...slot });
  }
}

/**
 * The bookable window: from now to now + booking_window_days. Sessions inside
 * the cancellation cutoff are still bookable; the cutoff governs cancellation,
 * not booking. PRD 5.2.
 */
export function bookingWindow(config: AppConfig, now = new Date()): { from: Date; to: Date } {
  return { from: now, to: addDays(now, config.bookingWindowDays) };
}

export async function listAvailability(
  context: Pick<Context, 'store' | 'membership' | 'config' | 'venueId' | 'timezone'>,
  options: { now?: Date; includePublic?: boolean } = {},
): Promise<SessionView[]> {
  const now = options.now ?? new Date();
  const { from, to } = bookingWindow(context.config, now);

  if (context.config.bookingBackend === 'hapana') {
    return availabilityFromHapana(context, from, to, options.includePublic ?? false);
  }
  return availabilityFromTimetable(context, from, to, options.includePublic ?? false);
}

async function availabilityFromTimetable(
  context: Pick<Context, 'store' | 'membership' | 'config' | 'venueId' | 'timezone'>,
  from: Date,
  to: Date,
  includePublic: boolean,
): Promise<SessionView[]> {
  const slots = generateSlots(context.config, context.timezone, context.venueId, from, to);
  await ensureLocalSessions(context.store, context.venueId, slots);
  const rows = await context.store.sessions.availability(context.venueId, from, to, context.config.memberChannelCapacity);
  return rows.map((row) => toView(row, includePublic ? context.config.hapanaPublicCapacity : undefined));
}

async function availabilityFromHapana(
  context: Pick<Context, 'store' | 'membership' | 'config' | 'venueId' | 'timezone'>,
  from: Date,
  to: Date,
  includePublic: boolean,
): Promise<SessionView[]> {
  // A Hapana outage under Pattern A means we cannot know what is available, so
  // the page must show the maintenance state rather than an empty timetable
  // that looks like a sold-out venue. PRD 8, acceptance criterion 10.
  let hapanaSessions;
  try {
    hapanaSessions = await context.membership.listSessions(context.venueId, from, to);
  } catch (error) {
    console.error('[member-booking] Hapana session read failed', error);
    throw new BookingError('BACKEND_UNAVAILABLE');
  }
  for (const session of hapanaSessions) {
    await context.store.sessions.upsert({
      venueId: context.venueId,
      externalSessionId: session.externalSessionId,
      startsAt: session.startsAt,
      endsAt: session.endsAt,
    });
    if (session.booked !== null) {
      await context.store.sessions.setPublicBookedCache(context.venueId, session.externalSessionId, session.booked);
    }
  }
  const rows = await context.store.sessions.availability(context.venueId, from, to, context.config.memberChannelCapacity);
  const bookedById = new Map(hapanaSessions.map((s) => [s.externalSessionId, s.booked]));
  return rows.map((row) => {
    const publicBooked = bookedById.get(row.externalSessionId) ?? null;
    return toView(row, includePublic && publicBooked !== null ? publicBooked : undefined);
  });
}

function toView(row: AvailabilityRow, publicBooked?: number): SessionView {
  const view: SessionView = {
    externalSessionId: row.externalSessionId,
    startsAt: row.startsAt,
    endsAt: row.endsAt,
    capacity: row.capacity,
    booked: row.booked,
    spotsRemaining: row.spotsRemaining,
    bookable: !row.closed && row.spotsRemaining > 0 && new Date(row.startsAt) > new Date(),
  };
  if (publicBooked !== undefined) view.publicBooked = publicBooked;
  return view;
}

/**
 * Resolves the session a booking request names, and establishes how many spots
 * the public channel already holds.
 *
 * The second half is the ceiling input. If it cannot be established the caller
 * gets null and the booking is refused: fail closed, never open. PRD 8.
 */
export async function resolveSessionForBooking(
  context: Pick<Context, 'store' | 'membership' | 'config' | 'venueId' | 'timezone'>,
  externalSessionId: string,
  now = new Date(),
): Promise<
  | { ok: true; startsAt: Date; endsAt: Date; publicBooked: number }
  | { ok: false; code: 'SESSION_NOT_FOUND' | 'SESSION_IN_PAST' | 'OUTSIDE_BOOKING_WINDOW' | 'OCCUPANCY_UNKNOWN' }
> {
  const { from, to } = bookingWindow(context.config, now);
  const candidates = await listAvailability(context, { now });
  const match = candidates.find((session) => session.externalSessionId === externalSessionId);
  if (!match) return { ok: false, code: 'SESSION_NOT_FOUND' };

  const startsAt = new Date(match.startsAt);
  const endsAt = new Date(match.endsAt);
  if (startsAt <= now) return { ok: false, code: 'SESSION_IN_PAST' };
  if (startsAt < from || startsAt > to) return { ok: false, code: 'OUTSIDE_BOOKING_WINDOW' };

  const publicBooked = await resolvePublicBooked(context, externalSessionId);
  if (publicBooked === null) return { ok: false, code: 'OCCUPANCY_UNKNOWN' };

  return { ok: true, startsAt, endsAt, publicBooked };
}

/**
 * Public-channel occupancy for the ceiling check.
 *
 * Pattern A: read it live from Hapana. If Hapana is unreachable we return null
 * and the booking is refused, which is the documented behaviour.
 *
 * Pattern B: the two allocations are disjoint by construction, so the public
 * side can never be more than its configured capacity. Using that configured
 * capacity is the conservative assumption: it can only make the ceiling check
 * stricter, never looser.
 */
export async function resolvePublicBooked(
  context: Pick<Context, 'store' | 'membership' | 'config' | 'venueId'>,
  externalSessionId: string,
): Promise<number | null> {
  if (context.config.bookingBackend !== 'hapana') {
    return context.config.hapanaPublicCapacity;
  }
  try {
    const booked = await context.membership.publicBookedFor(context.venueId, externalSessionId);
    return booked ?? null;
  } catch {
    return null;
  }
}

/** Convenience for the scheduled job that pre-creates the timetable. */
export async function materialiseTimetable(
  context: Pick<Context, 'store' | 'config' | 'venueId' | 'timezone'>,
  now = new Date(),
): Promise<number> {
  const { from, to } = bookingWindow(context.config, now);
  const slots = generateSlots(context.config, context.timezone, context.venueId, from, to);
  await ensureLocalSessions(context.store, context.venueId, slots);
  return slots.length;
}

export type { MembershipSource };
