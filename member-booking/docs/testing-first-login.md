# Testing "First time here? Set your password"

Four test members, importable in about a minute, and removable afterwards from
the same screen. `docs/test-members.csv` holds them.

They use `@alchemy.test` addresses. `.test` is reserved by the RFCs and can
never be a real domain, so nothing here can reach a real person's inbox and
nothing can collide with a real member.

## Adding by hand works too

"Add someone" with the role left on Member creates the membership and nothing
else: no password, so they claim one like anybody else. That is the quickest
way to make a single test account.

Importing is worth doing anyway, because it is what actually happened to the
405, and because it is the only way to get a package onto the row. Neither the
import nor a hand-added member creates a credential, and an address that
already has a password cannot be claimed, which is the guard the whole flow
rests on.

Staff are the exception, on purpose: the claim refuses a staff address, so
adding somebody as Door, Manager or Admin still issues a password and shows it
once. A staff account is not a way to test this.

## Importing them

1. Sign in as an admin, go to **People**, and open the import panel.
2. Choose `docs/test-members.csv`.
3. **Leave "deactivate members missing from this file" unticked.** With four
   rows in the file and 405 members in the app, ticking it cancels all 405.
   The preview says how many would be deactivated before anything is written;
   if that number is not zero, stop.
4. Apply. The preview should read four added, none deactivated.

## What to check

| Account | Expected |
|---|---|
| `tess.trial@alchemy.test` | Sets a password, is signed straight in, and can book. |
| `tess.trial@alchemy.test`, a second time | Refused: "That address already has a password." |
| `cass.cancelled@alchemy.test` | Refused. A cancelled membership cannot claim. |
| `nobody@alchemy.test` | Refused, and identically: an address that is not a member and one that is not active must not be distinguishable. |
| `ollie.offpeak@alchemy.test` | Refused once Off-Peak is switched off under Settings, allowed while it is on. |

Then sign out and sign in again as Tess with the password chosen, to confirm it
is a real credential and not just a session.

## Clearing them out

People, then remove each one. That takes the membership and the sign-in
together, so the same address can be claimed again from scratch and the test
re-run.

## The same thing, in the suite

`tests/claim.test.ts` pins all of it, including the case this file exists for:
a member who arrived by import claiming successfully while Hapana has never
heard of the address. Run it with `npx vitest run tests/claim.test.ts`.
