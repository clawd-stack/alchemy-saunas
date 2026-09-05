import { buildContext } from '../../src/domain/context.ts';
import { readMemberSession, readStaffSession, withinRateLimit } from '../../src/lib/auth.ts';
import { hashPassword, readPassword, validatePassword, verifyPassword } from '../../src/lib/password.ts';
import { BookingError } from '../../src/lib/errors.ts';
import { clientIp, errorResponse, json, preflight, readJson, requireMethod } from '../../src/lib/http.ts';

/**
 * POST /api/auth/password  { currentPassword, newPassword }
 *
 * Changing your own password. Anyone signed in, member or staff, and only ever
 * their own: the address comes from the session cookie, never from the request
 * body, so this endpoint cannot be pointed at somebody else's account.
 *
 * The current password is required even though the session already proves who
 * you are. A session cookie can be a borrowed unlocked phone; knowing the
 * current password is the part that says it is really you.
 *
 * This is how a manager-issued password stops being one. Every issued password
 * has passed through a third party by definition, so must_change stays set
 * until the owner replaces it here.
 */
export default async (request: Request): Promise<Response> => {
  const early = preflight(request);
  if (early) return early;

  try {
    requireMethod(request, 'POST');
    const context = await buildContext();

    const member = readMemberSession(request);
    const staff = readStaffSession(request);
    const email = (staff?.email ?? member?.email ?? '').toLowerCase();
    if (!email) throw new BookingError('UNAUTHENTICATED');

    // The same brake as sign-in: this endpoint also verifies a password.
    if (!(await withinRateLimit(context.store, email, clientIp(request)))) {
      throw new BookingError('RATE_LIMITED');
    }

    const body = await readJson<{ currentPassword?: unknown; newPassword?: unknown }>(request);
    const currentPassword = readPassword(body.currentPassword);
    const newPassword = readPassword(body.newPassword);

    const problem = validatePassword(newPassword);
    if (problem) throw new BookingError('PASSWORD_TOO_SHORT', { field: 'newPassword' }, problem.message);

    const credential = await context.store.credentials.get(email);
    if (!credential || !credential.active) throw new BookingError('UNAUTHENTICATED');

    if (!(await verifyPassword(currentPassword, credential.passwordHash))) {
      throw new BookingError('SIGNIN_FAILED', { field: 'currentPassword' }, 'That current password did not match.');
    }

    if (currentPassword === newPassword) {
      throw new BookingError(
        'INVALID_REQUEST',
        { field: 'newPassword' },
        'Please choose a password different from the current one.',
      );
    }

    await context.store.credentials.setPassword({
      email,
      passwordHash: await hashPassword(newPassword),
      mustChange: false,
    });

    console.log(`[member-booking] ${email} changed their own password`);
    return json(request, { ok: true, message: 'Password changed. Use the new one from now on.' });
  } catch (error) {
    return errorResponse(request, error);
  }
};

export const config = { path: '/api/auth/password' };
