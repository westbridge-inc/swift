// Swift load-test harness — shared client, metrics, and scenarios [LOAD-001].
// Engagement #3 (Swarm Load Test). Reconciled to Swift's real stack: pure HTTP
// against the API (Fastify), no infra assumptions. Correctness invariants are
// first-class metrics (idempotency_violations MUST stay 0 under any load).
//
// Env:
//   BASE_URL           default http://localhost:3000
//   ORDER_TOKENS       comma-sep pre-seeded customer access tokens (with a
//                      default address + a cart-ready vendor). Absent → the
//                      order scenario is skipped (read-only swarm).
//   ORDER_VENDOR_ID    a vendor id the tokens can order from
//   ORDER_ITEM_ID      an available item id on that vendor
import http from 'k6/http';
import { check, sleep } from 'k6';
import { Rate, Trend } from 'k6/metrics';
import exec from 'k6/execution';
import { replayVerdict, changedBodyVerdict, cardinalityVerdict, manifestVerdict } from './oracle.js';

export const BASE = __ENV.BASE_URL || 'http://localhost:3000';
export const API = `${BASE}/api/v1`;
export const TOKENS = (__ENV.ORDER_TOKENS || '').split(',').map((t) => t.trim()).filter(Boolean);
export const VENDOR = __ENV.ORDER_VENDOR_ID || '';
export const ITEM = __ENV.ORDER_ITEM_ID || '';
// [SCR-003] A mutating run needs a signed run manifest: what the target MUST say about itself.
export const RUN_MANIFEST = __ENV.LOAD_RUN_MANIFEST ? JSON.parse(__ENV.LOAD_RUN_MANIFEST) : null;
export const RUN_ID = __ENV.LOAD_RUN_ID || `k6-${Date.now()}`;
let lease = null;

// [SCR-003] The identity gate: the target must answer /test-control/identity (production never does)
// and every manifest field must match exactly; otherwise the run aborts before its first write.
export function identityGate(token) {
  if (lease) return lease;
  if (!RUN_MANIFEST) exec.test.abort('LOAD_RUN_MANIFEST is required for a mutating run');
  const res = http.get(`${API}/test-control/identity`, { headers: { authorization: `Bearer ${token}` }, tags: { name: 'test_control_identity' } });
  if (res.status !== 200) exec.test.abort(`target has no test-control identity (${res.status}) — not an isolated load environment`);
  const identity = res.json('data');
  const verdict = manifestVerdict(identity, RUN_MANIFEST);
  if (!verdict.ok) exec.test.abort(`target does not match the run manifest: ${verdict.reason}`);
  lease = identity.lease;
  return lease;
}

// Health / correctness metrics — read by the thresholds in each profile.
export const browseErrors = new Rate('browse_errors');
export const orderErrors = new Rate('order_errors');
export const orderLatency = new Trend('order_latency_ms', true);
// CORRECTNESS INVARIANT (S0): a checkout replayed with the same Idempotency-Key
// must return the first result — never a second order. Any divergence is a
// correctness violation, not a performance one, and fails the run outright.
export const idempotencyViolations = new Rate('idempotency_violations');
// MEASUREMENT VALIDITY, not system health. Swift rate-limits per session token
// (authenticated) or per IP (anonymous) at RATE_LIMIT_MAX/minute. Every k6 VU
// on one host shares ONE source IP, so a browse swarm above that ceiling is
// throttled by design — the server is behaving correctly and the run is
// measuring the limiter instead of the system.
//
// Measured 2026-08-28 against a local API with the shipped RATE_LIMIT_MAX=200:
// 260 rapid anonymous requests returned 187x200 and 73x429, and a 200-VU swarm
// reported 90.46% "browse errors" that were almost entirely 429s. Counting
// those as failures makes a healthy server look broken; hiding them makes an
// invalid run look like a passing one. So they are counted SEPARATELY and the
// profiles fail the run when they appear — with a message that says the
// measurement is void, not that the API is.
export const rateLimited = new Rate('rate_limited');

const jitter = () => sleep(Math.random() * 2 + 1);

