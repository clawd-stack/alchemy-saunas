import { buildContext } from '../../src/domain/context.ts';
import { verifyMemberById } from '../../src/domain/membership.ts';
import { consumeMagicLink, issueMemberSession, issueStaffSession, MEMBER_SESSION_TTL_HOURS } from '../../src/lib/auth.ts';
import { MEMBER_COOKIE, STAFF_COOKIE, errorResponse, setCookie } from '../../src/lib/http.ts';
import { env } from '../../src/lib/env.ts';

/**
 * GET /api/auth-verify?token=...&next=booking|doorlist|admin
 *
 * Consumes a magic link, sets the session cookie and redirects to the page the
 * link was issued for. Consumption is a single conditional update, so a link
 * that is opened twice (email scanners do this) authenticates once.
 */
export default async (request: Request): Promise<Response> => {
  try {
    const url = new URL(request.url);
    const token = url.searchParams.get('token') ?? '';
    const next = url.searchParams.get('next') ?? 'booking';

    const context = await buildContext();
    const consumed = await consumeMagicLink(context.store, token);
    if (!consumed) return redirect(`/booking.html?signin=expired`);

    if (consumed.memberId.startsWith('staff:')) {
      const staffId = consumed.memberId.slice('staff:'.length);
      const staff = await context.store.auth.getStaff(staffId);
      if (!staff) return redirect('/doorlist.html?signin=expired');
      const cookie = setCookie(
        STAFF_COOKIE,
        issueStaffSession({
          staffId: staff.staffId,
          email: staff.email,
          displayName: staff.displayName,
          role: staff.role,
          venueIds: staff.venueIds,
        }),
        MEMBER_SESSION_TTL_HOURS * 3600,
      );
      return redirect(next === 'admin' ? '/admin.html' : '/doorlist.html', cookie);
    }

    // Re-verify against Hapana rather than trusting the token: a membership can
    // have been cancelled between the link being sent and being opened.
    const member = await verifyMemberById(context, consumed.memberId);
    if (!member) return redirect('/booking.html?signin=inactive');

    const cookie = setCookie(
      MEMBER_COOKIE,
      issueMemberSession({ memberId: member.memberId, email: member.email, name: member.name }),
      MEMBER_SESSION_TTL_HOURS * 3600,
    );
    return redirect('/booking.html?signin=ok', cookie);
  } catch (error) {
    return errorResponse(request, error);
  }
};

function redirect(path: string, cookie?: string): Response {
  const headers: Record<string, string> = {
    location: new URL(path, env.publicBaseUrl).toString(),
    'cache-control': 'no-store',
  };
  if (cookie) headers['set-cookie'] = cookie;
  return new Response(null, { status: 302, headers });
}

export const config = { path: '/api/auth-verify' };
