import { buildContext } from '../../src/domain/context.ts';
import { verifyMemberByEmail } from '../../src/domain/membership.ts';
import { requireStaff } from '../../src/lib/auth.ts';
import { generatePassword, hashPassword, readPassword, validatePassword } from '../../src/lib/password.ts';
import { BookingError } from '../../src/lib/errors.ts';
import { errorResponse, json, normaliseEmail, preflight, readJson, requireMethod, requireString } from '../../src/lib/http.ts';

/**
 * Sign-in accounts.
 *
 *   GET    /api/admin/credentials                        list
 *   POST   /api/admin/credentials { email, password? }   issue or reset
 *   PATCH  /api/admin/credentials { email, active }      suspend or restore
 *   DELETE /api/admin/credentials { email }              remove entirely
 *
 * This is the whole account-management story now that sign-in is a password.
 * A manager issues one here and passes it on however they like; the service
 * never needs to be able to send email for anybody to get in.
 *
 * The generated password is returned exactly once, in the response to the call
 * that creates it. It is stored only as a scrypt hash, so there is no second
 * chance to read it and no way for this endpoint to show an existing one. That
 * is the point: a password this screen could display is a password a database
 * dump could display. Lost passwords are reset, never recovered.
 *
 * Admin only. Issuing a credential for an address is the power to sign in as
 * that person, so it sits with the same role that manages staff accounts, not
 * with managers.
 */
export default async (request: Request): Promise<Response> => {
  const early = preflight(request);
  if (early) return early;

  try {
    requireMethod(request, 'GET', 'POST', 'PATCH', 'DELETE');
    const context = await buildContext();
    const caller = requireStaff(request);
    if (caller.role !== 'admin') throw new BookingError('FORBIDDEN');

    if (request.method === 'GET') {
      const [credentials, staff] = await Promise.all([
        context.store.credentials.list(),
        context.store.auth.listStaff(),
      ]);
      const staffByEmail = new Map(staff.map((s) => [s.email.toLowerCase(), s]));

      return json(request, {
        ok: true,
        // Never the hash. Nothing downstream needs it, and a list endpoint that
        // returns password material is one screenshot away from a problem.
        accounts: credentials.map((credential) => {
          const match = staffByEmail.get(credential.email);
          return {
            email: credential.email,
            kind: match ? 'staff' : 'member',
            role: match?.role ?? null,
            mustChange: credential.mustChange,
            active: credential.active,
            lastLoginAt: credential.lastLoginAt,
            createdAt: credential.createdAt,
          };
        }),
      });
    }

    if (request.method === 'POST') {
      const body = await readJson<{ email?: unknown; password?: unknown }>(request);
      const email = normaliseEmail(body.email);

      // Either pick one, or get a strong one generated. Generated is the path
      // worth taking: a password chosen by whoever is at the keyboard tends to
      // be a password they have used before.
      const supplied = readPassword(body.password);
      const generated = supplied ? null : generatePassword();
      const password = supplied || readPassword(generated ?? '');

      if (supplied) {
        const problem = validatePassword(supplied);
        if (problem) throw new BookingError('PASSWORD_TOO_SHORT', { field: 'password' }, problem.message);
      }

      const existed = Boolean(await context.store.credentials.get(email));
      await context.store.credentials.setPassword({
        email,
        passwordHash: await hashPassword(password),
        // Always: this password has just passed through somebody who is not its
        // owner, whoever chose it.
        mustChange: true,
      });

      // Say plainly whether this address will actually be able to get in. The
      // sign-in endpoint refuses identically for every reason, by design, which
      // makes an admin screen that stays silent about a mismatch a trap: a
      // typo'd address would issue a perfectly valid password for nobody.
      const staff = await context.store.auth.getStaffByEmail(email);
      let resolvesTo: string;
      if (staff) {
        resolvesTo = `${staff.displayName}, ${staff.role}`;
      } else {
        const member = await verifyMemberByEmail(context, email).catch(() => null);
        resolvesTo = member
          ? `${member.name}, member`
          : 'nobody yet: this address is not a staff account and has no active Alchemy membership, so sign-in will refuse until that changes';
      }

      console.log(`[member-booking] ${caller.email} ${existed ? 'reset' : 'issued'} a password for ${email}`);

      return json(request, {
        ok: true,
        email,
        // Shown once, then gone. There is no endpoint that can return it again.
        password: generated ?? null,
        resolvesTo,
        message: generated
          ? `${existed ? 'Reset' : 'Created'}. Send ${email} this password, then close this. It cannot be shown again.`
          : `${existed ? 'Reset' : 'Created'} with the password you supplied.`,
      });
    }

    if (request.method === 'PATCH') {
      const body = await readJson<{ email?: unknown; active?: unknown }>(request);
      const email = normaliseEmail(body.email);
      const active = body.active === true;

      guardSelf(email, caller.email, active ? null : 'You cannot suspend your own sign-in.');

      const saved = await context.store.credentials.setActive(email, active);
      if (!saved) throw new BookingError('NOT_FOUND');

      console.log(`[member-booking] ${caller.email} ${active ? 'restored' : 'suspended'} sign-in for ${email}`);
      return json(request, {
        ok: true,
        message: active
          ? `${email} can sign in again.`
          : `${email} can no longer sign in. A session already open ends within 12 hours.`,
      });
    }

    const body = await readJson<{ email?: unknown }>(request);
    const email = normaliseEmail(requireString(body.email, 'email', 320));
    guardSelf(email, caller.email, 'You cannot delete your own sign-in.');

    if (!(await context.store.credentials.remove(email))) throw new BookingError('NOT_FOUND');

    console.log(`[member-booking] ${caller.email} deleted the sign-in for ${email}`);
    return json(request, { ok: true, message: `Sign-in for ${email} deleted.` });
  } catch (error) {
    return errorResponse(request, error);
  }
};

/**
 * Locking yourself out is one click away and has no undo short of a migration,
 * so it is refused rather than confirmed.
 */
function guardSelf(email: string, callerEmail: string, message: string | null): void {
  if (message && email === callerEmail.toLowerCase()) {
    throw new BookingError('INVALID_REQUEST', { field: 'email' }, message);
  }
}

export const config = { path: '/api/admin/credentials' };
