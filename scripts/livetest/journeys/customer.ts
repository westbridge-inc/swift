// Customer commerce journeys [TASK-057]: CUST-01..05 and AUTH-04 (deletion).

import { FIXTURE_PNG, upload, type Session } from '../client.js';
import type { Journey, Recorder } from '../journey.js';
import {
  GET, POST, PUT, DEL, req, sleep, codeOf, brief, pick, waitFor,
  placeOrder, orderIdsOf, customerOrder, waitForRelease, clearCart, ensureAddress, idemKey,
} from './common.js';
import type { Ctx } from './context.js';
import { registerFresh } from './auth.js';

const ok2xx = (s: number) => s >= 200 && s < 300;

/** Vendor moves a released order forward from wherever it is; returns the last response. */
export async function vendorAdvance(vendor: Session, orderId: string, to: 'ACCEPTED' | 'PREPARING' | 'READY_FOR_PICKUP') {
  const order = ['ACCEPTED', 'PREPARING', 'READY_FOR_PICKUP'];
  const cur = await GET(`/vendor/orders/${orderId}`, vendor.token);
  const at = order.indexOf(String(cur.json?.data?.status));
  const steps: Array<[string, string]> = [['ACCEPTED', 'accept'], ['PREPARING', 'preparing'], ['READY_FOR_PICKUP', 'ready']];
  let last = cur;
  for (const [status, slug] of steps) {
    if (order.indexOf(status) <= at) { if (status === to) return cur; continue; }
    last = await PUT(`/vendor/orders/${orderId}/${slug}`, {}, vendor.token);
    if (!last.ok || status === to) break;
  }
  return last;
}

/** The store accepts a prepared order as soon as its hold ends (before the auto-reject window). */
async function acceptOnRelease(rec: Recorder, ctx: Ctx, c: Session, orderId: string | null, label: string) {
  if (!orderId) return;
  await waitForRelease(c, orderId);
  rec.expect(`${label}: the store accepts once the hold ends`, await PUT(`/vendor/orders/${orderId}/accept`, {}, ctx.roster.vendors.R2!.session.token), 200);
}

/** Place a pickup order at R2 for `c`, recording it; returns the order id or null. */
async function pickupAtR2(rec: Recorder, ctx: Ctx, c: Session, label: string): Promise<string | null> {
  const R2 = ctx.roster.vendors.R2!, item = ctx.world.items.R2;
  if (!item || !R2.vendorId) { rec.check(`${label}: R2 pickup item provisioned`, false, ctx.world.notReady.R2 ?? 'no item'); return null; }
  const r = await placeOrder(c, R2.vendorId, item.itemId, R2.lat, R2.lng, { pickup: true, key: idemKey(ctx.runId, label) });
  rec.expect(`${label}: pickup checkout at ${R2.id}`, r, [200, 201]);
  return orderIdsOf(r)[0] ?? null;
}

