import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
it('keeps cached history and stores visible when a background refresh fails', () => {
  const read = (name: string) => readFileSync(new URL(`../modules/${name}`, import.meta.url), 'utf8');
  expect(read('orders/screens/OrdersHistoryScreen.tsx')).toContain('orders.isError && !orders.data && live.length === 0');
  expect(read('shop/screens/CategoryFeedScreen.tsx')).toContain('vendorsQ.isError && !vendorsQ.data');
  expect(read('shop/screens/SearchScreen.tsx')).toContain('vendors.isError && !vendors.data');
});
it('restored active orders use a saved summary before live controls can render', () => {
  const delivery = readFileSync(new URL('../modules/orders/screens/DeliveryScreen.tsx', import.meta.url), 'utf8');
  expect(delivery.indexOf('if (isOfflineSnapshot(o)) return')).toBeGreaterThan(0);
  expect(delivery.indexOf('if (isOfflineSnapshot(o)) return')).toBeLessThan(delivery.indexOf('const mmgCancellationAmbiguous'));
  const summary = readFileSync(new URL('../components/SavedOrderSummary.tsx', import.meta.url), 'utf8');
  expect(summary).toContain('Last saved status:');
  expect(summary).toContain('Reconnect to refresh tracking');
  expect(summary).not.toMatch(/ridePin|paymentAction|canCancel/);
});
