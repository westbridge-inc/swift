/**
 * ELV-2 A12 — Scenario B2: MMG DELIVERY + RIDER DEBT.
 *
 * Same spine as B1 but paid by MMG (customer pays the STORE directly), proving:
 *   1. PAYMENT GATE: an unattested MMG order cannot move (vendor accept 409s
 *      with MMG_PAYMENT_PENDING) until POST /vendor/orders/:id/confirm-payment
 *      attests the money landed (paymentStatus CAPTURED).
 *   2. DEBT CREATED: DELIVERED mints exactly one DeliveryCashSettlement row —
 *      the VENDOR_OWES_RIDER obligation — amount = deliveryFee + tip
 *      (SPS-F-0016b: the store received the tip inside the MMG total).
 *   3. VISIBLE TO BOTH SIDES: the row appears on GET /rider/cash-settlements
 *      AND GET /vendor/cash-settlements while owed.
 *   4. DUAL-CONFIRM LIFECYCLE: rider confirm → RIDER_CONFIRMED (still on the
 *      store's owed list) → store confirm → SETTLED → gone from both owed
 *      lists; each confirm notifies the counterpart. Swift moves no money.
 *
 * Run: DATABASE_URL=postgresql://swift:swift@localhost:5434/swift \
 *      npx tsx scripts/baseline/b2-mmg-debt.ts
 */
import { Prisma, PrismaClient } from '@prisma/client';

const A = process.env['BASELINE_API'] ?? 'http://localhost:3000/api/v1';
const HEALTH = A.replace('/api/v1', '') + '/health';
const prisma = new PrismaClient();

// [F-026-06] Money is proven with EXACT Decimal comparison, never a float
// round-trip: Number() can equate distinct Decimals and mis-round; the
// integer-money law applies to the proofs too.
const dec = (v: unknown) => new Prisma.Decimal(String(v ?? 0));

const CUSTOMER_PHONE = '+5925566001';
const RIDER_PHONE = '+5925566002';
const OWNER_PHONE = '+5925566000';
const VENDOR_MARK = 'ELV1 Baseline Diner';
const TIP = 200;

function log(step: string, detail: unknown = '') {
  console.log(`${new Date().toISOString()} · ${step}`, typeof detail === 'string' ? detail : JSON.stringify(detail));
}

