import { buildContext } from '../../src/domain/context.ts';
import { createBooking, listMemberBookings } from '../../src/domain/booking.ts';
import { verifyMemberById } from '../../src/domain/membership.ts';
import { requireMember } from '../../src/lib/auth.ts';
import { BookingError } from '../../src/lib/errors.ts';
import { errorResponse, json, preflight, readJson } from '../../src/lib/http.ts';
import { formatLocal } from '../../src/lib/time.ts';
import type { GuestInput } from '../../src/store/types.ts';

/**
 * GET  /api/bookings   the member's own bookings
 * POST /api/bookings   create one
 *
 * Membership is re-verified on create rather than trusted from the cookie, so a
 * membership cancelled after sign-in cannot still book. PRD 5.3 rule 1.
 */
export default async (request: Request): Promise<Response> => {
  const early = preflight(request);
  if (early) return early;

  try {
    const session = requireMember(request);
    const context = await buildContext();

    if (request.method === 'GET') {
      const bookings = await listMemberBookings(context, session.memberId);
      return json(request, {
        ok: true,
        bookings: bookings.map((booking) => ({
          ...booking,
          sessionLabel: formatLocal(booking.startsAt, context.timezone),
          canCancel:
            booking.status === 'confirmed' &&
            new Date(booking.startsAt).getTime() - context.config.cancellationCutoffHours * 3_600_000 > Date.now(),
        })),
        policy: {
          cancellationCutoffHours: context.config.cancellationCutoffHours,
          guestPrice: context.config.guestPrice,
        },
      });
    }

    if (request.method !== 'POST') throw new BookingError('INVALID_REQUEST');

    const body = await readJson<{ sessionId?: unknown; guests?: unknown }>(request);
    if (typeof body.sessionId !== 'string' || body.sessionId.length === 0) {
      throw new BookingError('INVALID_REQUEST', { field: 'sessionId' });
    }

    const member = await verifyMemberById(context, session.memberId);
    if (!member) throw new BookingError('NO_ACTIVE_MEMBERSHIP');

    const outcome = await createBooking(context, member, {
      externalSessionId: body.sessionId,
      guests: (Array.isArray(body.guests) ? body.guests : []) as GuestInput[],
    });

    return json(request, {
      ok: true,
      booking: outcome.booking,
      sessionLabel: outcome.sessionLabel,
      message:
        outcome.booking.spotsGuest > 0
          ? `Booked. $${outcome.booking.amountOwedAud.toFixed(2)} is payable by card at the venue, and each guest has been emailed their waiver.`
          : 'Booked. Nothing to pay: your member spot is included in your membership.',
    }, 201);
  } catch (error) {
    return errorResponse(request, error);
  }
};

export const config = { path: '/api/bookings' };
