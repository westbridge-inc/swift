// Platform journeys [TASK-057]: PLAT-01 (tenant isolation / IDOR matrix) and
// PLAT-02 (worker restart / job recovery). PLAT-03 lives with auth.

import type { Journey, Recorder } from '../journey.js';
import { login, type Res, type Session } from '../client.js';
import { GET, POST, PUT, DEL, req, brief, pick, placeOrder, orderIdsOf, ensureAddress, idemKey, clearCart } from './common.js';
import type { Ctx } from './context.js';
import type { DrillManifest } from '../drills.js';

const FORGED_CUID = 'cl0000000000000000000forged';

export const PLAT_01: Journey<Ctx> = {
  id: 'PLAT-01',
  estimateSeconds: 45,
  title: 'Tenant isolation / IDOR denial matrix',
  cases: 'cross-role; cross-account; cross-tenant; forged object ID',
  async run(rec, ctx) {
    const C1 = ctx.roster.customers.C1!, C2 = ctx.roster.customers.C2!.session;
    const R1 = ctx.roster.vendors.R1!, R2 = ctx.roster.vendors.R2!;
    const rider = Object.values(ctx.roster.movers).find((m) => m.kind === 'rider');
    const driver = Object.values(ctx.roster.movers).find((m) => m.kind === 'driver');

    // A C1 order at R2 (pickup) and C1's address: the objects others try to reach.
    const item = ctx.world.items.R2;
    rec.require('an order to probe', !!item && !!R2.vendorId, ctx.world.notReady.R2 ?? '');
    const placed = await placeOrder(C1.session, R2.vendorId!, item!.itemId, R2.lat, R2.lng, { pickup: true, key: idemKey(ctx.runId, 'plat01') });
    const orderId = orderIdsOf(placed)[0];
    rec.require('C1 places the probe order', !!orderId, brief(placed));
    const addrId = await ensureAddress(C1.session, C1.lat, C1.lng);

    // cross-account (customer ↔ customer)
    rec.deny('C2 reads C1’s order', await GET(`/customer/orders/${orderId}`, C2.token), [404]);
    rec.deny('C2 reads C1’s receipt', await GET(`/customer/orders/${orderId}/receipt`, C2.token), [404]);
    rec.deny('C2 cancels C1’s order', await POST(`/customer/orders/${orderId}/cancel`, {}, C2.token), [404]);
    rec.deny('C2 reorders C1’s order', await POST(`/customer/orders/${orderId}/reorder`, {}, C2.token), [404]);
    if (addrId) {
      rec.deny('C2 edits C1’s address', await PUT(`/customer/addresses/${addrId}`, { label: 'pwned' }, C2.token), [404]);
      rec.deny('C2 deletes C1’s address', await DEL(`/customer/addresses/${addrId}`, C2.token), [404]);
      const still = await GET('/customer/addresses', C1.session.token);
      rec.check('C1’s address is untouched', (still.json?.data ?? []).some((a: any) => a.id === addrId && a.label !== 'pwned'), '');
    }
    const own = await GET(`/customer/orders/${orderId}`, C1.session.token);
    rec.check('the owner still reads it', own.ok && own.json?.data?.status === 'PENDING', `→ ${brief(own)} status=${own.json?.data?.status}`);

    // cross-role (a customer on partner/admin surfaces)
    rec.deny('customer → vendor order board', await GET('/vendor/orders', C2.token), [403, 404]);
    rec.deny('customer → accept a vendor order', await req('PUT', `/vendor/orders/${orderId}/accept`, { token: C2.token, body: {} }), [403, 404]);
    rec.deny('customer → rider job board', await GET('/rider/orders/available', C2.token), [403, 404]);
    rec.deny('customer → driver ride board', await GET('/driver/rides/available', C2.token), [403, 404]);
    rec.deny('customer → admin users', await GET('/admin/users', C2.token), [403]);
    rec.deny('vendor owner → admin orders', await GET('/admin/orders', R1.session.token), [403]);
    if (rider) rec.deny('rider → vendor board', await GET('/vendor/orders', rider.session.token), [403, 404]);
    if (rider) rec.deny('rider → admin', await GET('/admin/dashboard/overview', rider.session.token), [403]);
    if (driver) rec.deny('driver → rider job board', await GET('/rider/orders/available', driver.session.token), [403, 404]);

    // cross-account (vendor ↔ vendor): R1 cannot act on R2's order, even released.
    rec.deny('another store reads the order', await GET(`/vendor/orders/${orderId}`, R1.session.token), [404]);
    rec.deny('another store rejects the order', await req('PUT', `/vendor/orders/${orderId}/reject`, { token: R1.session.token, body: { reason: 'x' } }), [404]);

    // forged object ids
    rec.deny('a forged order id', await GET(`/customer/orders/${FORGED_CUID}`, C1.session.token), [404]);
    rec.deny('a forged vendor order id', await GET(`/vendor/orders/${FORGED_CUID}`, R2.session.token), [404]);
    rec.deny('a forged admin order id', await GET(`/admin/orders/${FORGED_CUID}`, ctx.admin.token), [404]);
    rec.deny('a path-shaped id', await GET(`/customer/orders/${encodeURIComponent('../../admin/users')}`, C1.session.token), [400, 404]);

    // cross-tenant [STG-DRILLS D6]: a second operator's store, customer, order and partner.
    if (ctx.drill) {
      await crossTenant(rec, ctx, ctx.drill.tenant, { orderId: orderId!, C1: C1.session, C1phone: C1.phone, R2: R2.session, R2phone: R2.phone, R2vendorId: R2.vendorId! });
    } else {
      rec.skipCase('cross-tenant', 'no drill fixtures on this run: the second tenant (swift-drill) is made on the server by deploy/drill-fixtures.sh create and handed over as LIVETEST_DRILL_MANIFEST; no HTTP route creates a tenant');
    }

    const cleanup = await POST(`/customer/orders/${orderId}/cancel`, { reason: 'journey cleanup' }, C1.session.token);
    rec.expect('the probe order cancels (cleanup)', cleanup, 200);
    void pick;
  },
};

