-- The venue's street address, shown on the session a member is about to book.
--
-- Seeded rather than left to the code default so it appears in Settings as a
-- row somebody can edit when the venue moves or a second one opens.
insert into app_config (key, value, source_note)
values ('venue_address', '"34 Duke St, East Fremantle"'::jsonb, 'confirmed by the venue')
on conflict (key) do nothing;
