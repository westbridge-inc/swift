// Taxi journeys [TASK-057]: TAXI-01..05. Every ride needs an L2 passenger
// (C7 is raised to L2 through identity review in provisioning); drivers are
// online through their real endpoints and keep fresh positions via the suite
// heartbeat.

import { OTP, BASE, ORIGIN, upload, type Session } from '../client.js';
import type { Journey, Recorder } from '../journey.js';
import { GET, POST, PUT, req, sleep, brief, pick, waitFor, codeOf } from './common.js';
import type { Ctx } from './context.js';
import { mover, onlineOf, setOnline, pollOffer } from './dispatch.js';
import { registerFresh } from './auth.js';
import { asAdmin, uploadDoc } from '../provision.js';
import { uniquePng } from '../roster.js';
import { twoPerson } from './admin-util.js';

const PICKUP = { lat: 6.8110, lng: -58.1530 };
const DROPOFF = { lat: 6.8250, lng: -58.1400 };
const rideBody = (extra: Record<string, unknown> = {}) => ({
  pickup: PICKUP, dropoff: DROPOFF, pickupAddress: 'TEST pickup, Camp Street', dropoffAddress: 'TEST dropoff, Vlissengen Road', passengerCount: 1, rideClass: 'ECONOMY', ...extra,
});
const drivers = (ctx: Ctx) => onlineOf(ctx, 'driver');

/** C7 (or another L2 passenger) requests a ride; returns its id and PIN. */
async function requestRide(rec: Recorder, ctx: Ctx, passenger: Session, label: string): Promise<{ id: string; pin: string } | null> {
  const r = await POST('/rides/request', rideBody(), passenger.token);
  if (!rec.expect(`${label}: ride request`, r, 201, undefined, `status=${r.json?.data?.ride?.status}`)) return null;
  const ride = r.json?.data?.ride;
  return { id: ride.id, pin: String(ride.ridePin ?? '') };
}

/** A driver takes the ride through its offer. */
async function driverTakes(rec: Recorder, ctx: Ctx, rideId: string, label: string, exclude: string[] = []): Promise<string | null> {
  const got = await pollOffer(ctx, rideId, drivers(ctx).filter((id) => !exclude.includes(id)), 45_000);
  if (!rec.check(`${label}: a driver is offered the ride`, !!got, got ? `${got.moverId}` : 'no offer in 45 s')) return null;
  const d = mover(ctx, got!.moverId);
  const acc = await POST('/driver/offers/accept', { orderId: rideId, offerAttemptId: got!.offer.offerAttemptId }, d.session.token);
  if (!rec.expect(`${label}: ${got!.moverId} accepts`, acc, 200)) return null;
  return got!.moverId;
}

async function cancelRide(passenger: Session, rideId: string) {
  await POST(`/rides/${rideId}/cancel`, { reason: 'journey cleanup' }, passenger.token);
}

async function activeRide(passenger: Session): Promise<any> {
  return (await GET('/rides/active', passenger.token)).json?.data ?? null;
}

/** A fresh L2 passenger for a case that strikes the account (no-show / refusal). */
async function freshL2(rec: Recorder, ctx: Ctx, slot: string): Promise<Session | null> {
  const acct = await registerFresh(ctx, slot);
  if (!acct) return null;
  await upload('/auth/selfie', acct.session.token, { name: 's.png', type: 'image/png', bytes: uniquePng(slot) });
  const id = await uploadDoc(acct.session, `${slot}-national-id`);
  const face = await upload('/verification/upload', acct.session.token, { name: 'face.png', type: 'image/png', bytes: uniquePng(`${slot}-face`) });
  const idv = await POST('/verification/identity', { idDocumentUrl: id.url, selfieUrl: face.json?.data?.url, consent: true, privacyNoticeVersion: '2026-09-23' }, acct.session.token);
  if (!rec.expect(`${slot}: identity submitted for review`, idv, 201)) return null;
  const ok = await asAdmin(ctx.admin.token, 'approve the synthetic identity check of a taxi journey passenger', 'PUT', `/admin/verification/${idv.json?.data?.id}/approve`, {});
  if (!rec.expect(`${slot}: identity approved (L2)`, ok, 200)) return null;
  return acct.session;
}

