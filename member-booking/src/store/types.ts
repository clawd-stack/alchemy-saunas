/**
 * Store interfaces.
 *
 * Everything above this layer talks to these types, never to SQL. Two
 * implementations exist: pg.ts (Postgres, production) and memory.ts (used by
 * the test suite and by `netlify dev` when no DATABASE_URL is set). Keeping
 * both honest against one interface is what lets the concurrency test in
 * tests/ describe behaviour rather than a particular database.
 */

export type BookingStatus = 'confirmed' | 'cancelled';
export type PaymentStatus = 'outstanding' | 'collected' | 'waived';
export type WaiverStatus = 'not_sent' | 'sent' | 'signed';
export type MembershipStatus = 'active' | 'paused' | 'suspended' | 'cancelled';

export interface GuestInput {
  name: string;
  email: string;
}

export interface CreateBookingInput {
  venueId: string;
  externalSessionId: string;
  startsAt: Date;
  endsAt: Date;
  memberId: string;
  memberName: string;
  memberEmail: string;
  guests: GuestInput[];
  defaultChannelCapacity: number;
  /** Null means no venue-wide ceiling is enforced. */
  venueMaximum: number | null;
  /** Occupancy already sold through the public channel. -1 means "unknown", which fails closed. */
  publicBooked: number;
  guestPrice: number;
  maxGuests: number;
  actor?: string;
}

export interface CreateBookingSuccess {
  ok: true;
  bookingId: string;
  sessionId: string;
  startsAt: string;
  spotsTotal: number;
  spotsGuest: number;
  amountOwedAud: number;
  memberChannelBookedAfter: number;
  memberChannelCapacity: number;
  venueTotalBookedAfter: number;
}

export interface StoreRefusal {
  ok: false;
  code: string;
  detail?: unknown;
}

export type CreateBookingResult = CreateBookingSuccess | StoreRefusal;

export interface CancelBookingInput {
  bookingId: string;
  /** Null when staff or the system is cancelling, which skips the ownership check. */
  memberId: string | null;
  cutoffHours: number;
  defaultChannelCapacity: number;
  /** Null means no venue-wide ceiling is enforced. */
  venueMaximum: number | null;
  reason?: string;
  enforceCutoff?: boolean;
  actor?: string;
}

export interface CancelBookingSuccess {
  ok: true;
  bookingId: string;
  code?: 'ALREADY_CANCELLED';
  spotsReleased?: number;
  memberChannelBookedAfter?: number;
}

export type CancelBookingResult = CancelBookingSuccess | StoreRefusal;

export interface AvailabilityRow {
  sessionId: string | null;
  externalSessionId: string;
  startsAt: string;
  endsAt: string;
  capacity: number;
  booked: number;
  spotsRemaining: number;
  closed: boolean;
}

export interface GuestRecord {
  guestId: string;
  bookingId: string;
  name: string;
  email: string;
  status: BookingStatus;
  checkedIn: boolean;
  waiverStatus: WaiverStatus;
  waiverSignedAt: string | null;
}

export interface BookingRecord {
  bookingId: string;
  venueId: string;
  sessionId: string;
  externalSessionId: string;
  startsAt: string;
  memberId: string;
  memberName: string;
  memberEmail: string;
  spotsTotal: number;
  spotsGuest: number;
  amountOwedAud: number;
  paymentStatus: PaymentStatus;
  status: BookingStatus;
  memberCheckedIn: boolean;
  createdAt: string;
  cancelledAt: string | null;
  externalBookingId: string | null;
  guests: GuestRecord[];
}

export interface WaiverRecord {
  waiverId: string;
  bookingId: string | null;
  guestId: string | null;
  venueId: string;
  sessionStartsAt: string;
  guestName: string;
  guestEmail: string;
  status: WaiverStatus;
  waiverVersion: string;
  sentAt: string | null;
  reminderSentAt: string | null;
  signedAt: string | null;
  /** SVG path data for the drawn signature. Null on waivers signed before it existed. */
  signature: string | null;
}