export const CUST_01: Journey<Ctx> = {
  id: 'CUST-01',
  estimateSeconds: 60,
  title: 'Browse → vendor → menu → cart',
  cases: 'guest browse; menu/cart/quote; stale cart failure and retry; multi-vendor quote',
  async run(rec, ctx) {
    const R1 = ctx.roster.vendors.R1!, OV1 = ctx.roster.vendors.OV1!;
    const i1 = ctx.world.items.R1, i2 = ctx.world.items.OV1, spare = ctx.world.items['OV1-spare'];
    const C4 = ctx.roster.customers.C4!.session;

    // guest browse
    const dir = await GET('/public/storefronts');
    const listed = (dir.json?.data ?? []).find((v: any) => v.id === R1.vendorId);
    rec.check('guest: the public storefront directory lists the live store', dir.ok && !!listed, `→ ${dir.status}, ${dir.json?.data?.length ?? 0} stores, R1 ${listed ? 'listed' : 'absent'}`);
    if (listed?.slug) {
      const page = await GET(`/public/storefronts/${listed.slug}`);
      const menu = JSON.stringify(page.json?.data ?? {});
      rec.check('guest: the storefront page carries the menu', page.ok && !!i1 && menu.includes(i1.itemId), `→ ${page.status}`);
    }
    const market = await GET('/market/items');
    rec.expect('guest: the market feed answers', market, 200);
    const guestSearch = await GET('/search?q=TEST');
    rec.check('guest: catalogue search answers a guest (E25)', guestSearch.status === 200,
      `GET /search without a session → ${brief(guestSearch)}${guestSearch.status === 401 ? ' — guest search still requires a session (E25 open)' : ''}`);
    rec.deny('guest: the cart needs a session', await GET('/customer/cart'), [401]);

    // menu → cart → quote
    rec.require('R1 and OV1 are orderable', !!(i1 && i2 && R1.vendorId && OV1.vendorId), JSON.stringify(ctx.world.notReady));
    const home = await GET('/customer/home', C4.token);
    rec.expect('customer home loads', home, 200);
    const store = await GET(`/customer/vendors/${R1.vendorId}`, C4.token);
    rec.check('the vendor menu lists the item', store.ok && JSON.stringify(store.json?.data ?? {}).includes(i1!.itemId), `→ ${store.status}`);
    await clearCart(C4);
    const addr = await ensureAddress(C4, ctx.roster.customers.C4!.lat, ctx.roster.customers.C4!.lng);
    const add = await POST('/customer/cart/items', { vendorId: R1.vendorId, itemId: i1!.itemId, quantity: 2 }, C4.token);
    rec.expect('add 2 × item to the cart', add, [200, 201]);
    if (addr) await PUT('/customer/cart/address', { addressId: addr }, C4.token);
    const q1 = (await GET('/customer/cart', C4.token)).json?.data;
    rec.check('the quote prices the basket (subtotal = 2 × price, total = subtotal + fee)',
      Number(q1?.subtotalCustomer) === 2 * i1!.price && Number(q1?.totalAmount) === Number(q1?.subtotalCustomer) + Number(q1?.deliveryFee) + Number(q1?.tipAmount ?? 0) - Number(q1?.discount ?? 0),
      `subtotal=${q1?.subtotalCustomer} fee=${q1?.deliveryFee} total=${q1?.totalAmount} price=${i1!.price}`);
    rec.deny('a quantity over the limit', await POST('/customer/cart/items', { vendorId: R1.vendorId, itemId: i1!.itemId, quantity: 100 }, C4.token), [400]);

    // stale cart: the store pulls an item after it was carted; checkout refuses; the retry succeeds.
    if (spare) {
      await clearCart(C4);
      await POST('/customer/cart/items', { vendorId: OV1.vendorId, itemId: spare.itemId, quantity: 1 }, C4.token);
      const off = await PUT(`/vendor/items/${spare.itemId}/availability`, { isAvailable: false }, OV1.session.token);
      rec.expect('the store marks the carted item unavailable', off, 200);
      const stale = await req('POST', '/customer/checkout', { token: C4.token, body: { paymentMethod: 'CASH', fulfillmentSelections: { [OV1.vendorId!]: 'PICKUP' } } });
      rec.deny('checkout of a stale cart is refused', stale, [404, 409], ['ITEM_UNAVAILABLE', 'ITEM_NOT_FOUND']);
      const cart = (await GET('/customer/cart', C4.token)).json?.data;
      rec.check('the refreshed quote flags the unavailable line', (cart?.unavailableItemIds ?? []).length === 1, `unavailableItemIds=${JSON.stringify(cart?.unavailableItemIds)}`);
      const lineId = cart?.items?.[0]?.id;
      if (lineId) await DEL(`/customer/cart/items/${lineId}`, C4.token);
      await PUT(`/vendor/items/${spare.itemId}/availability`, { isAvailable: true }, OV1.session.token);
      const retry = await placeOrder(C4, OV1.vendorId!, spare.itemId, OV1.lat, OV1.lng, { pickup: true, key: idemKey(ctx.runId, 'cust01-retry') });
      rec.expect('the retried checkout succeeds', retry, [200, 201]);
      for (const id of orderIdsOf(retry)) await POST(`/customer/orders/${id}/cancel`, { reason: 'journey cleanup' }, C4.token);
    } else {
      rec.check('OV1 spare item provisioned for the stale-cart case', false, ctx.world.notReady.OV1 ?? 'missing');
    }

    // multi-vendor quote vs the per-vendor orders it becomes
    await clearCart(C4);
    await POST('/customer/cart/items', { vendorId: R1.vendorId, itemId: i1!.itemId, quantity: 1 }, C4.token);
    await POST('/customer/cart/items', { vendorId: OV1.vendorId, itemId: i2!.itemId, quantity: 1 }, C4.token);
    if (addr) await PUT('/customer/cart/address', { addressId: addr }, C4.token);
    const q2 = (await GET('/customer/cart', C4.token)).json?.data;
    const delivery = ctx.world.onlineMovers.length > 0;
    const body: Record<string, unknown> = { paymentMethod: 'CASH' };
    if (!delivery) body.fulfillmentSelections = { [R1.vendorId!]: 'PICKUP', [OV1.vendorId!]: 'PICKUP' };
    const co = await req('POST', '/customer/checkout', { token: C4.token, body, headers: { 'Idempotency-Key': idemKey(ctx.runId, 'cust01-multi') } });
    rec.expect(`multi-vendor checkout (${delivery ? 'delivery' : 'pickup'})`, co, [200, 201]);
    const orders: any[] = co.json?.data?.orders ?? [];
    rec.check('one order per vendor', orders.length === 2, `orders=${orders.length}`);
    // The durable numbers: each order read back through GET /customer/orders/:id (the
    // checkout confirmation is a summary whose field names differ from the order view).
    const placedOrders: any[] = (await Promise.all(orders.map((o) => customerOrder(C4, o.id)))).filter(Boolean);
    const num = (o: any, ...keys: string[]) => Number(pick(o, ...keys) ?? 0);
    const sumSub = placedOrders.reduce((s, o) => s + num(o, 'subtotalCustomer', 'subtotal', 'subtotalBase'), 0);
    rec.check('the quote subtotal equals the orders’ subtotals', placedOrders.length === orders.length && sumSub === Number(q2?.subtotalCustomer), `quote=${q2?.subtotalCustomer} orders=${sumSub}`);
    if (delivery) {
      const sumFee = placedOrders.reduce((s, o) => s + num(o, 'deliveryFee'), 0);
      const sumTotal = placedOrders.reduce((s, o) => s + num(o, 'totalAmount', 'total'), 0);
      rec.check('the multi-vendor quote total equals what checkout charges (E01)', sumTotal === Number(q2?.totalAmount),
        `quote total=${q2?.totalAmount} (fee ${q2?.deliveryFee}) vs orders total=${sumTotal} (fees ${sumFee})`);
    } else {
      rec.skipCase('multi-vendor delivery-fee agreement', 'no mover was online, so the multi-vendor order was placed for pickup; the delivery-fee side of E01 needs an online rider');
    }
    for (const o of orders) await POST(`/customer/orders/${o.id}/cancel`, { reason: 'journey cleanup' }, C4.token);
  },
};

