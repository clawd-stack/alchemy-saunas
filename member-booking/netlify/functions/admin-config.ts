import { buildContext } from '../../src/domain/context.ts';
import { CONFIG_KEYS, updateConfig, validate } from '../../src/lib/config.ts';
import { requireAdmin } from '../../src/lib/auth.ts';
import { BookingError } from '../../src/lib/errors.ts';
import { errorResponse, json, preflight, readJson } from '../../src/lib/http.ts';
import { IS_PLACEHOLDER, WAIVER_VERSION } from '../../src/lib/waiver-text.ts';

/**
 * GET   /api/admin/config   current values, with their documented sources
 * PATCH /api/admin/config   { updates: {...}, sourceNote? }
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
      return json(request, {
        ok: true,
        keys: CONFIG_KEYS,
        config: context.config,
        entries,
        issues: validate(context.config),
        warnings: buildWarnings(context.config, entries),
      });
    }

    if (request.method !== 'PATCH' && request.method !== 'POST') {
      throw new BookingError('INVALID_REQUEST');
    }

    const body = await readJson<{ updates?: unknown; sourceNote?: unknown }>(request);
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
