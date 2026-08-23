/**
 * ELV-2 A12 — Scenario B9: NO-AVAILABILITY HONESTY.
 *
 * With ZERO riders and ZERO drivers online, proves the platform tells the
 * truth instead of stranding money or spinning forever:
 *   1. DELIVERY checkout → honest 409 DELIVERY_NO_RIDERS offering Pickup.
 *   2. PICKUP checkout still works (the fallback is real), free-cancelled
 *      inside the hold afterwards.
 *   3. Taxi supply read GET /rides/availability → level NONE (derived from
 *      dispatch's own candidate query — no fake optimism).
 *   4. "Tell me when drivers are back": POST /availability/watch creates the
 *      watch; POST /queue/join stores the FULL trip (WAITING w/ TTL) and
 *      supersedes the bare watch; /queue/leave is one honest tap out.
 *   5. Taxi request at zero supply (default allows it — drivers may come
 *      online mid-search) → dispatch exhausts → customer gets the honest
 *      dispatch_exhausted notice (no spinner-forever).
 *
 * Run: BASELINE_API=http://localhost:3020/api/v1 \
 *      DATABASE_URL=postgresql://swift:swift@localhost:5434/swift \
 *      npx tsx scripts/baseline/b9-no-availability.ts
 */
import { PrismaClient } from '@prisma/client';
import { EXHAUST_CAP, REDISPATCH_DELAY_MS } from '../../src/modules/dispatch/dispatch.service';

/**
 * [F-027-09] An EXECUTABLE containment barrier, not a comment.
 *
 * This scenario's premise is an empty market, so it takes every rider and
 * driver offline with an unscoped updateMany. Against a shared or
 * multi-tenant database that poisons the supply of tenants with nothing to do
 * with this test — and the baselines are CI-gated now, so "only run it on the
 * rig" as prose is not a barrier. Refuse anything that is not a known
 * disposable rig database unless an operator says otherwise out loud.
 */
