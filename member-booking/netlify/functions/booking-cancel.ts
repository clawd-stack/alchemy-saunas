import { buildContext } from '../../src/domain/context.ts';
import { cancelBooking, cancelGuestSpot } from '../../src/domain/booking.ts';
import { requireMember } from '../../src/lib/auth.ts';
import { BookingError } from '../../src/lib/errors.ts';
import { errorResponse, json, preflight, readJson, requireMethod } from '../../src/lib/http.ts';

/**
 * POST /api/bookings/cancel  { bookingId }            cancel the whole booking
 * POST /api/bookings/cancel  { bookingId, guestId }   drop one guest spot
 *
 * Free up to the configured cutoff. Cancelling the member spot cascades to
 * every guest spot; guests are emailed. Released spots return to this
 * channel's allocation, not to the Hapana public pool: ringfencing is a locked
 * decision. PRD 5.5.
 */
export default async (request: Request): Promise<Response> => {
  const early = preflight(request);
  if (early) return early;

  try {
    requireMethod(request, 'POST');
    const session = requireMember(request);
    const context = await buildContext();
    const body = await readJson<{ bookingId?: unknown; guestId?: unknown }>(request);

    if (typeof body.guestId === 'string' && body.guestId.length > 0) {
      const booking = await cancelGuestSpot(context, session.memberId, body.guestId);
      return json(request, {
        ok: true,
        booking,
        message: 'Guest spot released. Their waiver record is kept on file.',
      });
    }

    if (typeof body.bookingId !== 'string' || body.bookingId.length === 0) {
      throw new BookingError('INVALID_REQUEST', { field: 'bookingId' });
    }

    const booking = await cancelBooking(context, session.memberId, body.bookingId);
    return json(request, {
      ok: true,
      booking,
      message: 'Cancelled. Your spot and any guest spots have been released.',
    });
  } catch (error) {
    return errorResponse(request, error);
  }
};

export const config = { path: '/api/bookings/cancel' };
