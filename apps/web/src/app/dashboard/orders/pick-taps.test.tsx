import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import OrdersPage from './page';
import { mockApi, renderWithQuery, stubAudioContext, type ApiRequest } from '@/test/test-utils';
import { wireOrderLine, wireVendorOrder } from '@/test/vendor-wire-fixtures';

// ---------------------------------------------------------------------------
// [TAP-AUDIT 27 Oct · owner: "every single button tap"] A grocery or shop ticks each line of an order in its window as
// it picks. One tick used to freeze EVERY box on the order until the write AND a re-read of the order and the whole
// board came back (~1.3 s a line on a mobile link). Now the box ticks at the tap, only that line waits, a refusal puts
// it back and says why, the order's step buttons wait while a tick is still out (a "Ready" before it lands would be
// refused for an unpicked line), and the order alone is read again once after the last tick.
// ---------------------------------------------------------------------------

let writes: Array<{ method: string; path: string; body: unknown }>;
let reads: string[];
let picks: Array<{ path: string; release: (_reply: { status?: number; body: unknown }) => void }>;
let order: Record<string, unknown>;
/** After the window is open: every re-read hangs, so only the server's answers can change the screen. */
let holdReads = false;

const lines = () => [
  wireOrderLine({ id: 'line-1', itemId: 'item-1', name: 'Rice', picked: false }),
  wireOrderLine({ id: 'line-2', itemId: 'item-2', name: 'Oil', picked: false }),
];

function api() {
  return mockApi((request: ApiRequest) => {
    const { method, url, init } = request;
    const path = url.pathname.replace('/api/v1', '');
    if (method !== 'GET') {
      writes.push({ method, path, body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined });
      if (/\/items\/[^/]+\/picked$/.test(path)) return new Promise((resolve) => { picks.push({ path, release: (reply) => resolve({ status: reply.status ?? 200, body: reply.body }) }); });
      return { body: { success: true, data: {} } };
    }
    reads.push(path);
    if (holdReads) return new Promise(() => {});
    if (path === '/vendor/orders') return { body: { success: true, data: [order], meta: { total: 1 } } };
    if (path.startsWith('/vendor/orders/')) return { body: { success: true, data: order } };
    if (path === '/vendor/items') return { body: { success: true, data: [] } };
    return { status: 404, body: { success: false } };
  });
}
async function openWindow(view: ReturnType<typeof renderWithQuery>) {
  const later = await screen.findByText(/View later/).catch(() => null);
  if (later) await view.user.click(later);
  await view.user.click(await screen.findByText('#SW-7001', { selector: 'p' }));
  return screen.findByRole('dialog', { name: 'Order details' });
}
const box = (dialog: HTMLElement, name: string) => within(dialog).getByRole('checkbox', { name: `Picked: 2× ${name}` }) as HTMLInputElement;

beforeEach(async () => {
  holdReads = false;
  writes = [];
  reads = [];
  picks = [];
  order = wireVendorOrder({ id: 'o-1', orderNumber: 'SW-7001', status: 'PREPARING', vendor: { id: 'store-1', name: 'Mart', vendorType: 'SUPERMARKET' }, items: lines() });
  stubAudioContext();
  (await import('@/lib/auth')).setSelectedStore('store-1');
});

