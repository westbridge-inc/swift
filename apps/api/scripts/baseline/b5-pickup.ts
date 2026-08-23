/**
 * ELV-2 A12 — Scenario B5: PICKUP ORDER — no rider dispatch, ready-for-pickup,
 * verifier-blind pickup-code handshake (HND engine).
 *
 * Proves: (1) a PICKUP checkout creates the order with a pickup code and NO
 * rider is ever dispatched; (2) the vendor board never sees the code (HND-003
 * verifier-blind: the vendor order object omits it; the customer holds it);
 * (3) a WRONG code burns an attempt and is refused; (4) the RIGHT code
 * completes the handover; (5) the synthetic online rider was never touched.
 *
 * Run: DATABASE_URL=postgresql://swift:swift@localhost:5434/swift \
 *      npx tsx scripts/baseline/b5-pickup.ts
 */
import { Prisma, PrismaClient } from '@prisma/client';
import Redis from 'ioredis';

const API = process.env['BASELINE_API'] ?? 'http://localhost:3000/api/v1';
const prisma = new PrismaClient();
// [F-026-21] The 'no live offer' proof must READ REDIS. AlertDelivery is a
// best-effort receipt production explicitly catches and discards, so a zero
// SQL count can coexist with a real live offer key.
const redis = new Redis(process.env['REDIS_URL'] ?? 'redis://localhost:6382');

// [F-026-06] Money is proven with EXACT Decimal comparison, never a float
// round-trip: Number() can equate distinct Decimals and mis-round; the
// integer-money law applies to the proofs too.
const dec = (v: unknown) => new Prisma.Decimal(String(v ?? 0));

const CUSTOMER_PHONE = '+5925566001';
const OWNER_PHONE = '+5925566000';
const VENDOR_MARK = 'ELV1 Baseline Diner';

function log(step: string, detail: unknown = '') {
  console.log(`${new Date().toISOString()} · ${step}`, typeof detail === 'string' ? detail : JSON.stringify(detail));
}

async function http(method: string, path: string, body?: unknown, token?: string) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  let json: any = null;
  try { json = await res.json(); } catch { /* empty */ }
  return { status: res.status, json };
}

const pickToken = (j: any): string | undefined =>
  j?.data?.tokens?.accessToken ?? j?.data?.tokens?.token ?? j?.data?.token ?? j?.data?.accessToken;

async function loginByOtp(phone: string): Promise<string> {
  for (let attempt = 1; attempt <= 6; attempt++) {
    await http('POST', '/auth/send-otp', { phone });
    const v = await http('POST', '/auth/verify-otp', { phone, code: '000000' });
    const t = pickToken(v.json);
    if (t) return t;
    if (attempt === 6) throw new Error(`no token for ${phone}`);
    await new Promise((r) => setTimeout(r, 6500));
  }
  throw new Error('unreachable');
}

