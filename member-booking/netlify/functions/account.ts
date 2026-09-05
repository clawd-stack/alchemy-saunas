import { buildContext } from '../../src/domain/context.ts';
import { listMemberHistory } from '../../src/domain/booking.ts';
import { verifyMemberById } from '../../src/domain/membership.ts';
import { requireMember } from '../../src/lib/auth.ts';
import { errorResponse, json, preflight, requireMethod } from '../../src/lib/http.ts';
import { formatLocal } from '../../src/lib/time.ts';

/**
 * GET /api/account
 *
 * Everything the account page shows, in one request: who you are, whether the
 * membership behind you is still active, what you have coming up, and what you
 * have been to.
 *
 * One endpoint rather than three, because the page is a single answer to a
 * single question and three round trips would render it in pieces on a phone
 * at the door.
 *
 * Membership is read live, not taken from the session cookie. A member whose
 * membership lapsed after signing in should see that here rather than discover
 * it when a booking is refused.
 */
export default async (request: Request): Promise<Response> => {
  const early = preflight(request);
  if (early) return early;

  try {
    requireMethod(request, 'GET');
    const session = requireMember(request);
    const context = await buildContext();

    // verifyMemberById collapses every inactive state to null, which is right
    // for a gate and useless for a status line: "unknown" tells a member
    // nothing, where "paused" tells them what to ask the venue about. So the
    // raw record is read alongside it to recover the actual word, live where
    // there is a live source and from our own records otherwise.
    const isManual = session.memberId.startsWith('manual:');
    const [verified, cached, live] = await Promise.all([
      verifyMemberById(context, session.memberId).catch(() => null),
      context.store.members.get(session.memberId).catch(() => null),
      isManual ? Promise.resolve(null) : context.membership.getMember(session.memberId).catch(() => null),
    ]);

    const all = await listMemberHistory(context, session.memberId);
    const now = Date.now();
    const cutoffMs = context.config.cancellationCutoffHours * 3_600_000;

    const present = (booking: (typeof all)[number]) => ({
      bookingId: booking.bookingId,
      sessionLabel: formatLocal(booking.startsAt, context.timezone),
      startsAt: booking.startsAt,
      spotsTotal: booking.spotsTotal,
      spotsGuest: booking.spotsGuest,
      amountOwedAud: booking.amountOwedAud,
      paymentStatus: booking.paymentStatus,
      status: booking.status,
      guests: booking.guests,
      canCancel: booking.status === 'confirmed' && new Date(booking.startsAt).getTime() - cutoffMs > now,
    });

    const upcoming = all
      .filter((b) => b.status === 'confirmed' && new Date(b.startsAt).getTime() >= now)
      .map(present);

    // Newest first: a history is read backwards from today.
    const previous = all
      .filter((b) => b.status !== 'confirmed' || new Date(b.startsAt).getTime() < now)
      .sort((a, b) => new Date(b.startsAt).getTime() - new Date(a.startsAt).getTime())
      .map(present);

    const attended = previous.filter((b) => b.status === 'confirmed');

    return json(request, {
      ok: true,
      member: {
        name: verified?.name ?? session.name,
        email: session.email,
        memberId: session.memberId,
      },
      membership: {
        active: Boolean(verified),
        status: verified ? 'active' : (live?.status ?? cached?.status ?? 'unknown'),
        // Worth saying plainly: a member the venue added by hand is not in
        // Hapana, and somebody looking at this screen should know which.
        heldBy: cached?.source === 'manual' ? 'venue' : 'hapana',
        // Set only when the answer came from cache during a Hapana outage.
        staleSince: verified?.staleSince ?? null,
      },
      upcoming,
      previous,
      stats: {
        sessionsAttended: attended.length,
        guestsBrought: attended.reduce((sum, b) => sum + b.spotsGuest, 0),
      },
      policy: {
        cancellationCutoffHours: context.config.cancellationCutoffHours,
        guestPrice: context.config.guestPrice,
        maxGuestsPerMember: context.config.maxGuestsPerMember,
      },
    });
  } catch (error) {
    return errorResponse(request, error);
  }
};

export const config = { path: '/api/account' };
