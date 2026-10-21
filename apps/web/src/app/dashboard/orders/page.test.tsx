import { act, screen, waitFor, within } from '@testing-library/react';
import type { UserEvent } from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import OrdersPage from './page';
import { mockApi, renderWithQuery, stubAudioContext, type ApiRequest } from '@/test/test-utils';
import { wireVendorOrder, wireVendorOrderDetail, wireOrderLine } from '@/test/vendor-wire-fixtures';

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
    expect(row.textContent).not.toContain('GY$');

    // The detail pane: order total plus each line total (`totalCustomer`).
    await user.click(row);
    await waitFor(() => expect(screen.getByText('Cash on handover — you keep 100% of the goods total.')).toBeTruthy());
    expect(within(screen.getByRole('dialog', { name: 'Order details' })).getByText(`$${(4500).toLocaleString()}`)).toBeTruthy();
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

  it('keeps a long status on one line in the order window; the title side gives way instead', async () => {
    // At 390 px "READY FOR PICKUP" wrapped onto three lines and became a round blob.
    mockApi(boardHandler([wireVendorOrder({ status: 'READY_FOR_PICKUP' })], wireVendorOrderDetail({ status: 'READY_FOR_PICKUP' })));
    const { user } = renderWithQuery(<OrdersPage />);
    const row = await rowFor('SW-1001');
    // The board card's chip stays on one line too.
    expect(within(row).getByText('Ready').className.split(' ')).toEqual(expect.arrayContaining(['whitespace-nowrap']));
    await user.click(row);
    const dialog = await screen.findByRole('dialog', { name: 'Order details' });
    const chip = await within(dialog).findByText('Ready');
    expect(chip.className.split(' ')).toEqual(expect.arrayContaining(['whitespace-nowrap']));
    // The chip and the close button never shrink; the order number and customer line do.
    const actions = chip.parentElement!;
    expect(actions.className.split(' ')).toEqual(expect.arrayContaining(['shrink-0']));
    const title = actions.previousElementSibling as HTMLElement;
    expect(title.textContent).toContain('#SW-1001');
    expect(title.className.split(' ')).toEqual(expect.arrayContaining(['min-w-0', 'flex-1']));
  });

  it('never leaks the pickup code, and still tells the store a code is collected', async () => {
    const pickupBoard = wireVendorOrder({ fulfillment: 'PICKUP', status: 'READY_FOR_PICKUP' });
    const pickupDetail = wireVendorOrderDetail({ fulfillment: 'PICKUP', status: 'READY_FOR_PICKUP' });
    mockApi(boardHandler([pickupBoard], pickupDetail));
    const { user } = renderWithQuery(<OrdersPage />);

    await screen.findByRole('region', { name: 'Ready / handoff orders' });
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
    expect(await screen.findAllByText('Nothing here right now')).toHaveLength(3);
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
    await screen.findByRole('region', { name: detail.status === 'PENDING' ? 'New orders' : 'Ready / handoff orders' });
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
    expect(screen.queryByRole('button', { name: /Search for a rider again|Find a rider/i })).toBeNull();
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
    await screen.findByRole('region', { name: 'Ready / handoff orders' });
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
    await waitFor(() => expect(screen.getByText('MMG — the customer pays your store’s MMG account.')).toBeTruthy());
    return { user, fetchMock };
  }

  it.each(['REFUNDED', 'FAILED', 'UNKNOWN', 'EXPIRED', 'PARTIALLY_REFUNDED'])(
    'offers no attest button on a %s payment, and says why',
    async (paymentStatus) => {
      const { fetchMock } = await openMmgDetail(paymentStatus);
      expect(screen.queryByRole('button', { name: /^Paid by MMG$/i })).toBeNull();
      // and the screen is not silent about it
      expect(screen.getByText(/refunded|failed|unresolved|window closed/i)).toBeTruthy();
      expect(fetchMock.mock.calls.filter(([u]) => String(u).includes('confirm-payment'))).toHaveLength(0);
    },
  );

  it('[row 52] staff at the order\'s store get no attest button, only who can confirm', async () => {
    const over = { paymentMethod: 'MOBILE_MONEY', paymentStatus: 'PENDING', canConfirmPayment: false };
    const fetchMock = mockApi(boardHandler([wireVendorOrder(over)], wireVendorOrderDetail(over)));
    const { user } = renderWithQuery(<OrdersPage />);
    const row = await rowFor('SW-1001');
    await dismissTakeover(user);
    await user.click(row);
    await waitFor(() => expect(screen.getByText('MMG — the customer pays your store’s MMG account.')).toBeTruthy());
    expect(screen.queryByRole('button', { name: /^Paid by MMG$/i })).toBeNull();
    expect(screen.queryByLabelText(/MMG transaction reference/i)).toBeNull();
    expect(screen.getByText('Only the owner or a manager can confirm MMG payments.')).toBeTruthy();
    expect(fetchMock.mock.calls.filter(([u]) => String(u).includes('confirm-payment'))).toHaveLength(0);
  });

  // [owner 18 Oct 2026] An accepted MMG order not marked "Paid by MMG" within 30 minutes cancels: the store sees when.
  it("shows the server's cancel-at line beside the Paid by MMG button", async () => {
    const line = 'Cancels automatically at 3:45 PM unless you mark it "Paid by MMG".';
    const over = { paymentMethod: 'MOBILE_MONEY', paymentStatus: 'PENDING', mmgPayBy: '2026-10-18T19:45:00.000Z', mmgPayByLine: line };
    mockApi(boardHandler([wireVendorOrder(over)], wireVendorOrderDetail(over)));
    const { user } = renderWithQuery(<OrdersPage />);
    const row = await rowFor('SW-1001');
    await dismissTakeover(user);
    await user.click(row);
    await screen.findByRole('button', { name: /^Paid by MMG$/i });
    expect(screen.getByText(line)).toBeTruthy();
  });

  it('offers it on a PENDING payment, names the amount, and will not send without a reference', async () => {
    const { user, fetchMock } = await openMmgDetail('PENDING');
    const button = await screen.findByRole('button', { name: /^Paid by MMG$/i });
    // [PAYMENT-SIMPLIFY] The button says only "Paid by MMG"; the amount is named beside it.
    expect(screen.getByText(/^Tap when .*\d.* is in your MMG account\.$/)).toBeTruthy();
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
    // Preparing is now visible beside New and Ready; no filter click is needed.
    await screen.findByRole('region', { name: 'Preparing orders' });
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
    await waitFor(() => expect(screen.getByText('Cash on handover — you keep 100% of the goods total.')).toBeTruthy());
    return { user, fetchMock };
  }

  it('the Reject button opens a reason panel and sends nothing until a preset is chosen', async () => {
    const { user, fetchMock } = await openPendingDetail();

    // The order's own Reject, inside its detail dialog (the takeover has one too).
    await user.click(within(screen.getByRole('dialog', { name: 'Order details' })).getByRole('button', { name: 'Reject' }));
    expect(screen.getByRole('dialog', { name: 'Confirm order rejection' })).toBeTruthy();
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith('/reject'))).toBe(false);

    await user.click(screen.getByRole('button', { name: 'Out of stock' }));
    await waitFor(() => {
      const call = fetchMock.mock.calls.find(([url]) => String(url).endsWith('/orders/order-live/reject'));
      expect(call).toBeTruthy();
      expect(JSON.parse(String(call![1]?.body))).toEqual({ reason: 'Out of stock' });
    });
  });

  it('a booking is declined with its own question, label and booking reasons (DS221 S3)', async () => {
    const detail = wireVendorOrderDetail({ fulfillment: 'APPOINTMENT', appointmentSlot: '2026-09-24T13:00:00.000Z' });
    const fetchMock = mockApi(rejectHandler(detail));
    const { user } = renderWithQuery(<OrdersPage />);
    const row = await rowFor('SW-1001');
    await dismissTakeover(user);
    await user.click(row);
    await user.click(await within(await screen.findByRole('dialog', { name: 'Order details' })).findByRole('button', { name: 'Decline' }));

    expect(screen.getByRole('dialog', { name: 'Confirm booking decline' })).toBeTruthy();
    expect(screen.getByText('Decline this booking?')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Kitchen is too busy' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Fully booked at that time' }));
    await waitFor(() => {
      const call = fetchMock.mock.calls.find(([url]) => String(url).endsWith('/orders/order-live/reject'));
      expect(call).toBeTruthy();
      expect(JSON.parse(String(call![1]?.body))).toEqual({ reason: 'Fully booked at that time' });
    });
  });

  it('"Keep it" closes the panel without rejecting', async () => {
    const { user, fetchMock } = await openPendingDetail();

    // The order's own Reject, inside its detail dialog (the takeover has one too).
    await user.click(within(screen.getByRole('dialog', { name: 'Order details' })).getByRole('button', { name: 'Reject' }));
    await user.click(screen.getByRole('button', { name: 'Keep it' }));

    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Confirm order rejection' })).toBeNull());
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith('/reject'))).toBe(false);
  });
});

