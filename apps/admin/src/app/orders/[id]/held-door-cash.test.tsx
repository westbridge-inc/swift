import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import OrderDetailPage from './page';
import { fulfilledParams, mockApi, renderWithQuery, requestsByMethod, type ApiReply, type ApiRequest } from '@/test/test-utils';

// [L02 · row 34 · review S3-1 of #1542] Partial cash a rider still holds after
// a refused handover: the console's door to the C4 resolve action. Without it,
// HELD could only be left by an API call nobody can click, and the rider's
// account closure would wait on it forever.

const REASON = 'Rider handed the GY$1,200 back to the customer at the store on Tuesday';
const RESOLVE_PATH = '/api/v1/admin/orders/ord-c-1/door-cash-return/resolve';

function orderOf(over: Record<string, unknown> = {}) {
  return {
    id: 'ord-c-1', orderNumber: 'SW-3003', orderType: 'FOOD_DELIVERY', status: 'READY_FOR_PICKUP', paymentMethod: 'CASH', paymentStatus: 'PENDING',
    totalAmount: 3000, subtotalCustomer: 3000, deliveryFee: 0, items: [], statusHistory: [], vendor: { id: 'v1', name: 'Test Kitchen' },
    doorCashReturnStatus: 'HELD', doorCashReturnAmount: '1200', doorCashReturnRecordedAt: '2026-10-14T15:00:00.000Z',
    doorCashReturnResolvedAt: null, doorCashReturnResolvedById: null,
    ...over,
  };
}
function serveOrder(order: unknown, onWrite?: (_r: ApiRequest) => ApiReply) {
  return mockApi((r) => {
    if (r.method === 'GET' && r.url.pathname === '/api/v1/admin/orders/ord-c-1') return { body: { success: true, data: order } };
    if (onWrite && r.method !== 'GET') return onWrite(r);
    throw new Error(`Unexpected request: ${r.method} ${r.url}`);
  });
}
const detail = () => renderWithQuery(<OrderDetailPage params={fulfilledParams({ id: 'ord-c-1' })} />);

async function askToResolve(user: ReturnType<typeof detail>['user']) {
  const panel = await screen.findByRole('region', { name: 'Held cash' });
  await user.click(within(panel).getByRole('button', { name: 'Record held cash as resolved…' }));
  const dialog = screen.getByRole('dialog', { name: 'Record the held cash for order SW-3003 as resolved?' });
  await user.type(within(dialog).getByRole('textbox', { name: 'Reason' }), REASON);
  await user.click(within(dialog).getByRole('button', { name: 'Record as resolved' }));
  return dialog;
}

describe('[L02] partial cash a rider still holds', () => {
  it('says how much the rider holds and that Swift moves nothing; the ask goes to the resolve route with the reason and is queued for a second admin', async () => {
    const fetchMock = serveOrder(orderOf(), () => ({
      status: 202,
      body: { success: false, error: { code: 'APPROVAL_REQUIRED', message: 'A second admin must approve this', details: { approvalId: 'ap_31' } } },
    }));
    const { user } = detail();
    const panel = await screen.findByRole('region', { name: 'Held cash' });
    expect(panel.textContent).toMatch(/The rider still holds GY\$1,200 of the customer.s cash/);
    expect(panel.textContent).toMatch(/account closure waits until this is resolved/);
    expect(panel.textContent).toMatch(/Swift moves no money/);

    const dialog = await askToResolve(user);
    expect(dialog.textContent).toMatch(/A second admin must approve it \(or the owner.s solo approval\)/);
    expect(dialog.textContent).toMatch(/Swift moves, refunds and deducts nothing/);

    expect(await screen.findByText("Sent for a second admin's approval")).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Open Approvals' })).toBeTruthy();
    const posts = requestsByMethod(fetchMock, 'POST');
    expect(posts).toHaveLength(1);
    const [url, init] = posts[0]!;
    expect(String(url)).toMatch(new RegExp(`${RESOLVE_PATH.replaceAll('/', '\\/')}$`));
    expect((init?.headers as Record<string, string>)['x-swift-reason']).toBe(REASON);
    expect(JSON.parse(String(init?.body))).toEqual({});
  });

  it('an applied resolve says so in the order\'s words', async () => {
    serveOrder(orderOf(), () => ({
      body: { success: true, data: { orderId: 'ord-c-1', doorCashReturn: { amount: 1200, status: 'RESOLVED', resolvedAt: '2026-10-15T09:00:00.000Z' } } },
    }));
    const { user } = detail();
    await askToResolve(user);
    expect(await screen.findByText('Order SW-3003: the held cash is recorded as resolved.')).toBeTruthy();
  });

  it('a 200 that does not say RESOLVED is an unreadable answer, never a success', async () => {
    serveOrder(orderOf(), () => ({ body: { success: true, data: { orderId: 'ord-c-1', doorCashReturn: { status: 'HELD' } } } }));
    const { user } = detail();
    const dialog = await askToResolve(user);
    expect(await within(dialog).findByText(/Swift returned an unreadable answer/)).toBeTruthy();
    expect(screen.queryByText('Order SW-3003: the held cash is recorded as resolved.')).toBeNull();
  });

  it('a refusal (already resolved by someone else) stays in the panel, re-reads the order and stops offering the button', async () => {
    let reads = 0;
    mockApi((r) => {
      if (r.method === 'GET' && r.url.pathname === '/api/v1/admin/orders/ord-c-1') {
        return { body: { success: true, data: ++reads === 1 ? orderOf() : orderOf({ doorCashReturnStatus: 'RESOLVED', doorCashReturnResolvedAt: '2026-10-15T08:00:00.000Z' }) } };
      }
      if (r.method === 'POST' && r.url.pathname === RESOLVE_PATH) {
        return { status: 409, body: { success: false, error: { code: 'NO_HELD_CASH', message: 'This order has no partial cash held for operations (it was returned at the door, already resolved, or never recorded).' } } };
      }
      throw new Error(`Unexpected request: ${r.method} ${r.url}`);
    });
    const { user } = detail();
    const dialog = await askToResolve(user);
    expect(await within(dialog).findByText(/This order has no partial cash held for operations/)).toBeTruthy();
    await waitFor(() => expect(reads).toBeGreaterThanOrEqual(2));
    await user.click(within(dialog).getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Record held cash as resolved…' })).toBeNull());
    expect((await screen.findByRole('region', { name: 'Held cash' })).textContent).toMatch(/recorded as resolved/);
  });

  it('resolved cash is read-only; cash handed back at the door or never recorded shows no panel', async () => {
    serveOrder(orderOf({ doorCashReturnStatus: 'RESOLVED', doorCashReturnResolvedAt: '2026-10-15T08:00:00.000Z' }));
    const first = detail();
    const panel = await screen.findByRole('region', { name: 'Held cash' });
    expect(panel.textContent).toMatch(/The GY\$1,200 the rider held is recorded as resolved/);
    expect(within(panel).queryByRole('button')).toBeNull();
    first.unmount();

    for (const status of ['RETURNED', null]) {
      serveOrder(orderOf({ doorCashReturnStatus: status }));
      const view = detail();
      await screen.findByRole('heading', { name: '#SW-3003' });
      expect(screen.queryByRole('region', { name: 'Held cash' })).toBeNull();
      view.unmount();
    }
  });
});
