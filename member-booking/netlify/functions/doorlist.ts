import { buildContext } from '../../src/domain/context.ts';
import { buildDoorList, listSessionsForDay, todayKey } from '../../src/domain/doorlist.ts';
import { requireStaff } from '../../src/lib/auth.ts';
import { errorResponse, json, preflight, requireMethod } from '../../src/lib/http.ts';

/**
 * GET /api/door/list?session=...   one session's door list
 * GET /api/door/list?date=...      that day's sessions, for the picker
 *
 * Staff-authenticated. This view exposes member and guest names and contact
 * details, so it is never protected by URL obscurity. PRD 4.
 */
export default async (request: Request): Promise<Response> => {
  const early = preflight(request);
  if (early) return early;

  try {
    requireMethod(request, 'GET');
    const context = await buildContext();
    const staff = requireStaff(request, context.venueId);
    const url = new URL(request.url);
    const sessionId = url.searchParams.get('session');

    if (!sessionId) {
      const dateKey = url.searchParams.get('date') ?? todayKey(context);
      const sessions = await listSessionsForDay(context, dateKey);
      return json(request, { ok: true, date: dateKey, staff: { name: staff.name, role: staff.role }, sessions });
    }

    const doorList = await buildDoorList(context, sessionId);
    return json(request, { ok: true, staff: { name: staff.name, role: staff.role }, doorList });
  } catch (error) {
    return errorResponse(request, error);
  }
};

export const config = { path: '/api/door/list' };