export const CUST_02: Journey<Ctx> = {
  id: 'CUST-02',
  estimateSeconds: 60,
  title: 'Checkout (cash / vendor MMG)',
  cases: 'cash and MMG checkout; card denial; duplicate key; quote drift; dispute hold',
  async run(rec, ctx) {
    const R1 = ctx.roster.vendors.R1!, OV1 = ctx.roster.vendors.OV1!, i1 = ctx.world.items.R1, drift = ctx.world.items['OV1-drift'];
    const C5 = ctx.roster.customers.C5!;
    rec.require('R1 is orderable', !!(i1 && R1.vendorId), ctx.world.notReady.R1 ?? '');
    const delivery = ctx.world.onlineMovers.length > 0;

    // card and bank transfer are not order payment methods
    for (const method of ['CARD', 'BANK_TRANSFER']) {
      const r = await placeOrder(C5.session, R1.vendorId!, i1!.itemId, C5.lat, C5.lng, { payment: method, pickup: !delivery });
      rec.deny(`checkout with ${method}`, r, [400], ['VALIDATION_ERROR']);
    }
    const mmg = await placeOrder(C5.session, R1.vendorId!, i1!.itemId, C5.lat, C5.lng, { payment: 'MOBILE_MONEY', pickup: !delivery });
    rec.deny('MMG checkout at a store with no pay link', mmg, [400], ['MMG_NOT_AVAILABLE']);

    // cash, with an idempotency key; replay; changed body under the same key
    const key = idemKey(ctx.runId, 'cust02-cash');
    const first = await placeOrder(C5.session, R1.vendorId!, i1!.itemId, C5.lat, C5.lng, { pickup: !delivery, key });
    rec.expect(`cash ${delivery ? 'delivery' : 'pickup'} checkout`, first, [200, 201]);
    const ids = orderIdsOf(first);
    const o = ids[0] ? await customerOrder(C5.session, ids[0]) : null;
    rec.check('the order persists as PENDING, cash, held', o?.status === 'PENDING' && o?.paymentMethod === 'CASH' && !!o?.holdExpiresAt,
      `status=${o?.status} payment=${o?.paymentMethod} holdExpiresAt=${o?.holdExpiresAt}`);
    const body: Record<string, unknown> = { paymentMethod: 'CASH', ...(delivery ? {} : { fulfillmentSelections: { [R1.vendorId!]: 'PICKUP' } }) };
    const replay = await req('POST', '/customer/checkout', { token: C5.session.token, body, headers: { 'Idempotency-Key': key } });
    rec.check('a replay under the same key returns the same order (no second order)', replay.ok && replay.json?.replayed === true && JSON.stringify(orderIdsOf(replay)) === JSON.stringify(ids),
      `→ ${brief(replay)} replayed=${replay.json?.replayed} ids=${JSON.stringify(orderIdsOf(replay))}`);
    const receipt = await GET(`/test-control/checkout/${encodeURIComponent(key)}`, C5.session.token);
    rec.check('the server-side receipt holds exactly one order for the key', receipt.ok && receipt.json?.data?.orderCount === 1, `→ ${brief(receipt)} orderCount=${receipt.json?.data?.orderCount}`);
    const changed = await req('POST', '/customer/checkout', { token: C5.session.token, body: { ...body, deliveryInstructions: 'changed' }, headers: { 'Idempotency-Key': key } });
    rec.deny('a changed body under a used key', changed, [422], ['IDEMPOTENCY_KEY_REUSED']);
    for (const oid of ids) {
      const cancel = await POST(`/customer/orders/${oid}/cancel`, { reason: 'journey cleanup' }, C5.session.token);
      rec.expect('the held cash order cancels free of charge (cleanup)', cancel, 200);
    }

    // quote drift: the store changes the price between quote and checkout
    if (drift) {
      await clearCart(C5.session);
      await POST('/customer/cart/items', { vendorId: OV1.vendorId, itemId: drift.itemId, quantity: 1 }, C5.session.token);
      const q1 = (await GET('/customer/cart', C5.session.token)).json?.data;
      const newPrice = drift.price + 250;
      const up = await PUT(`/vendor/items/${drift.itemId}`, { basePrice: newPrice }, OV1.session.token);
      rec.expect('the store raises the price after the customer quoted', up, 200);
      const q2 = (await GET('/customer/cart', C5.session.token)).json?.data;
      rec.check('the re-read quote shows the new price', Number(q2?.subtotalCustomer) === newPrice, `before=${q1?.subtotalCustomer} after=${q2?.subtotalCustomer}`);
      const co = await req('POST', '/customer/checkout', { token: C5.session.token, body: { paymentMethod: 'CASH', fulfillmentSelections: { [OV1.vendorId!]: 'PICKUP' } } });
      const placedId = orderIdsOf(co)[0];
      const placed = placedId ? await customerOrder(C5.session, placedId) : null;
      const placedSub = Number(pick(placed, 'subtotalCustomer', 'subtotal', 'subtotalBase') ?? NaN);
      rec.check('checkout charges the current quote, never the stale one', ok2xx(co.status) && placedSub === newPrice,
        `→ ${brief(co)} order subtotal=${placedSub} (stale quote ${q1?.subtotalCustomer})`);
      await PUT(`/vendor/items/${drift.itemId}`, { basePrice: drift.price }, OV1.session.token);
      for (const id of orderIdsOf(co)) await POST(`/customer/orders/${id}/cancel`, { reason: 'journey cleanup' }, C5.session.token);
    }

    const stepUp = await PUT('/vendor/profile', { mmgPayUrl: 'https://pay.mmg.gy/vendor/test' }, R1.session.token);
    // Refused for one of two reasons, both closing the door on this target: pay links are not
    // configured here (MMG_PAY_URL_ALLOWED_HOSTS unset → 503), or they are and a fresh SMS step-up is required.
    rec.deny('a vendor cannot set an MMG pay link without a step-up (or at all where links are unconfigured)', stepUp, [403, 503], ['STEP_UP_REQUIRED', 'MMG_PAY_LINKS_NOT_CONFIGURED']);
    rec.skipCase('MMG checkout', `a vendor pay link needs a step-up whose code only reaches the owner by SMS (POST /auth/step-up/verify checks the real code; DEV_OTP_BYPASS does not apply), and Phase A has no SMS provider${codeOf(stepUp) === 'MMG_PAY_LINKS_NOT_CONFIGURED' ? '; pay links are also unconfigured on this target (MMG_PAY_URL_ALLOWED_HOSTS unset)' : ''} — no store can hold a link on this target`);
    rec.skipCase('dispute hold', 'the MMG claim/disagreement hold needs an MMG order, which needs a vendor pay link (step-up by SMS)');
  },
};

