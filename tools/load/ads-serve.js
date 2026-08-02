import http from 'k6/http';
import { check, sleep } from 'k6';

// Ads serve + event ingestion load pass (ads-platform spec §21 P6 / §12.2).
// The serve path must hold the home screen's p95 (<100ms cache-hit target,
// §20) and events must absorb batch bursts. Public endpoints — anonymous by
// design; forged tokens are EXPECTED to come back "invalid" (that IS the
// anti-fraud core working — the check asserts the envelope, not acceptance).
//
// Run:  k6 run tools/load/ads-serve.js -e BASE=http://localhost:3000

const BASE = __ENV.BASE || 'http://localhost:3000';

export const options = {
  scenarios: {
    serve: {
      executor: 'ramping-vus',
      exec: 'serve',
      startVUs: 0,
      stages: [
        { duration: '20s', target: 25 },
        { duration: '40s', target: 25 },
        { duration: '10s', target: 0 },
      ],
    },
    events: {
      executor: 'constant-vus',
      exec: 'events',
      vus: 10,
      duration: '70s',
    },
  },
  thresholds: {
    'http_req_duration{scenario:serve}': ['p(95)<300'], // network-inclusive local target
    'http_req_failed{scenario:serve}': ['rate<0.01'],
    'http_req_failed{scenario:events}': ['rate<0.01'],
  },
};

export function serve() {
  const sessionId = `k6-${__VU}-${__ITER}`;
  const res = http.get(
    `${BASE}/api/v1/ads/serve?placements=home_hero_video,home_top_card,home_ad_bar&city=*&sessionId=${sessionId}`,
  );
  check(res, {
    'serve 200': (r) => r.status === 200,
    'serve envelope': (r) => {
      try {
        const b = r.json();
        return b.success === true && typeof b.data.placements === 'object';
      } catch {
        return false;
      }
    },
  });
  sleep(0.5);
}

export function events() {
  // Forged tokens — the server must answer per-item 'invalid', never 5xx.
  const body = JSON.stringify({
    events: Array.from({ length: 10 }, (_, i) => ({
      token: `forged-${__VU}-${__ITER}-${i}.sig`,
      eventType: 'IMPRESSION',
      occurredAt: new Date().toISOString(),
    })),
  });
  const res = http.post(`${BASE}/api/v1/ads/events`, body, { headers: { 'Content-Type': 'application/json' } });
  check(res, {
    'events 200': (r) => r.status === 200,
    'events all rejected as invalid (anti-fraud)': (r) => {
      try {
        const results = r.json().data.results;
        return Array.isArray(results) && results.every((v) => v.status === 'invalid');
      } catch {
        return false;
      }
    },
  });
  sleep(1);
}
