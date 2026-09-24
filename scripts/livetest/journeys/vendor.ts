// Vendor journeys [TASK-057]: VEND-01..05.

import type { Session } from '../client.js';
import type { Journey, Recorder } from '../journey.js';
import { GET, POST, PUT, DEL, req, sleep, brief, pick, waitFor, codeOf, placeOrder, orderIdsOf, customerOrder, waitForRelease, clearCart, idemKey, notificationsOf } from './common.js';
import type { Ctx } from './context.js';
import { registerFresh } from './auth.js';
import { submitDoc, approveDoc, asAdmin } from '../provision.js';
import { vendorAdvance } from './customer.js';
import { mover, onlineOf, pollOffer, placeExpress, storeAccepts, freeRider } from './dispatch.js';
import { BUSINESS_PHONE } from '../roster.js';

const VENDOR_BUSINESS = (name: string, type: string, lat: number, lng: number) => ({
  name, vendorType: type, phone: BUSINESS_PHONE, addressLine1: `1 ${name} Street`, city: 'Georgetown', region: 'Demerara-Mahaica', latitude: lat, longitude: lng,
});

/** A brand-new vendor owner with a store in PENDING_APPROVAL. */
export async function freshVendor(rec: Recorder, ctx: Ctx, slot: string, type: 'STORE' | 'SUPERMARKET'): Promise<{ s: Session; vendorId: string } | null> {
  const acct = await registerFresh(ctx, slot, 'VENDOR');
  if (!rec.check(`${slot}: a fresh vendor owner signs up`, !!acct, acct ? acct.phone : 'signup failed')) return null;
  const s = acct!.session;
  const noAgreement = await POST('/partner/become', { role: 'VENDOR', business: VENDOR_BUSINESS(`TEST-${slot}`, type, 6.8150, -58.1500) }, s.token);
  rec.deny(`${slot}: becoming a vendor without accepting the agreement`, noAgreement, [400], ['AGREEMENT_REQUIRED']);
  const become = await POST('/partner/become', { role: 'VENDOR', acceptAgreement: true, business: VENDOR_BUSINESS(`TEST-${slot}`, type, 6.8150, -58.1500) }, s.token);
  if (!rec.expect(`${slot}: the store is created`, become, [200, 201], undefined, `id=${become.json?.data?.id}`)) return null;
  return { s, vendorId: become.json.data.id };
}