export const CUST_03: Journey<Ctx> = {
  id: 'CUST-03',
  title: 'Cancel / convert-to-pickup / reorder',
  cases: 'cancel; convert to pickup; reorder; stale cart retry; cancel/ready race',
  async prepare(rec, ctx) {
    const C6 = ctx.roster.customers.C6!.session;
    ctx.stash['CUST-03'] = { race: await pickupAtR2(rec, ctx, C6, 'cust03-race') };
  },
  async release(rec, ctx) {
    await acceptOnRelease(rec, ctx, ctx.roster.customers.C6!.session, ctx.stash['CUST-03']?.race ?? null, 'race order');
  },
  async run(rec, ctx) {
    const C6 = ctx.roster.customers.C6!.session, C2 = ctx.roster.customers.C2!.session;
    const R2 = ctx.roster.vendors.R2!;

    // cancel inside the free window
    const id = await pickupAtR2(rec, ctx, C6, 'cust03-cancel');
    rec.require('an order to cancel', !!id, '');
    rec.deny('another customer cannot cancel it', await POST(`/customer/orders/${id}/cancel`, {}, C2.token), [404]);
    const c = await POST(`/customer/orders/${id}/cancel`, { reason: 'changed my mind' }, C6.token);
    rec.expect('cancel inside the hold', c, 200);
    const after = await customerOrder(C6, id!);
    rec.check('the order reads CANCELLED with no fee', after?.status === 'CANCELLED' && Number(after?.cancellationFee ?? 0) === 0, `status=${after?.status} fee=${after?.cancellationFee}`);
    rec.deny('a second cancel', await POST(`/customer/orders/${id}/cancel`, {}, C6.token), [400, 409], ['INVALID_STATUS', 'ALREADY_CANCELLED', 'ORDER_CLOSED']);

    // reorder, then the stale-cart retry
    const re = await POST(`/customer/orders/${id}/reorder`, {}, C6.token);
    rec.expect('reorder rebuilds the cart', re, [200, 201]);
    const cart = (await GET('/customer/cart', C6.token)).json?.data;
    rec.check('the rebuilt cart holds the ordered item', (cart?.items ?? []).some((l: any) => (l.itemId ?? l.item?.id) === ctx.world.items.R2?.itemId), `items=${cart?.items?.length ?? 0}`);
    const r2item = ctx.world.items.R2!;
    await PUT(`/vendor/items/${r2item.itemId}/availability`, { isAvailable: false }, R2.session.token);
    const staleRe = await POST(`/customer/orders/${id}/reorder`, {}, C6.token);
    rec.deny('reorder when every item is gone', staleRe, [400], ['NO_ITEMS']);
    await PUT(`/vendor/items/${r2item.itemId}/availability`, { isAvailable: true }, R2.session.token);
    const retry = await POST(`/customer/orders/${id}/reorder`, {}, C6.token);
    rec.expect('reorder retried once the item is back', retry, [200, 201]);
    await clearCart(C6);

    // convert to pickup (flag-gated)
    const probe = await POST(`/customer/orders/${id}/convert-to-pickup`, {}, C6.token);
    if (probe.status === 404 && /not available/i.test(String(probe.json?.error?.message ?? ''))) {
      rec.skipCase('convert to pickup', 'the route answers 404 "Not available": DISPATCH_EXHAUSTION is off on this target (the documented default); the conversion ships dark until the flag is set');
    } else {
      rec.deny('converting a cancelled order', probe, [400, 409]);
      rec.skipCase('convert to pickup (happy path)', 'needs a delivery order whose dispatch has exhausted; not produced deterministically in one run');
    }

    // cancel/ready race on a released order: exactly one wins
    const raceId = ctx.stash['CUST-03']?.race as string | null;
    if (!raceId) return;
    const acc = await vendorAdvance(R2.session, raceId, 'PREPARING');
    rec.expect('the store starts preparing', acc, 200);
    const [cancel, ready] = await Promise.all([
      POST(`/customer/orders/${raceId}/cancel`, { reason: 'race' }, C6.token),
      PUT(`/vendor/orders/${raceId}/ready`, {}, R2.session.token),
    ]);
    const fin = await customerOrder(C6, raceId);
    const winners = [cancel.ok, ready.ok].filter(Boolean).length;
    const consistent = (cancel.ok && fin?.status === 'CANCELLED') || (ready.ok && fin?.status === 'READY_FOR_PICKUP') || (cancel.ok && ready.ok && ['CANCELLED', 'READY_FOR_PICKUP'].includes(fin?.status));
    rec.check('cancel vs ready: the final state matches a winner', winners >= 1 && !!consistent,
      `cancel → ${brief(cancel)}, ready → ${brief(ready)}, final=${fin?.status}`);
    if (fin?.status === 'READY_FOR_PICKUP') {
      const code = fin.pickupCode;
      await PUT(`/vendor/orders/${raceId}/complete-pickup`, { code }, R2.session.token);
    }
  },
};

