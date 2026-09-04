-- Seed data for the East Fremantle pilot.
-- Run after schema.sql. Idempotent.

insert into venues (venue_id, name, timezone)
values ('east-fremantle', 'Alchemy East Fremantle', 'Australia/Perth')
on conflict (venue_id) do nothing;

-- Configuration defaults, per PRD 5.7. Every value is editable from the admin
-- page without a deploy. venue_maximum carries a source_note because the build
-- must trace the ceiling to the certificate of approval, not to a conversation.
insert into app_config (key, value, source_note) values
  ('venue_maximum',            '40'::jsonb,    'PROVISIONAL. Stated by James 2026-09-04. Must be replaced with the certificate of approval reference issued by the Town of East Fremantle under the Health (Public Buildings) Regulations 1992 before go-live. See PRD dependency 9.3.'),
  ('hapana_public_capacity',   '20'::jsonb,    'Current public allocation configured in Hapana. Used for the ceiling validation in the admin page.'),
  ('member_channel_capacity',  '10'::jsonb,    null),
  ('booking_window_days',      '14'::jsonb,    null),
  ('cancellation_cutoff_hours','3'::jsonb,     null),
  ('max_guests_per_member',    '3'::jsonb,     null),
  ('guest_price',              '35'::jsonb,    'Display only. Collected by EFTPOS at the door; no payment processing in software.'),
  ('session_length_minutes',   '60'::jsonb,    null),
  ('waiver_version',           '"PLACEHOLDER-0"'::jsonb, 'Awaiting legal wording from Alex Beagley via James. See PRD dependency 9.4.'),
  ('operating_hours',          '{"mon":["06:00","20:00"],"tue":["06:00","20:00"],"wed":["06:00","20:00"],"thu":["06:00","20:00"],"fri":["06:00","20:00"],"sat":["07:00","18:00"],"sun":["07:00","18:00"]}'::jsonb,
                               'PROVISIONAL placeholder. Awaiting the real East Fremantle timetable. See PRD dependency 9.7.'),
  ('booking_backend',          '"local"'::jsonb, 'local = Pattern B (this service owns the ringfenced inventory). hapana = Pattern A (Hapana holds all inventory). Switch once the write-capability question in PRD 9.1 is answered.')
on conflict (key) do nothing;

-- Staff accounts. Replace the emails before go-live; sign-in is by magic link,
-- so no passwords are seeded.
insert into staff_users (email, display_name, role, venue_ids) values
  ('james@alchemysaunas.com.au', 'James Jordan', 'admin',   array['east-fremantle']),
  ('door.eastfremantle@alchemysaunas.com.au', 'East Fremantle Door', 'door', array['east-fremantle'])
on conflict (email) do nothing;
