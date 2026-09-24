// Courier journeys [TASK-057]: COUR-01 and COUR-02. A courier job is always
// held for the 5-minute window and dispatched within ~10 s of release, so the
// orders are placed in `prepare` and claimed in `release` (an offer nobody
// answers excludes that rider from the job for an hour).

import { FIXTURE_PNG, upload } from '../client.js';
import type { Journey, Recorder } from '../journey.js';
import { GET, POST, PUT, req, sleep, brief, waitFor, codeOf, noteHold } from './common.js';
import type { Ctx } from './context.js';
import { mover, onlineOf, pollOffer } from './dispatch.js';
import { uniquePng, RECIPIENT_PHONE } from '../roster.js';

const PICK = { lat: 6.8140, lng: -58.1540 };
const DROP = { lat: 6.8215, lng: -58.1450 };
const courierBody = (size: 'SMALL' | 'MEDIUM' | 'LARGE' | 'EXTRA_LARGE', note: string) => ({
  pickup: PICK, dropoff: DROP, pickupAddress: 'TEST courier pickup, Brickdam', dropoffAddress: 'TEST courier dropoff, Sheriff Street',
  packageSize: size, packageDescription: note, speed: 'STANDARD', recipientName: 'Test Recipient', recipientPhone: RECIPIENT_PHONE, payer: 'SENDER',
});

async function createCourier(rec: Recorder, ctx: Ctx, size: 'SMALL' | 'LARGE', label: string): Promise<{ id: string; token: string } | null> {
  const r = await POST('/courier/order', courierBody(size, `journey ${label} ${ctx.runId}`), ctx.roster.customers.C8!.session.token);
  if (!rec.expect(`${label}: courier order (${size})`, r, 201, undefined, `fee=${r.json?.data?.fee}`)) return null;
  const o = (await GET(`/courier/order/${r.json.data.orderId}`, ctx.roster.customers.C8!.session.token)).json?.data;
  noteHold(o?.holdExpiresAt);
  return { id: r.json.data.orderId, token: r.json.data.trackingToken };
}

async function waitReleased(ctx: Ctx, id: string) {
  const o = (await GET(`/courier/order/${id}`, ctx.roster.customers.C8!.session.token)).json?.data;
  const until = o?.holdExpiresAt ? Date.parse(o.holdExpiresAt) : 0;
  if (until > Date.now()) await sleep(until - Date.now() + 1_000);
}

export const COUR_01: Journey<Ctx> = {
  id: 'COUR-01',
  title: 'Courier "Send": order + collect + proof',
  cases: 'create; rider accept/collect; pickup/dropoff proof; public track; retry/recovery',
  async prepare(rec, ctx) {
    const est = await POST('/courier/estimate', { pickup: PICK, dropoff: DROP, packageSize: 'SMALL', speed: 'STANDARD' }, ctx.roster.customers.C8!.session.token);
    rec.check('the sender sees a price before sending', est.ok && Number(est.json?.data?.totalFee) > 0, `→ ${brief(est)} totalFee=${est.json?.data?.totalFee}`);
    ctx.stash['COUR-01'] = {
      main: await createCourier(rec, ctx, 'SMALL', 'send'),
      spare: await createCourier(rec, ctx, 'SMALL', 'cancel-before-custody'),
    };
  },
  async release(rec, ctx) {
    const { main, spare } = ctx.stash['COUR-01'] ?? {};
    rec.require('courier jobs exist', !!main && !!spare, '');
    await waitReleased(ctx, main.id);
    // recovery before custody: the sender cancels the spare job
    const cancel = await POST(`/courier/order/${spare.id}/cancel`, { reason: 'journey: sent by mistake' }, ctx.roster.customers.C8!.session.token);
    rec.expect('the sender cancels a job before pickup', cancel, 200);
    const got = await pollOffer(ctx, main.id, onlineOf(ctx, 'rider'), 60_000);
    rec.require('a rider is offered the courier job', !!got, got ? got.moverId : 'no offer within 60 s of release');
    const r = mover(ctx, got!.moverId);
    const acc = await POST('/rider/offers/accept', { orderId: main.id, offerAttemptId: got!.offer.offerAttemptId }, r.session.token);
    rec.expect(`${got!.moverId} accepts the courier job`, acc, 200);
    ctx.stash['COUR-01'].rider = got!.moverId;
  },
  async run(rec, ctx) {
    const { main, rider } = ctx.stash['COUR-01'] ?? {};
    rec.require('a rider holds the job', !!rider, '');
    const r = mover(ctx, rider);
    const C8 = ctx.roster.customers.C8!.session;
    rec.deny('another customer cannot read the job', await GET(`/courier/order/${main.id}`, ctx.roster.customers.C2!.session.token), [404]);
    rec.deny('collect before reaching the pickup', await POST(`/courier/order/${main.id}/collect`, { outcome: 'paid', gps: PICK }, r.session.token), [409], ['NOT_AT_PICKUP']);
    rec.expect('en route to pickup', await PUT(`/rider/orders/${main.id}/en-route-pickup`, {}, r.session.token), 200);
    rec.expect('arrived at pickup', await PUT(`/rider/orders/${main.id}/arrived-pickup`, {}, r.session.token), 200);
    rec.expect('the sender pays the fee in cash (collect, GPS)', await POST(`/courier/order/${main.id}/collect`, { outcome: 'paid', gps: PICK }, r.session.token), 200);
    rec.deny('collecting twice', await POST(`/courier/order/${main.id}/collect`, { outcome: 'paid', gps: PICK }, r.session.token), [409], ['ALREADY_COLLECTED']);
    rec.expect('parcel picked up', await PUT(`/rider/orders/${main.id}/picked-up`, {}, r.session.token), 200);
    rec.deny('the sender cannot cancel once the rider holds the parcel', await POST(`/courier/order/${main.id}/cancel`, {}, C8.token), [409], ['PARCEL_IN_CUSTODY']);
    rec.check('pickup photo custody proof (E16)', false, 'no route records a pickup photo: only POST /courier/order/:id/proof-photo at drop-off exists (E16 open)');
    rec.expect('en route to drop-off', await PUT(`/rider/orders/${main.id}/en-route-delivery`, {}, r.session.token), 200);
    const pub = await req('GET', `/courier/track/${main.token}`, {});
    rec.check('public tracking (no sign-in) shows the parcel moving with the rider', pub.ok && !!pub.json?.data?.status && pub.json?.data?.rider?.currentLat != null,
      `→ ${brief(pub)} status=${pub.json?.data?.status} riderLocation=${pub.json?.data?.rider?.currentLat != null ? 'shown' : 'hidden'}`);
    rec.deny('a forged tracking token', await req('GET', '/courier/track/not-a-real-token-000000', {}), [404]);
    rec.expect('arrived at drop-off', await PUT(`/rider/orders/${main.id}/arrived`, {}, r.session.token), 200);
    rec.deny('proof with a photo the server never issued', await POST(`/courier/order/${main.id}/proof`, { proofPhotoUrl: '/uploads/proof/forged.png' }, r.session.token), [400], ['PROOF_NOT_ISSUED']);
    const photo = await upload(`/courier/order/${main.id}/proof-photo`, r.session.token, { name: 'proof.png', type: 'image/png', bytes: uniquePng(`${ctx.runId}-proof`) });
    rec.expect('drop-off proof photo uploaded', photo, [200, 201]);
    const proof = await POST(`/courier/order/${main.id}/proof`, { proofPhotoUrl: photo.json?.data?.url }, r.session.token);
    rec.expect('proof of delivery closes the job', proof, 200);
    const done = (await GET(`/courier/order/${main.id}`, C8.token)).json?.data;
    rec.check('the sender sees DELIVERED', done?.status === 'DELIVERED', `status=${done?.status}`);
    const after = await req('GET', `/courier/track/${main.token}`, {});
    rec.check('public tracking stops showing the rider after delivery', after.ok && after.json?.data?.rider?.currentLat == null, `status=${after.json?.data?.status}`);
    // Note (E17): return-to-sender after custody is manual support; the in-app refusal (409 PARCEL_IN_CUSTODY) is proven above.
    void FIXTURE_PNG; void waitFor; void codeOf;
  },
};