export const VEND_01: Journey<Ctx> = {
  id: 'VEND-01',
  estimateSeconds: 90,
  title: 'Partner onboarding → docs → approval',
  cases: 'join; docs; approval/rejection; missing agreement and wrong-role denial',
  async run(rec, ctx) {
    const v = await freshVendor(rec, ctx, 'vend01', 'STORE');
    rec.require('a fresh store', !!v, '');
    const { s, vendorId } = v!;
    const p0 = (await GET('/vendor/profile', s.token)).json?.data;
    rec.check('the new store waits for approval, closed', p0?.status === 'PENDING_APPROVAL' && p0?.isCurrentlyOpen === false, `status=${p0?.status} open=${p0?.isCurrentlyOpen}`);
    const cat = await POST('/vendor/categories', { name: 'Menu', sortOrder: 0 }, s.token);
    rec.deny('listing an item before verification', await POST('/vendor/items', { categoryId: cat.json?.data?.id ?? 'x', name: 'Too early', basePrice: 100 }, s.token), [403], ['VERIFICATION_REQUIRED']);
    rec.deny('opening a store that is not active', await PUT('/vendor/vendor/toggle-open', {}, s.token), [409], ['VENDOR_NOT_ACTIVE']);
    rec.deny('a customer cannot use the vendor surface', await POST('/vendor/categories', { name: 'x' }, ctx.roster.customers.C2!.session.token), [403]);
    rec.deny('the new owner cannot approve itself', await asAdmin(s.token, 'self approval attempt', 'PUT', `/admin/vendors/${vendorId}/approve`), [403]);

    const st = (await GET('/verification/status?role=STORE', s.token)).json?.data;
    const missing: string[] = st?.missing ?? [];
    rec.check('the STORE checklist is published to the owner', missing.length >= 3, `missing=${JSON.stringify(missing)}`);
    rec.deny('a document type not on the checklist', (await submitDoc(s, 'STORE', 'gra_restaurant_licence', 'vend01-wrong')).res, [400], ['INVALID_DOC_TYPE']);
    const ids: Record<string, string> = {};
    for (const t of missing) {
      const d = await submitDoc(s, 'STORE', t, 'vend01');
      if (rec.expect(`submit ${t}`, d.res, 201)) ids[t] = d.id!;
    }
    // rejection, then a corrected resubmission
    const first = missing[0]!;
    const rej = await asAdmin(ctx.admin.token, `reject the synthetic ${first}: the scan is illegible`, 'PUT', `/admin/verification/${ids[first]}/reject`, { reason: 'The scan is illegible; please upload a clear copy.' });
    rec.expect(`the reviewer rejects ${first}`, rej, 200);
    const st2 = (await GET('/verification/status?role=STORE', s.token)).json?.data;
    rec.check('the owner sees the rejection and the document missing again', (st2?.missing ?? []).includes(first), `missing=${JSON.stringify(st2?.missing)}`);
    const re = await submitDoc(s, 'STORE', first, 'vend01-retry');
    rec.expect(`resubmit ${first}`, re.res, 201);
    ids[first] = re.id!;
    for (const t of missing) {
      const a = await approveDoc(ctx.admin, ids[t]!, t);
      rec.expect(`the reviewer approves ${t}`, a, 200);
    }
    const p1 = (await GET('/vendor/profile', s.token)).json?.data;
    rec.check('approving the last document activates the store', p1?.status === 'ACTIVE' && p1?.isVerified === true, `status=${p1?.status} isVerified=${p1?.isVerified}`);
    const sub = (await GET('/vendor/subscription', s.token)).json?.data;
    rec.check('activation starts the 14-day trial', sub?.status === 'TRIAL' && !!sub?.trialEndDate, `status=${sub?.status} trialEndDate=${sub?.trialEndDate}`);
    rec.deny('a second store approval is refused (already active)', await asAdmin(ctx.admin.token, 'approve an already-active synthetic store', 'PUT', `/admin/vendors/${vendorId}/approve`), [400], ['ALREADY_ACTIVE']);
    const open = await PUT('/vendor/vendor/toggle-open', {}, s.token);
    rec.check('the owner opens the store', open.ok && open.json?.data?.isCurrentlyOpen === true, `→ ${brief(open)}`);
    const item = await POST('/vendor/items', { categoryId: cat.json?.data?.id, name: `VEND-01 item ${ctx.runId}`, basePrice: 500 }, s.token);
    rec.expect('the verified store lists an item', item, [200, 201]);
    await PUT('/vendor/vendor/toggle-open', {}, s.token); // close again: a synthetic store should not stay open
    rec.deviceCase('document camera capture', 'photographing real papers on a phone is the device gate; this target proves upload, review, rejection and activation');
  },
};