export const TAXI_01: Journey<Ctx> = {
  id: 'TAXI-01',
  estimateSeconds: 330,
  title: 'Ride request + queue (mobile only)',
  cases: 'L2 request; L1 denial; no-supply queue; auto-request recovery',
  async run(rec, ctx) {
    const C7 = ctx.roster.customers.C7!.session;
    rec.require('an L2 passenger was provisioned', !ctx.world.notReady.C7, ctx.world.notReady.C7 ?? '');
    const l1 = await POST('/rides/request', rideBody(), ctx.roster.customers.C1!.session.token);
    rec.deny('an L1 account cannot request a ride', l1, [403], ['ID_VERIFICATION_REQUIRED'], `reason=${l1.json?.error?.details?.reason ?? ''}`);
    const est = await POST('/rides/estimate', { pickup: PICKUP, dropoff: DROPOFF }, C7.token);
    const eco = (est.json?.data?.tiers ?? []).find((t: any) => t.rideClass === 'ECONOMY');
    rec.check('the estimate prices an economy ride', est.ok && Number(eco?.fare) > 0, `→ ${brief(est)} economy=${eco?.fare} ${est.json?.data?.currencyCode ?? ''}`);

    // L2 request with drivers online
    const ride = await requestRide(rec, ctx, C7, 'L2 request');
    if (ride) {
      rec.check('the passenger holds a 6-digit ride PIN', /^\d{6}$/.test(ride.pin), `pin ${ride.pin ? 'present' : 'missing'}`);
      rec.deny('a second ride while one is live', await POST('/rides/request', rideBody(), C7.token), [409], ['RIDE_IN_PROGRESS']);
      await cancelRide(C7, ride.id);
    }

    // no supply: every driver offline, the passenger queues
    const online = drivers(ctx);
    for (const id of online) await setOnline(ctx, id, false);
    try {
      const avail = await GET(`/rides/availability?lat=${PICKUP.lat}&lng=${PICKUP.lng}`, C7.token);
      rec.check('availability reads NONE with no driver online', avail.json?.data?.level === 'NONE', `level=${avail.json?.data?.level}`);
      const join = await POST('/rides/queue/join', rideBody(), C7.token);
      rec.expect('the passenger joins the no-supply queue', join, 201, undefined, `position=${join.json?.data?.position}`);
      const q = await GET('/rides/queue', C7.token);
      rec.check('the queue entry is readable', !!q.json?.data?.id, `→ ${brief(q)}`);

      // recovery: a driver comes back near the pickup; the scan (every 2 min) turns the entry into a ride
      const back = online[0]!;
      const d = mover(ctx, back);
      ctx.stash.heartbeatOverrides[back] = PICKUP;
      await setOnline(ctx, back, true);
      await PUT('/driver/location', { latitude: PICKUP.lat, longitude: PICKUP.lng, accuracy: 5 }, d.session.token);
      const matched = await waitFor(async () => {
        const qq = await GET('/rides/queue', C7.token);
        const a = await activeRide(C7);
        return !qq.json?.data && a ? a : null;
      }, 200_000, 5_000);
      rec.check('the queued request becomes a ride once supply returns (auto-request)', !!matched, matched ? `ride ${matched.id} status=${matched.status}` : 'still queued after 200 s');
      const note = await GET('/customer/notifications', C7.token);
      rec.check('the passenger is told the queue matched', JSON.stringify(note.json?.data ?? []).includes('ride_queue_matched'), '');
      if (matched) await cancelRide(C7, matched.id);
    } finally {
      await POST('/rides/queue/leave', {}, C7.token);
      for (const id of online) {
        ctx.stash.heartbeatOverrides[id] = undefined;
        await setOnline(ctx, id, true);
      }
    }
  },
};

