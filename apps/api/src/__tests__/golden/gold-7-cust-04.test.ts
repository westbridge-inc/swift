import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { nanoid } from 'nanoid';
import { createGolden } from './gold-7-helpers';

// ---------------------------------------------------------------------------
// GOLD-7 · CUST-04 — completed-order rating → public-review report → repeated
// tip refusal. A CASH pickup is completed through the kitchen/counter routes;
// all defining customer actions use the real mounted HTTP routes.
// No rail collects a post-delivery tip: TIP_COLLECTION_UNAVAILABLE must be
// repeatable and create neither an earning nor a fictitious amount owed.
// Phone +5920974nnn: audited against source literals and random ranges.
// Device/staging-only: real notification delivery and physical cash handover.
// ---------------------------------------------------------------------------
const h = createGolden('+5920974', 'gold7-cust04');
beforeAll(() => h.start());
afterAll(() => h.close());

describe('GOLD-7 · CUST-04 — rate, report and tip refusal', () => {
  it('rates only a completed purchase, reports its review once, and refuses both tip submissions without inventing money', async () => {
    const owner = await h.actor(['VENDOR_OWNER']);
    const store = await h.vendor(owner);
    const customer = await h.actor();
    const reporter = await h.actor();
    await h.fillCart(customer, { vendorId: store.vendorId, itemId: store.itemId });
    const placed = await h.call('POST', '/api/v1/customer/checkout', customer.token,
      { paymentMethod: 'CASH', fulfillmentSelections: { [store.vendorId]: 'PICKUP' } },
      { 'idempotency-key': `g7-rate-${nanoid(8)}` });
    expect(placed.statusCode, placed.json().error?.code).toBe(200);
    const id = placed.json().data.order.id as string;
    const premature = await h.call('POST', `/api/v1/customer/orders/${id}/rate`, customer.token, { vendorScore: 5 });
    expect(premature.statusCode).toBe(400);
    expect(premature.json().error.code).toBe('ORDER_NOT_COMPLETE');
    // LIFECYCLE_V2's hold is a separate journey, as in GOLD-6 CUST-05.
    await h.sys(() => h.app.prisma.order.update({ where: { id }, data: { holdExpiresAt: null } }));
    for (const [step, status] of [['accept', 'ACCEPTED'], ['preparing', 'PREPARING'], ['ready', 'READY_FOR_PICKUP']]) {
      const next = await h.call('PUT', `/api/v1/vendor/orders/${id}/${step}`, owner.token, undefined, { 'x-vendor-id': store.vendorId });
      expect(next.statusCode, next.json().error?.code).toBe(200);
      expect(next.json().data.status).toBe(status);
    }
    const detail = await h.call('GET', `/api/v1/customer/orders/${id}`, customer.token);
    expect(detail.statusCode).toBe(200);
    const completed = await h.call('PUT', `/api/v1/vendor/orders/${id}/complete-pickup`, owner.token,
      { code: detail.json().data.pickupCode }, { 'x-vendor-id': store.vendorId });
    expect(completed.statusCode).toBe(200);
    const rate = await h.call('POST', `/api/v1/customer/orders/${id}/rate`, customer.token,
      { vendorScore: 5, vendorComment: 'Fresh meal and a friendly counter' });
    expect(rate.statusCode, rate.json().error?.code).toBe(200);
    const rating = await h.sys(() => h.app.prisma.rating.findFirstOrThrow({ where: { orderId: id, raterId: customer.userId } }));
    expect(rating).toMatchObject({ vendorId: store.vendorId, type: 'CUSTOMER_TO_VENDOR', score: 5, isPublic: true });
    const repeatRating = await h.call('POST', `/api/v1/customer/orders/${id}/rate`, customer.token, { vendorScore: 1 });
    expect(repeatRating.statusCode).toBe(409);
    expect(repeatRating.json().error.code).toBe('ALREADY_RATED');
    const unchangedRatings = await h.sys(() => h.app.prisma.rating.findMany({ where: { orderId: id } }));
    expect(unchangedRatings.map((r) => [r.id, r.score])).toEqual([[rating.id, 5]]);
    const report = await h.call('POST', `/api/v1/customer/ratings/${rating.id}/report`, reporter.token,
      { reason: 'FALSE_CLAIM', note: 'Please review this claim' });
    expect(report.statusCode, report.json().error?.code).toBe(200);
    expect(report.json().data).toMatchObject({ ratingId: rating.id, reporterId: reporter.userId, status: 'PENDING', reason: 'FALSE_CLAIM' });
    const reportAgain = await h.call('POST', `/api/v1/customer/ratings/${rating.id}/report`, reporter.token, { reason: 'FALSE_CLAIM' });
    expect(reportAgain.statusCode).toBe(200);
    expect(reportAgain.json().data.id).toBe(report.json().data.id);
    expect(await h.sys(() => h.app.prisma.ratingReport.count({ where: { ratingId: rating.id } }))).toBe(1);
    const before = await h.sys(() => h.app.prisma.order.findUniqueOrThrow({ where: { id } }));
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const tip = await h.call('POST', `/api/v1/customer/orders/${id}/tip`, customer.token, { amount: 300 });
      expect(tip.statusCode).toBe(409);
      expect(tip.json().error.code).toBe('TIP_COLLECTION_UNAVAILABLE');
    }
    expect(JSON.stringify(await h.sys(() => h.app.prisma.order.findUniqueOrThrow({ where: { id } }))) === JSON.stringify(before)).toBe(true);
    expect(await h.sys(() => h.app.prisma.earning.count({ where: { orderId: id, type: 'TIP' } }))).toBe(0);
    expect((await h.call('POST', `/api/v1/customer/orders/${id}/tip`, reporter.token, { amount: 300 })).statusCode).toBe(404);
  });
});
