// Administration journeys [TASK-057]: ADMIN-01..05. Consequential admin
// actions carry an x-swift-reason (ADM-006); money- and platform-class actions
// need a second admin (ADM-005, see admin-util.ts).

import type { Journey } from '../journey.js';
import { GET, POST, PUT, req, sleep, brief, pick, waitFor, placeOrder, orderIdsOf, customerOrder, idemKey, codeOf } from './common.js';
import type { Ctx } from './context.js';
import { asAdmin, submitDoc, approveDoc, vendorOf } from '../provision.js';
import { freshVendor } from './vendor.js';
import { twoPerson } from './admin-util.js';
import { mover, onlineOf, pollOffer, placeExpress, storeAccepts, freeRider, riderToDoor, handoverPaid, doorPin, storeReadies } from './dispatch.js';
import { registerFresh } from './auth.js';

const FORGED = 'cl0000000000000000000forged';

export const ADMIN_01: Journey<Ctx> = {
  id: 'ADMIN-01',
  estimateSeconds: 90,
  title: 'Partner doc review/approve/reject',
  cases: 'document review; recusal; two-person approval; wrong-role denial',
  async run(rec, ctx) {
    const v = await freshVendor(rec, ctx, 'admin01', 'SUPERMARKET');
    rec.require('a fresh store with documents to review', !!v, '');
    const st = (await GET('/verification/status?role=SUPERMARKET', v!.s.token)).json?.data;
    const ids: Record<string, string> = {};
    for (const t of (st?.missing ?? []) as string[]) {
      const d = await submitDoc(v!.s, 'SUPERMARKET', t, 'admin01');
      if (rec.expect(`the owner submits ${t}`, d.res, 201)) ids[t] = d.id!;
    }
    const types = Object.keys(ids);
    rec.require('documents to review', types.length >= 3, JSON.stringify(types));
    const queue = await GET('/admin/verification/queue?status=PENDING&role=operator&limit=50', ctx.admin.token);
    rec.check('the documents are in the operator review queue', Object.values(ids).every((id) => JSON.stringify(queue.json?.data ?? []).includes(id)), `→ ${brief(queue)}`);
    rec.expect('queue counts are readable', await GET('/admin/verification/queue/counts', ctx.admin.token), 200);
    rec.deny('a store owner cannot read the review queue', await GET('/admin/verification/queue', v!.s.token), [403]);

    // review one document: custody → claim → view → release
    const doc = ids[types[0]!]!;
    const custody = await GET(`/admin/verification/${doc}/custody`, ctx.admin.token);
    const caseId = pick(custody.json, 'data.review.0.caseId', 'data.caseId');
    rec.check('custody names the review case', custody.ok && !!caseId, `→ ${brief(custody)}`);
    if (caseId) {
      rec.expect('the reviewer claims the case', await asAdmin(ctx.admin.token, 'claim a synthetic review case', 'POST', `/admin/verification/cases/${caseId}/claim`), 200);
      rec.expect('and releases it', await asAdmin(ctx.admin.token, 'release a synthetic review case', 'POST', `/admin/verification/cases/${caseId}/release`), 200);
      rec.deny('releasing a case one does not hold', await asAdmin(ctx.admin.token, 'release again', 'POST', `/admin/verification/cases/${caseId}/release`), [409], ['NOT_CASE_HOLDER']);
    }
    const link = await GET(`/admin/verification/${doc}/document-url`, ctx.admin.token);
    const url = link.json?.data?.url as string | undefined;
    rec.check('the reviewer gets a short-lived signed view link', link.ok && !!url && Number(link.json?.data?.expiresInSeconds) <= 300, `expiresInSeconds=${link.json?.data?.expiresInSeconds}`);
    if (url) {
      const origin = process.env.LIVETEST_BASE_URL || 'http://localhost:3000';
      const view = await fetch(origin + url);
      const bytes = Buffer.from(await view.arrayBuffer());
      rec.check('the link renders the decrypted document', view.ok && bytes.subarray(0, 5).toString('latin1') === '%PDF-' && bytes.includes(Buffer.from('admin01')),
        `→ ${view.status} ${bytes.length} bytes`);
      const again = await fetch(origin + url);
      rec.step('view link reuse within its lifetime (E35)', true, `a second fetch → ${again.status}${again.ok ? ' — the link is replayable for its 5-minute life and no fetch acknowledgement exists (E35 open, S2)' : ''}`);
      const tampered = await fetch(origin + url.replace(/sig=[0-9a-f]{4}/, 'sig=0000'));
      rec.deny('a tampered view link', { status: tampered.status, ok: tampered.ok, json: null, text: '' }, [403, 410]);
    }
    rec.deny('a store owner cannot mint a view link', await GET(`/admin/verification/${doc}/document-url`, v!.s.token), [403]);
    rec.deny('a forged document id', await GET(`/admin/verification/${FORGED}/document-url`, ctx.admin.token), [404]);
    rec.deny('an approval with no reason (ADM-006)', await req('PUT', `/admin/verification/${doc}/approve`, { token: ctx.admin.token, body: {} }), [400], ['VALIDATION_ERROR']);

    // two-person: a fraud-class rejection needs a second reviewer
    const suspect = ids[types[1]!]!;
    const r1 = await asAdmin(ctx.admin.token, 'reject a synthetic document as suspected tampering', 'PUT', `/admin/verification/${suspect}/reject`, { reason: 'Edges look altered; suspected tampering on the scan.', reasonCode: 'SUSPECTED_TAMPERING' });
    rec.expect('a fraud-class rejection is recorded and sent to second review', r1, 200, undefined, `status=${r1.json?.data?.status} state=${r1.json?.data?.state}`);
    const r1b = await asAdmin(ctx.admin.token, 'confirm my own tampering rejection', 'PUT', `/admin/verification/${suspect}/reject`, { reason: 'Confirming my own tampering call.', reasonCode: 'SUSPECTED_TAMPERING' });
    rec.deny('the same reviewer cannot confirm it', r1b, [403], ['SECOND_REVIEWER_REQUIRED']);
    if (ctx.roster.admin2) {
      const r2 = await asAdmin(ctx.roster.admin2.token, 'second reviewer confirms the tampering rejection', 'PUT', `/admin/verification/${suspect}/reject`, { reason: 'Second review agrees: altered scan.', reasonCode: 'SUSPECTED_TAMPERING' });
      rec.expect('a second reviewer confirms the rejection', r2, 200, undefined, `status=${r2.json?.data?.status}`);
    } else {
      rec.skipCase('two-person approval (confirmation)', 'needs a second admin; none is provisioned on this target (LIVETEST_ADMIN2_PHONE unset) and no HTTP route creates one');
    }
    for (const t of types.slice(2)) rec.expect(`approve ${t}`, await approveDoc(ctx.admin, ids[t]!, t), 200);
    rec.skipCase('recusal', 'a reviewer is recused only from a case about themselves (or their identity cluster); staging that needs an admin to become a partner, which moves its active role to the partner role with no HTTP way back (switch-role has no admin role)');
  },
};