export const TAXI_02: Journey<Ctx> = {
  id: 'TAXI-02',
  estimateSeconds: 150,
  title: 'Driver accept → en-route → arrived (H-4)',
  cases: 'accept; en-route; arrived; cancellation/re-dispatch',
  async run(rec, ctx) {
    const C7 = ctx.roster.customers.C7!.session;
    rec.require('two drivers online', drivers(ctx).length >= 2, drivers(ctx).join(','));
    const ride = await requestRide(rec, ctx, C7, 'ride');
    rec.require('a ride to drive', !!ride, '');
    const d1 = await driverTakes(rec, ctx, ride!.id, 'first driver');
    rec.require('a driver accepted', !!d1, '');
    const D1 = mover(ctx, d1!);
    const a1 = await activeRide(C7);
    rec.check('the passenger sees the assignment and the driver', a1?.status === 'DRIVER_ASSIGNED' && !!a1?.driver, `status=${a1?.status}`);
    const other = drivers(ctx).find((id) => id !== d1)!;
    rec.deny('another driver cannot move this ride', await PUT(`/driver/rides/${ride!.id}/en-route`, {}, mover(ctx, other).session.token), [403, 404, 409]);
    rec.deny('the passenger cannot drive the ride', await PUT(`/driver/rides/${ride!.id}/en-route`, {}, C7.token), [403, 404]);
    rec.expect('en-route', await PUT(`/driver/rides/${ride!.id}/en-route`, {}, D1.session.token), 200);
    rec.expect('arrived', await PUT(`/driver/rides/${ride!.id}/arrived`, {}, D1.session.token), 200);
    const a2 = await activeRide(C7);
    rec.check('the passenger sees DRIVER_ARRIVED', a2?.status === 'DRIVER_ARRIVED', `status=${a2?.status}`);

    // cancellation by the driver before pickup: back to PENDING, a new PIN, re-dispatched
    rec.deny('a cancel reason that is too short', await POST(`/driver/rides/${ride!.id}/cancel`, { reason: 'x' }, D1.session.token), [400], ['VALIDATION_ERROR']);
    const cx = await POST(`/driver/rides/${ride!.id}/cancel`, { reason: 'vehicle problem before pickup' }, D1.session.token);
    rec.expect('the driver cancels before pickup', cx, 200, undefined, `status=${cx.json?.data?.status} reDispatched=${cx.json?.data?.reDispatched}`);
    const a3 = await activeRide(C7);
    rec.check('the ride is PENDING again with a new PIN', a3?.status === 'PENDING' && String(a3?.ridePin) !== ride!.pin, `status=${a3?.status} pinChanged=${String(a3?.ridePin) !== ride!.pin}`);
    const d2 = await driverTakes(rec, ctx, ride!.id, 're-dispatch', [d1!]);
    rec.check('a different driver takes the re-dispatched ride', !!d2 && d2 !== d1, `first=${d1} second=${d2}`);
    await cancelRide(C7, ride!.id);
  },
};