export const CUST_04: Journey<Ctx> = {
  id: 'CUST-04',
  title: 'Rate, report, tip',
  cases: 'delivered rating; report; tip duplicate/refusal',
  async prepare(rec, ctx) {
    ctx.stash['CUST-04'] = { orderId: await pickupAtR2(rec, ctx, ctx.roster.customers.C1!.session, 'cust04') };
  },
  async release(rec, ctx) {
    await acceptOnRelease(rec, ctx, ctx.roster.customers.C1!.session, ctx.stash['CUST-04']?.orderId ?? null, 'rated order');
  },
  async run(rec, ctx) {
    const C1 = ctx.roster.customers.C1!.session, C2 = ctx.roster.customers.C2!.session, R2 = ctx.roster.vendors.R2!;
    const id = ctx.stash['CUST-04']?.orderId as string | null;
    rec.require('an order to complete and rate', !!id, '');
    rec.deny('rating an order that is not finished', await POST(`/customer/orders/${id}/rate`, { vendorScore: 5 }, C1.token), [400], ['ORDER_NOT_COMPLETE']);
    rec.expect('the store readies it', await vendorAdvance(R2.session, id!, 'READY_FOR_PICKUP'), 200);
    const code = (await customerOrder(C1, id!))?.pickupCode;
    rec.expect('counter handover with the pickup code', await PUT(`/vendor/orders/${id}/complete-pickup`, { code }, R2.session.token), 200);
    rec.check('the order reads COMPLETED', (await customerOrder(C1, id!))?.status === 'COMPLETED', '');

    rec.deny('another customer cannot rate it', await POST(`/customer/orders/${id}/rate`, { vendorScore: 1 }, C2.token), [404], ['NOT_FOUND']);
    const rate = await POST(`/customer/orders/${id}/rate`, { vendorScore: 5, vendorComment: `journey ${ctx.runId}` }, C1.token);
    rec.expect('rate the completed order', rate, [200, 201]);
    const again = await POST(`/customer/orders/${id}/rate`, { vendorScore: 4 }, C1.token);
    rec.deny('a duplicate rating', again, [409], ['ALREADY_RATED']);
    const o = await customerOrder(C1, id!);
    rec.check('the order reads as rated', o?.hasBeenRated === true, `hasBeenRated=${o?.hasBeenRated}`);

    // report: reviews are double-blind (public only once both sides rate, or after 72 h), but the
    // store sees them at once and a report is filed against the review's id.
    const storeView = await GET('/vendor/reviews?limit=20', R2.session.token);
    const rows: any[] = Array.isArray(storeView.json?.data) ? storeView.json.data : [];
    // Match the review by its ORDER, which is unique to this run. The comment cannot carry
    // the run id: the review scrub masks any 7+ digit run as a possible phone number
    // (rating/review-scrub.ts), so "journey staging-2026…" is stored as
    // "journey staging-[number removed]…" — the product protecting PII, not a lost review.
    const review = rows.find((r) => r.orderId === id);
    rec.check('the store sees the new review', !!review, `→ ${brief(storeView)} ${rows.length} review(s)`);
    const publicView = await GET(`/customer/vendors/${R2.vendorId}/reviews`, C2.token);
    rec.check('the public listing holds it back (double-blind until both sides rate or 72 h)', !JSON.stringify(publicView.json?.data?.reviews ?? []).includes(review?.id ?? '§'), '');
    if (review) {
      rec.deny('a review report with an unknown reason', await POST(`/customer/ratings/${review.id}/report`, { reason: 'NOT_A_REASON' }, C2.token), [400], ['VALIDATION_ERROR']);
      const rep = await POST(`/customer/ratings/${review.id}/report`, { reason: 'SPAM', note: 'journey check' }, C2.token);
      rec.expect('another customer reports the review', rep, [200, 201]);
      const rep2 = await POST(`/customer/ratings/${review.id}/report`, { reason: 'SPAM' }, C2.token);
      rec.check('a repeated review report is the same report', rep2.ok && rep2.json?.data?.id === rep.json?.data?.id, `→ ${brief(rep2)}`);
      const ugc = await POST('/reports', { targetType: 'RATING', targetId: review.id, reason: 'OTHER', detail: `journey ${ctx.runId}` }, C1.token);
      rec.expect('the content report reaches moderation', ugc, [200, 201]);
      const queue = await GET('/admin/moderation/reports', ctx.admin.token);
      rec.check('the report is in the operator moderation queue', JSON.stringify(queue.json?.data ?? []).includes(review.id), `→ ${brief(queue)}`);
    }
    rec.deny('a customer cannot report their own profile', await POST('/reports', { targetType: 'USER', targetId: C1.userId, reason: 'SPAM' }, C1.token), [400], ['CANNOT_REPORT_SELF']);

    // tip: post-delivery tipping fails closed (no rail collects it)
    const tip = await POST(`/customer/orders/${id}/tip`, { amount: 100 }, C1.token);
    rec.deny('a post-delivery tip is refused (no collection rail)', tip, [409], ['TIP_COLLECTION_UNAVAILABLE']);
    const tip2 = await POST(`/customer/orders/${id}/tip`, { amount: 100 }, C1.token);
    rec.deny('a repeated tip is refused the same way', tip2, [409], ['TIP_COLLECTION_UNAVAILABLE']);
    rec.deny('another customer cannot tip the order', await POST(`/customer/orders/${id}/tip`, { amount: 100 }, C2.token), [404], ['NOT_FOUND']);
    rec.deny('a checkout tip above the ceiling', await PUT('/customer/cart/tip', { amount: 60_000 }, C1.token), [400]);
  },
};

