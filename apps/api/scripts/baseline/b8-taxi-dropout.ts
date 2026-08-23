/**
 * ELV-2 A12 — Scenario B8: TAXI DRIVER DROP-OUT.
 *
 * decline / timeout / exit at each pre-trip stage → cascade to the next
 * driver; never auto-cancel IN_PROGRESS. Two rides, two drivers:
 *
 * RIDE A — timeout + decline cascade:
 *   nearest driver IGNORES the offer (20s OFFER_TIMEOUT) → cascade to the
 *   second driver → second driver DECLINES → pool dry (customer tidies).
 * RIDE B — exit-after-accept + custody protection:
 *   first driver accepts then CANCELS pre-trip → controlled release: order
 *   back to PENDING, driver freed, RIDE PIN ROTATED w/ zeroed attempts
 *   (F-014-12), cancellationRate bumped → cascade re-offers → second driver
 *   accepts → arrives → verifies the NEW pin (old pin dead) → starts →
 *   cancel attempt IN TRIP → 400 (never auto-cancel with a passenger
 *   aboard) → completes normally.
 *
 * Roster: customer +5925566001 (L2) · drivers +5926005001 (Anil) and
 * +5926005002 (Marcus) — QA drivers, approved.
 *
 * Run: BASELINE_API=http://localhost:3020/api/v1 \
 *      DATABASE_URL=postgresql://swift:swift@localhost:5434/swift \
 *      npx tsx scripts/baseline/b8-taxi-dropout.ts
 */
import { PrismaClient } from '@prisma/client';

const A = process.env['BASELINE_API'] ?? 'http://localhost:3000/api/v1';
const HEALTH = A.replace('/api/v1', '') + '/health';
const prisma = new PrismaClient();
// [F-026-30] A started ride is a live Guardian-monitored trip; the finally
// must bring any still-live one to a safe terminal state (complete — the
// custody law refuses an in-trip cancel) rather than just disconnecting.
let liveRide: { id: string; token: string } | null = null;
const CUSTOMER_PHONE = '+5925566001';
const D1_PHONE = '+5926005001';
const D2_PHONE = '+5926005002';

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

async function freshen(driverId: string) {
  await prisma.driver.update({ where: { id: driverId }, data: { lastLocationUpdate: new Date() } });
}

async function waitOffer(driverId: string, token: string, orderId: string, ms: number): Promise<any | null> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    await freshen(driverId);
    const cur = await http('GET', '/driver/offers/current', undefined, token);
    if (cur.json?.data?.offer?.orderId === orderId) return cur.json.data.offer;
    await new Promise((r) => setTimeout(r, 2500));
  }
  return null;
}


/** [F-026-05] Prior driver state, captured before the pool is emptied — the
 *  "no drivers" premise must not outlive the run. Same restore-and-VERIFY
 *  discipline as b9 (F-028-17): per-row attempts, named failures, re-read
 *  verification, non-zero exit when the rig wasn't put back. */
const driversBefore: Array<{ id: string; isOnline: boolean; isAvailable: boolean }> = [];
async function restoreDrivers(tag: string): Promise<void> {
  const failures: string[] = [];
  for (const d of driversBefore) {
    try {
      await prisma.driver.updateMany({ where: { id: d.id }, data: { isOnline: d.isOnline, isAvailable: d.isAvailable } });
    } catch (e) { failures.push(`driver ${d.id}: ${(e as Error).message}`); }
  }
  const stillOffline = driversBefore.length === 0 ? 0 : await prisma.driver.count({
    where: { id: { in: driversBefore.filter((d) => d.isOnline).map((d) => d.id) }, isOnline: false },
  });
  console.log(`${new Date().toISOString()} · teardown: driver restore ${failures.length === 0 && stillOffline === 0 ? 'VERIFIED' : 'INCOMPLETE'}`,
    JSON.stringify({ drivers: driversBefore.length, failures, stillOffline }));
  if (failures.length > 0 || stillOffline > 0) { console.error(`${tag} DRIVER RESTORE INCOMPLETE`); process.exitCode = 1; }
}

