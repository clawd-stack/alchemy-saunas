import { describe, expect, it } from 'vitest';
import { CONFIG_DEFAULTS, materialise, updateConfig, validate } from '../src/lib/config.ts';
import { createMemoryStore } from '../src/store/memory.ts';

/**
 * Configuration bounds, PRD 5.7 and acceptance criterion 5.
 * The screen must make it impossible to set an allocation that breaches the
 * ceiling, so this is enforcement, not advice.
 */

describe('config validation', () => {
  it('accepts the shipped defaults', () => {
    expect(validate(CONFIG_DEFAULTS)).toEqual([]);
  });

  it('rejects an allocation that would breach the venue ceiling', () => {
    const issues = validate({ ...CONFIG_DEFAULTS, memberChannelCapacity: 25 });
    expect(issues).toHaveLength(1);
    expect(issues[0]?.key).toBe('member_channel_capacity');
    expect(issues[0]?.message).toContain('above the venue maximum');
  });

  it('rejects lowering the venue maximum below what is already allocated', () => {
    const issues = validate({ ...CONFIG_DEFAULTS, venueMaximum: 25 });
    expect(issues.some((issue) => issue.key === 'member_channel_capacity')).toBe(true);
  });

  it('accepts an allocation that exactly fills the ceiling', () => {
    expect(validate({ ...CONFIG_DEFAULTS, memberChannelCapacity: 20 })).toEqual([]);
  });

  it('rejects nonsense values', () => {
    const issues = validate({
      ...CONFIG_DEFAULTS,
      bookingWindowDays: 0,
      cancellationCutoffHours: -1,
      guestPrice: -5,
      maxGuestsPerMember: 99,
    });
    expect(issues.map((issue) => issue.key).sort()).toEqual([
      'booking_window_days',
      'cancellation_cutoff_hours',
      'guest_price',
      'max_guests_per_member',
    ]);
  });
});

describe('config writes', () => {
  it('refuses the write and reports the issue rather than half-applying it', async () => {
    const store = createMemoryStore();
    const { config, issues } = await updateConfig(store, { member_channel_capacity: 25 }, 'james@example.com');
    expect(issues).toHaveLength(1);
    expect(config.memberChannelCapacity).toBe(CONFIG_DEFAULTS.memberChannelCapacity);
    expect(await store.config.all()).toEqual([]);
  });

  it('requires a documented source before the venue maximum can change', async () => {
    const store = createMemoryStore();
    const refused = await updateConfig(store, { venue_maximum: 60 }, 'james@example.com');
    expect(refused.issues[0]?.message).toContain('documented source');

    const accepted = await updateConfig(
      store,
      { venue_maximum: 60 },
      'james@example.com',
      'Certificate of approval TOEF-2026-0142, Town of East Fremantle',
    );
    expect(accepted.issues).toEqual([]);
    expect(accepted.config.venueMaximum).toBe(60);
  });

  it('applies a valid change immediately', async () => {
    const store = createMemoryStore();
    const { config, issues } = await updateConfig(store, { booking_window_days: 21 }, 'james@example.com');
    expect(issues).toEqual([]);
    expect(config.bookingWindowDays).toBe(21);
  });

  it('rejects an unknown setting rather than silently ignoring it', async () => {
    const store = createMemoryStore();
    await expect(updateConfig(store, { not_a_setting: 1 }, 'james@example.com')).rejects.toMatchObject({
      code: 'CONFIG_INVALID',
    });
  });
});

describe('config materialisation', () => {
  it('falls back to defaults for anything not stored', () => {
    const config = materialise([
      { key: 'member_channel_capacity', value: 8, updatedAt: '', updatedBy: null, sourceNote: null },
    ]);
    expect(config.memberChannelCapacity).toBe(8);
    expect(config.venueMaximum).toBe(CONFIG_DEFAULTS.venueMaximum);
  });
});
