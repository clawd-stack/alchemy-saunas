import { randomUUID } from 'node:crypto';
import type {
  AuditRow,
  AvailabilityRow,
  BookingRecord,
  BookingStatus,
  CancelBookingInput,
  CancelBookingResult,
  ConfigEntry,
  CreateBookingInput,
  CreateBookingResult,
  CredentialRecord,
  GuestRecord,
  MemberRecord,
  OutboxEntry,
  PaymentStatus,
  StaffRecord,
  Store,
  WaiverRecord,
  WaiverStatus,
} from './types.ts';

/**
 * In-memory store.
 *
 * Used by the test suite and by `netlify dev` when no DATABASE_URL is set, so
 * the front end can be worked on without a database. It reproduces the same
 * rule order and the same serialisation guarantee as db/schema.sql: booking
 * attempts for one session are queued behind a per-session promise chain,
 * which is the JavaScript equivalent of SELECT ... FOR UPDATE.
 *
 * It is not a production store. Nothing here survives a cold start.
 */

interface SessionRow {
  id: string;
  venueId: string;
  externalSessionId: string;
  startsAt: Date;
  endsAt: Date;
  capacityOverride: number | null;
  publicBookedCached: number;
  closed: boolean;
}

interface BookingRow {
  bookingId: string;
  venueId: string;
  sessionId: string;
  startsAt: Date;
  memberId: string;
  memberName: string;
  memberEmail: string;
  spotsTotal: number;
  spotsGuest: number;
  amountOwedAud: number;
  paymentStatus: PaymentStatus;
  status: BookingStatus;
  memberCheckedIn: boolean;
  createdAt: Date;
  cancelledAt: Date | null;
  externalBookingId: string | null;
}

interface GuestRow {
  guestId: string;
  bookingId: string;
  name: string;
  email: string;
  status: BookingStatus;
  checkedIn: boolean;
}

interface WaiverRow {
  waiverId: string;
  tokenHash: string;
  bookingId: string | null;
  guestId: string | null;
  venueId: string;
  sessionStartsAt: Date;
  guestName: string;
  guestEmail: string;
  status: WaiverStatus;
  waiverVersion: string;
  sentAt: Date | null;
  reminderSentAt: Date | null;
  signedAt: Date | null;
  signedName: string | null;
  signature: string | null;
}

export interface MemoryStore extends Store {
  /** Test helper: wipe everything except config, venues and staff. */
  reset(): void;
  /** Test helper: seed a session so availability has something to show. */
  seedSession(input: {
    venueId: string;
    externalSessionId: string;
    startsAt: Date;
    endsAt: Date;
    capacityOverride?: number | null;
    publicBooked?: number;
  }): void;
  seedMember(member: MemberRecord): void;
  seedStaff(staff: StaffRecord): void;
  outboxAll(): OutboxEntry[];
}

