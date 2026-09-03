import { screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import OrderDetailPage from './page';
import {
  API_ORIGIN,
  fulfilledParams,
  mockApi,
  renderWithQuery,
  requestsByMethod,
  type ApiReply,
  type ApiRequest,
} from '@/test/test-utils';

const order = {
  id: 'order-1',
  orderNumber: 'ORDER-TEST-1',
  status: 'PENDING',
  orderType: 'FOOD',
  paymentMethod: 'CASH',
  paymentStatus: 'PENDING',
  items: [],
  statusHistory: [],
  totalAmount: 2500,
  subtotalCustomer: 2000,
  deliveryFee: 500,
  vendor: { id: 'vendor-1', name: 'Test Store' },
};

function orderHandler(
  mutation: (_request: ApiRequest) => ApiReply | Promise<ApiReply>,
  visibleOrder = order,
) {
  return (request: ApiRequest) => {
    if (request.method === 'GET' && request.url.pathname === '/api/v1/admin/orders/order-1') {
      return { body: { success: true, data: visibleOrder } };
    }
    return mutation(request);
  };
}

function deferredReply() {
  let resolve!: (_reply: ApiReply) => void;
  const promise = new Promise<ApiReply>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('order cancel and refund mutations', () => {
  it('confirms and sends a plain cancellation to the exact endpoint and payload', async () => {
    const confirm = vi.fn().mockReturnValueOnce(false).mockReturnValueOnce(true);
    vi.stubGlobal('confirm', confirm);
    const fetchMock = mockApi(
      orderHandler((request) => {
        if (request.method === 'PUT' && request.url.pathname === '/api/v1/admin/orders/order-1/cancel') {
          return { body: { success: true, data: {} } };
        }
        throw new Error(`Unexpected request: ${request.method} ${request.url}`);
      }),
    );
    const { user } = renderWithQuery(
      <OrderDetailPage params={fulfilledParams({ id: 'order-1' })} />,
    );
    const cancelButton = await screen.findByRole('button', { name: 'Cancel order' });

    await user.click(cancelButton);
    expect(confirm).toHaveBeenNthCalledWith(1, 'Cancel order ORDER-TEST-1?');
    expect(requestsByMethod(fetchMock, 'PUT')).toHaveLength(0);

    await user.click(cancelButton);
    await waitFor(() => expect(requestsByMethod(fetchMock, 'PUT')).toHaveLength(1));
    const [url, init] = requestsByMethod(fetchMock, 'PUT')[0]!;
    expect(confirm).toHaveBeenNthCalledWith(2, 'Cancel order ORDER-TEST-1?');
    expect(url).toBe(`${API_ORIGIN}/api/v1/admin/orders/order-1/cancel`);
    expect(init?.method).toBe('PUT');
    expect(JSON.parse(String(init?.body))).toEqual({
      reason: 'Cancelled by admin',
      refund: false,
    });
  });

  it('confirms and sends cancel-plus-refund with refund=true', async () => {
    const confirm = vi.fn().mockReturnValueOnce(false).mockReturnValueOnce(true);
    vi.stubGlobal('confirm', confirm);
    const fetchMock = mockApi(
      orderHandler((request) => {
        if (request.method === 'PUT' && request.url.pathname === '/api/v1/admin/orders/order-1/cancel') {
          return { body: { success: true, data: {} } };
        }
        throw new Error(`Unexpected request: ${request.method} ${request.url}`);
      }),
    );
    const { user } = renderWithQuery(
      <OrderDetailPage params={fulfilledParams({ id: 'order-1' })} />,
    );
    const refundButton = await screen.findByRole('button', { name: 'Record refund owed' });

    await user.click(refundButton);
    expect(confirm).toHaveBeenNthCalledWith(
      1,
      'Cancel ORDER-TEST-1 and record that Test Store OWES the customer a refund?'
      + '\n\nThis does not mark anything refunded. The order stays in the outstanding'
      + ' list until someone records the reference and the amount actually handed back.',
    );
    expect(requestsByMethod(fetchMock, 'PUT')).toHaveLength(0);

    await user.click(refundButton);
    await waitFor(() => expect(requestsByMethod(fetchMock, 'PUT')).toHaveLength(1));
    const [url, init] = requestsByMethod(fetchMock, 'PUT')[0]!;
    expect(confirm).toHaveBeenNthCalledWith(
      2,
      'Cancel ORDER-TEST-1 and record that Test Store OWES the customer a refund?'
      + '\n\nThis does not mark anything refunded. The order stays in the outstanding'
      + ' list until someone records the reference and the amount actually handed back.',
    );
    expect(url).toBe(`${API_ORIGIN}/api/v1/admin/orders/order-1/cancel`);
    expect(init?.method).toBe('PUT');
    expect(JSON.parse(String(init?.body))).toEqual({
      reason: 'Cancelled by admin',
      refund: true,
    });
  });

  it.each(['Cancel order', 'Record refund owed'])(
    'renders a %s failure without changing the visible order state',
    async (buttonName) => {
      vi.stubGlobal('confirm', vi.fn().mockReturnValue(true));
      const fetchMock = mockApi(
        orderHandler((request) => {
          if (request.method === 'PUT' && request.url.pathname === '/api/v1/admin/orders/order-1/cancel') {
            return {
              status: 400,
              body: {
                success: false,
                error: {
                  code: 'INVALID_STATUS',
                  message: 'Cannot cancel an order with status COMPLETED',
                },
              },
            };
          }
          throw new Error(`Unexpected request: ${request.method} ${request.url}`);
        }),
      );
      const { user } = renderWithQuery(
        <OrderDetailPage params={fulfilledParams({ id: 'order-1' })} />,
      );
      const actionButton = await screen.findByRole('button', { name: buttonName });

      await user.click(actionButton);

      expect((await screen.findByRole('alert')).textContent).toContain(
        'Order cancellation failed: Cannot cancel an order with status COMPLETED',
      );
      expect(screen.getByRole('heading', { name: '#ORDER-TEST-1' })).toBeTruthy();
      expect(screen.getByText('PENDING')).toBeTruthy();
      expect((actionButton as HTMLButtonElement).disabled).toBe(false);
      expect(requestsByMethod(fetchMock, 'PUT')).toHaveLength(1);
      expect(requestsByMethod(fetchMock, 'GET')).toHaveLength(1);
    },
  );

  it('disables the cash-refund control while pending and sends only one money mutation', async () => {
    const pending = deferredReply();
    vi.stubGlobal('confirm', vi.fn().mockReturnValue(true));
    const fetchMock = mockApi(
      orderHandler((request) => {
        if (request.method === 'PUT' && request.url.pathname === '/api/v1/admin/orders/order-1/cancel') {
          return pending.promise;
        }
        throw new Error(`Unexpected request: ${request.method} ${request.url}`);
      }),
    );
    const { user } = renderWithQuery(
      <OrderDetailPage params={fulfilledParams({ id: 'order-1' })} />,
    );
    const refundButton = await screen.findByRole('button', { name: 'Record refund owed' });

    await user.click(refundButton);
    await waitFor(() => expect(requestsByMethod(fetchMock, 'PUT')).toHaveLength(1));
    expect((refundButton as HTMLButtonElement).disabled).toBe(true);

    await user.click(refundButton);
    expect(requestsByMethod(fetchMock, 'PUT')).toHaveLength(1);

    pending.resolve({ body: { success: true, data: {} } });
    await waitFor(() => expect(requestsByMethod(fetchMock, 'GET')).toHaveLength(2));
  });

  it('never offers Swift refund controls for MMG and names the direct store refund rail', async () => {
    const confirm = vi.fn().mockReturnValue(false);
    vi.stubGlobal('confirm', confirm);
    const mmgOrder = { ...order, paymentMethod: 'MOBILE_MONEY', paymentStatus: 'CAPTURED' };
    const fetchMock = mockApi(
      orderHandler((_request) => {
        throw new Error('No mutation expected');
      }, mmgOrder),
    );
    const { user } = renderWithQuery(
      <OrderDetailPage params={fulfilledParams({ id: 'order-1' })} />,
    );

    const cancelButton = await screen.findByRole('button', { name: 'Cancel order' });
    expect(screen.queryByRole('button', { name: 'Record refund owed' })).toBeNull();
    await user.click(cancelButton);

    expect(confirm).toHaveBeenCalledWith(
      'Cancel order ORDER-TEST-1?\n\nMMG payment stays between customer and store. If paid, it is refunded by Test Store; Swift cannot refund it.',
    );
    expect(requestsByMethod(fetchMock, 'PUT')).toHaveLength(0);
  });
});


// ---------------------------------------------------------------------------
// [A-14] Deciding a refund is owed and proving it was handed back are two acts.
// The console must never let the first look like the second.
// ---------------------------------------------------------------------------
const owedOrder = {
  ...order,
  status: 'CANCELLED',
  refundOwedAmount: 2500,
  refundOwedAt: '2026-09-03T10:00:00.000Z',
  refundOwedById: 'admin-1',
  refundRef: null,
  refundPaidAmount: null,
  refundSettledAt: null,
};

describe('[A-14] an unsettled refund obligation', () => {
  it('says the money has NOT moved, and names the amount and the moment it was recorded', async () => {
    mockApi(orderHandler(() => {
      throw new Error('no mutation expected');
    }, owedOrder));

    renderWithQuery(<OrderDetailPage params={fulfilledParams({ id: 'order-1' })} />);

    expect(await screen.findByText('Refund owed — not yet settled')).toBeTruthy();
    expect(screen.getByText(/GY\$2,500 recorded as owed/)).toBeTruthy();
    expect(screen.getByText(/Nothing here says the money moved/)).toBeTruthy();
  });

  it('settles only with a reference AND an amount, and sends both to the settle endpoint', async () => {
    const prompt = vi.fn()
      .mockReturnValueOnce('CASH-REF-001')
      .mockReturnValueOnce('2500');
    vi.stubGlobal('prompt', prompt);
    const fetchMock = mockApi(orderHandler((request) => {
      if (request.method === 'PUT' && request.url.pathname === '/api/v1/admin/orders/order-1/refund-settled') {
        return { body: { success: true, data: {} } };
      }
      throw new Error(`Unexpected request: ${request.method} ${request.url}`);
    }, owedOrder));

    const { user } = renderWithQuery(<OrderDetailPage params={fulfilledParams({ id: 'order-1' })} />);
    await user.click(await screen.findByRole('button', { name: 'Record refund handed back' }));

    await waitFor(() => expect(requestsByMethod(fetchMock, 'PUT')).toHaveLength(1));
    const [url, init] = requestsByMethod(fetchMock, 'PUT')[0]!;
    expect(url).toBe(`${API_ORIGIN}/api/v1/admin/orders/order-1/refund-settled`);
    expect(JSON.parse(String(init?.body))).toEqual({ reference: 'CASH-REF-001', amount: '2500' });
  });

  it('abandoning either prompt sends NO money mutation', async () => {
    for (const answers of [[null], ['CASH-REF-002', null]]) {
      const prompt = vi.fn();
      answers.forEach((a) => prompt.mockReturnValueOnce(a));
      vi.stubGlobal('prompt', prompt);
      const fetchMock = mockApi(orderHandler(() => {
        throw new Error('no mutation expected');
      }, owedOrder));

      const { user } = renderWithQuery(<OrderDetailPage params={fulfilledParams({ id: 'order-1' })} />);
      await user.click(await screen.findByRole('button', { name: 'Record refund handed back' }));

      await waitFor(() => expect(prompt).toHaveBeenCalledTimes(answers.length));
      expect(requestsByMethod(fetchMock, 'PUT')).toHaveLength(0);
    }
  });

  it('a settled refund shows its evidence, and the owed banner is gone', async () => {
    mockApi(orderHandler(() => {
      throw new Error('no mutation expected');
    }, {
      ...owedOrder,
      status: 'REFUNDED',
      refundRef: 'CASH-REF-003',
      refundPaidAmount: 2500,
      refundSettledAt: '2026-09-03T11:00:00.000Z',
    }));

    renderWithQuery(<OrderDetailPage params={fulfilledParams({ id: 'order-1' })} />);

    expect(await screen.findByText('Refund settled')).toBeTruthy();
    expect(screen.getByText(/CASH-REF-003/)).toBeTruthy();
    expect(screen.queryByText('Refund owed — not yet settled')).toBeNull();
  });
});
