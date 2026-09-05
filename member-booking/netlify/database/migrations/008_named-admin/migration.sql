-- ---------------------------------------------------------------------
-- The venue's own admin address.
--
-- The staff row only. No password and no hash: this repository is public,
-- and a seeded credential is a hash anybody can clone and attack offline,
-- valid until somebody thinks to change the password. Migration 007 does
-- exactly that for clawd@ragan.com.au, and that password should be
-- treated as compromised and changed.
--
-- A password reaches this account one of two ways, neither of which is
-- committed here:
--
--   set ADMIN_BOOTSTRAP_EMAIL and ADMIN_BOOTSTRAP_PASSWORD in the Netlify
--   environment and sign in once, which writes the hash and then requires
--   it to be changed; or
--
--   sign in as an existing admin and issue one from the People screen.
-- ---------------------------------------------------------------------
insert into staff_users (email, display_name, role, venue_ids, active)
values ('admin@alchemysaunas.com.au', 'Alchemy admin', 'admin', array['east-fremantle'], true)
on conflict (email) do update
  set role      = 'admin',
      venue_ids = array['east-fremantle'],
      active    = true;
