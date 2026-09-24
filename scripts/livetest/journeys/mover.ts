// Delivery-mover journeys [TASK-057]: RIDE-01..04. Movers are online through
// their real endpoints (provision.ts) and the suite heartbeat keeps their
// positions fresh; each journey leaves every rider free and online again.

import { FIXTURE_PNG, upload, type Session } from '../client.js';
import type { Journey, Recorder } from '../journey.js';
import { GET, POST, PUT, req, sleep, codeOf, brief, pick, waitFor, customerOrder, placeOrder, orderIdsOf, ensureAddress, idemKey } from './common.js';
import type { Ctx } from './context.js';
import { mover, onlineOf, setOnline, pollOffer, placeExpress, riderToDoor, handoverPaid, doorPin, storeAccepts, storeReadies, freeRider } from './dispatch.js';
import { registerFresh } from './auth.js';
import { uniquePng } from '../roster.js';

const riders = (ctx: Ctx) => onlineOf(ctx, 'rider');

/** Express order at R1, accepted by the store, offered to a rider who takes it. */
async function assignedExpress(rec: Recorder, ctx: Ctx, customerId: string, label: string, itemKey = 'R1', qty = 1): Promise<{ orderId: string; riderId: string } | null> {
  const placed = await placeExpress(ctx, customerId, 'R1', itemKey, label, qty);
  if (!rec.expect(`${label}: express cash delivery checkout`, placed.res, [200, 201])) return null;
  const orderId = placed.id!;
  if (!rec.expect(`${label}: the store accepts`, await storeAccepts(ctx, 'R1', orderId), 200)) return null;
  const got = await pollOffer(ctx, orderId, riders(ctx));
  if (!rec.check(`${label}: an online rider is offered the job`, !!got, got ? `${got.moverId} holds attempt ${got.offer.offerAttemptId}` : 'no offer within 45 s')) return null;
  const m = mover(ctx, got!.moverId);
  const acc = await POST('/rider/offers/accept', { orderId, offerAttemptId: got!.offer.offerAttemptId }, m.session.token);
  if (!rec.expect(`${label}: ${got!.moverId} accepts the offer`, acc, 200)) return null;
  return { orderId, riderId: got!.moverId };
}

async function freshCustomer(ctx: Ctx, slot: string, lat: number, lng: number): Promise<Session | null> {
  const acct = await registerFresh(ctx, slot);
  if (!acct) return null;
  await upload('/auth/selfie', acct.session.token, { name: 's.png', type: 'image/png', bytes: uniquePng(slot) });
  await ensureAddress(acct.session, lat, lng);
  return acct.session;
}

