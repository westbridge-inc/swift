import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import OrdersPage from './page';
import { mockApi, renderWithQuery, stubAudioContext, type ApiRequest } from '@/test/test-utils';
import { wireVendorOrderDetail } from '@/test/vendor-wire-fixtures';

// [BUG-HUNT-2 G08] "Refund sent" on the web order window: the store's own MMG, then the reference, and the server's words.

let writes: ApiRequest[];
let refusal: { code?: string; message: string } | null;
const OWED = { state: 'OWED', amount: '1300.00', line: 'You owe the customer GY$1,300 by MMG. Send it from your MMG, then tap Refund sent.', canMarkSent: true };

function closed(over: Record<string, unknown> = {}) {
  return wireVendorOrderDetail({ status: 'CANCELLED', fulfillment: 'PICKUP', paymentMethod: 'MOBILE_MONEY', paymentStatus: 'CLAIMED', deliveryFee: '0.00', totalAmount: '1300.00', mmgRefund: OWED, ...over });
}

async function openDetail(detail: Record<string, unknown>) {
  const server = { ...detail };
  mockApi((request) => {
    const path = request.url.pathname;
    if (request.method === 'GET' && path === '/api/v1/vendor/orders') return { body: { success: true, data: [{ ...server }], meta: { total: 1 } } };
    if (request.method === 'GET' && path === '/api/v1/vendor/orders/order-live') return { body: { success: true, data: { ...server } } };
    if (request.method === 'GET' && path === '/api/v1/vendor/items') return { body: { success: true, data: [] } };
    if (request.method === 'POST' && path === '/api/v1/vendor/orders/order-live/mmg-refunds/send') {
      writes.push(request);
      if (refusal) return { status: 409, body: { success: false, error: refusal } };
      Object.assign(server, { mmgRefund: { state: 'SENT', amount: '1300.00', line: 'You marked GY$1,300 sent.', canMarkSent: false } });
      return { body: { success: true, data: { sendId: 's1', status: 'SENT', replayed: false } } };
    }
    throw new Error(`Unexpected request: ${request.method} ${request.url}`);
  });
  const { user } = renderWithQuery(<OrdersPage />);
  await user.click(await screen.findByRole('button', { name: /^Done/ }));
  const heading = await screen.findByText('#SW-1001');
  const later = screen.queryByText(/View later/);
  if (later) await user.click(later);
  await user.click(heading.closest('button')!);
  const dialog = await screen.findByRole('dialog', { name: 'Order details' });
  await within(dialog).findByRole('region', { name: 'MMG refund' });
  return { user, dialog };
}

beforeEach(() => { stubAudioContext(); writes = []; refusal = null; });
afterEach(() => { refusal = null; });

describe('[G08] Refund sent on the web order window', () => {
  it('asks for the reference, sends the server\'s amount once, and shows the new state', async () => {
    const { user, dialog } = await openDetail(closed());
    await user.click(within(dialog).getByRole('button', { name: 'Refund sent' }));
    const ask = within(dialog).getByRole('dialog', { name: 'Confirm refund sent' });
    expect(within(ask).getByRole('button', { name: 'I sent it' })).toHaveProperty('disabled', true);
    await user.type(within(ask).getByRole('textbox', { name: 'MMG reference' }), 'mp123456');
    await user.click(within(ask).getByRole('button', { name: 'I sent it' }));
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(JSON.parse(String(writes[0]!.init?.body))).toEqual({ reference: 'mp123456', amount: '1300.00' });
    expect(await within(dialog).findByText('You marked GY$1,300 sent.')).toBeTruthy();
    expect(within(dialog).queryByRole('button', { name: 'Refund sent' })).toBeNull();
  });

  it('a refusal is shown in the server\'s words', async () => {
    refusal = { code: 'MMG_REFUND_REF_USED', message: 'That MMG reference is already on another refund.' };
    const { user, dialog } = await openDetail(closed());
    await user.click(within(dialog).getByRole('button', { name: 'Refund sent' }));
    await user.type(within(dialog).getByRole('textbox', { name: 'MMG reference' }), 'mp123456');
    await user.click(within(dialog).getByRole('button', { name: 'I sent it' }));
    expect(await within(dialog).findByText(refusal.message)).toBeTruthy();
  });

  it('staff below a manager read it and have no door', async () => {
    const { dialog } = await openDetail(closed({ mmgRefund: { ...OWED, canMarkSent: false } }));
    expect(within(dialog).getByText(OWED.line)).toBeTruthy();
    expect(within(dialog).queryByRole('button', { name: 'Refund sent' })).toBeNull();
  });
});