export const COUR_02: Journey<Ctx> = {
  id: 'COUR-02',
  title: 'Courier deny: wrong vehicle/service',
  cases: 'wrong service/vehicle denial; correct mover accepts',
  async prepare(rec, ctx) {
    ctx.stash['COUR-02'] = { big: await createCourier(rec, ctx, 'LARGE', 'large parcel') };
  },
  async release(rec, ctx) {
    const { big } = ctx.stash['COUR-02'] ?? {};
    rec.require('a large-parcel job exists', !!big, '');
    await waitReleased(ctx, big.id);
    const riders = onlineOf(ctx, 'rider');
    const bike = riders.find((id) => mover(ctx, id).vehicleType === 'BICYCLE');
    if (bike) {
      const tooSmall = await POST(`/rider/orders/${big.id}/accept`, {}, mover(ctx, bike).session.token);
      rec.deny('a bicycle cannot take a large parcel', tooSmall, [400], ['VEHICLE_TOO_SMALL']);
    } else {
      rec.check('a bicycle rider is online for the vehicle case', false, ctx.world.notReady.DR4 ?? 'DR4 not online');
    }
    const moto = riders.filter((id) => mover(ctx, id).vehicleType === 'MOTORCYCLE');
    const deliveryOnly = moto[moto.length - 1];
    if (deliveryOnly) {
      const d = mover(ctx, deliveryOnly);
      rec.expect(`${deliveryOnly} switches to food delivery only`, await PUT('/rider/profile', { riderType: 'DELIVERY' }, d.session.token), 200);
      rec.deny('a food-delivery-only rider cannot take a courier job', await POST(`/rider/orders/${big.id}/accept`, {}, d.session.token), [400], ['WRONG_SERVICE_TYPE']);
      await PUT('/rider/profile', { riderType: 'BOTH' }, d.session.token);
    }
    const got = await pollOffer(ctx, big.id, moto, 60_000);
    let taken: string | null = null;
    if (got) {
      const acc = await POST('/rider/offers/accept', { orderId: big.id, offerAttemptId: got.offer.offerAttemptId }, mover(ctx, got.moverId).session.token);
      if (acc.ok) taken = got.moverId;
    }
    if (!taken) {
      for (const id of moto) {
        if ((await POST(`/rider/orders/${big.id}/accept`, {}, mover(ctx, id).session.token)).ok) { taken = id; break; }
      }
    }
    rec.check('a motorcycle courier rider takes the large parcel', !!taken, `taken by ${taken ?? 'nobody'}`);
    ctx.stash['COUR-02'].rider = taken;
  },
  async run(rec, ctx) {
    const { big, rider } = ctx.stash['COUR-02'] ?? {};
    if (!rider) return;
    const job = (await GET(`/courier/order/${big.id}`, ctx.roster.customers.C8!.session.token)).json?.data;
    rec.check('the sender sees the assignment', job?.status === 'RIDER_ASSIGNED', `status=${job?.status}`);
    const cancel = await POST(`/courier/order/${big.id}/cancel`, { reason: 'journey cleanup before pickup' }, ctx.roster.customers.C8!.session.token);
    rec.expect('the sender cancels before pickup (cleanup)', cancel, 200);
  },
};

export const COURIER_JOURNEYS = [COUR_01, COUR_02];
