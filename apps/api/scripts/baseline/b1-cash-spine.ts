/**
 * ELV-2 A12 — Scenario B1: the CASH DELIVERY FULL SPINE, live-rig, synthetic
 * roster only (reuses the ELV1 baseline roster; never touches real rows).
 *
 * place → hold (vendor-blind) → release → vendor LOUD alert → accept →
 * preparing → READY → rider offer → accept → pickup → GPS-proofed cash
 * handover → DELIVERED → settlement evidence.
 *
 * RECONCILIATION (ELV-2 says "PIN verify" here): the implemented delivery
 * handover is the SERVER-ISSUED COURIER-PROOF mechanism — outcome+GPS with
 * idempotency (REPORT-018 lineage); customer PINs govern rides + pickup
 * codes govern takeaway. B1 proves the real mechanism.
 *
 * Run: DATABASE_URL=postgresql://swift:swift@localhost:5434/swift \
 *      npx tsx scripts/baseline/b1-cash-spine.ts
 */
import { PrismaClient } from '@prisma/client';

const API = process.env['BASELINE_API'] ?? 'http://localhost:3000/api/v1';
const prisma = new PrismaClient();
const CUSTOMER_PHONE = '+5925566001';
const RIDER_PHONE = '+5925566002';
const OWNER_PHONE = '+5925566000';
const VENDOR_MARK = 'ELV1 Baseline Diner';

function log(step: string, detail: unknown = '') {
  console.log(`${new Date().toISOString()} · ${step}`, typeof detail === 'string' ? detail : JSON.stringify(detail));
}

async function http(method: string, path: string, body?: unknown, token?: string, headers: Record<string, string> = {}) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
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
    const msg = JSON.stringify(v.json ?? {});
    if (!/rate limit|retry/i.test(msg) || attempt === 6) {
      throw new Error(`no token for ${phone}: ${msg.slice(0, 200)}`);
    }
    await new Promise((r) => setTimeout(r, 6500)); // real limiter — wait it out
  }
  throw new Error('unreachable');
}