async function main() {
  const vendor = await prisma.vendor.findFirstOrThrow({ where: { name: VENDOR_MARK } });
  const item = await prisma.item.findFirstOrThrow({ where: { vendorId: vendor.id, name: 'ELV1 Pepperpot' } });
  const customer = await prisma.user.findFirstOrThrow({ where: { phone: CUSTOMER_PHONE } });
  const riderUser = await prisma.user.findFirstOrThrow({ where: { phone: '+5925566002' } });
  const rider = await prisma.rider.findFirstOrThrow({ where: { userId: riderUser.id } });
  const customerToken = await loginByOtp(CUSTOMER_PHONE);
  const ownerToken = await loginByOtp(OWNER_PHONE);
  const riderToken = await loginByOtp('+5925566002');
  const address = await prisma.address.findFirstOrThrow({ where: { userId: customer.id } });

  // [F-024-11] The "no dispatch" proof is only meaningful against FRESH,
  // ELIGIBLE supply — a missing/stale rider makes the negative vacuous. Put a
  // real online rider in range so a regression that DID offer this pickup
  // would leave detectable evidence.
  const on = await http('POST', '/rider/go-online', { latitude: 6.8, longitude: -58.15 }, riderToken);
  if (on.status >= 300) throw new Error(`rider go-online ${on.status}: ${JSON.stringify(on.json).slice(0, 200)}`);
  // [F-026-23] The go-online ROUTE is the authority on availability — it
  // preserves currentOrderId and derives isAvailable from it. Force-setting
  // isAvailable:true + currentOrderId:null right after would erase a live
  // assignment and make the mover double-bookable — the exact corruption the
  // hardening avoids. If the rig rider somehow already owns an order, that's a
  // dirty precondition, not something to paper over; fail loudly. Otherwise
  // only stamp LOCATION (which the route doesn't set from a fixture position).
  const liveNow = await prisma.rider.findUniqueOrThrow({ where: { id: rider.id }, select: { currentOrderId: true, isOnline: true } });
  if (liveNow.currentOrderId) throw new Error(`FAIL precondition: the rig rider already owns order ${liveNow.currentOrderId} — clear it before B5 rather than erasing the assignment`);
  await prisma.rider.update({ where: { id: rider.id }, data: { currentLat: 6.8, currentLng: -58.15, lastLocationUpdate: new Date() } });
  // Capture the REAL pre-state (the guard above proved currentOrderId is null),
  // so the "rider untouched" proof compares against truth, not a hardcode.
  const riderBefore = { id: rider.id, currentOrderId: liveNow.currentOrderId };

  // ── 1. PICKUP checkout ────────────────────────────────────────────────────
  await http('POST', '/customer/cart/items', { vendorId: vendor.id, itemId: item.id, quantity: 1 }, customerToken);
  await http('PUT', '/customer/cart/address', { addressId: address.id }, customerToken);
  const co = await http('POST', '/customer/checkout', {
    paymentMethod: 'CASH',
    fulfillmentSelections: { [vendor.id]: 'PICKUP' },
  }, customerToken);
  if (co.status !== 200) throw new Error(`checkout ${co.status}: ${JSON.stringify(co.json).slice(0, 300)}`);
  const orderId: string = co.json.data.orders?.[0]?.id ?? co.json.data.order?.id ?? co.json.data.id;
  const o0 = await prisma.order.findUniqueOrThrow({
    where: { id: orderId },
    select: { fulfillment: true, pickupCode: true, deliveryFee: true, holdExpiresAt: true, status: true },
  });
  if (o0.fulfillment !== 'PICKUP') throw new Error(`FAIL: fulfillment ${o0.fulfillment}`);
  if (!o0.pickupCode) throw new Error('FAIL: no pickup code minted');
  if (!dec(o0.deliveryFee ?? 0).isZero()) throw new Error(`FAIL: pickup carries deliveryFee ${o0.deliveryFee}`);
  log('EVIDENCE pickup order', { orderId, fulfillment: o0.fulfillment, fee: String(o0.deliveryFee), codeLen: o0.pickupCode.length });

  // ── 2. fast-forward hold (synthetic), vendor works to READY ───────────────
  if (o0.holdExpiresAt && o0.holdExpiresAt > new Date()) {
    await prisma.order.update({ where: { id: orderId }, data: { holdExpiresAt: new Date(Date.now() - 1000) } });
    const deadline = Date.now() + 180_000;
    for (;;) {
      const st = (await prisma.order.findUniqueOrThrow({ where: { id: orderId }, select: { status: true } })).status;
      if (st === 'PENDING') break;
      if (Date.now() > deadline) break;
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
  for (const step of ['accept', 'preparing', 'ready']) {
    const r = await http('PUT', `/vendor/orders/${orderId}/${step}`, {}, ownerToken);
    if (r.status >= 300) throw new Error(`vendor ${step} ${r.status}: ${JSON.stringify(r.json).slice(0, 200)}`);
  }
  const o1 = await prisma.order.findUniqueOrThrow({ where: { id: orderId }, select: { status: true, riderId: true } });
  if (o1.status !== 'READY_FOR_PICKUP') throw new Error(`FAIL: status ${o1.status} after ready`);
  if (o1.riderId) throw new Error(`FAIL: a rider was dispatched to a PICKUP order (${o1.riderId})`);
  // [F-024-11] Assignment pointers move only on ACCEPTANCE — a regression that
  // OFFERS a pickup and is simply never accepted would pass a pointer-only
  // check. Assert the offer never existed: no live offer key in redis and no
  // MOVER_OFFER delivery row correlated to this order. Give the cascade a
  // window to have fired before declaring absence.
  await new Promise((r) => setTimeout(r, 8000));
  const offerRows = await prisma.alertDelivery.count({ where: { kind: 'MOVER_OFFER', subjectId: orderId } });
  if (offerRows !== 0) throw new Error(`FAIL: ${offerRows} MOVER_OFFER delivery row(s) for a PICKUP order`);
  // [F-026-21] The authoritative check: dispatch's live offer key for THIS
  // order, and the per-mover pointer for the eligible rider. Redis is where an
  // offer actually lives; the SQL receipt above is best-effort corroboration.
  const liveOfferKey = await redis.get(`dispatch:offer:${orderId}`);
  const moverOfferKey = await redis.get(`dispatch:mover-offer:${rider.id}`);
  if (liveOfferKey) throw new Error(`FAIL: a LIVE dispatch offer exists in Redis for a PICKUP order (dispatch:offer:${orderId})`);
  if (moverOfferKey && moverOfferKey.includes(orderId)) throw new Error(`FAIL: the eligible rider holds a live offer pointer for this PICKUP order`);
  const riderMid = await prisma.rider.findUniqueOrThrow({ where: { id: rider.id }, select: { currentOrderId: true, isAvailable: true } });
  if (riderMid.currentOrderId) throw new Error('FAIL: rider bound to a pickup order');
  log('EVIDENCE ready, NO dispatch (no live Redis offer key, no offer rows, eligible rider present + free)', { ...o1, offerRows, liveOfferKey: liveOfferKey ?? null, riderAvailable: riderMid.isAvailable });

  // ── 3. verifier-blind: the vendor's own order read must NOT carry the code ─
  // [F-024-12] A 401/404/500/garbage body would trivially "not contain" the
  // code — require a real 200 carrying THIS order before reading the absence
  // of the secret as evidence.
  const vendorView = await http('GET', `/vendor/orders/${orderId}`, undefined, ownerToken);
  if (vendorView.status !== 200) throw new Error(`FAIL: vendor order read ${vendorView.status} — cannot prove verifier-blindness from a failed request`);
  const viewed = vendorView.json?.data ?? vendorView.json;
  const viewedId = viewed?.id ?? viewed?.order?.id;
  if (viewedId !== orderId) throw new Error(`FAIL: vendor view returned order ${viewedId ?? 'none'}, expected ${orderId}`);
  const flat = JSON.stringify(vendorView.json ?? {});
  if (flat.includes(o0.pickupCode)) throw new Error('FAIL HND-003: pickup code visible to the verifier');
  for (const secret of ['pickupCode', 'ridePin', 'handoverCode']) {
    if (new RegExp(`"${secret}"\\s*:\\s*"[^"]`).test(flat)) throw new Error(`FAIL HND-003: vendor view carries a populated ${secret} field`);
  }
  log('EVIDENCE verifier-blind vendor view (200, right order, no secret fields)', { status: vendorView.status, orderMatched: true });

  // ── 4. wrong code burns an attempt; right code completes ──────────────────
  const wrong = String(Number(o0.pickupCode) === 999999 ? 111111 : 999999);
  const bad = await http('PUT', `/vendor/orders/${orderId}/complete-pickup`, { code: wrong }, ownerToken);
  if (bad.status < 400) throw new Error('FAIL: wrong code accepted');
  const afterBad = await prisma.order.findUniqueOrThrow({ where: { id: orderId }, select: { pickupCodeAttempts: true } });
  if (afterBad.pickupCodeAttempts !== 1) throw new Error(`FAIL: attempts ${afterBad.pickupCodeAttempts} after wrong code`);
  // [F-024-16] The customer must be able to SEE their pickup code — read it
  // from the authenticated customer contract and hand THAT value over. Reading
  // the secret straight from the DB would pass even if the customer-facing
  // surface never exposed it, stranding real pickups.
  const custView = await http('GET', `/customer/orders/${orderId}`, undefined, customerToken);
  if (custView.status !== 200) throw new Error(`FAIL: customer order read ${custView.status} — the customer cannot see their own pickup code`);
  const custBody = custView.json?.data ?? custView.json;
  const customerCode: string | undefined = custBody?.pickupCode ?? custBody?.order?.pickupCode;
  if (!customerCode) throw new Error('FAIL HND: the customer contract does not expose the pickup code — pickup would strand');
  // [F-026-22] NEVER interpolate either pickup code — the top-level catch
  // prints e.message while the order is still live, and handover codes must
  // never reach a log, failure logs included. Report a redacted marker with
  // safe run correlation instead.
  if (customerCode !== o0.pickupCode) {
    throw new Error(`FAIL: customer-visible pickup code does not match the minted code [orderId=${orderId}, lenSeen=${customerCode.length}, lenMinted=${o0.pickupCode.length}]`);
  }
  log('EVIDENCE customer can read their own pickup code', { status: custView.status, matchesMinted: true });
  const good = await http('PUT', `/vendor/orders/${orderId}/complete-pickup`, { code: customerCode }, ownerToken);
  if (good.status >= 300) throw new Error(`FAIL: right code refused ${good.status}: ${JSON.stringify(good.json).slice(0, 200)}`);
  const oF = await prisma.order.findUniqueOrThrow({ where: { id: orderId }, select: { status: true } });
  if (oF.status !== 'COMPLETED') throw new Error(`FAIL: final status ${oF.status}`);
  log('EVIDENCE handshake', { wrongStatus: bad.status, attemptsBurned: afterBad.pickupCodeAttempts, finalStatus: oF.status });

  // ── 5. the rider roster was never touched ─────────────────────────────────
  const riderAfter = await prisma.rider.findFirst({ where: { user: { phone: '+5925566002' } }, select: { currentOrderId: true } });
  if (riderAfter?.currentOrderId) throw new Error('FAIL: rider bound to a pickup order');
  log('EVIDENCE rider untouched', { before: riderBefore?.currentOrderId ?? null, after: riderAfter?.currentOrderId ?? null });

  log('B5 COMPLETE — PICKUP SPINE PROVEN (no dispatch, blind code, attempt budget)');
}

main()
  .catch((e) => { console.error('B5 FAILED:', e.message); process.exitCode = 1; })
  .finally(async () => { await prisma.$disconnect(); redis.disconnect(); });
