import { screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import NewOrderTakeover from './NewOrderTakeover';
import { mockApi, renderWithQuery, stubAudioContext } from '@/test/test-utils';
import { wireVendorOrder } from '@/test/vendor-wire-fixtures';
import { normalizeVendorOrder } from '@/lib/vendor-api';

/**
 * The full-screen new-order takeover is the loudest money surface the vendor
 * has — it is the screen a store accepts an order from. It printed "$NaN"
 * for the same reason the board did.
 *
 * The first poll only BASELINES (a dashboard opened onto an old queue must not
 * scream), so each test renders an empty queue first and then the arrival.
 */
describe('new-order takeover', () => {
  beforeEach(() => {
    stubAudioContext();
  });

  it('shows the real total from `totalAmount`, never "$NaN"', async () => {
    const { rerender } = renderWithQuery(<NewOrderTakeover orders={[]} />);
    rerender(<NewOrderTakeover orders={[normalizeVendorOrder(wireVendorOrder())]} />);

    const headline = await screen.findByText(new RegExp(`SW-1001`));
    expect(headline.textContent).toContain(`$${(4500).toLocaleString()}`);
    expect(document.body.textContent ?? '').not.toMatch(/NaN/);
  });

  it('renders an em-dash rather than a made-up $0 when no total arrived', async () => {
    const raw = wireVendorOrder() as Record<string, unknown>;
    delete raw['totalAmount'];
    const { rerender } = renderWithQuery(<NewOrderTakeover orders={[]} />);
    rerender(<NewOrderTakeover orders={[normalizeVendorOrder(raw)]} />);

    const headline = await screen.findByText(new RegExp(`SW-1001`));
    await waitFor(() => expect(headline.textContent).toContain('—'));
    expect(headline.textContent).not.toContain('$0');
    expect(headline.textContent ?? '').not.toMatch(/NaN/);
  });

  it('a rejection always sends the reason the server now requires (E10 RED: web sent {})', async () => {
    const fetchMock = mockApi((request) => {
      if (request.method === 'PUT' && request.url.pathname === '/api/v1/vendor/orders/order-live/reject') {
        return { body: { success: true, data: { id: 'order-live', status: 'CANCELLED' } } };
      }
      throw new Error(`Unexpected request: ${request.method} ${request.url}`);
    });
    const { rerender, user } = renderWithQuery(<NewOrderTakeover orders={[]} />);
    rerender(<NewOrderTakeover orders={[normalizeVendorOrder(wireVendorOrder())]} />);

    await screen.findByText(/NEW ORDER/);
    await user.click(screen.getByRole('button', { name: 'Reject' }));

    await waitFor(() => {
      const call = fetchMock.mock.calls.find(([url]) => String(url).includes('/orders/order-live/reject'));
      expect(call).toBeTruthy();
      expect(JSON.parse(String(call![1]?.body))).toEqual({ reason: 'Out of stock' });
    });
  });

  it('a booking is declined with a booking reason, never a kitchen one (E10 · DS200 D3)', async () => {
    const fetchMock = mockApi((request) => {
      if (request.method === 'PUT' && request.url.pathname === '/api/v1/vendor/orders/order-live/reject') {
        return { body: { success: true, data: { id: 'order-live', status: 'CANCELLED' } } };
      }
      throw new Error(`Unexpected request: ${request.method} ${request.url}`);
    });
    const raw = { ...wireVendorOrder(), fulfillment: 'APPOINTMENT', appointmentSlot: '2026-09-24T13:00:00.000Z' };
    const { rerender, user } = renderWithQuery(<NewOrderTakeover orders={[]} />);
    rerender(<NewOrderTakeover orders={[normalizeVendorOrder(raw)]} />);

    await screen.findByText('NEW BOOKING');
    expect(screen.queryByRole('option', { name: 'Kitchen is too busy' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Decline' }));

    await waitFor(() => {
      const call = fetchMock.mock.calls.find(([url]) => String(url).includes('/orders/order-live/reject'));
      expect(call).toBeTruthy();
      expect(JSON.parse(String(call![1]?.body))).toEqual({ reason: 'Fully booked at that time' });
    });
  });

  it('shows a booking at the market time without kitchen prep controls', async () => {
    const raw = {
      ...wireVendorOrder(), fulfillment: 'APPOINTMENT', appointmentSlot: '2026-09-24T13:00:00.000Z',
    };
    const { rerender } = renderWithQuery(<NewOrderTakeover orders={[]} />);
    rerender(<NewOrderTakeover orders={[normalizeVendorOrder(raw)]} />);
    expect(await screen.findByText('NEW BOOKING')).toBeTruthy();
    expect(screen.getByText(/9:00 AM/)).toBeTruthy();
    expect(screen.queryByText('20 min prep')).toBeNull();
    expect(screen.getByRole('button', { name: 'Decline' })).toBeTruthy();
  });
});
