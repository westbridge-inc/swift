// Swift load SMOKE — tiny profile to prove the harness itself works before a
// real run (CI-friendly, seconds, trivial load) [LOAD-001].
//
//   BASE_URL=http://localhost:3000 k6 run tools/load/smoke.js
//
// A green smoke means the scripts, endpoints and metrics wiring are sound; it
// says nothing about capacity — use swarm.js / breakpoint.js for that.
import { browse, order, browseErrors, orderErrors, orderLatency, idempotencyViolations } from './lib.js';

export { browse, order };

export const options = {
  scenarios: {
    browse: { executor: 'constant-vus', exec: 'browse', vus: 3, duration: '15s' },
    order: { executor: 'per-vu-iterations', exec: 'order', vus: 1, iterations: 2, maxDuration: '20s' },
  },
  thresholds: {
    browse_errors: ['rate<0.05'],
    idempotency_violations: ['rate==0'], // the invariant holds even in a smoke
  },
};

void [order, orderErrors, orderLatency, idempotencyViolations, browseErrors];