// [F-026-30] Complete a started-but-unfinished ride via the authorized driver
// path and verify Guardian closed with it — never leave a live monitored trip.
async function unwindLiveRide(): Promise<void> {
  if (!liveRide) return;
  const { id, token } = liveRide;
  const cur = await prisma.order.findUnique({ where: { id }, select: { status: true } });
  const TERMINAL = ['DELIVERED', 'COMPLETED', 'CANCELLED'];
  if (!cur || TERMINAL.includes(cur.status)) { liveRide = null; return; }
  console.error(`B8 SAFETY UNWIND: ride ${id} left in ${cur.status} — completing via authorized path`);
  await http('PUT', `/driver/rides/${id}/complete`, {}, token).catch(() => undefined);
  const after = await prisma.order.findUnique({ where: { id }, select: { status: true } });
  const openSession = await prisma.tripSafetySession.count({ where: { orderId: id, status: { in: ['MONITORING', 'CHECKIN_PENDING', 'ESCALATING'] } } }).catch(() => 0);
  if (!after || !TERMINAL.includes(after.status) || openSession > 0) {
    console.error(`B8 SAFETY UNWIND INCOMPLETE: status=${after?.status}, openGuardianSessions=${openSession}`);
    process.exitCode = 1;
  }
  liveRide = null;
}

