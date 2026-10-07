import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import OrdersPage from './orders/page';
import OrderDetailPage from './orders/[id]/page';
import MmgPaymentsPage from './mmg-payments/page';
import { fulfilledParams, mockApi, renderWithQuery, requestsByMethod, type ApiReply, type ApiRequest } from '@/test/test-utils';

// ---------------------------------------------------------------------------
// [MISSION CONTROL · AD3 / AD4 / AD5] DOORS FOR THE PROMISES THE APPS MAKE.
//
// The partner and store apps now tell people that a person at Swift is
// handling three things — a held weekly-fee payment, a paid order held for
// review, a disputed MMG payment. The server has the routes; the console had
// no screen for any of them. Each door: lists what waits, decides it through
// the in-page reason panel with the server's own rules, and shows a failed
// read as a failed read — never as "nothing waiting".
// ---------------------------------------------------------------------------

const REASON = 'Checked the MMG statement line with the partner on the phone';
const outage: ApiReply = { status: 500, body: { success: false, error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred' } } };
const empty: ApiReply = { body: { success: true, data: [], meta: { total: 0, page: 1, limit: 20, totalPages: 0, hasNext: false } } };

// ── AD4: held orders ────────────────────────────────────────────────────────
const heldOrder = {
  id: 'ord-held-1', orderNumber: 'SW-1001', orderType: 'FOOD', status: 'READY_FOR_PICKUP', paymentMethod: 'MOBILE_MONEY',
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
    const fetchMock = serveOrders({ body: { success: true, data: [heldOrder] } }, () => ({ body: { success: true, data: { released: true, decision: 'DELIVER_ANYWAY' } } }));
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

// ── AD3: held weekly-fee payments ───────────────────────────────────────────
const hold = (over: Record<string, unknown> = {}) => ({
  id: 'hold-1', subscriptionId: 'sub-1', epoch: 2, clockEpoch: 2, clockVersion: 7, status: 'ACTIVE', resolvable: true,
  source: 'MMG_CHECKOUT', sourceId: 'chk-0001', reason: 'PROVIDER_UNPROVEN', beganAt: '2026-10-06T12:00:00.000Z',
  reviewDueAt: '2026-10-07T12:00:00.000Z', overdue: false, remainingGraceMs: 30 * 3_600_000, ...over,
});
function serveMmg(holds: ApiReply, onWrite?: (_r: ApiRequest) => ApiReply) {
  return mockApi((r) => {
    if (r.method === 'GET' && r.url.pathname === '/api/v1/admin/billing/confirmations') return holds;
    if (r.method === 'GET' && r.url.pathname === '/api/v1/admin/billing/mmg-checkouts') return { body: { success: true, data: [], nextCursor: null } };
    if (onWrite && r.method !== 'GET') return onWrite(r);
    throw new Error(`Unexpected request: ${r.method} ${r.url}`);
  });
}

async function decidePaid(user: ReturnType<typeof renderWithQuery>['user'], evidence: string) {
  await user.click(await screen.findByRole('button', { name: 'Confirm chk-0001 as paid' }));
  const dialog = screen.getByRole('dialog', { name: 'Confirm this MMG checkout as paid?' });
  await user.type(within(dialog).getByRole('textbox', { name: 'Reason' }), REASON);
  await user.type(within(dialog).getByRole('textbox', { name: /Evidence reference/ }), evidence);
  await user.click(within(dialog).getByRole('button', { name: 'Confirm paid' }));
  return dialog;
}

describe('[MC-AD3] held weekly-fee payments', () => {
  it('lists each held payment; "Paid" sends the version it was read at, the evidence and the reason, and a second admin is asked', async () => {
    const fetchMock = serveMmg({ body: { success: true, data: [hold()] } }, () => ({
      status: 202, body: { success: false, error: { code: 'APPROVAL_REQUIRED', message: 'A second admin must approve this action.', details: { approvalId: 'apr-1' } } },
    }));
    const { user } = renderWithQuery(<MmgPaymentsPage />);
    const section = await screen.findByRole('region', { name: /Held weekly-fee payments/ });
    await within(section).findByText('chk-0001');
    expect(section.textContent).toContain('MMG checkout');
    await decidePaid(user, 'MMG-STATEMENT-0042');
    expect(await screen.findByText("Sent for a second admin's approval")).toBeTruthy();
    const [url, init] = requestsByMethod(fetchMock, 'POST')[0]!;
    expect(String(url)).toMatch(/\/api\/v1\/admin\/billing\/confirmations\/hold-1\/resolve$/);
    expect(JSON.parse(String(init?.body))).toEqual({
      sourceId: 'chk-0001', epoch: 2, clockVersion: 7, decision: 'PAID', evidenceReference: 'MMG-STATEMENT-0042', reason: REASON,
    });
    expect((init?.headers as Record<string, string>)['x-swift-reason']).toBe(REASON);
  });

  it('a "Paid" the provider never recorded is refused in words, in the panel, with the reason kept', async () => {
    serveMmg({ body: { success: true, data: [hold()] } }, () => ({
      status: 409, body: { success: false, error: { code: 'SETTLEMENT_EVIDENCE_REQUIRED', message: 'Complete or reconcile this payment through its existing settlement workflow first.' } },
    }));
    const { user } = renderWithQuery(<MmgPaymentsPage />);
    const dialog = await decidePaid(user, 'MMG-STATEMENT-0042');
    expect(await within(dialog).findByText("The provider's record of this payment isn't on file")).toBeTruthy();
    expect((within(dialog).getByRole('textbox', { name: 'Reason' }) as HTMLTextAreaElement).value).toBe(REASON);
  });

  it('"Not paid" asks for the evidence and sends decision UNPAID', async () => {
    const fetchMock = serveMmg({ body: { success: true, data: [hold()] } }, () => ({ body: { success: true, data: { id: 'hold-1', status: 'PROVEN_UNPAID', changed: true } } }));
    const { user } = renderWithQuery(<MmgPaymentsPage />);
    await user.click(await screen.findByRole('button', { name: 'Confirm chk-0001 as not paid' }));
    const dialog = screen.getByRole('dialog', { name: 'Confirm this MMG checkout as not paid?' });
    await user.type(within(dialog).getByRole('textbox', { name: 'Reason' }), REASON);
    await user.type(within(dialog).getByRole('textbox', { name: /Evidence reference/ }), 'CASE-2026-0007');
    await user.click(within(dialog).getByRole('button', { name: 'Confirm not paid' }));
    expect(await screen.findByText('Confirmed as not paid: the weekly fee is due again.')).toBeTruthy();
    expect(JSON.parse(String(requestsByMethod(fetchMock, 'POST')[0]![1]?.body))).toMatchObject({ decision: 'UNPAID', evidenceReference: 'CASE-2026-0007' });
  });

  it('a paused-fee review item is listed but offers no decision here', async () => {
    serveMmg({ body: { success: true, data: [hold({ id: 'aud-1', source: 'OBLIGATION', sourceId: 'sub-9', resolvable: false, status: 'REVIEW_REQUIRED' })] } });
    renderWithQuery(<MmgPaymentsPage />);
    const section = await screen.findByRole('region', { name: /Held weekly-fee payments/ });
    await within(section).findByText(/the billing team reviews it/);
    expect(within(section).queryByRole('button', { name: /paid/i })).toBeNull();
  });

  it('a failed read says so; it is never "no payments held"', async () => {
    serveMmg(outage);
    renderWithQuery(<MmgPaymentsPage />);
    expect((await screen.findByRole('alert')).textContent).toContain("Couldn't load the held payments");
    expect(screen.queryByText('No weekly-fee payments are held for a decision.')).toBeNull();
  });
});

// ── AD5: MMG payment disputes ───────────────────────────────────────────────
function orderOf(over: Record<string, unknown> = {}) {
  return {
    id: 'ord-d-1', orderNumber: 'SW-2002', orderType: 'FOOD', status: 'READY_FOR_PICKUP', paymentMethod: 'MOBILE_MONEY', paymentStatus: 'CLAIMED',
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
