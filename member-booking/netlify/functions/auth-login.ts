import { buildContext } from '../../src/domain/context.ts';
import { verifyMemberByEmail } from '../../src/domain/membership.ts';
import {
  MEMBER_SESSION_TTL_HOURS,
  STAFF_SESSION_TTL_HOURS,
  issueMemberSession,
  issueStaffSession,
  withinRateLimit,
} from '../../src/lib/auth.ts';
import { DUMMY_HASH, hashPassword, needsRehash, readPassword, verifyPassword } from '../../src/lib/password.ts';
import { BookingError } from '../../src/lib/errors.ts';
import {
  MEMBER_COOKIE,
  STAFF_COOKIE,
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
 * POST /api/auth/login  { email, password }
 *
 * One endpoint for members and staff. Which one you are is a property of the
 * account, not of the form you filled in, so there is nothing for the caller to
 * declare and nothing to get wrong.
 *
 * Every failure returns the same message and the same status. A caller cannot
 * learn from the response whether an address has an account, whether the
 * password was wrong, or whether a membership has lapsed. The timing is held
 * flat too: an unknown address is verified against a dummy hash so it costs the
 * same scrypt work as a real one, because a fast "no" is an answer.
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
    const ip = clientIp(request);

    if (!(await withinRateLimit(context.store, email, ip))) {
      throw new BookingError('RATE_LIMITED');
    }

    const credential = await context.store.credentials.get(email);

    // Always do the work, even with nothing to check it against.
    const stored = credential?.active ? credential.passwordHash : DUMMY_HASH;
    const passwordOk = await verifyPassword(password, stored);

    if (!credential || !credential.active || !passwordOk) {
      console.warn(`[member-booking] failed sign-in for ${email} from ${ip ?? 'unknown ip'}`);
      throw new BookingError('SIGNIN_FAILED');
    }

    // Cost parameters can be raised over time; a password proven correct at an
    // older cost is quietly rewritten at the current one.
    if (needsRehash(credential.passwordHash)) {
      await context.store.credentials.updateHash(email, await hashPassword(password));
    }

    // Staff first: an address that is a staff account is a staff account, and
    // is not also looked up in Hapana.
    const staff = await context.store.auth.getStaffByEmail(email);
    if (staff) {
      await context.store.credentials.recordLogin(email);
      console.log(`[member-booking] ${staff.email} signed in as ${staff.role}`);
      return json(
        request,
        {
          ok: true,
          kind: 'staff',
          name: staff.displayName,
          role: staff.role,
          mustChangePassword: credential.mustChange,
        },
        200,
        {
          'set-cookie': setCookie(
            STAFF_COOKIE,
            issueStaffSession({
              staffId: staff.staffId,
              email: staff.email,
              displayName: staff.displayName,
              role: staff.role,
              venueIds: staff.venueIds,
            }),
            STAFF_SESSION_TTL_HOURS * 3600,
          ),
        },
      );
    }

    // A correct password is identity, not entitlement: the membership still has
    // to be active in Hapana right now.
    const member = await verifyMemberByEmail(context, email);
    if (!member) throw new BookingError('SIGNIN_FAILED');

    await context.store.credentials.recordLogin(email);
    const ttlHours = MEMBER_SESSION_TTL_HOURS;

    return json(
      request,
      {
        ok: true,
        kind: 'member',
        name: member.name,
        mustChangePassword: credential.mustChange,
      },
      200,
      {
        'set-cookie': setCookie(
          MEMBER_COOKIE,
          issueMemberSession({ memberId: member.memberId, email: member.email, name: member.name }, ttlHours),
          ttlHours * 3600,
        ),
      },
    );
  } catch (error) {
    return errorResponse(request, error);
  }
};

export const config = { path: '/api/auth/login' };