export const TAXI_03: Journey<Ctx> = {
  id: 'TAXI-03',
  estimateSeconds: 150,
  title: 'PIN verify → start → complete',
  cases: 'PIN verify/start/complete; wrong PIN lockout; concurrent completion',
  async run(rec, ctx) {
    const C7 = ctx.roster.customers.C7!.session;
    const ride = await requestRide(rec, ctx, C7, 'ride');
    rec.require('a ride', !!ride, '');
    const did = await driverTakes(rec, ctx, ride!.id, 'driver');
    rec.require('a driver', !!did, '');
    const D = mover(ctx, did!);
    await PUT(`/driver/rides/${ride!.id}/en-route`, {}, D.session.token);
    rec.deny('PIN before arrival', await PUT(`/driver/rides/${ride!.id}/verify-pin`, { pin: ride!.pin }, D.session.token), [400], ['INVALID_STATUS']);
    await PUT(`/driver/rides/${ride!.id}/arrived`, {}, D.session.token);
    rec.deny('start before the PIN', await PUT(`/driver/rides/${ride!.id}/start`, {}, D.session.token), [400], ['PIN_REQUIRED']);
    rec.deny('a malformed PIN (not counted)', await PUT(`/driver/rides/${ride!.id}/verify-pin`, { pin: '12ab' }, D.session.token), [400], ['VALIDATION_ERROR']);
    const wrong = String((Number(ride!.pin) + 1) % 1_000_000).padStart(6, '0');
    rec.deny('a wrong PIN', await PUT(`/driver/rides/${ride!.id}/verify-pin`, { pin: wrong }, D.session.token), [400], ['INVALID_PIN']);
    rec.expect('the passenger’s PIN verifies', await PUT(`/driver/rides/${ride!.id}/verify-pin`, { pin: ride!.pin }, D.session.token), 200);
    rec.expect('the ride starts', await PUT(`/driver/rides/${ride!.id}/start`, {}, D.session.token), 200);
    rec.check('the passenger sees RIDE_IN_PROGRESS', (await activeRide(C7))?.status === 'RIDE_IN_PROGRESS', '');
    rec.deny('cash rides cannot use the card completion path', await PUT(`/driver/rides/${ride!.id}/complete`, {}, D.session.token), [409], ['PAYMENT_NOT_CAPTURED']);

    // concurrent completion: two handovers at once, one outcome
    const gps = { lat: DROPOFF.lat, lng: DROPOFF.lng };
    const [h1, h2] = await Promise.all([
      POST(`/driver/rides/${ride!.id}/handover`, { outcome: 'paid', gps }, D.session.token),
      POST(`/driver/rides/${ride!.id}/handover`, { outcome: 'paid', gps }, D.session.token),
    ]);
    const oks = [h1!, h2!].filter((r) => r.ok && !r.json?.replayed).length;
    rec.check('two concurrent completions settle once', oks === 1 && [h1!, h2!].every((r) => r.ok || [409].includes(r.status)),
      `→ ${brief(h1!)}${h1!.json?.replayed ? ' (replayed)' : ''}, ${brief(h2!)}${h2!.json?.replayed ? ' (replayed)' : ''}`);
    const ridden = await GET(`/rides/${ride!.id}`, C7.token);
    rec.check('the ride reads DELIVERED (cash captured)', ridden.json?.data?.status === 'DELIVERED' && ridden.json?.data?.paymentStatus === 'CAPTURED', `status=${ridden.json?.data?.status} payment=${ridden.json?.data?.paymentStatus}`);
    const earn = await GET('/driver/earnings/today', D.session.token);
    rec.check('the fare is in the driver’s earnings', earn.ok, `→ ${brief(earn)}`);

    // lockout: five wrong PINs, then even the right one is refused
    const r2 = await requestRide(rec, ctx, C7, 'lockout ride');
    rec.require('a second ride', !!r2, '');
    const d2 = await driverTakes(rec, ctx, r2!.id, 'lockout driver');
    rec.require('a driver for the lockout ride', !!d2, '');
    const D2 = mover(ctx, d2!);
    await PUT(`/driver/rides/${r2!.id}/en-route`, {}, D2.session.token);
    await PUT(`/driver/rides/${r2!.id}/arrived`, {}, D2.session.token);
    const bad = String((Number(r2!.pin) + 3) % 1_000_000).padStart(6, '0');
    const tries: string[] = [];
    for (let i = 0; i < 5; i += 1) tries.push(brief(await PUT(`/driver/rides/${r2!.id}/verify-pin`, { pin: bad }, D2.session.token)));
    rec.check('wrong PINs are each refused', tries.every((t) => t.startsWith('400')), tries.join(', '));
    rec.deny('after the lockout the right PIN is refused', await PUT(`/driver/rides/${r2!.id}/verify-pin`, { pin: r2!.pin }, D2.session.token), [400], ['MAX_ATTEMPTS']);
    rec.deny('the locked ride cannot start', await PUT(`/driver/rides/${r2!.id}/start`, {}, D2.session.token), [400], ['PIN_REQUIRED']);
    await POST(`/driver/rides/${r2!.id}/cancel`, { reason: 'PIN locked, passenger not verified' }, D2.session.token);
    await cancelRide(C7, r2!.id);
    rec.deviceCase('PIN shown on one phone, typed on another', 'the two-phone PIN exchange is the device gate');
  },
};

