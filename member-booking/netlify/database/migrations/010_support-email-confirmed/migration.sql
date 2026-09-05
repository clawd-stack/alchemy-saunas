-- The real support address, replacing the guess seeded in 009.
--
-- Overwrites deliberately rather than ON CONFLICT DO NOTHING: 009 already
-- ran and put a wrong address in front of members, so a seed that declines
-- to act would leave it there. The one case this would tread on is an
-- address somebody set by hand in Settings between the two deploys, which
-- is minutes rather than days, and Settings is where to set it again.
update app_config
   set value       = '"support@alchemysaunas.com.au"'::jsonb,
       source_note = 'confirmed by the venue',
       updated_at  = now()
 where key = 'support_email';

-- And create it if 009 somehow did not, so a database that skipped one is
-- not left without the row entirely.
insert into app_config (key, value, source_note)
values ('support_email', '"support@alchemysaunas.com.au"'::jsonb, 'confirmed by the venue')
on conflict (key) do nothing;
