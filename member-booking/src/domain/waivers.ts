import { generateToken, hashToken } from '../lib/crypto.ts';
import { sendQueued, waiverInvite } from '../lib/email.ts';
import { env } from '../lib/env.ts';
import { formatLocal } from '../lib/time.ts';
import type { Context } from './context.ts';
import type { BookingRecord, WaiverRecord } from '../store/types.ts';

/**
 * Waiver service, PRD 5.4.
 *
 * Each guest gets their own waiver at their own address. The member never signs
 * on a guest's behalf. An unsigned waiver does not block the booking: it shows
 * as unsigned on the door list and is resolved at the venue.
 *
 * Waiver records are a liability document, so they are retained independently
 * of the booking and survive its cancellation.
 */

export const WAIVER_REMINDER_LEAD_HOURS = 24;

export function waiverUrl(token: string): string {
  const url = new URL('/waiver.html', env.publicBaseUrl);
  url.hash = token;
  return url.toString();
}

/** Creates and sends one waiver per confirmed guest that does not already have one. */
export async function issueWaiversForBooking(context: Context, booking: BookingRecord): Promise<WaiverRecord[]> {
  const existing = await context.store.waivers.listForBooking(booking.bookingId);
  const haveGuestIds = new Set(existing.map((w) => w.guestId));
  const issued: WaiverRecord[] = [];

  for (const guest of booking.guests) {
    if (guest.status !== 'confirmed' || haveGuestIds.has(guest.guestId)) continue;

    const token = generateToken();
    const waiver = await context.store.waivers.create({
      tokenHash: hashToken(token),
      bookingId: booking.bookingId,
      guestId: guest.guestId,
      venueId: booking.venueId,
      sessionStartsAt: new Date(booking.startsAt),
      guestName: guest.name,
      guestEmail: guest.email,
      waiverVersion: context.config.waiverVersion,
    });

    const message = waiverInvite({
      guestName: guest.name,
      memberName: booking.memberName,
      venueName: context.venueName,
      sessionLabel: formatLocal(booking.startsAt, context.timezone),
      waiverUrl: waiverUrl(token),
      isReminder: false,
    });
    await sendQueued(context.store, 'waiver_invite', { ...message, to: guest.email }, {
      bookingId: booking.bookingId,
      guestId: guest.guestId,
      waiverId: waiver.waiverId,
    });
    await context.store.waivers.markSent(waiver.waiverId, false);
    issued.push(waiver);
  }

  return issued;
}

export async function getWaiverByToken(context: Context, token: string): Promise<WaiverRecord | null> {
  if (!token || token.length < 20) return null;
  return context.store.waivers.getByTokenHash(hashToken(token));
}

export async function signWaiver(
  context: Context,
  input: { token: string; signedName: string; signature: string; ip: string | null; userAgent: string | null },
): Promise<WaiverRecord | null> {
  const waiver = await getWaiverByToken(context, input.token);
  if (!waiver) return null;
  if (waiver.status === 'signed') return waiver;
  return context.store.waivers.sign({
    waiverId: waiver.waiverId,
    signedName: input.signedName,
    signature: input.signature,
    ip: input.ip,
    userAgent: input.userAgent,
  });
}

/**
 * One reminder, 24 hours out, for anything still unsigned. Runs hourly; the
 * reminder_sent_at column keeps it to one per waiver however often it runs.
 */
export async function sendWaiverReminders(context: Context, now = new Date()): Promise<number> {
  const from = new Date(now.getTime() + (WAIVER_REMINDER_LEAD_HOURS - 1) * 3_600_000);
  const to = new Date(now.getTime() + WAIVER_REMINDER_LEAD_HOURS * 3_600_000);
  const due = await context.store.waivers.listUnsignedStartingBetween(from, to);

  let sent = 0;
  for (const waiver of due) {
    const booking = waiver.bookingId ? await context.store.bookings.get(waiver.bookingId) : null;
    // The original token was only ever stored as a hash, so it cannot be
    // re-sent. Rotate to a fresh token on the same waiver record: the reminder
    // link works, the earlier link stops working, and the liability record
    // stays a single row rather than being duplicated per reminder.
    const token = generateToken();
    await context.store.waivers.rotateToken(waiver.waiverId, hashToken(token));

    const message = waiverInvite({
      guestName: waiver.guestName,
      memberName: booking?.memberName ?? 'Your host',
      venueName: context.venueName,
      sessionLabel: formatLocal(waiver.sessionStartsAt, context.timezone),
      waiverUrl: waiverUrl(token),
      isReminder: true,
    });
    await sendQueued(context.store, 'waiver_reminder', { ...message, to: waiver.guestEmail }, {
      waiverId: waiver.waiverId,
      bookingId: waiver.bookingId,
    });
    await context.store.waivers.markSent(waiver.waiverId, true);
    sent += 1;
  }
  return sent;
}
