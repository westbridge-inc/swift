// Swift SUSTAINED swarm — hold peak traffic and prove the SLOs + correctness
// invariants hold [LOAD-001]. Run against STAGING, never prod.
//
//   BASE_URL=https://staging-api.swift.gy \
//   ORDER_TOKENS="tokA,tokB" ORDER_VENDOR_ID=<vid> ORDER_ITEM_ID=<item> \
//   k6 run tools/load/swarm.js
//
// Without ORDER_TOKENS it runs a read-only browse swarm (still a valid SLO test).
import { browse, order, browseErrors, orderErrors, orderLatency, idempotencyViolations, rateLimited } from './lib.js';

export { browse, order };

// Target profile: launch-day-plausible peak — ~200 concurrent browsers holding
// for several minutes, with ~20 orders/min layered on. Tune to the market size.
export const options = {
  scenarios: {
    browse: {
      executor: 'ramping-vus',
      exec: 'browse',
      startVUs: 0,
      stages: [
        { duration: '1m', target: 50 },
        { duration: '1m', target: 200 },
        { duration: '3m', target: 200 }, // hold at peak
        { duration: '1m', target: 0 },
      ],
    },
    order: {
      executor: 'constant-arrival-rate',
      exec: 'order',
      rate: 20, timeUnit: '1m',
      duration: '6m',
      preAllocatedVUs: 10, maxVUs: 30,
    },
  },
  thresholds: {
    http_req_duration: ['p(95)<800'],
    browse_errors: ['rate<0.01'],       // <1% read errors
    order_errors: ['rate<0.02'],        // <2% order errors (excludes honest no-riders)
    order_latency_ms: ['p(95)<2000'],   // checkout is heavier
    // The correctness invariant is absolute — a single idempotency violation
    // fails the whole run, regardless of latency.
    idempotency_violations: ['rate==0'],
    // MEASUREMENT VALIDITY: every VU on one host shares a source IP, and Swift
    // rate-limits anonymous traffic per IP at RATE_LIMIT_MAX/minute. If this
    // trips, the run measured the LIMITER, not the system — raise
    // RATE_LIMIT_MAX in the load environment (or drive from multiple hosts) and
    // run again. It is not an API failure and must not be read as one.
    rate_limited: ['rate<0.01'],
  },
};

// Silence the unused-import lint for the metrics (they're referenced by name in
// `thresholds` above, which k6 resolves at runtime, not statically).
void [browseErrors, orderErrors, orderLatency, idempotencyViolations, rateLimited];
