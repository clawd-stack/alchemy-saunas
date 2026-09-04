# Hapana API findings

Record what a live probe established, so the next person does not repeat it.

**Status as at 2026-09-04: unresolved.** Nothing below has been confirmed
against the live account.

## Why it is still unresolved

Credentials for the Alchemy Hapana account were supplied during the build
session. They could not be used: outbound access to `api.hapana.com` and
`apidocs.hapana.com` is blocked by the build environment's egress policy. This
was confirmed through both an HTTP client and a browser, and the proxy recorded
it as a policy denial (403 on CONNECT), not a transport failure. It is not
something the build can route around.

The build therefore does not depend on the answer. Pattern B ships by default
and needs no write access. See the README.

## How to resolve it

From a machine that can reach Hapana:

```bash
HAPANA_API_KEY='<id:secret from apidashboard.hapana.com>' \
PROBE_EMAIL='a.known.member@example.com' \
node scripts/probe-hapana.mjs
```

The script issues GET requests only. It never creates a booking.

Paste its findings block below, then work through the items the script cannot
answer, which need a login to `apidashboard.hapana.com`.

## Findings

```json
{
  "probedAt": null,
  "baseUrl": null,
  "authScheme": null,
  "canReadMembers": null,
  "canReadSessions": null,
  "canCreateBookings": null,
  "exposesPausedAndSuspended": null,
  "hiddenClassesBookableViaApi": null,
  "respectsClassCapacity": null,
  "webhookEvents": [],
  "notes": []
}
```

## Still to confirm by hand (PRD Appendix A.4)

1. **Does a hidden or unpublished class remain bookable through the API?**
   Pattern A depends on this mechanism. If hidden classes are not bookable,
   Pattern A is off the table regardless of write capability.
2. **Does API booking creation respect class capacity, or can it exceed it?**
   If it can exceed capacity, this service's own ceiling check becomes the only
   guard. It is already implemented and independent, so the build survives
   either answer, but the risk profile changes.
3. **Is there a staff or admin booking mode, and does it bypass capacity?**
   If it bypasses capacity, do not use it.
4. **Do member endpoints distinguish paused and suspended from active and
   cancelled?** PRD 5.1 requires it. `mapMembershipStatus` in
   `src/adapters/hapana/mapping.ts` handles several spellings and treats
   anything unrecognised as not bookable, which is the safe direction, but it
   should be checked against the real values.
5. **Which webhook events exist, particularly membership status change?** This
   decides whether the Pattern B membership cache can be near-real-time or is
   limited to the hourly sync.
6. **Is an SSO or OAuth flow usable from an external page?** (PRD 9.2.) If yes,
   it slots in alongside the magic link, which stays as the fallback. If no,
   the magic link is already built and nothing further is needed.
7. **Is API access included on Alchemy's current Hapana plan, or does it cost
   extra?** If it carries a cost, escalate before go-live: it changes the
   economics against the third-party alternatives in PRD Appendix B.

## Credential handling

API credentials belong in server-side environment variables only: the Netlify
UI for deployed environments, a local `.env` for development. They must never
be committed to this repository, and no credential appears anywhere in it.

Any key that has been sent through chat, email or a ticket should be rotated in
`apidashboard.hapana.com` before go-live, and the client named distinctly (for
example `east-fremantle-member-channel`) so it can be revoked independently of
any other integration.