describe('[TAP-AUDIT] a pick tick on the web', () => {
  it('ticks at the tap; only that line waits; the other line can be ticked meanwhile', async () => {
    api();
    const view = renderWithQuery(<OrdersPage />);
    const dialog = await openWindow(view);
    await act(async () => { fireEvent.click(box(dialog, 'Rice')); });
    // [REVIEW-F #2143 S3-1] The tick lands a scheduler tick after the click (the write first cancels a read on its
    // way); the server's answer is still held here, so this is the box before the answer.
    await waitFor(() => expect(box(dialog, 'Rice').checked, 'the box ticks before the server answers').toBe(true));
    expect(picks).toHaveLength(1);
    expect(box(dialog, 'Rice').disabled, 'that line waits').toBe(true);
    expect(box(dialog, 'Oil').disabled, 'the other line does not').toBe(false);
    await act(async () => { fireEvent.click(box(dialog, 'Oil')); });
    await waitFor(() => expect(box(dialog, 'Oil').checked).toBe(true));
    expect(writes.map((w) => w.path)).toEqual(['/vendor/orders/o-1/items/line-1/picked', '/vendor/orders/o-1/items/line-2/picked']);
  });

  it('[REVIEW-M #2143 S4-2] the server\'s answer wins over the tap (another device unticked it)', async () => {
    api();
    const view = renderWithQuery(<OrdersPage />);
    const dialog = await openWindow(view);
    holdReads = true; // only the answer itself can untick the box
    await act(async () => { fireEvent.click(box(dialog, 'Rice')); });
    await waitFor(() => expect(box(dialog, 'Rice').checked).toBe(true));
    await act(async () => { picks[0]!.release({ body: { success: true, data: { id: 'line-1', picked: false } } }); });
    await waitFor(() => expect(box(dialog, 'Rice').checked).toBe(false));
  });

  it('a refused tick goes back and says why', async () => {
    api();
    const view = renderWithQuery(<OrdersPage />);
    const dialog = await openWindow(view);
    await act(async () => { fireEvent.click(box(dialog, 'Rice')); });
    await act(async () => { picks[0]!.release({ status: 409, body: { success: false, error: { code: 'ORDER_MOVED_ON', message: 'This order has moved on.' } } }); });
    await waitFor(() => expect(box(dialog, 'Rice').checked).toBe(false));
    expect(await within(dialog).findByText(/This order has moved on\./)).toBeTruthy();
  });

  it('the step button waits while a tick is out, and only this order is read again after the last tick', async () => {
    api();
    const view = renderWithQuery(<OrdersPage />);
    const dialog = await openWindow(view);
    const step = () => within(within(dialog).getByTestId('order-action-bar')).getAllByRole('button')
      .find((b) => /Ready/.test(b.textContent ?? '')) as HTMLButtonElement;
    expect(step().disabled).toBe(false);
    await act(async () => { fireEvent.click(box(dialog, 'Rice')); });
    await waitFor(() => expect(step().disabled, 'Ready waits for the tick').toBe(true));
    const before = reads.length;
    order = { ...order, items: (order['items'] as Array<Record<string, unknown>>).map((l) => (l['id'] === 'line-1' ? { ...l, picked: true } : l)) };
    await act(async () => { picks[0]!.release({ body: { success: true, data: { id: 'line-1', picked: true } } }); });
    await waitFor(() => expect(step().disabled).toBe(false));
    await waitFor(() => expect(reads.length).toBeGreaterThan(before));
    expect(reads.slice(before).every((p) => p === '/vendor/orders/o-1'), `re-reads after the tick: ${reads.slice(before).join(', ')}`).toBe(true);
    expect(box(dialog, 'Rice').checked).toBe(true);
  });
});

describe('[TAP-AUDIT] "Ask for the pickup code" moves at the tap', () => {
  it('the switch shows the tapped state while the request is out, and stays locked until the store is read again', async () => {
    let release!: () => void;
    let served = false;
    mockApi((request: ApiRequest) => {
      const { method, url } = request;
      const path = url.pathname.replace('/api/v1', '');
      if (method === 'PUT' && path === '/vendor/profile') return new Promise((resolve) => { release = () => { served = true; resolve({ body: { success: true, data: { id: 'store-1', requirePickupCode: true } } }); }; });
      if (path === '/vendor/stores') return { body: { success: true, data: { stores: [{ id: 'store-1', name: 'Mart', vendorType: 'SUPERMARKET', isCurrentlyOpen: true, acceptingOrders: true, city: null, isVerified: true }], selectedId: 'store-1', myRole: 'OWNER' } } };
      if (path === '/vendor/profile') {
        return { body: { success: true, data: { id: 'owner-1', userId: 'user-1', myRole: 'OWNER', vendors: [{
          id: 'store-1', name: 'Mart', vendorType: 'SUPERMARKET', status: 'ACTIVE', isVerified: true, isCurrentlyOpen: true, acceptingOrders: true, selfDeliveryEnabled: false,
          requirePickupCode: served, operatingHours: [], _count: { orders: 40, items: 3 },
        }] } } };
      }
      if (path === '/vendor/orders') return { body: { success: true, data: [], meta: { total: 0 } } };
      return { status: 404, body: { success: false } };
    });
    renderWithQuery(<OrdersPage />);
    const control = await screen.findByRole('switch', { name: 'Ask for the pickup code' });
    expect(control.getAttribute('aria-checked')).toBe('false');
    await act(async () => { fireEvent.click(control); });
    expect(control.getAttribute('aria-checked'), 'the switch moves at the tap').toBe('true');
    expect(control.hasAttribute('disabled'), 'and is locked while the request is out').toBe(true);
    await act(async () => { release(); });
    await waitFor(() => expect(control.hasAttribute('disabled')).toBe(false));
    expect(control.getAttribute('aria-checked')).toBe('true');
  });
});
