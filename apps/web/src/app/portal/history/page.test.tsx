import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import HistoryPage from './page';
import { mockApi, renderWithQuery } from '@/test/test-utils';

describe('phone history', () => {
  it('keeps order, store, status, and amount together in a delivery card', async () => {
    mockApi(({ url }) => {
      if (url.pathname === '/api/v1/rider/profile') return { body: { data: { id: 'rider-1' } } };
      if (url.pathname === '/api/v1/driver/profile') return { status: 404, body: { error: 'Absent' } };
      if (url.pathname === '/api/v1/rider/orders') return { body: { data: [{ id: 'delivery-1', orderNumber: 'SW-1001', vendor: { name: 'Fixture Market' }, status: 'DELIVERED', deliveryFee: '800.00', placedAt: '2026-09-29T18:00:00Z' }], meta: { totalPages: 1 } } };
      throw new Error(`Unexpected request: ${url}`);
    });
    renderWithQuery(<HistoryPage />);
    const card = await screen.findByRole('article', { name: 'Delivery SW-1001' });
    expect(card.textContent).toContain('Fixture Market');
    expect(card.textContent).toContain('DELIVERED');
    expect(card.textContent).toContain('$800');
    expect(card.className).toContain('sm:hidden');
  });

  it('keeps ride status, fare, and tip together in a phone card', async () => {
    mockApi(({ url }) => {
      if (url.pathname === '/api/v1/rider/profile') return { status: 404, body: { error: 'Absent' } };
      if (url.pathname === '/api/v1/driver/profile') return { body: { data: { id: 'driver-1' } } };
      if (url.pathname === '/api/v1/driver/rides') return { body: { data: [{ id: 'ride-1', orderNumber: 'SW-2001', status: 'COMPLETED', taxiPickupAddress: 'Market Street', taxiDropoffAddress: 'Camp Street', taxiFareTotal: '2500.00', tipAmount: '200.00' }], meta: { totalPages: 1 } } };
      throw new Error(`Unexpected request: ${url}`);
    });
    renderWithQuery(<HistoryPage />);
    const card = await screen.findByRole('article', { name: 'Ride SW-2001' });
    expect(card.textContent).toContain('COMPLETED');
    expect(card.textContent).toContain('$2,500');
    expect(card.textContent).toContain('$200');
  });
});