export const VEND_02: Journey<Ctx> = {
  id: 'VEND-02',
  title: 'Accept order → ready (H-1 close)',
  cases: 'hold; accept; prepare; ready; reject/expiry; ready/cancel race',
  async prepare(rec, ctx) {
    const R2 = ctx.roster.vendors.R2!, item = ctx.world.items.R2;
    rec.require('R2 pickup item provisioned', !!item, ctx.world.notReady.R2 ?? '');
    const place = async (cid: string, label: string) => {
      const c = ctx.roster.customers[cid]!;
      const r = await placeOrder(c.session, R2.vendorId!, item!.itemId, R2.lat, R2.lng, { pickup: true, key: idemKey(ctx.runId, label) });
      rec.expect(`${label}: pickup checkout`, r, [200, 201]);
      return orderIdsOf(r)[0] ?? null;
    };
    const A = await place('C1', 'vend02-accept');
    const B1 = await place('C2', 'vend02-reject-bare');
    const B2 = await place('C3', 'vend02-reject-reason');
    const X = await place('C6', 'vend02-expiry');
    // hold: the store cannot see the order yet, even by id
    if (A) {
      rec.deny('the store cannot accept a held order (it does not exist for the store yet)', await PUT(`/vendor/orders/${A}/accept`, {}, R2.session.token), [404]);
      const board = await GET('/vendor/orders?limit=50', R2.session.token);
      rec.check('the held order is absent from the store board', !JSON.stringify(board.json?.data ?? []).includes(A), `→ ${brief(board)}`);
    }
    ctx.stash['VEND-02'] = { A, B1, B2, X };
  },
  async release(rec, ctx) {
    const { A, B1, B2 } = ctx.stash['VEND-02'] ?? {};
    const R2 = ctx.roster.vendors.R2!;
    rec.require('orders placed', !!(A && B1 && B2), '');
    await waitForRelease(ctx.roster.customers.C1!.session, A);
    const board = await GET('/vendor/orders?limit=50', R2.session.token);
    rec.check('after the hold the order is on the store board', JSON.stringify(board.json?.data ?? []).includes(A), '');
    const alerts = await GET('/vendor/alerts/pending', R2.session.token);
    rec.check('the store has an unread new-order alert for it', JSON.stringify(alerts.json?.data ?? []).includes(A), `→ ${brief(alerts)}`);
    const acc = await PUT(`/vendor/orders/${A}/accept`, { estimatedPrepTime: 15 }, R2.session.token);
    rec.expect('the store accepts', acc, 200, undefined, `status=${acc.json?.data?.status}`);
    const bare = await PUT(`/vendor/orders/${B1}/reject`, {}, R2.session.token);
    rec.check('a reject without a reason (E10: the API makes the reason optional)', bare.ok || bare.status === 400, `→ ${brief(bare)}${bare.ok ? ' — accepted with the default reason; the mobile app requires one (E10 open)' : ''}`);
    const reasoned = await PUT(`/vendor/orders/${B2}/reject`, { reason: 'Kitchen closed early today' }, R2.session.token);
    rec.expect('the store rejects with a reason', reasoned, 200);
  },
  async run(rec, ctx) {
    const { A, B2 } = ctx.stash['VEND-02'] ?? {};
    const R2 = ctx.roster.vendors.R2!, R1 = ctx.roster.vendors.R1!;
    const C1 = ctx.roster.customers.C1!.session, C3 = ctx.roster.customers.C3!.session;
    rec.deny('another store cannot touch this order', await PUT(`/vendor/orders/${A}/preparing`, {}, R1.session.token), [404]);
    rec.expect('prepare', await PUT(`/vendor/orders/${A}/preparing`, {}, R2.session.token), 200);
    rec.deny('ready cannot be skipped back to accept', await PUT(`/vendor/orders/${A}/accept`, {}, R2.session.token), [400], ['INVALID_STATUS']);
    rec.expect('ready', await PUT(`/vendor/orders/${A}/ready`, {}, R2.session.token), 200);
    const o = await customerOrder(C1, A);
    rec.check('the customer timeline records accept → preparing → ready', ['ACCEPTED', 'PREPARING', 'READY_FOR_PICKUP'].every((s) => (o?.timeline ?? []).some((t: any) => t.status === s)),
      `timeline=${(o?.timeline ?? []).map((t: any) => t.status).join('>')}`);
    rec.expect('the counter handover closes it', await PUT(`/vendor/orders/${A}/complete-pickup`, { code: o?.pickupCode }, R2.session.token), 200);
    const notes = await notificationsOf(C1);
    rec.check('the customer was told it was accepted and ready', notes.some((n) => n.data?.orderId === A && n.data?.status === 'ACCEPTED') && notes.some((n) => n.data?.orderId === A && n.data?.status === 'READY_FOR_PICKUP'),
      `rows for the order: ${notes.filter((n) => n.data?.orderId === A).map((n) => n.data?.status ?? n.title).join(', ')}`);

    const r = await customerOrder(C3, B2);
    rec.check('the rejected order reads CANCELLED with the store’s reason', r?.status === 'CANCELLED' && /Kitchen closed/.test(String(r?.cancellationReason ?? '')), `status=${r?.status} reason=${r?.cancellationReason}`);
    const n3 = await notificationsOf(C3);
    rec.check('the customer got “Order declined” with the reason', n3.some((n) => n.data?.orderId === B2 && /declined/i.test(n.title) && /Kitchen closed/.test(n.body)), '');
    rec.deny('a cancelled order cannot be accepted', await PUT(`/vendor/orders/${B2}/accept`, {}, R2.session.token), [400], ['INVALID_STATUS']);

    // ready vs cancel on the rider-owned lane (E04): an assigned delivery, both at once
    const riders = onlineOf(ctx, 'rider');
    const placed = await placeExpress(ctx, 'C5', 'R1', 'R1', 'vend02-race');
    if (rec.expect('an express delivery for the race', placed.res, [200, 201]) && placed.id) {
      await storeAccepts(ctx, 'R1', placed.id);
      const got = await pollOffer(ctx, placed.id, riders);
      if (got && (await POST('/rider/offers/accept', { orderId: placed.id, offerAttemptId: got.offer.offerAttemptId }, mover(ctx, got.moverId).session.token)).ok) {
        await PUT(`/vendor/orders/${placed.id}/preparing`, {}, R1.session.token);
        const C5 = ctx.roster.customers.C5!.session;
        const [cancel, ready] = await Promise.all([
          POST(`/customer/orders/${placed.id}/cancel`, { reason: 'race' }, C5.token),
          PUT(`/vendor/orders/${placed.id}/ready`, {}, R1.session.token),
        ]);
        const fin = await customerOrder(C5, placed.id);
        const readyAfterCancel = fin?.status === 'CANCELLED' && fin?.readyAt && fin?.cancelledAt && Date.parse(fin.readyAt) > Date.parse(fin.cancelledAt);
        rec.check('ready vs cancel on a rider-owned order: no ready stamp lands on a cancelled order (E04)', !readyAfterCancel && (cancel.ok || ready.ok),
          `cancel → ${brief(cancel)}, ready → ${brief(ready)}, final=${fin?.status} readyAt=${fin?.readyAt ?? null} cancelledAt=${fin?.cancelledAt ?? null}`);
        await freeRider(ctx, got.moverId);
      } else {
        rec.check('a rider takes the race order', false, got ? 'accept failed' : 'no offer');
      }
    }
  },
  async finish(rec, ctx) {
    const { X } = ctx.stash['VEND-02'] ?? {};
    if (!X) return;
    const C6 = ctx.roster.customers.C6!.session;
    const gone = await waitFor(async () => {
      const o = await customerOrder(C6, X);
      return o?.status === 'CANCELLED' ? o : null;
    }, 8 * 60_000, 10_000);
    rec.check('an order the store never answers is cancelled automatically (expiry)', !!gone, gone ? `cancelled at ${gone.cancelledAt}: ${gone.cancellationReason}` : 'still not cancelled 8 min after the run');
    const notes = await notificationsOf(C6);
    rec.check('the customer is told nobody answered', notes.some((n) => n.data?.orderId === X && /cancel/i.test(n.title)), '');
  },
};

