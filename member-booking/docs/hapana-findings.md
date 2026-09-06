# Hapana API findings

**Status as at 2026-09-06: largely resolved.** Read from the live Hapana documentation
at `apidocs.hapana.com/docs`, signed in as the `Alchemy-Saunas-V1API` account, through
the browser on James's machine. Endpoint list, auth scheme and parameters below are
confirmed from the vendor's own docs, not inferred.

Two items remain open and both need one live call each. They are listed at the bottom.

`scripts/probe-hapana.mjs` is now obsolete and should be deleted. Every path it guessed
(`v1/members`, `v1/sessions`, `v1/bookings`) is wrong, and every auth style it tried is
wrong. It would have reported "no endpoints answered" and told us nothing.

## Findings

```json
{
  "probedAt": "2026-09-06",
  "source": "apidocs.hapana.com/docs, version 2.0.0, signed in as Alchemy-Saunas-V1API",
  "baseUrl": "https://api.hapana.com",
  "apiVersion": "v2",
  "authScheme": "two request headers: accessID (the auth key) and siteID",
  "canReadMembers": true,
  "canReadSessions": true,
  "canCreateBookings": false,
  "webhookEvents": [],
  "notes": [
    "No booking-create endpoint exists anywhere in the published API.",
    "No webhooks. The Notification group is outbound push-notification send only.",
    "Response schemas are not documented. Field names still need one live call."
  ]
}
```

## The decisive finding: there is no booking-create endpoint

The published API is 18 endpoints in three groups, and that is the whole surface:

**Client** (11) `POST /v2/customer/addClient`, `POST /v2/customer/allocatePackage`,
`GET /v2/customer/futureBookings`, `GET /v2/customer/corporate/purchases`,
`GET /v2/customer/client/purchases`, `GET /v2/customer/client`,
`GET /v2/customer/registerFields`, `POST /v2/customer/accountCredit`,
`POST /v2/customer/generalCheckin`, `POST /v2/customer/updateClient`,
`GET /v2/customer/visitHistory`

**Notification** (1) `POST /v2/pushnotification/send`

**Sites** (6) `GET /v2/site`, `GET /v2/site/instructor`, `GET /v2/site/sessionDetail`,
`GET /v2/site/sessions`, `GET /v2/site/detail`, `GET /v2/site/packages`

Bookings can be **read** (`futureBookings`) and attendance can be **recorded**
(`generalCheckin`), but a booking cannot be **created**. There is no `book`,
`reserve`, `bookSession` or `registration` endpoint.

**This settles PRD dependency 9.1. Pattern A is not available, and cannot become
available without Hapana shipping a new endpoint.** Pattern B, local ringfenced
inventory, is not the default that shipped pending an answer. It is the only
option there is. The 10 spots the channel owns are its own, permanently, and the
two channels keep disjoint pools.

It also closes Appendix A.4 items 1, 2 and 3 (hidden-class bookability, whether API
booking respects capacity, staff booking mode). All three only mattered under
Pattern A. They are moot.

## Auth

Two headers on every request. Not a bearer token, not `x-api-key`, not basic, not a
query parameter.

```
accessID: <the auth key from apidashboard.hapana.com>
siteID:   <the site id the key is registered against>
```

`siteID` is documented as "siteID registered with Auth Key & accessID", so the key and
the site are bound together at registration. `GET /v2/site` returns the sites the key
can see, which is how to get the East Fremantle id.

A missing or invalid `accessID` returns 401. That is the only 4xx documented.

## What this changes in the code

`src/adapters/hapana/client.ts`

- `HAPANA_AUTH_STYLE` and its five candidate styles can go. There is one scheme.
  Send `accessID` and `siteID` as headers.
- `siteID` is currently sent as a **query parameter** and as `x-site-id`. Both are
  wrong. It is a request header named exactly `siteID`.
- `HAPANA_COMPANY_ID` has no counterpart in the API. Drop it.

`src/adapters/hapana/adapter.ts`

- Member lookup is `GET /v2/customer/client`, not `v1/members`. It takes an `email`
  parameter directly (comma-separated for several), so sign-in verification is one
  call with no client-side filtering.
- The full-list sync should use `lastModifiedDate` (format `Y-m-d H:i:s`, returns
  everything changed on or after that time) rather than pulling every member every
  hour. Store the high-water mark, ask for the delta.
- `GET /v2/customer/client` documents **no pagination parameters at all**. The
  current 50-pages-of-200 loop with `page` and `limit` does not apply. Where
  pagination does exist (`futureBookings`, `site/sessions`) it is `pageSize` and
  `pageIndex`, both mandatory together, and omitting both returns everything.
- Sessions are `GET /v2/site/sessions`, dates as `YYYY-MM-DD`, not ISO timestamps,
  and **the range is capped at 15 days**. Any window wider than that has to be
  chunked.
- `createBooking` and `cancelBooking` should throw `NotSupported` unconditionally
  and stop pretending to be configurable. There is nothing to configure.
- `HAPANA_PATH_*` overrides can go with them.

`src/adapters/hapana/mapping.ts`

- Unchanged for now. The candidate-spellings approach stays until the one live call
  below returns a real payload. Note that Hapana's own vocabulary is "client", not
  "member", and `clientID` appears in the check-in sample as an opaque base64-looking
  string (`QUtVci9raDY3ck51SktpcGRaMm1mQT09`), so treat member ids as opaque strings.

## Still open

Both need a single live call, which needs the key. Neither blocks the build.

1. **Membership status field name and its values.** The docs document request
   parameters but no response schemas. `mapMembershipStatus` currently guesses at
   spellings and maps anything unrecognised to `suspended` (cannot book), which is
   the safe direction. Resolve with one call to
   `GET /v2/customer/client?email=<a known member>` and read the field names off the
   response. This is PRD 5.1 and Appendix A.4 item 4.
2. **The East Fremantle siteID.** One call to `GET /v2/site`.

Both can be run from the "Send a Sample Request" form built into each endpoint's page
on `apidocs.hapana.com/docs`, without a terminal, a checkout or a script. Type the
accessID into the form, send, read the response.

Two other Appendix A.4 items resolve without a call:

- **Item 5, webhooks.** There are none. The only Notification endpoint sends push
  notifications outbound. The Pattern B membership cache can never be near-real-time;
  hourly polling with `lastModifiedDate` is the ceiling. Anyone cancelled between
  syncs can still book for up to an hour. Decide whether that is acceptable or whether
  sign-in should always verify live (it currently does, with the cache as fallback,
  which is the right shape given this).
- **Item 6, SSO or OAuth.** Nothing in the published API. The magic link stays.

Item 7 (whether API access costs extra on Alchemy's plan) is commercial and still
needs asking, though the `Alchemy-Saunas-V1API` client already exists on the account,
which suggests API access is already enabled.

## Credential handling

Unchanged. Server-side environment variables only, never committed. An API client
named `Alchemy-Saunas-V1API` already exists on the account. Create a separate client
named `east-fremantle-member-channel` so this channel can be revoked on its own, and
rotate anything that has passed through chat, email or a ticket before go-live.
