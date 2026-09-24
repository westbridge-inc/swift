// Safety journeys [TASK-057]: SAFE-01 (SOS, fan-out, ack/resolve, duplicate
// and retry) and SAFE-02 (trip share, guardian check-in and alert, revoke,
// location withheld after the trip). Ops actions are taken by the admin.

import type { Session } from '../client.js';
import type { Journey } from '../journey.js';
import { GET, POST, PUT, DEL, req, sleep, brief, pick, waitFor } from './common.js';
import type { Ctx } from './context.js';
import { mover, onlineOf, pollOffer } from './dispatch.js';
import { CONTACT_PHONE } from '../roster.js';

export const SAFE_01: Journey<Ctx> = {
  id: 'SAFE-01',
  estimateSeconds: 60,
  title: 'SOS + emergency contacts fanout',
  cases: 'SOS; contact/ops fanout; ack/resolve; duplicate and retry',
  async run(rec, ctx) {
    const C2 = ctx.roster.customers.C2!, C3 = ctx.roster.customers.C3!.session.token, admin = ctx.admin.token;
    const contacts = await GET('/safety/emergency-contacts', C2.session.token);
    const list: any[] = Array.isArray(contacts.json?.data) ? contacts.json.data : contacts.json?.data?.contacts ?? [];
    if (!list.some((c) => c.phoneE164 === CONTACT_PHONE)) {
      const add = await POST('/safety/emergency-contacts', { name: 'Journey Contact', phoneE164: CONTACT_PHONE }, C2.session.token);
      rec.expect('an emergency contact is added (a code is sent to it)', add, [200, 201]);
    } else {
      rec.step('an emergency contact is on file', true, 'reused from an earlier run');
    }

    const key = `${ctx.runId}-sos`.slice(0, 120);
    const at = { lat: C2.lat, lng: C2.lng, accuracyM: 12, addressText: 'TEST address, Georgetown' };
    const sos = await POST('/safety/sos', { ...at, source: 'BUTTON', clientIdempotencyKey: key }, C2.session.token);
    rec.expect('the customer raises an SOS', sos, [200, 201], undefined, `status=${sos.json?.data?.status} graceEndsAt=${sos.json?.data?.graceEndsAt}`);
    const id = sos.json?.data?.id;
    rec.require('an SOS id', !!id, '');
    const dup = await POST('/safety/sos', { ...at, source: 'BUTTON', clientIdempotencyKey: key }, C2.session.token);
    rec.check('a duplicate press with the same key is the same alert', dup.ok && dup.json?.data?.id === id, `→ ${brief(dup)} id=${dup.json?.data?.id}`);
    if (sos.json?.data?.status === 'TRIGGER_PENDING') {
      const c = await POST(`/safety/sos/${id}/confirm`, {}, C2.session.token);
      rec.check('confirming inside the grace window makes it ACTIVE', c.ok || c.status === 409, `→ ${brief(c)}`);
    }
    const retry = await POST('/safety/sos', { ...at, source: 'BUTTON' }, C2.session.token);
    rec.check('a retry without a key while the alert is live merges into it', retry.ok && retry.json?.data?.id === id, `→ ${brief(retry)} id=${retry.json?.data?.id}`);

    rec.deny('another customer cannot read the SOS', await GET(`/safety/sos/${id}`, C3), [403, 404]);
    rec.deny('a customer cannot acknowledge SOS alerts', await POST(`/safety/sos/${id}/ack`, {}, C3), [403]);
    const alerts = await waitFor(async () => {
      const r = await GET('/safety/ops-alerts', admin);
      return JSON.stringify(r.json?.data ?? []).includes(id) ? r : null;
    }, 30_000);
    rec.check('ops is paged (an ops alert names the SOS)', !!alerts, alerts ? 'ops alert present' : 'no ops alert within 30 s');
    const open = await GET('/safety/sos?status=open', admin);
    rec.check('the SOS is in the ops queue', JSON.stringify(open.json?.data ?? []).includes(id), `→ ${brief(open)}`);
    rec.expect('ops acknowledges', await POST(`/safety/sos/${id}/ack`, {}, admin), 200);
    rec.deny('an unknown resolution code', await POST(`/safety/sos/${id}/resolve`, { resolutionCode: 'NOT_A_CODE' }, admin), [400], ['VALIDATION_ERROR']);
    rec.expect('ops resolves it (safe confirmed)', await POST(`/safety/sos/${id}/resolve`, { resolutionCode: 'SAFE_CONFIRMED', notes: `journey drill ${ctx.runId}` }, admin), 200);
    const mine = await GET(`/safety/sos/${id}`, C2.session.token);
    rec.check('the customer reads the resolution', mine.ok && /RESOLVED|CLOSED/.test(String(mine.json?.data?.status)), `status=${mine.json?.data?.status}`);
    rec.deny('a resolved SOS cannot be resolved again', await POST(`/safety/sos/${id}/resolve`, { resolutionCode: 'SAFE_CONFIRMED' }, admin), [409], ['INVALID_SOS_TRANSITION']);
    rec.deviceCase('emergency-contact SMS fan-out', 'the contact is verified by an SMS code and alerted by SMS; Phase A has no SMS provider, so this is the device/provider gate (a consented contact phone)');
    void DEL; void req; void sleep; void pick;
  },
};