export const VEND_03: Journey<Ctx> = {
  id: 'VEND-03',
  estimateSeconds: 30,
  title: 'MMG pay-link set + confirm payment',
  cases: 'link cool-off; MMG claim; duplicate/reference conflict; disputed payment hold',
  async run(rec, ctx) {
    const R3 = ctx.roster.vendors.R3!;
    const set = await PUT('/vendor/profile', { mmgPayUrl: 'https://pay.example.invalid/vendor/test' }, R3.session.token);
    rec.deny('a pay link cannot be set without a fresh step-up', set, [400, 403, 503], ['STEP_UP_REQUIRED', 'INVALID_MMG_PAY_URL', 'MMG_PAY_LINKS_NOT_CONFIGURED'], `→ ${codeOf(set)}`);
    const send = await POST('/auth/step-up', {}, R3.session.token);
    rec.check('the step-up code is sent to the phone on the account', send.ok || send.status === 429, `→ ${brief(send)} sentTo=${send.json?.data?.sentTo ?? ''}`);
    const dev = await POST('/auth/step-up/verify', { code: '000000' }, R3.session.token);
    rec.deny('the dev OTP code does not satisfy step-up', dev, [400], ['INVALID_CODE']);
    const pend = await req('DELETE', '/vendor/profile/mmg-pay-url/pending', { token: R3.session.token });
    rec.check('cancelling a pending link (none pending) is harmless', pend.ok && pend.json?.data?.cancelled === false, `→ ${brief(pend)} ${JSON.stringify(pend.json?.data ?? null)}`);
    const cart = await GET('/customer/cart', ctx.roster.customers.C2!.session.token);
    rec.check('the cart reports MMG unavailable for a store with no link', cart.json?.data?.paymentCapabilities?.mmg?.available !== true, JSON.stringify(cart.json?.data?.paymentCapabilities ?? null));
    const unconfigured = codeOf(set) === 'MMG_PAY_LINKS_NOT_CONFIGURED';
    rec.skipAll(`every case needs a live vendor pay link. ${unconfigured ? 'Pay links are not configured on this target (MMG_PAY_URL_ALLOWED_HOSTS unset, 503), and even' : 'Setting one'} needs a step-up whose code reaches the owner only by SMS (POST /auth/step-up/verify checks the real code; DEV_OTP_BYPASS does not apply); Phase A has no SMS provider. Phase B (Twilio + a consented owner phone${unconfigured ? ' + the MMG host allowlist' : ''}) unlocks it`);
    void sleep;
  },
};

