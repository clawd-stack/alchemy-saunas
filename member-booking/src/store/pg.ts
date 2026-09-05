import postgres from 'postgres';
import { env } from '../lib/env.ts';
import type {
  AuditRow,
  AvailabilityRow,
  BookingRecord,
  CancelBookingInput,
  CancelBookingResult,
  ConfigEntry,
  CreateBookingInput,
  CreateBookingResult,
  GuestRecord,
  MemberRecord,
  OutboxEntry,
  PaymentStatus,
  StaffRecord,
  Store,
  WaiverRecord,
} from './types.ts';

/**
 * Postgres implementation. Every capacity-changing operation goes through a
 * database function (see db/schema.sql) rather than being assembled here, so
 * the rules and the lock live together and cannot drift apart.
 */

type Sql = ReturnType<typeof postgres>;

let shared: Sql | null = null;
let overrideConnectionString: string | null = null;

function sql(): Sql {
  if (!shared) {
    shared = postgres(overrideConnectionString ?? env.databaseUrl, {
      // Serverless: small pool, short idle, prepared statements off because
      // connections are frequently recycled behind a pooler.
      max: 3,
      idle_timeout: 20,
      connect_timeout: 10,
      prepare: false,
    });
  }
  return shared;
}

function toNumber(value: unknown): number {
  return typeof value === 'number' ? value : Number(value ?? 0);
}

function iso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  return String(value ?? '');
}

function isoOrNull(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return iso(value);
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function mapGuest(row: any): GuestRecord {
  return {
    guestId: row.guest_id,
    bookingId: row.booking_id,
    name: row.name,
    email: row.email,
    status: row.status,
    checkedIn: row.checked_in,
    waiverStatus: row.waiver_status ?? 'not_sent',
    waiverSignedAt: isoOrNull(row.waiver_signed_at),
  };
}

function mapBooking(row: any, guests: GuestRecord[]): BookingRecord {
  return {
    bookingId: row.booking_id,
    venueId: row.venue_id,
    sessionId: row.session_id,
    externalSessionId: row.external_session_id,
    startsAt: iso(row.starts_at),
    memberId: row.member_id,
    memberName: row.member_name,
    memberEmail: row.member_email,
    spotsTotal: toNumber(row.spots_total),
    spotsGuest: toNumber(row.spots_guest),
    amountOwedAud: toNumber(row.amount_owed_aud),
    paymentStatus: row.payment_status,
    status: row.status,
    memberCheckedIn: row.member_checked_in,
    createdAt: iso(row.created_at),
    cancelledAt: isoOrNull(row.cancelled_at),
    externalBookingId: row.external_booking_id ?? null,
    guests,
  };
}

function mapWaiver(row: any): WaiverRecord {
  return {
    waiverId: row.waiver_id,
    bookingId: row.booking_id ?? null,
    guestId: row.guest_id ?? null,
    venueId: row.venue_id,
    sessionStartsAt: iso(row.session_starts_at),
    guestName: row.guest_name,
    guestEmail: row.guest_email,
    status: row.status,
    waiverVersion: row.waiver_version,
    sentAt: isoOrNull(row.sent_at),
    reminderSentAt: isoOrNull(row.reminder_sent_at),
    signedAt: isoOrNull(row.signed_at),
  };
}

function mapMember(row: any): MemberRecord {
  return {
    memberId: row.member_id,
    email: row.email,
    firstName: row.first_name ?? null,
    lastName: row.last_name ?? null,
    status: row.status,
    homeVenueId: row.home_venue_id ?? null,
    syncedAt: iso(row.synced_at),
  };
}

function mapAudit(row: any): AuditRow {
  return {
    eventId: row.event_id,
    sessionId: row.session_id,
    bookingId: row.booking_id ?? null,
    action: row.action,
    refusalCode: row.refusal_code ?? null,
    spotsDelta: toNumber(row.spots_delta),
    memberChannelBookedAfter: toNumber(row.member_channel_booked_after),
    memberChannelCapacity: toNumber(row.member_channel_capacity),
    publicBookedAtTime: toNumber(row.public_booked_at_time),
    venueTotalBookedAfter: toNumber(row.venue_total_booked_after),
    venueMaximumAtTime: row.venue_maximum_at_time === null ? null : toNumber(row.venue_maximum_at_time),
    createdAt: iso(row.created_at),
  };
}

/** Loads bookings plus their guests and each guest's waiver status. */
async function loadBookings(where: (s: Sql) => Promise<any[]>): Promise<BookingRecord[]> {
  const s = sql();
  const rows: any[] = await where(s);
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.booking_id);
  const guestRows: any[] = await s`
    select g.*, w.status as waiver_status, w.signed_at as waiver_signed_at
    from booking_guests g
    left join waivers w on w.guest_id = g.guest_id
    where g.booking_id = any(${ids}::uuid[])
    order by g.created_at
  `;
  const byBooking = new Map<string, GuestRecord[]>();
  for (const g of guestRows) {
    const list = byBooking.get(g.booking_id) ?? [];
    list.push(mapGuest(g));
    byBooking.set(g.booking_id, list);
  }
  return rows.map((r) => mapBooking(r, byBooking.get(r.booking_id) ?? []));
}

