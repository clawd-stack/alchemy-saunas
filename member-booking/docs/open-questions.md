# Decisions and outstanding items

## Settled (confirmed by James, 2026-09-05)

### Capacity: 10 spots per hour
The channel sells 10 spots per session. That allocation is the limit the build
enforces, and it is enforced atomically under contention.

A venue-wide ceiling across all channels is **optional and off by default**.
`venue_maximum` is null in the seeded config, which switches off both the
cross-channel check and its dependency on knowing what Hapana has sold. If a
documented occupancy limit ever needs to be held, set a number in the admin
screen: the check then applies strictly, the screen refuses an allocation that
would breach it, and it will not accept the number without a recorded source.

### Operating hours: 5am to 9pm, seven days
Last session starts at 8pm and ends as the venue closes. Sessions are hourly.
Sixteen per day. Held in config, so a change to the timetable is an edit rather
than a release.

### Guest waiver: Alchemy's own published conditions
Taken from alchemysaunas.com.au. The **binding document is the website Terms of
Use**, which the guest is shown as a link and agrees to by name. The page does
not restate or reword it, so there is one authoritative source of legal wording
rather than a second copy that can silently drift.

The clauses shown alongside it are Alchemy's published conditions of use: 18 or
over, shower first, rinse off sand and salt water, bring a towel and water,
sit on your towel, wait for your session time, 15 minute limit, stay hydrated,
no smoking or alcohol or drugs, no offensive or aggressive behaviour, follow
staff directions. A health acknowledgement and a note about what personal
details are held are included because the guest is signing a record.

All of it is a configuration value, editable from the admin screen without a
deploy. `waiver_version` is stamped on every signature, so which wording a
guest agreed to remains provable after it changes. Bump it whenever the text
changes.

**Worth knowing:** this is Alchemy's own published wording, not wording drafted
or reviewed for this specific guest-of-a-member flow. If Alex Beagley or the
insurer ever wants something different, it is a config edit, not a rebuild.

### Datastore: Postgres
Left to the build. Postgres it is, on the Supabase project Ragan already runs,
so no new vendor. The reason is narrow: correct capacity under concurrent
booking needs an atomic conditional write, and a key-value store cannot give
that honestly. It also makes the audit log and the waiver records queryable,
which are the two things most likely to be asked about later.

## Still open

### Hapana write capability
**Owner: whoever runs the probe.** Does not block go-live: Pattern B ships by
default and needs read access only. Run
`HAPANA_API_KEY=… node scripts/probe-hapana.mjs` from a machine that can reach
Hapana and paste the result into `docs/hapana-findings.md`. See that file for
why it could not be answered from the build environment.

### Deployment settings
Not decisions, just things that must exist before members are pointed at it,
each reported by `GET /api/health`:

- A Postgres database with `db/schema.sql` and `db/seed.sql` loaded.
- Hapana API credentials in the Netlify environment. **Rotate the key first if
  it has ever been sent through chat or email**, and name the client
  distinctly so it can be revoked on its own.
- A real email provider. The default logs to the function log and delivers
  nothing, which is fine locally and never acceptable in production.
- The Webflow page and its private URL.

### Operational, not build
- **Who reconciles the daily EFTPOS CSV.** The export exists and door staff can
  pull it. It is worth nothing unless a named person checks it against the
  terminal settlement. With no payment integration this is the only control
  against guest revenue leaking.
- **Staff accounts.** `db/seed.sql` seeds two placeholder addresses. Replace
  them, and decide who holds `admin` (configuration) versus `door` (door list
  and CSV only).
- **How the channel is positioned to members**, permanent benefit or pilot.
  This changes the copy on the page and how hard it is to withdraw later. The
  page currently says neither, which is the honest default but not a decision.

## Decisions the build made, worth knowing about

- **Reserve locally first, register with Hapana second** under Pattern A. A
  local reservation can be released deterministically if the second step fails;
  a Hapana booking we lost track of cannot.
- **An unrecognised membership status is treated as not bookable.** An unknown
  state refusing a booking is a support call. An unknown state permitting one is
  an unauthorised entry.
- **Magic link, not passwords.** If Hapana turns out to expose OAuth it slots in
  alongside, and nothing downstream changes.
- **Waiver records outlive bookings.** Cancelling a booking does not delete a
  signed waiver. It is a liability document.
