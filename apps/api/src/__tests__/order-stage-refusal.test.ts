import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { orderStageRefusal, STEP_GONE } from '../modules/order/order-status-words';

// [BUG-HUNT F12] A refusal about an order's stage is said in words. The status code never reaches a person.
describe('orderStageRefusal', () => {
  it('says where the order is and what that means for this tap', () => {
    expect(orderStageRefusal('CANCELLED', 'it cannot be accepted')).toBe('This order is cancelled, so it cannot be accepted.');
    expect(orderStageRefusal('RIDER_ARRIVED_PICKUP', 'it cannot be cancelled')).toBe('This order is with a rider, so it cannot be cancelled.');
    expect(orderStageRefusal('RIDE_IN_PROGRESS', STEP_GONE, 'ride')).toBe('This ride is under way, so this step no longer applies.');
  });

  it('a status it does not know still reads as words, never a code', () => {
    expect(orderStageRefusal('SOME_NEW_STATE', 'it cannot be accepted')).toBe('This order has moved on, so it cannot be accepted.');
  });

  it('no refusal in the order routes prints a status again', () => {
    const files = ['modules/vendor/vendor.routes.ts', 'modules/rider/rider.routes.ts', 'modules/driver/driver.routes.ts', 'modules/order/order.service.ts', 'modules/order/picking.service.ts', 'modules/user/customer.routes.ts'];
    for (const file of files) {
      const text = readFileSync(join(__dirname, '..', file), 'utf8');
      expect(text.match(/AppError\(\s*\d+,\s*'[A-Z_]+',\s*`[^`]*\$\{[a-zA-Z.]*(?:status|current)\}[^`]*`/gi) ?? [], file).toEqual([]);
    }
  });
});
