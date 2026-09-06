# Testing the member channel

What it is: members book their included spot at East Fremantle through a
private link, and bring up to three guests at $35 each, paid by EFTPOS at the
door. No money moves through this software.

Live: https://alchemy-booking.netlify.app

## Getting in the first time

There is no invitation email. Your membership is the invitation.

1. Open the link, press **First time here? Set your password**.
2. Enter the email address the venue has for you, and choose a password.
3. You are signed straight in. Use that password from then on.

If it says the address already has a password, somebody has already set one on
it. Ask the venue to reset it rather than guessing.

If it says it cannot find an active membership, the address is not the one the
venue holds, or the membership is not active. It says the same thing either
way, on purpose: the sign-in must not be usable to work out who is a member.

## What is worth trying to break

The interesting failures are the ones that lose money or turn somebody away at
the door, so aim at those rather than at typos.

- **Book, then book again** for the same session. The second one must be
  refused, not silently taken.
- **Book the last spot from two phones at once.** Never two bookings for one
  spot; one of you gets a clean refusal.
- **Cancel, then rebook.** The spot must come back.
- **Bring guests**: 1, 2, 3, then try 4. Four is refused.
- **Cancel late.** Inside the cutoff it is refused, and it should say why.
- **Sign in on a phone, then on a laptop.** Both should work.
- **Get it wrong on purpose**: wrong password several times in a row, an
  address that is not yours, a password of four characters.

At the door, staff have their own screen: the session, who is coming, guests
owing, and a tick for paid and arrived.

## What is not built yet

Say so if these bite you, but they are known:

- **Nothing is written back to Hapana.** A booking made here does not appear
  there. The Hapana API has no endpoint to create one.
- **No email.** No confirmations, no reminders. The booking is on the screen
  and on the door list.
- **Guest waivers** are per booking, by link, not stored against a person.
- **One venue.** East Fremantle only.

## Reporting something

Worth a message: what you did, what happened, what you expected, and roughly
when, so it can be found in the logs. A screenshot beats a description. The
time matters more than it looks: everything is timestamped and the log is the
only record of what the server thought at that moment.

Say which you were on, phone or laptop, and which browser. Most of what has
gone wrong so far has been layout on a phone.
