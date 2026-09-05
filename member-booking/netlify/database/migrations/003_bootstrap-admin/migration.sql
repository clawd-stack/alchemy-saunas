-- Bootstrap admin account.
--
-- The two addresses seeded in 002 are placeholders and were never confirmed.
-- This adds the one address known to be real, so there is a working way into
-- the configuration and door list screens on first deploy without waiting for
-- the venue's own addresses to be settled.
--
-- Sign-in is by magic link, so no password is created here. Replace or remove
-- these rows once the venue's real staff addresses are known.

insert into staff_users (email, display_name, role, venue_ids)
values ('clawd@ragan.com.au', 'Ragan (bootstrap admin)', 'admin', array['east-fremantle'])
on conflict (email) do update
  set role = 'admin',
      venue_ids = array['east-fremantle'],
      active = true;