export const VEND_04: Journey<Ctx> = {
  id: 'VEND-04',
  estimateSeconds: 30,
  title: 'Weekly fee + cash settlement',
  cases: 'weekly bill; agent cash; idempotent receipt; suspension/reinstatement; stop billing',
  async run(rec, ctx) {
    const R1 = ctx.roster.vendors.R1!;
    const sub = (await GET('/vendor/subscription', R1.session.token)).json?.data;
    rec.check('the store has a subscription with its weekly rate and cash account number', !!sub?.status && Number(sub?.weeklyFeeGyd ?? sub?.weeklyRate) > 0 && !!sub?.san,
      `status=${sub?.status} weekly=${sub?.weeklyFeeGyd ?? sub?.weeklyRate} san=${sub?.sanFormatted ?? sub?.san} due=${sub?.amountDueGyd}`);
    const cash = await PUT('/vendor/subscription/billing-method', { method: 'CASH' }, R1.session.token);
    rec.expect('the owner pays by agent cash (idempotent choice)', cash, 200);
    rec.deny('MMG billing without the payer number', await PUT('/vendor/subscription/billing-method', { method: 'MOBILE_MONEY' }, R1.session.token), [400], ['MSISDN_REQUIRED']);
    rec.deny('a customer cannot read a store’s subscription', await GET('/vendor/subscription', ctx.roster.customers.C2!.session.token), [403, 404]);
    const stop = await PUT('/vendor/subscription/billing-method', { method: 'NONE' }, R1.session.token);
    rec.check('a partner can stop weekly billing self-serve (E12)', stop.ok,
      stop.ok ? `→ ${brief(stop)}` : `no stop option: billing-method refuses a stop (→ ${brief(stop)}) and no other route exists; the only way out is account deletion — E12 open`);
    if (stop.ok) await PUT('/vendor/subscription/billing-method', { method: 'CASH' }, R1.session.token);
    const inquiry = await req('POST', '/billing/mmg/inquiry', { body: { accountNumber: String(sub?.san ?? '0') } });
    rec.check('the agent-cash channel refuses an unsigned inquiry (dark or signature-gated)', inquiry.status === 503 || inquiry.status === 401, `→ ${inquiry.status} ${inquiry.text.slice(0, 120)}`);
    rec.skipAll('the weekly bill runs from the hourly billing job only after the 14-day trial ends, and suspension follows three failed charges 24 h apart; a run cannot advance the clock (no HTTP trigger). Agent-cash receipts need the webhook secret, which the runner must not hold');
  },
};

