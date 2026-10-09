import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import OrdersPage from './orders/page';
import OrderDetailPage from './orders/[id]/page';
import { fulfilledParams, mockApi, renderWithQuery, requestsByMethod, type ApiReply, type ApiRequest } from '@/test/test-utils';

// Launch order review screens use the existing server action contracts.

const REASON = 'Checked the MMG statement line with the partner on the phone';
const outage: ApiReply = { status: 500, body: { success: false, error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred' } } };
const empty: ApiReply = { body: { success: true, data: [], meta: { total: 0, page: 1, limit: 20, totalPages: 0, hasNext: false } } };

// ── AD4: held orders ────────────────────────────────────────────────────────
const heldOrder = {
  id: 'ord-held-1', orderNumber: 'SW-1001', orderType: 'FOOD_DELIVERY', status: 'READY_FOR_PICKUP', paymentMethod: 'MOBILE_MONEY',
  paymentStatus: 'CAPTURED', totalAmount: 4500, readyAt: '2026-10-07T10:00:00.000Z', foodAgeHeldAt: '2026-10-07T10:50:00.000Z',
  placedAt: '2026-10-07T09:30:00.000Z', heldMinutes: 25, readyMinutes: 75, vendor: { id: 'v1', name: 'Test Kitchen' },
};
function serveOrders(held: ApiReply, onWrite?: (_r: ApiRequest) => ApiReply) {
  return mockApi((r) => {
    if (r.method === 'GET' && r.url.pathname === '/api/v1/admin/orders/held') return held;
    if (r.method === 'GET' && r.url.pathname === '/api/v1/admin/orders') return empty;
    if (onWrite && r.method !== 'GET') return onWrite(r);
    throw new Error(`Unexpected request: ${r.method} ${r.url}`);
  });
}

describe('[MC-AD4] held orders', () => {
  it('lists a held paid order and releases it with "Deliver anyway", the one release the server offers', async () => {
    const fetchMock = serveOrders({ body: { success: true, data: [heldOrder] } }, () => ({ body: { success: true, data: { released: true, decision: 'DELIVER_ANYWAY', dispatch: {} } } }));
    const { user } = renderWithQuery(<OrdersPage />);
    const section = await screen.findByRole('region', { name: /Held for review/ });
    expect(section.textContent).toContain('SW-1001');
    expect(section.textContent).toContain('Test Kitchen');
    await user.click(within(section).getByRole('button', { name: 'Deliver order SW-1001 anyway' }));
    const dialog = screen.getByRole('dialog', { name: 'Deliver order SW-1001 anyway?' });
    expect(dialog.textContent).toMatch(/ready for 1 h 15 min/);
    await user.click(within(dialog).getByRole('button', { name: 'Deliver anyway' }));
    expect((await screen.findByText('Order SW-1001 is released and back with dispatch.'))).toBeTruthy();
    const [url, init] = requestsByMethod(fetchMock, 'POST')[0]!;
    expect(String(url)).toMatch(/\/api\/v1\/admin\/orders\/ord-held-1\/food-age-hold\/release$/);
    expect(JSON.parse(String(init?.body))).toEqual({ decision: 'DELIVER_ANYWAY' });
  });

  it('a failed read of the held orders says so; it is never read as "nothing held"', async () => {
    serveOrders(outage);
    renderWithQuery(<OrdersPage />);
    expect((await screen.findByRole('alert')).textContent).toContain("Couldn't load the held orders");
  });

  it('with nothing held there is no held section at all', async () => {
    serveOrders({ body: { success: true, data: [] } });
    renderWithQuery(<OrdersPage />);
    await screen.findByRole('heading', { name: 'Orders' });
    await waitFor(() => expect(screen.queryByRole('region', { name: /Held for review/ })).toBeNull());
  });
});

// ── AD5: MMG payment disputes ───────────────────────────────────────────────
function orderOf(over: Record<string, unknown> = {}) {
  return {
    id: 'ord-d-1', orderNumber: 'SW-2002', orderType: 'FOOD_DELIVERY', status: 'READY_FOR_PICKUP', paymentMethod: 'MOBILE_MONEY', paymentStatus: 'CLAIMED',
    totalAmount: 3000, subtotal: 3000, deliveryFee: 0, items: [], statusHistory: [], vendor: { id: 'v1', name: 'Test Kitchen' }, customer: { id: 'c1', firstName: 'Test', lastName: 'Customer' },
    customerMmgClaim: 'NOT_PAID', mmgClaimMismatchAt: '2026-10-07T11:00:00.000Z', mmgClaimRevision: 4, mmgClaimResolution: null, mmgClaimResolvedAt: null,
    ...over,
  };
}
function serveOrder(order: unknown, onWrite?: (_r: ApiRequest) => ApiReply) {
  return mockApi((r) => {
    if (r.method === 'GET' && r.url.pathname === '/api/v1/admin/orders/ord-d-1') return { body: { success: true, data: order } };
    if (onWrite && r.method !== 'GET') return onWrite(r);
    throw new Error(`Unexpected request: ${r.method} ${r.url}`);
  });
}
const detail = () => renderWithQuery(<OrderDetailPage params={fulfilledParams({ id: 'ord-d-1' })} />);

describe('[MC-AD5] an MMG payment dispute', () => {
  it('says who claims what and decides it against the revision on screen; the reason is also the decision note', async () => {
    const fetchMock = serveOrder(orderOf(), () => ({ body: { success: true, data: { orderId: 'ord-d-1', paymentStatus: 'PENDING', mismatch: false, resolution: 'CUSTOMER_DID_NOT_PAY', replayed: false } } }));
    const { user } = detail();
    const panel = await screen.findByRole('region', { name: 'Payment dispute' });
    expect(panel.textContent).toMatch(/The customer says they did not pay; Test Kitchen says the payment arrived/);
    await user.click(within(panel).getByRole('button', { name: 'Customer did not pay…' }));
    const dialog = screen.getByRole('dialog', { name: 'Decide that the customer did not pay for order SW-2002?' });
    await user.type(within(dialog).getByRole('textbox', { name: 'Reason' }), REASON);
    await user.click(within(dialog).getByRole('button', { name: 'Customer did not pay' }));
    expect(await screen.findByText('Order SW-2002: decided that the customer did not pay.')).toBeTruthy();
    const [url, init] = requestsByMethod(fetchMock, 'POST')[0]!;
    expect(String(url)).toMatch(/\/api\/v1\/admin\/orders\/ord-d-1\/payment-claim\/resolve$/);
    expect(JSON.parse(String(init?.body))).toEqual({ resolution: 'CUSTOMER_DID_NOT_PAY', expectedClaimRevision: 4, note: REASON });
    expect((init?.headers as Record<string, string>)['x-swift-reason']).toBe(REASON);
  });

  it('a dispute that changed since it was read is refused in the panel with the server’s words', async () => {
    serveOrder(orderOf(), () => ({ status: 409, body: { success: false, error: { code: 'MMG_CLAIM_STALE', message: 'The payment claims changed since you reviewed them. Refresh and decide on the current evidence.' } } }));
    const { user } = detail();
    await user.click(within(await screen.findByRole('region', { name: 'Payment dispute' })).getByRole('button', { name: 'Customer paid…' }));
    const dialog = screen.getByRole('dialog', { name: 'Decide that the customer paid for order SW-2002?' });
    await user.type(within(dialog).getByRole('textbox', { name: 'Reason' }), REASON);
    await user.click(within(dialog).getByRole('button', { name: 'Customer paid' }));
    expect(await within(dialog).findByText(/The payment claims changed since you reviewed them/)).toBeTruthy();
  });

  it('no dispute: no panel; a decided one says what was decided and offers nothing', async () => {
    serveOrder(orderOf({ mmgClaimMismatchAt: null, customerMmgClaim: 'UNRECORDED' }));
    const first = detail();
    await screen.findByRole('heading', { name: '#SW-2002' });
    expect(screen.queryByRole('region', { name: 'Payment dispute' })).toBeNull();
    first.unmount();
    serveOrder(orderOf({ mmgClaimMismatchAt: null, mmgClaimResolution: 'CUSTOMER_PAID', mmgClaimResolvedAt: '2026-10-07T12:00:00.000Z', mmgClaimRevision: 5 }));
    detail();
    const panel = await screen.findByRole('region', { name: 'Payment dispute' });
    expect(panel.textContent).toContain('Decided: the customer paid.');
    expect(within(panel).queryByRole('button')).toBeNull();
  });
});

describe('reviewed door recovery paths', () => {
  it('shows a release with failed dispatch and offers a dispatch retry', async () => {
    const fetchMock = serveOrders({ body: { success: true, data: [heldOrder] } }, (request) => request.url.pathname.endsWith('/retry-dispatch')
      ? { body: { success: true, data: { dispatched: true } } }
      : { body: { success: true, data: { released: true, decision: 'DELIVER_ANYWAY', dispatch: { error: 'Dispatch unavailable' } } } });
    const { user } = renderWithQuery(<OrdersPage />);
    await user.click(await screen.findByRole('button', { name: 'Deliver order SW-1001 anyway' }));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Deliver anyway' }));
    expect(await screen.findByText(/released.*dispatch needs retry/)).toBeTruthy();
    expect(screen.queryByText('Order SW-1001 is released and back with dispatch.')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Retry dispatch for SW-1001' }));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Retry dispatch' }));
    await waitFor(() => expect(requestsByMethod(fetchMock, 'POST').some(([url]) => String(url).endsWith('/retry-dispatch'))).toBe(true));
  });
  it('shows both payment references and identifies their mismatch', async () => {
    serveOrder(orderOf({ customerMmgClaim: 'PAID', customerPaymentRef: 'MMG-CUSTOMER-001', mmgAttestedRef: 'MMG-STORE-002' }));
    detail();
    const panel = await screen.findByRole('region', { name: 'Payment dispute' });
    expect(within(panel).getByText('MMG-CUSTOMER-001')).toBeTruthy();
    expect(within(panel).getByText('MMG-STORE-002')).toBeTruthy();
    expect(panel.textContent).toMatch(/references do not match/i);
  });
  it('re-reads stale claims and uses the new revision only after renewed review', async () => {
    let reads = 0;
    const revisions: number[] = [];
    mockApi((request) => {
      if (request.method === 'GET') return { body: { success: true, data: orderOf({ mmgClaimRevision: ++reads === 1 ? 4 : 5 }) } };
      revisions.push(Number(JSON.parse(String(request.init?.body)).expectedClaimRevision));
      return revisions.length === 1 ? { status: 409, body: { success: false, error: { code: 'MMG_CLAIM_STALE', message: 'The payment claims changed. Review the current evidence.' } } }
        : { body: { success: true, data: { orderId: 'ord-d-1', resolution: 'CUSTOMER_PAID', mismatch: false, paymentStatus: 'CLAIMED', replayed: false } } };
    });
    const { user } = detail();
    await user.click(await screen.findByRole('button', { name: 'Customer paid…' }));
    let dialog = screen.getByRole('dialog');
    await user.type(within(dialog).getByRole('textbox', { name: 'Reason' }), REASON);
    await user.click(within(dialog).getByRole('button', { name: 'Customer paid' }));
    await within(dialog).findByRole('alert');
    await user.click(within(dialog).getByRole('button', { name: 'Close' }));
    await user.click(screen.getByRole('button', { name: 'Customer paid…' }));
    dialog = screen.getByRole('dialog');
    await user.type(within(dialog).getByRole('textbox', { name: 'Reason' }), REASON);
    await user.click(within(dialog).getByRole('button', { name: 'Customer paid' }));
    await waitFor(() => expect(revisions).toEqual([4, 5]));
  });
});