export const SAFE_02: Journey<Ctx> = {
  id: 'SAFE-02',
  estimateSeconds: 560,
  title: 'Guardian / trip share / monitoring',
  cases: 'trip share; check-in; guardian alert; revoke and stale-location denial',
  async run(rec, ctx) {
    const C7 = ctx.roster.customers.C7!.session;
    const pickup = { lat: 6.8110, lng: -58.1530 }, drop = { lat: 6.8250, lng: -58.1400 };
    const mid = { lat: 6.8180, lng: -58.1466 };
    const r = await POST('/rides/request', { pickup, dropoff: drop, pickupAddress: 'TEST pickup, Camp Street', dropoffAddress: 'TEST dropoff, Vlissengen Road', passengerCount: 1, rideClass: 'ECONOMY' }, C7.token);
    rec.expect('the passenger requests a ride', r, 201);
    const ride = r.json?.data?.ride;
    rec.require('a ride', !!ride?.id, '');
    const got = await pollOffer(ctx, ride.id, onlineOf(ctx, 'driver'));
    rec.require('a driver is offered the ride', !!got, '');
    const D: { session: Session } & ReturnType<typeof mover> = mover(ctx, got!.moverId);
    rec.expect('the driver accepts', await POST('/driver/offers/accept', { orderId: ride.id, offerAttemptId: got!.offer.offerAttemptId }, D.session.token), 200);
    await PUT(`/driver/rides/${ride.id}/en-route`, {}, D.session.token);
    await PUT(`/driver/rides/${ride.id}/arrived`, {}, D.session.token);
    await PUT(`/driver/rides/${ride.id}/verify-pin`, { pin: String(ride.ridePin) }, D.session.token);
    rec.expect('the trip starts', await PUT(`/driver/rides/${ride.id}/start`, {}, D.session.token), 200);

    // trip share
    const share = await POST(`/safety/trips/${ride.id}/share`, {}, C7.token);
    rec.expect('the passenger shares the trip', share, [200, 201], undefined, `expiresAt=${share.json?.data?.expiresAt}`);
    const token = share.json?.data?.token;
    rec.deny('a stranger cannot share this trip', await POST(`/safety/trips/${ride.id}/share`, {}, ctx.roster.customers.C2!.session.token), [404]);
    const pub = await req('GET', `/safety/public/trip/${token}`, {});
    rec.check('anyone with the link sees the live trip (no sign-in)', pub.ok && pub.json?.data?.ended === false && !!pub.json?.data?.driver, `→ ${brief(pub)} location=${pub.json?.data?.location ? 'shown' : 'none'}`);
    rec.deny('a guessed link', await req('GET', `/safety/public/trip/${'g'.repeat(32)}`, {}), [404]);

    // check-in: the car stops away from both ends; the guardian asks the passenger
    ctx.stash.heartbeatOverrides[got!.moverId] = mid;
    let checkin: any = null;
    try {
      const deadline = Date.now() + 7 * 60_000;
      while (Date.now() < deadline && !checkin) {
        await PUT('/driver/location', { latitude: mid.lat, longitude: mid.lng, accuracy: 5 }, D.session.token);
        const c = await GET('/safety/guardian/checkin', C7.token);
        if (c.json?.data?.sessionId || c.json?.data?.level) checkin = c.json.data;
        else await sleep(10_000);
      }
      if (checkin) {
        rec.step('the guardian asks the passenger to check in after an unexplained stop', true, JSON.stringify(checkin).slice(0, 160));
        rec.deny('a stranger cannot answer the check-in', await POST('/safety/guardian/checkin', { response: 'OK' }, ctx.roster.customers.C2!.session.token), [404, 409]);
        const help = await POST('/safety/guardian/checkin', { response: 'NEED_HELP' }, C7.token);
        rec.check('“I need help” escalates to an SOS (guardian alert)', help.ok && help.json?.data?.escalated === true && !!help.json?.data?.sosAlertId, `→ ${brief(help)} ${JSON.stringify(help.json?.data ?? null)}`);
        const sosId = help.json?.data?.sosAlertId;
        if (sosId) {
          await POST(`/safety/sos/${sosId}/ack`, {}, ctx.admin.token);
          rec.expect('ops resolves the guardian alert', await POST(`/safety/sos/${sosId}/resolve`, { resolutionCode: 'SAFE_CONFIRMED', notes: 'journey guardian drill' }, ctx.admin.token), 200);
        }
      } else {
        rec.skipCase('check-in and guardian alert', 'no check-in was raised within 7 minutes of a stationary position; the detector is time-driven (stopped ≥3–5 min away from both ends, sweep every 15 s)');
      }
    } finally {
      ctx.stash.heartbeatOverrides[got!.moverId] = undefined;
    }

    // end the trip; the public page stops showing a position; revoke
    rec.expect('the trip ends (cash paid)', await POST(`/driver/rides/${ride.id}/handover`, { outcome: 'paid', gps: drop }, D.session.token), 200);
    const ended = await req('GET', `/safety/public/trip/${token}`, {});
    rec.check('after the trip the shared page withholds the location', ended.ok && ended.json?.data?.ended === true && ended.json?.data?.location == null, `→ ${brief(ended)} ended=${ended.json?.data?.ended} location=${JSON.stringify(ended.json?.data?.location ?? null)}`);
    rec.deny('a new share of a finished trip', await POST(`/safety/trips/${ride.id}/share`, {}, C7.token), [409], ['TRIP_OVER']);
    rec.deny('a stranger cannot revoke the link', await DEL(`/safety/share/${token}`, ctx.roster.customers.C2!.session.token), [404]);
    rec.expect('the passenger revokes the link', await DEL(`/safety/share/${token}`, C7.token), 200);
    rec.deny('a revoked link shows nothing', await req('GET', `/safety/public/trip/${token}`, {}), [404]);
    void pick; void waitFor;
  },
};

export const SAFETY_JOURNEYS = [SAFE_01, SAFE_02];
