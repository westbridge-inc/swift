// The golden-path flow assertions [SWIFT-081]. Each returns a FlowResult; a
// thrown error becomes a FAIL (never crashes the run). Flows that need a live
// multi-driver / Redis dispatch setup are cataloged as SKIP with the reason —
// honest coverage, not a faked pass. Mirrors reports/LIVE_TEST_RUN.md.

import { GET, POST, PUT, req, type Session } from './client.js';
import type { Roster } from './roster.js';
import type { Provisioned } from './provision.js';

export interface FlowResult { name: string; ok: boolean; skip?: boolean; detail?: string }

const ok = (name: string, detail?: string): FlowResult => ({ name, ok: true, detail });
const bad = (name: string, detail: string): FlowResult => ({ name, ok: false, detail });
const skip = (name: string, detail: string): FlowResult => ({ name, ok: false, skip: true, detail });

async function ensureAddress(c: Session, lat: number, lng: number): Promise<string | null> {
  const list = await GET('/customer/addresses', c.token);
  const existing = list.json?.data?.[0]?.id;
  if (existing) return existing;
  const a = await POST('/customer/addresses', {
    label: 'Home', addressLine1: '1 Test St', city: 'Georgetown', region: 'Demerara-Mahaica',
    latitude: lat, longitude: lng, isDefault: true,
  }, c.token);
  return a.json?.data?.id ?? a.json?.data?.address?.id ?? null;
}

async function clearCart(c: Session) { await req('DELETE', '/customer/cart', { token: c.token }); }

async function placeOrder(
  c: Session, vendorId: string, itemId: string, lat: number, lng: number,
  o: { payment?: string; qty?: number; addr?: boolean; pickup?: boolean } = {},
) {
  await clearCart(c);
  const addressId = o.addr === false ? null : await ensureAddress(c, lat, lng);
  await POST('/customer/cart/items', { vendorId, itemId, quantity: o.qty ?? 1 }, c.token);
  if (addressId) await PUT('/customer/cart/address', { addressId }, c.token);
  // PICKUP isolates the value-gate / IDOR / stock invariants from the live
  // rider-availability gate (a DELIVERY order 409s when no rider is online —
  // asserted separately). The dispatch cascade itself stays cataloged as SKIP.
  const body: Record<string, unknown> = { paymentMethod: o.payment ?? 'CASH' };
  if (o.pickup) body.fulfillmentSelections = { [vendorId]: 'PICKUP' };
  return POST('/customer/checkout', body, c.token);
}

