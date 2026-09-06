import { hapanaRequest, HapanaUnavailable } from './client.ts';
import { mapMember, mapSession, unwrapList, unwrapObject } from './mapping.ts';
import type { HapanaBookingRequest, HapanaBookingResult, HapanaMember, HapanaSession } from './types.ts';

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
  /**
   * Everything changed on or after `since`, or the whole membership when it is
   * omitted. Used by the scheduled sync.
   */
  listMembers(since?: Date): Promise<HapanaMember[]>;
  /** Sessions in a window, with public-channel occupancy where Hapana reports it. */
  listSessions(venueId: string, from: Date, to: Date): Promise<HapanaSession[]>;
  /** Public-channel occupancy for one session, or null when it cannot be established. */
  publicBookedFor(venueId: string, externalSessionId: string): Promise<number | null>;
  /**
   * Always throws against Hapana: the published API has no booking-create
   * endpoint, and this channel owns its own inventory. Kept on the interface
   * because a future backend may have one, and because the mock exercises the
   * caller's release-the-local-spot path.
   */
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
 * The paths, read from Hapana's documentation on 2026-09-06. They were
 * configurable through HAPANA_PATH_* while they were guesses; they are not
 * guesses any more, and an override that lets somebody point this at a path
 * that does not exist is worth less than the line it takes to read.
 *
 * Hapana's vocabulary is "client" where ours is "member". The mapping between
 * the two lives in mapping.ts and nowhere else.
 */
const CLIENTS = 'v2/customer/client';
const SESSIONS = 'v2/site/sessions';
const SESSION_DETAIL = 'v2/site/sessionDetail';

/** GET /v2/site/sessions refuses a range wider than this. */
const SESSION_WINDOW_DAYS = 15;

/** Hapana wants Y-m-d H:i:s for lastModifiedDate, and YYYY-MM-DD for session dates. */
function asDateTime(value: Date): string {
  return value.toISOString().slice(0, 19).replace('T', ' ');
}

function asDate(value: Date): string {
  return value.toISOString().slice(0, 10);
}

/** The 15 day windows a range has to be cut into. */
export function sessionWindows(from: Date, to: Date): Array<{ from: Date; to: Date }> {
  const windows: Array<{ from: Date; to: Date }> = [];
  const span = SESSION_WINDOW_DAYS * 86_400_000;
  let start = from;
  // Bounded: a booking window is 14 days by default, and the guard stops a bad
  // range from spinning inside a scheduled function.
  while (start < to && windows.length < 32) {
    const end = new Date(Math.min(start.getTime() + span, to.getTime()));
    windows.push({ from: start, to: end });
    start = new Date(end.getTime() + 1);
  }
  return windows;
}

export function createHapanaAdapter(): MembershipSource {
  return {
    name: 'hapana',

    async findMemberByEmail(email: string): Promise<HapanaMember | null> {
      // The endpoint filters by email itself, so this is one call and no
      // client-side scanning. The equality check below still stands, because a
      // filter we did not write is not a filter we should trust with sign-in.
      const body = await hapanaRequest(CLIENTS, { query: { email } });
      for (const row of unwrapList(body)) {
        const member = mapMember(row);
        if (member && member.email === email.toLowerCase()) return member;
      }
      return null;
    },

    async getMember(): Promise<HapanaMember | null> {
      // There is no lookup by client id in the published API. Callers that
      // hold an id resolve the address first and come back through
      // findMemberByEmail; see verifyMemberById.
      throw new NotSupported('lookup by member id');
    },

    async listMembers(since?: Date): Promise<HapanaMember[]> {
      // No pagination parameters exist on this endpoint at all: it returns
      // everything. The page/limit loop this replaces would have been ignored
      // and the loop would have read the same first response fifty times.
      //
      // lastModifiedDate returns everything changed on or after that moment,
      // which is what makes a scheduled sync cheap rather than a full pull.
      const body = await hapanaRequest(CLIENTS, {
        query: since ? { lastModifiedDate: asDateTime(since) } : {},
        // A full membership is a bigger response than a single lookup.
        timeoutMs: 20_000,
      });
      const members: HapanaMember[] = [];
      for (const row of unwrapList(body)) {
        const member = mapMember(row);
        if (member) members.push(member);
      }
      return members;
    },

    async listSessions(venueId: string, from: Date, to: Date): Promise<HapanaSession[]> {
      // Dates, not timestamps, and never a range wider than 15 days.
      const sessions: HapanaSession[] = [];
      for (const window of sessionWindows(from, to)) {
        const body = await hapanaRequest(SESSIONS, {
          query: { startDate: asDate(window.from), endDate: asDate(window.to) },
        });
        for (const row of unwrapList(body)) {
          const session = mapSession(row, venueId);
          if (session) sessions.push(session);
        }
      }
      return sessions;
    },

    async publicBookedFor(venueId: string, externalSessionId: string): Promise<number | null> {
      try {
        const body = await hapanaRequest(SESSION_DETAIL, { query: { sessionID: externalSessionId } });
        const session = mapSession(unwrapObject(body), venueId);
        return session?.booked ?? null;
      } catch (error) {
        if (error instanceof HapanaUnavailable) throw error;
        return null;
      }
    },

    async createBooking(): Promise<HapanaBookingResult> {
      // Not a configuration this deployment happens to lack. The published
      // API has 18 endpoints and none of them creates a booking, so there is
      // nothing to switch on. This channel owns its own inventory, which is
      // the only arrangement available and, as it happens, the one that makes
      // overselling the room impossible.
      throw new NotSupported('creating a booking');
    },

    async cancelBooking(): Promise<void> {
      throw new NotSupported('cancelling a booking');
    },
  };
}

/**
 * A membership source that answers nothing, for a deployment with no Hapana
 * credentials configured.
 *
 * This replaces an earlier guard that refused to build the request context at
 * all when HAPANA_API_KEY was missing in production. The intent was right, and
 * the effect was not: membership is resolved once per request for every
 * endpoint, so a missing key took down sign-in, the door list and the very
 * configuration screen an operator would use to fix it. A deployment cannot
 * bootstrap itself out of a failure that blocks the whole API.
 *
 * The safety property the guard existed for is preserved exactly, and by a
 * stricter route. The danger was serving members from the mock, which answers
 * "yes, a member" to anything. This answers nothing at all: every lookup raises
 * the same outage the codebase already knows how to degrade through, so
 * verifyMemberByEmail falls through to the cache, finds it empty, and refuses.
 * No member signs in and no booking is taken, while staff and admin, who never
 * touch this source, can sign in and set the key.
 */
export function createUnavailableMembership(reason: string): MembershipSource {
  const refuse = (): never => {
    throw new HapanaUnavailable(reason);
  };

  return {
    name: 'unavailable',
    async findMemberByEmail(): Promise<HapanaMember | null> {
      return refuse();
    },
    async getMember(): Promise<HapanaMember | null> {
      return refuse();
    },
    async listMembers(_since?: Date): Promise<HapanaMember[]> {
      return refuse();
    },
    async listSessions(): Promise<HapanaSession[]> {
      return refuse();
    },
    async publicBookedFor(): Promise<number | null> {
      return refuse();
    },
    async createBooking(): Promise<HapanaBookingResult> {
      return refuse();
    },
    async cancelBooking(): Promise<void> {
      return refuse();
    },
  };
}
