# Golden-path live harness [SWIFT-081] and pilot journey suite [TASK-057]

An end-to-end harness that drives a **running** Swift API over HTTP only
(never the DB): it seeds the sanctioned test roster through the real signup
path, provisions vendors and movers into a working state through the real
review endpoints, then asserts behaviour against the live API.

This needs live infra (API + Postgres + Redis) and `DEV_OTP_BYPASS=1`, so it is
**not** part of unit CI — run it against a local stack or the staging pilot's
PRIVATE `api-journeys` instance (see `deploy/PILOT-RUNBOOK.md` §7).

## Run

```bash
# API up with DEV_OTP_BYPASS=1 (+ TEST_CONTROL_ENABLED=1 for the journeys);
# the boot guard forbids the bypass in production.
LIVETEST_BASE_URL=http://localhost:3000 LIVETEST_ADMIN_PHONE=+5920400000 \
  apps/api/node_modules/.bin/tsx scripts/livetest/run.ts                    # golden path
LIVETEST_BASE_URL=http://localhost:3000 LIVETEST_ADMIN_PHONE=+5920400000 \
  apps/api/node_modules/.bin/tsx scripts/livetest/run.ts --suite=journeys   # all 42 journeys
```

Exit code `0` = nothing failed, `1` = a flow/journey failed, `2` = the harness
itself errored, `3` = the target was refused (journeys suite).

| env | meaning |
|---|---|
| `LIVETEST_BASE_URL` | the API origin (private address or service name only, for the journeys) |
| `LIVETEST_ADMIN_PHONE` | required: the seed admin (seed-production `SEED_ADMIN_PHONE`) |
| `LIVETEST_ADMIN2_PHONE` | optional: a second admin (break-glass); unlocks the two-person cases |
| `LIVETEST_WEB_ORIGIN` | optional: an origin `CORS_ORIGIN` allows; enables the web-taxi refusal |
| `LIVETEST_PUBLIC_HOST` | the public hostname, refused by name |
| `LIVETEST_OUT_DIR`, `LIVETEST_RUN_ID` | where results land and what the run is called |
| `LIVETEST_EXPECT_DEPLOYMENT_ID` / `_ENVIRONMENT` / `_BUILD_SHA` | optional pins on the target identity |
| `--only=AUTH-01,CUST-02` | run a subset |

## Safety (journeys suite)

Before its first request the runner refuses unless: (a) the target is private
(never the public hostname, a public DNS name or a public address); (b)
`GET /api/v1/test-control/identity` exists and declares an environment other
than production; (c) the data is `synthetic`; (p) every phone it uses is in
`+5920…` — a 0 after +592 is never a subscriber number. The roster lives in
the `+59204` block (`+5920400000` is kept for the seed admin); accounts a
journey must create afresh come from `+592049xxxx`. The shared worker sends
with the public provider settings, so a live number would be texted once real
SMS is on; gate (p) keeps that from ever happening.

The OTP endpoints are rate-limited to 5/min per IP, `send-otp` and
`verify-otp` each with its own bucket, so a cold roster takes a few minutes;
re-runs log existing accounts straight in.

## Results (journeys suite)

`journeys-result.json`: one entry per ledger journey — `journeyId`, `status`
(PASS | FAIL | SKIP), `reason`, `steps[] {name, ok, detail}`,
`skippedCases[] {case, reason, gate}`, `startedAt`, `finishedAt`,
`target {deploymentId, environment, buildSha}`, `runId` — and
`journeys-summary.md` for people. PASS means every server-side case ran and
passed (only device-gate cases may remain); SKIP means a case cannot run on the
target (the reason names it); FAIL means a step failed or no negative check ran.

## Layout

| file | role |
|---|---|
| `client.ts` | HTTP client, session renewal, multipart, `signupOrLogin`/`login` |
| `roster.ts` | the roster (customers, vendors, movers, a provider) |
| `provision.ts` | documents → admin review → stores open, movers online, heal leftovers |
| `flows.ts` | the golden-path assertions (cash-only, IDOR, stock race, …) |
| `guard.ts` | the target and phone refusals |
| `journey.ts`, `report.ts` | journey recording, status rules, result files |
| `journeys/*.ts` | the 42 journeys, by ledger group |
| `run.ts` | orchestrates either suite, prints the summary, sets the exit code |
