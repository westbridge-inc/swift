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
