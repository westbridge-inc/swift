// Swift BREAKPOINT test — ramp request rate up until the SLO breaks, to find
// the capacity ceiling [LOAD-001]. This is the "ramp → break" half of the
// engagement: a sustained swarm proves a target holds; this finds where it
// STOPS holding, so capacity planning is a measured number, not a guess.
//
//   BASE_URL=https://staging-api.swift.gy k6 run tools/load/breakpoint.js
//
// Read-only (public browse) so it can push high without seeded auth. k6 ABORTS
// the run the moment a threshold breaks (abortOnFail) — the arrival rate on the
// last completed stage is the ceiling. Watch the stage markers in the output.
import { browse, browseErrors, rateLimited } from './lib.js';

export { browse };

export const options = {
  scenarios: {
    ramp_to_break: {
      executor: 'ramping-arrival-rate',
      exec: 'browse',
      startRate: 50,
      timeUnit: '1s',
      preAllocatedVUs: 100,
      maxVUs: 3000, // headroom for a synthetic 1,000+ concurrent city
      stages: [
        { duration: '1m', target: 100 },  // 100 req/s
        { duration: '1m', target: 250 },
        { duration: '1m', target: 500 },
        { duration: '1m', target: 1000 },
        { duration: '1m', target: 2000 }, // push past the expected ceiling
        { duration: '1m', target: 3000 },
      ],
    },
  },
  thresholds: {
    // abortOnFail stops the run at the break point; delayAbortEval lets a stage
    // settle before judging (avoids aborting on a momentary ramp spike).
    http_req_duration: [{ threshold: 'p(95)<1000', abortOnFail: true, delayAbortEval: '20s' }],
    browse_errors: [{ threshold: 'rate<0.02', abortOnFail: true, delayAbortEval: '20s' }],
    // MEASUREMENT VALIDITY, and it matters most here: this profile ramps to
    // 3000 req/s from ONE host, so a per-IP RATE_LIMIT_MAX of 200/min is
    // reached in the first seconds of the first stage. Without this the "found
    // ceiling" would be the limiter's, reported as the system's. Aborting on it
    // is the honest outcome — raise RATE_LIMIT_MAX in the load environment (or
    // drive from many hosts) and run again.
    rate_limited: [{ threshold: 'rate<0.01', abortOnFail: true, delayAbortEval: '20s' }],
  },
};

void [browseErrors, rateLimited];
