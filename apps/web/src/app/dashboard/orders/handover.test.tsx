import { screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import OrdersPage from './page';
import { mockApi, renderWithQuery, stubAudioContext, type ApiRequest } from '@/test/test-utils';
import { wireVendorOrder } from '@/test/vendor-wire-fixtures';

// ---------------------------------------------------------------------------
// [STORE-DASH · owner ruling 22 Oct 19:45Z, O-2] The store's hand-overs on the
// web dashboard, the app's buttons and words (server contract STORE-FLOW O-2):
//   - takeaway with the store's "Ask for the pickup code" OFF: "Handed to
//     customer" in one tap from the card or the window, after the name and
//     order-number check — PUT complete-pickup with NO code;
//   - a Swift-rider delivery with its rider assigned: the rider's photo, first
//     name and vehicle, then "Handed to rider" — PUT handed-to-rider;
//   - the setting itself, for owners and managers, once the server serves it;
//   - an older server (no new fields): exactly today's screens.
// ---------------------------------------------------------------------------

const writes: Array<{ method: string; path: string; body: unknown }> = [];
const rider = { user: { firstName: 'Devon', lastName: 'R', phone: null }, vehicleMake: 'Honda', vehicleModel: 'CG125', vehicleColor: 'Red', licensePlate: 'PAB 1234', photoUrl: 'https://cdn.test/signed/rider.jpg?sig=1' };
const takeaway = (over: Record<string, unknown>) => wireVendorOrder({ status: 'READY_FOR_PICKUP', fulfillment: 'PICKUP', deliveryAddress: null, customer: { id: 'c-1', firstName: 'Asha', lastName: 'K' }, ...over });
const riderDelivery = (over: Record<string, unknown>) => wireVendorOrder({
  status: 'RIDER_ARRIVED_PICKUP', fulfillment: 'DELIVERY', fulfillmentMode: 'PLATFORM_RIDER', riderId: 'r-1', rider,
  preparingAt: '2026-10-23T09:00:00.000Z', readyAt: '2026-10-23T09:10:00.000Z', handedToRiderAt: null, ...over,
});

function api(orders: Array<Record<string, unknown>>, store: { role?: string; requirePickupCode?: boolean } = {}) {
  const { role = 'OWNER' } = store;
  return mockApi((request: ApiRequest) => {
    const { method, url, init } = request;
    const path = url.pathname.replace('/api/v1', '');
    if (method !== 'GET') { writes.push({ method, path, body: init?.body ? JSON.parse(String(init.body)) : null }); return { body: { success: true, data: {} } }; }
    if (path === '/vendor/stores') {
      return { body: { success: true, data: { stores: [{ id: 'store-1', name: 'Sample Kitchen', vendorType: 'RESTAURANT', isCurrentlyOpen: true, acceptingOrders: true, city: null, isVerified: true }], selectedId: 'store-1', myRole: role } } };
    }
    if (path === '/vendor/profile') {
      return { body: { success: true, data: { id: 'owner-1', userId: 'user-1', myRole: role, vendors: [{
        id: 'store-1', name: 'Sample Kitchen', vendorType: 'RESTAURANT', status: 'ACTIVE', isVerified: true, isCurrentlyOpen: true, acceptingOrders: true, selfDeliveryEnabled: false,
        ...('requirePickupCode' in store ? { requirePickupCode: store.requirePickupCode } : {}),
        operatingHours: [], _count: { orders: 40, items: 3 },
      }] } } };
    }
    if (path === '/vendor/orders') return { body: { success: true, data: orders, meta: { total: orders.length } } };
    if (path.startsWith('/vendor/orders/')) return { body: { success: true, data: orders.find((o) => `/vendor/orders/${o.id}` === path) ?? orders[0] } };
    return { status: 404, body: { success: false } };
  });
}
async function card(orderNumber: string, view: ReturnType<typeof renderWithQuery>) {
  const later = await screen.findByText(/View later/).catch(() => null);
  if (later) await view.user.click(later);
  await screen.findByText(`#${orderNumber}`, { selector: 'p' });
  return (await screen.findAllByRole('article')).find((a) => a.textContent?.includes(`#${orderNumber}`))!;
}
async function openWindow(orderNumber: string, view: ReturnType<typeof renderWithQuery>) {
  await card(orderNumber, view);
  await view.user.click(await screen.findByText(`#${orderNumber}`, { selector: 'p' }));
  return screen.findByRole('dialog', { name: 'Order details' });
}
const CHECK_NAME = 'Check the name before you hand it over: Asha · order #SW-6001';

beforeEach(async () => {
  writes.length = 0;
  stubAudioContext();
  (await import('@/lib/auth')).setSelectedStore('store-1');
});

describe('[O-2] the card: one-tap hand-overs (#2033 F S4-2)', () => {
  it('pickup code off: the name check, then "Handed to customer" sends complete-pickup with NO code', async () => {
    api([takeaway({ id: 'o-1', orderNumber: 'SW-6001', pickupCodeRequired: false })]);
    const view = renderWithQuery(<OrdersPage />);
    const c = await card('SW-6001', view);
    expect(within(c).getByText(CHECK_NAME)).toBeTruthy();
    expect(within(c).queryByRole('button', { name: 'Mark picked up' })).toBeNull();
    await view.user.click(within(c).getByRole('button', { name: 'Handed to customer' }));
    await waitFor(() => expect(writes).toEqual([{ method: 'PUT', path: '/vendor/orders/o-1/complete-pickup', body: {} }]));
    expect(screen.queryByRole('dialog', { name: 'Order details' })).toBeNull();
  });

  it('a Swift rider at the counter: the rider to check, then "Handed to rider" sends handed-to-rider', async () => {
    api([riderDelivery({ id: 'o-2', orderNumber: 'SW-6002' })]);
    const view = renderWithQuery(<OrdersPage />);
    const c = await card('SW-6002', view);
    const check = within(c).getByTestId('rider-handover-line');
    expect(check.textContent).toContain('Check the rider before you hand it over:');
    expect(check.textContent).toContain('Devon — Red Honda CG125 · PAB 1234');
    expect(within(check).getByRole('img', { name: 'Photo of Devon' }).getAttribute('src')).toBe('https://cdn.test/signed/rider.jpg?sig=1');
    await view.user.click(within(c).getByRole('button', { name: 'Handed to rider' }));
    await waitFor(() => expect(writes).toEqual([{ method: 'PUT', path: '/vendor/orders/o-2/handed-to-rider', body: {} }]));
  });

  it('once marked: the card says it went, no button and no check', async () => {
    api([riderDelivery({ id: 'o-3', orderNumber: 'SW-6003', handedToRiderAt: '2026-10-23T09:15:00.000Z' })]);
    const view = renderWithQuery(<OrdersPage />);
    const c = await card('SW-6003', view);
    expect(within(c).getByText('Handed to the rider')).toBeTruthy();
    expect(within(c).queryByRole('button', { name: 'Handed to rider' })).toBeNull();
    expect(within(c).queryByTestId('rider-handover-line')).toBeNull();
  });

  it('control: pickup code on — "Mark picked up" opens the window for the code', async () => {
    api([takeaway({ id: 'o-4', orderNumber: 'SW-6004', pickupCodeRequired: true })]);
    const view = renderWithQuery(<OrdersPage />);
    const c = await card('SW-6004', view);
    expect(within(c).queryByRole('button', { name: 'Handed to customer' })).toBeNull();
    await view.user.click(within(c).getByRole('button', { name: 'Mark picked up' }));
    expect(await screen.findByRole('dialog', { name: 'Order details' })).toBeTruthy();
    expect(writes).toEqual([]);
  });

  it('control: an older server (no new fields) — today\'s card: "Mark picked up", no rider check', async () => {
    const { handedToRiderAt: _gone, ...oldDelivery } = riderDelivery({ id: 'o-6', orderNumber: 'SW-6006' });
    api([takeaway({ id: 'o-5', orderNumber: 'SW-6005' }), oldDelivery]);
    const view = renderWithQuery(<OrdersPage />);
    const t = await card('SW-6005', view);
    expect(within(t).getByRole('button', { name: 'Mark picked up' })).toBeTruthy();
    expect(within(t).queryByText(/Check the name before you hand it over/)).toBeNull();
    const d = await card('SW-6006', view);
    expect(within(d).queryByRole('button', { name: 'Handed to rider' })).toBeNull();
    expect(within(d).queryByTestId('rider-handover-line')).toBeNull();
  });
});

describe('[O-2] the order window', () => {
  it('pickup code off: the name check instead of the code box; "Handed to customer" sends NO code', async () => {
    api([takeaway({ id: 'o-1', orderNumber: 'SW-6001', pickupCodeRequired: false })]);
    const view = renderWithQuery(<OrdersPage />);
    const dialog = await openWindow('SW-6001', view);
    expect(within(dialog).getByText(CHECK_NAME)).toBeTruthy();
    expect(within(dialog).queryByRole('textbox', { name: /code/i })).toBeNull();
    await view.user.click(within(dialog).getByRole('button', { name: 'Handed to customer' }));
    await waitFor(() => expect(writes).toEqual([{ method: 'PUT', path: '/vendor/orders/o-1/complete-pickup', body: {} }]));
  });

  it('a Swift rider at the counter: the rider to check in the rider block; "Handed to rider"', async () => {
    api([riderDelivery({ id: 'o-2', orderNumber: 'SW-6002' })]);
    const view = renderWithQuery(<OrdersPage />);
    const dialog = await openWindow('SW-6002', view);
    const block = within(dialog).getByRole('region', { name: 'Rider' });
    expect(within(block).getByTestId('rider-handover-line').textContent).toContain('Devon — Red Honda CG125 · PAB 1234');
    await view.user.click(within(dialog).getByRole('button', { name: 'Handed to rider' }));
    await waitFor(() => expect(writes).toEqual([{ method: 'PUT', path: '/vendor/orders/o-2/handed-to-rider', body: {} }]));
  });

  it('control: pickup code on — the code is still typed and sent', async () => {
    api([takeaway({ id: 'o-4', orderNumber: 'SW-6004', pickupCodeRequired: true })]);
    const view = renderWithQuery(<OrdersPage />);
    const dialog = await openWindow('SW-6004', view);
    expect(within(dialog).getByText('Customer collects with a pickup code.')).toBeTruthy();
    expect(within(dialog).queryByRole('button', { name: 'Handed to customer' })).toBeNull();
    expect(within(dialog).getByRole('button', { name: 'Mark picked up' })).toHaveProperty('disabled', true);
  });
});

describe('[O-2] "Ask for the pickup code" (owners and managers)', () => {
  it('off by default; one tap turns it on through the store profile', async () => {
    api([], { requirePickupCode: false });
    const view = renderWithQuery(<OrdersPage />);
    const control = await screen.findByRole('switch', { name: 'Ask for the pickup code' });
    expect(control.getAttribute('aria-checked')).toBe('false');
    expect(screen.getByText('You hand takeaway orders over after checking the customer’s first name and order number.')).toBeTruthy();
    await view.user.click(control);
    await waitFor(() => expect(writes).toEqual([{ method: 'PUT', path: '/vendor/profile', body: { requirePickupCode: true } }]));
  });

  it('on: says so, and one tap turns it off', async () => {
    api([], { requirePickupCode: true });
    const view = renderWithQuery(<OrdersPage />);
    const control = await screen.findByRole('switch', { name: 'Ask for the pickup code' });
    expect(control.getAttribute('aria-checked')).toBe('true');
    await view.user.click(control);
    await waitFor(() => expect(writes).toEqual([{ method: 'PUT', path: '/vendor/profile', body: { requirePickupCode: false } }]));
  });

  it('an older server (no setting served): no switch', async () => {
    api([]);
    renderWithQuery(<OrdersPage />);
    await screen.findByRole('switch', { name: 'Deliver my own orders' });
    expect(screen.queryByRole('switch', { name: 'Ask for the pickup code' })).toBeNull();
  });

  it('a staff login: no switch', async () => {
    api([], { role: 'STAFF', requirePickupCode: false });
    renderWithQuery(<OrdersPage />);
    await screen.findByText('Open for orders');
    expect(screen.queryByRole('switch', { name: 'Ask for the pickup code' })).toBeNull();
  });
});
