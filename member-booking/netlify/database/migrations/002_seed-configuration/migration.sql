-- Seed data for the East Fremantle pilot.
-- Run after schema.sql. Idempotent.

insert into venues (venue_id, name, timezone)
values ('east-fremantle', 'Alchemy East Fremantle', 'Australia/Perth')
on conflict (venue_id) do nothing;

-- Configuration defaults, per PRD 5.7. Every value is editable from the admin
-- page without a deploy. venue_maximum carries a source_note because the build
-- must trace the ceiling to the certificate of approval, not to a conversation.
insert into app_config (key, value, source_note) values
  -- No venue-wide ceiling is enforced. This channel sells a fixed 10 spots per
  -- hour, and that allocation is the constraint that governs it. Set a number
  -- here only if a documented occupancy limit ever needs to be held, and
  -- record where it came from in the source note.
  ('venue_maximum',            'null'::jsonb,  null),
  ('hapana_public_capacity',   '0'::jsonb,     'Only used to validate an allocation against a venue ceiling, which is not enforced.'),
  ('member_channel_capacity',  '10'::jsonb,    'Confirmed by James: the app has 10 spots per hour.'),
  ('booking_window_days',      '14'::jsonb,    null),
  ('cancellation_cutoff_hours','3'::jsonb,     null),
  ('max_guests_per_member',    '3'::jsonb,     null),
  ('guest_price',              '35'::jsonb,    'Display only. Collected by EFTPOS at the door; no payment processing in software.'),
  ('session_length_minutes',   '60'::jsonb,    null),
  ('waiver_version',           '"ALCHEMY-TOU-2026-09"'::jsonb, 'Alchemy conditions of use, with the website Terms of Use as the binding document.'),
  ('waiver_text',              '{"version": "ALCHEMY-TOU-2026-09", "title": "Guest acknowledgement and conditions of use", "intro": "You are booked in as a guest at Alchemy. Before you visit, please confirm you have read the Terms of Use and agree to the conditions below. It takes about a minute.", "termsUrl": "https://alchemysaunas.com.au/terms-of-use", "termsLabel": "Alchemy Saunas Terms of Use", "clauses": [{"heading": "You are 18 or over", "body": "You must be 18 years of age or older to access and use the facilities."}, {"heading": "Health and wellbeing", "body": "You confirm you have no condition that makes heat or cold exposure unsafe for you, and that you will stop, leave the sauna or ice bath, and tell a staff member if you feel unwell at any point during your visit."}, {"heading": "Before you use the facilities", "body": "Shower before using the ice baths or sauna, and rinse off any sand and salt water before entering the sauna."}, {"heading": "What to bring", "body": "Bring a towel and a water bottle each time you attend, and sit on your towel while using the sauna."}, {"heading": "Using the sauna safely", "body": "Wait until your session time begins before entering, limit each sauna use to 15 minutes, and stay hydrated throughout your visit."}, {"heading": "Conduct", "body": "Be kind and respectful to everyone in the space. Do not smoke, consume alcohol or drugs, use offensive language, or behave aggressively. Staff directions must be followed at all times."}, {"heading": "Your details", "body": "Your name and email were given by the member who booked you in, and are held so we can send you this waiver and identify you at the door. Your signature and the time you signed are kept as a record of this acknowledgement."}], "declaration": "By typing my name below I confirm I am 18 or over, that I have read and agree to the Alchemy Saunas Terms of Use and the conditions above, and that the health statement above is true for me."}'::jsonb, 'Sourced from alchemysaunas.com.au. Editable from the admin screen without a deploy; bump waiver_version whenever the wording changes.'),
  -- 5am to 9pm, seven days. With 60 minute sessions the last starts at 8pm.
  ('operating_hours',          '{"mon":["05:00","21:00"],"tue":["05:00","21:00"],"wed":["05:00","21:00"],"thu":["05:00","21:00"],"fri":["05:00","21:00"],"sat":["05:00","21:00"],"sun":["05:00","21:00"]}'::jsonb,
                               'Confirmed by James: 5am to 9pm, last session 8pm.'),
  ('booking_backend',          '"local"'::jsonb, 'local = Pattern B (this service owns the ringfenced inventory). hapana = Pattern A (Hapana holds all inventory). Switch once the write-capability question in PRD 9.1 is answered.')
on conflict (key) do nothing;

-- Staff accounts. These two addresses are PLACEHOLDERS and have not been
-- confirmed: replace them with the venue's real addresses before go-live.
-- Migration 003 adds a known-good admin so there is a working way in
-- meanwhile. Sign-in is by magic link, so no passwords are seeded.
insert into staff_users (email, display_name, role, venue_ids) values
  ('james@alchemysaunas.com.au', 'James Jordan', 'admin',   array['east-fremantle']),
  ('door.eastfremantle@alchemysaunas.com.au', 'East Fremantle Door', 'door', array['east-fremantle'])
on conflict (email) do nothing;