export const RIDE_01: Journey<Ctx> = {
  id: 'RIDE-01',
  estimateSeconds: 240,
  title: 'Go online + live location',
  cases: 'go online; location freshness; background pause/restart; stale GPS denial',
  async run(rec, ctx) {
    const online = riders(ctx);
    rec.require('riders are online after provisioning', online.length >= 1, `online=${online.join(',') || 'none'}; notReady=${JSON.stringify(ctx.world.notReady)}`);
    const probe = online.includes('DR3') ? 'DR3' : online[0]!;
    const m = mover(ctx, probe);

    rec.deny('a customer cannot go online as a rider', await POST('/rider/go-online', { latitude: 6.81, longitude: -58.15 }, ctx.roster.customers.C2!.session.token), [403, 404]);
    rec.deny('go-online without a position', await POST('/rider/go-online', {}, m.session.token), [400], ['VALIDATION_ERROR']);
    const on = await POST('/rider/go-online', { latitude: m.lat, longitude: m.lng }, m.session.token);
    rec.expect(`${probe} goes online`, on, 200, undefined, `isOnline=${on.json?.data?.isOnline}`);
    const p1 = (await GET('/rider/profile', m.session.token)).json?.data;
    rec.check('the profile reads online with a fresh position', p1?.isOnline === true && Date.now() - Date.parse(p1?.lastLocationUpdate ?? 0) < 120_000,
      `isOnline=${p1?.isOnline} lastLocationUpdate=${p1?.lastLocationUpdate}`);

    // location freshness: a new position is persisted (one write per 10 s per mover)
    await sleep(11_000);
    const moved = { lat: m.lat + 0.0012, lng: m.lng - 0.0009 };
    const loc = await PUT('/rider/location', { latitude: moved.lat, longitude: moved.lng, accuracy: 6 }, m.session.token);
    rec.expect('a location report is accepted', loc, 200);
    const p2 = (await GET('/rider/profile', m.session.token)).json?.data;
    rec.check('the new position is stored', Math.abs(Number(p2?.currentLat) - moved.lat) < 1e-6 && Math.abs(Number(p2?.currentLng) - moved.lng) < 1e-6,
      `current=${p2?.currentLat},${p2?.currentLng} sent=${moved.lat},${moved.lng}`);
    await sleep(11_000);
    await PUT('/rider/location', { latitude: m.lat, longitude: m.lng, accuracy: 6 }, m.session.token);

    // stale GPS denial: with only this rider online and its app paused past 90 s, it is not supply.
    const others = online.filter((id) => id !== probe);
    for (const id of others) await setOnline(ctx, id, false);
    ctx.stash.heartbeatOverrides[probe] = null;
    const R1 = ctx.roster.vendors.R1!, item = ctx.world.items.R1!;
    const C5 = ctx.roster.customers.C5!;
    try {
      await sleep(100_000);
      const stale = await placeOrder(C5.session, R1.vendorId!, item.itemId, C5.lat, C5.lng, { key: idemKey(ctx.runId, 'ride01-stale') });
      rec.deny('delivery checkout while the only rider’s position is >90 s old', stale, [409], ['DELIVERY_NO_RIDERS']);
      for (const id of orderIdsOf(stale)) await POST(`/customer/orders/${id}/cancel`, { reason: 'journey cleanup' }, C5.session.token);

      // restart: the app resumes reporting and the rider counts again
      const resume = await PUT('/rider/location', { latitude: m.lat, longitude: m.lng, accuracy: 6 }, m.session.token);
      rec.expect('after the pause, the next location report is accepted', resume, 200);
      const fresh = await placeOrder(C5.session, R1.vendorId!, item.itemId, C5.lat, C5.lng, { key: idemKey(ctx.runId, 'ride01-fresh') });
      rec.expect('delivery checkout succeeds once the position is fresh again', fresh, [200, 201]);
      for (const id of orderIdsOf(fresh)) await POST(`/customer/orders/${id}/cancel`, { reason: 'journey cleanup' }, C5.session.token);
    } finally {
      ctx.stash.heartbeatOverrides[probe] = undefined;
      for (const id of others) await setOnline(ctx, id, true);
    }

    // offline: positions are refused as OFFLINE; back online restores supply
    const off = await POST('/rider/go-offline', {}, m.session.token);
    rec.expect(`${probe} goes offline`, off, 200);
    const late = await PUT('/rider/location', { latitude: m.lat, longitude: m.lng }, m.session.token);
    rec.check('an offline rider’s position is not taken', late.json?.data?.accepted === false && late.json?.data?.reason === 'OFFLINE', `→ ${brief(late)} ${JSON.stringify(late.json?.data ?? null)}`);
    const back = await setOnline(ctx, probe, true);
    rec.expect(`${probe} back online`, back, 200);
    rec.deviceCase('OS-level background pause', 'backgrounding is a device property; the server side (a silent app ages out of supply after 90 s and counts again on its next report) was proven above');
  },
};