/**
 * [STG-DRILLS D6] The cross-tenant denial matrix, both ways. Every foreign id
 * must answer 404 (or a refusal), and no response to a foreign caller may
 * carry the other tenant's data — names, phones, the order number, and in
 * lists the ids themselves (a 404 body echoes the id asked for, so single-id
 * probes are checked for data, lists for ids too).
 */
async function crossTenant(
  rec: Recorder,
  ctx: Ctx,
  t: DrillManifest['tenant'],
  own: { orderId: string; C1: Session; C1phone: string; R2: Session; R2phone: string; R2vendorId: string },
): Promise<void> {
  const drillData = [t.store.name, t.store.itemName, t.customer.phone, t.storeOwner.phone, t.partner.phone, t.order.orderNumber];
  const drillIds = [t.order.orderId, t.store.vendorId, t.store.itemId, t.customer.userId, t.storeOwner.userId, t.partner.userId, t.partner.riderId];
  const leaks: string[] = [];
  const watch = (label: string, r: Res, extra: string[] = []) => {
    const found = [...drillData, ...extra].filter((x) => x && r.text.includes(x));
    if (found.length) leaks.push(`${label}: ${found.join(', ')}`);
    return r;
  };
  const C1 = own.C1.token, R2 = own.R2.token, A = ctx.admin.token;
  const ourData = [own.C1phone, own.R2phone];
  const ourIds = [own.orderId, own.R2vendorId];

  // A default-tenant customer, store and operator reach for the drill tenant's objects.
  rec.deny('cross-tenant: a customer reads another operator’s order', watch('customer order', await GET(`/customer/orders/${t.order.orderId}`, C1)), [404]);
  rec.deny('cross-tenant: a customer reads its receipt', watch('customer receipt', await GET(`/customer/orders/${t.order.orderId}/receipt`, C1)), [404]);
  rec.deny('cross-tenant: a customer cancels it', watch('customer cancel', await POST(`/customer/orders/${t.order.orderId}/cancel`, { reason: 'x' }, C1)), [404]);
  rec.deny('cross-tenant: a customer reorders it', watch('customer reorder', await POST(`/customer/orders/${t.order.orderId}/reorder`, {}, C1)), [404]);
  rec.deny('cross-tenant: a customer opens another operator’s store', watch('customer store', await GET(`/customer/vendors/${t.store.vendorId}`, C1)), [404]);
  await clearCart(own.C1);
  rec.deny('cross-tenant: a customer adds another operator’s item to the cart', watch('customer cart add', await POST('/customer/cart/items', { vendorId: t.store.vendorId, itemId: t.store.itemId, quantity: 1 }, C1)), [400, 404]);
  const cart = watch('customer cart', await GET('/customer/cart', C1), drillIds);
  rec.check('cross-tenant: the cart holds nothing of the other operator', cart.ok, `→ ${brief(cart)}`);
  rec.deny('cross-tenant: a store reads another operator’s order', watch('store order', await GET(`/vendor/orders/${t.order.orderId}`, R2)), [404]);
  rec.deny('cross-tenant: a store accepts it', watch('store accept', await req('PUT', `/vendor/orders/${t.order.orderId}/accept`, { token: R2, body: {} })), [403, 404]);
  rec.deny('cross-tenant: the operator reads the other operator’s order', watch('admin order', await GET(`/admin/orders/${t.order.orderId}`, A)), [404]);
  rec.deny('cross-tenant: the operator reads its customer', watch('admin user', await GET(`/admin/users/${t.customer.userId}`, A)), [404]);
  rec.deny('cross-tenant: the operator reads its store', watch('admin store', await GET(`/admin/vendors/${t.store.vendorId}`, A)), [404]);
  rec.deny('cross-tenant: the operator reads its partner', watch('admin rider', await GET(`/admin/riders/${t.partner.riderId}`, A)), [403, 404]);
  const users = watch('admin user search', await GET(`/admin/users?search=${encodeURIComponent(t.customer.phone)}`, A), drillIds);
  const stores = watch('admin store search', await GET(`/admin/vendors?search=${encodeURIComponent(t.store.name)}`, A), drillIds);
  const orders = watch('admin order search', await GET(`/admin/orders?search=${encodeURIComponent(t.order.orderNumber)}`, A), drillIds);
  rec.check('cross-tenant: the operator’s searches answer, and find nothing of the other operator', users.ok && stores.ok && orders.ok, `users ${brief(users)} · stores ${brief(stores)} · orders ${brief(orders)}`);

  // The drill tenant's own customer reaches back for the default tenant's objects.
  let foreign: string | null = null;
  try {
    foreign = (await login(t.customer.phone)).token;
  } catch (e: any) {
    rec.check('cross-tenant: the other operator’s customer signs in (dev code, private instance)', false, String(e?.message ?? e).slice(0, 200));
  }
  if (foreign) {
    // A 404 body echoes the id asked for: by-id probes are checked for our data, lists for our ids too.
    const back = (label: string, r: Res, ids: string[] = []) => {
      const found = [...ourData, ...ids].filter((x) => x && r.text.includes(x));
      if (found.length) leaks.push(`${label}: ${found.join(', ')}`);
      return r;
    };
    rec.deny('cross-tenant (reverse): their customer reads our order', back('reverse order', await GET(`/customer/orders/${own.orderId}`, foreign)), [404]);
    rec.deny('cross-tenant (reverse): their customer cancels our order', back('reverse cancel', await POST(`/customer/orders/${own.orderId}/cancel`, { reason: 'x' }, foreign)), [404]);
    rec.deny('cross-tenant (reverse): their customer opens our store', back('reverse store', await GET(`/customer/vendors/${own.R2vendorId}`, foreign)), [404]);
    const list = back('reverse store list', await GET('/customer/vendors', foreign), ourIds);
    rec.check('cross-tenant (reverse): their marketplace lists none of our stores', list.ok, `→ ${brief(list)}`);
    const mine = await GET('/customer/orders', foreign);
    rec.check('cross-tenant (reverse): their own order stays theirs', mine.ok && mine.text.includes(t.order.orderId), `→ ${brief(mine)} own order listed=${mine.text.includes(t.order.orderId)}`);
  }
  rec.check('cross-tenant: no response to a foreign caller carried the other tenant’s data', leaks.length === 0, leaks.length ? `LEAKED — ${leaks.join(' | ')}` : 'names, phones, order numbers and (in lists) ids checked in every body');
}

