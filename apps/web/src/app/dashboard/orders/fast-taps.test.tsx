import { screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import OrdersPage from './page';
import { mockApi, renderWithQuery, stubAudioContext, type ApiRequest } from '@/test/test-utils';
import { wireVendorOrder, wireVendorOrderDetail } from '@/test/vendor-wire-fixtures';

// ---------------------------------------------------------------------------
// [STORE-DASH · owner 22 Oct 2026 "just make dashboard fixes and make sure
// it's fast taps and simple"] The web board, the way a store works it:
//   - the button names the next step: "Ready for delivery" / "Ready for pickup";
//   - a store-courier delivery is confirmed right on the card (the same second
//     tap as the window), with no window first;
//   - the order window opens at once on the board's copy of the order, and its
//     shelf ticks wait for the order's own read;
//   - the window's next step sits in a bar that stays at the bottom.
// ---------------------------------------------------------------------------

const writes: Array<{ method: string; path: string }> = [];
let holdDetail: Promise<{ body: unknown }> | null = null;

function api(orders: unknown[], detail?: (_path: string) => unknown) {
  return mockApi((request: ApiRequest) => {
    const { method, url } = request;
    const path = url.pathname.replace('/api/v1', '');
    if (method !== 'GET') { writes.push({ method, path }); return { body: { success: true, data: {} } }; }
    if (path === '/vendor/orders') return { body: { success: true, data: orders, meta: { total: orders.length } } };
    if (path.startsWith('/vendor/orders/')) {
      if (holdDetail) return holdDetail;
      return { body: { success: true, data: detail ? detail(path) : orders[0] } };
    }
    return { status: 404, body: { success: false } };
  });
}

async function card(orderNumber: string) {
  await screen.findByText(`#${orderNumber}`);
  return screen.getAllByRole('article').find((a) => a.textContent?.includes(`#${orderNumber}`))!;
}

beforeEach(async () => {
  writes.length = 0;
  holdDetail = null;
  stubAudioContext();
  (await import('@/lib/auth')).setSelectedStore('store-1');
});

describe('[STORE-DASH] the button names the next step', () => {
  it('a delivery order being prepared: "Ready for delivery", one tap, straight to the server', async () => {
    api([wireVendorOrder({ id: 'o-del', orderNumber: 'SW-8001', status: 'PREPARING' })]);
    const view = renderWithQuery(<OrdersPage />);
    await view.user.click(within(await card('SW-8001')).getByRole('button', { name: 'Ready for delivery' }));
    await waitFor(() => expect(writes).toEqual([{ method: 'PUT', path: '/vendor/orders/o-del/ready' }]));
    expect(screen.queryByRole('dialog', { name: 'Order details' })).toBeNull();
  });

  it('a takeaway order being prepared: "Ready for pickup"', async () => {
    api([wireVendorOrder({ id: 'o-tk', orderNumber: 'SW-8002', status: 'PREPARING', fulfillment: 'PICKUP' })]);
    renderWithQuery(<OrdersPage />);
    expect(within(await card('SW-8002')).getByRole('button', { name: 'Ready for pickup' })).toBeTruthy();
  });
});

describe('[STORE-DASH] a store-courier delivery is confirmed on the card', () => {
  const own = () => wireVendorOrder({ id: 'o-own', orderNumber: 'SW-8003', status: 'READY_FOR_PICKUP', fulfillmentMode: 'VENDOR_DELIVERY' });

  it('Confirm delivered asks once, right on the card; "Yes, delivered" closes it — no window', async () => {
    api([own()]);
    const view = renderWithQuery(<OrdersPage />);
    const c = await card('SW-8003');
    await view.user.click(within(c).getByRole('button', { name: 'Confirm delivered' }));
    expect(screen.queryByRole('dialog', { name: 'Order details' })).toBeNull();
    const ask = within(c).getByRole('group', { name: 'Confirm store delivery' });
    expect(within(ask).getByText('Did your store hand this order to the customer?')).toBeTruthy();
    expect(writes).toEqual([]); // the first tap only asks
    await view.user.click(within(ask).getByRole('button', { name: 'Yes, delivered' }));
    await waitFor(() => expect(writes).toEqual([{ method: 'PUT', path: '/vendor/orders/o-own/delivered' }]));
  });

  it('"Not yet" sends nothing and brings the button back', async () => {
    api([own()]);
    const view = renderWithQuery(<OrdersPage />);
    const c = await card('SW-8003');
    await view.user.click(within(c).getByRole('button', { name: 'Confirm delivered' }));
    await view.user.click(within(c).getByRole('button', { name: 'Not yet' }));
    expect(within(c).getByRole('button', { name: 'Confirm delivered' })).toBeTruthy();
    expect(writes).toEqual([]);
  });
});

describe('[STORE-DASH] the order window opens at once', () => {
  it('it shows the board\'s copy while its own read is out; shelf ticks wait for that read', async () => {
    const row = wireVendorOrder({ id: 'o-gro', orderNumber: 'SW-8004', status: 'PREPARING', vendor: { id: 'vendor-1', name: 'Test Grocer', vendorType: 'SUPERMARKET', selfDeliveryEnabled: false } });
    let release: (_v: { body: unknown }) => void = () => {};
    api([row], () => wireVendorOrderDetail({ id: 'o-gro', orderNumber: 'SW-8004', status: 'PREPARING', vendor: { vendorType: 'SUPERMARKET', selfDeliveryEnabled: false } }));
    const view = renderWithQuery(<OrdersPage />);
    const c = await card('SW-8004');
    holdDetail = new Promise((resolve) => { release = resolve; });
    await view.user.click(within(c).getByText('#SW-8004'));
    const dialog = await screen.findByRole('dialog', { name: 'Order details' });
    expect(await within(dialog).findByText('#SW-8004')).toBeTruthy();
    expect(within(dialog).queryByText('Loading…')).toBeNull();
    expect(within(dialog).queryByRole('checkbox')).toBeNull();
    // the next step is already there, in the bar at the bottom
    const bar = within(dialog).getByTestId('order-action-bar');
    expect(bar.className).toMatch(/\bsticky\b/);
    expect(bar.className).toMatch(/\bbottom-0\b/);
    expect(within(bar).getByRole('button', { name: 'Ready for delivery' })).toBeTruthy();

    release({ body: { success: true, data: wireVendorOrderDetail({ id: 'o-gro', orderNumber: 'SW-8004', status: 'PREPARING', vendor: { vendorType: 'SUPERMARKET', selfDeliveryEnabled: false } }) } });
    holdDetail = null;
    expect((await within(dialog).findAllByRole('checkbox')).length).toBe(2);
  });

  it('control: a failed read still says so (the board copy never hides a failure)', async () => {
    const row = wireVendorOrder({ id: 'o-f', orderNumber: 'SW-8005', status: 'PREPARING' });
    api([row]);
    const view = renderWithQuery(<OrdersPage />);
    const c = await card('SW-8005');
    holdDetail = Promise.resolve({ status: 503, body: { success: false, error: { message: 'Unavailable' } } } as never);
    await view.user.click(within(c).getByText('#SW-8005'));
    expect(await screen.findByText(/Could not load this order/)).toBeTruthy();
  });
});
