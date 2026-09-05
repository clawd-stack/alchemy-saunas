# Alchemy East Fremantle member booking channel, PRD v2.0 (as-built)

**Owner (this spec):** The Architect
**Build owner:** Ragan Software Tools Engineer ("Git")
**Primary users:** Alchemy members (booking), their guests (waiver), Alchemy door and management staff (schedule, settings). **Commissioning stakeholder:** James Jordan, CIO, Ragan (Alchemy is a Ragan strategic investment, roughly $1.7M equity and $2.5M loans).
**Date:** 2026-09-05
**Status:** Reference spec, sufficient to rebuild the shipped system from nothing. Supersedes PRD v1.0 (2026-09-04), which specified magic-link sign-in and no drawn signature.

This is the architectural spec and product requirements. It does not include Git's system prompt (Project Designer) and it does not include code. It tells Git what to build and to what standard.

**One caveat on sourcing.** This PRD is grounded in the shipped codebase (`clawd-stack/alchemy-saunas`, `member-booking/`, `main` at commit `7f21c1c`), not in the Ragan `registry.md` or `memory/` files, which are not mounted in the environment this was written from. Nothing here depends on a Ragan portfolio figure, so no number in this document goes stale.

---

## 1. Locked decisions

| Decision | Value | Implication |
|---|---|---|
| Build target | Static pages plus serverless functions on Netlify, Postgres (Netlify DB / Neon) | No framework, no build step for the front end. Migrations run automatically on deploy and block publish on failure. |
| Inventory model | This channel owns a ringfenced allocation, Hapana keeps its own | The two allocations are disjoint by construction, so no cross-system race is possible. Read-only Hapana access is sufficient. |
| Capacity | **10 spots per session**, hourly sessions | The allocation is the rule that governs the build. A venue-wide ceiling is optional and off by default. |
| Operating hours | 5am to 9pm, seven days, 60 minute sessions | Last session starts 8pm. Sixteen per day. Held in config, so a timetable change is an edit, not a release. |
| Guests | Up to 3 per member, $35 each | Collected by EFTPOS at the door. The software records that it happened and moves no money. |
| Sign-in | Email and password, issued by a manager | Changed from PRD v1.0's magic link: the venue needed to hand credentials over in person, and members cannot always receive email at the door. |
| Waiver | Alchemy's published conditions, Terms of Use as the binding document, drawn signature required | The wording is configuration, versioned, editable without a deploy. |
| Datastore | Postgres | Correct capacity under concurrent booking needs an atomic conditional write. A key-value store cannot provide that honestly. |
| Audience | Members by private link, staff at `/admin/` | The private URL is a distribution choice, never an access control. |

Git should not redesign around these without escalating.

---

## 2. Objective and success criteria

**Objective.** The venue is permitted more people per hour than the public Hapana channel sells. This opens a ringfenced slice of that unused capacity to members, without standing up a second membership database, and without any possibility of overselling the room. Members book their included spot by private link and bring up to three guests at $35 each, paid at the door. Guests sign a waiver before they arrive. Door staff work from a schedule that tells them who is coming, what is owed and whose waiver is outstanding.

**Success criteria (v1 is done when):**

1. Twenty genuinely concurrent booking requests against a session with three spots left produce exactly three bookings and seventeen clean refusals, proven against real Postgres, not mocked.
2. A member with an active Hapana membership can sign in, book a spot plus up to three guests, see what is owed, and cancel up to the cutoff.
3. Each guest receives their own waiver at their own address, signs it with a drawn signature, and the signature and its version are retrievable afterwards.
4. Door staff can open the day's schedule on a phone, mark payment collected and check people in, and export the day as CSV.
5. A manager can change capacity, pricing, the booking window, the waiver wording and staff access from a screen, with no deploy.
6. `GET /api/health` reports readiness and names every outstanding blocker plainly.

