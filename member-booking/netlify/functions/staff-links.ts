import { buildContext } from '../../src/domain/context.ts';
import { verifyMemberByEmail } from '../../src/domain/membership.ts';
import { createMagicLink, magicLinkUrl, requireStaff } from '../../src/lib/auth.ts';
import { generateToken, hashToken } from '../../src/lib/crypto.ts';
import { BookingError } from '../../src/lib/errors.ts';
import { clientIp, errorResponse, json, normaliseEmail, preflight, readJson, requireMethod, requireString } from '../../src/lib/http.ts';
import { waiverUrl } from '../../src/domain/waivers.ts';

/**
 * Staff-issued links, for running the channel without email delivery.
 *
 * Every link this build sends is normally emailed. Where no email provider is
 * configured, or a member never received theirs, that leaves a member unable to
 * sign in and a guest unable to sign a waiver. Both are solvable at the venue,
 * because the person is standing in front of a staff member who is already
 * authenticated and can see the booking.
 *
 * This is deliberately not a password system. A password needs a delivery
 * channel and a reset channel, which are exactly what is missing, and it would
 * put credential storage and breach handling into a pilot that does not need
 * them. A link handed over in person by a staff member who can see the member
 * is a stronger check than a password typed into a form, not a weaker one.
 *
 *   POST /api/staff/links { action: "member-signin", email }
 *   POST /api/staff/links { action: "guest-waiver", bookingId, guestId }
 *
 * Staff-authenticated. Membership is still verified against Hapana, so staff
 * cannot conjure access for someone whose membership is not active.
 */
export default async (request: Request): Promise<Response> => {
  const early = preflight(request);
  if (early) return early;

  try {
    requireMethod(request, 'POST');
    const context = await buildContext();
    const staff = requireStaff(request, context.venueId);
    const body = await readJson<{ action?: unknown; email?: unknown; bookingId?: unknown; guestId?: unknown }>(request);

    if (body.action === 'member-signin') {
      const email = normaliseEmail(body.email);

      // The same membership check the member-facing path uses. Staff issuing
      // the link does not bypass it: a paused or cancelled membership gets
      // nothing, and the message says nothing about why.
      const member = await verifyMemberByEmail(context, email);
      if (!member) throw new BookingError('NO_ACTIVE_MEMBERSHIP');

      const token = await createMagicLink(context.store, {
        email,
        memberId: member.memberId,
        ip: clientIp(request),
      });

      console.log(`[member-booking] staff ${staff.email} issued a sign-in link for member ${member.memberId}`);

      return json(request, {
        ok: true,
        memberName: member.name,
        url: magicLinkUrl(token, 'booking'),
        // Once opened, the session lasts this long, so a member handed a link
        // at the venue can go on booking from home without another one.
        sessionDays: context.config.memberSessionDays,
        message: `Have ${member.name} open this on their own phone. It works once, and signs them in for ${context.config.memberSessionDays} days.`,
      });
    }

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