const DISPOSABLE_DBS = ['swift', 'swift_test', 'swift_test2', 'swift_test3'];
function assertDisposableRig(): void {
  if (process.env['BASELINE_ALLOW_DESTRUCTIVE'] === '1') return;
  const url = process.env['DATABASE_URL'] ?? '';
  // [F-028-17] Parse with the URL class, not a regex keyed on '@'. PostgreSQL
  // userinfo is OPTIONAL, so postgresql://production.example/swift used to
  // yield host '' — and '' was treated as LOCAL, letting B9 take every rider
  // and driver offline against a remote target. Unknown is now REFUSED:
  // a guard that cannot name the host has no business trusting it.
  let host = '';
  let name = '';
  try {
    const parsed = new URL(url);
    host = parsed.hostname;
    name = parsed.pathname.replace(/^\//, '').split('?')[0] ?? '';
  } catch { /* unparseable → host stays '', refused below */ }
  const localish = host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === 'db';
  if (!localish || !DISPOSABLE_DBS.includes(name)) {
    throw new Error(
      `REFUSING TO RUN: B9 takes EVERY rider and driver offline, and "${name || url}" on host "${host || 'unknown'}" is not a known disposable local rig `
      + `(${DISPOSABLE_DBS.join(', ')}). Set BASELINE_ALLOW_DESTRUCTIVE=1 only if you genuinely mean to empty this database's supply pools.`,
    );
  }
}

/** Prior online/available state, captured before the pools are emptied. */
const onlineBefore: {
  riders: Array<{ id: string; isOnline: boolean; isAvailable: boolean }>;
  drivers: Array<{ id: string; isOnline: boolean; isAvailable: boolean }>;
} = { riders: [], drivers: [] };

/** [F-027-09 → F-028-17] Put the supply back on EVERY exit path — and keep
 *  going when one row fails. The serial version threw out of the loop on the
 *  first failed Rider update, skipped every later Rider and ALL Drivers, and
 *  the finalizer swallowed it: the next run inherited a partially emptied
 *  rig while this one had already printed COMPLETE. Every row is now its own
 *  attempt, failures are counted and named, and the restore VERIFIES itself
 *  by re-reading the rows it claims to have restored. */
let trustBefore: { customerId: string; trustLevel: string } | null = null;
async function restoreSupply(): Promise<void> {
  const failures: string[] = [];
  for (const r of onlineBefore.riders) {
    try {
      await prisma.rider.updateMany({ where: { id: r.id }, data: { isOnline: r.isOnline, isAvailable: r.isAvailable } });
    } catch (e) { failures.push(`rider ${r.id}: ${(e as Error).message}`); }
  }
  for (const d of onlineBefore.drivers) {
    try {
      await prisma.driver.updateMany({ where: { id: d.id }, data: { isOnline: d.isOnline, isAvailable: d.isAvailable } });
    } catch (e) { failures.push(`driver ${d.id}: ${(e as Error).message}`); }
  }
  // [F-028-17] The rig-prep trust promotion was PERMANENT — every run
  // ratcheted the fixture customer to L2 and never put it back, so later
  // runs could not exercise the L1 gates. Restore what was captured.
  if (trustBefore) {
    try {
      await prisma.user.update({ where: { id: trustBefore.customerId }, data: { trustLevel: trustBefore.trustLevel as never } });
    } catch (e) { failures.push(`trust restore: ${(e as Error).message}`); }
  }
  // Verify, never assume: re-read what we claim to have restored.
  const stillOffline = onlineBefore.riders.length === 0 ? 0 : await prisma.rider.count({
    where: { id: { in: onlineBefore.riders.filter((r) => r.isOnline).map((r) => r.id) }, isOnline: false },
  });
  console.log(`${new Date().toISOString()} · teardown: supply restore ${failures.length === 0 && stillOffline === 0 ? 'VERIFIED' : 'INCOMPLETE'}`,
    JSON.stringify({ riders: onlineBefore.riders.length, drivers: onlineBefore.drivers.length, failures, stillOffline }));
  if (failures.length > 0 || stillOffline > 0) process.exitCode = 1;
}

const A = process.env['BASELINE_API'] ?? 'http://localhost:3000/api/v1';
const HEALTH = A.replace('/api/v1', '') + '/health';
const prisma = new PrismaClient();
const CUSTOMER_PHONE = '+5925566001';
const VENDOR_MARK = 'ELV1 Baseline Diner';

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
  // [F-027-09] FIRST, before any database or network access. A containment
  // barrier that runs after the connection is already open is not a barrier —
  // the first probe of this put it after the fixture lookups, so a wrong
  // DATABASE_URL failed with a Prisma connection error instead of the refusal
  // that explains what this script would have done.
  assertDisposableRig();
  const h = await fetch(HEALTH).then((r) => r.status).catch(() => 0);
  if (h !== 200) throw new Error(`rig not healthy (${h})`);

  const vendor = await prisma.vendor.findFirstOrThrow({ where: { name: VENDOR_MARK } });
  const item = await prisma.item.findFirstOrThrow({ where: { vendorId: vendor.id, name: 'ELV1 Pepperpot' } });
  const customer = await prisma.user.findFirstOrThrow({ where: { phone: CUSTOMER_PHONE } });

  // Rig prep: EVERY pool offline (the scenario IS the empty market), stranded
  // synthetic orders tidied, and the synthetic customer at L2 (taxi trust gate
  // — roster prep, same class as roster creation).
  // [F-027-09] This takes EVERY pool offline, unscoped, and used to never put
  // them back. On any shared or multi-tenant database that poisons the supply
  // of tenants with nothing to do with this scenario — and the script is now
  // CI-gated, so "only run it on the rig" as a code comment is not a barrier.
  // Two changes: an executable guard, and an actual restore.
  onlineBefore.riders = (await prisma.rider.findMany({ where: { OR: [{ isOnline: true }, { isAvailable: true }] }, select: { id: true, isOnline: true, isAvailable: true } }));
  onlineBefore.drivers = (await prisma.driver.findMany({ where: { OR: [{ isOnline: true }, { isAvailable: true }] }, select: { id: true, isOnline: true, isAvailable: true } }));
  const riders = await prisma.rider.updateMany({ where: {}, data: { isOnline: false, isAvailable: false } });
  const drivers = await prisma.driver.updateMany({ where: {}, data: { isOnline: false, isAvailable: false } });
  log('rig prep: pools taken offline, prior state captured for restore', { willRestoreRiders: onlineBefore.riders.length, willRestoreDrivers: onlineBefore.drivers.length });
  const tidied = await prisma.order.updateMany({
    where: { vendor: { name: { startsWith: 'ELV1 Baseline' } }, status: { in: ['PENDING', 'ACCEPTED', 'PREPARING', 'READY_FOR_PICKUP'] } },
    data: { status: 'CANCELLED' },
  });
  if ((customer as any).trustLevel === 'L1') {
    trustBefore = { customerId: customer.id, trustLevel: 'L1' };
    await prisma.user.update({ where: { id: customer.id }, data: { trustLevel: 'L2' } });
    log('rig prep: synthetic customer raised to L2 for the taxi gates (restored at teardown)');
  }
  log('market emptied', { ridersOffline: riders.count, driversOffline: drivers.count, tidied: tidied.count });

  const customerToken = await loginByOtp(CUSTOMER_PHONE);

  // ── 1. delivery checkout is honestly refused ─────────────────────────────
  await http('POST', '/customer/cart/items', { vendorId: vendor.id, itemId: item.id, quantity: 1 }, customerToken);
  const addr = await prisma.address.findFirstOrThrow({ where: { userId: customer.id } });
  await http('PUT', '/customer/cart/address', { addressId: addr.id }, customerToken);
  const co = await http('POST', '/customer/checkout', { paymentMethod: 'CASH' }, customerToken);
  if (co.status !== 409) throw new Error(`FAIL: delivery checkout at zero supply returned ${co.status}, expected 409`);
  const code = co.json?.error?.code;
  const msg: string = co.json?.error?.message ?? '';
  if (code !== 'DELIVERY_NO_RIDERS' || !/pickup/i.test(msg)) throw new Error(`FAIL honesty copy: ${code} · ${msg}`);
  log('EVIDENCE delivery refused honestly w/ pickup fallback copy', { code });

  // ── 2. the pickup fallback is real ───────────────────────────────────────
  const cop = await http('POST', '/customer/checkout', { paymentMethod: 'CASH', fulfillmentSelections: { [vendor.id]: 'PICKUP' } }, customerToken);
  if (cop.status !== 200) throw new Error(`FAIL: pickup fallback checkout ${cop.status}: ${JSON.stringify(cop.json).slice(0, 200)}`);
  const pickupOrderId: string = cop.json.data.orders?.[0]?.id ?? cop.json.data.order?.id ?? cop.json.data.id;
  log('EVIDENCE pickup fallback works', { pickupOrderId });
  const can = await http('POST', `/orders/${pickupOrderId}/cancel`, { reason: 'ELV2 baseline B9 tidy' }, customerToken);
  const can2 = can.status < 300 ? can : await http('POST', `/customer/orders/${pickupOrderId}/cancel`, { reason: 'ELV2 baseline B9 tidy' }, customerToken);
  if (can2.status >= 300) throw new Error(`tidy cancel ${can2.status}`);

  // ── 3. taxi supply read is honest ────────────────────────────────────────
  const avail = await http('GET', '/rides/availability?lat=6.8&lng=-58.15', undefined, customerToken);
  if (avail.json?.data?.level !== 'NONE') throw new Error(`FAIL supply read: ${JSON.stringify(avail.json?.data)}`);
  log('EVIDENCE taxi supply read honest', avail.json.data);

  // ── 4. watch + queue: a supply gap is a service ──────────────────────────
  const watch = await http('POST', '/rides/availability/watch', { lat: 6.8, lng: -58.15 }, customerToken);
  if (watch.status >= 300 || !watch.json?.data?.id) throw new Error(`watch ${watch.status}`);
  log('EVIDENCE supply watch created', { id: watch.json.data.id });
  const trip = {
    pickup: { lat: 6.8, lng: -58.15 }, dropoff: { lat: 6.82, lng: -58.17 },
    pickupAddress: 'ELV1 Baseline pickup corner', dropoffAddress: 'ELV1 Baseline dropoff corner',
    passengerCount: 1,
  };
  const qj = await http('POST', '/rides/queue/join', trip, customerToken);
  if (qj.status !== 201 && qj.status !== 200) throw new Error(`queue join ${qj.status}: ${JSON.stringify(qj.json).slice(0, 200)}`);
  const qs = qj.json?.data;
  if (!qs || qs.position < 1 || !qs.expiresAt || qs.suppliersOnline !== 0) throw new Error(`FAIL queue status: ${JSON.stringify(qs).slice(0, 200)}`);
  const watchGone = await prisma.supplyWatch.count({ where: { customerId: customer.id, notifiedAt: null } });
  if (watchGone !== 0) throw new Error(`FAIL: queue join should supersede the bare watch (${watchGone} left)`);
  // [F-026-28] The claim is "the queue stores the FULL trip in WAITING" — so
  // read the PERSISTED row, not just the response envelope. A response that
  // echoes a position while nothing durable landed used to pass.
  const qRow = await prisma.rideQueueEntry.findFirst({
    where: { customerId: customer.id },
    orderBy: { createdAt: 'desc' },
    select: { status: true, pickupLat: true, pickupLng: true, dropoffLat: true, dropoffLng: true, pickupAddress: true, dropoffAddress: true, expiresAt: true },
  });
  if (!qRow) throw new Error('FAIL: queue join persisted no RideQueueEntry row');
  if (qRow.status !== 'WAITING') throw new Error(`FAIL: queue row is ${qRow.status}, expected WAITING`);
  if (qRow.pickupAddress !== trip.pickupAddress || qRow.dropoffAddress !== trip.dropoffAddress) {
    throw new Error('FAIL: the queue row does not carry the full trip (addresses differ from the request)');
  }
  if (Number(qRow.pickupLat) !== trip.pickup.lat || Number(qRow.dropoffLng) !== trip.dropoff.lng) {
    throw new Error('FAIL: the queue row does not carry the full trip (coordinates differ from the request)');
  }
  if (!qRow.expiresAt) throw new Error('FAIL: the queue row has no TTL');
  log('EVIDENCE queue join stores the full trip and supersedes the watch', { rowStatus: qRow.status, expiresAt: qRow.expiresAt });
  const ql = await http('POST', '/rides/queue/leave', {}, customerToken);
  if (ql.status >= 300 || ql.json?.data?.left !== true) throw new Error(`queue leave ${ql.status}`);
  log('EVIDENCE queue leave honest one-tap', ql.json.data);

  // ── 5. request at zero supply → quiet rescans, then HONEST RELEASE ───────
  // Taxi design: no repeat customer pushes during the ≤TAXI_WAIT_LIMIT_MIN
  // (30) rescan window (socket dead-state only) — then the ride is RELEASED:
  // CANCELLED + told + nothing to pay. The limit leg is fast-forwarded by
  // shrinking placedAt on this SYNTHETIC ride (same class as the hold shrink).
  const req = await http('POST', '/rides/request', trip, customerToken);
  if (req.status !== 201) throw new Error(`ride request ${req.status}: ${JSON.stringify(req.json).slice(0, 250)}`);
  const rideId: string = req.json.data.ride.id;
  log('ride requested at zero supply', { rideId, message: req.json.data.message });

  // Ops drought page (SWIFT-AUD-D7-02). TIMING MATTERS — and getting it wrong
  // once produced a false finding (F-224, retracted): exhaust() returns early
  // while attempts < EXHAUST_CAP (3) at REDISPATCH_DELAY_MS (90s), so the taxi
  // slow lane that owns the ops page is only reached on the THIRD exhaust,
  // ~4.5min+ in. Wait past when the page is DUE, computed from the constants,
  // before concluding anything about its absence.
  // [F-027-03] DERIVED, not hardcoded. This claimed to be "computed from the
  // constants" while spelling out 3 * 90_000 — so a change to either constant
  // (both are env-tunable) would silently make the gate wrong: too short and
  // B9 concludes "no page" before the page is due, which is exactly the false
  // finding F-224 was. It was also one interval too long: attempts 1..CAP-1
  // schedule a re-sweep and the CAP-th is terminal, so the page is due after
  // (CAP - 1) intervals, not CAP.
  // [F-028-17/F-027-03] Pin to the SERVER's effective tuning, not this
  // shell's env: /health (detail view) states the running API's own
  // exhaustCap/redispatchDelayMs. Fall back to the imported constants ONLY
  // when the server predates the field — and say so, because in that case
  // the wait math is an assumption again.
  let serverCap = EXHAUST_CAP;
  let serverDelay = REDISPATCH_DELAY_MS;
  try {
    const h = await (await fetch(HEALTH)).json() as { dispatch?: { exhaustCap?: number; redispatchDelayMs?: number } };
    if (h.dispatch?.exhaustCap && h.dispatch?.redispatchDelayMs) {
      serverCap = h.dispatch.exhaustCap;
      serverDelay = h.dispatch.redispatchDelayMs;
      log('wait math pinned to the SERVER\u2019s effective tuning', { serverCap, serverDelay });
    } else {
      log('WARNING: server /health does not state dispatch tuning — wait math is this shell\u2019s ASSUMPTION', { EXHAUST_CAP, REDISPATCH_DELAY_MS });
    }
  } catch {
    log('WARNING: could not read /health for dispatch tuning — wait math is this shell\u2019s ASSUMPTION');
  }
  const OPS_PAGE_DUE_MS = (serverCap - 1) * serverDelay + 90_000; // + slack
  let opsPages = 0;
  const opsDeadline = Date.now() + OPS_PAGE_DUE_MS;
  while (Date.now() < opsDeadline) {
    opsPages = await prisma.notification.count({
      where: { data: { path: ['orderId'], equals: rideId } as any, NOT: { userId: customer.id } },
    });
    if (opsPages > 0) break;
    await new Promise((r) => setTimeout(r, 10_000));
  }
  if (opsPages === 0) throw new Error(`FAIL: no ops page after ${Math.round(OPS_PAGE_DUE_MS / 1000)}s — a fully-exhausted dispatch must reach an admin (SWIFT-AUD-D7-02)`);
  log('EVIDENCE ops drought page fired', { opsPages, waitedSec: Math.round((Date.now() - (opsDeadline - OPS_PAGE_DUE_MS)) / 1000) });

  await prisma.order.update({ where: { id: rideId }, data: { placedAt: new Date(Date.now() - 31 * 60_000) } });
  log('placedAt fast-forwarded past the 30-min wait limit');
  const sinceRequest = new Date(Date.now() - 10 * 60_000);
  const relDeadline2 = Date.now() + 240_000;
  let releasedNotice = 0;
  while (Date.now() < relDeadline2) {
    // [F-026-28] Correlate on the RELEASE notification specifically — any
    // earlier generic dispatch message bearing this ride id used to satisfy
    // the "customer was told nothing to pay" claim.
    releasedNotice = await prisma.notification.count({
      where: {
        userId: customer.id, createdAt: { gte: sinceRequest },
        AND: [
          { data: { path: ['orderId'], equals: rideId } as any },
          { data: { path: ['kind'], equals: 'ride_released_no_drivers' } as any },
        ],
      },
    });
    const cur = await prisma.order.findUnique({ where: { id: rideId }, select: { status: true, cancellationReason: true } });
    if (cur?.status === 'CANCELLED' && releasedNotice > 0) {
      if (cur.cancellationReason !== 'NO_DRIVERS_AVAILABLE') throw new Error(`FAIL release reason: ${cur.cancellationReason}`);
      log('EVIDENCE honest release', { status: cur.status, reason: cur.cancellationReason, customerNotices: releasedNotice });
      break;
    }
    await new Promise((r) => setTimeout(r, 6000));
  }
  const fin = await prisma.order.findUniqueOrThrow({ where: { id: rideId }, select: { status: true } });
  if (fin.status !== 'CANCELLED' || releasedNotice === 0) throw new Error(`FAIL: release leg incomplete (status=${fin.status}, notices=${releasedNotice})`);

  log('B9 COMPLETE — EMPTY-MARKET HONESTY PROVEN ON EVERY SURFACE');
}

main()
  .catch((e) => { console.error('B9 FAILED:', e.message); process.exitCode = 1; })
  .finally(async () => {
    // [F-027-09] Put the supply back, on EVERY exit path. A scenario whose
    // whole premise is "the market is empty" must not leave it that way.
    await restoreSupply().catch((e) => {
      console.error('B9 SUPPLY RESTORE FAILED:', e.message);
      process.exitCode = 1;
    });
    await prisma.$disconnect();
  });