describe('order detail stays dismissible while its request settles', () => {
  beforeEach(() => { stubAudioContext(); });

  it('can close a pending detail request on a phone', async () => {
    const order = wireVendorOrder({ status: 'ACCEPTED' });
    mockApi((request) => {
      if (request.url.pathname === '/api/v1/vendor/orders') return { body: { success: true, data: [order] } };
      if (request.url.pathname.endsWith('/order-live')) return new Promise(() => {});
      throw new Error(`Unexpected request: ${request.url}`);
    });
    const { user } = renderWithQuery(<OrdersPage />);
    await screen.findByRole('region', { name: 'Preparing orders' });
    await user.click(await rowFor('SW-1001'));
    await screen.findByText('Loading…');
    await user.click(screen.getByRole('button', { name: 'Close order detail' }));
    expect(screen.queryByRole('button', { name: 'Close order detail' })).toBeNull();
  });

  it('shows a failed detail request and retries it', async () => {
    const order = wireVendorOrder({ status: 'ACCEPTED' });
    let attempts = 0;
    mockApi((request) => {
      if (request.url.pathname === '/api/v1/vendor/orders') return { body: { success: true, data: [order] } };
      if (request.url.pathname.endsWith('/order-live')) {
        attempts++;
        return attempts === 1
          ? { status: 503, body: { success: false, error: { message: 'Unavailable' } } }
          : { body: { success: true, data: wireVendorOrderDetail({ status: 'ACCEPTED' }) } };
      }
      throw new Error(`Unexpected request: ${request.url}`);
    });
    const { user } = renderWithQuery(<OrdersPage />);
    await screen.findByRole('region', { name: 'Preparing orders' });
    await user.click(await rowFor('SW-1001'));
    await screen.findByText(/Could not load this order/);
    await user.click(screen.getByRole('button', { name: 'Retry order detail' }));
    await screen.findByText('Cash on handover — you keep 100% of the goods total.');
    expect(attempts).toBe(2);
  });
});

