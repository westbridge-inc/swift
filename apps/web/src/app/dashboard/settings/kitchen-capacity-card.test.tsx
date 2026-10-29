import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { KitchenCapacityCard } from './kitchen-capacity-card';
import { DeliveryStatusNotice } from '../delivery-status-notice';
import { mockApi, renderWithQuery, type ApiRequest } from '@/test/test-utils';

// ---------------------------------------------------------------------------
// [RIDER-SAFE 4] "How many orders at once" (the store's maxConcurrentOrders,
// no limit by default) and the notice that tells a store WHY customers cannot
// order delivery right now. Synthetic store only.
// ---------------------------------------------------------------------------

let store: Record<string, unknown>;
let role: string;
let status: Record<string, unknown>;
let writes: ApiRequest[];

beforeEach(async () => {
  store = { id: 'store-1', vendorType: 'RESTAURANT', maxConcurrentOrders: null };
  role = 'OWNER';
  status = { deliveryOpen: true, reason: null, waitingForRider: 0, backlogCap: 3, message: null };
  writes = [];
  (await import('@/lib/auth')).setSelectedStore('store-1');
  mockApi((r) => {
    if (r.url.pathname === '/api/v1/vendor/profile' && r.method === 'GET') return { body: { success: true, data: { myRole: role, vendors: [store] } } };
    if (r.url.pathname === '/api/v1/vendor/profile' && r.method === 'PUT') {
      writes.push(r);
      store = { ...store, ...JSON.parse(String(r.init?.body)) };
      return { body: { success: true, data: store } };
    }
    if (r.url.pathname === '/api/v1/vendor/vendor/delivery-status') return { body: { success: true, data: status } };
    throw new Error(`Unexpected request: ${r.method} ${r.url}`);
  });
});

async function click(name: string) { await act(async () => { fireEvent.click(screen.getByRole('button', { name })); }); }

describe('[RIDER-SAFE 4] How many orders at once', () => {
  it('no limit by default; setting one sends the number; No limit sends null', async () => {
    renderWithQuery(<KitchenCapacityCard storeId="store-1" />);
    expect(await screen.findByRole('heading', { name: 'How many orders at once' })).toBeTruthy();
    expect(screen.getByText('No limit')).toBeTruthy();
    await click('Set a limit');
    await click('Fewer');
    expect(screen.getByText('Up to 9 orders at a time (new, cooking or ready). More wait until one is collected.')).toBeTruthy();
    await click('Save');
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(JSON.parse(String(writes[0]!.init?.body))).toEqual({ maxConcurrentOrders: 9 });
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Save' })).toBeNull());
    await click('No limit');
    await click('Save');
    await waitFor(() => expect(writes).toHaveLength(2));
    expect(JSON.parse(String(writes[1]!.init?.body))).toEqual({ maxConcurrentOrders: null });
  });

  it('not for staff below manager, nor for a Services business', async () => {
    role = 'STAFF';
    const { unmount } = renderWithQuery(<KitchenCapacityCard storeId="store-1" />);
    await waitFor(() => expect(writes).toHaveLength(0));
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByRole('heading', { name: 'How many orders at once' })).toBeNull();
    unmount();
    role = 'OWNER';
    store = { ...store, vendorType: 'SERVICE' };
    renderWithQuery(<KitchenCapacityCard storeId="store-1" />);
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByRole('heading', { name: 'How many orders at once' })).toBeNull();
  });
});

describe('[RIDER-SAFE 4/5] the store sees why delivery is paused', () => {
  it('its own orders waiting for riders: the server words, pickup open', async () => {
    status = { deliveryOpen: false, reason: 'STORE_BUSY', waitingForRider: 3, backlogCap: 3, message: '3 of your orders are waiting for a rider, so new delivery orders are paused. They restart by themselves when a rider takes one. Customers can still order for pickup.' };
    renderWithQuery(<DeliveryStatusNotice storeId="store-1" />);
    const note = await screen.findByRole('status', { name: 'Delivery paused' });
    expect(note.textContent).toContain('New delivery orders are paused');
    expect(note.textContent).toContain('restart by themselves');
  });

  it("Swift's pause says so; open delivery says nothing", async () => {
    status = { deliveryOpen: false, reason: 'SWIFT_PAUSED', waitingForRider: 0, backlogCap: 3, message: 'Swift has paused delivery in your area for now. Customers can still order for pickup.' };
    const { unmount } = renderWithQuery(<DeliveryStatusNotice storeId="store-1" />);
    expect((await screen.findByRole('status', { name: 'Delivery paused' })).textContent).toContain('Delivery is paused by Swift');
    unmount();
    status = { deliveryOpen: true, reason: null, waitingForRider: 0, backlogCap: 3, message: null };
    renderWithQuery(<DeliveryStatusNotice storeId="store-1" />);
    await new Promise((r) => setTimeout(r, 30));
    expect(screen.queryByRole('status', { name: 'Delivery paused' })).toBeNull();
  });
});