export function createPgStore(connectionString?: string): Store {
  if (connectionString) overrideConnectionString = connectionString;
  return {
    bookings: {
      async create(input: CreateBookingInput): Promise<CreateBookingResult> {
        const s = sql();
        const [row]: any[] = await s`
          select create_member_booking(
            ${input.venueId},
            ${input.externalSessionId},
            ${input.startsAt},
            ${input.endsAt},
            ${input.memberId},
            ${input.memberName},
            ${input.memberEmail},
            ${s.json(input.guests as unknown as never)},
            ${input.defaultChannelCapacity},
            ${input.venueMaximum},
            ${input.publicBooked},
            ${input.guestPrice},
            ${input.maxGuests},
            ${input.actor ?? null}
          ) as result
        `;
        const result = row.result;
        if (!result.ok) return { ok: false, code: result.code, detail: result.detail ?? null };
        return {
          ok: true,
          bookingId: result.booking_id,
          sessionId: result.session_id,
          startsAt: iso(result.starts_at),
          spotsTotal: toNumber(result.spots_total),
          spotsGuest: toNumber(result.spots_guest),
          amountOwedAud: toNumber(result.amount_owed_aud),
          memberChannelBookedAfter: toNumber(result.member_channel_booked_after),
          memberChannelCapacity: toNumber(result.member_channel_capacity),
          venueTotalBookedAfter: toNumber(result.venue_total_booked_after),
        };
      },

      async cancel(input: CancelBookingInput): Promise<CancelBookingResult> {
        const [row]: any[] = await sql()`
          select cancel_member_booking(
            ${input.bookingId}::uuid,
            ${input.memberId},
            ${input.cutoffHours},
            ${input.defaultChannelCapacity},
            ${input.venueMaximum},
            ${input.reason ?? null},
            ${input.enforceCutoff ?? true},
            ${input.actor ?? null}
          ) as result
        `;
        const result = row.result;
        if (!result.ok) return { ok: false, code: result.code, detail: result.detail ?? null };
        return {
          ok: true,
          bookingId: result.booking_id,
          code: result.code,
          spotsReleased: toNumber(result.spots_released),
          memberChannelBookedAfter: toNumber(result.member_channel_booked_after),
        };
      },

      async cancelGuest(input): Promise<CancelBookingResult> {
        const [row]: any[] = await sql()`
          select cancel_guest_spot(
            ${input.guestId}::uuid,
            ${input.memberId},
            ${input.cutoffHours},
            ${input.guestPrice},
            ${input.defaultChannelCapacity},
            ${input.venueMaximum},
            ${input.actor ?? null}
          ) as result
        `;
        const result = row.result;
        if (!result.ok) return { ok: false, code: result.code, detail: result.detail ?? null };
        return { ok: true, bookingId: result.booking_id };
      },

      async get(bookingId: string): Promise<BookingRecord | null> {
        const rows = await loadBookings(
          (s) => s`
            select b.*, sess.external_session_id
            from bookings b join sessions sess on sess.id = b.session_id
            where b.booking_id = ${bookingId}::uuid
          ` as any,
        );
        return rows[0] ?? null;
      },

      async listForMember(memberId: string, from: Date): Promise<BookingRecord[]> {
        return loadBookings(
          (s) => s`
            select b.*, sess.external_session_id
            from bookings b join sessions sess on sess.id = b.session_id
            where b.member_id = ${memberId} and b.starts_at >= ${from}
            order by b.starts_at
          ` as any,
        );
      },

      async listForSession(venueId: string, externalSessionId: string): Promise<BookingRecord[]> {
        return loadBookings(
          (s) => s`
            select b.*, sess.external_session_id
            from bookings b join sessions sess on sess.id = b.session_id
            where sess.venue_id = ${venueId}
              and sess.external_session_id = ${externalSessionId}
              and b.status = 'confirmed'
            order by b.member_name
          ` as any,
        );
      },

      async listForVenueBetween(venueId: string, from: Date, to: Date): Promise<BookingRecord[]> {
        return loadBookings(
          (s) => s`
            select b.*, sess.external_session_id
            from bookings b join sessions sess on sess.id = b.session_id
            where b.venue_id = ${venueId} and b.starts_at >= ${from} and b.starts_at < ${to}
            order by b.starts_at, b.member_name
          ` as any,
        );
      },

      async setExternalId(bookingId: string, externalBookingId: string): Promise<void> {
        await sql()`
          update bookings set external_booking_id = ${externalBookingId}
          where booking_id = ${bookingId}::uuid
        `;
      },

      async markPayment(bookingId: string, status: PaymentStatus, actor: string): Promise<void> {
        await sql()`
          update bookings
             set payment_status = ${status}::payment_status,
                 payment_marked_at = now(),
                 payment_marked_by = ${actor}
           where booking_id = ${bookingId}::uuid
        `;
      },

      async setCheckIn(target, checkedIn: boolean): Promise<void> {
        const s = sql();
        if (target.bookingId) {
          await s`update bookings set member_checked_in = ${checkedIn} where booking_id = ${target.bookingId}::uuid`;
        }
        if (target.guestId) {
          await s`update booking_guests set checked_in = ${checkedIn} where guest_id = ${target.guestId}::uuid`;
        }
      },
    },

    sessions: {
      async availability(venueId, from, to, defaultCapacity): Promise<AvailabilityRow[]> {
        const rows: any[] = await sql()`
          select * from session_availability(${venueId}, ${from}, ${to}, ${defaultCapacity})
        `;
        return rows.map((r) => ({
          sessionId: r.session_id,
          externalSessionId: r.external_session_id,
          startsAt: iso(r.starts_at),
          endsAt: iso(r.ends_at),
          capacity: toNumber(r.capacity),
          booked: toNumber(r.booked),
          spotsRemaining: toNumber(r.spots_remaining),
          closed: r.closed,
        }));
      },

      async upsert({ venueId, externalSessionId, startsAt, endsAt }): Promise<void> {
        await sql()`
          insert into sessions (venue_id, external_session_id, starts_at, ends_at)
          values (${venueId}, ${externalSessionId}, ${startsAt}, ${endsAt})
          on conflict (venue_id, external_session_id)
          do update set starts_at = excluded.starts_at, ends_at = excluded.ends_at
        `;
      },

      async setPublicBookedCache(venueId, externalSessionId, publicBooked): Promise<void> {
        await sql()`
          update sessions
             set public_booked_cached = ${publicBooked}, public_booked_cached_at = now()
           where venue_id = ${venueId} and external_session_id = ${externalSessionId}
        `;
      },

      async setClosed(venueId, externalSessionId, closed): Promise<void> {
        await sql()`
          update sessions set closed = ${closed}
          where venue_id = ${venueId} and external_session_id = ${externalSessionId}
        `;
      },
    },

    waivers: {
      async create(input): Promise<WaiverRecord> {
        const [row]: any[] = await sql()`
          insert into waivers (token_hash, booking_id, guest_id, venue_id, session_starts_at,
                               guest_name, guest_email, waiver_version)
          values (${input.tokenHash}, ${input.bookingId}::uuid, ${input.guestId}::uuid, ${input.venueId},
                  ${input.sessionStartsAt}, ${input.guestName}, ${input.guestEmail}, ${input.waiverVersion})
          returning *
        `;
        return mapWaiver(row);
      },

      async getByTokenHash(tokenHash: string): Promise<WaiverRecord | null> {
        const [row]: any[] = await sql()`select * from waivers where token_hash = ${tokenHash}`;
        return row ? mapWaiver(row) : null;
      },

      async markSent(waiverId: string, isReminder: boolean): Promise<void> {
        const s = sql();
        if (isReminder) {
          await s`update waivers set reminder_sent_at = now() where waiver_id = ${waiverId}::uuid`;
        } else {
          await s`
            update waivers
               set status = case when status = 'not_sent' then 'sent'::waiver_status else status end,
                   sent_at = coalesce(sent_at, now())
             where waiver_id = ${waiverId}::uuid
          `;
        }
      },

      async rotateToken(waiverId: string, tokenHash: string): Promise<void> {
        await sql()`update waivers set token_hash = ${tokenHash} where waiver_id = ${waiverId}::uuid`;
      },

      async sign(input): Promise<WaiverRecord | null> {
        const [row]: any[] = await sql()`
          update waivers
             set status = 'signed', signed_at = coalesce(signed_at, now()),
                 signed_name = ${input.signedName},
                 signed_ip = ${input.ip}::inet,
                 signed_user_agent = ${input.userAgent}
           where waiver_id = ${input.waiverId}::uuid
          returning *
        `;
        return row ? mapWaiver(row) : null;
      },

      async listForBooking(bookingId: string): Promise<WaiverRecord[]> {
        const rows: any[] = await sql()`
          select * from waivers where booking_id = ${bookingId}::uuid order by created_at
        `;
        return rows.map(mapWaiver);
      },

      async listUnsignedStartingBetween(from: Date, to: Date): Promise<WaiverRecord[]> {
        const rows: any[] = await sql()`
          select w.* from waivers w
          join bookings b on b.booking_id = w.booking_id
          join booking_guests g on g.guest_id = w.guest_id
          where w.status <> 'signed'
            and w.reminder_sent_at is null
            and b.status = 'confirmed'
            and g.status = 'confirmed'
            and w.session_starts_at >= ${from}
            and w.session_starts_at < ${to}
        `;
        return rows.map(mapWaiver);
      },
    },

    config: {
      async all(): Promise<ConfigEntry[]> {
        const rows: any[] = await sql()`select * from app_config order by key`;
        return rows.map((r) => ({
          key: r.key,
          value: r.value,
          updatedAt: iso(r.updated_at),
          updatedBy: r.updated_by ?? null,
          sourceNote: r.source_note ?? null,
        }));
      },
      async set(key, value, actor, sourceNote): Promise<void> {
        const s = sql();
        await s`
          insert into app_config (key, value, updated_by, source_note)
          values (${key}, ${s.json(value as never)}, ${actor}, ${sourceNote ?? null})
          on conflict (key) do update
            set value = excluded.value,
                updated_at = now(),
                updated_by = excluded.updated_by,
                source_note = coalesce(excluded.source_note, app_config.source_note)
        `;
      },
    },

    members: {
      async getByEmail(email: string): Promise<MemberRecord | null> {
        const [row]: any[] = await sql()`
          select * from members_cache where lower(email) = ${email.toLowerCase()}
        `;
        return row ? mapMember(row) : null;
      },
      async get(memberId: string): Promise<MemberRecord | null> {
        const [row]: any[] = await sql()`select * from members_cache where member_id = ${memberId}`;
        return row ? mapMember(row) : null;
      },
      async upsertMany(members: MemberRecord[]): Promise<void> {
        if (members.length === 0) return;
        const s = sql();
        const rows = members.map((m) => ({
          member_id: m.memberId,
          email: m.email,
          first_name: m.firstName,
          last_name: m.lastName,
          status: m.status,
          home_venue_id: m.homeVenueId,
          synced_at: new Date(),
        }));
        await s`
          insert into members_cache ${s(rows as any, 'member_id', 'email', 'first_name', 'last_name', 'status', 'home_venue_id', 'synced_at')}
          on conflict (member_id) do update
            set email = excluded.email,
                first_name = excluded.first_name,
                last_name = excluded.last_name,
                status = excluded.status,
                home_venue_id = excluded.home_venue_id,
                synced_at = excluded.synced_at
        `;
      },
      async lastSyncAt(): Promise<string | null> {
        const [row]: any[] = await sql()`select max(synced_at) as synced_at from members_cache`;
        return row?.synced_at ? iso(row.synced_at) : null;
      },
    },

    auth: {
      async createToken({ tokenHash, email, memberId, expiresAt, ip }): Promise<void> {
        await sql()`
          insert into auth_tokens (token_hash, email, member_id, expires_at, created_ip)
          values (${tokenHash}, ${email}, ${memberId}, ${expiresAt}, ${ip ?? null}::inet)
        `;
      },
      async consumeToken(tokenHash: string): Promise<{ email: string; memberId: string } | null> {
        // Single statement: the WHERE clause is the guard, so a replayed link
        // cannot be consumed twice even under concurrent requests.
        const [row]: any[] = await sql()`
          update auth_tokens
             set consumed_at = now()
           where token_hash = ${tokenHash}
             and consumed_at is null
             and expires_at > now()
          returning email, member_id
        `;
        return row ? { email: row.email, memberId: row.member_id } : null;
      },
      async throttle(bucketKey: string, limit: number, windowMs: number): Promise<boolean> {
        const windowStart = new Date(Date.now() - windowMs);
        const [row]: any[] = await sql()`
          insert into auth_throttle (bucket_key, hits, window_start)
          values (${bucketKey}, 1, now())
          on conflict (bucket_key) do update
            set hits = case when auth_throttle.window_start < ${windowStart} then 1 else auth_throttle.hits + 1 end,
                window_start = case when auth_throttle.window_start < ${windowStart} then now() else auth_throttle.window_start end
          returning hits
        `;
        return toNumber(row.hits) <= limit;
      },
      async getStaffByEmail(email: string): Promise<StaffRecord | null> {
        const [row]: any[] = await sql()`
          select * from staff_users where lower(email) = ${email.toLowerCase()} and active
        `;
        return row
          ? { staffId: row.staff_id, email: row.email, displayName: row.display_name, role: row.role, venueIds: row.venue_ids ?? [], active: row.active }
          : null;
      },
      async getStaff(staffId: string): Promise<StaffRecord | null> {
        const [row]: any[] = await sql()`select * from staff_users where staff_id = ${staffId}::uuid and active`;
        return row
          ? { staffId: row.staff_id, email: row.email, displayName: row.display_name, role: row.role, venueIds: row.venue_ids ?? [], active: row.active }
          : null;
      },
    },

    audit: {
      async listForSession(sessionId: string, limit = 200): Promise<AuditRow[]> {
        const rows: any[] = await sql()`
          select * from capacity_audit where session_id = ${sessionId}::uuid
          order by created_at desc limit ${limit}
        `;
        return rows.map(mapAudit);
      },
      async listForVenueBetween(venueId: string, from: Date, to: Date): Promise<AuditRow[]> {
        const rows: any[] = await sql()`
          select a.* from capacity_audit a
          join sessions s on s.id = a.session_id
          where s.venue_id = ${venueId} and a.created_at >= ${from} and a.created_at < ${to}
          order by a.created_at
        `;
        return rows.map(mapAudit);
      },
    },

    outbox: {
      async enqueue({ toEmail, template, payload }): Promise<string> {
        const s = sql();
        const [row]: any[] = await s`
          insert into email_outbox (to_email, template, payload)
          values (${toEmail}, ${template}, ${s.json(payload as never)})
          returning email_id
        `;
        return row.email_id;
      },
      async markSent(emailId: string, providerId: string | null): Promise<void> {
        await sql()`
          update email_outbox set status = 'sent', sent_at = now(), provider_id = ${providerId}
          where email_id = ${emailId}::uuid
        `;
      },
      async markFailed(emailId: string, error: string): Promise<void> {
        await sql()`
          update email_outbox set status = 'failed', attempts = attempts + 1, last_error = ${error}
          where email_id = ${emailId}::uuid
        `;
      },
      async pending(limit: number): Promise<OutboxEntry[]> {
        const rows: any[] = await sql()`
          select * from email_outbox
          where status <> 'sent' and attempts < 5
          order by created_at limit ${limit}
        `;
        return rows.map((r) => ({
          emailId: r.email_id,
          toEmail: r.to_email,
          template: r.template,
          payload: r.payload,
          status: r.status,
          attempts: toNumber(r.attempts),
        }));
      },
    },

    venue: {
      async get(venueId: string) {
        const [row]: any[] = await sql()`select * from venues where venue_id = ${venueId}`;
        return row ? { venueId: row.venue_id, name: row.name, timezone: row.timezone } : null;
      },
    },

    async close(): Promise<void> {
      if (shared) {
        await shared.end({ timeout: 5 });
        shared = null;
        overrideConnectionString = null;
      }
    },
  };
}

/** Escape hatch for the integration test, which needs raw SQL to reset state. */
export function rawSql(): Sql {
  return sql();
}
