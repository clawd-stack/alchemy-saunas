# Alchemy East Fremantle, member booking channel

A member-only booking channel for Alchemy East Fremantle: members reach it by
private link, book their own included spot, and bring up to three guests at $35
each, paid by card at the door. Built against PRD v1.0 (2026-09-04).

The venue is permitted more people per hour than the public Hapana channel
sells. This opens a ringfenced slice of that unused capacity to members,
without standing up a second membership database and without any possibility of
overselling the room.

---

## Status

Built and tested. The product decisions are settled:

| Setting | Value |
|---|---|
| Spots per hour | **10**, the limit that governs bookings |
| Operating hours | **5am to 9pm, seven days**, last session starts 8pm |
| Venue-wide ceiling | **Not enforced.** Optional, off by default |
| Guest waiver | Alchemy's published conditions, with the website Terms of Use as the binding document |
| Guests | Up to 3 per member, $35 each, EFTPOS at the door |

What remains before members can be pointed at it is deployment rather than
design: a database, Hapana credentials, a real email provider, and the Webflow
page. `GET /api/health` reports on each and says plainly whether the channel is
safe to open.

One open item, which does not block: **Hapana write capability** is still
unconfirmed, because the build environment cannot reach Hapana. It ships as
Pattern B, which needs no write access, so nothing has to change to go live.

### The Hapana question, and why it did not block the build

PRD 9.1 forks the architecture on whether Hapana's API can create a booking.
That could not be answered from the build environment: outbound access to
`api.hapana.com` and `apidocs.hapana.com` is blocked by egress policy, through
both HTTP clients and a browser.

So the build does not depend on the answer. Both patterns are implemented
behind one interface and selected by a config value, `booking_backend`:

- **`local` (Pattern B, the default, and what ships today).** This service owns
  the ringfenced allocation of 10 spots per session. Hapana keeps its 20. The
  two allocations are disjoint by construction, so no cross-system race is
  possible and the sum is fixed. Needs read access only.
- **`hapana` (Pattern A).** Hapana holds all inventory, including a hidden
  member class on the East Fremantle room. Needs booking-creation access.

To resolve it, run `HAPANA_API_KEY=… node scripts/probe-hapana.mjs` from a
machine that can reach Hapana. It reports which auth style the account accepts,
which endpoints answer, and whether a booking-creation endpoint exists, then
prints a findings block to paste into `docs/hapana-findings.md`. It issues GET
requests only and never creates a booking.

Switching patterns afterwards is a config change in the admin screen, not a
deploy.

---

## How capacity is kept correct

This is the property the build is actually for, so it is worth being explicit.

Every booking goes through one database function, `create_member_booking` in
`db/schema.sql`. Nothing else may insert a booking. That function takes a row
lock on the session, then evaluates the rules in order inside the same
transaction:

1. Guest count within bounds, and every guest has a name and an email.
2. The member does not already hold a live booking for this session. A partial
   unique index enforces this too, so it cannot be raced.
3. **The request fits the 10 spots per hour this channel sells.** This is the
   rule that governs the build.
4. Optionally, total occupancy across channels stays at or under a configured
   venue ceiling. No ceiling is configured by default, so this check is off;
   when one is set it is enforced strictly, independently of what Hapana
   believes, and a booking is refused rather than guessed at if occupancy
   cannot be established.

Every book, cancel and refusal is written to `capacity_audit` with the
occupancy at the time. If the ceiling is ever questioned, that table is the
evidence.

**This is proven, not asserted.** `tests/integration.pg.test.ts` runs twenty
genuinely concurrent booking requests, on twenty separate connections, against
a session with three spots left, and asserts exactly three bookings and
seventeen clean refusals. It runs against real Postgres.

---

## Running it

```bash
npm install
npm test          # 93 tests, no database or network needed
npm run typecheck
```

The suite runs against an in-memory store and a Hapana mock, so it stays
offline-clean. To also run the 19 Postgres integration tests, which are the
ones that prove the concurrency behaviour:

```bash
createdb member_booking_test
for dir in netlify/database/migrations/*/; do
  psql -d member_booking_test -v ON_ERROR_STOP=1 -f "$dir/migration.sql"
done
DATABASE_URL=postgres://localhost/member_booking_test npm test
```

To run the app locally:

```bash
cp .env.example .env     # fill in SESSION_SECRET at minimum
npx netlify dev
```

Without `DATABASE_URL` it uses the in-memory store and without `HAPANA_API_KEY`
it uses the Hapana mock, so the front end can be worked on with no external
setup. Both refuse to start in production, so neither can be reached by
accident. With `EMAIL_PROVIDER=console`, sign-in links and waiver links are
printed to the function log: that is how you sign in locally.

---

## Deploying

