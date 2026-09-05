import { buildContext } from '../../src/domain/context.ts';
import { requireStaff } from '../../src/lib/auth.ts';
import { BookingError } from '../../src/lib/errors.ts';
import { errorResponse, json, normaliseEmail, preflight, readJson, requireMethod, requireString } from '../../src/lib/http.ts';
import type { StaffRecord } from '../../src/store/types.ts';

/**
 * Staff accounts.
 *
 *   GET    /api/admin/staff                       list
 *   POST   /api/admin/staff  { email, name, role, venueIds }   add or update
 *   PATCH  /api/admin/staff  { staffId, active }               deactivate or restore
 *
 * The seeded accounts are placeholders, and until now changing them meant a
 * database migration and a deploy. Door staff turn over faster than that, and
 * an account that cannot be revoked in the moment it needs revoking is worse
 * than the inconvenience of adding one. The door list carries member names,
 * phone numbers and guest details, so who holds an account is an access
 * control decision, and it belongs to whoever is running the venue rather than
 * to whoever can push code.
 *
 * Admin only, not manager: a manager who could edit staff could make
 * themselves an admin, which would make the distinction between the two roles
 * decorative.
 */

const ROLES = new Set(['door', 'manager', 'admin']);

export default async (request: Request): Promise<Response> => {
  const early = preflight(request);
  if (early) return early;

  try {
    requireMethod(request, 'GET', 'POST', 'PATCH');
    const context = await buildContext();
    const caller = requireStaff(request);
    if (caller.role !== 'admin') throw new BookingError('FORBIDDEN');

    if (request.method === 'GET') {
      return json(request, { ok: true, staff: (await context.store.auth.listStaff()).map(present) });
    }

    if (request.method === 'POST') {
      const body = await readJson<{ email?: unknown; name?: unknown; role?: unknown; venueIds?: unknown }>(request);
      const email = normaliseEmail(body.email);
      const displayName = requireString(body.name, 'name', 120);
      const role = String(body.role ?? 'door');
      if (!ROLES.has(role)) throw new BookingError('INVALID_REQUEST', { field: 'role' });

      // Door and manager accounts are scoped to venues; an admin is not, and
      // requireStaff skips the venue check for them. Default to this venue so
      // the common case needs no thought at the point of adding somebody.
      const venueIds = Array.isArray(body.venueIds)
        ? body.venueIds.filter((v): v is string => typeof v === 'string' && v.length > 0 && v.length <= 64).slice(0, 10)
        : [];

      // Demoting yourself out of admin is the same lockout as deactivating
      // yourself, one step removed, so it gets the same guard. Checked before
      // the write, so a refusal leaves nothing to undo.
      if (email.toLowerCase() === caller.email.toLowerCase() && role !== 'admin') {
        throw new BookingError(
          'INVALID_REQUEST',
          { field: 'role' },
          'You cannot remove your own admin role. Ask another admin to do it.',
        );
      }

      const saved = await context.store.auth.upsertStaff({
        email,
        displayName,
        role: role as StaffRecord['role'],
        venueIds: venueIds.length > 0 ? venueIds : [context.venueId],
      });

      console.log(`[member-booking] ${caller.email} saved staff account ${saved.email} as ${saved.role}`);
      return json(request, {
        ok: true,
        staff: present(saved),
        message: `${saved.displayName} can now sign in as ${roleLabel(saved.role)}.`,
      });
    }

    const body = await readJson<{ staffId?: unknown; active?: unknown }>(request);
    const staffId = requireString(body.staffId, 'staffId', 64);
    const active = body.active === true;

    const all = await context.store.auth.listStaff();
    const target = all.find((s) => s.staffId === staffId);
    if (!target) throw new BookingError('NOT_FOUND');

    if (!active) {
      // Two ways to lock everybody out, both of them one click away, so both
      // are refused rather than warned about.
      if (target.email.toLowerCase() === caller.email.toLowerCase()) {
        throw new BookingError('INVALID_REQUEST', { field: 'staffId' }, 'You cannot deactivate your own account.');
      }
      const remainingAdmins = all.filter((s) => s.active && s.role === 'admin' && s.staffId !== staffId);
      if (target.role === 'admin' && remainingAdmins.length === 0) {
        throw new BookingError(
          'INVALID_REQUEST',
          { field: 'staffId' },
          'That is the last active admin account. Add another admin before deactivating this one.',
        );
      }
    }

    const saved = await context.store.auth.setStaffActive(staffId, active);
    if (!saved) throw new BookingError('NOT_FOUND');

    console.log(`[member-booking] ${caller.email} ${active ? 'restored' : 'deactivated'} staff account ${saved.email}`);
    return json(request, {
      ok: true,
      staff: present(saved),
      message: active
        ? `${saved.displayName} can sign in again.`
        : `${saved.displayName} can no longer sign in. Any session they already hold expires within 12 hours.`,
    });
  } catch (error) {
    return errorResponse(request, error);
  }
};

/** Nothing here is secret, but keep the shape the UI relies on explicit. */
function present(staff: StaffRecord) {
  return {
    staffId: staff.staffId,
    email: staff.email,
    name: staff.displayName,
    role: staff.role,
    venueIds: staff.venueIds,
    active: staff.active,
  };
}

function roleLabel(role: string): string {
  if (role === 'admin') return 'an admin, with configuration access';
  if (role === 'manager') return 'a manager, with the door list and reconciliation';
  return 'door staff, with the door list';
}

export const config = { path: '/api/admin/staff' };
