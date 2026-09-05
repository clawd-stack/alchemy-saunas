import { buildContext } from '../../src/domain/context.ts';
import { reconciliationCsv, todayKey } from '../../src/domain/doorlist.ts';
import { requireStaff } from '../../src/lib/auth.ts';
import { corsHeaders, errorResponse, preflight, requireMethod } from '../../src/lib/http.ts';

/**
 * GET /api/admin/reconciliation?date=YYYY-MM-DD
 *
 * The daily CSV of amounts owed against amounts marked collected. With EFTPOS
 * at the door and no payment integration, this is the only control against
 * guest revenue leaking, so door staff can pull it as well as managers. PRD 6.
 */
export default async (request: Request): Promise<Response> => {
  const early = preflight(request);
  if (early) return early;

  try {
    requireMethod(request, 'GET');
    const context = await buildContext();
    requireStaff(request, context.venueId);

    const dateKey = new URL(request.url).searchParams.get('date') ?? todayKey(context);
    const { filename, csv } = await reconciliationCsv(context, dateKey);

    return new Response(csv, {
      status: 200,
      headers: {
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': `attachment; filename="${filename}"`,
        'cache-control': 'no-store',
        ...corsHeaders(request),
      },
    });
  } catch (error) {
    return errorResponse(request, error);
  }
};

export const config = { path: '/api/admin/reconciliation' };
