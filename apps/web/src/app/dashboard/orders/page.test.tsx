import { screen, waitFor } from '@testing-library/react';
import type { UserEvent } from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import OrdersPage from './page';
import { mockApi, renderWithQuery, stubAudioContext, type ApiRequest } from '@/test/test-utils';
import { wireVendorOrder, wireVendorOrderDetail } from '@/test/vendor-wire-fixtures';

/**
 * S0 — the web vendor order board rendered the letters "$NaN" where a vendor's
 * own order total belongs, because the client's types named fields the API has
 * never sent (`Order.total`, `OrderItem.totalPrice`) and `money()` had no guard.
 *
 * Every test below feeds the board a response shaped like the REAL one: raw
 * Prisma rows whose `Decimal` columns are STRINGS, with no `total`, no
 * `totalPrice` and no `pickupCode`.
 */

const EM_DASH = '—';

function boardHandler(orders: unknown[], detail: unknown) {
  return (request: ApiRequest) => {
    if (request.method === 'GET' && request.url.pathname === '/api/v1/vendor/orders') {
      return { body: { success: true, data: orders, meta: { total: orders.length } } };
    }
    if (request.method === 'GET' && request.url.pathname.startsWith('/api/v1/vendor/orders/')) {
      return { body: { success: true, data: detail } };
    }
    if (request.method === 'GET' && request.url.pathname === '/api/v1/vendor/items') {
      return { body: { success: true, data: [] } };
    }
    throw new Error(`Unexpected request: ${request.method} ${request.url}`);
  };
}

function deliveryOwnerHandler(detail: Record<string, unknown>) {
  return (request: ApiRequest) => {
    if (request.method === 'GET' && request.url.pathname === '/api/v1/vendor/orders') {
      return { body: { success: true, data: [detail], meta: { total: 1 } } };
    }
    if (request.method === 'GET' && request.url.pathname === '/api/v1/vendor/orders/order-live') {
      return { body: { success: true, data: detail } };
    }
    if (request.method === 'PUT' && request.url.pathname === '/api/v1/vendor/orders/order-live/fulfillment-mode') {
      return { body: { success: true, data: { ...detail, fulfillmentMode: JSON.parse(String(request.init?.body)).mode } } };
    }
    if (request.method === 'PUT' && request.url.pathname === '/api/v1/vendor/orders/order-live/delivered') {
      return { body: { success: true, data: { ...detail, status: 'DELIVERED' } } };
    }
    if (request.method === 'GET' && request.url.pathname === '/api/v1/vendor/items') {
      return { body: { success: true, data: [] } };
    }
    throw new Error(`Unexpected request: ${request.method} ${request.url}`);
  };
}

/** The board row `<p>` is exactly `#SW-1001`; the takeover's is longer. */
async function rowFor(orderNumber: string) {
  const heading = await screen.findByText(`#${orderNumber}`);
  const row = heading.closest('button');
  if (!row) throw new Error(`No board row rendered for ${orderNumber}`);
  return row;
}

/**
 * A PENDING order in the first poll raises the full-screen new-order takeover
 * (it has its own test file). Dismiss it so the board underneath is
 * unambiguous — "View later" leaves the order in the queue.
 */
async function dismissTakeover(user: UserEvent) {
  const later = screen.queryByText(/View later/);
  if (later) await user.click(later);
  await waitFor(() => expect(screen.queryByText(/View later/)).toBeNull());
}

