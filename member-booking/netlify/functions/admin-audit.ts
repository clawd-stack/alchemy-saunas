import { buildContext } from '../../src/domain/context.ts';
import { requireAdmin } from '../../src/lib/auth.ts';
import { errorResponse, json, preflight, requireMethod } from '../../src/lib/http.ts';
import { localWallClockToInstant } from '../../src/lib/time.ts';

/**
 * GET /api/admin/audit?date=YYYY-MM-DD
 *
 * The capacity audit log, PRD 6. Every booking, cancellation and refusal with
 * the occupancy at the time. If the ceiling is ever questioned, this is the
 * evidence that it was respected.
 */
export default async (request: Request): Promise<Response> => {
  const early = preflight(request);
  if (early) return early;

  try {
    requireMethod(request, 'GET');
    const context = await buildContext();
    requireAdmin(request);

    const url = new URL(request.url);
    const dateKey = url.searchParams.get('date');
    const from = dateKey
      ? localWallClockToInstant(dateKey, '00:00', context.timezone)
      : new Date(Date.now() - 7 * 24 * 3_600_000);
    const to = dateKey ? new Date(from.getTime() + 24 * 3_600_000) : new Date();

    const rows = await context.store.audit.listForVenueBetween(context.venueId, from, to);
    const breaches = rows.filter(
      (row) => row.venueMaximumAtTime !== null && row.venueTotalBookedAfter > row.venueMaximumAtTime,
    );

    return json(request, {
      ok: true,
      from: from.toISOString(),
      to: to.toISOString(),
      count: rows.length,
      // Should always be zero. If it is not, the ceiling was breached and that
      // is the single most serious failure this build can have.
      ceilingBreaches: breaches.length,
      breaches,
      rows,
    });
  } catch (error) {
    return errorResponse(request, error);
  }
};

export const config = { path: '/api/admin/audit' };
