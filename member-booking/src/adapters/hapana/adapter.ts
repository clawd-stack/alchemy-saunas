import { hapanaRequest, HapanaUnavailable } from './client.ts';
import { mapBookingId, mapMember, mapSession, unwrapList, unwrapObject } from './mapping.ts';
import type { HapanaBookingRequest, HapanaBookingResult, HapanaMember, HapanaSession } from './types.ts';
import { env } from '../../lib/env.ts';

/**
 * The Hapana adapter. Everything the rest of the build knows about Hapana is
 * behind this interface, so a future Forge migration swaps this file and
 * nothing else. PRD 8, portability.
 */
export interface MembershipSource {
  readonly name: string;
  /** Live membership lookup. Returns null when the address is not a member. */
  findMemberByEmail(email: string): Promise<HapanaMember | null>;
  getMember(memberId: string): Promise<HapanaMember | null>;
  /** Full list, used by the Pattern B scheduled sync. */
  listMembers(): Promise<HapanaMember[]>;
  /** Sessions in a window, with public-channel occupancy where Hapana reports it. */
  listSessions(venueId: string, from: Date, to: Date): Promise<HapanaSession[]>;
  /** Public-channel occupancy for one session, or null when it cannot be established. */
  publicBookedFor(venueId: string, externalSessionId: string): Promise<number | null>;
  /** Pattern A only. Throws NotSupported when the API is read-only. */
  createBooking(request: HapanaBookingRequest): Promise<HapanaBookingResult>;
  cancelBooking(externalBookingId: string): Promise<void>;
}

export class NotSupported extends Error {
  constructor(operation: string) {
    super(`Hapana adapter does not support ${operation} in this configuration`);
    this.name = 'NotSupported';
  }
}

/**
 * Endpoint paths are configurable for the same reason the auth style is: the
 * live endpoint list could not be read from the build environment. Defaults are
 * the most likely shapes; the probe script prints the ones that answered.
 */
function path(name: string, fallback: string): string {
  return process.env[`HAPANA_PATH_${name}`] ?? fallback;
}

export function createHapanaAdapter(): MembershipSource {
  return {
    name: 'hapana',

    async findMemberByEmail(email: string): Promise<HapanaMember | null> {
      const body = await hapanaRequest(path('MEMBERS', 'v1/members'), {
        query: { email, siteID: env.hapanaSiteId || undefined, limit: 5 },
      });
      const rows = unwrapList(body);
      for (const row of rows) {
        const member = mapMember(row);
        if (member && member.email === email.toLowerCase()) return member;
      }
      return null;
    },

    async getMember(memberId: string): Promise<HapanaMember | null> {
      const body = await hapanaRequest(`${path('MEMBERS', 'v1/members')}/${encodeURIComponent(memberId)}`);
      return mapMember(unwrapObject(body));
    },

    async listMembers(): Promise<HapanaMember[]> {
      const members: HapanaMember[] = [];
      let page = 1;
      // Bounded so a paging bug cannot spin forever inside a scheduled function.
      while (page <= 50) {
        const body = await hapanaRequest(path('MEMBERS', 'v1/members'), {
          query: { siteID: env.hapanaSiteId || undefined, page, limit: 200 },
        });
        const rows = unwrapList(body);
        if (rows.length === 0) break;
        for (const row of rows) {
          const member = mapMember(row);
          if (member) members.push(member);
        }
        if (rows.length < 200) break;
        page += 1;
      }
      return members;
    },

    async listSessions(venueId: string, from: Date, to: Date): Promise<HapanaSession[]> {
      const body = await hapanaRequest(path('SESSIONS', 'v1/sessions'), {
        query: {
          siteID: env.hapanaSiteId || undefined,
          startDate: from.toISOString(),
          endDate: to.toISOString(),
          limit: 500,
        },
      });
      const sessions: HapanaSession[] = [];
      for (const row of unwrapList(body)) {
        const session = mapSession(row, venueId);
        if (session) sessions.push(session);
      }
      return sessions;
    },

    async publicBookedFor(venueId: string, externalSessionId: string): Promise<number | null> {
      try {
        const body = await hapanaRequest(`${path('SESSIONS', 'v1/sessions')}/${encodeURIComponent(externalSessionId)}`);
        const session = mapSession(unwrapObject(body), venueId);
        return session?.booked ?? null;
      } catch (error) {
        if (error instanceof HapanaUnavailable) throw error;
        return null;
      }
    },

    async createBooking(request: HapanaBookingRequest): Promise<HapanaBookingResult> {
      const body = await hapanaRequest(path('BOOKINGS', 'v1/bookings'), {
        method: 'POST',
        body: {
          sessionID: request.externalSessionId,
          memberID: request.memberId,
          spots: request.spots,
          reference: request.reference,
          siteID: env.hapanaSiteId || undefined,
          classID: env.hapanaMemberClassId || undefined,
        },
      });
      const externalBookingId = mapBookingId(unwrapObject(body));
      if (!externalBookingId) throw new Error('Hapana accepted the booking but returned no booking id');
      return { externalBookingId };
    },

    async cancelBooking(externalBookingId: string): Promise<void> {
      await hapanaRequest(`${path('BOOKINGS', 'v1/bookings')}/${encodeURIComponent(externalBookingId)}`, {
        method: 'DELETE',
      });
    },
  };
}