export const RIDE_02: Journey<Ctx> = {
  id: 'RIDE-02',
  estimateSeconds: 150,
  title: 'Offer accept / board grab (H-2)',
  cases: 'offer accept/board grab; two-rider race; old-attempt denial; reconnect recovery',
  async run(rec, ctx) {
    rec.require('at least two riders online', riders(ctx).length >= 2, `online=${riders(ctx).join(',')}`);
    const placed = await placeExpress(ctx, 'C1', 'R1', 'R1', 'ride02-offer');
    rec.expect('express cash delivery checkout (no hold)', placed.res, [200, 201]);
    const e1 = placed.id!;
    const o1 = await customerOrder(ctx.roster.customers.C1!.session, e1);
    rec.check('an express delivery is not held', !o1?.holdExpiresAt, `holdExpiresAt=${o1?.holdExpiresAt ?? null}`);
    rec.expect('the store accepts (dispatch starts on accept)', await storeAccepts(ctx, 'R1', e1), 200);
    const got = await pollOffer(ctx, e1, riders(ctx));
    rec.require('an online rider is offered the job', !!got, got ? `${got.moverId} attempt ${got.offer.offerAttemptId}` : 'no offer in 45 s');
    const holder = mover(ctx, got!.moverId);
    const attempt = String(got!.offer.offerAttemptId);

    // reconnect recovery: the same offer comes back on a fresh read
    const again = await GET('/rider/offers/current', holder.session.token);
    const reread = again.json?.data?.offer ?? again.json?.data;
    rec.check('a reconnecting rider reads the same live offer', reread?.orderId === e1 && String(reread?.offerAttemptId) === attempt, `offerAttemptId=${reread?.offerAttemptId}`);
    rec.expect('the offer card is marked seen', await POST('/rider/offers/seen', { orderId: e1, offerAttemptId: attempt }, holder.session.token), 200);

    const stale = await POST('/rider/offers/accept', { orderId: e1, offerAttemptId: `${attempt.split('~')[0]!.slice(0, 8)}-stale~fv0` }, holder.session.token);
    rec.deny('accepting an old attempt id', stale, [409], ['OFFER_EXPIRED']);
    const other = riders(ctx).find((id) => id !== got!.moverId)!;
    const theft = await POST('/rider/offers/accept', { orderId: e1, offerAttemptId: attempt }, mover(ctx, other).session.token);
    rec.deny('a rider who does not hold the offer', theft, [409], ['OFFER_EXPIRED']);
    const acc = await POST('/rider/offers/accept', { orderId: e1, offerAttemptId: attempt }, holder.session.token);
    rec.expect('the holder accepts', acc, 200, undefined, `status=${acc.json?.data?.status}`);
    const seen = await customerOrder(ctx.roster.customers.C1!.session, e1);
    rec.check('the customer sees the assignment and the rider', seen?.status === 'RIDER_ASSIGNED' && !!seen?.rider, `status=${seen?.status} rider=${seen?.rider?.firstName ?? 'none'}`);
    const active = await GET('/rider/orders/active-legs', holder.session.token);
    rec.check('the rider’s active legs include it', JSON.stringify(active.json?.data ?? null).includes(e1), `→ ${brief(active)}`);

    // board grab race between two free riders
    const free = riders(ctx).filter((id) => id !== got!.moverId).slice(0, 2);
    rec.require('two free riders for the race', free.length === 2, free.join(','));
    const p2 = await placeExpress(ctx, 'C2', 'R1', 'R1', 'ride02-race');
    rec.expect('second express checkout', p2.res, [200, 201]);
    const e2 = p2.id!;
    rec.expect('the store accepts it', await storeAccepts(ctx, 'R1', e2), 200);
    const board = await GET('/rider/orders/available', mover(ctx, free[0]!).session.token);
    rec.check('the job is on the board', JSON.stringify(board.json?.data ?? null).includes(e2), `→ ${brief(board)}`);
    const [a, b] = await Promise.all(free.map((id) => POST(`/rider/orders/${e2}/accept`, {}, mover(ctx, id).session.token)));
    const winners = [a!, b!].filter((r) => r.ok).length;
    rec.check('two riders grab at once: exactly one wins', winners === 1 && [a!, b!].some((r) => [409].includes(r.status)),
      `${free[0]} → ${brief(a!)}, ${free[1]} → ${brief(b!)}`);
    const o2 = await customerOrder(ctx.roster.customers.C2!.session, e2);
    rec.check('the order has exactly one rider', o2?.status === 'RIDER_ASSIGNED', `status=${o2?.status}`);

    // leave every rider free: deliver both
    for (const [oid, cust] of [[e1, 'C1'], [e2, 'C2']] as const) {
      await storeReadies(ctx, 'R1', oid);
      const who = oid === e1 ? got!.moverId : (a!.ok ? free[0]! : free[1]!);
      const w = mover(ctx, who);
      const door = await riderToDoor(w.session, oid);
      rec.expect(`${oid === e1 ? 'first' : 'raced'} order: rider reaches the door`, door, 200);
      const c = ctx.roster.customers[cust]!;
      rec.expect(`${oid === e1 ? 'first' : 'raced'} order: paid at the door`, await handoverPaid(w.session, oid, { lat: c.lat, lng: c.lng }, await doorPin(c.session, oid)), 200);
    }
    rec.deviceCase('two-phone latency race', 'the server-side race (one winner, one 409) is proven; the timing of two physical phones is the device gate');
  },
};

