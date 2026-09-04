-- =====================================================================
-- Alchemy East Fremantle member booking channel
-- Schema, constraints and the atomic booking function.
--
-- Run against a Postgres 14+ database (Supabase project or plain Postgres).
-- Safe to re-run: everything is IF NOT EXISTS / CREATE OR REPLACE.
--
-- The single most important thing in this file is create_member_booking().
-- It is the only path that may create a booking, and it evaluates every
-- capacity rule inside one transaction holding a row lock on the session.
-- No application code is permitted to insert into bookings directly.
-- =====================================================================

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------------
-- Configuration. One row per key, edited by the venue manager or James
-- through the admin page, with no deploy.
-- ---------------------------------------------------------------------
create table if not exists app_config (
  key           text primary key,
  value         jsonb        not null,
  updated_at    timestamptz  not null default now(),
  updated_by    text,
  source_note   text -- documentary source, required for venue_maximum
);

-- ---------------------------------------------------------------------
-- Venues. v1 is East Fremantle only, but nothing is keyed on that.
-- ---------------------------------------------------------------------
create table if not exists venues (
  venue_id      text primary key,
  name          text not null,
  timezone      text not null default 'Australia/Perth',
  active        boolean not null default true,
  created_at    timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- Sessions. Under Pattern A these mirror a Hapana class occurrence and are
-- created lazily on first member-channel booking. Under Pattern B they are
-- generated from the venue timetable and are the authoritative inventory
-- for this channel's ringfenced allocation.
-- ---------------------------------------------------------------------
create table if not exists sessions (
  id                              uuid primary key default gen_random_uuid(),
  venue_id                        text not null references venues(venue_id),
  external_session_id             text not null,          -- Hapana session/class-occurrence id, or generated key under Pattern B
  starts_at                       timestamptz not null,
  ends_at                         timestamptz not null,
  -- Null means "use the configured default". A per-session override exists so a
  -- one-off (private hire, maintenance) can be closed without touching config.
  member_channel_capacity_override integer,
  -- Last known public-channel occupancy, refreshed from Hapana before each
  -- booking attempt. Used for the independent ceiling assertion.
  public_booked_cached            integer not null default 0,
  public_booked_cached_at         timestamptz,
  closed                          boolean not null default false,
  created_at                      timestamptz not null default now(),
  constraint sessions_window_valid check (ends_at > starts_at),
  constraint sessions_capacity_override_sane check (member_channel_capacity_override is null or member_channel_capacity_override >= 0),
  unique (venue_id, external_session_id)
);

create index if not exists sessions_venue_start_idx on sessions (venue_id, starts_at);

-- ---------------------------------------------------------------------
-- Bookings. Never hard-deleted; cancellation sets status and timestamp.
-- ---------------------------------------------------------------------
do $$ begin
  create type booking_status as enum ('confirmed', 'cancelled');
exception when duplicate_object then null; end $$;

do $$ begin
  create type payment_status as enum ('outstanding', 'collected', 'waived');
exception when duplicate_object then null; end $$;

create table if not exists bookings (
  booking_id        uuid primary key default gen_random_uuid(),
  venue_id          text not null references venues(venue_id),
  session_id        uuid not null references sessions(id),
  starts_at         timestamptz not null,          -- denormalised for door list and cutoff maths
  member_id         text not null,                 -- Hapana member identifier
  member_name       text not null,
  member_email      text not null,
  channel           text not null default 'member-private',
  spots_total       integer not null,
  spots_member      integer not null default 1,
  spots_guest       integer not null,
  amount_owed_aud   numeric(10,2) not null default 0,
  payment_status    payment_status not null default 'outstanding',
  payment_marked_at timestamptz,
  payment_marked_by text,
  status            booking_status not null default 'confirmed',
  member_checked_in boolean not null default false,
  -- Set when a booking is rolled back because the downstream backend (Hapana)
  -- refused or was unreachable after we had already reserved locally.
  cancel_reason     text,
  external_booking_id text,                        -- Hapana booking id under Pattern A
  created_at        timestamptz not null default now(),
  cancelled_at      timestamptz,
  constraint bookings_spots_consistent check (spots_total = spots_member + spots_guest),
  constraint bookings_spots_positive check (spots_total >= 1),
  constraint bookings_member_spot check (spots_member = 1),
  constraint bookings_cancelled_has_timestamp check (
    (status = 'cancelled' and cancelled_at is not null) or
    (status = 'confirmed' and cancelled_at is null)
  )
);

create index if not exists bookings_session_status_idx on bookings (session_id, status);
create index if not exists bookings_member_idx on bookings (member_id, starts_at desc);
create index if not exists bookings_venue_start_idx on bookings (venue_id, starts_at);

-- One live booking per member per session (rule 3 in PRD 5.3). Enforced by the
-- database rather than by application logic so it cannot be raced.
create unique index if not exists bookings_one_live_per_member_session
  on bookings (session_id, member_id)
  where status = 'confirmed';

-- ---------------------------------------------------------------------
-- Guests. Cancelled individually (guest-only cancellation) or with the member.
-- ---------------------------------------------------------------------
create table if not exists booking_guests (
  guest_id      uuid primary key default gen_random_uuid(),
  booking_id    uuid not null references bookings(booking_id) on delete restrict,
  name          text not null,
  email         text not null,
  status        booking_status not null default 'confirmed',
  checked_in    boolean not null default false,
  cancelled_at  timestamptz,
  created_at    timestamptz not null default now()
);

create index if not exists booking_guests_booking_idx on booking_guests (booking_id);

-- ---------------------------------------------------------------------
-- Waivers. A liability document. Deliberately NOT cascaded from bookings:
-- a signed waiver survives cancellation of the booking that produced it.
-- ---------------------------------------------------------------------
do $$ begin
  create type waiver_status as enum ('not_sent', 'sent', 'signed');
exception when duplicate_object then null; end $$;

create table if not exists waivers (
  waiver_id       uuid primary key default gen_random_uuid(),
  token_hash      text not null unique,         -- sha256 of the emailed token; raw token never stored
  booking_id      uuid references bookings(booking_id) on delete set null,
  guest_id        uuid references booking_guests(guest_id) on delete set null,
  venue_id        text not null,
  session_starts_at timestamptz not null,
  guest_name      text not null,
  guest_email     text not null,
  status          waiver_status not null default 'not_sent',
  waiver_version  text not null,                -- which legal text was shown
  sent_at         timestamptz,
  reminder_sent_at timestamptz,
  signed_at       timestamptz,
  signed_name     text,                         -- typed name at signature
  signed_ip       inet,
  signed_user_agent text,
  created_at      timestamptz not null default now()
);

create index if not exists waivers_guest_idx on waivers (guest_id);
create index if not exists waivers_booking_idx on waivers (booking_id);
create index if not exists waivers_pending_reminder_idx on waivers (session_starts_at)
  where status <> 'signed';

-- ---------------------------------------------------------------------
-- Capacity audit. Every book and cancel, with the occupancy at the time.
-- This is the evidence that the ceiling was respected.
-- ---------------------------------------------------------------------
create table if not exists capacity_audit (
  event_id                    uuid primary key default gen_random_uuid(),
  session_id                  uuid not null references sessions(id),
  booking_id                  uuid,
  action                      text not null,       -- book | cancel | cancel_guest | refuse
  refusal_code                text,
  spots_delta                 integer not null,
  member_channel_booked_after integer not null,
  member_channel_capacity     integer not null,
  public_booked_at_time       integer not null,
  venue_total_booked_after    integer not null,
  venue_maximum_at_time       integer not null,
  actor                       text,
  created_at                  timestamptz not null default now()
);

create index if not exists capacity_audit_session_idx on capacity_audit (session_id, created_at desc);

-- ---------------------------------------------------------------------
-- Member cache. Pattern B only: last known membership status from Hapana,
-- plus the sync timestamp so staleness can be shown on the door list.
-- ---------------------------------------------------------------------
create table if not exists members_cache (
  member_id     text primary key,
  email         text not null,
  first_name    text,
  last_name     text,
  status        text not null,               -- active | paused | suspended | cancelled
  home_venue_id text,
  synced_at     timestamptz not null default now()
);

create index if not exists members_cache_email_idx on members_cache (lower(email));

-- ---------------------------------------------------------------------
-- Magic-link auth. Single-use, short-lived, hashed at rest.
-- No passwords are ever created or stored.
-- ---------------------------------------------------------------------
create table if not exists auth_tokens (
  token_hash   text primary key,
  email        text not null,
  member_id    text not null,
  expires_at   timestamptz not null,
  consumed_at  timestamptz,
  created_ip   inet,
  created_at   timestamptz not null default now()
);

create index if not exists auth_tokens_expiry_idx on auth_tokens (expires_at);

-- Rate limiting for the magic-link request endpoint, keyed by email hash and IP.
create table if not exists auth_throttle (
  bucket_key   text primary key,
  hits         integer not null default 0,
  window_start timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- Staff accounts for the door list and admin pages. Door list exposes member
-- and guest contact details, so it is authenticated, not obscured.
-- ---------------------------------------------------------------------
create table if not exists staff_users (
  staff_id      uuid primary key default gen_random_uuid(),
  email         text not null unique,
  display_name  text not null,
  role          text not null default 'door',   -- door | manager | admin
  venue_ids     text[] not null default '{}',
  active        boolean not null default true,
  created_at    timestamptz not null default now()
);

create table if not exists staff_sessions (
  token_hash  text primary key,
  staff_id    uuid not null references staff_users(staff_id) on delete cascade,
  expires_at  timestamptz not null,
  created_at  timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- Outbound email log. Delivery is a provider concern; this is the record
-- that we asked, and the retry queue when the provider is down.
-- ---------------------------------------------------------------------
create table if not exists email_outbox (
  email_id     uuid primary key default gen_random_uuid(),
  to_email     text not null,
  template     text not null,
  payload      jsonb not null,
  status       text not null default 'queued',   -- queued | sent | failed
  attempts     integer not null default 0,
  last_error   text,
  provider_id  text,
  created_at   timestamptz not null default now(),
  sent_at      timestamptz
);

create index if not exists email_outbox_pending_idx on email_outbox (status, created_at)
  where status <> 'sent';

-- =====================================================================
-- Helper: effective member channel capacity for a session
-- =====================================================================
create or replace function member_channel_capacity_for(p_session sessions, p_default integer)
returns integer
language sql
immutable
as $$
  select coalesce(p_session.member_channel_capacity_override, p_default);
$$;

-- =====================================================================
-- create_member_booking
--
-- The only sanctioned way to create a booking. Evaluates PRD 5.3 rules in
-- order, inside one transaction, holding a row lock on the session, and
-- returns a structured result rather than raising, so the API layer can map
-- refusals to specific messages.
--
-- Concurrency: the FOR UPDATE lock on the session row serialises every
-- booking attempt for that session. The occupancy counts are read *after*
-- the lock is granted, so under READ COMMITTED each waiter sees the
-- committed effect of the transaction it waited for. Two members booking
-- the last two spots cannot both succeed.
--
-- Returns jsonb:
--   { "ok": true,  "booking_id": "...", "member_channel_booked_after": 7, ... }
--   { "ok": false, "code": "SESSION_FULL", "detail": {...} }
-- =====================================================================
create or replace function create_member_booking(
  p_venue_id                text,
  p_external_session_id     text,
  p_starts_at               timestamptz,
  p_ends_at                 timestamptz,
  p_member_id               text,
  p_member_name             text,
  p_member_email            text,
  p_guests                  jsonb,        -- [{ "name": "...", "email": "..." }]
  p_default_channel_capacity integer,
  p_venue_maximum           integer,
  p_public_booked           integer,
  p_guest_price             numeric,
  p_max_guests              integer,
  p_actor                   text default null
)
returns jsonb
language plpgsql
as $$
declare
  v_session          sessions%rowtype;
  v_capacity         integer;
  v_booked           integer;
  v_guest_count      integer;
  v_requested        integer;
  v_booking_id       uuid;
  v_guest            jsonb;
  v_total_after      integer;
  v_amount           numeric(10,2);
  v_code             text;
begin
  v_guest_count := coalesce(jsonb_array_length(p_guests), 0);
  v_requested   := 1 + v_guest_count;

  -- Rule 2: spot count bounds. Checked before any write.
  if v_guest_count < 0 or v_guest_count > p_max_guests then
    return jsonb_build_object('ok', false, 'code', 'GUEST_COUNT_OUT_OF_RANGE',
      'detail', jsonb_build_object('requested_guests', v_guest_count, 'max_guests', p_max_guests));
  end if;

  -- Rule 6: guest details complete. Cheap, so done before taking the lock.
  for v_guest in select * from jsonb_array_elements(p_guests) loop
    if coalesce(btrim(v_guest->>'name'), '') = '' or coalesce(btrim(v_guest->>'email'), '') = '' then
      return jsonb_build_object('ok', false, 'code', 'GUEST_DETAILS_INCOMPLETE');
    end if;
  end loop;

  -- Materialise the session row so there is always something to lock.
  insert into sessions (venue_id, external_session_id, starts_at, ends_at)
  values (p_venue_id, p_external_session_id, p_starts_at, p_ends_at)
  on conflict (venue_id, external_session_id) do nothing;

  select * into v_session
  from sessions
  where venue_id = p_venue_id and external_session_id = p_external_session_id
  for update;   -- <<< serialisation point for this session

  if v_session.closed then
    return jsonb_build_object('ok', false, 'code', 'SESSION_CLOSED');
  end if;

  v_capacity := coalesce(v_session.member_channel_capacity_override, p_default_channel_capacity);

  -- Occupancy read strictly after the lock.
  select coalesce(sum(spots_total), 0) into v_booked
  from bookings
  where session_id = v_session.id and status = 'confirmed';

  -- Rule 3: one live booking per member per session. The partial unique index
  -- is the real guard; this check exists to return a friendly code instead of
  -- a constraint violation.
  if exists (
    select 1 from bookings
    where session_id = v_session.id and member_id = p_member_id and status = 'confirmed'
  ) then
    return jsonb_build_object('ok', false, 'code', 'ALREADY_BOOKED');
  end if;

  -- Rule 4: this channel's ringfenced allocation.
  if v_booked + v_requested > v_capacity then
    v_code := 'SESSION_FULL';
    insert into capacity_audit (session_id, action, refusal_code, spots_delta,
      member_channel_booked_after, member_channel_capacity, public_booked_at_time,
      venue_total_booked_after, venue_maximum_at_time, actor)
    values (v_session.id, 'refuse', v_code, 0, v_booked, v_capacity, p_public_booked,
      v_booked + p_public_booked, p_venue_maximum, p_actor);
    return jsonb_build_object('ok', false, 'code', v_code,
      'detail', jsonb_build_object('spots_remaining', greatest(v_capacity - v_booked, 0), 'requested', v_requested));
  end if;

  -- Rule 5: hard venue ceiling across all channels. Independent of whatever
  -- Hapana believes. If p_public_booked could not be established the caller
  -- passes a negative sentinel and we fail closed.
  if p_public_booked < 0 then
    return jsonb_build_object('ok', false, 'code', 'OCCUPANCY_UNKNOWN');
  end if;

  v_total_after := v_booked + p_public_booked + v_requested;
  if v_total_after > p_venue_maximum then
    v_code := 'VENUE_CEILING';
    insert into capacity_audit (session_id, action, refusal_code, spots_delta,
      member_channel_booked_after, member_channel_capacity, public_booked_at_time,
      venue_total_booked_after, venue_maximum_at_time, actor)
    values (v_session.id, 'refuse', v_code, 0, v_booked, v_capacity, p_public_booked,
      v_booked + p_public_booked, p_venue_maximum, p_actor);
    return jsonb_build_object('ok', false, 'code', v_code,
      'detail', jsonb_build_object('venue_maximum', p_venue_maximum, 'would_be', v_total_after));
  end if;

  v_amount := (v_guest_count * p_guest_price)::numeric(10,2);

  insert into bookings (venue_id, session_id, starts_at, member_id, member_name, member_email,
                        spots_total, spots_member, spots_guest, amount_owed_aud)
  values (p_venue_id, v_session.id, v_session.starts_at, p_member_id, p_member_name, p_member_email,
          v_requested, 1, v_guest_count, v_amount)
  returning booking_id into v_booking_id;

  for v_guest in select * from jsonb_array_elements(p_guests) loop
    insert into booking_guests (booking_id, name, email)
    values (v_booking_id, btrim(v_guest->>'name'), lower(btrim(v_guest->>'email')));
  end loop;

  insert into capacity_audit (session_id, booking_id, action, spots_delta,
    member_channel_booked_after, member_channel_capacity, public_booked_at_time,
    venue_total_booked_after, venue_maximum_at_time, actor)
  values (v_session.id, v_booking_id, 'book', v_requested,
    v_booked + v_requested, v_capacity, p_public_booked,
    v_total_after, p_venue_maximum, p_actor);

  return jsonb_build_object(
    'ok', true,
    'booking_id', v_booking_id,
    'session_id', v_session.id,
    'starts_at', v_session.starts_at,
    'spots_total', v_requested,
    'spots_guest', v_guest_count,
    'amount_owed_aud', v_amount,
    'member_channel_booked_after', v_booked + v_requested,
    'member_channel_capacity', v_capacity,
    'venue_total_booked_after', v_total_after
  );
end;
$$;

-- =====================================================================
-- cancel_member_booking
-- Releases the member spot and every guest spot. Audited. Idempotent.
-- =====================================================================
create or replace function cancel_member_booking(
  p_booking_id            uuid,
  p_member_id             text,        -- null for staff/system cancellation
  p_cutoff_hours          integer,
  p_default_channel_capacity integer,
  p_venue_maximum         integer,
  p_reason                text default null,
  p_enforce_cutoff        boolean default true,
  p_actor                 text default null
)
returns jsonb
language plpgsql
as $$
declare
  v_booking   bookings%rowtype;
  v_session   sessions%rowtype;
  v_capacity  integer;
  v_booked    integer;
begin
  select * into v_booking from bookings where booking_id = p_booking_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'NOT_FOUND');
  end if;
  if p_member_id is not null and v_booking.member_id <> p_member_id then
    -- Do not disclose that the booking exists.
    return jsonb_build_object('ok', false, 'code', 'NOT_FOUND');
  end if;
  if v_booking.status = 'cancelled' then
    return jsonb_build_object('ok', true, 'code', 'ALREADY_CANCELLED', 'booking_id', p_booking_id);
  end if;
  if p_enforce_cutoff and v_booking.starts_at - make_interval(hours => p_cutoff_hours) <= now() then
    return jsonb_build_object('ok', false, 'code', 'PAST_CUTOFF',
      'detail', jsonb_build_object('starts_at', v_booking.starts_at, 'cutoff_hours', p_cutoff_hours));
  end if;

  select * into v_session from sessions where id = v_booking.session_id for update;

  update bookings
     set status = 'cancelled', cancelled_at = now(), cancel_reason = p_reason
   where booking_id = p_booking_id;

  update booking_guests
     set status = 'cancelled', cancelled_at = now()
   where booking_id = p_booking_id and status = 'confirmed';

  select coalesce(sum(spots_total), 0) into v_booked
  from bookings where session_id = v_booking.session_id and status = 'confirmed';

  v_capacity := coalesce(v_session.member_channel_capacity_override, p_default_channel_capacity);

  insert into capacity_audit (session_id, booking_id, action, spots_delta,
    member_channel_booked_after, member_channel_capacity, public_booked_at_time,
    venue_total_booked_after, venue_maximum_at_time, actor)
  values (v_booking.session_id, p_booking_id, 'cancel', -v_booking.spots_total,
    v_booked, v_capacity, v_session.public_booked_cached,
    v_booked + v_session.public_booked_cached, p_venue_maximum, p_actor);

  return jsonb_build_object('ok', true, 'booking_id', p_booking_id,
    'spots_released', v_booking.spots_total,
    'member_channel_booked_after', v_booked);
end;
$$;

-- =====================================================================
-- cancel_guest_spot
-- Drops one guest from a live booking before the cutoff. The member spot and
-- the remaining guests are untouched.
-- =====================================================================
create or replace function cancel_guest_spot(
  p_guest_id      uuid,
  p_member_id     text,
  p_cutoff_hours  integer,
  p_guest_price   numeric,
  p_default_channel_capacity integer,
  p_venue_maximum integer,
  p_actor         text default null
)
returns jsonb
language plpgsql
as $$
declare
  v_guest    booking_guests%rowtype;
  v_booking  bookings%rowtype;
  v_session  sessions%rowtype;
  v_booked   integer;
  v_capacity integer;
begin
  select * into v_guest from booking_guests where guest_id = p_guest_id for update;
  if not found or v_guest.status = 'cancelled' then
    return jsonb_build_object('ok', false, 'code', 'NOT_FOUND');
  end if;

  select * into v_booking from bookings where booking_id = v_guest.booking_id for update;
  if v_booking.member_id <> p_member_id or v_booking.status <> 'confirmed' then
    return jsonb_build_object('ok', false, 'code', 'NOT_FOUND');
  end if;
  if v_booking.starts_at - make_interval(hours => p_cutoff_hours) <= now() then
    return jsonb_build_object('ok', false, 'code', 'PAST_CUTOFF');
  end if;

  select * into v_session from sessions where id = v_booking.session_id for update;

  update booking_guests set status = 'cancelled', cancelled_at = now() where guest_id = p_guest_id;

  update bookings
     set spots_guest = spots_guest - 1,
         spots_total = spots_total - 1,
         amount_owed_aud = ((spots_guest - 1) * p_guest_price)::numeric(10,2)
   where booking_id = v_booking.booking_id;

  select coalesce(sum(spots_total), 0) into v_booked
  from bookings where session_id = v_booking.session_id and status = 'confirmed';

  v_capacity := coalesce(v_session.member_channel_capacity_override, p_default_channel_capacity);

  insert into capacity_audit (session_id, booking_id, action, spots_delta,
    member_channel_booked_after, member_channel_capacity, public_booked_at_time,
    venue_total_booked_after, venue_maximum_at_time, actor)
  values (v_booking.session_id, v_booking.booking_id, 'cancel_guest', -1,
    v_booked, v_capacity, v_session.public_booked_cached,
    v_booked + v_session.public_booked_cached, p_venue_maximum, p_actor);

  return jsonb_build_object('ok', true, 'booking_id', v_booking.booking_id, 'guest_id', p_guest_id);
end;
$$;

-- =====================================================================
-- session_availability
-- Availability for a venue across a window, for the booking UI.
-- =====================================================================
create or replace function session_availability(
  p_venue_id text,
  p_from     timestamptz,
  p_to       timestamptz,
  p_default_channel_capacity integer
)
returns table (
  session_id            uuid,
  external_session_id   text,
  starts_at             timestamptz,
  ends_at               timestamptz,
  capacity              integer,
  booked                integer,
  spots_remaining       integer,
  closed                boolean
)
language sql
stable
as $$
  select s.id,
         s.external_session_id,
         s.starts_at,
         s.ends_at,
         coalesce(s.member_channel_capacity_override, p_default_channel_capacity) as capacity,
         coalesce(b.booked, 0) as booked,
         greatest(coalesce(s.member_channel_capacity_override, p_default_channel_capacity) - coalesce(b.booked, 0), 0) as spots_remaining,
         s.closed
  from sessions s
  left join (
    select session_id, sum(spots_total) as booked
    from bookings where status = 'confirmed'
    group by session_id
  ) b on b.session_id = s.id
  where s.venue_id = p_venue_id
    and s.starts_at >= p_from
    and s.starts_at <= p_to
  order by s.starts_at;
$$;
