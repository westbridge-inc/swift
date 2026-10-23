import { screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import OrdersPage from './page';
import NewOrderTakeover from '@/components/NewOrderTakeover';
import { mockApi, renderWithQuery, stubAudioContext, type ApiRequest } from '@/test/test-utils';
import { wireOrderLine, wireVendorOrder } from '@/test/vendor-wire-fixtures';
import { normalizeVendorOrder } from '@/lib/vendor-api';

// ---------------------------------------------------------------------------
// [STORE-DASH · owner 22 Oct 2026, O-4] "Accept the whole order without
// ticking items; Out of stock per item", every store type, on the web
// dashboard (server #2043):
//   - a waiting order's window and its new-order popup have one "Out of
//     stock" per item: one tap asks the customer about THAT item;
//   - while the customer answers there is no Accept (card, window, popup) and
//     the screen says why; the popup lets go of the order and brings it back
//     with the answer;
//   - every item came off: no Accept, "reject the order with a reason";
//   - once accepted, no "Out of stock" here (today's shelf flow).
// ---------------------------------------------------------------------------

const writes: Array<{ method: string; path: string }> = [];
const lines = (...over: Array<Record<string, unknown>>) => over.map((o, i) => wireOrderLine({ id: `line-${i + 1}`, itemId: `item-${i + 1}`, name: `Item ${i + 1}`, ...o }));

function api(orders: unknown[]) {
  return mockApi((request: ApiRequest) => {
    const { method, url } = request;
    const path = url.pathname.replace('/api/v1', '');
    if (method !== 'GET') { writes.push({ method, path }); return { body: { success: true, data: {} } }; }
    if (path === '/vendor/orders') return { body: { success: true, data: orders, meta: { total: orders.length } } };
    if (path.startsWith('/vendor/orders/')) return { body: { success: true, data: orders[0] } };
    return { status: 404, body: { success: false } };
  });
}
async function openWindow(orderNumber: string, view: ReturnType<typeof renderWithQuery>) {
  const later = await screen.findByText(/View later/).catch(() => null);
  if (later) await view.user.click(later);
  await view.user.click(await screen.findByText(`#${orderNumber}`, { selector: 'p' }));
  return screen.findByRole('dialog', { name: 'Order details' });
}

beforeEach(async () => {
  writes.length = 0;
  stubAudioContext();
  (await import('@/lib/auth')).setSelectedStore('store-1');
});

describe('[O-4] the order window', () => {
  it('a waiting order: one "Out of stock" per item; one tap asks about THAT item', async () => {
    api([wireVendorOrder({ id: 'o-1', orderNumber: 'SW-9001', status: 'PENDING', items: lines({ name: 'Pepperpot' }, { name: 'Sorrel' }) })]);
    const view = renderWithQuery(<OrdersPage />);
    const dialog = await openWindow('SW-9001', view);
    expect(within(dialog).getAllByRole('button', { name: /^Out of stock: / })).toHaveLength(2);
    await view.user.click(within(dialog).getByRole('button', { name: 'Out of stock: Sorrel' }));
    await waitFor(() => expect(writes).toEqual([{ method: 'POST', path: '/vendor/orders/o-1/items/line-2/refund-line' }]));
  });

  it('while the customer answers: no Accept, the reason, the asked line says what was asked; Reject stays', async () => {
    api([wireVendorOrder({ id: 'o-2', orderNumber: 'SW-9002', status: 'PENDING', items: lines({ name: 'Pepperpot', subStatus: 'PENDING', substituteName: null }, { name: 'Sorrel' }) })]);
    const view = renderWithQuery(<OrdersPage />);
    const card = (await screen.findAllByRole('article')).find((a) => a.textContent?.includes('#SW-9002'))!;
    expect(within(card).queryByRole('button', { name: 'Accept' })).toBeNull();
    expect(within(card).getByText('Waiting on the customer’s answer — accept after they reply.')).toBeTruthy();
    const dialog = await openWindow('SW-9002', view);
    expect(within(dialog).queryByRole('button', { name: 'Accept' })).toBeNull();
    expect(within(dialog).getByRole('button', { name: 'Reject' })).toBeTruthy();
    expect(within(dialog).getByText('Waiting on the customer’s answer — accept after they reply.')).toBeTruthy();
    expect(within(dialog).getByText('Asked the customer: continue without it, or cancel')).toBeTruthy();
    expect(within(dialog).getAllByRole('button', { name: /^Out of stock: / })).toHaveLength(1);
  });

  it('every item came off: no Accept, "reject the order with a reason"', async () => {
    api([wireVendorOrder({ id: 'o-3', orderNumber: 'SW-9003', status: 'PENDING', items: lines({ subStatus: 'REFUNDED' }, { subStatus: 'REJECTED' }) })]);
    const view = renderWithQuery(<OrdersPage />);
    const dialog = await openWindow('SW-9003', view);
    expect(within(dialog).queryByRole('button', { name: 'Accept' })).toBeNull();
    expect(within(dialog).getByText('Every item is out of stock — reject the order with a reason.')).toBeTruthy();
    expect(within(dialog).getByRole('button', { name: 'Reject' })).toBeTruthy();
  });

  it('control: an accepted order has no "Out of stock" here', async () => {
    api([wireVendorOrder({ id: 'o-4', orderNumber: 'SW-9004', status: 'PREPARING' })]);
    const view = renderWithQuery(<OrdersPage />);
    const dialog = await openWindow('SW-9004', view);
    expect(within(dialog).queryByRole('button', { name: /^Out of stock: / })).toBeNull();
  });

  it('control: a waiting order with no question keeps Accept', async () => {
    api([wireVendorOrder({ id: 'o-5', orderNumber: 'SW-9005', status: 'PENDING' })]);
    const view = renderWithQuery(<OrdersPage />);
    const dialog = await openWindow('SW-9005', view);
    expect(within(dialog).getByRole('button', { name: 'Accept' })).toBeTruthy();
  });
});

describe('[O-4] the new-order popup', () => {
  const o = (over: Record<string, unknown>) => normalizeVendorOrder(wireVendorOrder({ id: 'p-1', orderNumber: 'SW-9101', status: 'PENDING', items: lines({ name: 'Pepperpot' }, { name: 'Sorrel' }), ...over }));

  it('one "Out of stock" per item, one tap asks about that item', async () => {
    api([]);
    const view = renderWithQuery(<NewOrderTakeover orders={[]} />);
    view.rerender(<NewOrderTakeover orders={[o({})]} />);
    await screen.findByText(/NEW ORDER/);
    await view.user.click(screen.getByRole('button', { name: 'Out of stock: Pepperpot' }));
    await waitFor(() => expect(writes).toEqual([{ method: 'POST', path: '/vendor/orders/p-1/items/line-1/refund-line' }]));
  });

  it('while the customer answers the popup lets go; the answer brings the order back', async () => {
    api([]);
    const view = renderWithQuery(<NewOrderTakeover orders={[]} />);
    view.rerender(<NewOrderTakeover orders={[o({})]} />);
    await screen.findByText(/NEW ORDER/);
    view.rerender(<NewOrderTakeover orders={[o({ items: lines({ name: 'Pepperpot', subStatus: 'PENDING', substituteName: null }, { name: 'Sorrel' }) })]} />);
    await waitFor(() => expect(screen.queryByText(/NEW ORDER/)).toBeNull());
    // the customer chose "Continue without it": the line came off, the rest waits for the store
    view.rerender(<NewOrderTakeover orders={[o({ items: lines({ name: 'Pepperpot', subStatus: 'REFUNDED' }, { name: 'Sorrel' }) })]} />);
    expect(await screen.findByText(/NEW ORDER/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Accept' })).toBeTruthy();
    expect(screen.getByText('Removed — not charged')).toBeTruthy();
  });

  it('every item came off: no Accept, the words, Reject stays', async () => {
    api([]);
    const view = renderWithQuery(<NewOrderTakeover orders={[]} />);
    view.rerender(<NewOrderTakeover orders={[o({ items: lines({ subStatus: 'REFUNDED' }, { subStatus: 'REFUNDED' }) })]} />);
    await screen.findByText(/NEW ORDER/);
    expect(screen.queryByRole('button', { name: 'Accept' })).toBeNull();
    expect(screen.getByText('Every item is out of stock — reject the order with a reason.')).toBeTruthy();
    expect(screen.getByRole('button', { name: /Reject — tell us why/ })).toBeTruthy();
  });
});