describe('vendor order board — money is never invented', () => {
  beforeEach(() => {
    // happy-dom has no Web Audio; the takeover mounts on the first poll.
    stubAudioContext();
  });

  it('shows a true appointment instant as the Guyana time on the provider board', async () => {
    const booking = {
      ...wireVendorOrder(), fulfillment: 'APPOINTMENT', appointmentSlot: '2026-09-24T13:00:00.000Z',
    };
    mockApi(boardHandler([booking], { ...wireVendorOrderDetail(), ...booking }));
    const { user } = renderWithQuery(<OrdersPage />);
    const row = await rowFor('SW-1001');
    await dismissTakeover(user);
    expect(row.textContent).toContain('9:00 AM');
    await user.click(row);
    expect(await screen.findAllByText(/Appointment:.*9:00 AM/)).toHaveLength(2);
    expect(screen.queryByText('20 min prep')).toBeNull();
  });

  it('renders the real order total from the wire Decimal STRING, and never "NaN"', async () => {
    mockApi(boardHandler([wireVendorOrder()], wireVendorOrderDetail()));
    const { user } = renderWithQuery(<OrdersPage />);

    const row = await rowFor('SW-1001');
    await dismissTakeover(user);

    // The list row: `totalAmount` arrived as the STRING "4500.00".
    expect(row.textContent).toContain(`$${(4500).toLocaleString()}`);

    // The detail pane: order total plus each line total (`totalCustomer`).
    await user.click(row);
    await waitFor(() => expect(screen.getByText('Total (Cash)')).toBeTruthy());
    expect(screen.getByText(`$${(4500).toLocaleString()}`)).toBeTruthy();
    expect(screen.getByText(`$${(3000).toLocaleString()}`)).toBeTruthy();
    expect(screen.getByText(`$${(1000).toLocaleString()}`)).toBeTruthy();

    // The headline guarantee: the letters N-a-N reach no part of this page.
    expect(document.body.textContent ?? '').not.toMatch(/NaN/);
  });

  it('renders an em-dash — never "$0" — when the server sends no total', async () => {
    // A response that cannot say what is owed: `totalAmount` absent entirely.
    const noTotal = wireVendorOrder() as Record<string, unknown>;
    delete noTotal['totalAmount'];
    mockApi(boardHandler([noTotal], { ...wireVendorOrderDetail(), totalAmount: undefined }));
    const { user } = renderWithQuery(<OrdersPage />);

    const row = await rowFor('SW-1001');
    await dismissTakeover(user);

    expect(row.textContent).toContain(EM_DASH);
    // A real zero and an invented zero look identical and mean opposite things.
    expect(row.textContent).not.toContain('$0');
    expect(row.textContent ?? '').not.toMatch(/NaN/);
  });

  it('never leaks the pickup code, and still tells the store a code is collected', async () => {
    const pickupBoard = wireVendorOrder({ fulfillment: 'PICKUP', status: 'READY_FOR_PICKUP' });
    const pickupDetail = wireVendorOrderDetail({ fulfillment: 'PICKUP', status: 'READY_FOR_PICKUP' });
    mockApi(boardHandler([pickupBoard], pickupDetail));
    const { user } = renderWithQuery(<OrdersPage />);

    await user.click(await screen.findByRole('button', { name: /Ready \/ handoff/ }));
    await user.click(await rowFor('SW-1001'));

    // HND-003: the hint is driven by `fulfillment`, a field the API DOES send.
    // It used to be gated on `pickupCode`, which both vendor routes strip — so
    // the condition was permanently false and the hint never rendered at all.
    await waitFor(() => expect(screen.getByText(/Customer collects with a pickup code/)).toBeTruthy());

    // And the code itself is still nowhere on the page: staff TYPE it in.
    const codeInput = screen.getByPlaceholderText('Pickup code') as HTMLInputElement;
    expect(codeInput.value).toBe('');
    expect(document.body.textContent ?? '').not.toMatch(/\b\d{6}\b/);
  });

  it('shows the customer notes the API actually sends', async () => {
    mockApi(boardHandler([wireVendorOrder()], wireVendorOrderDetail()));
    const { user } = renderWithQuery(<OrdersPage />);

    const row = await rowFor('SW-1001');
    await dismissTakeover(user);
    await user.click(row);

    // `OrderItem.specialInstructions` — the client used to read `notes`, which
    // is not a column, so a customer's line note silently never reached staff.
    await waitFor(() => expect(screen.getByText(/No pepper please/)).toBeTruthy());
    // `Order.deliveryInstructions` — same defect at order level (`notes`).
    expect(screen.getByText(/Ring the bell twice/)).toBeTruthy();
  });

  it('renders an empty bucket without inventing a figure', async () => {
    mockApi(boardHandler([], wireVendorOrderDetail()));
    renderWithQuery(<OrdersPage />);
    await screen.findByText(/Nothing in/);
    expect(document.body.textContent ?? '').not.toMatch(/NaN/);
  });
});