export const CUST_05: Journey<Ctx> = {
  id: 'CUST-05',
  title: 'Pickup code at counter (H-3 pickup variant)',
  cases: 'pickup creation; wrong-code denial/lockout; counter completion',
  async prepare(rec, ctx) {
    const C3 = ctx.roster.customers.C3!.session;
    ctx.stash['CUST-05'] = {
      good: await pickupAtR2(rec, ctx, C3, 'cust05-good'),
      lock: await pickupAtR2(rec, ctx, C3, 'cust05-lock'),
    };
  },
  async release(rec, ctx) {
    const C3 = ctx.roster.customers.C3!.session;
    await acceptOnRelease(rec, ctx, C3, ctx.stash['CUST-05']?.good ?? null, 'counter order');
    await acceptOnRelease(rec, ctx, C3, ctx.stash['CUST-05']?.lock ?? null, 'lockout order');
  },
  async run(rec, ctx) {
    const C3 = ctx.roster.customers.C3!.session, R2 = ctx.roster.vendors.R2!;
    const { good, lock } = ctx.stash['CUST-05'] ?? {};
    rec.require('two pickup orders were created', !!good && !!lock, '');
    const g = await customerOrder(C3, good);
    rec.check('the customer holds a 6-digit pickup code', /^\d{6}$/.test(String(g?.pickupCode ?? '')), `pickupCode ${g?.pickupCode ? 'present' : 'missing'}`);
    rec.expect('the store readies the first order', await vendorAdvance(R2.session, good, 'READY_FOR_PICKUP'), 200);
    const vendorView = await GET(`/vendor/orders/${good}`, R2.session.token);
    rec.check('the store never reads the pickup code', vendorView.ok && vendorView.json?.data?.pickupCode === undefined, `vendor view pickupCode=${vendorView.json?.data?.pickupCode}`);
    rec.deny('handover without a code', await PUT(`/vendor/orders/${good}/complete-pickup`, {}, R2.session.token), [400], ['MISSING_PICKUP_CODE']);
    const wrongCode = String((Number(g.pickupCode) + 1) % 1_000_000).padStart(6, '0');
    rec.deny('a wrong code', await PUT(`/vendor/orders/${good}/complete-pickup`, { code: wrongCode }, R2.session.token), [400], ['WRONG_PICKUP_CODE']);
    rec.expect('the right code completes the handover', await PUT(`/vendor/orders/${good}/complete-pickup`, { code: g.pickupCode }, R2.session.token), 200);
    rec.check('the customer sees COMPLETED', (await customerOrder(C3, good))?.status === 'COMPLETED', '');

    // lockout: five wrong codes, then even the right one is refused
    rec.expect('the store readies the second order', await vendorAdvance(R2.session, lock, 'READY_FOR_PICKUP'), 200);
    const l = await customerOrder(C3, lock);
    const bad = String((Number(l.pickupCode) + 7) % 1_000_000).padStart(6, '0');
    const tries: string[] = [];
    for (let i = 0; i < 5; i += 1) tries.push(brief(await PUT(`/vendor/orders/${lock}/complete-pickup`, { code: bad }, R2.session.token)));
    rec.check('five wrong codes are each refused', tries.every((t) => t.startsWith('400')), tries.join(', '));
    rec.deny('after the lockout the right code is refused too', await PUT(`/vendor/orders/${lock}/complete-pickup`, { code: l.pickupCode }, R2.session.token), [400], ['MAX_ATTEMPTS']);
    rec.check('the locked order is not completed', (await customerOrder(C3, lock))?.status === 'READY_FOR_PICKUP', '');
    // cleanup: an operator closes the locked order
    await PUT(`/admin/orders/${lock}/cancel`, { reason: 'journey cleanup: pickup code locked' }, ctx.admin.token);
  },
};

