# Weekly Netlify check, as a Cowork scheduled task

What this is for: the booking channel deploys itself on every merge and syncs
membership on a schedule, and both are silent when they work. This is the
weekly look that catches the case where one of them stopped working and nobody
noticed, which is the only failure mode that costs anything here.

Everything below runs through the Netlify and GitHub connectors. Nothing needs
the site itself to be reachable.

---

## Schedule

**Monday 08:00 Perth**, which is two hours after the app's own membership sync
runs at 06:00, so there is a result to look at rather than a job in flight.

If Cowork asks for cron in UTC: `0 0 * * 1`. Perth is UTC+8 with no daylight
saving, so Monday 08:00 local is Monday 00:00 UTC.

---

## The prompt

Paste this as the task's instruction, unchanged.

```
Weekly check on the Alchemy East Fremantle member booking channel
(clawd-stack/alchemy-saunas, Netlify project "alchemy-booking").

Run these four checks. Report only what needs a person; if everything
passes, reply with one line saying so and nothing else.

1. The production deploy is healthy.
   Netlify: get-projects for "alchemy-booking", take
   _enrichedFields.currentDeploy.currentDeploy.id, then get-deploy-for-site
   with that deploy id and the site id from the same result.
   Pass when: state is "ready" and error_message is null.
   Flag when: state is "error" or "building" for more than an hour. Read
   the deploy's error and say what failed, in one sentence.

2. What is deployed is what was merged.
   GitHub: list_commits for clawd-stack/alchemy-saunas on main, take the
   newest sha. Compare it to the deploy's commit_ref.
   Pass when: they match.
   Flag when: they differ. That means a merge did not deploy. Say which
   commit is live and which is on main, and how old the difference is.

3. Migrations and secret scanning came back clean on that deploy.
   From the same deploy record:
   - database_migrations.files: every entry must have applied: true.
   - deploy_validations_report.secret_scan_result.secretsScanMatches and
     enhancedSecretsScanMatches must both be empty.
   Flag either immediately. A migration that did not apply means the
   database and the code disagree. A secret scan match in a public
   repository is urgent: name the file, never the value.

4. The membership sync is still configured to run.
   From the same deploy record, function_schedules must contain:
   - cron-membership-sync at "0 22 * * 0"  (Monday 06:00 Perth)
   - cron-waiver-reminders at "@hourly"
   Flag when either is missing or has changed. A schedule that silently
   went away is how a membership cache goes stale for a month.

Do not deploy, merge, or change any setting. This task reports; a person
decides. If a check cannot run because a connector is unavailable, say
which one rather than reporting a pass.
```

---

## What each result means

| Check | Green means | Red means |
|---|---|---|
| Deploy healthy | The site people are using built and published | Members may be on an older build, or the last deploy failed outright |
| Deployed equals merged | Every merge reached production | A merge did not deploy. Usually a failed build; occasionally a deploy that was never triggered |
| Migrations applied | The database matches the code | The two disagree. Fix before anything else: this is the one that corrupts data rather than merely annoying people |
| Secret scan clean | Nothing sensitive was committed | Treat as urgent. The repository is public, so a pushed credential is a rotated credential |
| Schedules present | Membership sync and waiver reminders will run | An unnoticed schedule loss means a stale membership cache, or guests never chased for their waiver |

---

## What this deliberately does not check

- **Whether the sync found anything.** Without a Hapana API key the sync has
  nothing to read, and reporting that every week would train everyone to
  ignore the report. The People screen already says so on its own, at the top
  of the list.
- **The site's own `/api/health`.** It is the better readiness check, and worth
  adding to the prompt as a fifth step if the environment Cowork runs in can
  reach `https://alchemy-booking.netlify.app/api/health`. Add:

  > 5. Fetch https://alchemy-booking.netlify.app/api/health and report any
  >    check where ok is false, along with its detail.

  Do not add it if that request is blocked, because a blocked fetch reported
  as a failure every week is worse than not checking.

---

## Changing it later

The Perth conversion is the part most likely to be got wrong. Cron is UTC,
Perth is UTC+8 all year, and subtracting eight hours moves the day backwards
when local time is before 08:00. Monday 06:00 local is Sunday 22:00 UTC, which
is why the app's own sync reads `0 22 * * 0` rather than a Monday expression.
