# Swift Load-Test Harness (`tools/load/`)

Engagement #3 — the Swarm Load Test. A synthetic-traffic harness for proving
Swift holds its SLOs (and its **correctness** invariants) under launch-scale
load, and for finding the point where it stops.

Pure [k6](https://k6.io) over HTTP against the API — no infra assumptions, runs
against local or staging. **Never run the write scenarios against production.**

## Profiles

| File | Purpose | Load |
|------|---------|------|
| `smoke.js` | Prove the harness itself works (CI-friendly) | trivial — 3 VUs, 15s |
| `swarm.js` | **Sustain** a launch-plausible peak and prove the SLOs hold | ~200 browsers + ~20 orders/min for 6m |
| `breakpoint.js` | **Ramp to break** — find the capacity ceiling | 50 → 3000 req/s, aborts at the SLO break |

## ⚠️ Before you run: the per-IP rate limit will invalidate the result

Swift rate-limits at `RATE_LIMIT_MAX` per minute, keyed on the **session token**
for authenticated traffic and the **source IP** for anonymous traffic. Every k6
VU on one host shares one source IP, so a browse swarm above that ceiling is
throttled by design.

Measured 2026-08-28 against a local API at the shipped `RATE_LIMIT_MAX=200`:

```
260 rapid anonymous requests   ->  187 x 200, 73 x 429
200-VU swarm                   ->  90.46% "browse errors", nearly all 429s
same swarm, RATE_LIMIT_MAX raised -> 0.00% errors
```

**The first number is the limiter working correctly, not the API failing.** A
run that trips it has measured the limiter and proved nothing about the system.
The harness now counts 429s as a separate `rate_limited` metric with its own
threshold, so this fails the run LOUDLY instead of masquerading as either a
system failure or a pass.

So: raise `RATE_LIMIT_MAX` in the load environment (or drive from many hosts)
before drawing any conclusion.

## Run

```bash
# 1. Smoke (local) — verify the scripts + endpoints + metrics wiring
BASE_URL=http://localhost:3000 k6 run tools/load/smoke.js

# 2. Sustained swarm (staging). Read-only without tokens; add them for the money path:
BASE_URL=https://staging-api.swift.gy \
  ORDER_TOKENS="<tokenA>,<tokenB>" ORDER_VENDOR_ID=<vid> ORDER_ITEM_ID=<item> \
  k6 run tools/load/swarm.js

# 3. Breakpoint (staging) — read-only, pushes until the SLO breaks
BASE_URL=https://staging-api.swift.gy k6 run tools/load/breakpoint.js
```

### Running the API for a load test

```bash
# NODE_ENV != 'development' turns OFF Prisma per-query logging, which otherwise
# dominates the measurement. NODE_ENV != 'production' keeps the boot guards
# relaxed for a local stack.
cd apps/api && NODE_ENV=loadtest LOG_LEVEL=warn RATE_LIMIT_MAX=1000000 \
  npx tsx src/server.ts
```

`ORDER_TOKENS` are pre-seeded customer access tokens whose accounts have a
default address and can order from `ORDER_VENDOR_ID`/`ORDER_ITEM_ID`. Absent →
the order scenario is skipped and you get a read-only browse swarm (still a
valid SLO test — browse is most of the traffic). The golden-path harness
(`scripts/livetest/`) already provisions a roster you can mint tokens from.

## What it asserts

**SLOs** (thresholds — a breach fails the run):
- `http_req_duration p95 < 800ms` (swarm) / `< 1000ms` (breakpoint abort)
- `browse_errors < 1%`, `order_errors < 2%` (an honest `409 DELIVERY_NO_RIDERS` is *not* an error)
- `order_latency_ms p95 < 2000ms`

**Correctness invariant (S0 — absolute):**
- `idempotency_violations == 0`. Every checkout is replayed with the same
  `Idempotency-Key`; the replay must return the first result, never a second
  order. One violation fails the whole run regardless of latency — a load test
  that trades correctness for throughput has proved nothing.

## Measured results

Record every run here so a regression is visible. **This harness had never been
executed before 2026-08-28** — the numbers below are its first.

| date | profile | environment | result |
|------|---------|-------------|--------|
| 2026-08-28 | `smoke` | local single box (API + Postgres + Redis on one Mac) | 26/26 checks, `p95 16.97ms`, 0 errors |
| 2026-08-28 | `swarm` | same, `RATE_LIMIT_MAX=200` (shipped default) | **INVALID** — 90.46% browse errors, all rate-limit 429s. See the warning above. |
| 2026-08-28 | `swarm` | same, limiter raised | **PASS.** 200 VUs held 6m · 25,610 checks, **100% succeeded** · `browse_errors 0.00%` · `rate_limited 0.00%` · `http_req_duration p95 = 9.26ms` against an SLO of 800ms · 70.3 req/s · 0 failed requests · 12,926 iterations, 0 interrupted |

Observed alongside the passing run: Postgres held **5–6 connections** for the
whole 200-VU peak, against a pool of 40. Browse is Redis-cached, so the
connection pool is **not** the constraint on this path — which is worth knowing
before anyone tunes it.

**What this does NOT yet prove.** Without `ORDER_TOKENS` the order scenario is
skipped, so `idempotency_violations` reads `0 out of 0` — the correctness
invariant this harness calls its reason to exist has not been exercised at all.
A read-only swarm is a real SLO test and nothing more. Seed a roster
(`scripts/livetest/`, needs `DEV_OTP_BYPASS=1`), mint tokens, and run again
before treating the money path as proven.

## Reading the breakpoint

`breakpoint.js` ramps the arrival rate through stages and `abortOnFail` stops
the run the moment `p95` or the error rate breaches. The **arrival rate of the
last fully-completed stage is the ceiling**; watch the stage markers in the k6
output. `delayAbortEval` lets each stage settle so a momentary ramp spike
doesn't abort early.

## Loop (ramp → break → fix → re-prove)

1. `swarm.js` to confirm the target peak holds.
2. `breakpoint.js` to find the ceiling.
3. If the ceiling is below the target market's plausible peak, profile the
   bottleneck (DB pool, a hot query, dispatch), fix it, and re-run — the ceiling
   should move. Record each ceiling so regressions are visible.

Reconciled to Swift: exercises the **real** endpoints (`/public/storefronts`,
`/customer/checkout`), respects the cash-only/no-supply honest-error semantics,
and treats the idempotency guarantee as the load test's reason to exist.
