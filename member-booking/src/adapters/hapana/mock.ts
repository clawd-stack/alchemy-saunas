import type { MembershipSource } from './adapter.ts';
import { NotSupported } from './adapter.ts';
import type { HapanaBookingRequest, HapanaBookingResult, HapanaMember, HapanaSession } from './types.ts';

/**
 * Deterministic stand-in for Hapana. Used by the test suite and by
 * `netlify dev` when HAPANA_API_KEY is not set, so the front end and the rules
 * can be worked on without touching the live account.
 */
export interface MockOptions {
  members?: HapanaMember[];
  sessions?: HapanaSession[];
  /** Public-channel occupancy keyed by external session id. */
  publicBooked?: Record<string, number>;
  /** Pattern A when true; when false, createBooking throws NotSupported. */
  supportsWrites?: boolean;
  /** Simulates the Hapana outage path in PRD 8 and acceptance criterion 10. */
  unavailable?: boolean;
}

export class MockUnavailable extends Error {
  constructor() {
    super('Hapana unreachable (mock)');
    this.name = 'HapanaUnavailable';
  }
}

export function createMockHapana(options: MockOptions = {}): MembershipSource & {
  setUnavailable(value: boolean): void;
  setPublicBooked(sessionId: string, value: number): void;
  bookings: Array<HapanaBookingRequest & { externalBookingId: string }>;
} {
  const members = options.members ?? [];
  const sessions = options.sessions ?? [];
  const publicBooked = { ...(options.publicBooked ?? {}) };
  const bookings: Array<HapanaBookingRequest & { externalBookingId: string }> = [];
  let unavailable = options.unavailable ?? false;
  let counter = 0;

  function guard(): void {
    if (unavailable) throw new MockUnavailable();
  }

  return {
    name: 'hapana-mock',
    bookings,
    setUnavailable(value: boolean) {
      unavailable = value;
    },
    setPublicBooked(sessionId: string, value: number) {
      publicBooked[sessionId] = value;
    },
    async findMemberByEmail(email: string): Promise<HapanaMember | null> {
      guard();
      return members.find((m) => m.email.toLowerCase() === email.toLowerCase()) ?? null;
    },
    async getMember(memberId: string): Promise<HapanaMember | null> {
      guard();
      return members.find((m) => m.memberId === memberId) ?? null;
    },
    async listMembers(_since?: Date): Promise<HapanaMember[]> {
      guard();
      return [...members];
    },
    async listSessions(_venueId: string, from: Date, to: Date): Promise<HapanaSession[]> {
      guard();
      return sessions.filter((s) => s.startsAt >= from && s.startsAt <= to);
    },
    async publicBookedFor(_venueId: string, externalSessionId: string): Promise<number | null> {
      guard();
      return publicBooked[externalSessionId] ?? 0;
    },
    async createBooking(request: HapanaBookingRequest): Promise<HapanaBookingResult> {
      guard();
      if (!options.supportsWrites) throw new NotSupported('createBooking');
      counter += 1;
      const externalBookingId = `mock-booking-${counter}`;
      bookings.push({ ...request, externalBookingId });
      return { externalBookingId };
    },
    async cancelBooking(externalBookingId: string): Promise<void> {
      guard();
      if (!options.supportsWrites) throw new NotSupported('cancelBooking');
      const index = bookings.findIndex((b) => b.externalBookingId === externalBookingId);
      if (index >= 0) bookings.splice(index, 1);
    },
  };
}
