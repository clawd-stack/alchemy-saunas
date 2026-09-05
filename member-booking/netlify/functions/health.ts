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
    const dbSource = process.env.DATABASE_URL
      ? 'postgres (DATABASE_URL)'
      : process.env.NETLIFY_DATABASE_URL
        ? 'postgres (Netlify DB)'
        : 'in-memory (not production safe)';
    checks.push({ name: 'store', ok: !dbSource.startsWith('in-memory'), detail: dbSource });
  } catch (error) {
    checks.push({ name: 'store', ok: false, detail: error instanceof Error ? error.message : String(error) });
  }

  checks.push({
    name: 'hapana_credentials',
    ok: Boolean(process.env.HAPANA_API_KEY),
    detail: process.env.HAPANA_API_KEY ? 'configured' : 'missing: running against the mock',
  });

  const emailProvider = process.env.EMAIL_PROVIDER ?? 'console';
  const emailConfigured =
    emailProvider === 'smtp'
      ? Boolean(process.env.SMTP_USER && process.env.SMTP_PASS)
      : emailProvider !== 'console' && Boolean(process.env.EMAIL_API_KEY);
  checks.push({
    name: 'email_provider',
    ok: emailConfigured,
    detail: emailConfigured
      ? `${emailProvider}, sending as ${process.env.EMAIL_FROM ?? 'the default from address'}`
      : emailProvider === 'console'
        ? 'console (logs only, nothing is delivered)'
        : `${emailProvider} selected but its credentials are missing`,
  });

  if (context) {
    const version = context.config.waiverVersion;
    const isPlaceholder = IS_PLACEHOLDER || version.startsWith('PLACEHOLDER');
    checks.push({
      name: 'waiver_wording',
      ok: !isPlaceholder,
      detail: isPlaceholder ? `placeholder ${version}` : `${version}, agreeing to ${context.config.waiverText.termsUrl}`,
    });
  }

  if (context) {
    // Sign-in is a password now, so an admin who can still get in is a
    // deployment-level dependency, not a detail. Zero admin accounts, or every
    // one of them still on an issued password, is worth surfacing.
    const accounts = await context.store.credentials.list();
    const staff = await context.store.auth.listStaff();
    const adminEmails = new Set(
      staff.filter((s) => s.active && s.role === 'admin').map((s) => s.email.toLowerCase()),
    );
    const adminLogins = accounts.filter((a) => a.active && adminEmails.has(a.email));
    const unchanged = adminLogins.filter((a) => a.mustChange).length;
    checks.push({
      name: 'admin_sign_in',
      ok: adminLogins.length > 0,
      detail:
        adminLogins.length === 0
          ? 'no active admin has a password set: nobody can reach the configuration screen'
          : `${adminLogins.length} admin sign-in${adminLogins.length === 1 ? '' : 's'}` +
            (unchanged > 0 ? `, ${unchanged} still on an issued password that should be changed` : ''),
    });
  }

  if (context) {
    const entries = await context.store.config.all();
    const ceiling = entries.find((entry) => entry.key === 'venue_maximum');
    // A ceiling is optional. It is only a problem when one is set without a
    // recorded source, because staff would then be relying on an unsourced number.
    checks.push({
      name: 'venue_maximum_source',
      ok: context.config.venueMaximum === null || Boolean(ceiling?.sourceNote),
      detail:
        context.config.venueMaximum === null
          ? `no venue-wide ceiling enforced; this channel sells ${context.config.memberChannelCapacity} spots per hour`
          : ceiling?.sourceNote ?? 'a ceiling is set with no documented source',
    });
    const issues = validate(context.config);
    checks.push({
      name: 'config_valid',
      ok: issues.length === 0,
      detail: issues.length === 0 ? 'all settings within bounds' : issues.map((i) => i.message).join(' '),
    });
    const hours = Object.entries(context.config.operatingHours ?? {});
    checks.push({
      name: 'operating_hours',
      ok: hours.length > 0,
      detail: hours.length > 0 ? `${hours[0]?.[1]?.[0]} to ${hours[0]?.[1]?.[1]}, ${hours.length} days configured` : 'none configured',
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
