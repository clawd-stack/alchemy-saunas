-- Which membership packages this channel is open to.
--
-- Alchemy sells ten packages at East Fremantle, and not all of them are
-- meant to reach the member channel. Until now the only answer to "is this
-- person allowed" was their membership status, which is Hapana's answer to a
-- different question: whether they are paying, not whether this benefit is
-- part of what they pay for.
--
-- The package a member holds is recorded on their row, and a configuration
-- map says which packages are open. Both are needed: the map alone cannot be
-- applied to anybody, and the package alone is a label with no decision
-- attached to it.
alter table members_cache add column if not exists membership_package text;

comment on column members_cache.membership_package is
  'The Hapana package this member holds, as it appears in their export. Null for anybody added by hand.';

-- Read on the People screen, which lists every package it can see with a
-- count and a toggle.
create index if not exists members_cache_package_idx on members_cache (membership_package)
  where membership_package is not null;

-- Empty, deliberately, and not a list of the packages that exist today.
--
-- An empty map means every package is open, which is what the channel did
-- before this migration and is therefore the only value that does not change
-- behaviour on deploy. The venue turns packages off on the People screen, and
-- from the first time they do, a package nobody has ruled on is closed rather
-- than open: an unknown package letting somebody in is an unauthorised entry,
-- and an unknown package keeping somebody out is a support call. The screen
-- shows every package it has seen, so nothing stays unruled for long.
insert into app_config (key, value, source_note)
values ('package_access', '{}'::jsonb, 'empty means every package is open; set from the People screen')
on conflict (key) do nothing;