async function http(method: string, path: string, body?: unknown, token?: string) {
  const res = await fetch(`${A}${path}`, {
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
    await new Promise((r) => setTimeout(r, 8000));
  }
  throw new Error('unreachable');
}

async function main() {
  const h = await fetch(HEALTH).then((r) => r.status).catch(() => 0);
  if (h !== 200) throw new Error(`rig not healthy (${h})`);

  const vendor = await prisma.vendor.findFirstOrThrow({ where: { name: VENDOR_MARK } });
  const item = await prisma.item.findFirstOrThrow({ where: { vendorId: vendor.id, name: 'ELV1 Pepperpot' } });
  const customer = await prisma.user.findFirstOrThrow({ where: { phone: CUSTOMER_PHONE } });
  const riderUser = await prisma.user.findFirstOrThrow({ where: { phone: RIDER_PHONE } });
  const rider = await prisma.rider.findFirstOrThrow({ where: { userId: riderUser.id } });
  const ownerUserId = (await prisma.vendorOwner.findUniqueOrThrow({ where: { id: vendor.ownerId }, select: { userId: true } })).userId;

  // MMG checkout requires a valid store pay URL (https, allowlisted/local host).
  if (!vendor.mmgPayUrl) {
    await prisma.vendor.update({ where: { id: vendor.id }, data: { mmgPayUrl: 'https://pay.mmg.localhost/elv1-baseline-diner' } });
    log('rig setup: mmgPayUrl set on synthetic vendor');
  }

  const customerToken = await loginByOtp(CUSTOMER_PHONE);
  const ownerToken = await loginByOtp(OWNER_PHONE);
  const riderToken = await loginByOtp(RIDER_PHONE);

  // Rig tidy (same synthetic-only class as the holdExpiresAt fast-forward).
  const tidied = await prisma.order.updateMany({
    where: { vendor: { name: { startsWith: 'ELV1 Baseline' } }, status: { in: ['PENDING', 'ACCEPTED', 'PREPARING', 'READY_FOR_PICKUP', 'RIDER_ASSIGNED', 'RIDER_EN_ROUTE_PICKUP', 'RIDER_ARRIVED_PICKUP', 'PICKED_UP', 'EN_ROUTE_DELIVERY', 'ARRIVED'] } },
    data: { status: 'CANCELLED' },
  });
  if (tidied.count > 0) log('tidied stranded synthetic orders', { cancelled: tidied.count });

  await http('POST', '/rider/go-online', { latitude: 6.8, longitude: -58.15 }, riderToken);
  await prisma.rider.update({ where: { id: rider.id }, data: { isOnline: true, isAvailable: true, currentOrderId: null, lastLocationUpdate: new Date() } });

  // ── checkout by MMG with a tip ───────────────────────────────────────────
  await http('POST', '/customer/cart/items', { vendorId: vendor.id, itemId: item.id, quantity: 1 }, customerToken);
  const addr = await prisma.address.findFirstOrThrow({ where: { userId: customer.id } });
  await http('PUT', '/customer/cart/address', { addressId: addr.id }, customerToken);
  const co = await http('POST', '/customer/checkout', { paymentMethod: 'MOBILE_MONEY', tipAmount: TIP }, customerToken);
  if (co.status !== 200) throw new Error(`checkout ${co.status}: ${JSON.stringify(co.json).slice(0, 300)}`);
  const orderId: string = co.json.data.orders?.[0]?.id ?? co.json.data.order?.id ?? co.json.data.id;
  const o0 = await prisma.order.findUniqueOrThrow({ where: { id: orderId }, select: { paymentStatus: true, mmgPayUrlSnapshot: true, deliveryFee: true, tipAmount: true, holdExpiresAt: true } });
  if (o0.paymentStatus !== 'PENDING') throw new Error(`expected PENDING payment, got ${o0.paymentStatus}`);
  if (!o0.mmgPayUrlSnapshot) throw new Error('mmgPayUrlSnapshot missing — checkout must freeze the pay URL');
  log('EVIDENCE MMG order placed', { orderId, paymentStatus: o0.paymentStatus, fee: Number(o0.deliveryFee), tip: Number(o0.tipAmount), snapshot: !!o0.mmgPayUrlSnapshot });

  // release the hold so the vendor can act
  await prisma.order.update({ where: { id: orderId }, data: { holdExpiresAt: new Date(Date.now() - 1000) } });
  const relDeadline = Date.now() + 180_000;
  let released = false;
  while (Date.now() < relDeadline) {
    const n = await prisma.notification.count({ where: { userId: ownerUserId, data: { path: ['orderId'], equals: orderId } } as any });
    if (n > 0) { released = true; break; }
    await new Promise((r) => setTimeout(r, 4000));
  }
  if (!released) throw new Error('release never fired');
  log('hold released to vendor');

  // ── 1. the payment gate: accept must 409 while unattested ────────────────
  const early = await http('PUT', `/vendor/orders/${orderId}/accept`, {}, ownerToken);
  if (early.status !== 409) throw new Error(`FAIL gate: unattested accept returned ${early.status}, expected 409`);
  log('EVIDENCE unattested accept blocked', { status: early.status, code: early.json?.error?.code ?? early.json?.code });

  const att = await http('POST', `/vendor/orders/${orderId}/confirm-payment`, {}, ownerToken);
  if (att.status >= 300) throw new Error(`confirm-payment ${att.status}: ${JSON.stringify(att.json).slice(0, 200)}`);
  const oCap = await prisma.order.findUniqueOrThrow({ where: { id: orderId }, select: { paymentStatus: true } });
  if (oCap.paymentStatus !== 'CAPTURED') throw new Error(`expected CAPTURED after attestation, got ${oCap.paymentStatus}`);
  log('EVIDENCE store attested payment', { paymentStatus: oCap.paymentStatus });

  // ── spine to DELIVERED ───────────────────────────────────────────────────
  await http('POST', '/rider/go-online', { latitude: 6.8, longitude: -58.15 }, riderToken);
  await prisma.rider.update({ where: { id: rider.id }, data: { isOnline: true, isAvailable: true, currentOrderId: null, lastLocationUpdate: new Date() } });
  for (const step of ['accept', 'preparing', 'ready']) {
    const r = await http('PUT', `/vendor/orders/${orderId}/${step}`, {}, ownerToken);
    if (r.status >= 300) throw new Error(`vendor ${step} ${r.status}: ${JSON.stringify(r.json).slice(0, 200)}`);
  }
  let offer: any = null;
  const offDeadline = Date.now() + 120_000;
  while (Date.now() < offDeadline) {
    await prisma.rider.update({ where: { id: rider.id }, data: { lastLocationUpdate: new Date() } });
    const cur = await http('GET', '/rider/offers/current', undefined, riderToken);
    if (cur.json?.data?.offer?.orderId === orderId) { offer = cur.json.data.offer; break; }
    await new Promise((r) => setTimeout(r, 3000));
  }
  if (!offer) throw new Error('offer never arrived');
  const acc = await http('POST', '/rider/offers/accept', { orderId, ...(offer.offerAttemptId ? { offerAttemptId: offer.offerAttemptId } : {}) }, riderToken);
  if (acc.status !== 200) throw new Error(`accept ${acc.status}`);
  for (const step of ['en-route-pickup', 'arrived-pickup', 'picked-up', 'en-route-delivery', 'arrived']) {
    const r = await http('PUT', `/rider/orders/${orderId}/${step}`, {}, riderToken);
    if (r.status >= 300) throw new Error(`rider ${step} ${r.status}`);
  }
  // MMG is already CAPTURED — completion is PUT /delivered with the customer's
  // delivery PIN (the rider VERIFIES it; cash handover is a different, cash-only
  // door — that 409 is itself part of the payment×fulfilment matrix).
  const cashDoor = await http('POST', `/rider/orders/${orderId}/handover`, { outcome: 'paid', gps: { lat: 6.81, lng: -58.16 } }, riderToken);
  if (cashDoor.status !== 409) throw new Error(`FAIL: cash handover on an MMG order returned ${cashDoor.status}, expected 409`);
  log('EVIDENCE cash door closed for MMG', { status: cashDoor.status, code: cashDoor.json?.error?.code });
  const pinRow = await prisma.order.findUniqueOrThrow({ where: { id: orderId }, select: { ridePin: true } });
  if (pinRow.ridePin) {
    const bad = await http('PUT', `/rider/orders/${orderId}/delivered`, { ridePin: '000000' === pinRow.ridePin ? '111111' : '000000' }, riderToken);
    if (bad.status !== 400) throw new Error(`FAIL: wrong PIN returned ${bad.status}, expected 400`);
    log('EVIDENCE wrong delivery PIN rejected', { status: bad.status });
  }
  const hand = await http('PUT', `/rider/orders/${orderId}/delivered`, pinRow.ridePin ? { ridePin: pinRow.ridePin } : {}, riderToken);
  if (hand.status >= 300) throw new Error(`delivered ${hand.status}: ${JSON.stringify(hand.json).slice(0, 200)}`);
  const oDone = await prisma.order.findUniqueOrThrow({ where: { id: orderId }, select: { status: true, deliveryFee: true, tipAmount: true } });
  // [F-026-27] The delivered leg claimed a handover but only LOGGED the
  // persisted status — a transition that silently didn't land would still
  // reach COMPLETE. Require the terminal state.
  if (!['DELIVERED', 'COMPLETED'].includes(oDone.status)) throw new Error(`FAIL delivered leg: order is ${oDone.status}, expected DELIVERED`);
  log('EVIDENCE delivered', { status: oDone.status });

  // ── 2. the debt row ──────────────────────────────────────────────────────
  const debt = await prisma.deliveryCashSettlement.findUnique({ where: { orderId } });
  if (!debt) throw new Error('FAIL: no DeliveryCashSettlement row for the MMG order');
  const due = dec(oDone.deliveryFee).plus(dec(oDone.tipAmount));
  if (!dec(debt.amount).equals(due)) throw new Error(`FAIL amount: row ${String(debt.amount)} != fee+tip ${due.toString()}`);
  if (debt.status !== 'OWED') throw new Error(`FAIL status: ${debt.status}`);
  log('EVIDENCE VENDOR_OWES_RIDER created', { amount: Number(debt.amount), fee: Number(oDone.deliveryFee), tip: Number(oDone.tipAmount), status: debt.status });

  // ── 3. visible to both sides while owed ──────────────────────────────────
  const riderLedger = await http('GET', '/rider/cash-settlements', undefined, riderToken);
  const vendorLedger = await http('GET', '/vendor/cash-settlements', undefined, ownerToken);
  const rOwedRow = riderLedger.json?.data?.unsettled?.find((s: any) => s.id === debt.id);
  const vOwedRow = vendorLedger.json?.data?.unsettled?.find((s: any) => s.id === debt.id);
  if (!rOwedRow || !vOwedRow) throw new Error(`FAIL visibility in OWED sections: rider=${!!rOwedRow} vendor=${!!vOwedRow}`);
  if (rOwedRow.amount !== due || vOwedRow.amount !== due) throw new Error(`FAIL wire amount: rider=${rOwedRow.amount} vendor=${vOwedRow.amount} != ${due}`);
  log('EVIDENCE owed row visible to both sides w/ exact amount', { riderOwedSummary: riderLedger.json?.data?.summary, vendorOwedSummary: vendorLedger.json?.data?.summary });

  // ── 4. dual-confirm lifecycle ────────────────────────────────────────────
  const rc = await http('POST', `/rider/cash-settlements/${debt.id}/confirm`, {}, riderToken);
  if (rc.status >= 300) throw new Error(`rider confirm ${rc.status}`);
  const half = await prisma.deliveryCashSettlement.findUniqueOrThrow({ where: { id: debt.id } });
  if (half.status !== 'RIDER_CONFIRMED') throw new Error(`FAIL half-state: ${half.status}`);
  const vMid = (await http('GET', '/vendor/cash-settlements', undefined, ownerToken)).json?.data;
  if (!vMid?.unsettled?.some((s: any) => s.id === debt.id)) throw new Error('FAIL: store owed list dropped the row before the store confirmed');
  const vc = await http('POST', `/vendor/cash-settlements/${debt.id}/confirm`, {}, ownerToken);
  if (vc.status >= 300) throw new Error(`vendor confirm ${vc.status}`);
  const settled = await prisma.deliveryCashSettlement.findUniqueOrThrow({ where: { id: debt.id } });
  if (settled.status !== 'SETTLED' || !settled.riderConfirmedAt || !settled.storeConfirmedAt) throw new Error(`FAIL settle: ${settled.status}`);
  // Settled rows LEAVE the owed section but stay visible as history (honesty).
  const rEnd = (await http('GET', '/rider/cash-settlements', undefined, riderToken)).json?.data;
  const vEnd = (await http('GET', '/vendor/cash-settlements', undefined, ownerToken)).json?.data;
  const inOwed = (l: any) => !!l?.unsettled?.some((s: any) => s.id === debt.id);
  const inHistory = (l: any) => !!l?.settled?.some((s: any) => s.id === debt.id);
  if (inOwed(rEnd) || inOwed(vEnd)) throw new Error('FAIL: settled row still in an OWED section');
  if (!inHistory(rEnd) || !inHistory(vEnd)) throw new Error('FAIL: settled row missing from history sections');
  // [F-026-27] "Both counterparts notified" was a COUNT of any two rows bearing
  // the settlement id — two duplicates from one side passed while the other
  // side was never told. Correlate by RECIPIENT: each party must have at
  // least one notice of their own.
  const noticeTo = async (userId: string) => prisma.notification.count({
    where: { userId, data: { path: ['settlementId'], equals: debt.id } } as any,
  });
  const [riderNotices, ownerNotices] = await Promise.all([noticeTo(riderUser.id), noticeTo(ownerUserId)]);
  if (riderNotices < 1 || ownerNotices < 1) {
    throw new Error(`FAIL counterpart notices: rider=${riderNotices}, store=${ownerNotices} — each side must be told of the other's confirm`);
  }
  log('EVIDENCE dual-confirm settled', { status: settled.status, riderNotices, ownerNotices });

  log('B2 COMPLETE — MMG GATE + VENDOR_OWES_RIDER LIFECYCLE PROVEN');
}

main()
  .catch((e) => { console.error('B2 FAILED:', e.message); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
