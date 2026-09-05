-- The address behind the "Email us" link on the booking screen and in the
-- menu. Seeded with a guess at the venue's address, and editable in Settings
-- precisely because it is one: a support link that bounces is worse than no
-- link, because the member thinks they were ignored rather than unheard.
--
-- Blank hides the link entirely.
insert into app_config (key, value, source_note)
values ('support_email', '"hello@alchemysaunas.com.au"'::jsonb, 'seeded default, confirm the real address')
on conflict (key) do nothing;
