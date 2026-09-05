import { BookingError } from './errors.ts';
import { DEFAULT_WAIVER_TEXT, WAIVER_VERSION, type WaiverText } from './waiver-text.ts';
import type { ConfigEntry, Store } from '../store/types.ts';

/**
 * The configuration store, PRD 5.7.
 *
 * Two jobs. First, give the rest of the codebase one typed view of the tunable
 * values, so no rule is expressed in more than one place. Second, refuse any
 * change that would breach the venue ceiling. The bound on
 * member_channel_capacity is a validation rule, not a note: the admin screen
 * must make it impossible to set an allocation that oversells the room.
 */

export interface AppConfig {
  /**
   * Optional venue-wide ceiling across all channels. Null means not enforced,
   * which is the shipped default: this channel owns a fixed allocation of
   * spots per hour, and that allocation is the constraint that governs it.
   * Set a number here only if there is a documented occupancy limit to hold.
   */
  venueMaximum: number | null;
  hapanaPublicCapacity: number;
  memberChannelCapacity: number;
  bookingWindowDays: number;
  cancellationCutoffHours: number;
  maxGuestsPerMember: number;
  memberSessionDays: number;
  guestPrice: number;
  sessionLengthMinutes: number;
  waiverVersion: string;
  waiverText: WaiverText;
  operatingHours: Record<string, [string, string]>;
  bookingBackend: 'local' | 'hapana';
  /**
   * Where a member writes when the screen cannot help them. Empty hides the
   * link rather than showing one that goes nowhere.
   */
  supportEmail: string;
}

export const CONFIG_DEFAULTS: AppConfig = {
  venueMaximum: null,
  hapanaPublicCapacity: 0,
  memberChannelCapacity: 10,
  bookingWindowDays: 14,
  cancellationCutoffHours: 3,
  maxGuestsPerMember: 3,
  // Long by design. Without email a member cannot re-request a link on their
  // own, so a sign-in handed over at the venue has to keep working.
  memberSessionDays: 30,
  guestPrice: 35,
  sessionLengthMinutes: 60,
  waiverVersion: WAIVER_VERSION,
  waiverText: DEFAULT_WAIVER_TEXT,
  // 5am to 9pm, seven days. With 60 minute sessions the last one starts at
  // 8pm and ends as the venue closes.
  operatingHours: {
    mon: ['05:00', '21:00'],
    tue: ['05:00', '21:00'],
    wed: ['05:00', '21:00'],
    thu: ['05:00', '21:00'],
    fri: ['05:00', '21:00'],
    sat: ['05:00', '21:00'],
    sun: ['05:00', '21:00'],
  },
  bookingBackend: 'local',
  // The venue's address, confirmed. Still editable in Settings: it is the
  // kind of thing that changes without anybody thinking to open a PR.
  supportEmail: 'support@alchemysaunas.com.au',
};

const KEY_MAP: Record<string, keyof AppConfig> = {
  venue_maximum: 'venueMaximum',
  hapana_public_capacity: 'hapanaPublicCapacity',
  member_channel_capacity: 'memberChannelCapacity',
  booking_window_days: 'bookingWindowDays',
  cancellation_cutoff_hours: 'cancellationCutoffHours',
  max_guests_per_member: 'maxGuestsPerMember',
  member_session_days: 'memberSessionDays',
  guest_price: 'guestPrice',
  session_length_minutes: 'sessionLengthMinutes',
  waiver_version: 'waiverVersion',
  waiver_text: 'waiverText',
  operating_hours: 'operatingHours',
  booking_backend: 'bookingBackend',
  support_email: 'supportEmail',
};

export const CONFIG_KEYS = Object.keys(KEY_MAP);

export function configKeyFor(field: keyof AppConfig): string {
  const entry = Object.entries(KEY_MAP).find(([, value]) => value === field);
  if (!entry) throw new Error(`No config key for field ${String(field)}`);
  return entry[0];
}

/** Merges stored rows over the defaults. Unknown keys are ignored, not fatal. */
export function materialise(entries: ConfigEntry[]): AppConfig {
  const config: AppConfig = { ...CONFIG_DEFAULTS };
  for (const entry of entries) {
    const field = KEY_MAP[entry.key];
    if (!field) continue;
    (config as unknown as Record<string, unknown>)[field] = entry.value;
  }
  return config;
}

export interface ValidationIssue {
  key: string;
  message: string;
}

/**
 * Whole-config validation. Called on every write with the proposed value
 * already applied, so a change is judged against the config it would create
 * rather than the one it replaces.
 */
