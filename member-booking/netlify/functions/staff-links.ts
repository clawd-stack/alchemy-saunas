import { buildContext } from '../../src/domain/context.ts';
import { requireStaff } from '../../src/lib/auth.ts';
import { generateToken, hashToken } from '../../src/lib/crypto.ts';
import { BookingError } from '../../src/lib/errors.ts';
import { errorResponse, json, preflight, readJson, requireMethod, requireString } from '../../src/lib/http.ts';
import { waiverUrl } from '../../src/domain/waivers.ts';

/**
 * Staff-issued guest waiver links.
 *
 *   POST /api/staff/links { action: "guest-waiver", bookingId, guestId }
 *
 * A guest is not a member and has no account: they are somebody a member is
 * bringing, whose only involvement with this system is signing a waiver once.
 * Issuing them a password would be absurd, so the waiver stays a single-use
 * link, and this is how staff produce one at the counter when a guest never
 * got theirs or turned up without it.
 *
 * Staff-authenticated, and scoped to a guest on a booking at this venue.
 */
export default async (request: Request): Promise<Response> => {
  const early = preflight(request);
  if (early) return early;

  try {
    requireMethod(request, 'POST');
    const context = await buildContext();
    const staff = requireStaff(request, context.venueId);
    const body = await readJson<{ action?: unknown; email?: unknown; bookingId?: unknown; guestId?: unknown }>(request);

    if (body.action === 'guest-waiver') {
      const bookingId = requireString(body.bookingId, 'bookingId', 64);
      const guestId = requireString(body.guestId, 'guestId', 64);

      const booking = await context.store.bookings.get(bookingId);
      if (!booking || booking.venueId !== context.venueId) throw new BookingError('NOT_FOUND');
      const guest = booking.guests.find((candidate) => candidate.guestId === guestId);
      if (!guest) throw new BookingError('NOT_FOUND');

      const token = generateToken();
      const existing = (await context.store.waivers.listForBooking(bookingId)).find((w) => w.guestId === guestId);

      if (existing) {
        // Rotate rather than issue a second record: the waiver is one document
        // per guest per session, and its signature history has to stay in one
        // place to be worth anything.
        await context.store.waivers.rotateToken(existing.waiverId, hashToken(token));
      } else {
        await context.store.waivers.create({
          tokenHash: hashToken(token),
          bookingId,
          guestId,
          venueId: booking.venueId,
          sessionStartsAt: new Date(booking.startsAt),
          guestName: guest.name,
          guestEmail: guest.email,
          waiverVersion: context.config.waiverVersion,
        });
      }

      console.log(`[member-booking] staff ${staff.email} opened a waiver for guest ${guestId}`);

      return json(request, {
        ok: true,
        guestName: guest.name,
        url: waiverUrl(token),
        message: `Hand the tablet to ${guest.name}, or send them this link.`,
      });
    }

    throw new BookingError('INVALID_REQUEST', { field: 'action' });
  } catch (error) {
    return errorResponse(request, error);
  }
};

export const config = { path: '/api/staff/links' };