export const RIDE_03: Journey<Ctx> = {
  id: 'RIDE-03',
  estimateSeconds: 150,
  title: 'Cash float at pickup',
  cases: 'float commit; cap denial; assignment rollback/retry',
  async run(rec, ctx) {
    rec.require('the 4500 feast item and two riders', !!ctx.world.items['R1-feast'] && riders(ctx).length >= 2, '');
    const feast = ctx.world.items['R1-feast']!;
    // cap at checkout: no L1 rider (float 8000) can front 2 × 4500
    const big = await placeExpress(ctx, 'C4', 'R1', 'R1-feast', 'ride03-big', 2);
    rec.deny('a cash basket above every rider’s float is refused at checkout', big.res, [409], ['DELIVERY_NO_RIDERS'], `store price ${2 * feast.price} > L1 float 8000`);

    const first = await assignedExpress(rec, ctx, 'C4', 'ride03-f1', 'R1-feast');
    rec.require('a rider holds the first feast order', !!first, '');
    const a = mover(ctx, first!.riderId);
    const pa = (await GET('/rider/profile', a.session.token)).json?.data;
    rec.check('the float is committed at claim', Number(pa?.float?.committed ?? pa?.committedFloat) === feast.price,
      `float=${JSON.stringify(pa?.float ?? { committed: pa?.committedFloat, limit: pa?.floatLimit })}`);

    const second = await placeExpress(ctx, 'C6', 'R1', 'R1-feast', 'ride03-f2');
    rec.expect('a second feast order', second.res, [200, 201]);
    rec.expect('the store accepts it', await storeAccepts(ctx, 'R1', second.id!), 200);
    const denied = await POST(`/rider/orders/${second.id}/accept`, {}, a.session.token);
    rec.deny(`${first!.riderId} cannot take a second 4500 cash order on an 8000 float`, denied, [409], ['FLOAT_EXCEEDED']);
    const pa2 = (await GET('/rider/profile', a.session.token)).json?.data;
    rec.check('the refused claim committed nothing (rollback)', Number(pa2?.float?.committed ?? pa2?.committedFloat) === feast.price, `committed=${pa2?.float?.committed ?? pa2?.committedFloat}`);

    // retry: another rider with headroom takes it (offer or board)
    const offer = await pollOffer(ctx, second.id!, riders(ctx).filter((id) => id !== first!.riderId), 30_000);
    let bId: string | null = null;
    if (offer) {
      const r = await POST('/rider/offers/accept', { orderId: second.id, offerAttemptId: offer.offer.offerAttemptId }, mover(ctx, offer.moverId).session.token);
      if (r.ok) bId = offer.moverId;
    }
    if (!bId) {
      for (const id of riders(ctx).filter((x) => x !== first!.riderId)) {
        const r = await POST(`/rider/orders/${second.id}/accept`, {}, mover(ctx, id).session.token);
        if (r.ok) { bId = id; break; }
      }
    }
    rec.check('the retry by a rider with headroom succeeds', !!bId, `taken by ${bId ?? 'nobody'}`);

    // release: delivering frees the float
    for (const [oid, rid, cust] of [[first!.orderId, first!.riderId, 'C4'], [second.id!, bId, 'C6']] as const) {
      if (!rid) continue;
      await storeReadies(ctx, 'R1', oid);
      const w = mover(ctx, rid);
      await riderToDoor(w.session, oid);
      const c = ctx.roster.customers[cust]!;
      rec.expect(`${rid} delivers ${oid === first!.orderId ? 'the first' : 'the second'} feast order`, await handoverPaid(w.session, oid, { lat: c.lat, lng: c.lng }, await doorPin(c.session, oid)), 200);
    }
    const pa3 = (await GET('/rider/profile', a.session.token)).json?.data;
    rec.check('delivery releases the float', Number(pa3?.float?.committed ?? pa3?.committedFloat ?? 0) === 0, `committed=${pa3?.float?.committed ?? pa3?.committedFloat}`);
  },
};

