-- ---------------------------------------------------------------------
-- Force the first admin's sign-in back to a known-good state.
--
-- The seed in 005 used ON CONFLICT DO NOTHING, which is correct for a
-- seed and useless as a repair: if that row ended up wrong, absent, or
-- deactivated, no later deploy could put it right, and the account it
-- exists to protect is the only one that can fix anything else.
--
-- This one overwrites deliberately. It is idempotent, it is the only
-- account it can touch, and it carries a scrypt hash rather than a
-- password, so it cannot be read back into one.
--
-- must_change is cleared. The flag was a UI gate rather than a server
-- rule, and the screen it drove left the sign-in form on the page after
-- a successful sign-in, which is indistinguishable from a failed one.
-- The prompt to choose a new password stays; the dead end does not.
-- ---------------------------------------------------------------------
insert into user_credentials (email, password_hash, must_change, active)
values (
  'clawd@ragan.com.au',
  'scrypt$32768$8$1$noHpm3xI61db1JLvnQYDTw==$dW8hbslcSVnYSZYMALTU8+IvGj+TodUNbon6AepOgfc=',
  false,
  true
)
on conflict (email) do update
  set password_hash = excluded.password_hash,
      must_change   = false,
      active        = true,
      updated_at    = now();

-- And the staff row it resolves against: a credential is useless if the
-- account behind it is missing, inactive, or no longer an admin.
insert into staff_users (email, display_name, role, venue_ids, active)
values ('clawd@ragan.com.au', 'Ragan (bootstrap admin)', 'admin', array['east-fremantle'], true)
on conflict (email) do update
  set role      = 'admin',
      venue_ids = array['east-fremantle'],
      active    = true;

-- Clear any rate-limit buckets standing against this account, so a run
-- of failed attempts while it was broken does not keep it locked out
-- after it is fixed.
delete from auth_throttle where bucket_key like 'login:%';