export const ADMIN_02: Journey<Ctx> = {
  id: 'ADMIN-02',
  estimateSeconds: 90,
  title: 'Held orders + retry dispatch + food-age hold',
  cases: 'held order; release; redispatch; rider accept; non-admin denial',
  async run(rec, ctx) {
    const held = await GET('/admin/orders/held', ctx.admin.token);
    rec.expect('the operator reads the held-orders board', held, 200, undefined, `${Array.isArray(held.json?.data) ? held.json.data.length : '?'} held`);
    rec.deny('a customer cannot read held orders', await GET('/admin/orders/held', ctx.roster.customers.C2!.session.token), [403]);
    rec.deny('release of an order that is not held', await asAdmin(ctx.admin.token, 'release a synthetic order that is not held', 'POST', `/admin/orders/${FORGED}/food-age-hold/release`, { decision: 'DELIVER_ANYWAY' }), [404, 409]);
    rec.deny('the close-and-refund release is not available yet', await asAdmin(ctx.admin.token, 'close store refunded on a synthetic order', 'POST', `/admin/orders/${FORGED}/food-age-hold/release`, { decision: 'CLOSE_STORE_REFUNDED' }), [409], ['NOT_AVAILABLE_YET']);

    // redispatch: the operator restarts the search, a rider accepts
    const placed = await placeExpress(ctx, 'C5', 'R1', 'R1', 'admin02');
    rec.expect('an express delivery', placed.res, [200, 201]);
    const id = placed.id!;
    rec.expect('the store accepts', await storeAccepts(ctx, 'R1', id), 200);
    rec.deny('a store cannot use the admin redispatch', await POST(`/admin/orders/${id}/retry-dispatch`, {}, ctx.roster.vendors.R1!.session.token), [403]);
    const retry = await asAdmin(ctx.admin.token, 'restart the rider search for a synthetic order', 'POST', `/admin/orders/${id}/retry-dispatch`);
    rec.expect('the operator restarts the search', retry, 200, undefined, JSON.stringify(retry.json?.data ?? null));
    const got = await pollOffer(ctx, id, onlineOf(ctx, 'rider'));
    rec.check('a rider is offered the job after the redispatch', !!got, got ? got.moverId : 'no offer');
    if (got) {
      const acc = await POST('/rider/offers/accept', { orderId: id, offerAttemptId: got.offer.offerAttemptId }, mover(ctx, got.moverId).session.token);
      rec.expect('the rider accepts', acc, 200);
      const live = await GET('/admin/ops/live', ctx.admin.token);
      rec.check('ops live shows the assignment', JSON.stringify(live.json?.data ?? null).includes(id), `→ ${brief(live)}`);
      await storeReadies(ctx, 'R1', id);
      await riderToDoor(mover(ctx, got.moverId).session, id);
      const C5 = ctx.roster.customers.C5!;
      await handoverPaid(mover(ctx, got.moverId).session, id, { lat: C5.lat, lng: C5.lng }, await doorPin(C5.session, id));
    }
    rec.skipAll('the defining case — a food-age hold and its release — cannot be produced here: a hold needs a platform-rider delivery paid by MMG (captured or claimed) whose ready time passes the 45-minute food-age limit, and MMG orders need a vendor pay link (SMS step-up). The redispatch and rider-accept parts above ran for real');
  },
};