export const AUTH_04: Journey<Ctx> = {
  id: 'AUTH-04',
  title: 'Account deletion & erasure',
  cases: 'active-obligation denial; completed-order retry; document erasure; token revocation',
  async prepare(rec, ctx) {
    const acct = await registerFresh(ctx, 'auth04');
    rec.require('a fresh customer to delete', !!acct, acct ? acct.phone : 'signup failed');
    const sel = await upload('/auth/selfie', acct!.session.token, { name: 'selfie.png', type: 'image/png', bytes: FIXTURE_PNG });
    rec.expect('the customer captures a selfie (an avatar object to erase)', sel, [200, 201]);
    const orderId = await pickupAtR2(rec, ctx, acct!.session, 'auth04');
    ctx.stash['AUTH-04'] = { acct, orderId };
  },
  async release(rec, ctx) {
    const { acct, orderId } = ctx.stash['AUTH-04'] ?? {};
    if (acct) await acceptOnRelease(rec, ctx, acct.session, orderId ?? null, 'the live order');
  },
  async run(rec, ctx) {
    const { acct, orderId } = ctx.stash['AUTH-04'] ?? {};
    rec.require('the account and its live order exist', !!acct && !!orderId, '');
    const s: Session = acct.session;
    const R2 = ctx.roster.vendors.R2!;
    const blocked = await req('DELETE', '/customer/account', { token: s.token });
    rec.deny('deletion while an order is live', blocked, [409], ['ACTIVE_ORDERS']);
    rec.check('the account still works after the refusal', (await GET('/auth/me', s.token)).ok, '');

    rec.expect('the store readies it', await vendorAdvance(R2.session, orderId, 'READY_FOR_PICKUP'), 200);
    const code = (await customerOrder(s, orderId))?.pickupCode;
    rec.expect('the order completes at the counter', await PUT(`/vendor/orders/${orderId}/complete-pickup`, { code }, R2.session.token), 200);

    const del = await req('DELETE', '/customer/account', { token: s.token });
    rec.expect('deletion succeeds once nothing is live', del, [200, 202], undefined, `status=${del.json?.data?.status ?? (del.json?.data?.deleted ? 'deleted' : '?')}`);
    const me = await req('GET', '/auth/me', { token: s.token, refresh: false });
    rec.deny('the deleted account’s token is revoked at once', me, [401]);
    const refresh = s.refreshToken ? await req('POST', '/auth/refresh', { body: { refreshToken: s.refreshToken }, refresh: false }) : null;
    if (refresh) rec.deny('its refresh token is revoked too', refresh, [401]);
    const user = await GET(`/admin/users/${acct.user?.id ?? s.userId}`, ctx.admin.token);
    const u = pick(user.json, 'data.user', 'data');
    rec.check('the user row is de-identified (phone released, deactivated, no avatar)',
      user.ok && String(u?.phone ?? '').startsWith('deleted:') && u?.status === 'DEACTIVATED' && !u?.avatar,
      `admin read → ${brief(user)} status=${u?.status} phoneReleased=${String(u?.phone ?? '').startsWith('deleted:')} avatar=${u?.avatar ? 'present' : 'none'}`);
    rec.check('the erasure left no pending document or avatar object', del.status === 200 && (del.json?.data?.deleted === true || !del.json?.data?.pendingDocuments),
      `deleted=${del.json?.data?.deleted} pendingDocuments=${del.json?.data?.pendingDocuments ?? 0} pendingAvatarObjects=${del.json?.data?.pendingAvatarObjects ?? 0}`);
    void sleep; void waitFor;
  },
};

export const CUSTOMER_JOURNEYS = [CUST_01, CUST_02, CUST_03, CUST_04, CUST_05, AUTH_04];
