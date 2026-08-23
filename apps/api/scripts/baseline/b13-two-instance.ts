/**
 * ELV-2 A12 — Scenario B13: TWO-INSTANCE TIMERS & SINGLE-WINNER.
 *
 * With TWO live API instances sharing one DB + Redis (both running their
 * own sweepers/workers), proves:
 *   1. HOLD RELEASE FIRES EXACTLY ONCE — the vendor gets exactly ONE alert
 *      row for the released order, never two (double-sweeper world).
 *   2. OFFER ACCEPT IS SINGLE-WINNER ACROSS INSTANCES — the same offer
 *      accepted simultaneously through instance A and instance B yields
 *      exactly one 200; the loser gets an honest refusal; the order is
 *      assigned exactly once.
 *
 * Prereq: instance A on :3000 (the rig), instance B on :3020 (workers on).
 * Run: DATABASE_URL=postgresql://swift:swift@localhost:5434/swift \
 *      npx tsx scripts/baseline/b13-two-instance.ts
 */
import { PrismaClient } from '@prisma/client';

const A = 'http://localhost:3000/api/v1';
const B = 'http://localhost:3020/api/v1';
const prisma = new PrismaClient();
const CUSTOMER_PHONE = '+5925566001';
const RIDER_PHONE = '+5925566002';
const OWNER_PHONE = '+5925566000';
const VENDOR_MARK = 'ELV1 Baseline Diner';

function log(step: string, detail: unknown = '') {
  console.log(`${new Date().toISOString()} · ${step}`, typeof detail === 'string' ? detail : JSON.stringify(detail));
}