// A read VU: the heaviest unauthenticated path — the public storefront directory
// and a random storefront detail. This is what most traffic actually is.
export function browse() {
  const list = http.get(`${API}/public/storefronts`, { tags: { name: 'storefronts' } });
  rateLimited.add(list.status === 429);
  // A 429 is the limiter working, not the system failing — the same honest-
  // response treatment the order scenario already gives 409 DELIVERY_NO_RIDERS.
  browseErrors.add(list.status !== 200 && list.status !== 429);
  check(list, { 'storefronts 200 or honest 429': (r) => r.status === 200 || r.status === 429 });
  jitter();

  try {
    const vendors = list.json('data') || [];
    if (vendors.length) {
      const slug = vendors[Math.floor(Math.random() * vendors.length)].slug;
      const detail = http.get(`${API}/public/storefronts/${slug}`, { tags: { name: 'storefront_detail' } });
      rateLimited.add(detail.status === 429);
      browseErrors.add(detail.status !== 200 && detail.status !== 429);
      check(detail, { 'storefront detail 200 or honest 429': (r) => r.status === 200 || r.status === 429 });
    }
  } catch (_) {
    /* non-json body under stress is itself a browse error, already counted */
  }
  jitter();
}

// A write VU: cart → checkout, then REPLAY the checkout with the same
// Idempotency-Key. Proves the money path stays correct AND idempotent under
// concurrency. Skipped without seeded ORDER_TOKENS (read-only swarm).
export function order() {
  if (!TOKENS.length || !VENDOR || !ITEM) return;
  const token = TOKENS[Math.floor(Math.random() * TOKENS.length)];
  const l = identityGate(token);
  const H = { headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'x-load-run-id': RUN_ID, 'x-load-lease': `${l.nonce}.${l.signature}` } };

  http.del(`${API}/customer/cart`, null, H);
  const add = http.post(`${API}/customer/cart/items`, JSON.stringify({ vendorId: VENDOR, itemId: ITEM, quantity: 1 }), H);
  if (![200, 201].includes(add.status)) { orderErrors.add(true); return; }

  const idemKey = `k6-${__VU}-${__ITER}`;
  const HK = { headers: { ...H.headers, 'Idempotency-Key': idemKey } };
  const t0 = Date.now();
  const co = http.post(`${API}/customer/checkout`, JSON.stringify({ paymentMethod: 'CASH' }), { ...HK, tags: { name: 'checkout' } });
  orderLatency.add(Date.now() - t0);
  // A 409 DELIVERY_NO_RIDERS is an HONEST no-supply response, not a failure.
  const honest = co.status === 409 && String(co.body).includes('DELIVERY_NO_RIDERS');
  orderErrors.add(!([200, 201].includes(co.status) || honest));

  const replay = http.post(`${API}/customer/checkout`, JSON.stringify({ paymentMethod: 'CASH' }), { ...HK, tags: { name: 'checkout_replay' } });
  // [SCR-004] The replay must be the SAME COMMAND RESULT — the receipt's answer with the same order ids —
  // not merely the same status. A changed body under the same key must conflict. The read-only verifier
  // must hold exactly the orders the first response named. Status alone is only a latency/error signal.
  const v = replayVerdict(co, replay);
  idempotencyViolations.add(!v.ok);
  check(replay, { [`idempotent replay: ${v.reason}`]: () => v.ok });
  if ([200, 201].includes(co.status)) {
    const changed = http.post(`${API}/customer/checkout`, JSON.stringify({ paymentMethod: 'CASH', note: 'changed' }), { ...HK, tags: { name: 'checkout_changed_body' } });
    const cv = changedBodyVerdict(changed);
    idempotencyViolations.add(!cv.ok);
    check(changed, { [`changed body conflicts: ${cv.reason}`]: () => cv.ok });
    const receipt = http.get(`${API}/test-control/checkout/${idemKey}`, { headers: H.headers, tags: { name: 'checkout_verify' } });
    const rv = cardinalityVerdict(receipt, co);
    idempotencyViolations.add(!rv.ok);
    check(receipt, { [`verifier cardinality: ${rv.reason}`]: () => rv.ok });
  }
  sleep(1);
}
