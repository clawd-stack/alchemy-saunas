import { afterEach, describe, expect, it } from 'vitest';
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

  it('leaves the ceiling unenforced by default, so any sane allocation is allowed', () => {
    // Shipped default is no venue-wide ceiling: the spots-per-hour allocation
    // is the only limit, so a larger allocation is not a validation error.
    expect(CONFIG_DEFAULTS.venueMaximum).toBeNull();
    expect(validate({ ...CONFIG_DEFAULTS, memberChannelCapacity: 25 })).toEqual([]);
  });

  it('rejects an allocation that would breach a ceiling once one is set', () => {
    const withCeiling = { ...CONFIG_DEFAULTS, venueMaximum: 40, hapanaPublicCapacity: 20 };
    const issues = validate({ ...withCeiling, memberChannelCapacity: 25 });
    expect(issues).toHaveLength(1);
    expect(issues[0]?.key).toBe('member_channel_capacity');
    expect(issues[0]?.message).toContain('above the venue maximum');
  });

  it('rejects lowering a ceiling below what is already allocated', () => {
    const withCeiling = { ...CONFIG_DEFAULTS, venueMaximum: 40, hapanaPublicCapacity: 20 };
    const issues = validate({ ...withCeiling, venueMaximum: 25 });
    expect(issues.some((issue) => issue.key === 'member_channel_capacity')).toBe(true);
  });

  it('accepts an allocation that exactly fills a configured ceiling', () => {
    const withCeiling = { ...CONFIG_DEFAULTS, venueMaximum: 40, hapanaPublicCapacity: 20 };
    expect(validate({ ...withCeiling, memberChannelCapacity: 20 })).toEqual([]);
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
    await store.config.set('venue_maximum', 40, 'setup');
    await store.config.set('hapana_public_capacity', 20, 'setup');

    const { config, issues } = await updateConfig(store, { member_channel_capacity: 25 }, 'james@example.com');
    expect(issues).toHaveLength(1);
    // The rejected value must not have been written.
    expect(config.memberChannelCapacity).toBe(CONFIG_DEFAULTS.memberChannelCapacity);
    const stored = await store.config.all();
    expect(stored.find((entry) => entry.key === 'member_channel_capacity')).toBeUndefined();
  });

  it('lets a ceiling be cleared without a documented source', async () => {
    const store = createMemoryStore();
    await store.config.set('venue_maximum', 40, 'setup', 'Certificate TOEF-1');

    const { config, issues } = await updateConfig(store, { venue_maximum: null }, 'james@example.com');
    expect(issues).toEqual([]);
    expect(config.venueMaximum).toBeNull();
  });

  it('requires a documented source before a venue ceiling can be set', async () => {
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

describe('email provider selection', () => {
  const original = { ...process.env };
  afterEach(() => {
    process.env = { ...original };
  });

  it('defaults to console, which delivers nothing', async () => {
    delete process.env.EMAIL_PROVIDER;
    const { createProvider } = await import('../src/lib/email.ts');
    expect(createProvider().name).toBe('console');
  });

  it('selects SMTP, so a mailbox the business already owns can be used', async () => {
    process.env.EMAIL_PROVIDER = 'smtp';
    const { createProvider } = await import('../src/lib/email.ts');
    expect(createProvider().name).toBe('smtp');
  });

  it('refuses an unknown provider rather than silently sending nothing', async () => {
    process.env.EMAIL_PROVIDER = 'carrier-pigeon';
    const { createProvider } = await import('../src/lib/email.ts');
    expect(() => createProvider()).toThrow(/Unsupported EMAIL_PROVIDER/);
  });
});

describe('support email', () => {
  it('accepts an address, and blank to hide the link', () => {
    expect(validate({ ...CONFIG_DEFAULTS, supportEmail: 'hello@alchemysaunas.com.au' })).toHaveLength(0);
    // Blank is not a mistake: it is how the link is turned off.
    expect(validate({ ...CONFIG_DEFAULTS, supportEmail: '' })).toHaveLength(0);
  });

  it('refuses something that is not an address', () => {
    // A link that bounces is worse than no link, because the member thinks
    // they were ignored rather than unheard.
    for (const bad of ['the front desk', 'hello@', '@example.com', 'hello@example']) {
      const issues = validate({ ...CONFIG_DEFAULTS, supportEmail: bad });
      expect(issues.map((i) => i.key), bad).toContain('support_email');
    }
  });
});
