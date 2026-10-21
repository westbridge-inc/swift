import { screen, waitFor, within } from '@testing-library/react';
import type userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
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
type User = ReturnType<typeof userEvent.setup>;

/** Opens the panel with `opener`; the panel names the order before anything is sent. */
async function openPanel(user: User, opener: string) {
  await user.click(await screen.findByRole('button', { name: opener }));
  return screen.findByRole('dialog');
}
async function giveReason(user: User, panel: HTMLElement, reason = REASON) {
  await user.type(within(panel).getByRole('textbox', { name: 'Reason' }), reason);
}

describe('order cancel and refund mutations', () => {
  it('confirms and sends a plain cancellation to the exact endpoint and payload', async () => {
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

    let panel = await openPanel(user, 'Cancel order');
    expect(within(panel).getByRole('heading').textContent).toBe('Cancel order ORDER-TEST-1?');
    await user.click(within(panel).getByRole('button', { name: 'Keep the order' }));
    expect(requestsByMethod(fetchMock, 'PUT')).toHaveLength(0);

    panel = await openPanel(user, 'Cancel order');
    // [ADM-006] the operator is asked why; the reason is theirs, not a template
    await giveReason(user, panel);
    await user.click(within(panel).getByRole('button', { name: 'Cancel order' }));
    await waitFor(() => expect(requestsByMethod(fetchMock, 'PUT')).toHaveLength(1));
    const [url, init] = requestsByMethod(fetchMock, 'PUT')[0]!;
    expect(url).toBe(`${API_ORIGIN}/api/v1/admin/orders/order-1/cancel`);
    expect(init?.method).toBe('PUT');
    expect(JSON.parse(String(init?.body))).toEqual({ reason: REASON, refund: false });
    expect(await screen.findByText('Order ORDER-TEST-1 cancelled.')).toBeTruthy();
  });

  it('confirms and sends cancel-plus-refund with refund=true', async () => {
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

    let panel = await openPanel(user, 'Record refund owed');
    expect(within(panel).getByRole('heading').textContent).toBe('Cancel ORDER-TEST-1 and record that Test Store owes the customer a refund?');
    expect(panel.textContent).toContain('This does not mark anything refunded.');
    await user.click(within(panel).getByRole('button', { name: 'Keep the order' }));
    expect(requestsByMethod(fetchMock, 'PUT')).toHaveLength(0);

    panel = await openPanel(user, 'Record refund owed');
    await giveReason(user, panel);
    await user.click(within(panel).getByRole('button', { name: 'Cancel and record refund owed' }));
    await waitFor(() => expect(requestsByMethod(fetchMock, 'PUT')).toHaveLength(1));
    const [url, init] = requestsByMethod(fetchMock, 'PUT')[0]!;
    expect(url).toBe(`${API_ORIGIN}/api/v1/admin/orders/order-1/cancel`);
    expect(init?.method).toBe('PUT');
    expect(JSON.parse(String(init?.body))).toEqual({ reason: REASON, refund: true });
  });

  it.each([['Cancel order', 'Cancel order'], ['Record refund owed', 'Cancel and record refund owed']])(
    'renders a %s failure without changing the visible order state',
    async (buttonName, confirmName) => {
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
      const panel = await openPanel(user, buttonName);
      await giveReason(user, panel);
      await user.click(within(panel).getByRole('button', { name: confirmName }));

      expect((await within(panel).findByRole('alert')).textContent).toContain('Cannot cancel an order with status COMPLETED');
      expect(screen.getByRole('heading', { name: '#ORDER-TEST-1' })).toBeTruthy();
      expect(screen.getByText('Waiting to be accepted')).toBeTruthy();
      expect(requestsByMethod(fetchMock, 'PUT')).toHaveLength(1);
      expect(requestsByMethod(fetchMock, 'GET')).toHaveLength(1);
    },
  );

  it('disables the cash-refund control while pending and sends only one money mutation', async () => {
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
    const panel = await openPanel(user, 'Record refund owed');
    await giveReason(user, panel);
    await user.click(within(panel).getByRole('button', { name: 'Cancel and record refund owed' }));
    await waitFor(() => expect(requestsByMethod(fetchMock, 'PUT')).toHaveLength(1));
    const sending = within(panel).getByRole('button', { name: 'Sending…' }) as HTMLButtonElement;
    expect(sending.disabled).toBe(true);

    await user.click(sending);
    // a second panel cannot open while this one is sending
    await user.click(screen.getByRole('button', { name: 'Record refund owed' }));
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
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

    await screen.findByRole('button', { name: 'Cancel order' });
    expect(screen.queryByRole('button', { name: 'Record refund owed' })).toBeNull();
    const panel = await openPanel(user, 'Cancel order');
    expect(panel.textContent).toContain('MMG payment stays between customer and store. If paid, it is refunded by Test Store; Swift cannot refund it.');
    await user.click(within(panel).getByRole('button', { name: 'Keep the order' }));
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
    const panel = await openPanel(user, 'Record refund handed back');
    expect(panel.textContent).toContain('GY$2,500');
    await user.type(within(panel).getByLabelText('Receipt or handover reference'), 'CASH-REF-001');
    await user.type(within(panel).getByLabelText('Amount actually handed back (GYD)'), '2500');
    await giveReason(user, panel, 'Cash handed back against receipt CASH-REF-001');
    await user.click(within(panel).getByRole('button', { name: 'Record refund handed back' }));

    await waitFor(() => expect(requestsByMethod(fetchMock, 'PUT')).toHaveLength(1));
    const [url, init] = requestsByMethod(fetchMock, 'PUT')[0]!;
    expect(url).toBe(`${API_ORIGIN}/api/v1/admin/orders/order-1/refund-settled`);
    // what was typed, never pre-filled from the owed figure
    expect(JSON.parse(String(init?.body))).toEqual({ reference: 'CASH-REF-001', amount: 2500 });
  });

  it('a missing reference or amount, or a closed panel, sends NO money mutation', async () => {
    for (const fill of [{ reference: '', amount: '2500' }, { reference: 'CASH-REF-002', amount: '' }, null]) {
      const fetchMock = mockApi(orderHandler(() => {
        throw new Error('no mutation expected');
      }, owedOrder));

      const { user, unmount } = renderWithQuery(<OrderDetailPage params={fulfilledParams({ id: 'order-1' })} />);
      const panel = await openPanel(user, 'Record refund handed back');
      if (fill) {
        if (fill.reference) await user.type(within(panel).getByLabelText('Receipt or handover reference'), fill.reference);
        if (fill.amount) await user.type(within(panel).getByLabelText('Amount actually handed back (GYD)'), fill.amount);
        await giveReason(user, panel, 'Cash handed back against the receipt');
        await user.click(within(panel).getByRole('button', { name: 'Record refund handed back' }));
      } else {
        await user.click(within(panel).getByRole('button', { name: 'Cancel' }));
      }
      expect(requestsByMethod(fetchMock, 'PUT')).toHaveLength(0);
      unmount();
    }
  });

  it('[U28] a queued close reads as waiting for a second admin (never a red failure) and cannot be asked twice', async () => {
    const fetchMock = mockApi(orderHandler((request) => {
      if (request.method === 'PUT' && request.url.pathname === '/api/v1/admin/orders/order-1/refund-settled') {
        return { status: 202, body: { success: false, error: { code: 'APPROVAL_REQUIRED', message: 'A second admin must approve this before it happens.', details: { approvalId: 'apr_o1' } } } };
      }
      throw new Error(`Unexpected request: ${request.method} ${request.url}`);
    }, owedOrder));
    const { user } = renderWithQuery(<OrderDetailPage params={fulfilledParams({ id: 'order-1' })} />);
    const panel = await openPanel(user, 'Record refund handed back');
    await user.type(within(panel).getByLabelText('Receipt or handover reference'), 'CASH-REF-004');
    await user.type(within(panel).getByLabelText('Amount actually handed back (GYD)'), '2500');
    await giveReason(user, panel, 'Cash handed back against receipt CASH-REF-004');
    await user.click(within(panel).getByRole('button', { name: 'Record refund handed back' }));
    expect((await screen.findByRole('status')).textContent).toContain("Sent for a second admin's approval");
    expect(screen.queryByRole('alert')).toBeNull();
    const locked = await screen.findByRole('button', { name: 'Waiting for approval' }) as HTMLButtonElement;
    expect(locked.disabled).toBe(true);
    expect(requestsByMethod(fetchMock, 'PUT')).toHaveLength(1);
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

describe('[TAXI waiting charge] a ride charged for waiting', () => {
  const ride = {
    ...order,
    orderType: 'TAXI',
    status: 'DELIVERED',
    paymentStatus: 'CAPTURED',
    vendor: null,
    taxiFareTotal: 2800,
    totalAmount: 3100,
    deliveryFee: 0,
  };

  it('shows the frozen line read-only: trip fare, waiting with its minutes, and the total they make', async () => {
    mockApi(orderHandler(() => {
      throw new Error('no mutation expected');
    }, { ...ride, fareBreakdown: { routeFare: 2800, waitingMinutes: 13, waitingCharge: 300, total: 3100, currencyCode: 'GYD' } }));

    renderWithQuery(<OrderDetailPage params={fulfilledParams({ id: 'order-1' })} />);

    const waiting = await screen.findByText('Waiting (13 min)');
    expect(waiting.nextElementSibling?.textContent).toBe('$300');
    expect(screen.getByText('Trip fare').nextElementSibling?.textContent).toBe('$2,800');
    expect(screen.getByText('Total').nextElementSibling?.textContent).toBe('$3,100');
  });

  it('a ride without a breakdown keeps today\'s money section: the route fare as its total, no waiting line', async () => {
    mockApi(orderHandler(() => {
      throw new Error('no mutation expected');
    }, { ...ride, totalAmount: 2800 }));

    renderWithQuery(<OrderDetailPage params={fulfilledParams({ id: 'order-1' })} />);

    expect((await screen.findByText('Total')).nextElementSibling?.textContent).toBe('$2,800');
    expect(screen.queryByText(/^Waiting/)).toBeNull();
    expect(screen.queryByText('Trip fare')).toBeNull();
  });
});

describe('[TAXI multi-stop 8/8] a ride with stops', () => {
  const ride = {
    ...order,
    orderType: 'TAXI',
    status: 'RIDE_IN_PROGRESS',
    vendor: null,
    pickupAddress: 'Bartica Police Station',
    deliveryAddress: 'Bartica Airstrip',
    taxiFareTotal: 2800,
    totalAmount: 2800,
    deliveryFee: 0,
  };
  const stop = (sequence: number, extra: Record<string, unknown>) => ({
    sequence, address: `Stop street ${sequence}`, status: 'PENDING', arrivedAt: null, departedAt: null, skippedAt: null, skipReason: null, evidenceNote: null, ...extra,
  });

  it('lists the stops between the pickup and the destination, in order, each with where the ride stands and the arrival evidence', async () => {
    mockApi(orderHandler(() => {
      throw new Error('no mutation expected');
    }, {
      ...ride,
      nextStopSequence: 3,
      stops: [
        stop(1, { status: 'DEPARTED', arrivedAt: '2026-10-18T20:00:00.000Z', departedAt: '2026-10-18T20:06:00.000Z', evidenceNote: 'Driver reported arriving at stop 1 — near the pin 40m away, fix 5s old' }),
        stop(2, { status: 'SKIPPED', skippedAt: '2026-10-18T20:15:00.000Z', skipReason: 'Road flooded' }),
        stop(3, { status: 'ARRIVED', arrivedAt: '2026-10-18T20:20:00.000Z' }),
      ],
    }));

    renderWithQuery(<OrderDetailPage params={fulfilledParams({ id: 'order-1' })} />);

    const first = await screen.findByTestId('ride-stop-1');
    expect(first.textContent).toContain('Stop street 1');
    expect(first.textContent).toMatch(/Arrived \d\d:\d\d · left \d\d:\d\d/);
    expect(first.textContent).toContain('Driver reported arriving at stop 1 — near the pin 40m away, fix 5s old');
    expect(screen.getByTestId('ride-stop-2').textContent).toMatch(/Skipped \d\d:\d\d — Road flooded/);
    expect(screen.getByTestId('ride-stop-3').textContent).toMatch(/Waiting here since \d\d:\d\d/);
    // The itinerary reads top to bottom: pickup, the stops, the destination.
    const text = document.body.textContent ?? '';
    const at = (s: string) => text.indexOf(s);
    expect(at('Bartica Police Station')).toBeLessThan(at('Stop street 1'));
    expect(at('Stop street 1')).toBeLessThan(at('Stop street 2'));
    expect(at('Stop street 3')).toBeLessThan(at('Bartica Airstrip'));
  });

  it('a stop not reached yet says whether it is the next one', async () => {
    mockApi(orderHandler(() => {
      throw new Error('no mutation expected');
    }, { ...ride, nextStopSequence: 1, stops: [stop(1, {}), stop(2, {})] }));
    renderWithQuery(<OrderDetailPage params={fulfilledParams({ id: 'order-1' })} />);
    expect((await screen.findByTestId('ride-stop-1')).textContent).toContain('Next stop');
    expect(screen.getByTestId('ride-stop-2').textContent).toContain('Not reached yet');
  });

  it('a ride without stops renders no stop rows', async () => {
    mockApi(orderHandler(() => {
      throw new Error('no mutation expected');
    }, ride));
    renderWithQuery(<OrderDetailPage params={fulfilledParams({ id: 'order-1' })} />);
    expect(await screen.findByText('Bartica Airstrip')).toBeTruthy();
    expect(screen.queryByTestId('ride-stop-1')).toBeNull();
  });
});
