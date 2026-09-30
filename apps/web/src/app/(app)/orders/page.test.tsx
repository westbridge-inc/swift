import { screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import OrdersPage from './page';
import { mockApi, renderWithQuery } from '@/test/test-utils';

vi.mock('@/components/customer-session', () => ({
  useCustomerSession: () => ({ scope: 'fixture-customer', epoch: 0 }),
}));

afterEach(() => { vi.unstubAllGlobals(); });

describe('customer order total presentation', () => {
  it('does not invent a zero for a missing total', async () => {
    mockApi(({ url }) => {
      if (url.pathname !== '/api/v1/customer/orders') throw new Error(`Unexpected request: ${url.pathname}`);
      return { body: { data: [{ id: 'order-1', orderNumber: 'SW-1001', status: 'PENDING',
        vendorName: 'Fixture Market', items: [{ id: 'line-1' }] }] } };
    });
    renderWithQuery(<OrdersPage />);
    const row = await screen.findByText('Fixture Market');
    expect(row.closest('a')?.textContent).toContain('—');
    expect(row.closest('a')?.textContent).not.toContain('GY$0');
  });
});