1. **Database.** Nothing to do. Netlify DB provisions Postgres on the first
   deploy and applies everything in `netlify/database/migrations/` before the
   deploy is published, in order, with a failed migration blocking publish.
   Deploy previews get their own isolated database branch, so a preview can
   never write to production data.
2. **Netlify.** Link the site to this repository. `netlify.toml` lives at the
   **repository root**, not in this directory, because that is the only place
   Netlify reads it from; it sets the base directory to `member-booking` along
   with the build command, publish and functions directories, and the security
   headers. Leave the UI build settings empty so the file stays authoritative.
3. **Environment.** Set the variables from `.env.example` in the Netlify UI.
   Hapana credentials and the session secret live there and nowhere else.
4. **Staff accounts.** Edit the seeded rows in `staff_users` to the real
   addresses. Sign-in is by magic link, so there are no passwords to set.
5. **Webflow.** Create the private page and embed `web/booking.html`, or
   iframe it. `netlify.toml` already allows framing from the Alchemy domains
   and blocks everyone else. Nothing sensitive lives in the page: it calls the
   API for everything.
6. **Before opening it to members**, load `/api/health` and confirm
   `readyForMembers` is true.

---

## What is here

```
netlify/database/migrations/  Schema and seed, applied automatically on deploy.
                              001 holds the tables and the booking functions,
                              where the lock lives. 002 seeds venue and config.
src/lib/             Config, errors, email, auth, time, crypto, HTTP helpers.
src/store/           Store interface, Postgres implementation, in-memory implementation.
src/adapters/hapana/ Client, field mapping, adapter, mock. Everything Hapana-shaped is here.
src/domain/          Booking, membership, sessions, waivers, door list. The rules that are not in SQL.
netlify/functions/   The API. One file per route, plus two scheduled jobs.
web/                 Booking page, door list, admin config, guest waiver.
scripts/             The Hapana probe.
tests/               112 tests, of which 19 need Postgres.
```

Three ideas keep this maintainable:

- **All Hapana field mappings sit in `src/adapters/hapana/mapping.ts`.** The
  live field names could not be confirmed, so each lookup tries several
  spellings. When the probe returns a real payload, that one file changes and
  nothing else moves.
- **All configuration sits in one store**, editable without a deploy. That
  includes the guest waiver wording: changing the words a guest agrees to is a
  config edit, not a release. The version is stamped on every signature, so
  which text a guest agreed to stays provable after the wording changes.
- **No business rule is expressed twice.** The capacity rules exist only in
  `create_member_booking`; the API layer calls it rather than reimplementing it.

---

## API

| Route | Who | What |
|---|---|---|
| `GET /api/sessions` | anyone | Availability for the booking window. Shows this channel's allocation only. |
| `POST /api/auth/request` | anyone | Emails a single-use sign-in link. Identical response whether or not the address is a member. |
| `GET /api/auth-verify` | link | Consumes the link, sets the session cookie. |
| `GET POST /api/auth/session` | anyone | Who am I, and sign out. |
| `GET POST /api/bookings` | member | List own bookings, create a booking. |
| `POST /api/bookings/cancel` | member | Cancel a booking, or drop one guest spot. |
| `GET POST /api/waiver` | guest, by token | Read and sign a waiver. |
| `GET /api/door/list` | staff | The day's sessions, or one session's door list. |
| `POST /api/door/update` | staff | Mark payment collected, check someone in. |
| `GET /api/admin/config` `PATCH` | manager | Read and change configuration. |
| `GET /api/admin/audit` | manager | The capacity audit log. |
| `GET /api/admin/reconciliation` | staff | The daily CSV. |
| `GET /api/health` | anyone | Readiness, including the outstanding blockers. |

Two scheduled functions run hourly: waiver reminders 24 hours out, and the
membership cache refresh plus timetable materialisation.

---

## Security notes

- Hapana credentials and the session secret are read in `src/lib/env.ts` and
  nowhere else. Nothing under `src/` is imported by anything in `web/`, so no
  credential can reach a client bundle.
- The private booking URL is a distribution choice, never an access control.
  Every booking action verifies membership server-side, and re-verifies it at
  the moment of booking rather than trusting the sign-in cookie.
- The door list exposes member and guest contact details, so it requires staff
  authentication.
- Sign-in and waiver tokens are stored as SHA-256 hashes. A database dump
  cannot be replayed into someone's account or used to sign in their name.
- Membership failures all return one message, so the endpoint cannot be used to
  work out who is a member.
- Waiver records are retained independently of bookings and survive
  cancellation. They are a liability document.

---

## Not built, deliberately

No payments of any kind: guest spots are collected by EFTPOS at the door and
the software only records that it happened. No waitlist, no no-show tracking,
no other venues, no native app, no guest self-service booking. All are PRD
non-goals for v1. The data model is multi-venue throughout, so a second venue
is configuration rather than a rebuild.
