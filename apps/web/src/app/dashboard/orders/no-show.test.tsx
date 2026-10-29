import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import OrdersPage from './page';
import { mockApi, renderWithQuery, stubAudioContext, type ApiRequest } from '@/test/test-utils';
import { wireVendorOrderDetail } from '@/test/vendor-wire-fixtures';

// ---------------------------------------------------------------------------
// [BOOK-S5b · owner B3, against #2198 PUT /vendor/orders/:id/no-show] "Customer didn't come" on the web order window:
// offered only on an ACCEPTED appointment whose booked time has started; asked once (a confirm step); the server's
// refusal shown in its own words; the outcome shown once the server has closed it. No fee or strike is ever
// claimed by the page beyond the server's rule. Synthetic people only.
// ---------------------------------------------------------------------------

let writes: ApiRequest[];
let refusal: { code: string; message: string } | null;

function appointment(over: Record<string, unknown> = {}) {
  return wireVendorOrderDetail({
    status: 'ACCEPTED', fulfillment: 'APPOINTMENT', deliveryFee: '0.00', totalAmount: '4000.00', acceptedAt: new Date().toISOString(),
    appointmentSlot: new Date(Date.now() - 20 * 60_000).toISOString(),
    vendor: { vendorType: 'SERVICE', selfDeliveryEnabled: false },
    ...over,
  });
}

function serve(detail: Record<string, unknown>) {
  const server = { ...detail };
  mockApi((request) => {
    const path = request.url.pathname;
    if (request.method === 'GET' && path === '/api/v1/vendor/orders') return { body: { success: true, data: [{ ...server }], meta: { total: 1 } } };
    if (request.method === 'GET' && path === '/api/v1/vendor/orders/order-live') return { body: { success: true, data: { ...server } } };
    if (request.method === 'GET' && path === '/api/v1/vendor/items') return { body: { success: true, data: [] } };
    if (request.method === 'PUT' && path === '/api/v1/vendor/orders/order-live/no-show') {
      writes.push(request);
      if (refusal) return { status: 409, body: { success: false, error: refusal } };
      Object.assign(server, { status: 'CANCELLED', cancellationReason: "Customer didn't come (recorded by the business)." });
      return { body: { success: true, data: { id: 'order-live', status: 'CANCELLED' } } };
    }
    throw new Error(`Unexpected request: ${request.method} ${request.url}`);
  });
}

async function openDetail(detail: Record<string, unknown>) {
  serve(detail);
  const { user } = renderWithQuery(<OrdersPage />);
  const heading = await screen.findByText('#SW-1001');
  const later = screen.queryByText(/View later/);
  if (later) await user.click(later);
  await user.click(heading.closest('button')!);
  const dialog = await screen.findByRole('dialog', { name: 'Order details' });
  await within(dialog).findByRole('button', { name: 'Mark complete' });
  return { user, dialog };
}

beforeEach(() => { stubAudioContext(); writes = []; refusal = null; });
afterEach(() => { refusal = null; });

describe('[BOOK-S5b] Customer didn’t come on the web order window', () => {
  it('after the start: asked once, sent once, and the outcome is shown', async () => {
    const { user, dialog } = await openDetail(appointment());
    await user.click(within(dialog).getByRole('button', { name: 'Customer didn’t come' }));
    const ask = within(dialog).getByRole('dialog', { name: "Confirm customer didn't come" });
    expect(ask.textContent).toContain('This closes the booking and gives you the time back. The customer is told. There is no fee and no strike for them.');
    expect(writes).toHaveLength(0);
    await user.click(within(ask).getByRole('button', { name: 'Yes, they didn’t come' }));
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(await within(dialog).findByText('Booking closed: you recorded that the customer didn’t come. The customer has been told.')).toBeTruthy();
  });

  it('“Keep the booking” sends nothing', async () => {
    const { user, dialog } = await openDetail(appointment());
    await user.click(within(dialog).getByRole('button', { name: 'Customer didn’t come' }));
    await user.click(within(dialog).getByRole('button', { name: 'Keep the booking' }));
    expect(writes).toHaveLength(0);
    expect(within(dialog).queryByRole('dialog', { name: "Confirm customer didn't come" })).toBeNull();
  });

  it('the server’s refusal is shown in its own words', async () => {
    refusal = { code: 'NO_SHOW_PAID_MMG', message: 'This booking is already paid by MMG, so it cannot be closed here. Settle it with the customer directly, or contact Swift Support.' };
    const { user, dialog } = await openDetail(appointment());
    await user.click(within(dialog).getByRole('button', { name: 'Customer didn’t come' }));
    await user.click(within(dialog).getByRole('button', { name: 'Yes, they didn’t come' }));
    expect(await within(dialog).findByText(refusal.message)).toBeTruthy();
    expect(within(dialog).queryByText(/Booking closed:/)).toBeNull();
  });

  it('not offered before the appointment’s time has started', async () => {
    const { dialog } = await openDetail(appointment({ appointmentSlot: new Date(Date.now() + 60 * 60_000).toISOString() }));
    expect(within(dialog).queryByRole('button', { name: 'Customer didn’t come' })).toBeNull();
  });
});