export function validate(config: AppConfig): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const positiveInt = (value: unknown) => Number.isInteger(value) && (value as number) > 0;

  if (config.venueMaximum !== null && !positiveInt(config.venueMaximum)) {
    issues.push({ key: 'venue_maximum', message: 'Venue maximum must be a whole number above zero, or left blank for no ceiling.' });
  }
  if (!Number.isInteger(config.hapanaPublicCapacity) || config.hapanaPublicCapacity < 0) {
    issues.push({ key: 'hapana_public_capacity', message: 'Public capacity must be zero or a whole number.' });
  }
  if (!Number.isInteger(config.memberChannelCapacity) || config.memberChannelCapacity < 0) {
    issues.push({ key: 'member_channel_capacity', message: 'Member channel capacity must be zero or a whole number.' });
  }

  // The bound that matters, when a ceiling is configured at all: public plus
  // member allocation may never exceed it, whichever value is being edited.
  if (
    config.venueMaximum !== null &&
    Number.isInteger(config.memberChannelCapacity) &&
    Number.isInteger(config.hapanaPublicCapacity) &&
    Number.isInteger(config.venueMaximum) &&
    config.memberChannelCapacity + config.hapanaPublicCapacity > config.venueMaximum
  ) {
    issues.push({
      key: 'member_channel_capacity',
      message:
        `Public capacity (${config.hapanaPublicCapacity}) plus member channel capacity ` +
        `(${config.memberChannelCapacity}) is ${config.hapanaPublicCapacity + config.memberChannelCapacity}, ` +
        `which is above the venue maximum of ${config.venueMaximum}. Reduce one of them.`,
    });
  }

  if (!positiveInt(config.bookingWindowDays) || config.bookingWindowDays > 365) {
    issues.push({ key: 'booking_window_days', message: 'Booking window must be between 1 and 365 days.' });
  }
  if (!Number.isInteger(config.cancellationCutoffHours) || config.cancellationCutoffHours < 0 || config.cancellationCutoffHours > 168) {
    issues.push({ key: 'cancellation_cutoff_hours', message: 'Cancellation cutoff must be between 0 and 168 hours.' });
  }
  if (!Number.isInteger(config.maxGuestsPerMember) || config.maxGuestsPerMember < 0 || config.maxGuestsPerMember > 10) {
    issues.push({ key: 'max_guests_per_member', message: 'Guests per member must be between 0 and 10.' });
  }
  // Deliberately loose: enough to catch a stray word or a missing @, not
  // enough to argue with a valid address it has not heard of.
  if (typeof config.supportEmail !== 'string' || (config.supportEmail !== '' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(config.supportEmail))) {
    issues.push({ key: 'support_email', message: 'Support email must be an email address, or blank to hide the link.' });
  }
  if (!Number.isInteger(config.memberSessionDays) || config.memberSessionDays < 1 || config.memberSessionDays > 365) {
    issues.push({ key: 'member_session_days', message: 'Member sign-in must last between 1 and 365 days.' });
  }
  if (typeof config.guestPrice !== 'number' || config.guestPrice < 0) {
    issues.push({ key: 'guest_price', message: 'Guest price must be zero or more.' });
  }
  if (!positiveInt(config.sessionLengthMinutes) || config.sessionLengthMinutes > 480) {
    issues.push({ key: 'session_length_minutes', message: 'Session length must be between 1 and 480 minutes.' });
  }
  if (config.bookingBackend !== 'local' && config.bookingBackend !== 'hapana') {
    issues.push({ key: 'booking_backend', message: "Booking backend must be 'local' or 'hapana'." });
  }
  const waiver = config.waiverText;
  if (!waiver || typeof waiver !== 'object') {
    issues.push({ key: 'waiver_text', message: 'Waiver text must be an object.' });
  } else {
    if (!waiver.declaration?.trim()) {
      issues.push({ key: 'waiver_text', message: 'The waiver needs a declaration line for the guest to agree to.' });
    }
    if (!Array.isArray(waiver.clauses) || waiver.clauses.length === 0) {
      issues.push({ key: 'waiver_text', message: 'The waiver needs at least one clause.' });
    }
    if (waiver.termsUrl && !/^https:\/\//.test(waiver.termsUrl)) {
      issues.push({ key: 'waiver_text', message: 'The terms link must be an https URL.' });
    }
  }

  for (const [day, hours] of Object.entries(config.operatingHours ?? {})) {
    if (!Array.isArray(hours) || hours.length !== 2 || !/^\d{2}:\d{2}$/.test(hours[0] ?? '') || !/^\d{2}:\d{2}$/.test(hours[1] ?? '')) {
      issues.push({ key: 'operating_hours', message: `Operating hours for ${day} must be ["HH:MM", "HH:MM"].` });
    }
  }
  return issues;
}

/**
 * Raising the ceiling requires a documented source. The build hardcodes a
 * number that staff rely on, so it must trace to the certificate of approval
 * rather than to a conversation.
 */
export function requiresSourceNote(key: string, currentValue: unknown, nextValue: unknown): boolean {
  if (key !== 'venue_maximum') return false;
  // Clearing the ceiling needs no source; setting or raising one does, because
  // staff will then rely on the number.
  if (nextValue === null || nextValue === undefined || nextValue === '') return false;
  return Number(nextValue) !== Number(currentValue);
}

export async function loadConfig(store: Store): Promise<AppConfig> {
  return materialise(await store.config.all());
}

export async function updateConfig(
  store: Store,
  updates: Record<string, unknown>,
  actor: string,
  sourceNote?: string | null,
): Promise<{ config: AppConfig; issues: ValidationIssue[] }> {
  const entries = await store.config.all();
  const current = materialise(entries);
  const proposed: AppConfig = { ...current };

  for (const [key, value] of Object.entries(updates)) {
    const field = KEY_MAP[key];
    if (!field) throw new BookingError('CONFIG_INVALID', { key, message: `Unknown setting: ${key}` });
    (proposed as unknown as Record<string, unknown>)[field] = value;
  }

  const issues = validate(proposed);
  if (issues.length > 0) return { config: current, issues };

  for (const [key, value] of Object.entries(updates)) {
    const field = KEY_MAP[key]!;
    if (requiresSourceNote(key, current[field], value) && !sourceNote?.trim()) {
      return {
        config: current,
        issues: [{
          key,
          message: 'Changing the venue maximum requires a documented source, for example the certificate of approval reference.',
        }],
      };
    }
    await store.config.set(key, value, actor, sourceNote ?? null);
  }

  return { config: await loadConfig(store), issues: [] };
}