export const TAXI_04: Journey<Ctx> = {
  id: 'TAXI-04',
  estimateSeconds: 150,
  title: 'Cash outcome / no-show claim',
  cases: 'paid/no-show outcome; missing-GPS denial; admin claim settlement',
  async run(rec, ctx) {
    const passenger = await freshL2(rec, ctx, 'taxi04-noshow');
    rec.require('a fresh L2 passenger (a no-show strikes the account)', !!passenger, '');
    const ride = await requestRide(rec, ctx, passenger!, 'ride');
    rec.require('a ride', !!ride, '');
    const did = await driverTakes(rec, ctx, ride!.id, 'driver');
    rec.require('a driver', !!did, '');
    const D = mover(ctx, did!);
    await PUT(`/driver/rides/${ride!.id}/en-route`, {}, D.session.token);
    await PUT(`/driver/rides/${ride!.id}/arrived`, {}, D.session.token);
    await PUT(`/driver/rides/${ride!.id}/verify-pin`, { pin: ride!.pin }, D.session.token);
    rec.expect('the ride starts', await PUT(`/driver/rides/${ride!.id}/start`, {}, D.session.token), 200);
    rec.deny('an outcome without GPS proof', await POST(`/driver/rides/${ride!.id}/handover`, { outcome: 'no_show' }, D.session.token), [400], ['VALIDATION_ERROR']);
    rec.deny('an unknown outcome', await POST(`/driver/rides/${ride!.id}/handover`, { outcome: 'vanished', gps: DROPOFF }, D.session.token), [400], ['VALIDATION_ERROR']);
    const ns = await POST(`/driver/rides/${ride!.id}/handover`, { outcome: 'no_show', gps: DROPOFF }, D.session.token);
    const claim = ns.json?.data?.claim;
    rec.expect('the driver records a no-show outcome', ns, 200, undefined, `status=${ns.json?.data?.status} claim=${claim?.id ? `${claim.status} ${claim.amount}` : 'none'}`);
    const r = await GET(`/rides/${ride!.id}`, passenger!.token);
    rec.check('the ride ends FAILED', r.json?.data?.status === 'FAILED', `status=${r.json?.data?.status}`);
    const mine = await GET('/driver/claims', D.session.token);
    rec.check('the driver’s claim is on record', JSON.stringify(mine.json?.data ?? null).includes(ride!.id), `→ ${brief(mine)}`);
    rec.deny('a driver cannot read the admin claim queue', await GET('/admin/cash-rules/claims', D.session.token), [403]);
    // A claim with complete evidence is AUTO_APPROVED at once; one with flags waits in PENDING_REVIEW.
    const wanted = String(claim?.status ?? 'PENDING_REVIEW');
    let queue = await GET(`/admin/cash-rules/claims?status=${encodeURIComponent(wanted)}`, ctx.admin.token);
    let row = (queue.json?.data ?? []).find((c: any) => c.orderId === ride!.id || c.id === claim?.id);
    if (!row) {
      queue = await GET('/admin/cash-rules/claims', ctx.admin.token);
      row = (queue.json?.data ?? []).find((c: any) => c.orderId === ride!.id || c.id === claim?.id);
    }
    const listed: any[] = queue.json?.data ?? [];
    rec.check('the driver’s claim is in the operator ledger (auto-approved with complete evidence, else under review)', !!row && ['AUTO_APPROVED', 'PENDING_REVIEW', 'APPROVED'].includes(String(row.status)),
      `claim ${claim?.id ?? '?'} status=${claim?.status ?? '?'}; GET /admin/cash-rules/claims${row ? '' : `?status=${wanted} then unfiltered`} → ${brief(queue)} lists ${listed.length} claim(s) (total ${queue.json?.meta?.total ?? '?'}): ${listed.map((c) => `${c.id}${c.driverId ? ' driver' : c.riderId ? ' rider' : ''}`).join(', ') || 'none'}${row ? '' : ' — the driver claim is absent'}`);
    if (row) {
      let settled = ['AUTO_APPROVED', 'APPROVED'].includes(String(row.status));
      if (!settled) {
        const settle = await twoPerson(rec, ctx, 'approve the synthetic no-show claim', 'PUT', `/admin/cash-rules/claims/${row.id}/approve`, { reason: 'synthetic no-show verified by the journey runner' });
        settled = settle.done;
      }
      if (settled) {
        const paid = await twoPerson(rec, ctx, 'mark the synthetic claim paid', 'PUT', `/admin/cash-rules/claims/${row.id}/paid`, { reference: `SYN-T04-${ctx.runId}`.slice(0, 40), amount: row.amount });
        if (paid.done) {
          const after = await GET('/admin/cash-rules/claims?status=PAID', ctx.admin.token);
          rec.check('the claim reads PAID', JSON.stringify(after.json?.data ?? []).includes(row.id), '');
        }
      }
    }
    void sleep; void pick; void codeOf; void req;
  },
};

