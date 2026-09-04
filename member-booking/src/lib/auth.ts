import { BookingError } from './errors.ts';
import { env } from './env.ts';
import { MEMBER_COOKIE, STAFF_COOKIE, readCookie } from './http.ts';
import { generateToken, hashToken, signSession, verifySession } from './crypto.ts';
import type { Store } from '../store/types.ts';

/**
 * Authentication.
 *
 * Members: magic link. The member enters an email, we check it against Hapana's
 * active members, and if it is active we email a single-use link. No password
 * is ever created or stored. If Hapana turns out to expose an OAuth flow usable
 * from an external page (PRD 9.2) it slots in as another way to reach
 * issueMemberSession, and nothing downstream changes.
 *
 * Staff: the same magic link mechanism against staff_users. The door list shows
 * member and guest names and contact details, so it is authenticated. The
 * private booking URL is a distribution choice and is never an access control.
 */

export const MAGIC_LINK_TTL_MINUTES = 15;
export const MEMBER_SESSION_TTL_HOURS = 12;
export const STAFF_SESSION_TTL_HOURS = 12;

/** Requests per email or IP per window for the magic-link endpoint. */
export const MAGIC_LINK_RATE_LIMIT = 5;
export const MAGIC_LINK_RATE_WINDOW_MS = 15 * 60_000;

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

export function issueMemberSession(member: { memberId: string; email: string; name: string }): string {
  const payload: MemberSession = {
    kind: 'member',
    memberId: member.memberId,
    email: member.email,
    name: member.name,
    exp: Math.floor(Date.now() / 1000) + MEMBER_SESSION_TTL_HOURS * 3600,
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
 * Creates a single-use magic-link token. Returns the raw token for the email;
 * only its hash reaches the database.
 */
export async function createMagicLink(
  store: Store,
  input: { email: string; memberId: string; ip?: string | null },
): Promise<string> {
  const token = generateToken();
  await store.auth.createToken({
    tokenHash: hashToken(token),
    email: input.email,
    memberId: input.memberId,
    expiresAt: new Date(Date.now() + MAGIC_LINK_TTL_MINUTES * 60_000),
    ip: input.ip ?? null,
  });
  return token;
}

export async function consumeMagicLink(
  store: Store,
  token: string,
): Promise<{ email: string; memberId: string } | null> {
  return store.auth.consumeToken(hashToken(token));
}

/**
 * Rate limiting for link requests. Both the email and the caller IP are
 * bucketed, so neither a single address nor a single source can be used to
 * enumerate the membership list.
 */
export async function withinRateLimit(store: Store, email: string, ip: string | null): Promise<boolean> {
  const emailOk = await store.auth.throttle(
    `magic:email:${hashToken(email)}`,
    MAGIC_LINK_RATE_LIMIT,
    MAGIC_LINK_RATE_WINDOW_MS,
  );
  const ipOk = ip
    ? await store.auth.throttle(`magic:ip:${hashToken(ip)}`, MAGIC_LINK_RATE_LIMIT * 4, MAGIC_LINK_RATE_WINDOW_MS)
    : true;
  return emailOk && ipOk;
}

export function magicLinkUrl(token: string, next: 'booking' | 'doorlist' | 'admin'): string {
  const url = new URL('/api/auth-verify', env.publicBaseUrl);
  url.searchParams.set('token', token);
  url.searchParams.set('next', next);
  return url.toString();
}
