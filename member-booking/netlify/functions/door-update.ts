import { buildContext } from '../../src/domain/context.ts';
import { requireStaff } from '../../src/lib/auth.ts';
import { BookingError } from '../../src/lib/errors.ts';
import { errorResponse, json, preflight, readJson, requireMethod } from '../../src/lib/http.ts';

/**
 * POST /api/door/update
 *   { bookingId, paymentStatus }              record EFTPOS collection
 *   { bookingId | guestId, checkedIn }        check someone in
 *
 * Payment status is a reconciliation record, not a payment. No money moves
 * through this software. PRD 5.6.
 *
 * Door staff cannot create or cancel bookings in v1, so this endpoint
 * deliberately exposes only those two fields.
 */
export default async (request: Request): Promise<Response> => {
  const early = preflight(request);
  if (early) return early;

  try {
    requireMethod(request, 'POST');
    const context = await buildContext();
    const staff = requireStaff(request, context.venueId);
    const body = await readJson<{
      bookingId?: unknown;
      guestId?: unknown;
      paymentStatus?: unknown;
      checkedIn?: unknown;
    }>(request);

    if (typeof body.paymentStatus === 'string') {
      if (typeof body.bookingId !== 'string') throw new BookingError('INVALID_REQUEST', { field: 'bookingId' });
      if (!['outstanding', 'collected', 'waived'].includes(body.paymentStatus)) {
        throw new BookingError('INVALID_REQUEST', { field: 'paymentStatus' });
      }
      const booking = await context.store.bookings.get(body.bookingId);
      if (!booking || booking.venueId !== context.venueId) throw new BookingError('NOT_FOUND');
      await context.store.bookings.markPayment(
        body.bookingId,
        body.paymentStatus as 'outstanding' | 'collected' | 'waived',
        staff.email,
      );
      return json(request, { ok: true, bookingId: body.bookingId, paymentStatus: body.paymentStatus });
    }

    if (typeof body.checkedIn === 'boolean') {
      const target: { bookingId?: string; guestId?: string } = {};
      if (typeof body.bookingId === 'string') target.bookingId = body.bookingId;
      if (typeof body.guestId === 'string') target.guestId = body.guestId;
      if (!target.bookingId && !target.guestId) throw new BookingError('INVALID_REQUEST');
      await context.store.bookings.setCheckIn(target, body.checkedIn);
      return json(request, { ok: true, ...target, checkedIn: body.checkedIn });
    }

    throw new BookingError('INVALID_REQUEST');
  } catch (error) {
    return errorResponse(request, error);
  }
};

export const config = { path: '/api/door/update' };
