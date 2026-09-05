import { BookingError } from '../lib/errors.ts';
import { bookingConfirmation, cancellationNotice, sendQueued } from '../lib/email.ts';
import { env } from '../lib/env.ts';
import { formatLocal } from '../lib/time.ts';
import { refusalFromDb } from '../lib/errors.ts';
import { NotSupported } from '../adapters/hapana/adapter.ts';
import { issueWaiversForBooking } from './waivers.ts';
import { resolveSessionForBooking } from './sessions.ts';
import type { Context } from './context.ts';
import type { BookingRecord, GuestInput } from '../store/types.ts';

/**
 * Booking orchestration.
 *
 * The capacity rules themselves are not here: they live in the store, where the
 * lock is (db/schema.sql, create_member_booking). This module resolves the
 * session, establishes occupancy, calls that one function, and then does the
 * things that must happen after a booking exists: register it with Hapana under
 * Pattern A, issue waivers, and send the confirmation.
 *
 * Ordering matters. We reserve locally first and register with Hapana second,
 * because a local reservation can be released deterministically if the second
 * step fails, whereas a Hapana booking we lost track of cannot.
 */

export interface CreateBookingRequest {
  externalSessionId: string;
  guests: GuestInput[];
}

export interface CreateBookingOutcome {
  booking: BookingRecord;
  sessionLabel: string;
}

export async function createBooking(
  context: Context,
  member: { memberId: string; email: string; name: string },
  request: CreateBookingRequest,
  now = new Date(),
): Promise<CreateBookingOutcome> {
  const guests = normaliseGuests(request.guests, context.config.maxGuestsPerMember);

  const session = await resolveSessionForBooking(context, request.externalSessionId, now);
  if (!session.ok) throw new BookingError(session.code);

  const result = await context.store.bookings.create({
    venueId: context.venueId,
    externalSessionId: request.externalSessionId,
    startsAt: session.startsAt,
    endsAt: session.endsAt,
    memberId: member.memberId,
    memberName: member.name,
    memberEmail: member.email,
    guests,
    defaultChannelCapacity: context.config.memberChannelCapacity,
    venueMaximum: context.config.venueMaximum,
    publicBooked: session.publicBooked,
    guestPrice: context.config.guestPrice,
    maxGuests: context.config.maxGuestsPerMember,
    actor: member.memberId,
  });

  if (!result.ok) throw refusalFromDb(result.code, result.detail);

  // Pattern A: Hapana holds the inventory, so the booking has to exist there
  // too. If that fails we release the local spot rather than leave a phantom
  // reservation holding capacity nobody can use.
  if (context.config.bookingBackend === 'hapana') {
    try {
      const external = await context.membership.createBooking({
        externalSessionId: request.externalSessionId,
        memberId: member.memberId,
        spots: result.spotsTotal,
        reference: result.bookingId,
      });
      await context.store.bookings.setExternalId(result.bookingId, external.externalBookingId);
    } catch (error) {
      await context.store.bookings.cancel({
        bookingId: result.bookingId,
        memberId: null,
        cutoffHours: context.config.cancellationCutoffHours,
        defaultChannelCapacity: context.config.memberChannelCapacity,
        venueMaximum: context.config.venueMaximum,
        reason: 'backend_failed',
        enforceCutoff: false,
        actor: 'system',
      });
      console.error('[member-booking] Hapana booking creation failed, local reservation released', error);
      throw new BookingError(error instanceof NotSupported ? 'INTERNAL' : 'BACKEND_UNAVAILABLE');
    }
  }

  const created = await context.store.bookings.get(result.bookingId);
  if (!created) throw new BookingError('INTERNAL');

  const sessionLabel = formatLocal(created.startsAt, context.timezone);

  // Waivers and email are best-effort: a provider outage must not undo a
  // booking that the member has already been told is confirmed. PRD 8.
  await issueWaiversForBooking(context, created).catch((error) => {
    console.error('[member-booking] waiver issue failed; booking stands, waiver queued', error);
  });

  // Re-read after issuing waivers so the confirmation the member sees carries
  // the real per-guest waiver status rather than the pre-issue snapshot.
  const booking = (await context.store.bookings.get(result.bookingId)) ?? created;

  const confirmation = bookingConfirmation({
    memberName: member.name,
    venueName: context.venueName,
    sessionLabel,
    spotsTotal: booking.spotsTotal,
    guestNames: booking.guests.filter((g) => g.status === 'confirmed').map((g) => g.name),
    amountOwed: booking.amountOwedAud,
    cutoffHours: context.config.cancellationCutoffHours,
    manageUrl: new URL('/booking.html#bookings', env.publicBaseUrl).toString(),
  });
  await sendQueued(context.store, 'booking_confirmation', { ...confirmation, to: member.email }, {
    bookingId: booking.bookingId,
  });

  return { booking, sessionLabel };
}

