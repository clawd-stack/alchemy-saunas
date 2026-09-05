import { describe, expect, it } from 'vitest';
import { bookingWindow, generateSlots, localSessionKey } from '../src/domain/sessions.ts';
import { CONFIG_DEFAULTS } from '../src/lib/config.ts';
import { formatLocal, isPastCutoff, localDateKey, localWallClockToInstant } from '../src/lib/time.ts';

const TZ = 'Australia/Perth';

/**
 * Timetable generation and the Perth time handling it depends on. Getting the
 * local wall clock wrong would shift every session by hours, which is the sort
 * of bug that only shows up at the door.
 */

describe('local time', () => {
  it('resolves a Perth wall-clock time to the right instant', () => {
    // Perth is UTC+8 year round, no daylight saving.
    const instant = localWallClockToInstant('2026-09-11', '18:00', TZ);
    expect(instant.toISOString()).toBe('2026-09-11T10:00:00.000Z');
  });

  it('formats an instant back into Perth local time', () => {
    const label = formatLocal('2026-09-11T10:00:00.000Z', TZ);
    expect(label).toContain('11 Sept');
    expect(label).toContain('6:00');
  });

  it('keeps the local date key stable across the UTC day boundary', () => {
    // 4pm UTC is midnight the next day in Perth.
    expect(localDateKey('2026-09-11T16:30:00.000Z', TZ)).toBe('2026-09-12');
  });

  it('applies the cancellation cutoff against the session start', () => {
    const start = new Date(Date.now() + 4 * 3_600_000);
    expect(isPastCutoff(start, 3)).toBe(false);
    expect(isPastCutoff(new Date(Date.now() + 2 * 3_600_000), 3)).toBe(true);
    // Exactly on the cutoff is too late: the boundary closes.
    expect(isPastCutoff(new Date(Date.now() + 3 * 3_600_000), 3)).toBe(true);
  });
});

describe('timetable generation', () => {
  it('generates hourly slots inside the configured operating hours', () => {
    // Perth-local day boundaries: a UTC-midnight window would clip the first
    // two local hours off the front of the day.
    const from = localWallClockToInstant('2026-09-07', '00:00', TZ);
    const to = localWallClockToInstant('2026-09-07', '23:59', TZ);
    const slots = generateSlots(CONFIG_DEFAULTS, TZ, 'east-fremantle', from, to);

    expect(slots.length).toBeGreaterThan(0);
    for (const slot of slots) {
      const label = formatLocal(slot.startsAt, TZ);
      expect(slot.endsAt.getTime() - slot.startsAt.getTime()).toBe(60 * 60_000);
      expect(label).toBeTruthy();
    }
    // 5am to 9pm, so 16 hourly slots, the last starting at 8pm.
    const monday = slots.filter((slot) => localDateKey(slot.startsAt, TZ) === '2026-09-07');
    expect(monday).toHaveLength(16);
    expect(formatLocal(monday[0]!.startsAt, TZ)).toContain('5:00 am');
    expect(formatLocal(monday.at(-1)!.startsAt, TZ)).toContain('8:00 pm');
    // The last session ends exactly as the venue closes.
    expect(formatLocal(monday.at(-1)!.endsAt, TZ)).toContain('9:00 pm');
  });

  it('runs the same hours at the weekend', () => {
    const from = localWallClockToInstant('2026-09-12', '00:00', TZ);
    const to = localWallClockToInstant('2026-09-12', '23:59', TZ);
    expect(generateSlots(CONFIG_DEFAULTS, TZ, 'east-fremantle', from, to)).toHaveLength(16);
  });

  it('respects a shorter timetable if one is configured', () => {
    const config = { ...CONFIG_DEFAULTS, operatingHours: { ...CONFIG_DEFAULTS.operatingHours, sat: ['07:00', '18:00'] as [string, string] } };
    const from = localWallClockToInstant('2026-09-12', '00:00', TZ);
    const to = localWallClockToInstant('2026-09-12', '23:59', TZ);
    expect(generateSlots(config, TZ, 'east-fremantle', from, to)).toHaveLength(11);
  });

  it('skips a day with no configured hours', () => {
    const config = { ...CONFIG_DEFAULTS, operatingHours: { mon: ['06:00', '08:00'] as [string, string] } };
    const from = localWallClockToInstant('2026-09-12', '00:00', TZ);
    const to = localWallClockToInstant('2026-09-12', '23:59', TZ);
    expect(generateSlots(config, TZ, 'east-fremantle', from, to)).toHaveLength(0);
  });

  it('generates a stable key, so regenerating does not duplicate sessions', () => {
    const start = localWallClockToInstant('2026-09-11', '18:00', TZ);
    expect(localSessionKey('east-fremantle', start)).toBe(localSessionKey('east-fremantle', new Date(start)));
  });

  it('honours a changed session length', () => {
    const config = { ...CONFIG_DEFAULTS, sessionLengthMinutes: 30, operatingHours: { mon: ['06:00', '08:00'] as [string, string] } };
    const from = localWallClockToInstant('2026-09-07', '00:00', TZ);
    const to = localWallClockToInstant('2026-09-07', '23:59', TZ);
    const slots = generateSlots(config, TZ, 'east-fremantle', from, to);
    expect(slots).toHaveLength(4);
  });
});

describe('booking window', () => {
  it('runs from now to the configured number of days ahead', () => {
    const now = new Date('2026-09-04T02:00:00.000Z');
    const { from, to } = bookingWindow(CONFIG_DEFAULTS, now);
    expect(from).toEqual(now);
    expect(to.toISOString()).toBe('2026-09-18T02:00:00.000Z');
  });
});
