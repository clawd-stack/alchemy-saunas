import { buildContext } from '../../src/domain/context.ts';
import { issueStaffSession, STAFF_SESSION_TTL_HOURS } from '../../src/lib/auth.ts';
import { constantTimeEquals, hashToken } from '../../src/lib/crypto.ts';
import { env } from '../../src/lib/env.ts';
import { BookingError } from '../../src/lib/errors.ts';
import { STAFF_COOKIE, clientIp, errorResponse, json, preflight, readJson, requireMethod, setCookie } from '../../src/lib/http.ts';

/**
 * POST /api/admin/bootstrap  { token }
 *
 * The one way into the admin screen that does not need email.
 *
 * Everything else, member and staff alike, is reached through a link that is
 * emailed. That is the right shape once email works, and a deadlock before it
 * does: configuring the email provider requires the admin screen, reaching the
 * admin screen requires a link, and sending the link requires the email
 * provider. The staff-issued links endpoint does not break the deadlock either,
 * because it is itself staff-authenticated. Somebody has to get in first.
 *
 * This is deliberately the narrowest thing that does that:
 *
 *   - It exists only while ADMIN_BOOTSTRAP_TOKEN is set. Unset, which is the
 *     normal state, it refuses without looking at the request at all.
 *   - It signs in as an existing admin account. It cannot create one, promote
 *     one, or reach any account that is not already an active admin.
 *   - It is rate limited by IP, and the token is compared in constant time
 *     against its hash, so the endpoint is not a guessing oracle.
 *   - Every attempt, successful or not, is logged.
 *
 * Once the email check on the admin screen passes, delete the environment
 * variable. Sign-in links then work, and this endpoint returns to refusing
 * everything.
 */

/** Short enough to type, long enough that guessing is not a strategy. */
const MINIMUM_TOKEN_LENGTH = 32;
const ATTEMPT_LIMIT = 5;
const ATTEMPT_WINDOW_MS = 15 * 60_000;

export default async (request: Request): Promise<Response> => {
  const early = preflight(request);
  if (early) return early;

  try {
    requireMethod(request, 'POST');

    const expected = env.adminBootstrapToken;
    if (!expected) {
      // The deployment has no break-glass credential. Say so plainly rather
      // than pretending: this is a setup endpoint, and an operator who has
      // just set the variable needs to be able to tell the difference between
      // "not configured" and "wrong token".
      return json(
        request,
        {
          ok: false,
          code: 'BOOTSTRAP_DISABLED',
          message: 'Break-glass sign-in is not enabled on this deployment. Sign in with an emailed link instead.',
        },
        404,
      );
    }
    if (expected.length < MINIMUM_TOKEN_LENGTH) {
      return json(
        request,
        {
          ok: false,
          code: 'BOOTSTRAP_TOKEN_TOO_SHORT',
          message: `ADMIN_BOOTSTRAP_TOKEN is set but shorter than ${MINIMUM_TOKEN_LENGTH} characters, so it is refused. Replace it with a random value of at least that length.`,
        },
        500,
      );
    }

    const context = await buildContext();
    const ip = clientIp(request);

    // Bucketed on IP alone: there is one credential, so there is no address to
    // bucket on and no membership list to enumerate. This is purely a brake on
    // guessing.
    const withinLimit = await context.store.auth.throttle(
      `bootstrap:ip:${hashToken(ip ?? 'unknown')}`,
      ATTEMPT_LIMIT,
      ATTEMPT_WINDOW_MS,
    );
    if (!withinLimit) throw new BookingError('RATE_LIMITED');

    const body = await readJson<{ token?: unknown }>(request);
    const supplied = typeof body.token === 'string' ? body.token.trim() : '';

    // Compare the hashes, not the tokens: equal-length inputs, so a length
    // mismatch cannot be read off the response time either.
    if (!supplied || !constantTimeEquals(hashToken(supplied), hashToken(expected))) {
      console.warn(`[member-booking] rejected bootstrap attempt from ${ip ?? 'unknown ip'}`);
      throw new BookingError('UNAUTHENTICATED');
    }

    const staff = await resolveAdmin(context.store);
    if (!staff) {
      return json(
        request,
        {
          ok: false,
          code: 'NO_BOOTSTRAP_ADMIN',
          message: env.adminBootstrapEmail
            ? `The token is valid, but ${env.adminBootstrapEmail} is not an active admin account. Check ADMIN_BOOTSTRAP_EMAIL.`
            : 'The token is valid, but this deployment does not have exactly one active admin account. Set ADMIN_BOOTSTRAP_EMAIL to the one to sign in as.',
        },
        409,
      );
    }

    console.log(`[member-booking] break-glass sign-in as ${staff.email} from ${ip ?? 'unknown ip'}`);

    const cookie = setCookie(
      STAFF_COOKIE,
      issueStaffSession({
        staffId: staff.staffId,
        email: staff.email,
        displayName: staff.displayName,
        role: staff.role,
        venueIds: staff.venueIds,
      }),
      STAFF_SESSION_TTL_HOURS * 3600,
    );

    return json(
      request,
      {
        ok: true,
        email: staff.email,
        name: staff.displayName,
        hoursValid: STAFF_SESSION_TTL_HOURS,
        message: `Signed in as ${staff.displayName}. This session lasts ${STAFF_SESSION_TTL_HOURS} hours. Once the email check passes, delete ADMIN_BOOTSTRAP_TOKEN.`,
      },
      200,
      { 'set-cookie': cookie },
    );
  } catch (error) {
    return errorResponse(request, error);
  }
};

/**
 * The account to sign in as. Named explicitly, or inferred only when there is
 * no ambiguity to resolve. Never a non-admin, and never a deactivated one.
 */
async function resolveAdmin(store: Awaited<ReturnType<typeof buildContext>>['store']) {
  const named = env.adminBootstrapEmail.trim().toLowerCase();
  if (named) {
    const record = await store.auth.getStaffByEmail(named);
    return record && record.active && record.role === 'admin' ? record : null;
  }
  const admins = (await store.auth.listStaff()).filter((s) => s.active && s.role === 'admin');
  return admins.length === 1 ? admins[0] : null;
}

export const config = { path: '/api/admin/bootstrap' };
