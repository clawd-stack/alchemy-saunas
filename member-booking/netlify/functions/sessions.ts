import { buildContext } from '../../src/domain/context.ts';
import { listAvailability } from '../../src/domain/sessions.ts';
import { errorResponse, json, preflight, requireMethod } from '../../src/lib/http.ts';
import { readMemberSession } from '../../src/lib/auth.ts';

/**
 * GET /api/sessions
 *
 * Availability for the booking window. Signing in is not required to look, but
 * the numbers shown are this channel's ringfenced allocation only: a member is
 * never shown venue-wide occupancy, which is operational information.
 */
export default async (request: Request): Promise<Response> => {
  const early = preflight(request);
  if (early) return early;

  try {
    requireMethod(request, 'GET');
    const context = await buildContext();
    const sessions = await listAvailability(context);
    const member = readMemberSession(request);

    return json(request, {
      ok: true,
      venue: { id: context.venueId, name: context.venueName, timezone: context.timezone },
      policy: {
        maxGuests: context.config.maxGuestsPerMember,
        guestPrice: context.config.guestPrice,
        bookingWindowDays: context.config.bookingWindowDays,
        cancellationCutoffHours: context.config.cancellationCutoffHours,
      },
      supportEmail: context.config.supportEmail,
      signedIn: Boolean(member),
      memberName: member?.name ?? null,
      sessions: sessions.map(({ publicBooked: _ignored, ...view }) => view),
    });
  } catch (error) {
    return errorResponse(request, error);
  }
};

export const config = { path: '/api/sessions' };
