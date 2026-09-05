import { buildContext } from '../../src/domain/context.ts';
import { requireStaff } from '../../src/lib/auth.ts';
import { generatePassword, hashPassword, readPassword, validatePassword } from '../../src/lib/password.ts';
import { BookingError } from '../../src/lib/errors.ts';
import { errorResponse, json, normaliseEmail, preflight, readJson, requireMethod, requireString } from '../../src/lib/http.ts';
import type { MemberRecord, MembershipStatus, StaffRecord } from '../../src/store/types.ts';

/**
 * Everybody the channel knows, in one list.
 *
 *   GET    /api/admin/people                              one list
 *   POST   /api/admin/people { action: 'add', ... }       add, with a password
 *   POST   /api/admin/people { action: 'reset', email }   new password
 *   PATCH  /api/admin/people { email, role|signIn }       change role, suspend
 *   DELETE /api/admin/people { email }                    remove
 *
 * This replaces three screens that were three tables underneath: manual
 * members, staff accounts, and sign-in credentials. Keeping them apart made
 * the admin do the joining, and the join was where things went wrong: a member
 * with no password, a password for an address that resolves to nobody, a staff
 * account somebody also tried to add as a member.
 *
 * A person has one role. That is not a simplification imposed on the data, it
 * is what the data already required: sign-in resolves staff before membership,
 * so an address that is both would never reach its membership, and adding one
 * as the other was already refused. Saying it once, here, makes it a rule
 * rather than a trap.
 *
 * Admin only. Issuing a credential for an address is the power to sign in as
 * that person, and setting a role is the power to grant yourself anything.
 */

const STAFF_ROLES = new Set(['door', 'manager', 'admin']);
const ROLES = new Set(['member', 'door', 'manager', 'admin']);
const STATUSES = new Set<MembershipStatus>(['active', 'paused', 'suspended', 'cancelled']);

type Role = 'member' | 'door' | 'manager' | 'admin';

