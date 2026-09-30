import { screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import PortalHome from './page';
import { mockApi, renderWithQuery } from '@/test/test-utils';

afterEach(() => { vi.unstubAllGlobals(); });

describe('portal money presentation', () => {
  it('uses GY$ for real earnings and an em-dash for absent or unreadable fees', async () => {
    mockApi(({ url }) => {
      const path = url.pathname;
      if (path === '/api/v1/rider/profile') return { body: { data: { id: 'rider-1' } } };
      if (path === '/api/v1/driver/profile') return { status: 404, body: { error: 'No driver profile' } };
      if (path === '/api/v1/rider/earnings/summary') return { body: { data: {
        today: { total: 3500, count: 1 }, thisWeek: { total: 8000, count: 2 },
        thisMonth: { total: 12000, count: 3 }, allTime: { total: 25000, count: 4 },
      } } };
      if (path === '/api/v1/rider/subscription') return { body: { data: { status: 'ACTIVE' } } };
      if (path === '/api/v1/rider/cash-settlements') return { body: { data: {
        summary: { count: 1 }, unsettled: [{ id: 'settle-1', amount: 'unreadable', status: 'PENDING',
          vendor: { name: 'Fixture Store' }, order: { orderNumber: 'SW-1' } }], settled: [],
      } } };
      throw new Error(`Unexpected request: ${path}`);
    });
    renderWithQuery(<PortalHome />);
    expect(await screen.findByText('GY$3,500')).toBeTruthy();
    expect(screen.getByText(/Stores owe you — in delivery fees/)).toBeTruthy();
    expect(screen.getByText(/—\/week/)).toBeTruthy();
    expect(screen.queryByText(/\$NaN|GY\$0\/week|\$0\/week/)).toBeNull();
  });
});
