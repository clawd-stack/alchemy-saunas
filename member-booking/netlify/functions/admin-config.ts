import { buildContext } from '../../src/domain/context.ts';
import { CONFIG_KEYS, configKeyFor, updateConfig, validate } from '../../src/lib/config.ts';
import { requireAdmin } from '../../src/lib/auth.ts';
import { BookingError } from '../../src/lib/errors.ts';
import { errorResponse, json, preflight, readJson, requireString } from '../../src/lib/http.ts';
import { IS_PLACEHOLDER, WAIVER_VERSION } from '../../src/lib/waiver-text.ts';

/**
 * GET   /api/admin/config   current values, with their documented sources
 * PATCH /api/admin/config   { updates: {...}, sourceNote? }
 * PATCH /api/admin/config   { package, allowed }   open or close a package
 *
 * Membership packages live here rather than on the People screen because they
 * are a rule about the channel, not about any one person: which packages this
 * channel is part of. People is where somebody goes to deal with a person.
 *
 * The bound on member_channel_capacity is enforced here, not just described:
 * public capacity plus member allocation may never exceed the venue maximum,
 * and raising the venue maximum requires a documented source. PRD 5.7.
 */
export default async (request: Request): Promise<Response> => {
  const early = preflight(request);
  if (early) return early;

  try {
    const context = await buildContext();
    const staff = requireAdmin(request);

    if (request.method === 'GET') {
      const entries = await context.store.config.all();

      // Every package anybody holds, with the venue's ruling on it. An empty
      // ruling means every package is open, so that is what the screen says
      // rather than showing ten switches that are all doing nothing.
      const access = context.config.packageAccess ?? {};
      const ruled = Object.keys(access).length > 0;
      const seen = await context.store.members.listPackages();

      return json(request, {
        ok: true,
        keys: CONFIG_KEYS,
        config: context.config,
        entries,
        issues: validate(context.config),
        warnings: buildWarnings(context.config, entries),
        packagesRuled: ruled,
        packages: seen.map((entry) => ({
          ...entry,
          allowed: ruled ? access[entry.name] === true : true,
          // Holding members, and nobody has ruled on it since ruling started.
          // Worth saying out loud: those members cannot book.
          unruled: ruled && !(entry.name in access),
        })),
      });
    }

    if (request.method !== 'PATCH' && request.method !== 'POST') {
      throw new BookingError('INVALID_REQUEST');
    }

    const body = await readJson<{
      updates?: unknown; sourceNote?: unknown; package?: unknown; allowed?: unknown;
    }>(request);

    // One package opened or closed. Not a value in the settings form, because
    // the list is whatever the membership happens to hold rather than a field
    // somebody typed.
    if (body.package !== undefined) {
      const name = requireString(body.package, 'package', 200);
      if (typeof body.allowed !== 'boolean') throw new BookingError('INVALID_REQUEST', { field: 'allowed' });

      const current = context.config.packageAccess ?? {};
      // The first ruling closes everything it does not name, so the packages
      // already on screen are written down as open. Without this the first
      // switch would silently lock out every other package listed, which is
      // not what pressing one switch should mean.
      const base = Object.keys(current).length > 0
        ? current
        : Object.fromEntries((await context.store.members.listPackages()).map((entry) => [entry.name, true]));

      await context.store.config.set(
        configKeyFor('packageAccess'),
        { ...base, [name]: body.allowed },
        staff.email,
        null,
      );

      console.log(`[member-booking] ${staff.email} ${body.allowed ? 'opened' : 'closed'} the ${name} package`);
      return json(request, {
        ok: true,
        message: body.allowed
          ? `${name} can book. Anyone holding it signs in from now on.`
          : `${name} can no longer book. A session already open ends within 12 hours.`,
      });
    }

    if (!body.updates || typeof body.updates !== 'object' || Array.isArray(body.updates)) {
      throw new BookingError('INVALID_REQUEST', { field: 'updates' });
    }

    const { config, issues } = await updateConfig(
      context.store,
      body.updates as Record<string, unknown>,
      staff.email,
      typeof body.sourceNote === 'string' ? body.sourceNote : null,
    );

    if (issues.length > 0) {
      return json(request, { ok: false, code: 'CONFIG_INVALID', issues }, 400);
    }

    return json(request, { ok: true, config, message: 'Saved. The change is live immediately, no deploy needed.' });
  } catch (error) {
    return errorResponse(request, error);
  }
};

function buildWarnings(
  config: { venueMaximum: number | null; hapanaPublicCapacity: number; memberChannelCapacity: number },
  entries: Array<{ key: string; sourceNote: string | null }>,
): string[] {
  const warnings: string[] = [];

  if (config.venueMaximum !== null) {
    const ceiling = entries.find((entry) => entry.key === 'venue_maximum');
    if (!ceiling?.sourceNote || /provisional/i.test(ceiling.sourceNote)) {
      warnings.push(
        'A venue maximum is set but has no documented source. Record where the number comes from, or clear it if no ceiling needs to be enforced here.',
      );
    }
    const headroom = config.venueMaximum - config.hapanaPublicCapacity - config.memberChannelCapacity;
    if (headroom > 0) {
      warnings.push(`${headroom} spots per session are allocated to neither channel.`);
    }
  }

  if (IS_PLACEHOLDER) {
    warnings.push(`The guest waiver is still placeholder text (${WAIVER_VERSION}) and must be replaced before go-live.`);
  }
  return warnings;
}

export const config = { path: '/api/admin/config' };