export const PLAT_02: Journey<Ctx> = {
  id: 'PLAT-02',
  estimateSeconds: 20,
  title: 'Worker restart / job recovery mid-flow',
  cases: 'worker crash mid-offer/hold; DLQ; retry; once-only completion',
  async run(rec, ctx) {
    const dlq = await GET('/admin/dlq', ctx.admin.token);
    rec.expect('the operator can read the dead-letter queues', dlq, 200, undefined, `${Array.isArray(dlq.json?.data) ? dlq.json.data.length : '?'} failed job(s) listed`);
    const rows: any[] = Array.isArray(dlq.json?.data) ? dlq.json.data : [];
    rec.check('every listed job states its recovery class', rows.every((r) => r.recovery != null), `${rows.length} row(s)`);
    rec.deny('a non-founder cannot read the DLQ', await GET('/admin/dlq', ctx.roster.customers.C2!.session.token), [403]);
    rec.deny('requeue of a job that does not exist', await POST(`/admin/dlq/dispatch/${FORGED_CUID}/requeue`, {}, ctx.admin.token), [400, 404]);
    rec.skipAll('the defining case is a worker crash mid-offer and its recovery: the runner is an HTTP client on the private network with no Docker socket (by design), so it cannot kill the worker. deploy/drill-crash.sh runs it on the host after this run (the same run id) and replaces this row with its own PLAT-02 result');
  },
};

export const PLATFORM_JOURNEYS = [PLAT_01, PLAT_02];