// The API substitution vocabulary comes from the persisted line, not the order state.
describe('store picking uses the server substitution status', () => {
  beforeEach(() => { stubAudioContext(); });

  async function openLine(subStatus: string, picked = false) {
    const detail = wireVendorOrderDetail({
      vendor: { vendorType: 'SUPERMARKET', selfDeliveryEnabled: false },
      status: 'PREPARING',
      items: [wireOrderLine({ subStatus, picked, substituteName: 'Replacement rice' })],
    });
    mockApi(boardHandler([detail], detail));
    const { user, queryClient } = renderWithQuery(<OrdersPage />);
    await user.click(await rowFor('SW-1001'));
    await screen.findByText('Cash on handover — you keep 100% of the goods total.');
    return { user, queryClient, detail };
  }

  it('shows a PENDING swap and disables picking or proposing another swap', async () => {
    await openLine('PENDING');
    expect(screen.getByText('Waiting on customer: Replacement rice')).toBeTruthy();
    expect((screen.getByRole('checkbox') as HTMLInputElement).disabled).toBe(true);
    expect(screen.queryByRole('button', { name: 'Out of stock?' })).toBeNull();
  });

  it('a pending proposal on another device closes an already-open substitute panel', async () => {
    const { user, queryClient, detail } = await openLine('NONE');
    await user.click(screen.getByRole('button', { name: 'Out of stock?' }));
    expect(screen.getByRole('button', { name: 'No substitute — remove line' })).toBeTruthy();
    const pending = { ...detail, items: [wireOrderLine({ subStatus: 'PENDING', substituteName: 'Replacement rice' })] };
    mockApi(boardHandler([pending], pending));
    await queryClient.invalidateQueries({ predicate: (query) => query.queryKey.includes('order') });
    await screen.findByText('Waiting on customer: Replacement rice');
    expect(screen.queryByRole('button', { name: 'No substitute — remove line' })).toBeNull();
  });

  it('an APPROVED swap is picked and no longer waits on the customer', async () => {
    await openLine('APPROVED', true);
    expect(screen.queryByText(/Waiting on customer/)).toBeNull();
    expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(true);
    expect(screen.getByText('All picked ✓')).toBeTruthy();
  });

  it.each(['REFUNDED', 'REJECTED'])('%s lines cannot be picked or proposed again', async (status) => {
    await openLine(status);
    expect((screen.getByRole('checkbox') as HTMLInputElement).disabled).toBe(true);
    expect(screen.queryByRole('button', { name: 'Out of stock?' })).toBeNull();
    expect(screen.getByText('Nothing left to hand over — cancel this order')).toBeTruthy();
  });
});