export const ADMIN_03: Journey<Ctx> = {
  id: 'ADMIN-03',
  estimateSeconds: 60,
  title: 'Admin cancel / refund-settled',
  cases: 'cancel/refund obligation; duplicate refusal; reconciliation',
  async run(rec, ctx) {
    const C5 = ctx.roster.customers.C5!, OV1 = ctx.roster.vendors.OV1!, item = ctx.world.items.OV1;
    rec.require('OV1 orderable', !!item, '');
    const placed = await placeOrder(C5.session, OV1.vendorId!, item!.itemId, OV1.lat, OV1.lng, { pickup: true, key: idemKey(ctx.runId, 'admin03') });
    const id = orderIdsOf(placed)[0];
    rec.require('an order to cancel', !!id, brief(placed));
    rec.deny('a customer cannot use the admin cancel', await req('PUT', `/admin/orders/${id}/cancel`, { token: C5.session.token, body: { reason: 'x' } }), [403]);
    rec.deny('an admin cancel without a stated reason (ADM-006)', await req('PUT', `/admin/orders/${id}/cancel`, { token: ctx.admin.token, body: {} }), [400], ['VALIDATION_ERROR']);
    const cancel = await asAdmin(ctx.admin.token, 'cancel a synthetic order and record the refund owed', 'PUT', `/admin/orders/${id}/cancel`, { reason: 'Store could not fulfil (journey)', refund: true });
    rec.expect('the operator cancels and records a refund obligation', cancel, 200, undefined, `refundOwed=${cancel.json?.data?.refundOwed}`);
    const o = (await GET(`/admin/orders/${id}`, ctx.admin.token)).json?.data;
    rec.check('the obligation is on the order (amount = total)', Number(o?.refundOwedAmount) > 0 && Number(o?.refundOwedAmount) === Number(o?.totalAmount) && !!o?.refundOwedAt,
      `refundOwedAmount=${o?.refundOwedAmount} total=${o?.totalAmount} refundOwedAt=${o?.refundOwedAt}`);
    const cust = await customerOrder(C5.session, id!);
    rec.check('the customer sees the cancellation', cust?.status === 'CANCELLED', `status=${cust?.status}`);
    rec.deny('a second cancel of the same order', await asAdmin(ctx.admin.token, 'cancel the synthetic order again', 'PUT', `/admin/orders/${id}/cancel`, { reason: 'duplicate', refund: true }), [400], ['INVALID_STATUS']);

    const ref = `SYN${ctx.runId.replace(/[^A-Za-z0-9]/g, '').slice(-20)}`;
    const settle = await twoPerson(rec, ctx, 'settle the synthetic refund obligation', 'PUT', `/admin/orders/${id}/refund-settled`, { reference: ref, amount: Number(o?.refundOwedAmount) });
    if (settle.done) {
      const after = (await GET(`/admin/orders/${id}`, ctx.admin.token)).json?.data;
      rec.check('the refund reads settled (reconciliation)', !!after?.refundSettledAt, `refundSettledAt=${after?.refundSettledAt}`);
      const again = await twoPerson(rec, ctx, 'settle the same obligation again', 'PUT', `/admin/orders/${id}/refund-settled`, { reference: ref, amount: Number(o?.refundOwedAmount) }, [400, 409]);
      rec.check('a second settlement is refused', !!again.final && !again.final.ok && ['ALREADY_SETTLED', 'REFUND_REF_ALREADY_USED', 'NO_REFUND_DUE'].includes(codeOf(again.final)), `→ ${brief(again.final ?? again.first)}`);
    }
    rec.expect('finance revenue is readable', await GET('/admin/finance/revenue', ctx.admin.token), 200);
  },
};

