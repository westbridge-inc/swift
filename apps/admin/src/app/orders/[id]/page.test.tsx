import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

const REASON = 'Repeated no-shows after three written warnings';
type User = ReturnType<typeof renderWithQuery>['user'];

/** [MC-MONEY] Types the reason into the open panel and presses its confirm button. */
async function giveReason(user: User, dialog: HTMLElement, confirmLabel: string) {
  await user.type(within(dialog).getByRole('textbox', { name: 'Reason' }), REASON);
  await user.click(within(dialog).getByRole('button', { name: confirmLabel }));
}

beforeEach(() => {
  // [MC-MONEY] no browser prompt or confirm is ever the way in
  vi.stubGlobal('prompt', vi.fn(() => { throw new Error('window.prompt was called'); }));
  vi.stubGlobal('confirm', vi.fn(() => { throw new Error('window.confirm was called'); }));
});
afterEach(() => vi.unstubAllGlobals());

describe('order cancel and refund mutations', () => {
  it('names the order, asks why, and sends a plain cancellation to the exact endpoint and payload; a cancelled panel sends nothing', async () => {
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
    const cancelButton = await screen.findByRole('button', { name: 'Cancel order…' });

    await user.click(cancelButton);
    let dialog = screen.getByRole('dialog', { name: 'Cancel order ORDER-TEST-1?' });
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(requestsByMethod(fetchMock, 'PUT')).toHaveLength(0);

    await user.click(cancelButton);
    dialog = screen.getByRole('dialog', { name: 'Cancel order ORDER-TEST-1?' });
    // [ADM-006] the operator is asked why; the reason is theirs, not a template
    await giveReason(user, dialog, 'Cancel order');
    await waitFor(() => expect(requestsByMethod(fetchMock, 'PUT')).toHaveLength(1));
    const [url, init] = requestsByMethod(fetchMock, 'PUT')[0]!;
    expect(url).toBe(`${API_ORIGIN}/api/v1/admin/orders/order-1/cancel`);
    expect(init?.method).toBe('PUT');
    expect(JSON.parse(String(init?.body))).toEqual({ reason: REASON, refund: false });
    expect((await screen.findByRole('status')).textContent).toContain('Order ORDER-TEST-1 is cancelled.');
  });

  it('cancel-plus-refund says the store OWES a refund and that nothing is marked refunded, then sends refund=true', async () => {
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
    await user.click(await screen.findByRole('button', { name: 'Record refund owed…' }));
    const dialog = screen.getByRole('dialog', { name: 'Cancel order ORDER-TEST-1 and record a refund owed?' });
    expect(dialog.textContent).toContain('This records that Test Store OWES the customer a refund. It does not mark anything refunded');
    expect(dialog.textContent).toContain('the reference and the amount actually handed back');
    await giveReason(user, dialog, 'Cancel and record refund owed');
    await waitFor(() => expect(requestsByMethod(fetchMock, 'PUT')).toHaveLength(1));
    const [url, init] = requestsByMethod(fetchMock, 'PUT')[0]!;
    expect(url).toBe(`${API_ORIGIN}/api/v1/admin/orders/order-1/cancel`);
    expect(JSON.parse(String(init?.body))).toEqual({ reason: REASON, refund: true });
  });

  it.each([
    ['Cancel order…', 'Cancel order'],
    ['Record refund owed…', 'Cancel and record refund owed'],
  ])(
    'renders a %s failure in the panel without changing the visible order state',
    async (buttonName, confirmLabel) => {
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
      await user.click(await screen.findByRole('button', { name: buttonName }));
      const dialog = screen.getByRole('dialog');
      await giveReason(user, dialog, confirmLabel);

      expect((await within(dialog).findByRole('alert')).textContent).toContain(
        'Cannot cancel an order with status COMPLETED',
      );
      await user.click(within(dialog).getByRole('button', { name: 'Close' }));
      expect(screen.getByRole('alert').textContent).toContain('Cannot cancel an order with status COMPLETED');
      expect(screen.getByRole('heading', { name: '#ORDER-TEST-1' })).toBeTruthy();
      expect(screen.getByText('PENDING')).toBeTruthy();
      expect(requestsByMethod(fetchMock, 'PUT')).toHaveLength(1);
      expect(requestsByMethod(fetchMock, 'GET')).toHaveLength(1);
    },
  );

  it('locks the panel while the cash-refund cancel is pending and sends only one money mutation', async () => {
    const pending = deferredReply();
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
    const refundButton = await screen.findByRole('button', { name: 'Record refund owed…' });

    await user.click(refundButton);
    const dialog = screen.getByRole('dialog');
    await giveReason(user, dialog, 'Cancel and record refund owed');
    await waitFor(() => expect(requestsByMethod(fetchMock, 'PUT')).toHaveLength(1));
    const sending = within(dialog).getByRole('button', { name: 'Sending…' }) as HTMLButtonElement;
    expect(sending.disabled).toBe(true);
    await user.click(sending);
    await user.click(refundButton);
    expect(requestsByMethod(fetchMock, 'PUT')).toHaveLength(1);

    pending.resolve({ body: { success: true, data: {} } });
    await waitFor(() => expect(requestsByMethod(fetchMock, 'GET')).toHaveLength(2));
  });

  it('never offers Swift refund controls for MMG and names the direct store refund rail', async () => {
    const mmgOrder = { ...order, paymentMethod: 'MOBILE_MONEY', paymentStatus: 'CAPTURED' };
    const fetchMock = mockApi(
      orderHandler((_request) => {
        throw new Error('No mutation expected');
      }, mmgOrder),
    );
    const { user } = renderWithQuery(
      <OrderDetailPage params={fulfilledParams({ id: 'order-1' })} />,
    );

    const cancelButton = await screen.findByRole('button', { name: 'Cancel order…' });
    expect(screen.queryByRole('button', { name: 'Record refund owed…' })).toBeNull();
    await user.click(cancelButton);
    const dialog = screen.getByRole('dialog', { name: 'Cancel order ORDER-TEST-1?' });
    expect(dialog.textContent).toContain(
      'MMG payment stays between customer and store. If paid, it is refunded by Test Store; Swift cannot refund it.',
    );
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
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
    const fetchMock = mockApi(orderHandler((request) => {
      if (request.method === 'PUT' && request.url.pathname === '/api/v1/admin/orders/order-1/refund-settled') {
        return { body: { success: true, data: {} } };
      }
      throw new Error(`Unexpected request: ${request.method} ${request.url}`);
    }, owedOrder));

    const { user } = renderWithQuery(<OrderDetailPage params={fulfilledParams({ id: 'order-1' })} />);
    await user.click(await screen.findByRole('button', { name: 'Record refund handed back…' }));
    const dialog = screen.getByRole('dialog', { name: 'Record the refund handed back for order ORDER-TEST-1?' });
    await user.type(within(dialog).getByRole('textbox', { name: 'Reason' }), 'Cash handed back against receipt CASH-REF-001');
    // the reason alone is not evidence: both fields are refused, nothing is sent
    await user.click(within(dialog).getByRole('button', { name: 'Record refund' }));
    expect(within(dialog).getByText(/Enter the reference/)).toBeTruthy();
    expect(within(dialog).getByText(/Enter the amount/)).toBeTruthy();
    expect(requestsByMethod(fetchMock, 'PUT')).toHaveLength(0);
    await user.type(within(dialog).getByRole('textbox', { name: 'Reference' }), 'CASH-REF-001');
    await user.click(within(dialog).getByRole('button', { name: 'Record refund' }));
    expect(requestsByMethod(fetchMock, 'PUT')).toHaveLength(0);
    // what was typed is what is sent — the server, not the console, compares it
    // with what is owed (a console that filled in the owed figure would make the
    // attestation empty)
    await user.type(within(dialog).getByRole('textbox', { name: 'Amount handed back' }), '2,400');
    await user.click(within(dialog).getByRole('button', { name: 'Record refund' }));

    await waitFor(() => expect(requestsByMethod(fetchMock, 'PUT')).toHaveLength(1));
    const [url, init] = requestsByMethod(fetchMock, 'PUT')[0]!;
    expect(url).toBe(`${API_ORIGIN}/api/v1/admin/orders/order-1/refund-settled`);
    expect(JSON.parse(String(init?.body))).toEqual({ reference: 'CASH-REF-001', amount: 2400 });
  });

  it('a cancelled panel sends NO money mutation', async () => {
    const fetchMock = mockApi(orderHandler(() => {
      throw new Error('no mutation expected');
    }, owedOrder));

    const { user } = renderWithQuery(<OrderDetailPage params={fulfilledParams({ id: 'order-1' })} />);
    await user.click(await screen.findByRole('button', { name: 'Record refund handed back…' }));
    const dialog = screen.getByRole('dialog');
    await user.type(within(dialog).getByRole('textbox', { name: 'Reference' }), 'CASH-REF-002');
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(requestsByMethod(fetchMock, 'PUT')).toHaveLength(0);
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
