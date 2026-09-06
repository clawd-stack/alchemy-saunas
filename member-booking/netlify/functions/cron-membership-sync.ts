import { buildContext } from '../../src/domain/context.ts';
import { syncMembers } from '../../src/domain/membership.ts';
import { materialiseTimetable } from '../../src/domain/sessions.ts';

/**
 * Weekly, Monday morning.
 *
 * Two jobs, both Pattern B concerns. Refresh the membership cache, which is
 * what member verification falls back to when Hapana is unreachable, and
 * materialise the timetable so sessions exist before anyone books them.
 *
 * Weekly is enough for both. Membership is read live from Hapana at every
 * sign-in and again at the moment of booking, so the cache is a fallback for
 * an outage rather than the thing anyone is verified against: a week-old
 * fallback is still better than refusing every booking while Hapana is down.
 * The timetable is materialised on every availability read and again inside
 * the booking function, so this job only pre-creates rows that would be
 * created on demand anyway.
 *
 * A membership that lapses mid-week therefore still cannot book, because the
 * live check catches it. What a stale cache can do is let a lapsed member book
 * during a Hapana outage, which is the trade weekly buys and hourly did not.
 *
 * Under Pattern A the membership sync is unnecessary (status is read live) but
 * harmless, and it keeps the fallback warm if the pattern is ever switched.
 */
export default async (): Promise<Response> => {
  const context = await buildContext();

  let synced = 0;
  let delta = false;
  let syncError: string | null = null;
  try {
    ({ synced, delta } = await syncMembers(context));
  } catch (error) {
    // A failed sync must not stop the timetable from being built.
    syncError = error instanceof Error ? error.message : String(error);
    console.error('[member-booking] membership sync failed', error);
  }

  const slots = await materialiseTimetable(context);
  console.log(
    `[member-booking] membership sync: ${synced} members ${delta ? 'changed since the last run' : '(full pull)'}, ` +
    `${slots} sessions materialised`,
  );

  return new Response(JSON.stringify({ ok: syncError === null, synced, delta, slots, syncError }), {
    headers: { 'content-type': 'application/json' },
  });
};

/**
 * Monday 06:00 in Perth. Netlify evaluates cron in UTC and Perth is UTC+8 with
 * no daylight saving, so that is Sunday 22:00 UTC, hence day-of-week 0.
 */
export const config = { schedule: '0 22 * * 0' };
