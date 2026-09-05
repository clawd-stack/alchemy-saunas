-- How long a member stays signed in.
--
-- Deliberately long. Without an email provider a member cannot request a new
-- sign-in link themselves, so a link handed over at the venue has to keep
-- working from home afterwards. The application falls back to the same default
-- when this row is absent; seeding it makes the value visible and editable on
-- the admin screen rather than buried in code.
--
-- This is a separate migration rather than an edit to 002 because 002 has
-- already been applied: Netlify DB rejects a modified migration, which is what
-- stopped the deploy that first attempted it.

insert into app_config (key, value, source_note)
values (
  'member_session_days',
  '30'::jsonb,
  'Long by design: without email a member cannot request a new sign-in link, so a link handed over at the venue must keep working.'
)
on conflict (key) do nothing;