**Explicit non-goals for v1.** No payments of any kind. No waitlist. No no-show tracking. No guest self-service booking (a guest exists only as a member's guest). No native app. No second venue in the UI, though the data model is multi-venue throughout so a second venue is configuration rather than a rebuild. The Ragan standing non-goals (no trade or payment actions, no investment recommendations) are not meaningful here: this is an operating tool for a portfolio company, not a portfolio tool. Payments are excluded on their own merits, above.

---

## 3. Architecture

**Pattern: thin serverless API over a database that owns the rules.**

```
Webflow page (private link)
        |
        v
web/ static pages  ──►  netlify/functions/*  ──►  src/domain (rules not in SQL)
   no framework            one file per route          |
   no build step                                       ├──► src/store  ──► Postgres
                                                       |         (create_member_booking
                                                       |          holds the row lock)
                                                       └──► src/adapters/hapana
                                                                 (membership, sessions)
                                             hourly crons: waiver reminders, membership sync
```

**Why this shape.** Capacity correctness is the property the build exists for, so the capacity rule lives in one database function under a row lock, and nothing else may insert a booking. The API layer calls it rather than reimplementing it. The alternative considered was enforcing capacity in application code with an advisory lock or an optimistic retry loop: rejected because it puts the invariant in the layer that has the most callers and the least transactional guarantee, and because it cannot be proven with a concurrency test that means anything.

The second structural choice is the store abstraction. `src/store/types.ts` defines the interface; `pg.ts` and `memory.ts` implement it. That is what lets the whole suite run offline with no database, which in turn is what makes the tests worth running on every change.

The third is the Hapana boundary. Every Hapana-shaped thing sits in `src/adapters/hapana/`, and every field mapping sits in one file (`mapping.ts`), which tries several spellings per field because the live payload could not be confirmed from the build environment. When a real payload arrives, one file changes.

**Components Git builds:**

1. **Database schema and functions.** Tables, the booking and cancellation functions, the availability view.
2. **Store layer.** One interface, a Postgres implementation, an in-memory implementation for tests and local work.
3. **Hapana adapter.** Client, field mapping, adapter, mock, plus a read-only probe script.
4. **Domain services.** Booking, membership, sessions and timetable, waivers, door list, config, bootstrap.
5. **API functions.** One file per route, plus two scheduled jobs.
6. **Front end.** Member booking page, member account, guest waiver, staff schedule, admin area.

**Recommended stack.** TypeScript on Node 20 or later, Netlify Functions with `runtimeAPIVersion: 2`, the `postgres` npm client, `nodemailer` for SMTP, Vitest. Plain HTML, CSS and ES modules for the front end with no framework and no bundler. Total production dependencies: three. Git may choose otherwise with a stated reason, but dependency-light is the standing preference and the front end genuinely does not need a framework.

**Scheduling.** Two Netlify scheduled functions, both hourly, declared in the function file itself (`export const config = { schedule: '@hourly' }`) so no plugin or dashboard setting is involved.

---

## 4. Users and access

| User | Role | Access |
|---|---|---|
| Member | Books own spot and guests | Private link to the booking page. Signs in with email and password. Membership re-verified server-side at the moment of booking, never trusted from the cookie. |
| Guest | Signs a waiver | A single-use tokenised link, emailed to their own address. No account, no booking access, sees nothing but their own waiver. |
| Door staff (`door`) | Runs the door | Schedule, payment and check-in, daily CSV. No settings, no people, no audit. |
| Manager (`manager`) | Runs the venue | Everything `door` has, plus settings, waiver wording and the audit log. |
| Admin (`admin`) | Owns the system | Everything, plus People (accounts, roles, passwords). |

**How access is enforced.** Signed session cookies (`alchemy_member`, `alchemy_staff`), HttpOnly, SameSite=Lax, Secure in production, twelve hours. Staff pages are gated server-side by role on every request, not by hiding links. The member header carries no staff links at all: staff reach the admin area by going to `/admin/` directly, which is its own sign-in page. The private booking URL distributes the page; it does not protect it.

---

## 5. Requirements

### 5.1 Configuration

One store, editable from the admin screen without a deploy. Rows in `app_config` are merged over code defaults, so a missing row is never fatal.

| Key | Default | Definition |
|---|---|---|
| `member_channel_capacity` | 10 | Spots this channel sells per session. The rule that governs the build. |
| `venue_maximum` | null | Optional ceiling across all channels. Null switches off both the check and its dependency on knowing what Hapana sold. When set, enforced strictly, and the screen refuses to accept it without a recorded source note. |
| `hapana_public_capacity` | 0 | What the public channel holds, used only when a ceiling is configured. |
| `booking_window_days` | 14 | How far ahead a member may book. |
| `cancellation_cutoff_hours` | 3 | Cancellation closes this many hours before the session starts. |
| `max_guests_per_member` | 3 | Guests per booking. |
| `guest_price` | 35 | AUD per guest, collected at the door. |
| `session_length_minutes` | 60 | Session length, also used to generate the timetable. |
| `operating_hours` | 05:00 to 21:00, all seven days | `{ mon: ["05:00","21:00"], ... }`. Drives timetable generation. |
| `booking_backend` | `local` | `local` (this service owns the allocation) or `hapana` (Hapana holds all inventory). A config change, not a deploy. |
| `waiver_text` | Alchemy's published conditions | Title, intro, terms URL and label, clauses, declaration. |
| `waiver_version` | `ALCHEMY-TOU-2026-09B` | Stamped on every signature. Bump whenever the wording changes. |
| `support_email` | support@alchemysaunas.com.au | Shown as "Email us" under the sign-in form and in the member menu. Blank hides it. |
| `venue_address` | 34 Duke St, East Fremantle | Shown on the session a member is about to book. Blank hides it. |
| `member_session_days` | 30 | **Dead key.** A leftover from magic-link sign-in; nothing reads it. See open questions. |

Validation is a build requirement, not a note: the screen must refuse an allocation that would oversell the room, a negative price, a session length over 480 minutes, a support address that is not an address, and a waiver with no declaration or no clauses.

### 5.2 Capacity and booking rules

Every booking goes through one function, `create_member_booking`. Nothing else may insert a booking. It takes a row lock on the session, then evaluates in this order inside one transaction:

| # | Rule | Refusal code |
|---|---|---|
| 1 | Guest count within `0..max_guests_per_member` | `GUEST_COUNT_OUT_OF_RANGE` |
| 2 | Every guest has a name and an email | `GUEST_DETAILS_INCOMPLETE` |
| | *Session row materialised and locked `for update`* | |
| 3 | Session not closed | `SESSION_CLOSED` |
| 4 | Member holds no live booking for this session | `ALREADY_BOOKED` |
| 5 | `booked + requested <= member_channel_capacity` | `SESSION_FULL` |
| 6 | Optional: total occupancy at or under `venue_maximum` | `VENUE_CEILING` |

Occupancy is read strictly after the lock, never before. Rule 4 is also enforced by a partial unique index, so it cannot be raced; the check exists to return a friendly code rather than a constraint violation. When a ceiling is configured and public occupancy cannot be established, the caller passes a negative sentinel and the booking is refused: **fail closed, never open**.

Other refusals the API layer owns: `NO_ACTIVE_MEMBERSHIP`, `OUTSIDE_BOOKING_WINDOW`, `SESSION_IN_PAST`, `SESSION_NOT_FOUND`, `PAST_CUTOFF` (cancellation), `OCCUPANCY_UNKNOWN`, `BACKEND_UNAVAILABLE`.

Every book, cancel and refusal writes a row to `capacity_audit` with the occupancy at the time. If the ceiling is ever questioned, that table is the evidence.

**This must be proven, not asserted.** The integration suite runs twenty concurrent booking requests on twenty separate connections against a session with three spots left and asserts exactly three bookings and seventeen refusals, against real Postgres.

### 5.3 Membership verification

Only `active` may book. Every other outcome, including an address that is not a member at all, collapses to one refusal (`NO_ACTIVE_MEMBERSHIP`) with one message, so the endpoint cannot be used to work out who holds a membership.

An unrecognised membership status is treated as not bookable. An unknown state refusing a booking is a support call; an unknown state permitting one is an unauthorised entry.

Membership is read from Hapana, cached in `members_cache`, and refreshed hourly. Manually added members (`source = 'manual'`) are never overwritten by a sync, which is what lets the channel run before Hapana credentials exist.

### 5.4 Sessions and timetable

Under `local`, the timetable is generated from `operating_hours` and `session_length_minutes` in the venue timezone (Australia/Perth), materialised into `sessions` on demand and hourly. Session keys are deterministic, so regenerating does not duplicate.

Under `hapana`, sessions come from Hapana and are upserted locally. A Hapana read failure must surface as maintenance, never as an empty timetable that reads like a sold-out venue.

Availability returned to a member shows this channel's allocation only. Venue-wide occupancy is operational information and is never sent to a member.

### 5.5 Authentication

- Email and password. Passwords hashed with scrypt (N=2^15, r=8, p=1), format `scrypt$N$r$p$salt$hash`. Never a reversible or unsalted digest.
- One credential row per email, separate from both `staff_users` and `members_cache`, so a credential outlives a cache refresh and can be revoked on its own. A credential alone never grants access to a lapsed member: membership is re-checked at every sign-in.
- `must_change` is set on every manager-issued password and cleared once the person picks their own. It produces a notice, not a gate: the sign-in has already succeeded and the change form opens from the Change password control.
- Sign-in failures are identical whatever went wrong (no such address, wrong password, deactivated account, lapsed membership).
- Rate limit: 8 attempts per email or IP per 15 minutes.
- Sessions: signed cookies, 12 hours, HttpOnly, SameSite=Lax, Secure in production.
- An optional environment-variable bootstrap admin (`ADMIN_BOOTSTRAP_EMAIL` / `ADMIN_BOOTSTRAP_PASSWORD`) reconciles on sign-in: it creates the credential if missing and repairs it if the stored hash or the `must_change` flag does not match. This is how the first admin gets in without a password hash being committed to a public repository.

### 5.6 Member booking page

The layout follows the Alchemy app: a horizontal day strip, a day heading, then one row per session.

| Element | Content |
|---|---|
| Session row, left | Start time, length ("1 hr"), spots left |
| Session row, middle | "Member session", venue name |
| Session row, right | Book, Selected, or Full |
| Selected session | Date and time, then `34 Duke St, East Fremantle · 1 hr session` |
| Guests | Add up to the lesser of `max_guests_per_member` and the spots actually left |
| Total | "Due at the door", guests times `guest_price` |
| Your bookings | Upcoming, with cancel where the cutoff allows |

Behaviour that must not regress:

- Exactly one of the sign-in form and the booking section is ever on screen. Both pages start on a spinner, cleared in a `finally`, so an API failure does not strand it.
- The header is redrawn after a successful sign-in. It reads the session once at page load, which on a sign-in screen is a signed-out answer, so anything that signs in must refresh it. Otherwise "My account" and the member's name appear only after a reload.
- A session filling up between page load and confirm is handled, not crashed on, and re-reads availability.

### 5.7 Guest waiver

Each confirmed guest gets their own waiver at their own address. The member never signs on a guest's behalf. An unsigned waiver does not block the booking: it shows as unsigned on the schedule and is resolved at the venue.

- The token arrives in the URL **fragment**, not the query string, so it is never sent to the server as part of a navigation and never lands in an access log or a Referer header.
- Tokens are stored as SHA-256 hashes. A reminder rotates the token on the same record rather than creating a second waiver, because the original could not be re-sent.
- **The signature is drawn**, with a typed full name alongside it and a tick box for the declaration. Captured as SVG path data in a fixed 1000x400 space (integers, `M` and `L` only), which is a few hundred bytes rather than the tens of kilobytes an image costs, stays sharp at any size, and cannot carry markup. The pad is held to the same aspect ratio in CSS so a signature drawn on a phone records the same shape as one drawn on a laptop.
- Server-side validation admits nothing but that shape, and a single tap with no line is refused as a smudge rather than recorded as a signature.
- A guest who has signed sees their signature back, not just a timestamp.
- `waiver_version` is stamped on every signature. Waivers signed before a wording change keep the version they agreed to.
- Waiver records are retained independently of bookings and survive cancellation. They are a liability document.

### 5.8 Staff schedule (the door list)

Built for a phone or tablet held at a door: big touch targets, one session at a time, no horizontal scrolling on the primary columns. Called **Schedule** in the interface; the route is `/doorlist.html`.

Per session: the member, spots, amount owed, payment status, check-in state, and each guest with their waiver status. Staff can mark payment collected, check a member or guest in, and open a fresh waiver link on the device for a guest signing at the door (which rotates the token, so the waiver stays one document with one signature history).

Payment status records what the EFTPOS terminal collected. It is a reconciliation record, not a payment.

### 5.9 Admin area

At `/admin/`, its own sign-in page, no links to it from the member header. A hub lists the destinations the signed-in role may reach.

| Page | Roles | Contents |
|---|---|---|
| Schedule | door, manager, admin | As 5.8 |
| Settings | manager, admin | Configuration in labelled groups: capacity, booking window, guests, contact, inventory |
| Waiver | manager, admin | The wording guests sign, its declaration, its terms link and its version |
| People | admin | One list of everyone, with a role each: member, door, manager, admin. Add, deactivate, issue a password, change a role |
| Audit | manager, admin | The capacity audit log, plus CSV export of the whole range |

**People is one list, not three.** An address is either staff or a member, never both, and moving between them is a role change. Adding somebody who already exists never overwrites their password. The last admin cannot demote or remove themselves.

### 5.10 Email

Provider is pluggable: `smtp` (a mailbox the business already owns, no new vendor), `resend` or `postmark`, or `console` for local work. `console` delivers nothing and must never be the production setting; `GET /api/health` reports on it.

Every send is written to `email_outbox` first and marked sent afterwards, so a provider outage leaves a queue rather than a silence. Templates: booking confirmation, waiver invite, waiver reminder, cancellation notice.

### 5.11 Scheduled jobs

| Job | Cadence | Behaviour |
|---|---|---|
| Waiver reminders | hourly | One reminder per waiver, 24 hours out, for anything unsigned. `reminder_sent_at` keeps it to one however often the job runs. Does not chase a guest whose spot was cancelled. |
| Membership sync | hourly | Refreshes the membership cache from Hapana and materialises the timetable ahead. Never overwrites manually added members. |

### 5.12 Health

`GET /api/health` returns a `readyForMembers` boolean and a check per blocker: store (a real database, not the in-memory one), Hapana credentials, email provider, waiver wording (placeholder or real), admin sign-in exists, admin bootstrap state, and, when a venue ceiling is configured, whether it has a recorded source. Load it before pointing members at the channel.

### 5.13 Audit and reconciliation

`capacity_audit` holds every book, cancel and refusal with the occupancy at the time: session, booking, action, refusal code, spots delta, member channel booked after, member channel capacity, public booked at the time, venue total after, venue maximum at the time, actor, timestamp.

The daily reconciliation CSV columns: `date, session_starts_at, session_label, booking_id, member_name, member_email, status, spots_total, guest_spots, guest_names, amount_owed_aud, payment_status, amount_collected_aud, guests_checked_in, waivers_signed, waivers_outstanding`.

The audit export quotes text that would otherwise be read as a spreadsheet formula, and leaves numbers unquoted so the columns can be summed.

---

## 6. Recommended additions

| Addition | Why it matters | v1 / vNext |
|---|---|---|
| Signed-waiver viewer for staff | The signature is captured and stored but no staff screen shows it. A liability record nobody can retrieve is worth less than it should be | vNext, small |
| Waiver export per session or date range | The likely real request when an insurer or Alex Beagley asks | vNext |
| Retention policy on waivers | They are kept indefinitely by default. That is a decision to make, not a default to inherit | vNext, needs a decision |
| Named owner for the daily EFTPOS reconciliation | With no payment integration, this is the only control against guest revenue leaking. The export is worthless unless somebody checks it against the terminal settlement | Operational, not a build item |
| Second venue | The data model is multi-venue throughout. Opening one is configuration plus a venue row | vNext |

---

## 7. Data model

Postgres. Thirteen tables and four functions.

```
app_config(key, value jsonb, updated_at, updated_by, source_note)
venues(venue_id, name, timezone, ...)
sessions(id, venue_id, external_session_id, starts_at, ends_at,
         member_channel_capacity_override, closed, public_booked_cache)
  unique (venue_id, external_session_id)
bookings(booking_id, session_id, member_id, member_name, member_email,
         spots_total, guest_spots, amount_owed_aud, status, payment_status,
         member_checked_in, external_booking_id, created_at, cancelled_at)
  partial unique (session_id, member_id) where status = 'confirmed'
booking_guests(guest_id, booking_id, name, email, status, checked_in)
waivers(waiver_id, token_hash, booking_id, guest_id, venue_id, session_starts_at,
        guest_name, guest_email, status, waiver_version, sent_at, reminder_sent_at,
        signed_at, signed_name, signature, signed_ip, signed_user_agent, created_at)
capacity_audit(event_id, session_id, booking_id, action, refusal_code, spots_delta,
               member_channel_booked_after, member_channel_capacity,
               public_booked_at_time, venue_total_booked_after,
               venue_maximum_at_time, actor, created_at)
members_cache(member_id, email, first_name, last_name, status, home_venue_id,
              source, synced_at)
user_credentials(email, password_hash, must_change, active, last_login_at, ...)
staff_users(staff_id, email, display_name, role, venue_ids[], active)
staff_sessions(token_hash, staff_id, expires_at)
auth_tokens(...)          -- retained from magic-link sign-in
auth_throttle(...)        -- sign-in rate limiting
email_outbox(email_id, to_email, template, payload jsonb, status, attempts,
             last_error, provider_id, created_at, sent_at)
```

Functions: `create_member_booking`, `cancel_member_booking`, `cancel_guest_spot`, `session_availability`, plus the helper `member_channel_capacity_for`.

**Migrations are immutable once applied.** They are checksummed and applied in sorted order before a deploy publishes, and a failed migration blocks the publish. A mistake in a migration that has run is repaired by a new migration, never by editing the old one. Deploy previews get their own database branch, so a preview can never write to production data.

---

## 8. Non-functional requirements

**Security and privacy.**
- Credentials are read in `src/lib/env.ts` and nowhere else. Nothing under `src/` is imported by anything in `web/`, so no credential can reach a client bundle.
- Sign-in and waiver tokens are stored as SHA-256 hashes. A database dump cannot be replayed into an account.
- Membership failures return one message, so the endpoint cannot enumerate members.
- The schedule exposes member and guest contact details and therefore requires staff authentication.
- **The repository is public.** No password hash, key or token may be committed, including in a migration. Bootstrap credentials come from environment variables.
- Headers set at the edge: `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, `X-Frame-Options: SAMEORIGIN` everywhere except the booking embed, which instead carries a `frame-ancestors` policy naming the Alchemy domains.

**Reliability.** A Hapana outage reads as maintenance, never as an empty timetable. A booking is refused rather than guessed at when occupancy cannot be established. Email failures queue rather than vanish. Every page clears its spinner in a `finally`, so a 500 shows an error rather than a hang.

**Portability.** Runs with no database and no Hapana key locally (in-memory store, Hapana mock, `console` email). Both fallbacks refuse to start in production, so neither can be reached by accident.

**Maintainability.** No business rule is expressed twice: the capacity rules exist only in `create_member_booking`. Every Hapana field mapping is in one file. All tunable values are in one config store.

**Testing.** 212 tests, of which 20 need Postgres. The offline majority must stay offline: no network, no database. The Postgres set is gated on `DATABASE_URL` and is where the concurrency proof lives.

**Performance.** Trivial at this scale. Sixteen sessions a day, ten spots each.

---

## 9. Dependencies and prerequisites

1. **Hapana API credentials**, read access sufficient. Rotate the key first if it has ever been sent through chat or email, and name the client distinctly (`east-fremantle-member-channel`) so it can be revoked on its own. Until it exists, the People list is the entire membership the channel knows. **Owner: Alchemy.**
2. **Hapana write capability**, still unconfirmed, because the build environment cannot reach Hapana (egress policy blocks `api.hapana.com`). Does not block go-live: `local` ships by default and needs read access only. Resolve by running `scripts/probe-hapana.mjs` from a machine that can reach Hapana; it issues GET requests only and never creates a booking. **Owner: whoever runs the probe.**
3. **A real email provider.** SMTP through a mailbox the business already owns is the cheapest correct answer. **Owner: Alchemy.**
4. **`SESSION_SECRET`**, 32 random bytes, in the Netlify environment. **Owner: whoever deploys.**
5. **The Webflow page** and its private URL, with the booking page embedded or framed. **Owner: Alchemy.**
6. **Real staff accounts**, replacing any seeded placeholder, with a decision on who holds `admin` versus `manager` versus `door`. **Owner: Alchemy.**
7. **Legal sign-off on the waiver wording**, if wanted. What ships is Alchemy's own published wording, not wording drafted for this guest-of-a-member flow. Changing it is a config edit, not a rebuild. **Owner: James / Alex Beagley.**

---

## 10. Acceptance criteria (v1)

- Twenty concurrent bookings against three remaining spots produce exactly three bookings and seventeen refusals, against real Postgres.
- A member can sign in, book with guests, see the amount owed, and cancel before the cutoff. After the cutoff, cancellation is refused with the venue's phone number.
- Each guest receives a waiver at their own address, signs it with a drawn signature, and sees it back afterwards. A single tap is refused.
- The schedule shows the day, payment and waiver state per booking, and the CSV export reconciles to it.
- A manager can change capacity, price, window, waiver wording and staff roles from the screen with no deploy, and the screen refuses an allocation that would oversell the room.
- `GET /api/health` returns `readyForMembers: true` with every check green on a correctly configured deployment.
- Full suite green, typecheck clean, no credential in the repository.

---

## 11. Boundaries and hand-off

- **Git builds:** the schema and functions, the store layer, the Hapana adapter, the domain services, the API functions, the front end, the tests.
- **Not Git's job:** the Hapana credential and the probe run (Alchemy); the email provider (Alchemy); the Webflow page (Alchemy); legal sign-off on the waiver wording (James / Alex Beagley); the decision on who reconciles the daily CSV (Alchemy); any Cowork project prompt to own this long-term (Project Designer, from this PRD).
- **The Architect retains:** this PRD, the architecture, and the Build Pipeline entry.

---

## 12. Open questions for James

1. **Does the drawn signature satisfy the insurer, and does Alex Beagley want different wording for a guest-of-a-member?** What ships is Alchemy's published conditions with the website Terms of Use as the binding document. It is a config edit either way.
2. **How long are waivers kept?** They are retained indefinitely today. A stated period is better than an inherited default.
3. **Who checks the daily EFTPOS CSV against the terminal settlement?** With no payment integration this is the only control against guest revenue leaking, and it needs a name.
4. **Is the channel a permanent member benefit or a pilot?** This changes the copy on the page and how hard it is to withdraw later. The page currently says neither, which is honest but not a decision.
5. **`member_session_days` is dead configuration**, left over from magic-link sign-in; sessions are a fixed twelve hours. Remove the key, or wire it up so a sign-in handed over at the venue lasts longer than a shift? A door tablet re-authenticating mid-shift is the failure case worth avoiding.