export async function runFlows(roster: Roster, prov: Provisioned, _log: (s: string) => void): Promise<FlowResult[]> {
  const out: FlowResult[] = [];
  const run = async (name: string, fn: () => Promise<FlowResult>) => {
    try { out.push(await fn()); } catch (e: any) { out.push(bad(name, `threw: ${e?.message ?? e}`)); }
  };

  // ── ROSTER ────────────────────────────────────────────────────────────────
  await run('ROSTER seeded via real signup path', async () => {
    const n = Object.keys(roster.customers).length + Object.keys(roster.vendors).length + Object.keys(roster.movers).length;
    return n === 18 // 6 customers + 6 vendors + 6 movers
      ? ok('ROSTER seeded', `${n} accounts (6C/6V/6M) with live tokens`)
      : bad('ROSTER seeded', `only ${n} accounts got tokens`);
  });

  const R1 = roster.vendors.R1, ST1 = roster.vendors.ST1, R2 = roster.vendors.R2;
  const C1 = roster.customers.C1, C2 = roster.customers.C2, C3 = roster.customers.C3;

  // ── BROWSE ────────────────────────────────────────────────────────────────
  await run('BROWSE guest/customer home loads', async () => {
    const r = await GET('/customer/home', C1.session.token);
    return r.ok ? ok('BROWSE home', `200, ${(r.json?.data?.openVendors?.length ?? 0)} open vendors`) : bad('BROWSE home', `status ${r.status}`);
  });

  // ── A6c cash-only guardrail ───────────────────────────────────────────────
  await run('A6c cash-only guardrail (CARD rejected)', async () => {
    if (!prov.items.R1) return skip('A6c cash-only', 'R1 not provisioned (no orderable item)');
    const card = await placeOrder(C1.session, R1.vendorId!, prov.items.R1.itemId, C1.lat, C1.lng, { payment: 'CARD' });
    return card.status === 400
      ? ok('A6c cash-only', 'checkout CARD → 400 (order money never through Swift)')
      : bad('A6c cash-only', `CARD checkout returned ${card.status}, expected 400`);
  });

  // ── A10 L1 tier-gate ──────────────────────────────────────────────────────
  await run('A10 L1 tier-gate (large order → 403)', async () => {
    if (!prov.items.R1) return skip('A10 tier-gate', 'R1 not provisioned');
    // C3 is L1; a large enough order must trip ID_VERIFICATION_REQUIRED. Pickup
    // so the value gate is isolated from rider availability.
    const big = await placeOrder(C3.session, R1.vendorId!, prov.items.R1.itemId, C3.lat, C3.lng, { payment: 'CASH', qty: 40, pickup: true });
    return big.status === 403 && /ID_VERIFICATION/.test(big.text)
      ? ok('A10 tier-gate', 'L1 large order → 403 ID_VERIFICATION_REQUIRED (server-side)')
      : bad('A10 tier-gate', `got ${big.status} (${big.json?.error?.code ?? ''})`);
  });

  // ── delivery fail-safe (no riders online → 409, offer pickup) ──────────────
  await run('Supply fail-safe — delivery with no riders → 409', async () => {
    if (!prov.items.R1) return skip('Supply fail-safe', 'R1 not provisioned');
    // No movers are online in this harness, so a DELIVERY order must fail safe
    // with a helpful 409 rather than stranding the customer.
    const del = await placeOrder(C1.session, R1.vendorId!, prov.items.R1.itemId, C1.lat, C1.lng, { payment: 'CASH' });
    return del.status === 409 && /NO_RIDERS/.test(del.text)
      ? ok('Supply fail-safe', 'delivery with 0 riders → 409 DELIVERY_NO_RIDERS (offers pickup)')
      : bad('Supply fail-safe', `got ${del.status} (${del.json?.error?.code ?? ''}) — expected 409 DELIVERY_NO_RIDERS`);
  });

  // ── golden order + IDOR ───────────────────────────────────────────────────
  await run('IDOR — A cannot read B’s order', async () => {
    if (!prov.items.R1) return skip('IDOR', 'R1 not provisioned');
    const placed = await placeOrder(C1.session, R1.vendorId!, prov.items.R1.itemId, C1.lat, C1.lng, { payment: 'CASH', pickup: true });
    const orderId = placed.json?.data?.orders?.[0]?.id ?? placed.json?.data?.order?.id ?? placed.json?.data?.id;
    if (!orderId) return bad('IDOR', `could not place C1 order (${placed.status})`);
    const read = await GET(`/customer/orders/${orderId}`, C2.session.token);
    return read.status === 404 ? ok('IDOR', 'C2 read of C1 order → 404 (existence hidden)') : bad('IDOR', `C2 read → ${read.status}`);
  });

  // ── A12 stock=1 race ──────────────────────────────────────────────────────
  await run('A12 stock=1 race (1 wins, loser 409)', async () => {
    if (!prov.items.ST1) return skip('A12 stock race', 'ST1 not provisioned with stock=1');
    // Pickup on both so the only possible 409 is the stock conflict, never a
    // rider-availability false negative.
    const [a, b] = await Promise.all([
      placeOrder(C1.session, ST1.vendorId!, prov.items.ST1.itemId, C1.lat, C1.lng, { payment: 'CASH', pickup: true }),
      placeOrder(C2.session, ST1.vendorId!, prov.items.ST1.itemId, C2.lat, C2.lng, { payment: 'CASH', pickup: true }),
    ]);
    const wins = [a, b].filter((r) => r.status === 201 || r.status === 200).length;
    const conflicts = [a, b].filter((r) => r.status === 409).length;
    return wins === 1 && conflicts === 1
      ? ok('A12 stock race', 'concurrent buys: 1 success, 1 × 409 INSUFFICIENT_STOCK (never oversold)')
      : bad('A12 stock race', `wins=${wins} conflicts=${conflicts} (statuses ${a.status}/${b.status})`);
  });

  // ── B1 pickup no-dispatch ─────────────────────────────────────────────────
  await run('B1 pickup order does not dispatch a rider', async () => {
    if (!prov.items.R2) return skip('B1 pickup no-dispatch', 'R2 (pickup) not provisioned');
    const placed = await placeOrder(C1.session, R2.vendorId!, prov.items.R2.itemId, C1.lat, C1.lng, { payment: 'CASH', pickup: true });
    const o = placed.json?.data?.orders?.[0] ?? placed.json?.data?.order ?? placed.json?.data;
    return placed.ok && (o?.fulfillment === 'PICKUP' || o?.deliveryFee === 0)
      ? ok('B1 pickup no-dispatch', 'pickup order placed, delivery fee 0, no rider leg')
      : bad('B1 pickup no-dispatch', `status ${placed.status}, fulfillment ${o?.fulfillment}`);
  });

  // ── UNAUTH denial (auth boundary, always runnable) ────────────────────────
  await run('AUTH — cart requires a bearer', async () => {
    const r = await GET('/customer/cart');
    return r.status === 401 ? ok('AUTH bearer required', 'GET /cart unauth → 401') : bad('AUTH bearer required', `got ${r.status}`);
  });

  // ── Cataloged: need a live multi-driver + Redis dispatch stage ─────────────
  for (const [name, why] of [
    ['A1 delivery nearest-first + hold', 'needs riders online at known coords + LIFECYCLE_V2 hold window'],
    ['A2 decline cascade DR1→DR2', 'needs offer cascade with 2+ positioned riders + Redis offer state'],
    ['A4/A4b live re-rank + multi-factor scoring', 'needs live rider-position moves + acceptance-rate seeding'],
    ['C1t/C6t taxi nearest-first + re-rank', 'needs taxi request + positioned drivers'],
    ['A11 suspend / reactivate', 'needs subscription state toggling (admin)'],
    ['CALL driver↔passenger masked calling', 'needs an active assigned trip + call provider'],
  ] as const) {
    out.push(skip(name, why));
  }

  return out;
}
