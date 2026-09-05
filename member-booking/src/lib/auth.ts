import { BookingError } from './errors.ts';
import { env } from './env.ts';
import { MEMBER_COOKIE, STAFF_COOKIE, readCookie } from './http.ts';
import { hashToken, signSession, verifySession } from './crypto.ts';
import type { Store } from '../store/types.ts';

/**
 * Authentication.
 *
 * Email and password, for members and staff alike. A manager issues the
 * password from the admin screen and passes it on by whatever means suits;
 * nothing about sign-in depends on this service being able to send email,
 * which is what the magic-link design it replaces could never say.
 *
 * The password itself is never stored, only a salted scrypt hash with its cost
 * parameters attached (see password.ts). A manager-issued password is marked
 * must-change, so a password that has been read aloud or forwarded is always
 * replaced by one only its owner knows.
 *
 * Membership is still verified against Hapana on every sign-in and on every
 * booking. A credential is permission to identify yourself, never permission to
 * book: a lapsed member with a valid password gets exactly as far as a lapsed
 * member without one.
 *
 * The door list shows member and guest names and contact details, so it is
 * authenticated. The private booking URL is a distribution choice and is never
 * an access control.
 */

export const MEMBER_SESSION_TTL_HOURS = 12;
export const STAFF_SESSION_TTL_HOURS = 12;

/** Sign-in attempts per email or IP per window. */
export const LOGIN_RATE_LIMIT = 8;
export const LOGIN_RATE_WINDOW_MS = 15 * 60_000;

export interface MemberSession {
  kind: 'member';
  memberId: string;
  email: string;
  name: string;
  exp: number;
}

export interface StaffSession {
  kind: 'staff';
  staffId: string;
  email: string;
  name: string;
  role: 'door' | 'manager' | 'admin';
  venueIds: string[];
  exp: number;
}

export function issueMemberSession(
  member: { memberId: string; email: string; name: string },
  ttlHours: number = MEMBER_SESSION_TTL_HOURS,
): string {
  const payload: MemberSession = {
    kind: 'member',
    memberId: member.memberId,
    email: member.email,
    name: member.name,
    exp: Math.floor(Date.now() / 1000) + ttlHours * 3600,
  };
  return signSession(env.sessionSecret, payload as unknown as Record<string, unknown>);
}

export function issueStaffSession(staff: {
  staffId: string;
  email: string;
  displayName: string;
  role: 'door' | 'manager' | 'admin';
  venueIds: string[];
}): string {
  const payload: StaffSession = {
    kind: 'staff',
    staffId: staff.staffId,
    email: staff.email,
    name: staff.displayName,
    role: staff.role,
    venueIds: staff.venueIds,
    exp: Math.floor(Date.now() / 1000) + STAFF_SESSION_TTL_HOURS * 3600,
  };
  return signSession(env.sessionSecret, payload as unknown as Record<string, unknown>);
}

export function readMemberSession(request: Request): MemberSession | null {
  const cookie = readCookie(request, MEMBER_COOKIE);
  if (!cookie) return null;
  const payload = verifySession<MemberSession>(env.sessionSecret, cookie);
  return payload?.kind === 'member' ? payload : null;
}

export function requireMember(request: Request): MemberSession {
  const session = readMemberSession(request);
  if (!session) throw new BookingError('UNAUTHENTICATED');
  return session;
}

export function readStaffSession(request: Request): StaffSession | null {
  const cookie = readCookie(request, STAFF_COOKIE);
  if (!cookie) return null;
  const payload = verifySession<StaffSession>(env.sessionSecret, cookie);
  return payload?.kind === 'staff' ? payload : null;
}

export function requireStaff(request: Request, venueId?: string): StaffSession {
  const session = readStaffSession(request);
  if (!session) throw new BookingError('UNAUTHENTICATED');
  if (venueId && session.role !== 'admin' && !session.venueIds.includes(venueId)) {
    throw new BookingError('FORBIDDEN');
  }
  return session;
}

export function requireAdmin(request: Request): StaffSession {
  const session = requireStaff(request);
  if (session.role !== 'admin' && session.role !== 'manager') throw new BookingError('FORBIDDEN');
  return session;
}

/**
 * Rate limiting for sign-in. Both the email and the caller IP are bucketed, so
 * neither a single address nor a single source can be used to grind through
 * passwords or to enumerate the membership list. The email bucket is keyed by a
 * hash, so the rate-limit table is not itself a list of who has an account.
 */
export async function withinRateLimit(store: Store, email: string, ip: string | null): Promise<boolean> {
  const emailOk = await store.auth.throttle(
    `login:email:${hashToken(email)}`,
    LOGIN_RATE_LIMIT,
    LOGIN_RATE_WINDOW_MS,
  );
  const ipOk = ip
    ? await store.auth.throttle(`login:ip:${hashToken(ip)}`, LOGIN_RATE_LIMIT * 4, LOGIN_RATE_WINDOW_MS)
    : true;
  return emailOk && ipOk;
}