export const ADMIN_04: Journey<Ctx> = {
  id: 'ADMIN-04',
  estimateSeconds: 60,
  title: 'Finance: settlements, payment-mix, revenue',
  cases: 'staged import; process; duplicate; rollback/recovery',
  async run(rec, ctx) {
    const R1 = ctx.roster.vendors.R1!;
    rec.expect('the settlement digests are readable', await GET('/admin/finance/settlements', ctx.admin.token), 200);
    rec.expect('payment mix is readable', await GET('/admin/finance/payment-mix', ctx.admin.token), 200);
    rec.deny('a store cannot import settlement files', await POST('/admin/billing/settlement-import', { csv: 'x'.repeat(20) }, R1.session.token), [403]);
    const sub = (await GET('/vendor/subscription', R1.session.token)).json?.data;
    const san = String(sub?.san ?? '');
    const now = new Date().toISOString();
    // A reference of this journey's own: a provider transaction id that matches another channel's
    // receipt (MONEY-03 records SYN-<run>) is refused as PROVIDER_ID_CONFLICT, by design.
    const tx = `SYN-A04-${ctx.runId}`.slice(0, 60);
    const good = `transaction_id,account_number,amount,paid_at\n${tx},${san},1500,${now}\nTOTAL,1500\n`;
    const bad = `transaction_id,account_number,amount,paid_at\n${tx}-bad,${san},1500,${now}\nTOTAL,9999\n`;
    const before = Number(sub?.walletBalanceGyd ?? 0);
    const rej = await twoPerson(rec, ctx, 'import a synthetic settlement file whose total is wrong', 'POST', '/admin/billing/settlement-import', { csv: bad, source: `journey-${ctx.runId}-bad` });
    if (rej.done) rec.check('a file whose control total disagrees is rejected whole (nothing credited)', rej.final?.json?.data?.status === 'REJECTED' && Number(rej.final?.json?.data?.credited ?? 0) === 0, JSON.stringify(rej.final?.json?.data ?? null).slice(0, 200));
    const imp = await twoPerson(rec, ctx, 'import a synthetic settlement file', 'POST', '/admin/billing/settlement-import', { csv: good, source: `journey-${ctx.runId}` });
    if (imp.done) {
      rec.check('the corrected file is staged and published (recovery)', ['PUBLISHED', 'STAGED'].includes(imp.final?.json?.data?.status) && Number(imp.final?.json?.data?.credited ?? 0) === 1, JSON.stringify(imp.final?.json?.data ?? null).slice(0, 200));
      const dup = await twoPerson(rec, ctx, 'import the same synthetic settlement file again', 'POST', '/admin/billing/settlement-import', { csv: good, source: `journey-${ctx.runId}` });
      rec.check('the same file again is a replay, not a second credit', dup.final?.json?.data?.replayed === true || dup.final?.json?.data?.status === 'REPLAYED', JSON.stringify(dup.final?.json?.data ?? null).slice(0, 200));
      const after = Number((await GET('/vendor/subscription', R1.session.token)).json?.data?.walletBalanceGyd ?? 0);
      rec.check('the store’s fee wallet moved by exactly one credit', after === before + 1500, `wallet ${before} → ${after}`);
    }
    if (!ctx.roster.admin2) rec.skipAll('staged import, duplicate replay and rejected-file recovery are two-person actions (ADM-005): the request is held (202, proven above) until a second admin approves, and this target has one admin (LIVETEST_ADMIN2_PHONE unset; no HTTP route creates one)');
    rec.skipCase('process a weekly settlement digest', 'digests are written only by the Sunday 00:00 job for stores with COMPLETED orders in a finished week; a run cannot produce one');
    void sleep; void waitFor;
  },
};

