import { buildContext } from '../../src/domain/context.ts';
import { getWaiverByToken, signWaiver } from '../../src/domain/waivers.ts';
import { BookingError } from '../../src/lib/errors.ts';
import { clientIp, errorResponse, json, preflight, readJson, requireString } from '../../src/lib/http.ts';
import { formatLocal } from '../../src/lib/time.ts';
import { WAIVER_TEXT } from '../../src/lib/waiver-text.ts';

/**
 * GET  /api/waiver?token=...   fetch the waiver a guest was emailed
 * POST /api/waiver             sign it
 *
 * The token is the guest's only credential. Guests have no account and no
 * booking access, by design. PRD 4.
 */
export default async (request: Request): Promise<Response> => {
  const early = preflight(request);
  if (early) return early;

  try {
    const context = await buildContext();

    if (request.method === 'GET') {
      const token = new URL(request.url).searchParams.get('token') ?? '';
      const waiver = await getWaiverByToken(context, token);
      if (!waiver) throw new BookingError('NOT_FOUND');
      return json(request, {
        ok: true,
        waiver: {
          guestName: waiver.guestName,
          status: waiver.status,
          signedAt: waiver.signedAt,
          sessionLabel: formatLocal(waiver.sessionStartsAt, context.timezone),
          venueName: context.venueName,
          version: waiver.waiverVersion,
        },
        text: WAIVER_TEXT,
      });
    }

    if (request.method !== 'POST') throw new BookingError('INVALID_REQUEST');

    const body = await readJson<{ token?: unknown; signedName?: unknown; agreed?: unknown }>(request);
    const token = requireString(body.token, 'token', 400);
    const signedName = requireString(body.signedName, 'signedName', 120);
    if (body.agreed !== true) throw new BookingError('INVALID_REQUEST', { field: 'agreed' });

    const waiver = await signWaiver(context, {
      token,
      signedName,
      ip: clientIp(request),
      userAgent: request.headers.get('user-agent'),
    });
    if (!waiver) throw new BookingError('NOT_FOUND');

    return json(request, {
      ok: true,
      status: waiver.status,
      signedAt: waiver.signedAt,
      message: 'Signed. Thank you, that is all we need before you arrive.',
    });
  } catch (error) {
    return errorResponse(request, error);
  }
};

export const config = { path: '/api/waiver' };
