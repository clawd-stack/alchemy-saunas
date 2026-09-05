import { buildContext } from '../../src/domain/context.ts';
import { requireStaff } from '../../src/lib/auth.ts';
import { generatePassword, hashPassword } from '../../src/lib/password.ts';
import { BookingError } from '../../src/lib/errors.ts';
import { errorResponse, json, normaliseEmail, preflight, readJson, requireMethod, requireString } from '../../src/lib/http.ts';
import type { MembershipStatus } from '../../src/store/types.ts';

/**
 * Members the venue holds itself, rather than reading from Hapana.
 *
 *   GET    /api/admin/members                                    list
 *   POST   /api/admin/members { email, firstName, lastName, withPassword? }
 *   PATCH  /api/admin/members { memberId, status }                pause or reactivate
 *   DELETE /api/admin/members { memberId }                        remove
 *
 * Hapana is the source of truth for membership and stays that way: a live
 * lookup is tried first on every sign-in, and anybody Hapana confirms is served
 * from Hapana. This list is consulted only for an address Hapana does not
 * know, or when Hapana cannot be reached at all.
 *
 * That covers two real situations. Before the API key is configured there is no
 * other way for the channel to open, and afterwards there is no other way to
 * let somebody in when Hapana is wrong about them at the door. It is not a back
 * door: every entry is admin-created, appears on the admin screen as its own
 * row, and stops working the moment it is removed.
 *
 * A manual member and a sign-in password are different things, and both are
 * needed before somebody can book. withPassword issues both in one step,
 * because doing it in two is how half a member gets created.
 */

const STATUSES = new Set<MembershipStatus>(['active', 'paused', 'suspended', 'cancelled']);

export default async (request: Request): Promise<Response> => {
  const early = preflight(request);
  if (early) return early;

  try {
    requireMethod(request, 'GET', 'POST', 'PATCH', 'DELETE');
    const context = await buildContext();
    const caller = requireStaff(request);
    if (caller.role !== 'admin') throw new BookingError('FORBIDDEN');

    if (request.method === 'GET') {
      const [members, credentials] = await Promise.all([
        context.store.members.listManual(),
        context.store.credentials.list(),
      ]);
      const withCredential = new Set(credentials.filter((c) => c.active).map((c) => c.email));

      return json(request, {
        ok: true,
        // Whether Hapana is answering at all changes what this list means, so
        // say which it is rather than leaving the admin to infer it.
        hapanaConfigured: Boolean(process.env.HAPANA_API_KEY),
        members: members.map((member) => ({
          memberId: member.memberId,
          email: member.email,
          name: [member.firstName, member.lastName].filter(Boolean).join(' ') || member.email,
          status: member.status,
          // A member with no password cannot sign in, which is invisible from
          // this list otherwise and is the most likely thing to be half-done.
          canSignIn: withCredential.has(member.email),
          addedAt: member.syncedAt,
        })),
      });
    }

    if (request.method === 'POST') {
      const body = await readJson<{
        email?: unknown;
        firstName?: unknown;
        lastName?: unknown;
        withPassword?: unknown;
      }>(request);

      const email = normaliseEmail(body.email);
      const firstName = body.firstName ? requireString(body.firstName, 'firstName', 80) : null;
      const lastName = body.lastName ? requireString(body.lastName, 'lastName', 80) : null;

      const staff = await context.store.auth.getStaffByEmail(email);
      if (staff) {
        throw new BookingError(
          'INVALID_REQUEST',
          { field: 'email' },
          `${email} is a staff account. One address cannot be both, because sign-in resolves staff first and would never reach the membership.`,
        );
      }

      const member = await context.store.members.upsertManual({
        email,
        firstName,
        lastName,
        status: 'active',
        homeVenueId: context.venueId,
      });

      // Issuing the password here as well, rather than sending the admin to
      // another screen to do the other half.
      let password: string | null = null;
      if (body.withPassword !== false && !(await context.store.credentials.get(email))) {
        password = generatePassword();
        await context.store.credentials.setPassword({
          email,
          passwordHash: await hashPassword(password),
          mustChange: true,
        });
      }

      console.log(`[member-booking] ${caller.email} added manual member ${email}`);
      return json(request, {
        ok: true,
        member: { memberId: member.memberId, email: member.email },
        password,
        message: password
          ? `${email} can now sign in and book. Send them this password: it cannot be shown again.`
          : `${email} added. They already have a password, so nothing further is needed.`,
      });
    }

    if (request.method === 'PATCH') {
      const body = await readJson<{ memberId?: unknown; status?: unknown }>(request);
      const memberId = requireString(body.memberId, 'memberId', 200);
      const status = String(body.status ?? '') as MembershipStatus;
      if (!STATUSES.has(status)) throw new BookingError('INVALID_REQUEST', { field: 'status' });

      const existing = await context.store.members.get(memberId);
      if (!existing || existing.source !== 'manual') throw new BookingError('NOT_FOUND');

      await context.store.members.upsertManual({
        email: existing.email,
        firstName: existing.firstName,
        lastName: existing.lastName,
        status,
        homeVenueId: existing.homeVenueId,
      });

      console.log(`[member-booking] ${caller.email} set manual member ${existing.email} to ${status}`);
      return json(request, {
        ok: true,
        message:
          status === 'active'
            ? `${existing.email} can book again.`
            : `${existing.email} is ${status} and can no longer book. Any booking already made stands.`,
      });
    }

    const body = await readJson<{ memberId?: unknown }>(request);
    const memberId = requireString(body.memberId, 'memberId', 200);

    const existing = await context.store.members.get(memberId);
    if (!existing || existing.source !== 'manual') throw new BookingError('NOT_FOUND');
    await context.store.members.removeManual(memberId);

    console.log(`[member-booking] ${caller.email} removed manual member ${existing.email}`);
    return json(request, {
      ok: true,
      // The credential is left alone on purpose. Removing the membership is
      // what stops them booking; deleting the sign-in as well would be a second
      // destructive act the admin did not ask for, and it is one click away on
      // the accounts list if they want it.
      message: `${existing.email} removed from the member list and can no longer book. Their sign-in still exists; delete it under Sign-in accounts if you want it gone too.`,
    });
  } catch (error) {
    return errorResponse(request, error);
  }
};

export const config = { path: '/api/admin/members' };
