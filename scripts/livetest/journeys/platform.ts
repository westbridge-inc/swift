// Platform journeys [TASK-057]: PLAT-01 (tenant isolation / IDOR matrix) and
// PLAT-02 (worker restart / job recovery). PLAT-03 lives with auth.

import type { Journey } from '../journey.js';
import { GET, POST, PUT, DEL, req, brief, pick, placeOrder, orderIdsOf, ensureAddress, idemKey } from './common.js';
import type { Ctx } from './context.js';

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

    const cleanup = await POST(`/customer/orders/${orderId}/cancel`, { reason: 'journey cleanup' }, C1.session.token);
    rec.expect('the probe order cancels (cleanup)', cleanup, 200);
    rec.skipCase('cross-tenant', 'this target has one tenant (swift-default); a second tenant (e.g. the REVIEW tenant) is created only by an operator script (review:provision), never over HTTP, so a cross-tenant read cannot be staged by the runner');
    void pick;
  },
};

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
    rec.skipAll('the defining case is a worker crash mid-offer/hold and its recovery: the runner is an HTTP client on the private network with no Docker socket (by design), so it cannot kill or restart the worker; run the authorized controlled crash drill on the host (ledger hold) and re-read DLQ and order state afterwards');
  },
};

export const PLATFORM_JOURNEYS = [PLAT_01, PLAT_02];