async function http(base: string, method: string, path: string, body?: unknown, token?: string) {
  const res = await fetch(`${base}${path}`, {
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
    await http(A, 'POST', '/auth/send-otp', { phone });
    const v = await http(A, 'POST', '/auth/verify-otp', { phone, code: '000000' });
    const t = pickToken(v.json);
    if (t) return t;
    if (attempt === 6) throw new Error(`no token for ${phone}`);
    await new Promise((r) => setTimeout(r, 8000));
  }
  throw new Error('unreachable');
}

async function main() {
  // both instances answering?
  for (const [name, base] of [['A', A], ['B', B]] as const) {
    const h = await fetch(`${base.replace('/api/v1', '')}/health`).then((r) => r.status).catch(() => 0);
    if (h !== 200) throw new Error(`instance ${name} not healthy (${h})`);
  }
  log('both instances healthy');

  const vendor = await prisma.vendor.findFirstOrThrow({ where: { name: VENDOR_MARK } });
  const item = await prisma.item.findFirstOrThrow({ where: { vendorId: vendor.id, name: 'ELV1 Pepperpot' } });
  const customer = await prisma.user.findFirstOrThrow({ where: { phone: CUSTOMER_PHONE } });
  const riderUser = await prisma.user.findFirstOrThrow({ where: { phone: RIDER_PHONE } });
  const rider = await prisma.rider.findFirstOrThrow({ where: { userId: riderUser.id } });
  const ownerUserId = (await prisma.vendorOwner.findUniqueOrThrow({ where: { id: vendor.ownerId }, select: { userId: true } })).userId;
  const customerToken = await loginByOtp(CUSTOMER_PHONE);
  const ownerToken = await loginByOtp(OWNER_PHONE);
  const riderToken = await loginByOtp(RIDER_PHONE);

  // Rig tidy: stranded synthetic baseline orders keep redispatch cycling offers
  // at the single rider, starving this run's order of its offer slot. Cancel
  // anything open and unassigned on the baseline vendors (rig-only tidy — same
  // class of synthetic-only mutation as the holdExpiresAt fast-forward).
  const tidied = await prisma.order.updateMany({
    where: {
      vendor: { name: { startsWith: 'ELV1 Baseline' } },
      riderId: null,
      status: { in: ['PENDING', 'ACCEPTED', 'PREPARING', 'READY_FOR_PICKUP'] },
    },
    data: { status: 'CANCELLED' },
  });
  if (tidied.count > 0) log('tidied stranded synthetic orders', { cancelled: tidied.count });
  await http(A, 'POST', '/rider/go-online', { latitude: 6.8, longitude: -58.15 }, riderToken);
  await prisma.rider.update({ where: { id: rider.id }, data: { isOnline: true, isAvailable: true, currentOrderId: null, lastLocationUpdate: new Date() } });

  // ── 1. hold release fires EXACTLY ONCE with two sweepers live ────────────
  await http(A, 'POST', '/customer/cart/items', { vendorId: vendor.id, itemId: item.id, quantity: 1 }, customerToken);
  const addr = await prisma.address.findFirstOrThrow({ where: { userId: customer.id } });
  await http(A, 'PUT', '/customer/cart/address', { addressId: addr.id }, customerToken);
  const co = await http(A, 'POST', '/customer/checkout', { paymentMethod: 'CASH' }, customerToken);
  if (co.status !== 200) throw new Error(`checkout ${co.status}: ${JSON.stringify(co.json).slice(0, 250)}`);
  const orderId: string = co.json.data.orders?.[0]?.id ?? co.json.data.order?.id ?? co.json.data.id;
  const noticeWhere = { userId: ownerUserId, OR: [
    { data: { path: ['orderId'], equals: orderId } },
    { body: { contains: orderId.slice(0, 8) } },
  ] } as const;
  await prisma.order.update({ where: { id: orderId }, data: { holdExpiresAt: new Date(Date.now() - 1000) } });
  log('hold fast-forwarded; both sweepers racing to release', { orderId });
  const deadline = Date.now() + 180_000;
  let notices = 0;
  while (Date.now() < deadline) {
    notices = await prisma.notification.count({ where: noticeWhere as any });
    if (notices > 0) break;
    await new Promise((r) => setTimeout(r, 4000));
  }
  if (notices === 0) throw new Error('FAIL: release never fired');
  // settle window: give the second sweeper every chance to double-fire
  await new Promise((r) => setTimeout(r, 75_000));
  const noticesFinal = await prisma.notification.count({ where: noticeWhere as any });
  if (noticesFinal !== 1) throw new Error(`FAIL exactly-once: ${noticesFinal} vendor alerts for one release`);
  log('EVIDENCE release exactly-once under two sweepers', { vendorAlerts: noticesFinal });

  // ── 2. single-winner accept ACROSS instances ─────────────────────────────
  // Dispatch's candidate query demands location freshness (DISPATCH_LOCATION_
  // FRESH_SECONDS, default 90s) — part 1's settle window outlives it, so the
  // rider must be re-freshened BEFORE 'ready' triggers dispatch, and kept
  // fresh while polling so redispatch retries can still see him.
  await http(A, 'POST', '/rider/go-online', { latitude: 6.8, longitude: -58.15 }, riderToken);
  await prisma.rider.update({ where: { id: rider.id }, data: { isOnline: true, isAvailable: true, currentOrderId: null, lastLocationUpdate: new Date() } });
  for (const step of ['accept', 'preparing', 'ready']) {
    const r = await http(A, 'PUT', `/vendor/orders/${orderId}/${step}`, {}, ownerToken);
    if (r.status >= 300) throw new Error(`vendor ${step} ${r.status}`);
  }
  let offer: any = null;
  const offDeadline = Date.now() + 120_000;
  while (Date.now() < offDeadline) {
    await prisma.rider.update({ where: { id: rider.id }, data: { lastLocationUpdate: new Date() } });
    const cur = await http(A, 'GET', '/rider/offers/current', undefined, riderToken);
    if (cur.json?.data?.offer?.orderId === orderId) { offer = cur.json.data.offer; break; }
    await new Promise((r) => setTimeout(r, 3000));
  }
  if (!offer) throw new Error('FAIL: offer never arrived');
  const payload = { orderId, ...(offer.offerAttemptId ? { offerAttemptId: offer.offerAttemptId } : {}) };
  const [ra, rb] = await Promise.all([
    http(A, 'POST', '/rider/offers/accept', payload, riderToken),
    http(B, 'POST', '/rider/offers/accept', payload, riderToken),
  ]);
  // [F-026-26] Single-winner means ONE 200 AND the loser lost cleanly — a
  // crashed loser (500/401/timeout) is NOT proof of a working race guard, it's
  // an untested path masquerading as one. The loser must return the documented
  // conflict (409 already-claimed, or 410/404 if the offer was consumed).
  const winners = [ra, rb].filter((r) => r.status === 200);
  const losers = [ra, rb].filter((r) => r.status !== 200);
  log('EVIDENCE cross-instance accept race', { instanceA: ra.status, instanceB: rb.status });
  if (winners.length !== 1) throw new Error(`FAIL single-winner: ${winners.length} winners (statuses ${ra.status}/${rb.status})`);
  const loserOk = losers.every((r) => [409, 410, 404].includes(r.status));
  if (!loserOk) throw new Error(`FAIL: the losing instance did not lose CLEANLY — expected 409/410/404, got ${losers.map((r) => r.status).join(',')} (a 5xx is a crash, not a guarded conflict)`);
  const oAssigned = await prisma.order.findUniqueOrThrow({ where: { id: orderId }, select: { riderId: true, status: true } });
  if (oAssigned.riderId !== rider.id) throw new Error('FAIL: wrong assignment');
  log('EVIDENCE assigned exactly once, loser refused cleanly', { ...oAssigned, loserStatuses: losers.map((r) => r.status) });

  // [F-026-26] Cleanup transitions are EVIDENCE, not fire-and-forget — a failed
  // first leg used to leave an assigned order + occupied rider while the script
  // exited green. Assert every leg is accepted.
  for (const step of ['en-route-pickup', 'arrived-pickup', 'picked-up', 'en-route-delivery', 'arrived']) {
    const r = await http(A, 'PUT', `/rider/orders/${orderId}/${step}`, {}, riderToken);
    if (r.status >= 300) throw new Error(`FAIL cleanup: ${step} → ${r.status} (${JSON.stringify(r.json).slice(0, 160)})`);
  }
  const hnd = await http(A, 'POST', `/rider/orders/${orderId}/handover`, { outcome: 'paid', gps: { lat: 6.81, lng: -58.16 } }, riderToken);
  if (hnd.status >= 300) throw new Error(`FAIL cleanup: handover → ${hnd.status}`);
  // Verify the rig is actually reusable: the order is terminal and the rider is free.
  const finalState = await prisma.order.findUniqueOrThrow({ where: { id: orderId }, select: { status: true } });
  if (!['DELIVERED', 'COMPLETED'].includes(finalState.status)) throw new Error(`FAIL cleanup: order left in ${finalState.status}, not delivered`);

  log('B13 COMPLETE — EXACTLY-ONCE RELEASE + SINGLE-WINNER (loser refused cleanly) ACROSS TWO INSTANCES');
}

main()
  .catch((e) => { console.error('B13 FAILED:', e.message); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
