-- ---------------------------------------------------------------------
-- Password credentials.
--
-- Replaces magic-link sign-in. Members and staff now sign in with an
-- email and a password issued by a manager from the admin screen, and
-- delivered by whatever means the venue prefers.
--
-- One row per sign-in identity, keyed by email. Deliberately separate
-- from staff_users and from members_cache: a member's identity lives in
-- Hapana and is only cached here, so a credential has to be able to
-- outlive a cache refresh and be revoked on its own. Membership is still
-- checked against Hapana at every sign-in, so a credential alone never
-- grants access to a lapsed member.
--
-- password_hash is scrypt with its cost parameters embedded, never a
-- reversible or unsalted digest. See src/lib/password.ts.
-- ---------------------------------------------------------------------
create table if not exists user_credentials (
  email          text primary key,
  password_hash  text not null,
  -- Set on every manager-issued password. Cleared once the person picks
  -- their own, so a password that has been read aloud or emailed is
  -- always replaced by one only they know.
  must_change    boolean not null default true,
  active         boolean not null default true,
  last_login_at  timestamptz,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create index if not exists user_credentials_active_idx on user_credentials (active);

-- The first admin, so there is a way in on the deploy that ships this.
-- The value below is a scrypt hash, not a password: it cannot be reversed
-- into one. must_change is true because the plaintext was transmitted to
-- set this up, which makes it a bootstrap credential rather than a
-- lasting one.
insert into user_credentials (email, password_hash, must_change)
values (
  'clawd@ragan.com.au',
  'scrypt$32768$8$1$KMym6nBPc6KBg60WcwrQUw==$EDTHR19UciHJccQrRm5fAz+Du0ZUA7CVi/xCQyKQBz8=',
  true
)
on conflict (email) do nothing;
