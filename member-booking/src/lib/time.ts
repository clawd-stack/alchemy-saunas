/**
 * Time helpers. The venue runs on Australia/Perth (UTC+8, no daylight saving),
 * but nothing here assumes that: the timezone comes from the venue record so a
 * second venue in another state does not need code changes.
 */

export const MINUTE_MS = 60_000;
export const HOUR_MS = 60 * MINUTE_MS;
export const DAY_MS = 24 * HOUR_MS;

/** Formats an instant in a venue's local time, e.g. "Thu 11 Sep, 6:00 pm". */
export function formatLocal(instant: Date | string, timezone: string): string {
  const date = typeof instant === 'string' ? new Date(instant) : instant;
  return new Intl.DateTimeFormat('en-AU', {
    timeZone: timezone,
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).format(date);
}

/** Local calendar date (YYYY-MM-DD) for a venue, used to group the door list. */
export function localDateKey(instant: Date | string, timezone: string): string {
  const date = typeof instant === 'string' ? new Date(instant) : instant;
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/** Local weekday key ('mon'..'sun') used to look up operating hours. */
export function localWeekdayKey(instant: Date, timezone: string): string {
  const weekday = new Intl.DateTimeFormat('en-AU', { timeZone: timezone, weekday: 'short' })
    .format(instant)
    .toLowerCase();
  return weekday.slice(0, 3);
}

/**
 * The offset, in minutes, between UTC and a timezone at a given instant.
 * Used to build local wall-clock session times without pulling in a date library.
 */
export function timezoneOffsetMinutes(instant: Date, timezone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(instant);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? '0');
  const asUtc = Date.UTC(
    get('year'),
    get('month') - 1,
    get('day'),
    get('hour') % 24,
    get('minute'),
    get('second'),
  );
  return (asUtc - instant.getTime()) / MINUTE_MS;
}

/**
 * Resolves a local wall-clock time on a local calendar date to an instant.
 * Two passes, because the offset itself depends on the instant.
 */
export function localWallClockToInstant(
  dateKey: string,
  hhmm: string,
  timezone: string,
): Date {
  const [y, m, d] = dateKey.split('-').map(Number);
  const [hh, mm] = hhmm.split(':').map(Number);
  const naive = Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1, hh ?? 0, mm ?? 0, 0);
  let guess = new Date(naive);
  for (let i = 0; i < 2; i += 1) {
    const offset = timezoneOffsetMinutes(guess, timezone);
    guess = new Date(naive - offset * MINUTE_MS);
  }
  return guess;
}

export function addDays(instant: Date, days: number): Date {
  return new Date(instant.getTime() + days * DAY_MS);
}

/** True when `now` is at or past the cancellation cutoff for a session. */
export function isPastCutoff(startsAt: Date | string, cutoffHours: number, now = new Date()): boolean {
  const start = typeof startsAt === 'string' ? new Date(startsAt) : startsAt;
  return start.getTime() - cutoffHours * HOUR_MS <= now.getTime();
}
