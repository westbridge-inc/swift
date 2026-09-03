import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import OrdersPage from './page';
import {
  API_ORIGIN,
  mockApi,
  renderWithQuery,
  requestsByMethod,
  type ApiRequest,
} from '@/test/test-utils';

const otherOrder = {
  id: 'order-other',
  orderNumber: 'ORDER-OTHER',
  orderType: 'FOOD',
  fulfillment: 'DELIVERY',
  status: 'PENDING',
  paymentMethod: 'CASH',
  paymentStatus: 'PENDING',
  totalAmount: 1200,
  vendor: { id: 'vendor-other', name: 'Other Store' },
};

const targetOrder = {
  ...otherOrder,
  id: 'order-target',
  orderNumber: 'ORDER-TARGET',
  totalAmount: 3400,
  vendor: { id: 'vendor-target', name: 'Target Store' },
};

function ordersHandler(
  mutation: (_request: ApiRequest) => { body: unknown; status?: number },
  orders = [otherOrder, targetOrder],
) {
  return (request: ApiRequest) => {
    if (request.method === 'GET' && request.url.pathname === '/api/v1/admin/orders') {
      return { body: { success: true, data: orders } };
    }
    return mutation(request);
  };
}

async function targetRow() {
  const orderNumber = await screen.findByText('ORDER-TARGET');
  const row = orderNumber.closest('tr');
  if (!row) throw new Error('Target order row was not rendered');
  return within(row);
}

describe('order list money controls', () => {
  it('binds the visible row to the exact cash-refund request and store-attributed confirmation', async () => {
    const confirm = vi.fn().mockReturnValueOnce(false).mockReturnValueOnce(true);
    vi.stubGlobal('confirm', confirm);
    const fetchMock = mockApi(
      ordersHandler((request) => {
        if (
          request.method === 'PUT' &&
          request.url.pathname === '/api/v1/admin/orders/order-target/cancel'
        ) {
          return { body: { success: true, data: { orderId: 'order-target', status: 'REFUNDED' } } };
        }
        throw new Error(`Unexpected request: ${request.method} ${request.url}`);
      }),
    );
    const { user } = renderWithQuery(<OrdersPage />);
    const row = await targetRow();
    const refundButton = row.getByRole('button', { name: 'Record refund owed' });

    await user.click(refundButton);
    expect(confirm).toHaveBeenNthCalledWith(
      1,
      'Cancel order ORDER-TARGET and record that Target Store OWES the customer a refund?'
      + '\n\nThis does not mark anything refunded — settle it on the order page'
      + ' once the reference and the amount handed back are known.',
    );
    expect(requestsByMethod(fetchMock, 'PUT')).toHaveLength(0);

    await user.click(refundButton);
    await waitFor(() => expect(requestsByMethod(fetchMock, 'PUT')).toHaveLength(1));
    const [url, init] = requestsByMethod(fetchMock, 'PUT')[0]!;
    expect(url).toBe(`${API_ORIGIN}/api/v1/admin/orders/order-target/cancel`);
    expect(init?.method).toBe('PUT');
    expect(JSON.parse(String(init?.body))).toEqual({
      reason: 'Cancelled by admin',
      refund: true,
    });
  });

  it('does not offer a Swift refund for MMG and explains the store-direct rail', async () => {
    const confirm = vi.fn().mockReturnValue(false);
    vi.stubGlobal('confirm', confirm);
    const mmgOrder = {
      ...targetOrder,
      paymentMethod: 'MOBILE_MONEY',
      paymentStatus: 'CAPTURED',
    };
    const fetchMock = mockApi(
      ordersHandler((_request) => {
        throw new Error('No mutation expected');
      }, [mmgOrder]),
    );
    const { user } = renderWithQuery(<OrdersPage />);
    const row = await targetRow();

    expect(row.queryByRole('button', { name: 'Record refund owed' })).toBeNull();
    await user.click(row.getByRole('button', { name: 'Cancel' }));

    expect(confirm).toHaveBeenCalledWith(
      'Cancel order ORDER-TARGET?\n\nMMG payment stays between customer and store. If paid, it is refunded by Target Store; Swift cannot refund it.',
    );
    expect(requestsByMethod(fetchMock, 'PUT')).toHaveLength(0);
  });
});