describe('delivery owner controls', () => {
  beforeEach(() => { stubAudioContext(); });

  async function openDeliveryOwner(over: Record<string, unknown>) {
    const detail = wireVendorOrderDetail({
      status: 'READY_FOR_PICKUP',
      fulfillment: 'DELIVERY',
      vendor: { vendorType: 'RESTAURANT', selfDeliveryEnabled: true },
      ...over,
    });
    const fetchMock = mockApi(deliveryOwnerHandler(detail));
    const { user } = renderWithQuery(<OrdersPage />);
    const bucket = detail.status === 'PENDING' ? /New/ : /Ready \/ handoff/;
    await user.click(await screen.findByRole('button', { name: bucket }));
    await user.click(await rowFor('SW-1001'));
    await screen.findByRole('region', { name: 'Delivery owner' });
    return { user, fetchMock };
  }

  it('offers the alternative owner for an eligible riderless delivery and sends the typed choice', async () => {
    const { user, fetchMock } = await openDeliveryOwner({ fulfillmentMode: 'PLATFORM_RIDER' });
    expect(screen.getByText('Platform rider delivery selected')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'We’ll deliver' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Get a Swift rider' })).toBeNull();

    await user.click(screen.getByRole('button', { name: 'We’ll deliver' }));
    await waitFor(() => {
      const call = fetchMock.mock.calls.find(([url]) => String(url).includes('/fulfillment-mode'));
      expect(call).toBeTruthy();
      expect(JSON.parse(String(call![1]?.body))).toEqual({ mode: 'VENDOR_DELIVERY' });
    });
  });

  it('names vendor self-delivery and never offers a rider retry for it', async () => {
    await openDeliveryOwner({ fulfillmentMode: 'VENDOR_DELIVERY' });
    expect(screen.getByText('Your store delivers this order')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Search for a rider again/i })).toBeNull();
    expect(screen.getByRole('button', { name: 'Get a Swift rider' })).toBeTruthy();
  });

  it('requires an explicit handoff confirmation before closing a self-delivery', async () => {
    const { user, fetchMock } = await openDeliveryOwner({ fulfillmentMode: 'VENDOR_DELIVERY' });

    await user.click(screen.getByRole('button', { name: 'Confirm delivered' }));
    expect(screen.getByRole('dialog', { name: 'Confirm store delivery' })).toBeTruthy();
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith('/delivered'))).toBe(false);

    await user.click(screen.getByRole('button', { name: 'Yes, delivered' }));
    await waitFor(() => {
      expect(fetchMock.mock.calls.some(([url, init]) =>
        String(url).endsWith('/api/v1/vendor/orders/order-live/delivered')
        && init?.method === 'PUT')).toBe(true);
    });
  });

  it('keeps the platform-rider escape when the store-wide self-delivery setting is off', async () => {
    await openDeliveryOwner({
      fulfillmentMode: 'VENDOR_DELIVERY',
      vendor: { vendorType: 'RESTAURANT', selfDeliveryEnabled: false },
    });
    expect(screen.getByText('Your store delivers this order')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Get a Swift rider' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'We’ll deliver' })).toBeNull();
  });

  it('does not claim dispatch is searching when the delivery owner is unresolved', async () => {
    await openDeliveryOwner({ fulfillmentMode: null, status: 'PENDING' });
    expect(screen.getByText('Delivery owner not chosen yet')).toBeTruthy();
    expect(screen.getByText('No delivery owner has been recorded yet.')).toBeTruthy();
    expect(screen.queryByText(/finding a rider/i)).toBeNull();
  });

  it('treats riderId as assignment even when the rider profile has no display name', async () => {
    await openDeliveryOwner({
      riderId: 'rider-without-name',
      rider: { user: { firstName: null, lastName: null, phone: null } },
      fulfillmentMode: 'PLATFORM_RIDER',
    });
    expect(screen.getByText('A Swift rider delivers this order')).toBeTruthy();
    expect(screen.getByText('Swift rider')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'We’ll deliver' })).toBeNull();
  });

  it('preserves pickup semantics: a pickup has no delivery-owner controls', async () => {
    const detail = wireVendorOrderDetail({ fulfillment: 'PICKUP', status: 'READY_FOR_PICKUP' });
    mockApi(deliveryOwnerHandler(detail));
    const { user } = renderWithQuery(<OrdersPage />);
    await user.click(await screen.findByRole('button', { name: /Ready \/ handoff/ }));
    await user.click(await rowFor('SW-1001'));
    expect(screen.queryByRole('region', { name: 'Delivery owner' })).toBeNull();
    expect(screen.getByText(/Customer collects with a pickup code/)).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// [W-25] "MMG payment received" is the store's WORD, not a reconciled capture.
// The old predicate was "not captured and not cancelled", so a FAILED, a
// REFUNDED and an unresolved payment each offered a one-tap "received" — a tap
// on a reversed payment recaptured a refund. The server refuses those states
// by name; the board must not offer the tap in the first place, and when it
// does offer it, it collects the provider reference that proves the payment.
// ---------------------------------------------------------------------------

describe('[W-25] the store attests only where money plausibly landed', () => {
  beforeEach(() => { stubAudioContext(); });

  async function openMmgDetail(paymentStatus: string) {
    const over = { paymentMethod: 'MOBILE_MONEY', paymentStatus };
    const fetchMock = mockApi(boardHandler([wireVendorOrder(over)], wireVendorOrderDetail(over)));
    const { user } = renderWithQuery(<OrdersPage />);
    const row = await rowFor('SW-1001');
    await dismissTakeover(user);
    await user.click(row);
    await waitFor(() => expect(screen.getByText('Total (MMG)')).toBeTruthy());
    return { user, fetchMock };
  }

  it.each(['REFUNDED', 'FAILED', 'UNKNOWN', 'EXPIRED', 'PARTIALLY_REFUNDED'])(
    'offers no attest button on a %s payment, and says why',
    async (paymentStatus) => {
      const { fetchMock } = await openMmgDetail(paymentStatus);
      expect(screen.queryByRole('button', { name: /received in my MMG/i })).toBeNull();
      // and the screen is not silent about it
      expect(screen.getByText(/refunded|failed|unresolved|window closed/i)).toBeTruthy();
      expect(fetchMock.mock.calls.filter(([u]) => String(u).includes('confirm-payment'))).toHaveLength(0);
    },
  );

  it('offers it on a PENDING payment, names the amount, and will not send without a reference', async () => {
    const { user, fetchMock } = await openMmgDetail('PENDING');
    const button = await screen.findByRole('button', { name: /received in my MMG/i });
    expect((button as HTMLButtonElement).disabled).toBe(true); // no reference yet
    await user.click(button);
    expect(fetchMock.mock.calls.filter(([u]) => String(u).includes('confirm-payment'))).toHaveLength(0);

    await user.type(screen.getByLabelText(/MMG transaction reference/i), 'MMG12345');
    expect((button as HTMLButtonElement).disabled).toBe(false);
    await user.click(button);
    await waitFor(() => {
      const call = fetchMock.mock.calls.find(([u]) => String(u).includes('confirm-payment'));
      expect(call).toBeTruthy();
      expect(JSON.parse(String(call![1]?.body)).reference).toBe('MMG12345');
    });
  });
});


// ---------------------------------------------------------------------------
// [W-27] "REFUND" SAID MONEY CAME BACK. NONE EVER LEFT.
//
// An out-of-stock line with no substitute was removed with a button reading
// "No substitute — refund line", and the line then showed "Refunded". On a cash
// order nothing has been paid yet: the line comes off and the bill at the door
// is smaller. And an MMG order cannot do this at all — the server refuses with
// MMG_ADJUSTMENT_UNAVAILABLE, because that money went straight to the store and
// Swift never held it. So there is no tender here on which a refund is owed,
// and the words now say what actually happens.
// ---------------------------------------------------------------------------
describe('[W-27] removing a line is not a refund', () => {
  beforeEach(() => { stubAudioContext(); });

  const shelf = (over: Record<string, unknown> = {}) => ({
    vendor: { vendorType: 'SUPERMARKET', selfDeliveryEnabled: false },
    status: 'PREPARING',
    ...over,
  });

  async function openDetail(over: Record<string, unknown>) {
    const o = shelf(over);
    mockApi(boardHandler([wireVendorOrder(o)], wireVendorOrderDetail(o)));
    const { user } = renderWithQuery(<OrdersPage />);
    // A PREPARING order lives in the "In progress" lane; the board opens on New.
    await user.click(await screen.findByRole('button', { name: /In progress/ }));
    const row = await rowFor('SW-1001');
    await dismissTakeover(user);
    await user.click(row);
    return { user };
  }

  it('the action says it REMOVES the line — it never offers to refund one', async () => {
    const { user } = await openDetail({ paymentMethod: 'CASH' });
    // The line controls open behind "Out of stock?".
    await user.click((await screen.findAllByRole('button', { name: 'Out of stock?' }))[0]!);
    expect(await screen.findByRole('button', { name: /No substitute — remove line/ })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /refund line/ })).toBeNull();
  });

  it('a removed line reads "Removed — not charged", never "Refunded"', async () => {
    const items = [
      { id: 'line-1', itemId: 'item-1', name: 'Rice', quantity: 2, totalCustomer: '2000.00', specialInstructions: null, picked: false, subStatus: 'REFUNDED' },
    ];
    await openDetail({ paymentMethod: 'CASH', items });
    expect(await screen.findByText('Removed — not charged')).toBeTruthy();
    expect(screen.queryByText('Refunded')).toBeNull();
  });

  it('an MMG order cannot change its totals here, and the store is told instead of clicking into a 409', async () => {
    const { user } = await openDetail({ paymentMethod: 'MOBILE_MONEY' });
    await user.click((await screen.findAllByRole('button', { name: 'Out of stock?' }))[0]!);
    const remove = await screen.findByRole('button', { name: /No substitute — remove line/ });
    expect((remove as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getAllByText(/settle item changes with the customer directly/).length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// [E10] The API now requires a non-empty reason on PUT /vendor/orders/:id/reject.
// The board used to fire rejectOrder(id) straight off the Reject button, so the
// server recorded the generic "Rejected by vendor". Now the button opens a
// reason panel (parity with mobile's presets) and nothing is sent until the
// store picks one.
// ---------------------------------------------------------------------------
describe('[E10] rejecting an order always carries a reason', () => {
  beforeEach(() => { stubAudioContext(); });

  const rejectHandler = (detail: Record<string, unknown>) => (request: ApiRequest) => {
    if (request.method === 'GET' && request.url.pathname === '/api/v1/vendor/orders') {
      return { body: { success: true, data: [detail], meta: { total: 1 } } };
    }
    if (request.method === 'GET' && request.url.pathname === '/api/v1/vendor/orders/order-live') {
      return { body: { success: true, data: detail } };
    }
    if (request.method === 'PUT' && request.url.pathname === '/api/v1/vendor/orders/order-live/reject') {
      return { body: { success: true, data: { ...detail, status: 'CANCELLED' } } };
    }
    if (request.method === 'GET' && request.url.pathname === '/api/v1/vendor/items') {
      return { body: { success: true, data: [] } };
    }
    throw new Error(`Unexpected request: ${request.method} ${request.url}`);
  };

  async function openPendingDetail() {
    const detail = wireVendorOrderDetail();
    const fetchMock = mockApi(rejectHandler(detail));
    const { user } = renderWithQuery(<OrdersPage />);
    const row = await rowFor('SW-1001');
    await dismissTakeover(user);
    await user.click(row);
    await waitFor(() => expect(screen.getByText('Total (Cash)')).toBeTruthy());
    return { user, fetchMock };
  }

  it('the Reject button opens a reason panel and sends nothing until a preset is chosen', async () => {
    const { user, fetchMock } = await openPendingDetail();

    await user.click(screen.getByRole('button', { name: 'Reject' }));
    expect(screen.getByRole('dialog', { name: 'Confirm order rejection' })).toBeTruthy();
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith('/reject'))).toBe(false);

    await user.click(screen.getByRole('button', { name: 'Out of stock' }));
    await waitFor(() => {
      const call = fetchMock.mock.calls.find(([url]) => String(url).endsWith('/orders/order-live/reject'));
      expect(call).toBeTruthy();
      expect(JSON.parse(String(call![1]?.body))).toEqual({ reason: 'Out of stock' });
    });
  });

  it('"Keep it" closes the panel without rejecting', async () => {
    const { user, fetchMock } = await openPendingDetail();

    await user.click(screen.getByRole('button', { name: 'Reject' }));
    await user.click(screen.getByRole('button', { name: 'Keep it' }));

    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Confirm order rejection' })).toBeNull());
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith('/reject'))).toBe(false);
  });
});
