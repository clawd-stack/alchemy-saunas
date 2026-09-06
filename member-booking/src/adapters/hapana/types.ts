import type { MembershipStatus } from '../../store/types.ts';

/**
 * Hapana domain types as this build needs them, not as Hapana returns them.
 * Everything Hapana-shaped is mapped in mapping.ts and nowhere else, so when
 * the live field names are confirmed there is exactly one file to change.
 */

export interface HapanaMember {
  memberId: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  status: MembershipStatus;
  homeVenueId: string | null;
}

export interface HapanaSession {
  externalSessionId: string;
  venueId: string;
  startsAt: Date;
  endsAt: Date;
  /** Spots sold through the public channel, or null when Hapana did not say. */
  booked: number | null;
  capacity: number | null;
  classId: string | null;
  name: string | null;
}

export interface HapanaBookingRequest {
  externalSessionId: string;
  memberId: string;
  spots: number;
  reference: string;
}

export interface HapanaBookingResult {
  externalBookingId: string;
}

/**
 * What reading the API's documentation established. Recorded by hand
 * and pasted into docs/hapana-findings.md; the adapter reads only
 * canCreateBookings, via config, to choose Pattern A or Pattern B.
 */
export interface HapanaCapabilityReport {
  probedAt: string;
  baseUrl: string;
  authScheme: string;
  canReadMembers: boolean;
  canReadSessions: boolean;
  canCreateBookings: boolean;
  exposesPausedAndSuspended: boolean;
  hiddenClassesBookableViaApi: boolean | null;
  respectsClassCapacity: boolean | null;
  webhookEvents: string[];
  notes: string[];
}