async function main() {
  const h = await fetch(HEALTH).then((r) => r.status).catch(() => 0);
  if (h !== 200) throw new Error(`rig not healthy (${h})`);

  const customer = await prisma.user.findFirstOrThrow({ where: { phone: CUSTOMER_PHONE } });
  const d1User = await prisma.user.findFirstOrThrow({ where: { phone: D1_PHONE } });
  const d2User = await prisma.user.findFirstOrThrow({ where: { phone: D2_PHONE } });
  const d1 = await prisma.driver.findFirstOrThrow({ where: { userId: d1User.id } });
  const d2 = await prisma.driver.findFirstOrThrow({ where: { userId: d2User.id } });

  driversBefore.push(...await prisma.driver.findMany({ where: { OR: [{ isOnline: true }, { isAvailable: true }] }, select: { id: true, isOnline: true, isAvailable: true } }));
  await prisma.driver.updateMany({ where: {}, data: { isOnline: false, isAvailable: false } });
  await prisma.order.updateMany({ where: { customerId: customer.id, orderType: 'TAXI', status: 'PENDING' }, data: { status: 'CANCELLED' } });

  const customerToken = await loginByOtp(CUSTOMER_PHONE);
  const d1Token = await loginByOtp(D1_PHONE);
  const d2Token = await loginByOtp(D2_PHONE);
  for (const [tok, drv, lat] of [[d1Token, d1, 6.8], [d2Token, d2, 6.807]] as const) {
    const on = await http('POST', '/driver/go-online', { latitude: lat, longitude: -58.15 }, tok);
    if (on.status !== 200) throw new Error(`go-online ${on.status}: ${JSON.stringify(on.json).slice(0, 200)}`);
    await prisma.driver.update({ where: { id: drv.id }, data: { isOnline: true, isAvailable: true, currentRideId: null, currentLat: lat, currentLng: -58.15, lastLocationUpdate: new Date() } });
  }
  log('two-driver market ready', { nearest: d1.id, second: d2.id });

  const trip = {
    pickup: { lat: 6.801, lng: -58.151 }, dropoff: { lat: 6.82, lng: -58.17 },
    pickupAddress: 'ELV1 Baseline pickup corner', dropoffAddress: 'ELV1 Baseline dropoff corner',
    passengerCount: 1, rideClass: 'ECONOMY',
  };

  // ── RIDE A: timeout cascade, then decline ────────────────────────────────
  // ETA re-ranking decides who is offered FIRST — detect the actual holder by
  // polling both, ignore them through the 20s timeout, and expect the cascade
  // to move the SAME order to the other driver.
  const reqA = await http('POST', '/rides/request', trip, customerToken);
  if (reqA.status !== 201) throw new Error(`request A ${reqA.status}: ${JSON.stringify(reqA.json).slice(0, 200)}`);
  const rideA: string = reqA.json.data.ride.id;
  const both: Array<{ drv: { id: string }; token: string; name: string }> = [
    { drv: d1, token: d1Token, name: 'D1' }, { drv: d2, token: d2Token, name: 'D2' },
  ];
  let holder: (typeof both)[0] | null = null;
  {
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline && !holder) {
      for (const b of both) {
        await freshen(b.drv.id);
        const cur = await http('GET', '/driver/offers/current', undefined, b.token);
        if (cur.json?.data?.offer?.orderId === rideA) { holder = b; break; }
      }
      if (!holder) await new Promise((r) => setTimeout(r, 2000));
    }
  }
  if (!holder) throw new Error('ride A: no driver ever offered');
  const second = both.find((b) => b !== holder)!;
  log(`ride A offered to ${holder.name} — IGNORING through the 20s timeout`, { rideA });
  const offA2 = await waitOffer(second.drv.id, second.token, rideA, 90_000);
  if (!offA2) throw new Error('FAIL timeout cascade: second driver never offered after ignore');
  log(`EVIDENCE timeout cascade moved the offer ${holder.name}→${second.name}`);
  const dec = await http('POST', '/driver/offers/decline', { orderId: rideA, ...(offA2.offerAttemptId ? { offerAttemptId: offA2.offerAttemptId } : {}) }, second.token);
  if (dec.status >= 300) throw new Error(`decline ${dec.status}: ${JSON.stringify(dec.json).slice(0, 200)}`);
  const afterDecline = await http('GET', '/driver/offers/current', undefined, second.token);
  if (afterDecline.json?.data?.offer?.orderId === rideA) throw new Error('FAIL: declined offer still current');
  log('EVIDENCE decline honored (offer slot cleared)');
  const aState = await prisma.order.findUniqueOrThrow({ where: { id: rideA }, select: { status: true, driverId: true } });
  if (aState.driverId !== null || !['PENDING', 'CANCELLED'].includes(aState.status)) throw new Error(`FAIL: ride A wrongly assigned: ${JSON.stringify(aState)}`);
  await http('POST', `/rides/${rideA}/cancel`, { reason: 'ELV2 B8 tidy' }, customerToken);
  await prisma.order.updateMany({ where: { id: rideA, status: 'PENDING' }, data: { status: 'CANCELLED' } });
  log('ride A tidied (customer cancel after pool dry)');

  // ── RIDE B: exit-after-accept, pin rotation, custody protection ──────────
  const reqB = await http('POST', '/rides/request', trip, customerToken);
  if (reqB.status !== 201) throw new Error(`request B ${reqB.status}: ${JSON.stringify(reqB.json).slice(0, 200)}`);
  const rideB: string = reqB.json.data.ride.id;
  const pinB1: string = reqB.json.data.ride.ridePin;
  // whichever driver holds the first offer accepts (declined-set from ride A
  // does not apply to a fresh order, but keep it robust):
  let winner: { id: string; token: string; other: { id: string; token: string } } | null = null;
  {
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline && !winner) {
      for (const [drv, tok, oDrv, oTok] of [[d1, d1Token, d2, d2Token], [d2, d2Token, d1, d1Token]] as const) {
        await freshen(drv.id);
        const cur = await http('GET', '/driver/offers/current', undefined, tok);
        if (cur.json?.data?.offer?.orderId === rideB) {
          const acc = await http('POST', '/driver/offers/accept', { orderId: rideB, ...(cur.json.data.offer.offerAttemptId ? { offerAttemptId: cur.json.data.offer.offerAttemptId } : {}) }, tok);
          if (acc.status !== 200) throw new Error(`accept B ${acc.status}`);
          winner = { id: drv.id, token: tok, other: { id: oDrv.id, token: oTok } };
          break;
        }
      }
      if (!winner) await new Promise((r) => setTimeout(r, 2500));
    }
  }
  if (!winner) throw new Error('ride B: no offer reached either driver');
  log('ride B accepted by the first offered driver', { winner: winner.id });

  const exit = await http('POST', `/driver/rides/${rideB}/cancel`, { reason: 'ELV2 B8 exit test' }, winner.token);
  if (exit.status >= 300) throw new Error(`driver cancel ${exit.status}: ${JSON.stringify(exit.json).slice(0, 200)}`);
  const released = await prisma.order.findUniqueOrThrow({ where: { id: rideB }, select: { status: true, driverId: true, ridePin: true, ridePinAttempts: true } });
  if (released.status !== 'PENDING' || released.driverId !== null) throw new Error(`FAIL release: ${JSON.stringify({ s: released.status, d: released.driverId })}`);
  if (released.ridePin === pinB1) throw new Error('FAIL: ride PIN not rotated on driver exit (F-014-12)');
  if (released.ridePinAttempts !== 0) throw new Error(`FAIL: attempt budget not zeroed (${released.ridePinAttempts})`);
  const exFreed = await prisma.driver.findUniqueOrThrow({ where: { id: winner.id }, select: { currentRideId: true, isAvailable: true, cancellationRate: true } });
  if (exFreed.currentRideId !== null || !exFreed.isAvailable) throw new Error('FAIL: exiting driver not freed');
  if (Number(exFreed.cancellationRate) <= 0) throw new Error('FAIL: cancel-after-accept did not feed cancellationRate');
  log('EVIDENCE controlled release: PENDING + driver freed + PIN ROTATED + attempts zeroed + cancellationRate fed', { cancellationRate: Number(exFreed.cancellationRate) });

  const offB2 = await waitOffer(winner.other.id, winner.other.token, rideB, 120_000);
  if (!offB2) throw new Error('FAIL: cascade after driver exit never re-offered');
  const acc2 = await http('POST', '/driver/offers/accept', { orderId: rideB, ...(offB2.offerAttemptId ? { offerAttemptId: offB2.offerAttemptId } : {}) }, winner.other.token);
  if (acc2.status !== 200) throw new Error(`re-accept ${acc2.status}`);
  log('EVIDENCE cascade re-offered to the remaining driver after exit');

  const secondToken = winner.other.token;
  for (const step of ['en-route', 'arrived']) {
    const r = await http('PUT', `/driver/rides/${rideB}/${step}`, {}, secondToken);
    if (r.status >= 300) throw new Error(`driver ${step} ${r.status}`);
  }
  const oldPinTry = await http('PUT', `/driver/rides/${rideB}/verify-pin`, { pin: pinB1 }, secondToken);
  if (oldPinTry.status !== 400) throw new Error(`FAIL: the pre-exit PIN still verifies (${oldPinTry.status})`);
  const pinB2 = (await prisma.order.findUniqueOrThrow({ where: { id: rideB }, select: { ridePin: true } })).ridePin!;
  const vp = await http('PUT', `/driver/rides/${rideB}/verify-pin`, { pin: pinB2 }, secondToken);
  if (vp.status >= 300) throw new Error(`verify rotated pin ${vp.status}`);
  const st = await http('PUT', `/driver/rides/${rideB}/start`, {}, secondToken);
  if (st.status >= 300) throw new Error(`start ${st.status}`);
  liveRide = { id: rideB, token: secondToken }; // [F-026-30] armed
  const inTripCancel = await http('POST', `/driver/rides/${rideB}/cancel`, { reason: 'ELV2 B8 custody probe' }, secondToken);
  if (inTripCancel.status !== 400) throw new Error(`FAIL custody law: in-trip driver cancel returned ${inTripCancel.status}, expected 400`);
  log('EVIDENCE never-auto-cancel IN_PROGRESS (old pin dead, rotated pin works, in-trip cancel 400)');
  const done = await http('PUT', `/driver/rides/${rideB}/complete`, {}, secondToken);
  if (done.status >= 300) throw new Error(`complete ${done.status}`);
  const fin = await prisma.order.findUniqueOrThrow({ where: { id: rideB }, select: { status: true } });
  if (fin.status !== 'DELIVERED') throw new Error(`expected DELIVERED, got ${fin.status}`);
  liveRide = null; // safely terminal
  log('EVIDENCE ride B completed after the drop-out chain', fin);

  log('B8 COMPLETE — DROP-OUT CASCADE + CUSTODY PROTECTION PROVEN');
}

main()
  .catch((e) => { console.error('B8 FAILED:', e.message); process.exitCode = 1; })
  .finally(async () => {
    await unwindLiveRide().catch((e) => { console.error('B8 SAFETY UNWIND FAILED:', e.message); process.exitCode = 1; });
    await restoreDrivers('B8').catch((e) => { console.error('B8 DRIVER RESTORE FAILED:', e.message); process.exitCode = 1; });
    await prisma.$disconnect();
  });
