import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import OrdersPage from './page';
import { mockApi, renderWithQuery, stubAudioContext, type ApiRequest } from '@/test/test-utils';
import { wireVendorOrderDetail } from '@/test/vendor-wire-fixtures';

// [BUG-HUNT-2 G20] "Not collected" on the web order window: offered on the server's word, asked once, the outcome shown.

let writes: ApiRequest[];
let refusal: { code?: string; message: string } | null;

function pickup(over: Record<string, unknown> = {}) {
  return wireVendorOrderDetail({
    status: 'READY_FOR_PICKUP', fulfillment: 'PICKUP', deliveryFee: '0.00', totalAmount: '4000.00', acceptedAt: new Date().toISOString(), readyAt: new Date(Date.now() - 25 * 3_600_000).toISOString(),
    vendor: { vendorType: 'RESTAURANT', selfDeliveryEnabled: false, requirePickupCode: false },
    notCollected: { allowed: true, goesToSupport: false },
    ...over,
  });
}

function serve(detail: Record<string, unknown>, answer: Record<string, unknown>) {
  const server = { ...detail };
  mockApi((request) => {
    const path = request.url.pathname;
    if (request.method === 'GET' && path === '/api/v1/vendor/orders') return { body: { success: true, data: [{ ...server }], meta: { total: 1 } } };
    if (request.method === 'GET' && path === '/api/v1/vendor/orders/order-live') return { body: { success: true, data: { ...server } } };
    if (request.method === 'GET' && path === '/api/v1/vendor/items') return { body: { success: true, data: [] } };
    if (request.method === 'PUT' && path === '/api/v1/vendor/orders/order-live/not-collected') {
      writes.push(request);
      if (refusal) return { status: 409, body: { success: false, error: refusal } };
      Object.assign(server, answer);
      return { body: { success: true, data: { id: 'order-live', ...answer } } };
    }
    throw new Error(`Unexpected request: ${request.method} ${request.url}`);
  });
}

async function openDetail(detail: Record<string, unknown>, answer: Record<string, unknown> = { status: 'CANCELLED' }) {
  serve(detail, answer);
  const { user } = renderWithQuery(<OrdersPage />);
  const heading = await screen.findByText('#SW-1001');
  const later = screen.queryByText(/View later/);
  if (later) await user.click(later);
  await user.click(heading.closest('button')!);
  const dialog = await screen.findByRole('dialog', { name: 'Order details' });
  await within(dialog).findByRole('button', { name: /Handed to customer|Mark picked up/ });
  return { user, dialog };
}

beforeEach(() => { stubAudioContext(); writes = []; refusal = null; });
afterEach(() => { refusal = null; });

describe('[G20] Not collected on the web order window', () => {
  it('a cash order: asked once, sent once, the outcome shown', async () => {
    const { user, dialog } = await openDetail(pickup());
    await user.click(within(dialog).getByRole('button', { name: 'Not collected' }));
    const ask = within(dialog).getByRole('dialog', { name: 'Confirm not collected' });
    expect(ask.textContent).toContain('The order closes. No money moves. The customer is told.');
    expect(writes).toHaveLength(0);
    await user.click(within(ask).getByRole('button', { name: 'Yes, nobody came' }));
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(await within(dialog).findByText('Order closed: recorded as not collected. No money moved.')).toBeTruthy();
  });

  it('a paid MMG order says it goes to support', async () => {
    const { user, dialog } = await openDetail(pickup({ paymentMethod: 'MOBILE_MONEY', paymentStatus: 'CLAIMED', notCollected: { allowed: true, goesToSupport: true } }), { status: 'READY_FOR_PICKUP', sentToSupport: true });
    await user.click(within(dialog).getByRole('button', { name: 'Not collected' }));
    const ask = within(dialog).getByRole('dialog', { name: 'Confirm not collected' });
    expect(ask.textContent).toContain('It was paid by MMG, so Swift support closes it with you. The order stays open until they do.');
    await user.click(within(ask).getByRole('button', { name: 'Yes, nobody came' }));
    expect(await within(dialog).findByText('Swift support has this order. They close it and record the refund you owe the customer.')).toBeTruthy();
  });

  it('“Keep the order” sends nothing', async () => {
    const { user, dialog } = await openDetail(pickup());
    await user.click(within(dialog).getByRole('button', { name: 'Not collected' }));
    await user.click(within(dialog).getByRole('button', { name: 'Keep the order' }));
    expect(writes).toHaveLength(0);
  });

  it('the server’s refusal is shown in its own words', async () => {
    refusal = { code: 'NOT_COLLECTED_NOT_OPEN', message: 'Only a pickup that is ready and waiting can be marked Not collected.' };
    const { user, dialog } = await openDetail(pickup());
    await user.click(within(dialog).getByRole('button', { name: 'Not collected' }));
    await user.click(within(dialog).getByRole('button', { name: 'Yes, nobody came' }));
    expect(await within(dialog).findByText(refusal.message)).toBeTruthy();
  });

  it.each([
    ['the server sends no word', { notCollected: undefined }],
    ['the server says no', { notCollected: { allowed: false, goesToSupport: false } }],
    ['a word that is not exactly true', { notCollected: { allowed: 'yes' } }],
  ])('not offered when %s', async (_why, over) => {
    const { dialog } = await openDetail(pickup(over as Record<string, unknown>));
    expect(within(dialog).queryByRole('button', { name: 'Not collected' })).toBeNull();
  });
});