export const VEND_05: Journey<Ctx> = {
  id: 'VEND-05',
  estimateSeconds: 60,
  title: 'Items/stock management',
  cases: 'create/import; stock collision; customer quote recovery',
  async run(rec, ctx) {
    const OV1 = ctx.roster.vendors.OV1!, ST1 = ctx.roster.vendors.ST1!;
    const cat = (await GET('/vendor/categories', OV1.session.token)).json?.data?.[0]?.id;
    const made = await POST('/vendor/items', { categoryId: cat, name: `VEND-05 ${ctx.runId}`, basePrice: 450, stockQuantity: 3 }, OV1.session.token);
    rec.expect('create an item with stock', made, [200, 201]);
    const csv = `category,name,basePrice,stockQuantity\nImports,IMP-${ctx.runId}-a,650,4\nImports,IMP-${ctx.runId}-b,700,\nImports,,oops,\n`;
    const imp = await POST('/vendor/items/import', { csv }, OV1.session.token);
    rec.expect('bulk import', imp, [200, 201], undefined, JSON.stringify(imp.json?.data ?? null).slice(0, 200));
    const list = await GET('/vendor/items?limit=50', OV1.session.token);
    const names = JSON.stringify(list.json?.data ?? []);
    rec.check('the created and imported items are on the menu', names.includes(`VEND-05 ${ctx.runId}`) && names.includes(`IMP-${ctx.runId}-a`) && names.includes(`IMP-${ctx.runId}-b`), '');
    rec.check('the malformed row is reported, not imported', JSON.stringify(imp.json?.data ?? {}).includes('failures') || JSON.stringify(imp.json?.data ?? {}).includes('row'), '');
    rec.deny('a customer cannot import', await POST('/vendor/items/import', { csv }, ctx.roster.customers.C2!.session.token), [403]);

    // stock collision: one last bag, two buyers at once
    const bag = ctx.world.items.ST1;
    rec.require('ST1 last-bag item provisioned (stock 1)', !!bag, ctx.world.notReady.ST1 ?? '');
    const A = ctx.roster.customers.C1!, B = ctx.roster.customers.C2!;
    const [a, b] = await Promise.all([
      placeOrder(A.session, ST1.vendorId!, bag!.itemId, A.lat, A.lng, { pickup: true, key: idemKey(ctx.runId, 'vend05-a') }),
      placeOrder(B.session, ST1.vendorId!, bag!.itemId, B.lat, B.lng, { pickup: true, key: idemKey(ctx.runId, 'vend05-b') }),
    ]);
    const wins = [a, b].filter((r) => r.ok);
    const loser = a.ok ? B : A;
    rec.check('two buyers of the last unit: one order, one 409', wins.length === 1 && [a, b].some((r) => r.status === 409 && ['INSUFFICIENT_STOCK', 'ITEM_UNAVAILABLE', 'CART_CHANGED'].includes(codeOf(r))),
      `→ ${brief(a)} / ${brief(b)}`);
    const listed = await GET('/vendor/items?limit=50', ST1.session.token);
    const row = (Array.isArray(listed.json?.data) ? listed.json.data : []).find((i: any) => i.id === bag!.itemId);
    rec.check('the shelf reads empty and the item hides itself', Number(row?.stockQuantity) === 0 && row?.isAvailable === false, `stock=${row?.stockQuantity} available=${row?.isAvailable}`);
    rec.deny('stock cannot go below zero', await POST(`/vendor/items/${bag!.itemId}/adjust`, { delta: -1, reason: 'DAMAGED' }, ST1.session.token), [409], ['INSUFFICIENT_STOCK']);
    rec.deny('another store cannot adjust this stock', await POST(`/vendor/items/${bag!.itemId}/adjust`, { delta: 5, reason: 'RECEIVED' }, OV1.session.token), [404]);

    // customer quote recovery: the loser's quote shows it gone; a restock lets the retry through
    const q = await GET('/customer/cart', loser.session.token);
    rec.check('the loser’s quote shows the line unavailable', (q.json?.data?.unavailableItemIds ?? []).length >= 1 || (q.json?.data?.items ?? []).length === 0, JSON.stringify(q.json?.data?.unavailableItemIds ?? null));
    const restock = await POST(`/vendor/items/${bag!.itemId}/adjust`, { delta: 1, reason: 'RECEIVED', note: 'journey restock' }, ST1.session.token);
    rec.check('a restock brings the item back', restock.ok && restock.json?.data?.stockQuantity === 1 && restock.json?.data?.isAvailable === true, `→ ${brief(restock)} ${JSON.stringify(restock.json?.data ?? null).slice(0, 120)}`);
    const retry = await placeOrder(loser.session, ST1.vendorId!, bag!.itemId, loser.lat, loser.lng, { pickup: true, key: idemKey(ctx.runId, 'vend05-retry') });
    rec.expect('the loser’s retry now succeeds', retry, [200, 201]);
    for (const [s, r] of [[A.session, a], [B.session, b], [loser.session, retry]] as const) {
      for (const id of orderIdsOf(r)) await POST(`/customer/orders/${id}/cancel`, { reason: 'journey cleanup' }, s.token);
    }
    const back = await GET('/vendor/items?limit=50', ST1.session.token);
    const row2 = (Array.isArray(back.json?.data) ? back.json.data : []).find((i: any) => i.id === bag!.itemId);
    rec.check('cancelled orders put their units back on the shelf', Number(row2?.stockQuantity) >= 1, `stock=${row2?.stockQuantity}`);
    void DEL; void clearCart; void pick; void waitForRelease; void vendorAdvance;
  },
};

export const VENDOR_JOURNEYS = [VEND_01, VEND_02, VEND_03, VEND_04, VEND_05];
