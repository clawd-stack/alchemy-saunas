import { buildContext } from '../../src/domain/context.ts';
import { verifyMemberByEmail } from '../../src/domain/membership.ts';
import { MEMBER_SESSION_TTL_HOURS, issueMemberSession, withinRateLimit } from '../../src/lib/auth.ts';
import { hashPassword, readPassword, validatePassword } from '../../src/lib/password.ts';
import { BookingError } from '../../src/lib/errors.ts';
import {
  MEMBER_COOKIE,
  clientIp,
  errorResponse,
  json,
  normaliseEmail,
  preflight,
  readJson,
  requireMethod,
  setCookie,
} from '../../src/lib/http.ts';

/**
 * POST /api/auth/claim  { email, password }
 *
 * A member choosing their own password, the first time they use the channel.
 *
 * Four hundred members cannot be handed a password each, and the venue does
 * not want to email them one. So a member sets their own, and what stands in
 * for the invitation is their membership: the address has to resolve to an
 * active member before anything is written.
 *
 * Three guards, and they are the whole design:
 *
 *  - **Membership is checked first**, live against Hapana with the cache as
 *    the outage fallback, exactly as signing in does. An address the venue
 *    does not know gets nothing.
 *  - **Only once.** An address that already has a password cannot be claimed,
 *    so this is a way in for somebody who has never been in, never a way to
 *    take an account off somebody who has.
 *  - **Rate limited**, on the same bucket as sign-in, so it cannot be used to
 *    walk a list of addresses.
 *
 * The trade, stated plainly because it is a real one: between a member being
 * imported and that member first signing in, somebody who knows their email
 * address could set the password instead of them. What that buys an attacker
 * is the ability to book in that member's name and see their own bookings; the
 * door still checks who turns up, and the venue can suspend the sign-in from
 * the People screen. The alternative was emailing four hundred passwords,
 * which is worse, or issuing them by hand, which does not happen.
 *
 * This endpoint also tells a caller whether an address is a member, which the
 * rest of the API is careful never to do. That is unavoidable here: a member
 * who cannot be told "you already have a password" has no way to work out what
 * to do next.
 */
export default async (request: Request): Promise<Response> => {
  const early = preflight(request);
  if (early) return early;

  try {
    requireMethod(request, 'POST');
    const body = await readJson<{ email?: unknown; password?: unknown }>(request);
    const email = normaliseEmail(body.email);
    const password = readPassword(body.password);

    const context = await buildContext();

    if (!(await withinRateLimit(context.store, email, clientIp(request)))) {
      throw new BookingError('RATE_LIMITED');
    }

    // Before the membership lookup, so a weak password does not cost a call to
    // Hapana, and so the caller is told about the password itself rather than
    // being refused for a reason they cannot see.
    const problem = validatePassword(password);
    if (problem) throw new BookingError('PASSWORD_TOO_SHORT', { field: 'password' }, problem.message);

    // Staff never come through here. Their accounts are issued by an admin,
    // and an address that is staff is not a member: the People screen keeps
    // the two exclusive, and this is the second lock on the same door.
    //
    // Refused as though the address were simply not a member, and not with the
    // sign-in refusal it used to raise. That was a different status and a
    // different message, so one anonymous request per address said which of
    // them belong to staff, which is exactly the probing the rest of the API
    // is careful to prevent.
    const staff = await context.store.auth.getStaffByEmail(email);
    if (staff) throw new BookingError('NO_ACTIVE_MEMBERSHIP');

    const held = await context.store.credentials.get(email);
    if (held) {
      throw new BookingError(
        'INVALID_REQUEST',
        { field: 'email' },
        'That address already has a password. Sign in with it, or ask the venue to reset it for you.',
      );
    }

    // The same check the booking page makes, so somebody who cannot book
    // cannot set a password either and then wonder why nothing works.
    const member = await verifyMemberByEmail(context, email);
    if (!member) throw new BookingError('NO_ACTIVE_MEMBERSHIP');

    await context.store.credentials.setPassword({
      email,
      passwordHash: await hashPassword(password),
      // They chose it themselves, so there is nothing to change.
      mustChange: false,
    });
    await context.store.credentials.recordLogin(email);

    console.log(`[member-booking] ${email} set their own password and signed in`);

    return json(
      request,
      { ok: true, kind: 'member', name: member.name, mustChangePassword: false },
      200,
      {
        'set-cookie': setCookie(
          MEMBER_COOKIE,
          issueMemberSession({ memberId: member.memberId, email: member.email, name: member.name }),
          MEMBER_SESSION_TTL_HOURS * 3600,
        ),
      },
    );
  } catch (error) {
    return errorResponse(request, error);
  }
};

export const config = { path: '/api/auth/claim' };