describe('pending and approved line removal remains available', () => {
  beforeEach(() => { stubAudioContext(); });

  it.each(['PENDING', 'APPROVED'])('%s allows removal but never offers a second proposal', async (subStatus) => {
    const detail = wireVendorOrderDetail({
      vendor: { vendorType: 'SUPERMARKET', selfDeliveryEnabled: false }, status: 'PREPARING',
      items: [wireOrderLine({ subStatus, picked: false, substituteName: 'Replacement rice' })],
    });
    const handler = boardHandler([detail], detail);
    const fetchMock = mockApi((request) => {
      if (request.method === 'POST' && request.url.pathname.endsWith('/refund-line')) {
        return { body: { success: true, data: {} } };
      }
      return handler(request);
    });
    const { user } = renderWithQuery(<OrdersPage />);
    await user.click(await rowFor('SW-1001'));
    await screen.findByText('Cash on handover — you keep 100% of the goods total.');
    expect(screen.queryByRole('button', { name: 'Out of stock?' })).toBeNull();
    if (subStatus === 'PENDING') {
      expect(screen.getByText('Shelf picking — 1 waiting on customer')).toBeTruthy();
      expect((screen.getByRole('checkbox') as HTMLInputElement).disabled).toBe(true);
    } else {
      expect((screen.getByRole('checkbox') as HTMLInputElement).disabled).toBe(false);
    }
    await user.click(screen.getByRole('button', { name: 'Remove unavailable line' }));
    await waitFor(() => expect(fetchMock.mock.calls.some(([url, init]) =>
      String(url).includes('/refund-line') && init?.method === 'POST')).toBe(true));
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/substitute'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Independent review of #1601 (11 Oct), S2-1: React Query keeps the last good
// data when a refresh fails but flags the error, and the board polls every 10 s.
// One failed poll used to take every card off the screen until the next good
// one. Main kept the known orders visible under the "Couldn't load" banner;
// the kitchen still needs its ticket rail during a mobile-data blip.
// ---------------------------------------------------------------------------
describe('a failed refresh does not empty the board', () => {
  beforeEach(() => { stubAudioContext(); });

  it('keeps the loaded orders on the board, under the error, after one failed poll', async () => {
    let fail = false;
    const order = wireVendorOrder({ status: 'PREPARING' });
    mockApi((request) => {
      if (request.method === 'GET' && request.url.pathname === '/api/v1/vendor/orders') {
        return fail ? { status: 503, body: { success: false, error: { message: 'Service unavailable' } } } : { body: { success: true, data: [order], meta: { total: 1 } } };
      }
      return { status: 404, body: { success: false } };
    });
    const { queryClient } = renderWithQuery(<OrdersPage />);
    await rowFor('SW-1001');
    fail = true;
    await act(async () => { await queryClient.refetchQueries({ predicate: (q) => JSON.stringify(q.queryKey).includes('"orders"') }); });
    expect(await screen.findByText(/Couldn.t load your orders/)).toBeTruthy();
    // The card is still there, and still in its lane.
    expect(within(screen.getByRole('region', { name: 'Preparing orders' })).getByText('#SW-1001')).toBeTruthy();
    // An outage is never drawn as an empty lane.
    expect(screen.queryByText('Nothing here right now')).toBeNull();
  });
});

// Review S3-1: the order window is a modal dialog, so Tab stays inside it, and
// closing it returns focus to the order's card even after the order moved lanes.
describe('the order window keeps focus inside, and returns it to the card', () => {
  beforeEach(() => { stubAudioContext(); });

  it('cycles Tab and Shift+Tab inside the dialog', async () => {
    mockApi(boardHandler([wireVendorOrder({ status: 'PREPARING' })], wireVendorOrderDetail({ status: 'PREPARING' })));
    const { user } = renderWithQuery(<OrdersPage />);
    await user.click(await rowFor('SW-1001'));
    const dialog = await screen.findByRole('dialog', { name: 'Order details' });
    await within(dialog).findByRole('button', { name: 'Mark ready' });
    const close = within(dialog).getByRole('button', { name: 'Close order detail' });
    await waitFor(() => expect(document.activeElement).toBe(close));
    await user.tab({ shift: true });
    expect(dialog.contains(document.activeElement)).toBe(true);
    expect(document.activeElement).not.toBe(close);
    const last = document.activeElement;
    await user.tab();
    expect(document.activeElement).toBe(close);
    await user.tab({ shift: true });
    expect(document.activeElement).toBe(last);
  });

  it('returns focus to the order\'s card after an action moved it to another lane', async () => {
    let status = 'PREPARING';
    mockApi((request) => {
      const { method, url } = request;
      if (method === 'GET' && url.pathname === '/api/v1/vendor/orders') return { body: { success: true, data: [wireVendorOrder({ status })], meta: { total: 1 } } };
      if (method === 'GET' && url.pathname.startsWith('/api/v1/vendor/orders/')) return { body: { success: true, data: wireVendorOrderDetail({ status }) } };
      if (method === 'PUT' && url.pathname.endsWith('/ready')) { status = 'READY_FOR_PICKUP'; return { body: { success: true } }; }
      if (method === 'GET' && url.pathname === '/api/v1/vendor/items') return { body: { success: true, data: [] } };
      return { status: 404, body: { success: false } };
    });
    const { user } = renderWithQuery(<OrdersPage />);
    await user.click(await rowFor('SW-1001'));
    const dialog = await screen.findByRole('dialog', { name: 'Order details' });
    await user.click(await within(dialog).findByRole('button', { name: 'Mark ready' }));
    const ready = await screen.findByRole('region', { name: 'Ready / handoff orders' });
    await waitFor(() => expect(within(ready).getAllByText('#SW-1001').length).toBe(1));
    await user.click(within(dialog).getByRole('button', { name: 'Close order detail' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Order details' })).toBeNull());
    const card = within(ready).getByText('#SW-1001').closest('button');
    expect(document.activeElement).toBe(card);
  });
});

// Review S3-5: the third lane also holds orders a rider has claimed that may
// still be cooking, so it carries main's truthful name, not a bare "Ready".
describe('the third lane says what it holds', () => {
  beforeEach(() => { stubAudioContext(); });
  it('is called "Ready / handoff" and holds rider-claimed orders', async () => {
    mockApi(boardHandler([wireVendorOrder({ status: 'RIDER_ASSIGNED' })], wireVendorOrderDetail({ status: 'RIDER_ASSIGNED' })));
    renderWithQuery(<OrdersPage />);
    const lane = await screen.findByRole('region', { name: 'Ready / handoff orders' });
    expect(within(lane).getByRole('heading', { name: 'Ready / handoff' })).toBeTruthy();
    expect(await within(lane).findByText('#SW-1001')).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Ready' })).toBeNull();
  });
});

// [Item 10 · S1-6] A direct-MMG order the customer and the store disagree
// about is paused until Swift support resolves it: the server refuses every
// forward step (409 MMG_CLAIM_MISMATCH). The web board says so, as the phone
// does, and offers no forward button that can only fail.
describe('disputed MMG orders pause the web dashboard', () => {
  beforeEach(() => { stubAudioContext(); });
  it.each([
    ['PENDING', 'DELIVERY', 'PLATFORM_RIDER'],
    ['ACCEPTED', 'DELIVERY', 'PLATFORM_RIDER'],
    ['PREPARING', 'DELIVERY', 'PLATFORM_RIDER'],
    ['READY_FOR_PICKUP', 'PICKUP', 'PICKUP'],
    ['READY_FOR_PICKUP', 'DELIVERY', 'VENDOR_DELIVERY'],
    ['READY_FOR_PICKUP', 'DELIVERY', 'PLATFORM_RIDER'],
  ])('%s %s %s shows the pause and withholds forward work', async (status, fulfillment, fulfillmentMode) => {
    const over = {
      status, fulfillment, fulfillmentMode,
      paymentMethod: 'MOBILE_MONEY', paymentStatus: 'PENDING', canConfirmPayment: true,
      mmgClaimMismatchAt: '2026-10-07T12:00:00.000Z',
      vendor: { vendorType: 'SUPERMARKET', selfDeliveryEnabled: true },
    };
    mockApi(boardHandler([wireVendorOrder(over)], wireVendorOrderDetail(over)));
    const { user } = renderWithQuery(<OrdersPage />);
    // A disputed new order raises no takeover asking to accept it.
    expect(screen.queryByText(/View later/)).toBeNull();
    const row = await rowFor('SW-1001');
    expect(row.textContent).toContain('Payment under review — order paused');
    await user.click(row);
    await screen.findByText('MMG — the customer pays your store’s MMG account.');
    // The phone's own words (order-dispute.ts). A dispute can be a reference
    // mismatch where the customer says they DID pay, so the notice never says
    // the customer is disputing the payment (review S4-1).
    expect(screen.getByText("The store's and the customer's MMG payment reports don't match. Swift support is checking it and will tell you when the order can move. Don’t hand anything over until then.")).toBeTruthy();
    expect(screen.queryByText(/customer disputes/i)).toBeNull();
    for (const name of ['Accept', 'Start preparing', 'Mark ready', 'Ready for pickup', 'Mark picked up', 'Confirm delivered', 'Search for a rider again', 'Find a rider', 'We’ll deliver', 'Get a Swift rider']) {
      expect(screen.queryByRole('button', { name }), name).toBeNull();
    }
    expect(screen.queryByRole('checkbox')).toBeNull();
    expect(screen.queryByRole('button', { name: /^Paid by MMG$/ })).toBeNull();
    // Declining stays where it was: the server allows it.
    if (status === 'PENDING') expect(screen.getByRole('button', { name: 'Reject' })).toBeTruthy();
  });

  it('control: the same order without a dispute keeps its forward buttons', async () => {
    const over = { status: 'ACCEPTED', fulfillment: 'DELIVERY', fulfillmentMode: 'PLATFORM_RIDER', paymentMethod: 'MOBILE_MONEY', paymentStatus: 'CLAIMED' };
    mockApi(boardHandler([wireVendorOrder(over)], wireVendorOrderDetail(over)));
    const { user } = renderWithQuery(<OrdersPage />);
    const row = await rowFor('SW-1001');
    expect(row.textContent).not.toContain('order paused');
    await user.click(row);
    expect(await screen.findByRole('button', { name: 'Start preparing' })).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// [UI-SWEEP U02 / U25 / U45] The store's order window, as on the phone
// (VendorOrderDetailScreen). U02: a store that delivers itself could not see
// the delivery address or call the customer, although the reply carries both.
// U25: no money breakdown, no cancel reason, no timeline, no quoted prep time,
// and no way to close a return. U45: chips printed status codes
// ("READY FOR PICKUP"). Synthetic people and places only.
// ---------------------------------------------------------------------------

function detailHandler(detail: Record<string, unknown>, onPost?: (_request: ApiRequest) => unknown) {
  return (request: ApiRequest) => {
    if (request.method === 'POST' && onPost) return { body: { success: true, data: onPost(request) } };
    return boardHandler([wireVendorOrder(detail)], wireVendorOrderDetail(detail))(request);
  };
}

/** The order's card, on the main board or behind the lane button that holds it (Done, Out for delivery…). */
async function rowAnywhere(user: UserEvent) {
  const laneWithIt = () => screen.queryAllByRole('button', { name: / · 1$/ })[0] ?? null;
  await waitFor(() => expect(screen.queryByText('#SW-1001') ?? laneWithIt()).toBeTruthy());
  if (!screen.queryByText('#SW-1001')) await user.click(laneWithIt()!);
  return rowFor('SW-1001');
}

async function openWindow(detail: Record<string, unknown>, onPost?: (_request: ApiRequest) => unknown) {
  mockApi(detailHandler(detail, onPost));
  const rendered = renderWithQuery(<OrdersPage />);
  const row = await rowAnywhere(rendered.user);
  await rendered.user.click(row);
  const dialog = await screen.findByRole('dialog', { name: 'Order details' });
  await within(dialog).findByRole('region', { name: 'Customer' });
  return { ...rendered, dialog };
}

describe('[U02] the order window finds and calls the customer', () => {
  beforeEach(() => { stubAudioContext(); });

  it('a delivery shows the customer, a Call link, the address and the note', async () => {
    const { dialog } = await openWindow({ status: 'ACCEPTED', fulfillmentMode: 'VENDOR_DELIVERY' });
    const card = within(dialog).getByRole('region', { name: 'Customer' });
    expect(within(card).getByText('Test Customer')).toBeTruthy();
    const call = within(card).getByRole('link', { name: 'Call Test Customer' });
    expect(call.getAttribute('href')).toBe('tel:+5920000000');
    expect(call.className.split(' ')).toContain('min-h-11');
    expect(within(card).getByText('1 Test Road')).toBeTruthy();
    expect(within(card).getByText('Ring the bell twice')).toBeTruthy();
    // It wraps instead of pushing Call off a 360 px window.
    expect((call.parentElement as HTMLElement).className.split(' ')).toEqual(expect.arrayContaining(['flex-wrap']));
  });

  it('a pickup says the customer collects at the counter', async () => {
    const { dialog } = await openWindow({ status: 'ACCEPTED', fulfillment: 'PICKUP', deliveryAddress: null });
    expect(within(within(dialog).getByRole('region', { name: 'Customer' })).getByText('Collects at the counter')).toBeTruthy();
  });

  it('a booking names the slot and where it happens', async () => {
    const { dialog } = await openWindow({
      status: 'ACCEPTED', fulfillment: 'APPOINTMENT', appointmentSlot: '2026-10-20T13:00:00.000Z',
      deliveryAddress: '2 Sample Street', pickupAddress: '9 Shop Lane',
    });
    const card = within(dialog).getByRole('region', { name: 'Customer' });
    expect(within(card).getByText('You travel to: 2 Sample Street')).toBeTruthy();
  });

  it('a phone the server withheld is no Call link, never a broken one', async () => {
    const { dialog } = await openWindow({ status: 'DELIVERED', customer: { id: 'customer-1', firstName: 'Test', lastName: 'Customer', phone: null } });
    const card = within(dialog).getByRole('region', { name: 'Customer' });
    expect(within(card).queryByRole('link')).toBeNull();
  });
});

describe('[U25] the order window carries what the phone shows', () => {
  beforeEach(() => { stubAudioContext(); });

  it('the money card: items, the rider\'s delivery fee, a tip and a promo, what the customer pays, and how', async () => {
    const { dialog } = await openWindow({ status: 'ACCEPTED', tipAmount: '200.00', discount: '300.00', totalAmount: '4400.00' });
    const card = within(dialog).getByRole('region', { name: 'Payment' });
    const text = card.textContent ?? '';
    expect(text).toContain(`Items$${(4000).toLocaleString()}`);
    expect(text).toContain(`Delivery fee (rider’s)$${(500).toLocaleString()}`);
    expect(text).toContain(`Tip$${(200).toLocaleString()}`);
    expect(text).toContain(`Promo discount-$${(300).toLocaleString()}`);
    expect(text).toContain(`Customer pays$${(4400).toLocaleString()}`);
    expect(text).toContain('Cash on handover — you keep 100% of the goods total.');
  });

  it('a card order never reads as cash on handover', async () => {
    const { dialog } = await openWindow({ status: 'ACCEPTED', paymentMethod: 'CARD' });
    expect(within(dialog).getByRole('region', { name: 'Payment' }).textContent).not.toMatch(/Cash on handover/);
  });

  it('a cancelled order says when and why', async () => {
    const { dialog } = await openWindow({ status: 'CANCELLED', cancelledAt: '2026-10-19T14:05:00.000Z', cancellationReason: 'Customer changed their mind' });
    const card = within(dialog).getByRole('region', { name: 'Cancellation' });
    expect(card.textContent).toContain('Cancelled 19 Oct, 10:05 am');
    expect(within(card).getByText('Customer changed their mind')).toBeTruthy();
  });

  it('the timeline runs oldest first in words, and the quoted prep time is beside it', async () => {
    const { dialog } = await openWindow({
      status: 'READY_FOR_PICKUP', estimatedPrepTime: 20,
      acceptedAt: '2026-10-19T14:00:00.000Z', readyAt: '2026-10-19T14:18:00.000Z',
      statusHistory: [
        { status: 'READY_FOR_PICKUP', createdAt: '2026-10-19T14:18:00.000Z', note: null },
        { status: 'ACCEPTED', createdAt: '2026-10-19T14:00:00.000Z', note: 'Accepted on the web' },
      ],
    });
    const timeline = within(dialog).getByRole('region', { name: 'Timeline' });
    const items = within(timeline).getAllByRole('listitem').map((li) => li.textContent ?? '');
    expect(items[0]).toMatch(/^Accepted/);
    expect(items[0]).toContain('Accepted on the web');
    expect(items[1]).toMatch(/^Ready/);
    expect(timeline.textContent).not.toMatch(/READY_FOR_PICKUP|READY FOR PICKUP/);
    expect(within(dialog).getByText('Quoted prep time: 20 min · actual 18 min (ready 10:18 AM)')).toBeTruthy();
  });

  it('a return on its way back: the store confirms the goods are back with it', async () => {
    const posts: string[] = [];
    const { dialog, user } = await openWindow({
      status: 'RETURNING', pickedUpAt: '2026-10-19T14:20:00.000Z', riderId: 'rider-1',
      custodyRecovery: { caseId: 'case-1', state: 'RETURN_REQUIRED', open: true, headline: 'The order is coming back to you', body: 'The rider is bringing the goods back.' },
    }, (request) => { posts.push(request.url.pathname); return { orderId: 'order-live', caseId: 'case-1', state: 'RETURNED' }; });
    const card = within(dialog).getByRole('region', { name: 'Delivery recovery' });
    expect(within(card).getByText('The order is coming back to you')).toBeTruthy();
    await user.click(within(card).getByRole('button', { name: 'The order is back with us' }));
    await waitFor(() => expect(posts).toContain('/api/v1/vendor/orders/order-live/recovery/return-received'));
  });

  it('a courier parcel never offers the store the return', async () => {
    const { dialog } = await openWindow({
      status: 'RETURNING', orderType: 'COURIER', pickedUpAt: '2026-10-19T14:20:00.000Z', riderId: 'rider-1',
      custodyRecovery: { caseId: 'case-1', state: 'RETURN_REQUIRED', open: true, headline: 'The parcel is going back', body: 'It returns to its sender.' },
    });
    expect(within(dialog).queryByRole('button', { name: 'The order is back with us' })).toBeNull();
  });
});

describe('[U45] statuses read as words, never as codes', () => {
  beforeEach(() => { stubAudioContext(); });

  it.each([
    ['READY_FOR_PICKUP', 'Ready'],
    ['RIDER_EN_ROUTE_PICKUP', 'Rider en route'],
    ['RIDER_ARRIVED_PICKUP', 'Rider at counter'],
    ['EN_ROUTE_DELIVERY', 'Out for delivery'],
  ])('%s reads "%s" on the board and in the window', async (status, words) => {
    mockApi(boardHandler([wireVendorOrder({ status })], wireVendorOrderDetail({ status })));
    const { user } = renderWithQuery(<OrdersPage />);
    const row = await rowAnywhere(user);
    expect(within(row).getByText(words)).toBeTruthy();
    expect(row.textContent).not.toMatch(/[A-Z]{2,}_[A-Z]|EN ROUTE PICKUP|FOR PICKUP/);
    await user.click(row);
    const dialog = await screen.findByRole('dialog', { name: 'Order details' });
    expect(await within(dialog).findAllByText(words)).not.toHaveLength(0);
  });
});
