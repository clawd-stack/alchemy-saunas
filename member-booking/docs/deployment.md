# Deployment status

Live state of the East Fremantle member booking channel, so this is not only
in a chat transcript.

## Done

| | Detail |
|---|---|
| **Code** | Merged to `main` (PR #1). CI green: 112 tests, 19 against a real Postgres. |
| **Netlify site** | `alchemy-booking`, team Ragan. Site id `cdfc3250-6203-4e41-bb89-79c171e270f9`. URL will be `https://alchemy-booking.netlify.app`. |
| **Database** | Nothing to create. `@netlify/database` is a dependency, so Netlify DB provisions Postgres on the first build and applies `netlify/database/migrations/` in order before publishing. A failed migration blocks the publish. |
| **Environment variables** | `SESSION_SECRET` (generated), `PUBLIC_BASE_URL`, `ALLOWED_ORIGINS`, `DEFAULT_VENUE_ID`, `EMAIL_PROVIDER=console` are set on the site and verified by reading them back. They are stored as ordinary variables, not secret-flagged: variable scoping and the secret flag are paid-plan features on Netlify, and requesting them makes the write silently do nothing. Mark `SESSION_SECRET` secret in the UI if the plan is ever upgraded. |
| **Build settings** | In `netlify.toml` at the **repository root**: base `member-booking`, build `npm run typecheck`, publish `web`, functions `netlify/functions`. Leave every UI build field empty so this file stays authoritative. |
| **Admin access** | `clawd@ragan.com.au` is seeded as an admin, so there is a working way into the config and door list screens on first deploy. |

## Migrations are immutable once applied

Never edit a migration in `netlify/database/migrations/` that has already run.
Netlify DB checksums them and refuses the deploy with "migration ... has been
modified after being applied", which blocks the publish. Add a new numbered
migration instead. Local runs and CI will not catch this, because they build
the schema from scratch each time; only a deploy against an existing database
sees it.

## A trap worth knowing about

The first deploy reported "ready" while having done nothing useful: no build
ran, no functions were bundled, no database was provisioned, and the repository
root was published as a folder of static files. The cause was `netlify.toml`
sitting in `member-booking/` rather than at the repository root, which is the
only place Netlify reads it from.

If a deploy ever finishes suspiciously fast, check the deploy summary for "No
functions deployed" and "No header rules processed". Both mean the
configuration was not applied, whatever the deploy status says.

## Remaining, and who has to do it

### 1. Connect the site to GitHub, so it builds (2 minutes, phone is fine)

The build could not be triggered from the build environment: `api.netlify.com`
is blocked by egress policy there, which rules out both the CLI upload and the
API. Connecting the repo is the way through, and it is better anyway, because
every push to `main` then deploys on its own.

On app.netlify.com, phone browser is fine:

1. Open the **alchemy-booking** site.
2. **Project configuration → Build & deploy → Link repository** (on a new site
   this may appear as "Import an existing project" or "Link to Git").
3. Choose GitHub, then `clawd-stack/alchemy-saunas`, branch `main`.
4. Leave every build setting empty, including Base directory and Package
   directory. `netlify.toml` at the repository root declares all of them.
5. Deploy.

The first build provisions the database and applies all three migrations.

### 2. Email provider (3 minutes, phone is fine)

**The one item that genuinely needs a credential I cannot create.** Until it
is set, `EMAIL_PROVIDER=console` writes sign-in links, waivers and
cancellation notices to the Netlify function log and delivers them to nobody.

That is enough to test with: open the function log in the Netlify app, find
the sign-in link, tap it. It is not enough to open the channel to members,
because members cannot sign in and guests never receive a waiver.

**You can run the pilot before any of this is set.** Staff can hand out both
kinds of link in person from the door list:

- **Sign a member in**: enter their membership email, get a one-time link, let
  them open it on their own phone. Their membership is still checked against
  Hapana first, so a paused member gets nothing. Once opened they stay signed
  in for 30 days and can book from home afterwards.
- **Sign waiver**: on any unsigned guest, hand the tablet over and they sign on
  the spot. This is how guests without email are handled permanently, not only
  while email is unconfigured.

That covers everything except the automatic reminders. Set up email when
convenient rather than before go-live.

**Recommended: send through Google Workspace.** Alchemy already has it, so
there is no new vendor, no monthly cost, no new domain reputation to build,
and mail arrives from an address members recognise. Gmail's sending limits are
far above anything one venue generates.

1. On the Google account that will send (for example a bookings mailbox),
   turn on 2-Step Verification if it is not already on.
2. Google Account, Security, 2-Step Verification, App passwords. Generate one
   and copy it. It can be revoked on its own later without touching the
   mailbox password.
3. In Netlify, alchemy-booking, Environment variables, set:
   - `EMAIL_PROVIDER` = `smtp`
   - `SMTP_USER` = the full sending address
   - `SMTP_PASS` = the app password
   - `EMAIL_FROM` = `Alchemy Saunas <that same address>`
   - `SMTP_HOST` and `SMTP_PORT` already default to `smtp.gmail.com` and `465`
4. Redeploy.
5. Open `/admin.html`, sign in, and press **Send test email**. It sends a real
   message to your own address and reports what the provider said, including
   the provider's own error text if it refused. That is the fastest way to
   tell a working setup from a silently broken one: everywhere else a send
   failure is deliberately swallowed so it cannot take a booking down with it.

**Alternative: a transactional vendor.** Resend or Postmark, if you would
rather keep booking mail off the Workspace account or want delivery analytics.
Sign up, create an API key, then set `EMAIL_PROVIDER` to `resend` or
`postmark`, `EMAIL_API_KEY`, and `EMAIL_FROM` on a verified sender.

All three are already implemented, so whichever you choose is configuration
only, with no code change.

### 3. Hapana credentials

Set `HAPANA_API_KEY` in the Netlify environment. **Rotate the key first** if it
has ever been sent through chat or email, and name the API client
`east-fremantle-member-channel` so it can be revoked on its own.

Without it the channel runs against the mock and refuses to start in
production, so this is required before members are pointed at it.

While there, run the probe from any machine that can reach Hapana:

```bash
HAPANA_API_KEY='…' node member-booking/scripts/probe-hapana.mjs
```

It answers whether Pattern A is available. Not urgent: Pattern B ships as the
default and needs read access only.

### 4. Webflow page

Create the private page and embed `web/booking.html`, or iframe it from
`https://alchemy-booking.netlify.app/booking.html`. `netlify.toml`
already allows framing from the Alchemy domains and blocks everyone else.

### 5. Two decisions, not technical

- **Who reconciles the daily EFTPOS CSV** against the terminal settlement. With
  no payment integration this is the only control against guest revenue
  leaking. The export exists at `/api/admin/reconciliation`; it is worth
  nothing without a named person.
- **Permanent benefit or pilot.** Changes the copy on the booking page and how
  hard the channel is to withdraw later. The page currently says neither.

## Checking it worked

Once the site has built, `https://alchemy-booking.netlify.app/api/health`
reports every one of the above. `readyForMembers` stays false until the email
provider and Hapana credentials are set.

## Pages, once deployed

The site root (`/`) redirects to the booking page; there is no separate
landing page.

| Page | Who |
|---|---|
| `/booking.html` | Members. This is what goes in Webflow. |
| `/doorlist.html` | Door staff, sign in with a staff email. |
| `/admin.html` | Manager and admin, configuration and the capacity audit. |
| `/waiver.html` | Guests, reached from their emailed link. |