export function createMemoryStore(): MemoryStore {
  const sessions: SessionRow[] = [];
  const bookings: BookingRow[] = [];
  const guests: GuestRow[] = [];
  const waivers: WaiverRow[] = [];
  const audit: AuditRow[] = [];
  const config = new Map<string, ConfigEntry>();
  const members = new Map<string, MemberRecord>();
  const staff: StaffRecord[] = [];
  const credentials = new Map<string, CredentialRecord>();
  const tokens = new Map<string, { email: string; memberId: string; expiresAt: Date; consumed: boolean }>();
  const throttleBuckets = new Map<string, { hits: number; windowStart: number }>();
  const outbox: OutboxEntry[] = [];
  const venues = new Map<string, { venueId: string; name: string; timezone: string }>([
    ['east-fremantle', { venueId: 'east-fremantle', name: 'Alchemy East Fremantle', timezone: 'Australia/Perth' }],
  ]);

  /** One promise chain per session id: the lock. */
  const locks = new Map<string, Promise<unknown>>();

  function withSessionLock<T>(key: string, fn: () => Promise<T> | T): Promise<T> {
    const previous = locks.get(key) ?? Promise.resolve();
    const next = previous.then(fn, fn);
    // Keep the chain alive but never let a rejection poison the next waiter.
    locks.set(key, next.then(() => undefined, () => undefined));
    return next;
  }

  function findSession(venueId: string, externalSessionId: string): SessionRow | undefined {
    return sessions.find((s) => s.venueId === venueId && s.externalSessionId === externalSessionId);
  }

  function ensureSession(input: { venueId: string; externalSessionId: string; startsAt: Date; endsAt: Date }): SessionRow {
    const existing = findSession(input.venueId, input.externalSessionId);
    if (existing) return existing;
    const row: SessionRow = {
      id: randomUUID(),
      venueId: input.venueId,
      externalSessionId: input.externalSessionId,
      startsAt: input.startsAt,
      endsAt: input.endsAt,
      capacityOverride: null,
      publicBookedCached: 0,
      closed: false,
    };
    sessions.push(row);
    return row;
  }

  function bookedFor(sessionId: string): number {
    return bookings
      .filter((b) => b.sessionId === sessionId && b.status === 'confirmed')
      .reduce((sum, b) => sum + b.spotsTotal, 0);
  }

  function guestsFor(bookingId: string): GuestRecord[] {
    return guests
      .filter((g) => g.bookingId === bookingId)
      .map((g) => {
        const waiver = waivers.find((w) => w.guestId === g.guestId);
        return {
          guestId: g.guestId,
          bookingId: g.bookingId,
          name: g.name,
          email: g.email,
          status: g.status,
          checkedIn: g.checkedIn,
          waiverStatus: waiver?.status ?? 'not_sent',
          waiverSignedAt: waiver?.signedAt ? waiver.signedAt.toISOString() : null,
        };
      });
  }

  function toRecord(b: BookingRow): BookingRecord {
    const session = sessions.find((s) => s.id === b.sessionId);
    return {
      bookingId: b.bookingId,
      venueId: b.venueId,
      sessionId: b.sessionId,
      externalSessionId: session?.externalSessionId ?? '',
      startsAt: b.startsAt.toISOString(),
      memberId: b.memberId,
      memberName: b.memberName,
      memberEmail: b.memberEmail,
      spotsTotal: b.spotsTotal,
      spotsGuest: b.spotsGuest,
      amountOwedAud: b.amountOwedAud,
      paymentStatus: b.paymentStatus,
      status: b.status,
      memberCheckedIn: b.memberCheckedIn,
      createdAt: b.createdAt.toISOString(),
      cancelledAt: b.cancelledAt ? b.cancelledAt.toISOString() : null,
      externalBookingId: b.externalBookingId,
      guests: guestsFor(b.bookingId),
    };
  }

  function toWaiverRecord(w: WaiverRow): WaiverRecord {
    return {
      waiverId: w.waiverId,
      bookingId: w.bookingId,
      guestId: w.guestId,
      venueId: w.venueId,
      sessionStartsAt: w.sessionStartsAt.toISOString(),
      guestName: w.guestName,
      guestEmail: w.guestEmail,
      status: w.status,
      waiverVersion: w.waiverVersion,
      sentAt: w.sentAt ? w.sentAt.toISOString() : null,
      reminderSentAt: w.reminderSentAt ? w.reminderSentAt.toISOString() : null,
      signedAt: w.signedAt ? w.signedAt.toISOString() : null,
      signature: w.signature,
    };
  }

  function recordAudit(row: Omit<AuditRow, 'eventId' | 'createdAt'>): void {
    audit.push({ ...row, eventId: randomUUID(), createdAt: new Date().toISOString() });
  }

  return {
    bookings: {
      create(input: CreateBookingInput): Promise<CreateBookingResult> {
        const lockKey = `${input.venueId}::${input.externalSessionId}`;
        return withSessionLock(lockKey, () => {
          const guestCount = input.guests.length;
          const requested = 1 + guestCount;

          if (guestCount < 0 || guestCount > input.maxGuests) {
            return {
              ok: false as const,
              code: 'GUEST_COUNT_OUT_OF_RANGE',
              detail: { requestedGuests: guestCount, maxGuests: input.maxGuests },
            };
          }
          for (const guest of input.guests) {
            if (!guest.name?.trim() || !guest.email?.trim()) {
              return { ok: false as const, code: 'GUEST_DETAILS_INCOMPLETE' };
            }
          }

          const session = ensureSession(input);
          if (session.closed) return { ok: false as const, code: 'SESSION_CLOSED' };

          const capacity = session.capacityOverride ?? input.defaultChannelCapacity;
          const booked = bookedFor(session.id);

          if (bookings.some((b) => b.sessionId === session.id && b.memberId === input.memberId && b.status === 'confirmed')) {
            return { ok: false as const, code: 'ALREADY_BOOKED' };
          }

          if (booked + requested > capacity) {
            recordAudit({
              sessionId: session.id, bookingId: null, action: 'refuse', refusalCode: 'SESSION_FULL',
              spotsDelta: 0, memberChannelBookedAfter: booked, memberChannelCapacity: capacity,
              publicBookedAtTime: input.publicBooked, venueTotalBookedAfter: booked + input.publicBooked,
              venueMaximumAtTime: input.venueMaximum,
            });
            return {
              ok: false as const,
              code: 'SESSION_FULL',
              detail: { spotsRemaining: Math.max(capacity - booked, 0), requested },
            };
          }

          // The venue-wide ceiling is optional. When none is configured the
          // channel's own allocation, checked above, is the only limit, and we
          // do not need to know what the public channel has sold.
          const totalAfter = booked + Math.max(input.publicBooked, 0) + requested;
          if (input.venueMaximum !== null) {
            if (input.publicBooked < 0) return { ok: false as const, code: 'OCCUPANCY_UNKNOWN' };
            if (totalAfter > input.venueMaximum) {
              recordAudit({
                sessionId: session.id, bookingId: null, action: 'refuse', refusalCode: 'VENUE_CEILING',
                spotsDelta: 0, memberChannelBookedAfter: booked, memberChannelCapacity: capacity,
                publicBookedAtTime: input.publicBooked, venueTotalBookedAfter: booked + input.publicBooked,
                venueMaximumAtTime: input.venueMaximum,
              });
              return {
                ok: false as const,
                code: 'VENUE_CEILING',
                detail: { venueMaximum: input.venueMaximum, wouldBe: totalAfter },
              };
            }
          }

          const bookingId = randomUUID();
          const amount = Number((guestCount * input.guestPrice).toFixed(2));
          bookings.push({
            bookingId,
            venueId: input.venueId,
            sessionId: session.id,
            startsAt: session.startsAt,
            memberId: input.memberId,
            memberName: input.memberName,
            memberEmail: input.memberEmail,
            spotsTotal: requested,
            spotsGuest: guestCount,
            amountOwedAud: amount,
            paymentStatus: 'outstanding',
            status: 'confirmed',
            memberCheckedIn: false,
            createdAt: new Date(),
            cancelledAt: null,
            externalBookingId: null,
          });
          for (const guest of input.guests) {
            guests.push({
              guestId: randomUUID(),
              bookingId,
              name: guest.name.trim(),
              email: guest.email.trim().toLowerCase(),
              status: 'confirmed',
              checkedIn: false,
            });
          }

          recordAudit({
            sessionId: session.id, bookingId, action: 'book', refusalCode: null,
            spotsDelta: requested, memberChannelBookedAfter: booked + requested,
            memberChannelCapacity: capacity, publicBookedAtTime: input.publicBooked,
            venueTotalBookedAfter: totalAfter, venueMaximumAtTime: input.venueMaximum,
          });

          return {
            ok: true as const,
            bookingId,
            sessionId: session.id,
            startsAt: session.startsAt.toISOString(),
            spotsTotal: requested,
            spotsGuest: guestCount,
            amountOwedAud: amount,
            memberChannelBookedAfter: booked + requested,
            memberChannelCapacity: capacity,
            venueTotalBookedAfter: totalAfter,
          };
        });
      },

      async cancel(input: CancelBookingInput): Promise<CancelBookingResult> {
        const booking = bookings.find((b) => b.bookingId === input.bookingId);
        if (!booking) return { ok: false, code: 'NOT_FOUND' };
        if (input.memberId !== null && booking.memberId !== input.memberId) {
          return { ok: false, code: 'NOT_FOUND' };
        }
        if (booking.status === 'cancelled') {
          return { ok: true, bookingId: booking.bookingId, code: 'ALREADY_CANCELLED' };
        }
        const enforce = input.enforceCutoff ?? true;
        if (enforce && booking.startsAt.getTime() - input.cutoffHours * 3_600_000 <= Date.now()) {
          return {
            ok: false,
            code: 'PAST_CUTOFF',
            detail: { startsAt: booking.startsAt.toISOString(), cutoffHours: input.cutoffHours },
          };
        }
        booking.status = 'cancelled';
        booking.cancelledAt = new Date();
        for (const guest of guests.filter((g) => g.bookingId === booking.bookingId && g.status === 'confirmed')) {
          guest.status = 'cancelled';
        }
        const session = sessions.find((s) => s.id === booking.sessionId)!;
        const booked = bookedFor(booking.sessionId);
        recordAudit({
          sessionId: booking.sessionId, bookingId: booking.bookingId, action: 'cancel', refusalCode: null,
          spotsDelta: -booking.spotsTotal, memberChannelBookedAfter: booked,
          memberChannelCapacity: session.capacityOverride ?? input.defaultChannelCapacity,
          publicBookedAtTime: session.publicBookedCached,
          venueTotalBookedAfter: booked + session.publicBookedCached,
          venueMaximumAtTime: input.venueMaximum,
        });
        return { ok: true, bookingId: booking.bookingId, spotsReleased: booking.spotsTotal, memberChannelBookedAfter: booked };
      },

      async cancelGuest(input): Promise<CancelBookingResult> {
        const guest = guests.find((g) => g.guestId === input.guestId);
        if (!guest || guest.status === 'cancelled') return { ok: false, code: 'NOT_FOUND' };
        const booking = bookings.find((b) => b.bookingId === guest.bookingId);
        if (!booking || booking.memberId !== input.memberId || booking.status !== 'confirmed') {
          return { ok: false, code: 'NOT_FOUND' };
        }
        if (booking.startsAt.getTime() - input.cutoffHours * 3_600_000 <= Date.now()) {
          return { ok: false, code: 'PAST_CUTOFF' };
        }
        guest.status = 'cancelled';
        booking.spotsGuest -= 1;
        booking.spotsTotal -= 1;
        booking.amountOwedAud = Number((booking.spotsGuest * input.guestPrice).toFixed(2));
        const session = sessions.find((s) => s.id === booking.sessionId)!;
        const booked = bookedFor(booking.sessionId);
        recordAudit({
          sessionId: booking.sessionId, bookingId: booking.bookingId, action: 'cancel_guest', refusalCode: null,
          spotsDelta: -1, memberChannelBookedAfter: booked,
          memberChannelCapacity: session.capacityOverride ?? input.defaultChannelCapacity,
          publicBookedAtTime: session.publicBookedCached,
          venueTotalBookedAfter: booked + session.publicBookedCached,
          venueMaximumAtTime: input.venueMaximum,
        });
        return { ok: true, bookingId: booking.bookingId };
      },

      async get(bookingId: string): Promise<BookingRecord | null> {
        const booking = bookings.find((b) => b.bookingId === bookingId);
        return booking ? toRecord(booking) : null;
      },

      async listForMember(memberId: string, from: Date): Promise<BookingRecord[]> {
        return bookings
          .filter((b) => b.memberId === memberId && b.startsAt >= from)
          .sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime())
          .map(toRecord);
      },

      async listForSession(venueId: string, externalSessionId: string): Promise<BookingRecord[]> {
        const session = findSession(venueId, externalSessionId);
        if (!session) return [];
        return bookings
          .filter((b) => b.sessionId === session.id && b.status === 'confirmed')
          .sort((a, b) => a.memberName.localeCompare(b.memberName))
          .map(toRecord);
      },

      async listForVenueBetween(venueId: string, from: Date, to: Date): Promise<BookingRecord[]> {
        return bookings
          .filter((b) => b.venueId === venueId && b.startsAt >= from && b.startsAt < to)
          .sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime())
          .map(toRecord);
      },

      async setExternalId(bookingId: string, externalBookingId: string): Promise<void> {
        const booking = bookings.find((b) => b.bookingId === bookingId);
        if (booking) booking.externalBookingId = externalBookingId;
      },

      async markPayment(bookingId: string, status: PaymentStatus): Promise<void> {
        const booking = bookings.find((b) => b.bookingId === bookingId);
        if (booking) booking.paymentStatus = status;
      },

      async setCheckIn(target, checkedIn: boolean): Promise<void> {
        if (target.bookingId) {
          const booking = bookings.find((b) => b.bookingId === target.bookingId);
          if (booking) booking.memberCheckedIn = checkedIn;
        }
        if (target.guestId) {
          const guest = guests.find((g) => g.guestId === target.guestId);
          if (guest) guest.checkedIn = checkedIn;
        }
      },
    },

    sessions: {
      async availability(venueId, from, to, defaultCapacity): Promise<AvailabilityRow[]> {
        return sessions
          .filter((s) => s.venueId === venueId && s.startsAt >= from && s.startsAt <= to)
          .sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime())
          .map((s) => {
            const capacity = s.capacityOverride ?? defaultCapacity;
            const booked = bookedFor(s.id);
            return {
              sessionId: s.id,
              externalSessionId: s.externalSessionId,
              startsAt: s.startsAt.toISOString(),
              endsAt: s.endsAt.toISOString(),
              capacity,
              booked,
              spotsRemaining: Math.max(capacity - booked, 0),
              closed: s.closed,
            };
          });
      },
      async upsert(input): Promise<void> {
        const existing = findSession(input.venueId, input.externalSessionId);
        if (existing) {
          existing.startsAt = input.startsAt;
          existing.endsAt = input.endsAt;
          return;
        }
        ensureSession(input);
      },
      async setPublicBookedCache(venueId, externalSessionId, publicBooked): Promise<void> {
        const session = findSession(venueId, externalSessionId);
        if (session) session.publicBookedCached = publicBooked;
      },
      async setClosed(venueId, externalSessionId, closed): Promise<void> {
        const session = findSession(venueId, externalSessionId);
        if (session) session.closed = closed;
      },
    },

    waivers: {
      async create(input): Promise<WaiverRecord> {
        const row: WaiverRow = {
          waiverId: randomUUID(),
          tokenHash: input.tokenHash,
          bookingId: input.bookingId,
          guestId: input.guestId,
          venueId: input.venueId,
          sessionStartsAt: input.sessionStartsAt,
          guestName: input.guestName,
          guestEmail: input.guestEmail,
          status: 'not_sent',
          waiverVersion: input.waiverVersion,
          sentAt: null,
          reminderSentAt: null,
          signedAt: null,
          signedName: null,
          signature: null,
        };
        waivers.push(row);
        return toWaiverRecord(row);
      },
      async getByTokenHash(tokenHash: string): Promise<WaiverRecord | null> {
        const row = waivers.find((w) => w.tokenHash === tokenHash);
        return row ? toWaiverRecord(row) : null;
      },
      async markSent(waiverId: string, isReminder: boolean): Promise<void> {
        const row = waivers.find((w) => w.waiverId === waiverId);
        if (!row) return;
        if (isReminder) {
          row.reminderSentAt = new Date();
          return;
        }
        if (row.status === 'not_sent') row.status = 'sent';
        row.sentAt = row.sentAt ?? new Date();
      },
      async rotateToken(waiverId: string, tokenHash: string): Promise<void> {
        const row = waivers.find((w) => w.waiverId === waiverId);
        if (row) row.tokenHash = tokenHash;
      },

      async sign(input): Promise<WaiverRecord | null> {
        const row = waivers.find((w) => w.waiverId === input.waiverId);
        if (!row) return null;
        row.status = 'signed';
        row.signedAt = row.signedAt ?? new Date();
        row.signedName = input.signedName;
        row.signature = input.signature;
        return toWaiverRecord(row);
      },
      async listForBooking(bookingId: string): Promise<WaiverRecord[]> {
        return waivers.filter((w) => w.bookingId === bookingId).map(toWaiverRecord);
      },
      async listUnsignedStartingBetween(from: Date, to: Date): Promise<WaiverRecord[]> {
        return waivers
          .filter((w) => {
            if (w.status === 'signed' || w.reminderSentAt) return false;
            if (w.sessionStartsAt < from || w.sessionStartsAt >= to) return false;
            const booking = bookings.find((b) => b.bookingId === w.bookingId);
            const guest = guests.find((g) => g.guestId === w.guestId);
            return booking?.status === 'confirmed' && guest?.status === 'confirmed';
          })
          .map(toWaiverRecord);
      },
    },

    config: {
      async all(): Promise<ConfigEntry[]> {
        return [...config.values()].sort((a, b) => a.key.localeCompare(b.key));
      },
      async set(key, value, actor, sourceNote): Promise<void> {
        const existing = config.get(key);
        config.set(key, {
          key,
          value,
          updatedAt: new Date().toISOString(),
          updatedBy: actor,
          sourceNote: sourceNote ?? existing?.sourceNote ?? null,
        });
      },
    },

    members: {
      async getByEmail(email: string): Promise<MemberRecord | null> {
        const wanted = email.toLowerCase();
        return [...members.values()].find((m) => m.email.toLowerCase() === wanted) ?? null;
      },
      async get(memberId: string): Promise<MemberRecord | null> {
        return members.get(memberId) ?? null;
      },
      async upsertMany(list: MemberRecord[]): Promise<void> {
        for (const member of list) {
          members.set(member.memberId, {
            ...member,
            // A sync that says nothing about the package must not erase what an
            // import established. The Postgres store coalesces for the same
            // reason; the two have to agree.
            membershipPackage: member.membershipPackage ?? members.get(member.memberId)?.membershipPackage ?? null,
            syncedAt: new Date().toISOString(),
          });
        }
      },
      async upsertManual({ email, firstName, lastName, status, homeVenueId, membershipPackage }): Promise<MemberRecord> {
        const normalised = email.toLowerCase();
        const memberId = `manual:${normalised}`;
        const record: MemberRecord = {
          memberId,
          email: normalised,
          firstName,
          lastName,
          status,
          homeVenueId,
          // Kept when the caller says nothing, so a hand edit does not erase
          // what an import established.
          membershipPackage: membershipPackage ?? members.get(memberId)?.membershipPackage ?? null,
          syncedAt: new Date().toISOString(),
          source: 'manual',
        };
        members.set(memberId, record);
        return { ...record };
      },
      async lastSyncedAt(): Promise<Date | null> {
        const times = [...members.values()]
          .filter((member) => member.source === 'hapana')
          .map((member) => new Date(member.syncedAt).getTime());
        return times.length ? new Date(Math.max(...times)) : null;
      },

      async listPackages(): Promise<Array<{ name: string; members: number }>> {
        const counts = new Map<string, number>();
        for (const member of members.values()) {
          const name = member.membershipPackage;
          if (name) counts.set(name, (counts.get(name) ?? 0) + 1);
        }
        return [...counts.entries()]
          .map(([name, count]) => ({ name, members: count }))
          .sort((a, b) => b.members - a.members || a.name.localeCompare(b.name));
      },

      async listManual(): Promise<MemberRecord[]> {
        return [...members.values()]
          .filter((m) => m.source === 'manual')
          .map((m) => ({ ...m }))
          .sort((a, b) => a.email.localeCompare(b.email));
      },
      async removeManual(memberId: string): Promise<boolean> {
        // Scoped to manual rows, so this can never delete a synced one.
        const record = members.get(memberId);
        if (!record || record.source !== 'manual') return false;
        return members.delete(memberId);
      },
      async lastSyncAt(): Promise<string | null> {
        const all = [...members.values()];
        if (all.length === 0) return null;
        return all.map((m) => m.syncedAt).sort().at(-1) ?? null;
      },
    },

    auth: {
      async throttle(bucketKey: string, limit: number, windowMs: number): Promise<boolean> {
        const now = Date.now();
        const bucket = throttleBuckets.get(bucketKey);
        if (!bucket || now - bucket.windowStart > windowMs) {
          throttleBuckets.set(bucketKey, { hits: 1, windowStart: now });
          return 1 <= limit;
        }
        bucket.hits += 1;
        return bucket.hits <= limit;
      },
      async getStaffByEmail(email: string): Promise<StaffRecord | null> {
        const wanted = email.toLowerCase();
        return staff.find((s) => s.email.toLowerCase() === wanted && s.active) ?? null;
      },
      async getStaff(staffId: string): Promise<StaffRecord | null> {
        return staff.find((s) => s.staffId === staffId && s.active) ?? null;
      },
      async listStaff(): Promise<StaffRecord[]> {
        return [...staff].sort(
          (a, b) => Number(b.active) - Number(a.active) || a.email.localeCompare(b.email),
        );
      },
      async upsertStaff({ email, displayName, role, venueIds }): Promise<StaffRecord> {
        const wanted = email.toLowerCase();
        const existing = staff.find((s) => s.email.toLowerCase() === wanted);
        if (existing) {
          Object.assign(existing, { displayName, role, venueIds, active: true });
          return { ...existing };
        }
        const record: StaffRecord = { staffId: randomUUID(), email, displayName, role, venueIds, active: true };
        staff.push(record);
        return { ...record };
      },
      async setStaffActive(staffId: string, active: boolean): Promise<StaffRecord | null> {
        const record = staff.find((s) => s.staffId === staffId);
        if (!record) return null;
        record.active = active;
        return { ...record };
      },
    },

    credentials: {
      async get(email: string): Promise<CredentialRecord | null> {
        const record = credentials.get(email.toLowerCase());
        return record ? { ...record } : null;
      },
      async setPassword({ email, passwordHash, mustChange }): Promise<CredentialRecord> {
        const key = email.toLowerCase();
        const now = new Date().toISOString();
        const existing = credentials.get(key);
        const record: CredentialRecord = {
          email: key,
          passwordHash,
          mustChange,
          // A reset is also how a suspended account is brought back.
          active: true,
          lastLoginAt: existing?.lastLoginAt ?? null,
          createdAt: existing?.createdAt ?? now,
          updatedAt: now,
        };
        credentials.set(key, record);
        return { ...record };
      },
      async updateHash(email: string, passwordHash: string): Promise<void> {
        const record = credentials.get(email.toLowerCase());
        if (record) {
          record.passwordHash = passwordHash;
          record.updatedAt = new Date().toISOString();
        }
      },
      async recordLogin(email: string): Promise<void> {
        const record = credentials.get(email.toLowerCase());
        if (record) record.lastLoginAt = new Date().toISOString();
      },
      async setActive(email: string, active: boolean): Promise<CredentialRecord | null> {
        const record = credentials.get(email.toLowerCase());
        if (!record) return null;
        record.active = active;
        record.updatedAt = new Date().toISOString();
        return { ...record };
      },
      async list(): Promise<CredentialRecord[]> {
        return [...credentials.values()]
          .map((record) => ({ ...record }))
          .sort((a, b) => Number(b.active) - Number(a.active) || a.email.localeCompare(b.email));
      },
      async remove(email: string): Promise<boolean> {
        return credentials.delete(email.toLowerCase());
      },
    },

    audit: {
      async listForSession(sessionId: string, limit = 200): Promise<AuditRow[]> {
        return audit.filter((a) => a.sessionId === sessionId).slice(-limit).reverse();
      },
      async listForVenueBetween(venueId: string, from: Date, to: Date): Promise<AuditRow[]> {
        const sessionIds = new Set(sessions.filter((s) => s.venueId === venueId).map((s) => s.id));
        return audit.filter(
          (a) => sessionIds.has(a.sessionId) && new Date(a.createdAt) >= from && new Date(a.createdAt) < to,
        );
      },
    },

    outbox: {
      async enqueue({ toEmail, template, payload }): Promise<string> {
        const emailId = randomUUID();
        outbox.push({ emailId, toEmail, template, payload, status: 'queued', attempts: 0 });
        return emailId;
      },
      async markSent(emailId: string): Promise<void> {
        const entry = outbox.find((e) => e.emailId === emailId);
        if (entry) entry.status = 'sent';
      },
      async markFailed(emailId: string): Promise<void> {
        const entry = outbox.find((e) => e.emailId === emailId);
        if (entry) {
          entry.status = 'failed';
          entry.attempts += 1;
        }
      },
      async pending(limit: number): Promise<OutboxEntry[]> {
        return outbox.filter((e) => e.status !== 'sent' && e.attempts < 5).slice(0, limit);
      },
    },

    venue: {
      async get(venueId: string) {
        return venues.get(venueId) ?? null;
      },
    },

    async close(): Promise<void> {
      /* nothing to close */
    },

    reset(): void {
      sessions.length = 0;
      bookings.length = 0;
      guests.length = 0;
      waivers.length = 0;
      audit.length = 0;
      outbox.length = 0;
      tokens.clear();
      throttleBuckets.clear();
      locks.clear();
    },

    seedSession(input): void {
      const session = ensureSession(input);
      session.capacityOverride = input.capacityOverride ?? null;
      session.publicBookedCached = input.publicBooked ?? 0;
    },

    seedMember(member: MemberRecord): void {
      members.set(member.memberId, member);
    },

    seedStaff(record: StaffRecord): void {
      staff.push(record);
    },

    outboxAll(): OutboxEntry[] {
      return [...outbox];
    },
  };
}
