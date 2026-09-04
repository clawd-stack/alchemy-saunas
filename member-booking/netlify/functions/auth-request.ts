import { buildContext } from '../../src/domain/context.ts';
import { verifyMemberByEmail } from '../../src/domain/membership.ts';
import { createMagicLink, magicLinkUrl, withinRateLimit, MAGIC_LINK_TTL_MINUTES } from '../../src/lib/auth.ts';
import { magicLink, sendQueued } from '../../src/lib/email.ts';
import { clientIp, errorResponse, json, normaliseEmail, preflight, readJson, requireMethod } from '../../src/lib/http.ts';
import { BookingError } from '../../src/lib/errors.ts';

/**
 * POST /api/auth/request  { email, audience?: 'booking' | 'doorlist' | 'admin' }
 *
 * Sends a single-use sign-in link if, and only if, the address belongs to an
 * active member (or to a staff account for the staff audiences). The response
 * is identical either way: a caller cannot learn from it whether an address is
 * a member. PRD 5.1.
 */
export default async (request: Request): Promise<Response> => {
  const early = preflight(request);
  if (early) return early;

  // Deliberately identical for every outcome.
  const genericResponse = () =>
    json(request, {
      ok: true,
      message: 'If that email is on an active Alchemy membership, a sign-in link is on its way. It expires in 15 minutes.',
    });

  try {
    requireMethod(request, 'POST');
    const body = await readJson<{ email?: unknown; audience?: unknown }>(request);
    const email = normaliseEmail(body.email);
    const audience = body.audience === 'doorlist' || body.audience === 'admin' ? body.audience : 'booking';

    const context = await buildContext();
    const ip = clientIp(request);

    if (!(await withinRateLimit(context.store, email, ip))) {
      throw new BookingError('RATE_LIMITED');
    }

    if (audience === 'booking') {
      const member = await verifyMemberByEmail(context, email);
      if (!member) return genericResponse();
      const token = await createMagicLink(context.store, { email, memberId: member.memberId, ip });
      const message = magicLink({ linkUrl: magicLinkUrl(token, 'booking'), expiryMinutes: MAGIC_LINK_TTL_MINUTES });
      await sendQueued(context.store, 'magic_link', { ...message, to: email });
      return genericResponse();
    }

    const staff = await context.store.auth.getStaffByEmail(email);
    if (!staff) return genericResponse();
    const token = await createMagicLink(context.store, { email, memberId: `staff:${staff.staffId}`, ip });
    const message = magicLink({ linkUrl: magicLinkUrl(token, audience), expiryMinutes: MAGIC_LINK_TTL_MINUTES });
    await sendQueued(context.store, 'magic_link', { ...message, to: email });
    return genericResponse();
  } catch (error) {
    return errorResponse(request, error);
  }
};

export const config = { path: '/api/auth/request' };
