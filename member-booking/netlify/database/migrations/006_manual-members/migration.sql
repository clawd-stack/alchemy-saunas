-- ---------------------------------------------------------------------
-- Manually added members.
--
-- Membership is Hapana's to answer. Until the API key is configured,
-- and whenever Hapana is unreachable afterwards, there has to be some
-- other way for the venue to say who holds a membership, or the channel
-- cannot open at all.
--
-- These live in the same table as the synced cache rather than beside
-- it, so every read path that already consults the cache finds them with
-- no change: one place to ask "is this person a member", not two that
-- can disagree.
--
-- source distinguishes them. A Hapana sync upserts by member_id and
-- never deletes, so a manual row is not clobbered by one; and a manual
-- row is never silently overwritten by Hapana because manual member_ids
-- carry a 'manual:' prefix that Hapana ids cannot collide with.
-- ---------------------------------------------------------------------
alter table members_cache
  add column if not exists source text not null default 'hapana';

comment on column members_cache.source is
  'hapana = synced from the API, manual = entered on the admin screen';

-- Manual entries are looked up by email on every sign-in, and there is no
-- expectation that the list stays small enough for a scan.
create index if not exists members_cache_source_idx on members_cache (source);
