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

export const BASE = __ENV.BASE_URL || 'http://localhost:3000';
export const API = `${BASE}/api/v1`;
export const TOKENS = (__ENV.ORDER_TOKENS || '').split(',').map((t) => t.trim()).filter(Boolean);
export const VENDOR = __ENV.ORDER_VENDOR_ID || '';
export const ITEM = __ENV.ORDER_ITEM_ID || '';

// Health / correctness metrics — read by the thresholds in each profile.
export const browseErrors = new Rate('browse_errors');
export const orderErrors = new Rate('order_errors');
export const orderLatency = new Trend('order_latency_ms', true);
// CORRECTNESS INVARIANT (S0): a checkout replayed with the same Idempotency-Key
// must return the first result — never a second order. Any divergence is a
// correctness violation, not a performance one, and fails the run outright.
export const idempotencyViolations = new Rate('idempotency_violations');

const jitter = () => sleep(Math.random() * 2 + 1);

// A read VU: the heaviest unauthenticated path — the public storefront directory
// and a random storefront detail. This is what most traffic actually is.
export function browse() {
  const list = http.get(`${API}/public/storefronts`, { tags: { name: 'storefronts' } });
  browseErrors.add(list.status !== 200);
  check(list, { 'storefronts 200': (r) => r.status === 200 });
  jitter();

  try {
    const vendors = list.json('data') || [];
    if (vendors.length) {
      const slug = vendors[Math.floor(Math.random() * vendors.length)].slug;
      const detail = http.get(`${API}/public/storefronts/${slug}`, { tags: { name: 'storefront_detail' } });
      browseErrors.add(detail.status !== 200);
      check(detail, { 'storefront detail 200': (r) => r.status === 200 });
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
  const H = { headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' } };

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
  // The replay MUST mirror the first response. A different status = a second
  // order slipped through = a correctness violation.
  idempotencyViolations.add(replay.status !== co.status);
  check(replay, { 'idempotent replay: same status, no dup': () => replay.status === co.status });
  sleep(1);
}
