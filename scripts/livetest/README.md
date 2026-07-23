# Golden-path live harness [SWIFT-081]

An end-to-end smoke test that drives a **running** Swift API over HTTP only
(never the DB): it seeds the sanctioned test roster through the real signup
path, provisions vendors into an orderable state, then asserts the golden-path
invariants that must hold before any launch.

This needs live infra (API + Postgres + Redis) and `DEV_OTP_BYPASS=1`, so it is
**not** part of unit CI — run it against a local or staging stack.

## Run

```bash
# API must be up with DEV_OTP_BYPASS=1 (local/staging only — the boot guard
# forbids it in production).
LIVETEST_BASE_URL=http://localhost:3000 \
  apps/api/node_modules/.bin/tsx scripts/livetest/run.ts
```

Exit code `0` = all runnable flows passed, `1` = a flow failed, `2` = the
harness itself errored. Cataloged (`○ SKIP`) flows are the ones that need a
live multi-driver / Redis dispatch stage; they are listed with the reason
rather than faked green.

The OTP endpoints are rate-limited to 5/min per IP, so seeding the full roster
is paced by an automatic 429 back-off and takes a few minutes on a cold run;
re-runs log existing accounts straight in.

## Layout

| file          | role                                                          |
|---------------|---------------------------------------------------------------|
| `client.ts`   | HTTP client + `signupOrLogin`/`login` (verify-otp under bypass)|
| `roster.ts`   | the sanctioned roster (6 customers / 6 vendors / 6 movers)     |
| `provision.ts`| admin-approve + open + menu + stock for the orderable vendors  |
| `flows.ts`    | the golden-path assertions (cash-only, IDOR, stock race, …)    |
| `run.ts`      | orchestrates seed → provision → flows → summary → exit code    |

## Flows

Runnable (asserted against the live API): roster seeding, browse/home,
cash-only guardrail (CARD → 400), L1 tier-gate (large cash → 403), IDOR
(cross-customer order read → 404), stock=1 race (1 wins / 1 × 409), pickup
no-dispatch, unauth bearer required.

Cataloged as SKIP (need positioned drivers + Redis offer state): delivery
nearest-first + hold, decline cascade, live re-rank / multi-factor scoring,
taxi nearest-first, suspend/reactivate, masked calling.
