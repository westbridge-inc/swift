import { screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import FinancePage from './page';
import {
  API_ORIGIN,
  mockApi,
  renderWithQuery,
  requestsByMethod,
  type ApiRequest,
} from '@/test/test-utils';

const settlement = {
  id: 'settlement-1',
  totalBase: 12000,
  periodStart: '2026-08-01T00:00:00.000Z',
  periodEnd: '2026-08-08T00:00:00.000Z',
  vendor: { name: 'Test Vendor' },
};

function financeHandler(mutation: (_request: ApiRequest) => { body: unknown; status?: number }) {
  return (request: ApiRequest) => {
    if (request.method === 'GET' && request.url.pathname === '/api/v1/admin/finance/revenue') {
      return {
        body: {
          success: true,
          data: {
            dailyRevenue: [],
            summary: {
              weeklySubscriptionRevenue: 0,
              monthlySubscriptionRevenue: 0,
              activeSubscriptions: 0,
              thirtyDayDeliveryFees: 0,
            },
          },
        },
      };
    }
    if (request.method === 'GET' && request.url.pathname === '/api/v1/admin/finance/settlements') {
      expect(request.url.search).toBe('?limit=50&status=PENDING');
      return { body: { success: true, data: [settlement] } };
    }
    if (request.method === 'GET' && request.url.pathname === '/api/v1/admin/finance/payment-mix') {
      return { body: { success: true, data: { byMethod: [], mmgUnconfirmed: 0 } } };
    }
    if (request.method === 'GET' && request.url.pathname === '/api/v1/admin/finance/cash-settlements') {
      return {
        body: {
          success: true,
          data: [],
          meta: { page: 1, limit: 50, total: 0, totalPages: 0 },
          summary: {},
        },
      };
    }
    return mutation(request);
  };
}

describe('finance settlement mutation', () => {
  it('collects a reference, confirms, and marks paid through the exact endpoint and payload', async () => {
    const prompt = vi.fn().mockReturnValue('BANK-TEST-1');
    const confirm = vi.fn().mockReturnValueOnce(false).mockReturnValueOnce(true);
    vi.stubGlobal('prompt', prompt);
    vi.stubGlobal('confirm', confirm);
    const fetchMock = mockApi(
      financeHandler((request) => {
        if (
          request.method === 'PUT' &&
          request.url.pathname === '/api/v1/admin/finance/settlements/settlement-1/process'
        ) {
          return { body: { success: true, data: {} } };
        }
        throw new Error(`Unexpected request: ${request.method} ${request.url}`);
      }),
    );
    const { user } = renderWithQuery(<FinancePage />);
    const paidButton = await screen.findByRole('button', { name: 'Mark paid' });

    await user.click(paidButton);
    expect(prompt).toHaveBeenNthCalledWith(
      1,
      'Bank/transfer reference for Test Vendor (optional):',
    );
    expect(confirm).toHaveBeenNthCalledWith(1, 'Mark this settlement PAID?');
    expect(requestsByMethod(fetchMock, 'PUT')).toHaveLength(0);

    await user.click(paidButton);
    await waitFor(() => expect(requestsByMethod(fetchMock, 'PUT')).toHaveLength(1));
    const [url, init] = requestsByMethod(fetchMock, 'PUT')[0]!;
    expect(prompt).toHaveBeenNthCalledWith(
      2,
      'Bank/transfer reference for Test Vendor (optional):',
    );
    expect(confirm).toHaveBeenNthCalledWith(2, 'Mark this settlement PAID?');
    expect(url).toBe(
      `${API_ORIGIN}/api/v1/admin/finance/settlements/settlement-1/process`,
    );
    expect(init?.method).toBe('PUT');
    expect(JSON.parse(String(init?.body))).toEqual({ reference: 'BANK-TEST-1' });
  });

  it('renders a settlement failure and keeps the pending settlement visible', async () => {
    vi.stubGlobal('prompt', vi.fn().mockReturnValue('BANK-TEST-2'));
    vi.stubGlobal('confirm', vi.fn().mockReturnValue(true));
    const fetchMock = mockApi(
      financeHandler((request) => {
        if (
          request.method === 'PUT' &&
          request.url.pathname === '/api/v1/admin/finance/settlements/settlement-1/process'
        ) {
          return {
            status: 400,
            body: {
              success: false,
              error: { code: 'ALREADY_PAID', message: 'Settlement has already been processed' },
            },
          };
        }
        throw new Error(`Unexpected request: ${request.method} ${request.url}`);
      }),
    );
    const { user } = renderWithQuery(<FinancePage />);
    const paidButton = await screen.findByRole('button', { name: 'Mark paid' });

    await user.click(paidButton);

    expect((await screen.findByRole('alert')).textContent).toContain(
      'Settlement update failed: Settlement has already been processed',
    );
    expect(screen.getByText('Test Vendor')).toBeTruthy();
    expect((paidButton as HTMLButtonElement).disabled).toBe(false);
    expect(requestsByMethod(fetchMock, 'PUT')).toHaveLength(1);
    const settlementReads = requestsByMethod(fetchMock, 'GET').filter(([url]) =>
      String(url).includes('/api/v1/admin/finance/settlements?'),
    );
    expect(settlementReads).toHaveLength(1);
  });
});
