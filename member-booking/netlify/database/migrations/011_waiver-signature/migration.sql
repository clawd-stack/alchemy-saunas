-- A drawn signature on every waiver signed from here on.
--
-- Stored as SVG path data in a fixed 1000x400 space, not as an image: a few
-- hundred bytes rather than tens of kilobytes, sharp at any size, and it
-- carries no markup of its own. Nullable, because waivers signed before this
-- deploy have a typed name and nothing else, and rewriting history on a
-- liability record would be worse than the gap.
alter table waivers add column if not exists signature text;

-- The declaration said "By typing my name below", which stops being true the
-- moment there is a signature box. Only the one sentence is touched, and only
-- while it is still the wording this migration knows about, so anything edited
-- in Settings since is left exactly as the venue wrote it.
update app_config
   set value = jsonb_set(
         value,
         '{declaration}',
         '"By signing below I confirm I am 18 or over, that I have read and agree to the Alchemy Saunas Terms of Use and the conditions above, and that the health statement above is true for me."'::jsonb
       ),
       updated_at = now()
 where key = 'waiver_text'
   and value ->> 'declaration' like 'By typing my name below%';

-- The version is stamped on every signature so that which text a guest agreed
-- to stays provable. The declaration changed, so it moves, in both places that
-- hold it, and only where the old wording was still in place.
update app_config
   set value = jsonb_set(value, '{version}', '"ALCHEMY-TOU-2026-09B"'::jsonb),
       updated_at = now()
 where key = 'waiver_text'
   and value ->> 'version' = 'ALCHEMY-TOU-2026-09';

update app_config
   set value = '"ALCHEMY-TOU-2026-09B"'::jsonb,
       updated_at = now()
 where key = 'waiver_version'
   and value = '"ALCHEMY-TOU-2026-09"'::jsonb;