export async function cancelBooking(
  context: Context,
  memberId: string,
  bookingId: string,
): Promise<BookingRecord> {
  const existing = await context.store.bookings.get(bookingId);
  if (!existing || existing.memberId !== memberId) throw new BookingError('NOT_FOUND');

  const result = await context.store.bookings.cancel({
    bookingId,
    memberId,
    cutoffHours: context.config.cancellationCutoffHours,
    defaultChannelCapacity: context.config.memberChannelCapacity,
    venueMaximum: context.config.venueMaximum,
    reason: 'member_cancelled',
    actor: memberId,
  });
  if (!result.ok) throw refusalFromDb(result.code, result.detail);

  if (context.config.bookingBackend === 'hapana' && existing.externalBookingId) {
    // A failure here leaves a Hapana booking that our side considers cancelled.
    // That direction is safe (it holds a spot rather than oversells one) and is
    // visible on the reconciliation, so it is logged and not retried inline.
    await context.membership.cancelBooking(existing.externalBookingId).catch((error) => {
      console.error('[member-booking] Hapana cancellation failed; reconcile manually', {
        bookingId,
        externalBookingId: existing.externalBookingId,
        error,
      });
    });
  }

  const sessionLabel = formatLocal(existing.startsAt, context.timezone);
  for (const guest of existing.guests.filter((g) => g.status === 'confirmed')) {
    const notice = cancellationNotice({
      recipientName: guest.name,
      venueName: context.venueName,
      sessionLabel,
      cancelledByMember: true,
      memberName: existing.memberName,
    });
    await sendQueued(context.store, 'guest_cancellation', { ...notice, to: guest.email }, { bookingId });
  }

  const updated = await context.store.bookings.get(bookingId);
  return updated ?? existing;
}

export async function cancelGuestSpot(
  context: Context,
  memberId: string,
  guestId: string,
): Promise<BookingRecord> {
  const result = await context.store.bookings.cancelGuest({
    guestId,
    memberId,
    cutoffHours: context.config.cancellationCutoffHours,
    guestPrice: context.config.guestPrice,
    defaultChannelCapacity: context.config.memberChannelCapacity,
    venueMaximum: context.config.venueMaximum,
    actor: memberId,
  });
  if (!result.ok) throw refusalFromDb(result.code, result.detail);

  const booking = await context.store.bookings.get(result.bookingId);
  if (!booking) throw new BookingError('INTERNAL');

  const guest = booking.guests.find((g) => g.guestId === guestId);
  if (guest) {
    const notice = cancellationNotice({
      recipientName: guest.name,
      venueName: context.venueName,
      sessionLabel: formatLocal(booking.startsAt, context.timezone),
      cancelledByMember: true,
      memberName: booking.memberName,
    });
    await sendQueued(context.store, 'guest_cancellation', { ...notice, to: guest.email }, {
      bookingId: booking.bookingId,
    });
  }

  return booking;
}

export async function listMemberBookings(context: Context, memberId: string): Promise<BookingRecord[]> {
  const from = new Date(Date.now() - 24 * 60 * 60_000);
  return context.store.bookings.listForMember(memberId, from);
}

/**
 * The same list, reaching back far enough to be a history rather than a
 * schedule. The booking page wants what is coming up; the account page wants
 * what a member has actually done, which is a different question and a
 * different window.
 */
export async function listMemberHistory(
  context: Context,
  memberId: string,
  lookbackDays = 365,
): Promise<BookingRecord[]> {
  const from = new Date(Date.now() - lookbackDays * 24 * 60 * 60_000);
  return context.store.bookings.listForMember(memberId, from);
}

function normaliseGuests(guests: GuestInput[] | undefined, maxGuests: number): GuestInput[] {
  const list = Array.isArray(guests) ? guests : [];
  if (list.length > maxGuests) {
    throw new BookingError('GUEST_COUNT_OUT_OF_RANGE', { requestedGuests: list.length, maxGuests });
  }
  return list.map((guest) => {
    const name = typeof guest?.name === 'string' ? guest.name.trim() : '';
    const email = typeof guest?.email === 'string' ? guest.email.trim().toLowerCase() : '';
    if (!name || !email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      throw new BookingError('GUEST_DETAILS_INCOMPLETE');
    }
    if (name.length > 120 || email.length > 254) throw new BookingError('GUEST_DETAILS_INCOMPLETE');
    return { name, email };
  });
}
