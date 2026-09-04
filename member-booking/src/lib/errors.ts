/**
 * Refusal codes. Every rule in PRD 5.3 fails with a distinct code so the UI can
 * say something specific, with one deliberate exception: every membership
 * failure (unknown email, paused, suspended, cancelled) collapses to
 * NO_ACTIVE_MEMBERSHIP so the endpoint cannot be used to probe whether an
 * address is a member. PRD 5.1.
 */
export const REFUSAL = {
  NO_ACTIVE_MEMBERSHIP: {
    status: 403,
    message: "We couldn't find an active Alchemy membership for that email. If you think this is wrong, contact the venue.",
  },
  GUEST_COUNT_OUT_OF_RANGE: {
    status: 400,
    message: 'You can bring up to 3 guests, so 1 to 4 spots in total.',
  },
  GUEST_DETAILS_INCOMPLETE: {
    status: 400,
    message: 'Each guest needs a full name and an email address so we can send their waiver.',
  },
  ALREADY_BOOKED: {
    status: 409,
    message: 'You already have a booking for this session. Cancel it first if you need to change the number of spots.',
  },
  SESSION_FULL: {
    status: 409,
    message: 'That session just filled up. Please choose another time.',
  },
  VENUE_CEILING: {
    status: 409,
    message: 'That session is at venue capacity. Please choose another time.',
  },
  SESSION_CLOSED: {
    status: 409,
    message: 'That session is not available for booking.',
  },
  SESSION_NOT_FOUND: {
    status: 404,
    message: 'That session is no longer available. Please refresh and choose another time.',
  },
  OUTSIDE_BOOKING_WINDOW: {
    status: 400,
    message: 'You can book up to 14 days ahead. Please choose an earlier session.',
  },
  SESSION_IN_PAST: {
    status: 400,
    message: 'That session has already started.',
  },
  PAST_CUTOFF: {
    status: 409,
    message: 'Cancellations close 3 hours before the session starts. Please contact the venue on (08) 0000 0000 and we will sort it out.',
  },
  OCCUPANCY_UNKNOWN: {
    status: 503,
    message: 'Bookings are briefly unavailable while we confirm capacity. Please try again in a few minutes.',
  },
  BACKEND_UNAVAILABLE: {
    status: 503,
    message: 'Bookings are temporarily unavailable. Please try again shortly.',
  },
  NOT_FOUND: { status: 404, message: 'Not found.' },
  UNAUTHENTICATED: { status: 401, message: 'Please sign in again.' },
  FORBIDDEN: { status: 403, message: 'You do not have access to this.' },
  RATE_LIMITED: { status: 429, message: 'Too many attempts. Please wait a few minutes and try again.' },
  INVALID_REQUEST: { status: 400, message: 'That request was not valid.' },
  CONFIG_INVALID: { status: 400, message: 'That configuration value is not allowed.' },
  INTERNAL: { status: 500, message: 'Something went wrong at our end. Please try again.' },
} as const;

export type RefusalCode = keyof typeof REFUSAL;

export class BookingError extends Error {
  readonly code: RefusalCode;
  readonly status: number;
  readonly userMessage: string;
  readonly detail: unknown;

  constructor(code: RefusalCode, detail?: unknown, overrideMessage?: string) {
    const spec = REFUSAL[code];
    super(`${code}: ${spec.message}`);
    this.name = 'BookingError';
    this.code = code;
    this.status = spec.status;
    this.userMessage = overrideMessage ?? spec.message;
    this.detail = detail ?? null;
  }
}

export function isRefusalCode(value: string): value is RefusalCode {
  return Object.prototype.hasOwnProperty.call(REFUSAL, value);
}

/** Maps a refusal code returned by a database function into an error. */
export function refusalFromDb(code: string, detail?: unknown): BookingError {
  return new BookingError(isRefusalCode(code) ? code : 'INTERNAL', detail);
}
