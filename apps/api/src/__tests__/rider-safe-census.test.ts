import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ALGO_DEFAULTS } from '../modules/algo/algo-config';
import { ADMIN_ROUTE_AUTHORITY, ADMIN_ACTION_CLASSES } from '../modules/admin/admin-authority';
import { ALERT_CLASS_KINDS } from '../providers/notifications/alert-class';

// ---------------------------------------------------------------------------
// [RIDER-SAFE · COORD rulings 29 Oct 2026] The wiring a DB test cannot see:
// every door that frees a rider wakes the oldest waiting order near them, the
// checkout reads the honest capacity, the promise carries the rider wait, the
// operations page rides the supply-watch cadence, and the dials ship at the
// ruled launch values.
// ---------------------------------------------------------------------------

const src = (p: string) => readFileSync(resolve(__dirname, '..', p), 'utf8');

describe('[RIDER-SAFE] the wiring', () => {
  it('a rider going online, or handing over a bag, wakes the waiting orders near them', () => {
    const rider = src('modules/rider/rider.routes.ts');
    const goOnline = rider.slice(rider.indexOf("app.post('/go-online'"), rider.indexOf("app.post('/go-offline'"));
    expect(goOnline).toMatch(/if \(updated\.isAvailable\) await kickWaiting\(rider\.id\);/);
    const delivered = rider.slice(rider.indexOf("app.put('/orders/:id/delivered'"), rider.indexOf('// 7. ORDER HISTORY'));
    expect(delivered).toMatch(/if \(!replayed\) \{[\s\S]*await kickWaiting\(rider\.id\);[\s\S]*\}/);
    expect(rider).toMatch(/app\.dispatchQueue\.add\('dispatch-order', \{ orderId \}, \{ jobId, priority/);
  });

  it('checkout asks the honest capacity (the customer routes wire it), and the promise carries the wait', () => {
    const routes = src('modules/user/customer.routes.ts');
    expect(routes).toMatch(/\(probe\) => dispatchForAvailability\.getDeliveryCapacity\(probe\)/);
    const order = src('modules/order/order.service.ts');
    expect(order).toMatch(/riderWaitSeconds: riderWaitByVendor\.get\(plan\.vendor\.id\) \?\? 0/);
    expect(order).toMatch(/if \(capacity\.level === 'BUSY'\) riderWaitByVendor\.set\(vendor\.id, capacity\.riderWaitMinutes \* 60\)/);
    // The two switches are not behind the availability flag.
    const gate = order.slice(order.indexOf('[RIDER-SAFE 5] Swift'), order.indexOf("process.env['DISPATCH_AVAILABILITY'] === '1'"));
    expect(gate).toMatch(/deliveryPausedAt\(/);
    expect(gate).toMatch(/storeRiderBacklog\(/);
  });

  it('the riders-short page rides the 2-minute supply-watch scan, through opsPageOnce', () => {
    const queue = src('jobs/queue.ts');
    const scan = queue.slice(queue.indexOf("job.name === 'supply-watch-scan'"), queue.indexOf('const offerWorker = buildWorker('));
    expect(scan).toMatch(/pageRidersShort\(\{[\s\S]*pageOnce: \(key, ttl, page\) => opsPageOnce\(ctx, key, ttl, page\)/);
  });

  it('the food slow lane is armed in publishExhaustion, after the taxi lane and before the terminal notices', () => {
    const d = src('modules/dispatch/dispatch.service.ts');
    const taxi = d.indexOf('[R-05 certification catch] TAXI slow lane');
    const food = d.indexOf('[RIDER-SAFE 3 · COORD ruling 29 Oct 2026] FOOD slow lane');
    const notice = d.indexOf("title: 'No movers available right now'");
    expect(taxi).toBeGreaterThan(0);
    expect(food).toBeGreaterThan(taxi);
    expect(notice).toBeGreaterThan(food);
    expect(d.slice(food, notice)).toMatch(/this\.scheduleRedispatch\(order\.id, FOOD_RESCAN_MS/);
  });

  it('the dials ship at the ruled launch values', () => {
    expect(ALGO_DEFAULTS['delivery.avgRiderLegMinutes']).toBe(25);
    expect(ALGO_DEFAULTS['delivery.maxRiderWaitMinutes']).toBe(30);
    expect(ALGO_DEFAULTS['delivery.vendorBacklogCap']).toBe(3);
    expect(ALGO_DEFAULTS['delivery.waitingGraceMinutes']).toBe(3);
    expect(ALGO_DEFAULTS['delivery.ridersShortWaiting']).toBe(5);
    expect(ALGO_DEFAULTS['delivery.ridersShortExhaustions']).toBe(3);
    expect(ALGO_DEFAULTS['delivery.pause']).toEqual({ platform: false, zoneIds: [] });
  });

  it('the pause is a reasoned admin action; the riders-short page is a classified ops kind', () => {
    const put = ADMIN_ROUTE_AUTHORITY['PUT /delivery-pause'];
    expect(put?.cls).toBe('C3');
    expect(ADMIN_ACTION_CLASSES[put!.cls].requiresReason).toBe(true);
    expect(ADMIN_ROUTE_AUTHORITY['GET /delivery-pause']?.cls).toBe('C0');
    expect(ALERT_CLASS_KINDS.standard).toContain('ops_riders_short');
  });

  it('customers are told levels and minutes, never rider counts', () => {
    const routes = src('modules/user/customer.routes.ts');
    const route = routes.slice(routes.indexOf("app.get('/delivery-availability'"), routes.indexOf("app.post('/orders/:id/convert-to-pickup'"));
    expect(route.length).toBeGreaterThan(100);
    expect(route).not.toMatch(/counts/);
  });
});