export default async (request: Request): Promise<Response> => {
  const early = preflight(request);
  if (early) return early;

  try {
    requireMethod(request, 'GET', 'POST', 'PATCH', 'DELETE');
    const context = await buildContext();
    const caller = requireStaff(request);
    if (caller.role !== 'admin') throw new BookingError('FORBIDDEN');

    const load = async () => {
      const [staff, members, credentials] = await Promise.all([
        context.store.auth.listStaff(),
        context.store.members.listManual(),
        context.store.credentials.list(),
      ]);
      return { staff, members, credentials };
    };

    if (request.method === 'GET') {
      const { staff, members, credentials } = await load();
      return json(request, {
        ok: true,
        // Whether Hapana answers at all changes what this list means: with no
        // key it is the entire membership, not a supplement to it.
        hapanaConfigured: Boolean(process.env.HAPANA_API_KEY),
        people: merge(staff, members, credentials),
      });
    }

    if (request.method === 'POST') {
      const body = await readJson<{ action?: unknown; email?: unknown; name?: unknown; role?: unknown; password?: unknown }>(request);
      const action = String(body.action ?? 'add');
      const email = normaliseEmail(body.email);

      if (action === 'reset') {
        const { staff, members, credentials } = await load();
        const person = merge(staff, members, credentials).find((p) => p.email === email);
        if (!person) throw new BookingError('NOT_FOUND');

        const password = generatePassword();
        await context.store.credentials.setPassword({
          email,
          passwordHash: await hashPassword(password),
          // Always: this password has just passed through somebody who is not
          // its owner, whoever chose it.
          mustChange: true,
        });

        console.log(`[member-booking] ${caller.email} reset the password for ${email}`);
        return json(request, {
          ok: true,
          email,
          // Shown once. It is stored as a scrypt hash, so nothing can return
          // it again, and a screen that could show it is a screen a database
          // dump could show.
          password,
          message: `New password for ${email}. Send it to them, then close this: it cannot be shown again.`,
        });
      }

      if (action !== 'add') throw new BookingError('INVALID_REQUEST', { field: 'action' });

      const name = requireString(body.name, 'name', 120);
      const role = String(body.role ?? 'member') as Role;
      if (!ROLES.has(role)) throw new BookingError('INVALID_REQUEST', { field: 'role' });

      const supplied = readPassword(body.password);
      if (supplied) {
        const problem = validatePassword(supplied);
        if (problem) throw new BookingError('PASSWORD_TOO_SHORT', { field: 'password' }, problem.message);
      }

      // Adding somebody who is already here is a role change, not a second
      // person, so the same guards apply as changing the role outright.
      const { staff, members, credentials } = await load();
      const existing = merge(staff, members, credentials).find((p) => p.email === email);
      if (existing) guardLastAdmin(merge(staff, members, credentials), existing, role, caller.email);

      await place(context, email, name, role);

      // Never over an existing password. Silently replacing one somebody is
      // already using locks them out, and "Add" is the one button most likely
      // to be pressed twice. Use New password to deliberately replace one.
      const held = await context.store.credentials.get(email);
      const password = held ? null : supplied || generatePassword();
      if (password) {
        await context.store.credentials.setPassword({
          email,
          passwordHash: await hashPassword(password),
          mustChange: true,
        });
      }

      console.log(`[member-booking] ${caller.email} added ${email} as ${role}`);
      return json(request, {
        ok: true,
        email,
        password: supplied || !password ? null : password,
        message: held
          ? `${email} is now ${label(role)}. They already had a password, so it is unchanged.`
          : supplied
            ? `${email} added as ${label(role)}, with the password you supplied.`
            : `${email} added as ${label(role)}. Send them this password, then close this: it cannot be shown again.`,
      });
    }

    if (request.method === 'PATCH') {
      const body = await readJson<{ email?: unknown; role?: unknown; signIn?: unknown; status?: unknown }>(request);
      const email = normaliseEmail(body.email);
      const { staff, members, credentials } = await load();
      const all = merge(staff, members, credentials);
      const person = all.find((p) => p.email === email);
      if (!person) throw new BookingError('NOT_FOUND');

      if (body.role !== undefined) {
        const role = String(body.role) as Role;
        if (!ROLES.has(role)) throw new BookingError('INVALID_REQUEST', { field: 'role' });
        guardLastAdmin(all, person, role, caller.email);
        await place(context, email, person.name, role);

        console.log(`[member-booking] ${caller.email} set ${email} to ${role}`);
        return json(request, { ok: true, message: `${email} is now ${label(role)}.` });
      }

      if (body.signIn !== undefined) {
        const active = body.signIn === true;
        if (!active && email === caller.email.toLowerCase()) {
          throw new BookingError('INVALID_REQUEST', { field: 'email' }, 'You cannot suspend your own sign-in.');
        }
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

      if (body.status !== undefined) {
        const status = String(body.status) as MembershipStatus;
        if (!STATUSES.has(status)) throw new BookingError('INVALID_REQUEST', { field: 'status' });
        if (person.role !== 'member' || !person.memberId) {
          throw new BookingError('INVALID_REQUEST', { field: 'status' }, 'Only a member has a membership status.');
        }
        const existing = await context.store.members.get(person.memberId);
        if (!existing) throw new BookingError('NOT_FOUND');
        await context.store.members.upsertManual({
          email: existing.email,
          firstName: existing.firstName,
          lastName: existing.lastName,
          status,
          homeVenueId: existing.homeVenueId,
        });

        console.log(`[member-booking] ${caller.email} set ${email} to ${status}`);
        return json(request, {
          ok: true,
          message: status === 'active'
            ? `${email} can book again.`
            : `${email} is ${status} and can no longer book. Any booking already made stands.`,
        });
      }

      throw new BookingError('INVALID_REQUEST', { field: 'role' });
    }

    const body = await readJson<{ email?: unknown }>(request);
    const email = normaliseEmail(requireString(body.email, 'email', 320));
    const { staff, members, credentials } = await load();
    const all = merge(staff, members, credentials);
    const person = all.find((p) => p.email === email);
    if (!person) throw new BookingError('NOT_FOUND');

    if (email === caller.email.toLowerCase()) {
      throw new BookingError('INVALID_REQUEST', { field: 'email' }, 'You cannot remove your own account.');
    }
    guardLastAdmin(all, person, 'member', caller.email);

    // Everything, not the half that happens to be in front of you. The old
    // screens removed a membership and left the sign-in standing, which read
    // as "removed" and was not.
    if (person.memberId) await context.store.members.removeManual(person.memberId);
    if (person.staffId) await context.store.auth.setStaffActive(person.staffId, false);
    await context.store.credentials.remove(email);

    console.log(`[member-booking] ${caller.email} removed ${email}`);
    return json(request, { ok: true, message: `${email} removed. They can no longer sign in or book.` });
  } catch (error) {
    return errorResponse(request, error);
  }
};

/**
 * One row per address.
 *
 * An active staff account wins over a membership because that is the order
 * sign-in resolves them in; a deactivated one only shows through when there is
 * no membership to show instead, so a person moved from staff to member reads
 * as a member rather than as a switched-off manager.
 */
function merge(staff: StaffRecord[], members: MemberRecord[], credentials: { email: string; active: boolean; mustChange: boolean; lastLoginAt: string | null }[]) {
  const byEmail = new Map<string, { staff?: StaffRecord; member?: MemberRecord }>();
  for (const s of staff) {
    const key = s.email.toLowerCase();
    byEmail.set(key, { ...(byEmail.get(key) ?? {}), staff: s });
  }
  for (const m of members) {
    const key = m.email.toLowerCase();
    byEmail.set(key, { ...(byEmail.get(key) ?? {}), member: m });
  }

  const credential = new Map(credentials.map((c) => [c.email.toLowerCase(), c]));

  return [...byEmail.entries()]
    .map(([email, { staff: s, member: m }]) => {
      let role: Role;
      let active: boolean;
      if (s?.active) {
        role = s.role;
        active = true;
      } else if (m) {
        role = 'member';
        active = m.status === 'active';
      } else {
        role = (s as StaffRecord).role;
        active = false;
      }

      const c = credential.get(email);
      return {
        email,
        name: s?.displayName ?? [m?.firstName, m?.lastName].filter(Boolean).join(' ') ?? '',
        role,
        active,
        status: role === 'member' ? (m?.status ?? null) : null,
        signIn: !c ? 'none' : !c.active ? 'suspended' : c.mustChange ? 'issued' : 'active',
        lastLoginAt: c?.lastLoginAt ?? null,
        memberId: m?.memberId ?? null,
        staffId: s?.staffId ?? null,
      };
    })
    .map((p) => ({ ...p, name: p.name || p.email }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Puts an address on the right side of the staff/member line, and only one. */
async function place(
  context: Awaited<ReturnType<typeof buildContext>>,
  email: string,
  name: string,
  role: Role,
): Promise<void> {
  if (STAFF_ROLES.has(role)) {
    const member = (await context.store.members.listManual()).find((m) => m.email.toLowerCase() === email);
    if (member) await context.store.members.removeManual(member.memberId);
    await context.store.auth.upsertStaff({
      email,
      displayName: name,
      role: role as StaffRecord['role'],
      venueIds: [context.venueId],
    });
    return;
  }

  const staff = await context.store.auth.getStaffByEmail(email);
  // Deactivated rather than deleted, so an audit trail naming them still
  // resolves to a person.
  if (staff) await context.store.auth.setStaffActive(staff.staffId, false);

  const [firstName, ...rest] = name.trim().split(/\s+/);
  await context.store.members.upsertManual({
    email,
    firstName: firstName || null,
    lastName: rest.join(' ') || null,
    status: 'active',
    homeVenueId: context.venueId,
  });
}

/**
 * Two ways to lock everybody out, both one click away: taking your own admin
 * off, and taking off the last one there is. Both are refused rather than
 * confirmed, because neither has an undo short of a migration.
 */
function guardLastAdmin(
  all: ReturnType<typeof merge>,
  person: ReturnType<typeof merge>[number],
  nextRole: Role,
  callerEmail: string,
): void {
  if (nextRole === 'admin' || person.role !== 'admin') return;

  if (person.email === callerEmail.toLowerCase()) {
    throw new BookingError(
      'INVALID_REQUEST',
      { field: 'role' },
      'You cannot remove your own admin role. Ask another admin to do it.',
    );
  }
  const others = all.filter((p) => p.role === 'admin' && p.active && p.email !== person.email);
  if (others.length === 0) {
    throw new BookingError(
      'INVALID_REQUEST',
      { field: 'role' },
      'That is the last active admin. Give somebody else admin before changing this one.',
    );
  }
}

function label(role: Role): string {
  if (role === 'admin') return 'an admin, with full configuration access';
  if (role === 'manager') return 'a manager, with the door list and reconciliation';
  if (role === 'door') return 'door staff, with the door list';
  return 'a member, who can book sessions';
}

export const config = { path: '/api/admin/people' };
