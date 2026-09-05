import { buildContext } from '../../src/domain/context.ts';
import { syncMembers } from '../../src/domain/membership.ts';
import { materialiseTimetable } from '../../src/domain/sessions.ts';

/**
 * Scheduled hourly.
 *
 * Two jobs, both Pattern B concerns. Refresh the membership cache, which is
 * what member verification falls back to when Hapana is unreachable, and
 * materialise the timetable so sessions exist before anyone books them.
 *
 * Under Pattern A the membership sync is unnecessary (status is read live) but
 * harmless, and it keeps the fallback warm if the pattern is ever switched.
 */
export default async (): Promise<Response> => {
  const context = await buildContext();

  let synced = 0;
  let syncError: string | null = null;
  try {
    synced = await syncMembers(context);
  } catch (error) {
    // A failed sync must not stop the timetable from being built.
    syncError = error instanceof Error ? error.message : String(error);
    console.error('[member-booking] membership sync failed', error);
  }

  const slots = await materialiseTimetable(context);
  console.log(`[member-booking] membership sync: ${synced} members, ${slots} sessions materialised`);

  return new Response(JSON.stringify({ ok: syncError === null, synced, slots, syncError }), {
    headers: { 'content-type': 'application/json' },
  });
};

export const config = { schedule: '@hourly' };
