import { buildContext } from '../../src/domain/context.ts';
import { validate } from '../../src/lib/config.ts';
import { IS_PLACEHOLDER, WAIVER_VERSION } from '../../src/lib/waiver-text.ts';
import { json, preflight, requireMethod } from '../../src/lib/http.ts';

/**
 * GET /api/health
 *
 * A readiness check that answers the question that matters before go-live: is
 * this thing safe to point members at? It reports the unresolved dependencies
 * rather than just returning 200, so nobody has to remember them.
 */
export default async (request: Request): Promise<Response> => {
  const early = preflight(request);
  if (early) return early;

  requireMethod(request, 'GET');

  const checks: Array<{ name: string; ok: boolean; detail: string }> = [];
  let context: Awaited<ReturnType<typeof buildContext>> | null = null;

  try {
    context = await buildContext();
    checks.push({ name: 'store', ok: true, detail: process.env.DATABASE_URL ? 'postgres' : 'in-memory (not production safe)' });
  } catch (error) {
    checks.push({ name: 'store', ok: false, detail: error instanceof Error ? error.message : String(error) });
  }

  checks.push({
    name: 'hapana_credentials',
    ok: Boolean(process.env.HAPANA_API_KEY),
    detail: process.env.HAPANA_API_KEY ? 'configured' : 'missing: running against the mock',
  });

  checks.push({
    name: 'email_provider',
    ok: (process.env.EMAIL_PROVIDER ?? 'console') !== 'console',
    detail: process.env.EMAIL_PROVIDER ?? 'console (logs only, nothing is delivered)',
  });

  checks.push({
    name: 'waiver_wording',
    ok: !IS_PLACEHOLDER,
    detail: IS_PLACEHOLDER ? `placeholder ${WAIVER_VERSION}: awaiting Alex Beagley` : WAIVER_VERSION,
  });

  if (context) {
    const entries = await context.store.config.all();
    const ceiling = entries.find((entry) => entry.key === 'venue_maximum');
    checks.push({
      name: 'venue_maximum_source',
      ok: Boolean(ceiling?.sourceNote) && !/provisional/i.test(ceiling?.sourceNote ?? ''),
      detail: ceiling?.sourceNote ?? 'no documented source recorded',
    });
    const issues = validate(context.config);
    checks.push({
      name: 'config_valid',
      ok: issues.length === 0,
      detail: issues.length === 0 ? 'all settings within bounds' : issues.map((i) => i.message).join(' '),
    });
    checks.push({
      name: 'booking_backend',
      ok: true,
      detail: context.config.bookingBackend === 'hapana' ? 'Pattern A: Hapana holds inventory' : 'Pattern B: local ringfenced inventory',
    });
  }

  const readyForMembers = checks.every((check) => check.ok);
  return json(request, { ok: true, readyForMembers, checks }, readyForMembers ? 200 : 200);
};

export const config = { path: '/api/health' };
