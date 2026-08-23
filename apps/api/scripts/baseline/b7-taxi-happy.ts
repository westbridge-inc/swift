/**
 * ELV-2 A12 — Scenario B7: TAXI HAPPY PATH.
 *
 * request → nearest-driver offer → accept → en-route → arrived →
 * START-CODE HANDSHAKE (ride PIN, driver = verifier) → in-trip → complete →
 * payment recorded. Proves, with server-side evidence:
 *   1. Estimate → request freezes the fare (quoted == completed, no drift).
 *   2. The ONLY online driver gets the offer; accept assigns exactly once.
 *   3. PIN custody: wrong PIN 400 + burns exactly one attempt; right PIN
 *      grants custody; start only from DRIVER_ARRIVED w/ custody.
 *   4. complete → DELIVERED in ONE atomic commit: TAXI_FARE earning at the
 *      frozen fare, driver freed (available, no current ride).
 *
 * Roster: customer +5925566001 (L2) · driver +5926005001 (Anil, QA driver,
 * fully approved — HIRE insurance chain seeded by the dispatch audit).
 *
 * Run: BASELINE_API=http://localhost:3020/api/v1 \
 *      DATABASE_URL=postgresql://swift:swift@localhost:5434/swift \
 *      npx tsx scripts/baseline/b7-taxi-happy.ts
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
const DRIVER_PHONE = '+5926005001';

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

async function main() {
  const h = await fetch(HEALTH).then((r) => r.status).catch(() => 0);
  if (h !== 200) throw new Error(`rig not healthy (${h})`);

  const customer = await prisma.user.findFirstOrThrow({ where: { phone: CUSTOMER_PHONE } });
  const driverUser = await prisma.user.findFirstOrThrow({ where: { phone: DRIVER_PHONE } });
  const driver = await prisma.driver.findFirstOrThrow({ where: { userId: driverUser.id } });

  // Deterministic market: ONLY Anil online; stranded PENDING taxi requests
  // from this synthetic customer cancelled (offer competition).
  driversBefore.push(...await prisma.driver.findMany({ where: { OR: [{ isOnline: true }, { isAvailable: true }] }, select: { id: true, isOnline: true, isAvailable: true } }));
  await prisma.driver.updateMany({ where: {}, data: { isOnline: false, isAvailable: false } });
  const tidied = await prisma.order.updateMany({
    where: { customerId: customer.id, orderType: 'TAXI', status: 'PENDING' },
    data: { status: 'CANCELLED' },
  });
  if (tidied.count > 0) log('tidied stranded taxi requests', { cancelled: tidied.count });

  const customerToken = await loginByOtp(CUSTOMER_PHONE);
  const driverToken = await loginByOtp(DRIVER_PHONE);
  const on = await http('POST', '/driver/go-online', { latitude: 6.8, longitude: -58.15 }, driverToken);
  if (on.status !== 200) throw new Error(`driver go-online ${on.status}: ${JSON.stringify(on.json).slice(0, 250)}`);
  await prisma.driver.update({ where: { id: driver.id }, data: { isOnline: true, isAvailable: true, currentRideId: null, currentLat: 6.8, currentLng: -58.15, lastLocationUpdate: new Date() } });
  log('single-driver market ready', { driver: driver.id });

  // ── 1. estimate → request: the fare freezes ──────────────────────────────
  const trip = {
    pickup: { lat: 6.801, lng: -58.151 }, dropoff: { lat: 6.82, lng: -58.17 },
    pickupAddress: 'ELV1 Baseline pickup corner', dropoffAddress: 'ELV1 Baseline dropoff corner',
    passengerCount: 1, rideClass: 'ECONOMY',
  };
  const est = await http('POST', '/rides/estimate', { pickup: trip.pickup, dropoff: trip.dropoff }, customerToken);
  if (est.status >= 300) throw new Error(`estimate ${est.status}`);
  log('EVIDENCE estimate tiers', JSON.stringify(est.json?.data)?.slice(0, 180));
  const req = await http('POST', '/rides/request', trip, customerToken);
  if (req.status !== 201) throw new Error(`request ${req.status}: ${JSON.stringify(req.json).slice(0, 250)}`);
  const rideId: string = req.json.data.ride.id;
  // Keep the quote as an exact Decimal — the frozen-fare proof is exact.
  const quotedFare = dec(req.json.data.ride.fare);
  const ridePin: string | undefined = req.json.data.ride.ridePin;
  if (!ridePin) throw new Error('no ridePin returned to the customer — the start-code handshake needs it');
  if (!quotedFare.greaterThan(0)) throw new Error(`quoted fare not positive: ${quotedFare.toString()}`);
  log('EVIDENCE ride requested w/ frozen quote + customer-held PIN', { rideId, quotedFare });

  // ── 2. nearest-driver offer → single accept ──────────────────────────────
  let offer: any = null;
  const offDeadline = Date.now() + 120_000;
  while (Date.now() < offDeadline) {
    await prisma.driver.update({ where: { id: driver.id }, data: { lastLocationUpdate: new Date() } });
    const cur = await http('GET', '/driver/offers/current', undefined, driverToken);
    if (cur.json?.data?.offer?.orderId === rideId) { offer = cur.json.data.offer; break; }
    await new Promise((r) => setTimeout(r, 3000));
  }
  if (!offer) throw new Error('offer never reached the only online driver');
  const acc = await http('POST', '/driver/offers/accept', { orderId: rideId, ...(offer.offerAttemptId ? { offerAttemptId: offer.offerAttemptId } : {}) }, driverToken);
  if (acc.status !== 200) throw new Error(`accept ${acc.status}: ${JSON.stringify(acc.json).slice(0, 200)}`);
  const assigned = await prisma.order.findUniqueOrThrow({ where: { id: rideId }, select: { driverId: true, status: true } });
  if (assigned.driverId !== driver.id) throw new Error('assigned to the wrong driver');
  log('EVIDENCE offer → accept → assigned', assigned);

  // ── 3. en-route → arrived → PIN handshake ────────────────────────────────
  for (const step of ['en-route', 'arrived']) {
    const r = await http('PUT', `/driver/rides/${rideId}/${step}`, {}, driverToken);
    if (r.status >= 300) throw new Error(`driver ${step} ${r.status}: ${JSON.stringify(r.json).slice(0, 200)}`);
  }
  const before = await prisma.order.findUniqueOrThrow({ where: { id: rideId }, select: { ridePinAttempts: true } });
  const wrongPin = ridePin === '0000' ? '1111' : ridePin === '000000' ? '111111' : '0'.repeat(ridePin.length);
  const bad = await http('PUT', `/rides/${rideId}/verify-pin`.replace('/rides', '/driver/rides'), { pin: wrongPin }, driverToken);
  if (bad.status !== 400) throw new Error(`FAIL: wrong PIN returned ${bad.status}, expected 400`);
  const after = await prisma.order.findUniqueOrThrow({ where: { id: rideId }, select: { ridePinAttempts: true } });
  if (after.ridePinAttempts !== before.ridePinAttempts + 1) throw new Error(`FAIL: wrong PIN burned ${after.ridePinAttempts - before.ridePinAttempts} attempts, expected exactly 1`);
  log('EVIDENCE wrong PIN rejected + burns exactly one attempt', { attempts: after.ridePinAttempts });
  const good = await http('PUT', `/driver/rides/${rideId}/verify-pin`, { pin: ridePin }, driverToken);
  if (good.status >= 300) throw new Error(`verify-pin ${good.status}: ${JSON.stringify(good.json).slice(0, 200)}`);
  log('EVIDENCE PIN custody granted');

  // ── 4. start → in-trip → complete → payment recorded ─────────────────────
  const start = await http('PUT', `/driver/rides/${rideId}/start`, {}, driverToken);
  if (start.status >= 300) throw new Error(`start ${start.status}: ${JSON.stringify(start.json).slice(0, 200)}`);
  const inTrip = await prisma.order.findUniqueOrThrow({ where: { id: rideId }, select: { status: true } });
  if (inTrip.status !== 'RIDE_IN_PROGRESS') throw new Error(`expected RIDE_IN_PROGRESS, got ${inTrip.status}`);
  const done = await http('PUT', `/driver/rides/${rideId}/complete`, {}, driverToken);
  if (done.status >= 300) throw new Error(`complete ${done.status}: ${JSON.stringify(done.json).slice(0, 200)}`);

  const final = await prisma.order.findUniqueOrThrow({ where: { id: rideId }, select: { status: true, taxiFareTotal: true } });
  if (final.status !== 'DELIVERED') throw new Error(`expected DELIVERED, got ${final.status}`);
  if (!dec(final.taxiFareTotal).equals(quotedFare)) throw new Error(`FAIL fare drift: quoted ${quotedFare.toString()}, completed ${String(final.taxiFareTotal)}`);
  const earning = await prisma.earning.findFirst({ where: { orderId: rideId, driverId: driver.id, type: 'TAXI_FARE' } });
  if (!earning || !dec(earning.amount).equals(quotedFare)) throw new Error(`FAIL earning: ${earning ? String(earning.amount) : 'none'} != ${quotedFare.toString()}`);
  const earnCount = await prisma.earning.count({ where: { orderId: rideId } });
  if (earnCount !== 1) throw new Error(`FAIL: ${earnCount} earning rows for one ride`);
  const freed = await prisma.driver.findUniqueOrThrow({ where: { id: driver.id }, select: { currentRideId: true, isAvailable: true } });
  if (freed.currentRideId !== null || !freed.isAvailable) throw new Error(`FAIL: driver not freed ${JSON.stringify(freed)}`);
  log('EVIDENCE completed at the frozen fare + single earning + driver freed', { status: final.status, fare: Number(final.taxiFareTotal), earning: Number(earning.amount) });

  log('B7 COMPLETE — TAXI HAPPY PATH PROVEN END TO END');
}

main()
  .catch((e) => { console.error('B7 FAILED:', e.message); process.exitCode = 1; })
  .finally(async () => {
    await restoreDrivers('B7').catch((e) => { console.error('B7 DRIVER RESTORE FAILED:', e.message); process.exitCode = 1; });
    await prisma.$disconnect();
  });
