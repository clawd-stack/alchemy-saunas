import { readMemberSession, readStaffSession } from '../../src/lib/auth.ts';
import { MEMBER_COOKIE, STAFF_COOKIE, clearCookie, errorResponse, json, preflight } from '../../src/lib/http.ts';

/**
 * GET  /api/auth/session  who am I
 * POST /api/auth/session  sign out
 */
export default async (request: Request): Promise<Response> => {
  const early = preflight(request);
  if (early) return early;

  try {
    if (request.method === 'POST') {
      // Clear both cookies: a manager can hold a member and a staff session in
      // the same browser, and signing out should mean signing out of both.
      const response = json(request, { ok: true, signedOut: true });
      response.headers.append('set-cookie', clearCookie(MEMBER_COOKIE));
      response.headers.append('set-cookie', clearCookie(STAFF_COOKIE));
      return response;
    }

    const member = readMemberSession(request);
    const staff = readStaffSession(request);
    return json(request, {
      ok: true,
      member: member ? { memberId: member.memberId, name: member.name, email: member.email } : null,
      staff: staff ? { name: staff.name, role: staff.role, venueIds: staff.venueIds } : null,
    });
  } catch (error) {
    return errorResponse(request, error);
  }
};

export const config = { path: '/api/auth/session' };
