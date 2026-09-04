# Open questions and outstanding decisions

Everything the build could not settle for itself, and who settles it.

## Blocking go-live

### 1. The venue maximum, and its documentary source
**Owner: James.** The build hardcodes a ceiling of 40 and staff will rely on
it. It must trace to the certificate of approval issued by the Town of East
Fremantle under the Health (Public Buildings) Regulations 1992, not to a number
in a conversation. Also confirm whether a planning or DA condition sets a lower
number, since the binding limit is the lowest of them.

The config store already carries a `source_note` on `venue_maximum`, currently
marked PROVISIONAL, and the admin screen refuses a change to the ceiling
without one. Record the document reference there.

### 2. Guest waiver wording
**Owner: James, via Alex Beagley.** `src/lib/waiver-text.ts` is placeholder
text, labelled as such on the page a guest sees. Replace it and bump
`WAIVER_VERSION`; the version is stamped on every signature record, so which
text a guest agreed to stays provable after the wording changes.

Also confirm whether an emailed signature satisfies Alchemy's insurer, or
whether a signature at the venue is required regardless. If the latter, the
waiver flow becomes a convenience rather than a control, and the door list
becomes the place the signature is captured.

### 3. East Fremantle operating hours
**Owner: James.** The timetable currently runs on a placeholder: 06:00 to
20:00 weekdays, 07:00 to 18:00 weekends. One config change corrects it, but
sessions are generated from it, so it is wrong until it is right.

### 4. Hapana write capability
**Owner: Git, needs network access to Hapana.** See `docs/hapana-findings.md`.
Does not block go-live, since Pattern B ships by default, but it decides whether
the pilot runs with a shared pool or two disjoint ones.

## Not blocking, but worth deciding before launch

### 5. Why is Hapana configured at 20 against a permitted 40?
This is PRD open question 2 and it is the most valuable one. If 20 is simply a
legacy setting, raising it delivers most of the additional capacity with no
build at all, and this project becomes about the member channel and the guest
model rather than about unlocking spots. Worth answering before the channel is
positioned to members as the way to get in.

### 6. Permanent benefit or pilot?
This changes the copy on the page and how hard the channel is to withdraw
later. The page currently says nothing either way, which is the honest default
but not a decision.

### 7. Who owns the daily EFTPOS reconciliation?
**Owner: venue manager.** The CSV export exists and door staff can pull it. It
is worth nothing unless a named person reconciles it against the terminal
settlement. With no payment integration, this is the only control against guest
revenue leaking.

### 8. Staff accounts
`db/seed.sql` seeds two placeholder addresses. Replace them with the real ones
before go-live, and decide who holds `admin` (configuration) versus `door`
(door list and CSV only).

## Decisions the build made, that are worth knowing about

- **Postgres, not Netlify Blobs.** The PRD suggested either. Capacity
  correctness needs an atomic conditional write under contention, and a
  key-value store cannot give that honestly. Postgres also means the audit log
  and waiver records are queryable, which matters for the two things most
  likely to be asked about later: the ceiling and the liability documents.
  Ragan already runs Supabase, so this adds no new vendor.
- **Reserve locally first, register with Hapana second** (Pattern A). A local
  reservation can be released deterministically if the second step fails; a
  Hapana booking we lost track of cannot.
- **An unrecognised membership status is treated as not bookable.** An unknown
  state refusing a booking is a support call. An unknown state permitting one is
  an unauthorised entry.
- **Under Pattern B, the ceiling check assumes the public channel is at its
  full configured capacity.** It is the conservative assumption: it can only
  make the check stricter, never looser.
- **Magic link, not passwords.** Built as the PRD's documented fallback. If
  Hapana turns out to expose OAuth, it slots in alongside and nothing
  downstream changes.
