import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import OrderDetailPage from './page';
import { fulfilledParams, mockApi, renderWithQuery, requestsByMethod, type ApiReply, type ApiRequest } from '@/test/test-utils';

// ---------------------------------------------------------------------------
// [M2 · row 784] Five wrong tries lock a delivery PIN and the door refuses "until support intervenes". The route existed
// and nothing in the console called it: a rider stood at a door with food and nobody could open it. Same door as the ride
// code (a code to your phone, a reason), offered only where the server's own reset would go through. The reset sends the
// customer no message, so the console never says it did.
// ---------------------------------------------------------------------------

const REASON = 'Customer locked out at the door after wrong tries';
const order = (over: Record<string, unknown> = {}) => ({
  id: 'ord-p-1', orderNumber: 'SW-3003', orderType: 'FOOD_DELIVERY', fulfillment: 'DELIVERY', fulfillmentMode: 'PLATFORM_RIDER', status: 'ARRIVED', paymentMethod: 'CASH', paymentStatus: 'PENDING',
  totalAmount: 3000, subtotal: 3000, deliveryFee: 0, items: [], statusHistory: [], vendor: { id: 'v1', name: 'Test Kitchen' }, customer: { id: 'c1', firstName: 'Test', lastName: 'Customer' },
  mmgClaimMismatchAt: null, customerMmgClaim: 'UNRECORDED', handover: { ridePinIssued: true, ridePinLocked: true, ridePinAttempts: 5 }, ...over,
});
function serve(data: unknown, onWrite?: (_r: ApiRequest) => ApiReply) {
  return mockApi((r) => {
    if (r.method === 'GET' && r.url.pathname === '/api/v1/admin/orders/ord-p-1') return { body: { success: true, data } };
    if (onWrite && r.method !== 'GET') return onWrite(r);
    throw new Error(`Unexpected request: ${r.method} ${r.url}`);
  });
}
const open = () => renderWithQuery(<OrderDetailPage params={fulfilledParams({ id: 'ord-p-1' })} />);

describe('[M2] a delivery PIN locked at the door', () => {
  it('asks for the code sent to the phone and a reason, then resets it; the PIN is never shown and nobody is said to be told', async () => {
    const paths: string[] = [];
    const fetchMock = serve(order(), (r) => { paths.push(r.url.pathname); return { body: { success: true, data: { auditId: 'a1', rotated: true } } }; });
    const { user } = open();
    await user.click(await screen.findByRole('button', { name: 'New delivery PIN' }));
    await waitFor(() => expect(paths).toEqual(['/api/v1/auth/step-up']));
    const dialog = await screen.findByRole('dialog', { name: 'Give SW-3003 a new delivery PIN?' });
    expect(dialog.textContent).toMatch(/customer reads the new PIN on their order screen/);
    expect(dialog.textContent).toMatch(/Swift does not message them/);
    expect(dialog.textContent).toMatch(/give it a few seconds/);
    await user.type(within(dialog).getByRole('textbox', { name: 'Code sent to your phone' }), '654321');
    await user.type(within(dialog).getByRole('textbox', { name: 'Reason' }), REASON);
    await user.click(within(dialog).getByRole('button', { name: 'Give a new PIN' }));
    await waitFor(() => expect(paths).toEqual(['/api/v1/auth/step-up', '/api/v1/auth/step-up/verify', '/api/v1/admin/orders/ord-p-1/handover-secret/reset-delivery-pin']));
    const posts = requestsByMethod(fetchMock, 'POST');
    expect(JSON.parse(String(posts[1]![1]?.body))).toEqual({ code: '654321' });
    expect(JSON.parse(String(posts[2]![1]?.body))).toEqual({ reason: REASON });
    expect(new Headers(posts[2]![1]?.headers).get('x-swift-reason')).toBe(REASON);
    const done = await screen.findByText('SW-3003 has a new delivery PIN. Ask the customer to give it a few seconds, then read it from their order to the rider.');
    expect(done.textContent).not.toMatch(/told/);
  });

  it('a refusal stays in the panel, and a wrong code never reaches the reset', async () => {
    const paths: string[] = [];
    serve(order(), (r) => {
      paths.push(r.url.pathname);
      return r.url.pathname.endsWith('/verify') ? { status: 400, body: { success: false, error: { code: 'INVALID_CODE', message: 'That code is not right.' } } } : { body: { success: true, data: {} } };
    });
    const { user } = open();
    await user.click(await screen.findByRole('button', { name: 'New delivery PIN' }));
    const dialog = await screen.findByRole('dialog', { name: 'Give SW-3003 a new delivery PIN?' });
    await user.type(within(dialog).getByRole('textbox', { name: 'Code sent to your phone' }), '111111');
    await user.type(within(dialog).getByRole('textbox', { name: 'Reason' }), REASON);
    await user.click(within(dialog).getByRole('button', { name: 'Give a new PIN' }));
    expect(await within(dialog).findByText(/That code is not right/)).toBeTruthy();
    expect(paths).toEqual(['/api/v1/auth/step-up', '/api/v1/auth/step-up/verify']);
  });

  it.each(['PICKED_UP', 'EN_ROUTE_DELIVERY', 'ARRIVED'])('is offered at %s, locked or not', async (status) => {
    serve(order({ status, handover: { ridePinIssued: true, ridePinLocked: false, ridePinAttempts: 1 } }));
    open();
    expect(await screen.findByRole('button', { name: 'New delivery PIN' })).toBeTruthy();
  });

  it.each([
    ['before the rider has the goods', { status: 'RIDER_EN_ROUTE_PICKUP' }],
    ['after delivery', { status: 'DELIVERED' }],
    ['with no PIN issued', { handover: { ridePinIssued: false } }],
    ['with no handover read', { handover: undefined }],
    ['on a courier order', { orderType: 'COURIER' }],
    ['on a store’s own delivery', { fulfillmentMode: 'VENDOR_DELIVERY' }],
    ['on a pickup order', { fulfillment: 'PICKUP' }],
  ])('is not offered %s: the server would refuse it', async (_why, over) => {
    serve(order(over));
    open();
    await screen.findByText(/SW-3003/);
    expect(screen.queryByRole('button', { name: 'New delivery PIN' })).toBeNull();
  });

  it('a ride keeps its own button', async () => {
    serve(order({ orderType: 'TAXI', status: 'DRIVER_ARRIVED' }));
    open();
    expect(await screen.findByRole('button', { name: 'New ride code' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'New delivery PIN' })).toBeNull();
  });
});