async function main() {
  // ── roster references (b6 created them; require, don't recreate) ──────────
  const vendor = await prisma.vendor.findFirstOrThrow({ where: { name: VENDOR_MARK } });
  const item = await prisma.item.findFirstOrThrow({ where: { vendorId: vendor.id, name: 'ELV1 Pepperpot' } });
  const customer = await prisma.user.findFirstOrThrow({ where: { phone: CUSTOMER_PHONE } });
  const riderUser = await prisma.user.findFirstOrThrow({ where: { phone: RIDER_PHONE } });
  const rider = await prisma.rider.findFirstOrThrow({ where: { userId: riderUser.id } });
  const ownerUserId = (await prisma.vendorOwner.findUniqueOrThrow({ where: { id: vendor.ownerId }, select: { userId: true } })).userId;
  // [F-024-06] Never make an ASSIGNED rider dispatch-eligible by clearing only
  // the pointer — the abandoned order would sit live with a rider the pool
  // believes is free. Close the stranded synthetic orders FIRST (same rig-tidy
  // class as the holdExpiresAt fast-forward), then reset the rider.
  const tidied = await prisma.order.updateMany({
    where: {
      vendor: { name: { startsWith: 'ELV1 Baseline' } },
      status: { in: ['PENDING', 'ACCEPTED', 'PREPARING', 'READY_FOR_PICKUP', 'RIDER_ASSIGNED', 'RIDER_EN_ROUTE_PICKUP', 'RIDER_ARRIVED_PICKUP', 'PICKED_UP', 'EN_ROUTE_DELIVERY', 'ARRIVED'] },
    },
    data: { status: 'CANCELLED' },
  });
  if (tidied.count > 0) log('tidied stranded synthetic orders', { cancelled: tidied.count });
  await prisma.rider.update({
    where: { id: rider.id },
    data: { isOnline: true, isAvailable: true, currentOrderId: null, currentLat: 6.8, currentLng: -58.15, lastLocationUpdate: new Date() },
  });
  const customerToken = await loginByOtp(CUSTOMER_PHONE);
  const ownerToken = await loginByOtp(OWNER_PHONE);
  const riderToken = await loginByOtp(RIDER_PHONE);
  // INV-10: availability + dispatch share ONE source — so the rider goes
  // online through the REAL flow, not a DB poke.
  const on = await http('POST', '/rider/go-online', { latitude: 6.8, longitude: -58.15 }, riderToken);
  if (on.status >= 300) throw new Error(`rider go-online ${on.status}: ${JSON.stringify(on.json).slice(0, 200)}`);
  await http('PUT', '/rider/location', { latitude: 6.8, longitude: -58.15 }, riderToken);
  const address = await prisma.address.findFirstOrThrow({ where: { userId: customer.id } });
  log('roster + 3 tokens ready', { vendor: vendor.id, rider: rider.id });

  // ── 1. place (cash) ────────────────────────────────────────────────────────
  await http('POST', '/customer/cart/items', { vendorId: vendor.id, itemId: item.id, quantity: 1 }, customerToken);
  await http('PUT', '/customer/cart/address', { addressId: address.id }, customerToken);
  const co = await http('POST', '/customer/checkout', { paymentMethod: 'CASH' }, customerToken);
  if (co.status !== 200) throw new Error(`checkout ${co.status}: ${JSON.stringify(co.json).slice(0, 300)}`);
  const orderId: string = co.json.data.orders?.[0]?.id ?? co.json.data.order?.id ?? co.json.data.id;
  const o0 = await prisma.order.findUniqueOrThrow({ where: { id: orderId }, select: { status: true, holdExpiresAt: true, totalAmount: true, deliveryFee: true } });
  log('EVIDENCE placed', { orderId, ...o0 });

  // ── 2. hold vendor-blind, then fast-forward the WINDOW (synthetic order —
  //       we shrink the timestamp; the SWEEPER still does the release) ───────
  if (o0.holdExpiresAt && o0.holdExpiresAt > new Date()) {
    const noticeWhere = (oid: string) => ({ userId: ownerUserId, OR: [
      { data: { path: ['orderId'], equals: oid } },
      { body: { contains: oid.slice(0, 8) } },
    ] });
    const notices = await prisma.notification.count({ where: noticeWhere(orderId) });
    if (notices > 0) throw new Error('FAIL: vendor notified during hold');
    log('EVIDENCE hold vendor-blind', { holdExpiresAt: o0.holdExpiresAt, vendorNotices: notices });
    await prisma.order.update({ where: { id: orderId }, data: { holdExpiresAt: new Date(Date.now() - 1000) } });
    log('hold window fast-forwarded (synthetic order only) — waiting for the release sweep');
    const deadline = Date.now() + 180_000;
    for (;;) {
      const n = await prisma.notification.count({ where: noticeWhere(orderId) });
      if (n > 0) { log('EVIDENCE vendor LOUD alert after release', { notices: n }); break; }
      if (Date.now() > deadline) throw new Error('FAIL: release sweep never surfaced the order to the vendor');
      await new Promise((r) => setTimeout(r, 5000));
    }
  } else {
    // [F-024-05] The hold IS part of the cash spine on this rig (LIFECYCLE_V2
    // on; B6/B13 prove it live). A checkout that lands with no hold is a
    // regression, not a legacy mode to note-and-continue past.
    throw new Error(`FAIL: order placed WITHOUT a hold window (holdExpiresAt=${String(o0.holdExpiresAt)})`);
  }

  // ── 3. vendor works the board: accept → preparing → READY ────────────────
  const acc = await http('PUT', `/vendor/orders/${orderId}/accept`, {}, ownerToken);
  if (acc.status >= 300) throw new Error(`vendor accept ${acc.status}: ${JSON.stringify(acc.json).slice(0, 200)}`);
  const prep = await http('PUT', `/vendor/orders/${orderId}/preparing`, {}, ownerToken);
  if (prep.status >= 300) log('NOTE preparing step', `${prep.status} (may auto-advance)`);
  const rdy = await http('PUT', `/vendor/orders/${orderId}/ready`, {}, ownerToken);
  if (rdy.status >= 300) throw new Error(`vendor ready ${rdy.status}: ${JSON.stringify(rdy.json).slice(0, 200)}`);
  log('EVIDENCE vendor board worked', { accept: acc.status, preparing: prep.status, ready: rdy.status });

  // ── 4. the offer reaches the synthetic rider; accept with attempt echo ────
  let offer: any = null;
  const offDeadline = Date.now() + 120_000;
  while (Date.now() < offDeadline) {
    const cur = await http('GET', '/rider/offers/current', undefined, riderToken);
    if (cur.json?.data?.offer?.orderId === orderId) { offer = cur.json.data.offer; break; }
    await new Promise((r) => setTimeout(r, 3000));
  }
  if (!offer) throw new Error('FAIL: offer never reached the rider');
  // [F-024-05 / F-220] The attempt identity is part of the offer contract —
  // dispatch mints one per generation and the recovery read must echo it. A
  // null here silently downgrades accept to the legacy wildcard path.
  if (!offer.offerAttemptId) throw new Error('FAIL F-220: /rider/offers/current echoed offerAttemptId null — attempt identity lost on the recovery path');
  log('EVIDENCE offer', { orderId: offer.orderId, offerAttemptId: offer.offerAttemptId });
  const acceptOffer = await http('POST', '/rider/offers/accept', { orderId, offerAttemptId: offer.offerAttemptId }, riderToken);
  if (acceptOffer.status >= 300) throw new Error(`offer accept ${acceptOffer.status}: ${JSON.stringify(acceptOffer.json).slice(0, 200)}`);
  const oAssigned = await prisma.order.findUniqueOrThrow({ where: { id: orderId }, select: { status: true, riderId: true } });
  if (oAssigned.riderId !== rider.id) throw new Error(`FAIL: order assigned to ${oAssigned.riderId}, expected ${rider.id}`);
  log('EVIDENCE assigned', oAssigned);

  // ── 5. the run: en-route → arrived-pickup → picked-up → en-route → arrived ─
  for (const step of ['en-route-pickup', 'arrived-pickup', 'picked-up', 'en-route-delivery', 'arrived']) {
    const r = await http('PUT', `/rider/orders/${orderId}/${step}`, {}, riderToken);
    if (r.status >= 300) throw new Error(`FAIL transition ${step}: ${r.status} ${JSON.stringify(r.json).slice(0, 200)}`);
  }
  log('EVIDENCE run transitions complete');

  // ── 6. GPS-proofed cash handover (the real "PIN" of the delivery spine) ───
  const hand = await http('POST', `/rider/orders/${orderId}/handover`, {
    outcome: 'paid', gps: { lat: 6.81, lng: -58.16 },
  }, riderToken, { 'idempotency-key': `b1-${orderId}` });
  if (hand.status >= 300) throw new Error(`FAIL handover: ${hand.status} ${JSON.stringify(hand.json).slice(0, 300)}`);
  // [F-024-05] idempotency ASSERTED, not logged: the replay must succeed, be
  // MARKED as a replay by the server, and return the original result — a
  // 409/500 or a silently re-executed second handover both fail here.
  if (hand.json?.replayed === true) throw new Error('FAIL: FIRST handover reported replayed=true');
  const replay = await http('POST', `/rider/orders/${orderId}/handover`, {
    outcome: 'paid', gps: { lat: 6.81, lng: -58.16 },
  }, riderToken, { 'idempotency-key': `b1-${orderId}` });
  if (replay.status >= 300) throw new Error(`FAIL replay: ${replay.status} ${JSON.stringify(replay.json).slice(0, 200)}`);
  if (replay.json?.replayed !== true) throw new Error(`FAIL: replay not marked replayed (got ${JSON.stringify(replay.json?.replayed)})`);
  if (JSON.stringify(replay.json?.data ?? null) !== JSON.stringify(hand.json?.data ?? null)) throw new Error('FAIL: replay returned a DIFFERENT result than the original handover');
  log('EVIDENCE handover + idempotent replay', { first: hand.status, replay: replay.status, replayedFlag: replay.json?.replayed });

  // ── 7. settlement evidence ────────────────────────────────────────────────
  const oFinal = await prisma.order.findUniqueOrThrow({ where: { id: orderId }, select: { status: true, deliveredAt: true } });
  if (!['DELIVERED', 'COMPLETED'].includes(oFinal.status)) throw new Error(`FAIL final status ${oFinal.status}`);
  if (!oFinal.deliveredAt) throw new Error('FAIL: DELIVERED order carries no deliveredAt timestamp');
  // [F-024-05] Money integrity ASSERTED exactly: one DELIVERY_FEE earning for
  // THIS rider at THIS order's fee, AVAILABLE — and for a CASH order, NO
  // DeliveryCashSettlement row (that row is the MMG-only VENDOR_OWES_RIDER
  // obligation; cash settles implicitly at handover — F-221 CLOSED-VERIFIED).
  const feeMinor = Math.round(Number(o0.deliveryFee ?? 0) * 100);
  const earnings = await prisma.earning.findMany({ where: { orderId }, select: { type: true, amount: true, riderId: true, status: true } });
  const feeRows = earnings.filter((e) => e.type === 'DELIVERY_FEE');
  if (feeRows.length !== 1) throw new Error(`FAIL: ${feeRows.length} DELIVERY_FEE earnings, expected exactly 1`);
  if (feeRows[0]!.riderId !== rider.id) throw new Error(`FAIL: earning credited to ${feeRows[0]!.riderId}, expected ${rider.id}`);
  if (Math.round(Number(feeRows[0]!.amount) * 100) !== feeMinor) throw new Error(`FAIL: earning ${String(feeRows[0]!.amount)} != deliveryFee ${String(o0.deliveryFee)}`);
  if (feeRows[0]!.status !== 'AVAILABLE') throw new Error(`FAIL: earning status ${feeRows[0]!.status}, expected AVAILABLE`);
  const dup = await prisma.earning.groupBy({ by: ['type'], where: { orderId }, _count: true }).then((g) => g.filter((x) => x._count > 1));
  if (dup.length > 0) throw new Error(`FAIL: duplicated earnings after replay: ${JSON.stringify(dup)}`);
  const settlement = await prisma.deliveryCashSettlement.findFirst({ where: { orderId } });
  if (settlement) throw new Error(`FAIL: CASH order minted a DeliveryCashSettlement row (${settlement.id}) — that obligation is MMG-only`);
  log('EVIDENCE settlement', { finalStatus: oFinal.status, deliveredAt: oFinal.deliveredAt, earnings, cashSettlement: null });

  log('B1 COMPLETE — CASH SPINE PROVEN END-TO-END');
}

main()
  .catch((e) => { console.error('B1 FAILED:', e.message); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