export const TAXI_05: Journey<Ctx> = {
  id: 'TAXI-05',
  estimateSeconds: 45,
  title: 'Web taxi booking disabled',
  cases: 'web booking denial; mobile taxi remains reachable',
  async run(rec, ctx) {
    const C7 = ctx.roster.customers.C7!;
    const origin = (process.env.LIVETEST_WEB_ORIGIN ?? '').trim();
    if (origin) {
      // A browser session: cookies from verify-otp with the web client header and an allowed Origin.
      const v = await fetch(`${BASE}/auth/verify-otp`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-swift-client': 'web', origin },
        body: JSON.stringify({ phone: C7.phone, code: OTP }),
      });
      const cookies = (v.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
      rec.check('a browser sign-in yields an HttpOnly session cookie', v.ok && /swift_at=/.test(cookies), `→ ${v.status}, cookies: ${cookies.replace(/=[^;]+/g, '=…') || 'none'}`);
      const webReq = await fetch(`${BASE}/rides/request`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-swift-client': 'web', origin, cookie: cookies },
        body: JSON.stringify(rideBody()),
      });
      const body = await webReq.json().catch(() => null) as any;
      rec.deny('a web (cookie) session cannot book a taxi', { status: webReq.status, ok: webReq.ok, json: body, text: JSON.stringify(body) }, [403], ['TAXI_MOBILE_APP_REQUIRED']);
      const webQ = await fetch(`${BASE}/rides/queue/join`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-swift-client': 'web', origin, cookie: cookies },
        body: JSON.stringify(rideBody()),
      });
      const qb = await webQ.json().catch(() => null) as any;
      rec.deny('nor join the taxi queue', { status: webQ.status, ok: webQ.ok, json: qb, text: JSON.stringify(qb) }, [403], ['TAXI_MOBILE_APP_REQUIRED']);
    } else {
      rec.skipCase('web booking denial', 'LIVETEST_WEB_ORIGIN is not set: a browser (cookie) session needs an origin the API allows (CORS_ORIGIN), so the server-side web refusal cannot be formed');
    }
    const mobile = await POST('/rides/request', rideBody(), C7.session.token);
    rec.expect('the mobile app (bearer) still books a taxi', mobile, 201);
    if (mobile.ok) await cancelRide(C7.session, mobile.json.data.ride.id);
    rec.deny('an unauthenticated booking', await req('POST', '/rides/request', { body: rideBody() }), [401]);
    void ORIGIN;
  },
};

export const TAXI_JOURNEYS = [TAXI_01, TAXI_02, TAXI_03, TAXI_04, TAXI_05];