export const RIDE_04: Journey<Ctx> = {
  id: 'RIDE-04',
  estimateSeconds: 200,
  title: 'Door handover: PIN + GPS + outcome (H-3)',
  cases: 'PIN and GPS handover; wrong/stale proof denial; cash refusal; delivery recovery',
  async run(rec, ctx) {
    rec.require('three riders online', riders(ctx).length >= 3, riders(ctx).join(','));

    // paid at the door, with the premature and foreign attempts refused
    const g1 = await assignedExpress(rec, ctx, 'C1', 'ride04-paid');
    rec.require('a rider holds the paid-case order', !!g1, '');
    const a = mover(ctx, g1!.riderId);
    const C1 = ctx.roster.customers.C1!;
    rec.deny('a handover before reaching the door', await POST(`/rider/orders/${g1!.orderId}/handover`, { outcome: 'paid', gps: { lat: C1.lat, lng: C1.lng } }, a.session.token), [409], ['NOT_AT_DOOR']);
    await storeReadies(ctx, 'R1', g1!.orderId);
    rec.expect('rider travels to the door (5 transitions)', await riderToDoor(a.session, g1!.orderId), 200);
    const otherId = riders(ctx).find((id) => id !== g1!.riderId)!;
    rec.deny('another rider cannot close this handover', await POST(`/rider/orders/${g1!.orderId}/handover`, { outcome: 'paid', gps: { lat: C1.lat, lng: C1.lng } }, mover(ctx, otherId).session.token), [403, 404], ['NOT_YOUR_ORDER', 'NOT_FOUND']);
    rec.deny('a handover without GPS proof', await POST(`/rider/orders/${g1!.orderId}/handover`, { outcome: 'paid' }, a.session.token), [400], ['VALIDATION_ERROR']);
    rec.deny('a no-show claimed the moment the rider arrives', await POST(`/rider/orders/${g1!.orderId}/handover`, { outcome: 'no_show', gps: { lat: C1.lat, lng: C1.lng } }, a.session.token), [409], ['NO_SHOW_TOO_EARLY']);
    rec.deny('cash orders cannot use the MMG completion path', await PUT(`/rider/orders/${g1!.orderId}/delivered`, {}, a.session.token), [409], ['PAYMENT_NOT_CAPTURED']);
    // [MKT-F057] The door PIN: the customer holds it while the goods are on
    // their way; the rider must be given it. Missing and wrong are refused
    // (a wrong try burns one of the five attempts).
    const pin = await doorPin(C1.session, g1!.orderId);
    rec.check('the customer holds a 6-digit door PIN while the goods are on their way', !!pin && /^\d{6}$/.test(pin), `pin ${pin ? 'present' : 'absent'}`);
    rec.deny('a paid handover without the customer’s PIN', await handoverPaid(a.session, g1!.orderId, { lat: C1.lat, lng: C1.lng }), [400], ['MISSING_PIN']);
    rec.deny('a paid handover with the wrong PIN', await handoverPaid(a.session, g1!.orderId, { lat: C1.lat, lng: C1.lng }, pin === '000000' ? '111111' : '000000'), [400], ['INVALID_PIN']);
    const paid = await handoverPaid(a.session, g1!.orderId, { lat: C1.lat, lng: C1.lng }, pin);
    rec.expect('cash paid at the door with GPS and the PIN', paid, 200, undefined, `status=${paid.json?.data?.status}`);
    const done = await customerOrder(C1.session, g1!.orderId);
    rec.check('the customer sees DELIVERED and a captured cash payment', done?.status === 'DELIVERED' && done?.paymentStatus === 'CAPTURED', `status=${done?.status} payment=${done?.paymentStatus}`);
    const replay = await handoverPaid(a.session, g1!.orderId, { lat: C1.lat, lng: C1.lng }, pin);
    const afterReplay = await customerOrder(C1.session, g1!.orderId);
    rec.check('a repeated handover answers the same facts and changes nothing', (replay.ok || [400, 409].includes(replay.status)) && afterReplay?.status === 'DELIVERED' && afterReplay?.paymentStatus === 'CAPTURED' && afterReplay?.deliveredAt === done?.deliveredAt,
      `→ ${brief(replay)} status=${afterReplay?.status} payment=${afterReplay?.paymentStatus} deliveredAt unchanged=${afterReplay?.deliveredAt === done?.deliveredAt}`);
    const earn = await GET('/rider/earnings/today', a.session.token);
    rec.check('the delivery fee is in the rider’s earnings', earn.ok && JSON.stringify(earn.json?.data ?? '').length > 2, `→ ${brief(earn)}`);

    // cash refusal (a fresh customer: a refusal strikes the account)
    const cust = await freshCustomer(ctx, 'ride04-refuser', C1.lat, C1.lng);
    rec.require('a fresh customer for the refusal case', !!cust, '');
    ctx.roster.customers['RX'] = { id: 'RX', phone: '', session: cust!, lat: C1.lat, lng: C1.lng };
    const g2 = await assignedExpress(rec, ctx, 'RX', 'ride04-refused');
    rec.require('a rider holds the refusal-case order', !!g2, '');
    const b = mover(ctx, g2!.riderId);
    await storeReadies(ctx, 'R1', g2!.orderId);
    rec.expect('rider reaches the door', await riderToDoor(b.session, g2!.orderId), 200);
    const refused = await POST(`/rider/orders/${g2!.orderId}/handover`, { outcome: 'refused', gps: { lat: C1.lat, lng: C1.lng } }, b.session.token);
    rec.expect('the customer refuses the cash handover', refused, 200, undefined, `status=${refused.json?.data?.status} claim=${JSON.stringify(refused.json?.data?.claim ?? null)}`);
    const failed = await customerOrder(cust!, g2!.orderId);
    rec.check('the order ends FAILED', failed?.status === 'FAILED', `status=${failed?.status}`);
    const claims = await GET('/rider/claims', b.session.token);
    rec.check('the rider’s guarantee claim is on record', JSON.stringify(claims.json?.data ?? null).includes(g2!.orderId), `→ ${brief(claims)}`);
    delete ctx.roster.customers['RX'];

    // delivery recovery: a hand-back before pickup re-dispatches to another rider
    const g3 = await assignedExpress(rec, ctx, 'C6', 'ride04-recovery');
    rec.require('a rider holds the recovery-case order', !!g3, '');
    const c = mover(ctx, g3!.riderId);
    rec.deny('a hand-back reason that is too short', await POST(`/rider/orders/${g3!.orderId}/handback`, { reason: 'x' }, c.session.token), [400], ['VALIDATION_ERROR']);
    const hb = await POST(`/rider/orders/${g3!.orderId}/handback`, { reason: 'bike trouble, cannot collect' }, c.session.token);
    rec.expect('the rider hands the job back before pickup', hb, 200, undefined, `status=${hb.json?.data?.status}`);
    const next = await pollOffer(ctx, g3!.orderId, riders(ctx).filter((id) => id !== g3!.riderId), 60_000);
    rec.check('the order is re-offered to another rider', !!next, next ? `${next.moverId} offered` : 'no re-offer in 60 s');
    if (next) {
      const d = mover(ctx, next.moverId);
      rec.expect('the new rider accepts', await POST('/rider/offers/accept', { orderId: g3!.orderId, offerAttemptId: next.offer.offerAttemptId }, d.session.token), 200);
      await storeReadies(ctx, 'R1', g3!.orderId);
      await riderToDoor(d.session, g3!.orderId);
      const C6 = ctx.roster.customers.C6!;
      rec.expect('the recovered order is delivered', await handoverPaid(d.session, g3!.orderId, { lat: C6.lat, lng: C6.lng }, await doorPin(C6.session, g3!.orderId)), 200);
      rec.check('the customer sees DELIVERED', (await customerOrder(C6.session, g3!.orderId))?.status === 'DELIVERED', '');
    }
    for (const id of riders(ctx)) await freeRider(ctx, id);
    rec.skipCase('MMG completion PIN', 'the door PIN on the MMG completion path (PUT /rider/orders/:id/delivered ridePin) needs an MMG order, which needs a vendor pay link and an SMS step-up this target cannot deliver; the CASH door PIN is proven above (missing, wrong, right)');
    rec.deviceCase('photo proof and two-phone custody', 'a physical camera photo and the two-phone PIN exchange are the device gate');
    void req; void sleep; void codeOf; void pick; void waitFor; void FIXTURE_PNG;
  },
};

export const MOVER_JOURNEYS = [RIDE_01, RIDE_02, RIDE_03, RIDE_04];
