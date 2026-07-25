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