export const ADMIN_05: Journey<Ctx> = {
  id: 'ADMIN-05',
  estimateSeconds: 120,
  title: 'Suspend / ban / feature',
  cases: 'suspend/ban; active-job denial; revocation; reinstatement',
  async run(rec, ctx) {
    // suspend a customer: their token dies at once; unsuspend restores it
    const target = await registerFresh(ctx, 'admin05-suspend');
    rec.require('a fresh account to suspend', !!target, '');
    const uid = target!.user?.id ?? target!.session.userId;
    rec.deny('a customer cannot suspend anyone', await req('PUT', `/admin/users/${uid}/suspend`, { token: ctx.roster.customers.C2!.session.token, body: {} }), [403]);
    rec.expect('the operator suspends the account', await asAdmin(ctx.admin.token, 'suspend a synthetic account for the journey', 'PUT', `/admin/users/${uid}/suspend`, { reason: 'Journey: suspension drill' }), 200);
    rec.deny('the suspended account’s token is refused at once', await req('GET', '/auth/me', { token: target!.session.token, refresh: false }), [401]);
    rec.deny('its refresh is refused too', await req('POST', '/auth/refresh', { body: { refreshToken: target!.session.refreshToken }, refresh: false }), [401, 403]);
    rec.deny('suspending twice', await asAdmin(ctx.admin.token, 'suspend again', 'PUT', `/admin/users/${uid}/suspend`, {}), [400], ['ALREADY_SUSPENDED']);
    rec.expect('the operator reinstates it', await asAdmin(ctx.admin.token, 'reinstate the synthetic account', 'PUT', `/admin/users/${uid}/unsuspend`, {}), 200);
    rec.expect('the same token works again', await req('GET', '/auth/me', { token: target!.session.token, refresh: false }), 200);

    // ban: sessions deleted, no unban
    rec.expect('the operator bans it', await asAdmin(ctx.admin.token, 'ban the synthetic account for the journey', 'PUT', `/admin/users/${uid}/ban`, { reason: 'Journey: ban drill' }), 200);
    rec.deny('a banned account’s token is refused', await req('GET', '/auth/me', { token: target!.session.token, refresh: false }), [401]);
    rec.deny('a ban is not undone by unsuspend', await asAdmin(ctx.admin.token, 'unsuspend a banned account', 'PUT', `/admin/users/${uid}/unsuspend`, {}), [400], ['NOT_SUSPENDED']);
    const u = (await GET(`/admin/users/${uid}`, ctx.admin.token)).json?.data;
    rec.check('the user reads BANNED', (u?.status ?? u?.user?.status) === 'BANNED', `status=${u?.status ?? u?.user?.status}`);

    // active-job denial: a rider holding a delivery cannot be suspended
    const placed = await placeExpress(ctx, 'C4', 'R1', 'R1', 'admin05-job');
    if (rec.expect('an express delivery for the active-job case', placed.res, [200, 201]) && placed.id) {
      await storeAccepts(ctx, 'R1', placed.id);
      const got = await pollOffer(ctx, placed.id, onlineOf(ctx, 'rider'));
      if (got && (await POST('/rider/offers/accept', { orderId: placed.id, offerAttemptId: got.offer.offerAttemptId }, mover(ctx, got.moverId).session.token)).ok) {
        const riderUser = mover(ctx, got.moverId).session.userId;
        rec.deny('a rider holding a job cannot be suspended', await asAdmin(ctx.admin.token, 'suspend a rider who holds a live job', 'PUT', `/admin/users/${riderUser}/suspend`, {}), [409], ['ACTIVE_JOB']);
        await freeRider(ctx, got.moverId);
      } else {
        rec.check('a rider takes the job for the active-job case', false, got ? 'accept failed' : 'no offer');
      }
    }

    // a store: suspend blocks it, featuring toggles, approval reinstates
    const R3 = ctx.roster.vendors.R3!, item = ctx.world.items.R3;
    if (R3.vendorId && item) {
      rec.expect('the operator features the store', await asAdmin(ctx.admin.token, 'feature a synthetic store', 'PUT', `/admin/vendors/${R3.vendorId}/feature`, { featured: true }), 200);
      rec.expect('and un-features it', await asAdmin(ctx.admin.token, 'unfeature a synthetic store', 'PUT', `/admin/vendors/${R3.vendorId}/feature`, { featured: false }), 200);
      rec.expect('the operator suspends the store', await asAdmin(ctx.admin.token, 'suspend a synthetic store', 'PUT', `/admin/vendors/${R3.vendorId}/suspend`, { reason: 'Journey: store suspension drill' }), 200);
      const C6 = ctx.roster.customers.C6!;
      const blocked = await placeOrder(C6.session, R3.vendorId, item.itemId, R3.lat, R3.lng, { pickup: true });
      rec.deny('customers cannot order from a suspended store', blocked, [400], ['VENDOR_UNAVAILABLE', 'VENDOR_CLOSED']);
      // A suspension leaves the doors flag as it was: closing is always allowed, OPENING needs an ACTIVE store.
      let flip = await req('PUT', '/vendor/vendor/toggle-open', { token: R3.session.token, body: {} });
      if (flip.ok && flip.json?.data?.isCurrentlyOpen === false) {
        rec.step('a suspended store may still close its doors (closing is always allowed)', true, `→ ${brief(flip)} isCurrentlyOpen=false`);
        flip = await req('PUT', '/vendor/vendor/toggle-open', { token: R3.session.token, body: {} });
      }
      rec.deny('the suspended store cannot reopen itself', flip, [403, 409], ['VENDOR_SUSPENDED', 'VENDOR_NOT_ACTIVE']);
      rec.expect('the operator reinstates the store', await asAdmin(ctx.admin.token, 'reinstate a synthetic store', 'PUT', `/admin/vendors/${R3.vendorId}/approve`), 200);
      const p = vendorOf((await GET('/vendor/profile', R3.session.token)).json, R3.vendorId);
      rec.check('the store is ACTIVE again', p?.status === 'ACTIVE', `status=${p?.status}`);
      // restore open + accepting for the next run
      const t = R3.session.token;
      for (const [path, field] of [['/vendor/vendor/toggle-open', 'isCurrentlyOpen'], ['/vendor/vendor/toggle-orders', 'acceptingOrders']] as const) {
        let r = await PUT(path, {}, t);
        if (r.json?.data?.[field] === false) r = await PUT(path, {}, t);
      }
      const ok = await placeOrder(C6.session, R3.vendorId, item.itemId, R3.lat, R3.lng, { pickup: true, key: idemKey(ctx.runId, 'admin05-after') });
      rec.expect('customers can order again after reinstatement', ok, [200, 201]);
      for (const oid of orderIdsOf(ok)) await POST(`/customer/orders/${oid}/cancel`, { reason: 'journey cleanup' }, C6.session.token);
    } else {
      rec.check('R3 provisioned for the store case', false, ctx.world.notReady.R3 ?? '');
    }
  },
};

export const ADMIN_JOURNEYS = [ADMIN_01, ADMIN_02, ADMIN_03, ADMIN_04, ADMIN_05];