export interface MemberRecord {
  memberId: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  status: MembershipStatus;
  homeVenueId: string | null;
  /** The Hapana package this member holds. Null for anybody added by hand. */
  membershipPackage: string | null;
  syncedAt: string;
  /** Where this record came from. Manual entries are never overwritten by a sync. */
  source: 'hapana' | 'manual';
}

export interface CredentialRecord {
  email: string;
  passwordHash: string;
  /** True while the password in use was issued by a manager rather than chosen. */
  mustChange: boolean;
  active: boolean;
  lastLoginAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface StaffRecord {
  staffId: string;
  email: string;
  displayName: string;
  role: 'door' | 'manager' | 'admin';
  venueIds: string[];
  active: boolean;
}

export interface AuditRow {
  eventId: string;
  sessionId: string;
  bookingId: string | null;
  action: string;
  refusalCode: string | null;
  spotsDelta: number;
  memberChannelBookedAfter: number;
  memberChannelCapacity: number;
  publicBookedAtTime: number;
  venueTotalBookedAfter: number;
  venueMaximumAtTime: number | null;
  createdAt: string;
}

export interface ConfigEntry {
  key: string;
  value: unknown;
  updatedAt: string;
  updatedBy: string | null;
  sourceNote: string | null;
}

export interface OutboxEntry {
  emailId: string;
  toEmail: string;
  template: string;
  payload: Record<string, unknown>;
  status: 'queued' | 'sent' | 'failed';
  attempts: number;
}

export interface Store {
  bookings: {
    create(input: CreateBookingInput): Promise<CreateBookingResult>;
    cancel(input: CancelBookingInput): Promise<CancelBookingResult>;
    cancelGuest(input: {
      guestId: string;
      memberId: string;
      cutoffHours: number;
      guestPrice: number;
      defaultChannelCapacity: number;
      /** Null means no venue-wide ceiling is enforced. */
  venueMaximum: number | null;
      actor?: string;
    }): Promise<CancelBookingResult>;
    get(bookingId: string): Promise<BookingRecord | null>;
    listForMember(memberId: string, from: Date): Promise<BookingRecord[]>;
    listForSession(venueId: string, externalSessionId: string): Promise<BookingRecord[]>;
    listForVenueBetween(venueId: string, from: Date, to: Date): Promise<BookingRecord[]>;
    setExternalId(bookingId: string, externalBookingId: string): Promise<void>;
    markPayment(bookingId: string, status: PaymentStatus, actor: string): Promise<void>;
    setCheckIn(target: { bookingId?: string; guestId?: string }, checkedIn: boolean): Promise<void>;
  };
  sessions: {
    availability(venueId: string, from: Date, to: Date, defaultCapacity: number): Promise<AvailabilityRow[]>;
    upsert(input: {
      venueId: string;
      externalSessionId: string;
      startsAt: Date;
      endsAt: Date;
    }): Promise<void>;
    setPublicBookedCache(venueId: string, externalSessionId: string, publicBooked: number): Promise<void>;
    setClosed(venueId: string, externalSessionId: string, closed: boolean): Promise<void>;
  };
  waivers: {
    create(input: {
      tokenHash: string;
      bookingId: string;
      guestId: string;
      venueId: string;
      sessionStartsAt: Date;
      guestName: string;
      guestEmail: string;
      waiverVersion: string;
    }): Promise<WaiverRecord>;
    getByTokenHash(tokenHash: string): Promise<WaiverRecord | null>;
    markSent(waiverId: string, isReminder: boolean): Promise<void>;
    /** Replaces the emailed token, so a reminder can carry a link that works. */
    rotateToken(waiverId: string, tokenHash: string): Promise<void>;
    sign(input: {
      waiverId: string;
      signedName: string;
      signature: string;
      ip: string | null;
      userAgent: string | null;
    }): Promise<WaiverRecord | null>;
    listForBooking(bookingId: string): Promise<WaiverRecord[]>;
    listUnsignedStartingBetween(from: Date, to: Date): Promise<WaiverRecord[]>;
  };
  config: {
    all(): Promise<ConfigEntry[]>;
    set(key: string, value: unknown, actor: string, sourceNote?: string | null): Promise<void>;
  };
  members: {
    /**
     * The row for an address. An address can hold more than one: an import
     * writes `manual:<email>` and a Hapana sync writes `hapana:<id>`, so the
     * order is defined rather than left to the database. A manual row wins,
     * because it is the one a person curated and the one the admin screens
     * edit, and the freshest wins after that.
     */
    getByEmail(email: string): Promise<MemberRecord | null>;
    /**
     * The membership package held at an address, across every row for it.
     *
     * Asked by address rather than by member id because the id depends on which
     * way the member was resolved: a live Hapana hit writes a `hapana:<id>` row
     * carrying no package, since Hapana does not return one, and reading the
     * package off that row answered "no package" for somebody the import had
     * ruled on.
     */
    packageFor(email: string): Promise<string | null>;
    get(memberId: string): Promise<MemberRecord | null>;
    upsertMany(members: MemberRecord[]): Promise<void>;
    lastSyncAt(): Promise<string | null>;
    /** Adds or updates a member the venue entered by hand. */
    /**
     * `membershipPackage` distinguishes three things, and has to: omitted keeps
     * whatever is there, so a hand edit does not erase what an import
     * established; `null` clears it, which is what an import with an empty
     * Package Name column means; a string sets it.
     */
    upsertManual(input: {
      email: string;
      firstName: string | null;
      lastName: string | null;
      status: MembershipStatus;
      homeVenueId: string | null;
      membershipPackage?: string | null;
    }): Promise<MemberRecord>;
    /** Every package held by somebody, with how many hold it. For the toggles. */
    listPackages(): Promise<Array<{ name: string; members: number }>>;
    listManual(): Promise<MemberRecord[]>;
    /**
     * When a synced member was last written, which is the high-water mark the
     * scheduled sync asks Hapana for changes since. Null when nothing has ever
     * been synced, meaning the next sync pulls the whole membership.
     */
    lastSyncedAt(): Promise<Date | null>;
    removeManual(memberId: string): Promise<boolean>;
  };
  auth: {
    /** Returns true when the caller is within the allowance. */
    throttle(bucketKey: string, limit: number, windowMs: number): Promise<boolean>;
    getStaffByEmail(email: string): Promise<StaffRecord | null>;
    getStaff(staffId: string): Promise<StaffRecord | null>;
    /** Every staff account, active and deactivated, for the admin screen. */
    listStaff(): Promise<StaffRecord[]>;
    /** Creates by email, or updates the name, role and venues of an existing one. */
    upsertStaff(input: {
      email: string;
      displayName: string;
      role: 'door' | 'manager' | 'admin';
      venueIds: string[];
    }): Promise<StaffRecord>;
    /** Deactivates rather than deletes, so audit trails keep resolving. */
    setStaffActive(staffId: string, active: boolean): Promise<StaffRecord | null>;
  };
  credentials: {
    get(email: string): Promise<CredentialRecord | null>;
    /** Creates, or replaces the password on an existing address. */
    setPassword(input: { email: string; passwordHash: string; mustChange: boolean }): Promise<CredentialRecord>;
    /** Rewrites only the hash, for a silent re-hash at stronger cost parameters. */
    updateHash(email: string, passwordHash: string): Promise<void>;
    recordLogin(email: string): Promise<void>;
    setActive(email: string, active: boolean): Promise<CredentialRecord | null>;
    list(): Promise<CredentialRecord[]>;
    remove(email: string): Promise<boolean>;
  };
  audit: {
    listForSession(sessionId: string, limit?: number): Promise<AuditRow[]>;
    listForVenueBetween(venueId: string, from: Date, to: Date): Promise<AuditRow[]>;
  };
  outbox: {
    enqueue(entry: { toEmail: string; template: string; payload: Record<string, unknown> }): Promise<string>;
    markSent(emailId: string, providerId: string | null): Promise<void>;
    markFailed(emailId: string, error: string): Promise<void>;
    pending(limit: number): Promise<OutboxEntry[]>;
  };
  venue: {
    get(venueId: string): Promise<{ venueId: string; name: string; timezone: string } | null>;
  };
  close(): Promise<void>;
}
