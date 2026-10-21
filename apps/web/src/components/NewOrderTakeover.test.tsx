import { screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import NewOrderTakeover from './NewOrderTakeover';
import { mockApi, renderWithQuery, stubAudioContext } from '@/test/test-utils';
import { wireVendorOrder } from '@/test/vendor-wire-fixtures';
import { normalizeVendorOrder } from '@/lib/vendor-api';
import { storeKey } from '@/lib/store-scope';
import { getSelectedStore, setSelectedStore } from '@/lib/auth';
import { axeViolations } from '@/test/axe';

/**
 * The full-screen new-order takeover is the loudest money surface the vendor
 * has — it is the screen a store accepts an order from. It printed "$NaN"
 * for the same reason the board did.
 *
 * The first poll only BASELINES (a dashboard opened onto an old queue must not
 * scream), so each test renders an empty queue first and then the arrival.
 */
describe('new-order takeover', () => {
  beforeEach(() => {
    stubAudioContext();
  });

  it('shows the real total from `totalAmount`, never "$NaN"', async () => {
    const { rerender } = renderWithQuery(<NewOrderTakeover orders={[]} />);
    rerender(<NewOrderTakeover orders={[normalizeVendorOrder(wireVendorOrder())]} />);

    const headline = await screen.findByText(new RegExp(`SW-1001`));
    expect(headline.textContent).toContain(`$${(4500).toLocaleString()}`);
    expect(document.body.textContent ?? '').not.toMatch(/NaN/);
  });

  it('[Q12] an order the next poll shows cancelled leaves the takeover — no chime for an order that no longer exists', async () => {
    const { rerender } = renderWithQuery(<NewOrderTakeover orders={[]} />);
    rerender(<NewOrderTakeover orders={[normalizeVendorOrder(wireVendorOrder())]} />);
    await screen.findByText(/NEW ORDER/);

    // The customer cancelled (express, or after the free-cancel hold): the
    // board's next poll carries the order as CANCELLED.
    rerender(<NewOrderTakeover orders={[normalizeVendorOrder(wireVendorOrder({ status: 'CANCELLED' }))]} />);
    await waitFor(() => expect(screen.queryByText(/NEW ORDER/)).toBeNull());
    expect(screen.queryByRole('button', { name: 'Accept' })).toBeNull();
  });

  it('renders an em-dash rather than a made-up $0 when no total arrived', async () => {
    const raw = wireVendorOrder() as Record<string, unknown>;
    delete raw['totalAmount'];
    const { rerender } = renderWithQuery(<NewOrderTakeover orders={[]} />);
    rerender(<NewOrderTakeover orders={[normalizeVendorOrder(raw)]} />);

    const headline = await screen.findByText(new RegExp(`SW-1001`));
    await waitFor(() => expect(headline.textContent).toContain('—'));
    expect(headline.textContent).not.toContain('$0');
    expect(headline.textContent ?? '').not.toMatch(/NaN/);
  });

  it('a rejection always sends the reason the server now requires (E10 RED: web sent {})', async () => {
    const fetchMock = mockApi((request) => {
      if (request.method === 'PUT' && request.url.pathname === '/api/v1/vendor/orders/order-live/reject') {
        return { body: { success: true, data: { id: 'order-live', status: 'CANCELLED' } } };
      }
      throw new Error(`Unexpected request: ${request.method} ${request.url}`);
    });
    const { rerender, user } = renderWithQuery(<NewOrderTakeover orders={[]} />);
    rerender(<NewOrderTakeover orders={[normalizeVendorOrder(wireVendorOrder())]} />);

    await screen.findByText(/NEW ORDER/);
    await user.click(screen.getByRole('button', { name: 'Reject — tell us why' }));
    await user.click(screen.getByRole('button', { name: 'Out of stock' }));

    await waitFor(() => {
      const call = fetchMock.mock.calls.find(([url]) => String(url).includes('/orders/order-live/reject'));
      expect(call).toBeTruthy();
      expect(JSON.parse(String(call![1]?.body))).toEqual({ reason: 'Out of stock' });
    });
  });

  it('a booking is declined with a booking reason, never a kitchen one (E10 · DS200 D3)', async () => {
    const fetchMock = mockApi((request) => {
      if (request.method === 'PUT' && request.url.pathname === '/api/v1/vendor/orders/order-live/reject') {
        return { body: { success: true, data: { id: 'order-live', status: 'CANCELLED' } } };
      }
      throw new Error(`Unexpected request: ${request.method} ${request.url}`);
    });
    const raw = { ...wireVendorOrder(), fulfillment: 'APPOINTMENT', appointmentSlot: '2026-09-24T13:00:00.000Z' };
    const { rerender, user } = renderWithQuery(<NewOrderTakeover orders={[]} />);
    rerender(<NewOrderTakeover orders={[normalizeVendorOrder(raw)]} />);

    await screen.findByText('NEW BOOKING');
    await user.click(screen.getByRole('button', { name: 'Decline — tell us why' }));
    expect(screen.queryByRole('button', { name: 'Kitchen is too busy' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Fully booked at that time' }));

    await waitFor(() => {
      const call = fetchMock.mock.calls.find(([url]) => String(url).includes('/orders/order-live/reject'));
      expect(call).toBeTruthy();
      expect(JSON.parse(String(call![1]?.body))).toEqual({ reason: 'Fully booked at that time' });
    });
  });

  it('shows a booking at the market time without kitchen prep controls', async () => {
    const raw = {
      ...wireVendorOrder(), fulfillment: 'APPOINTMENT', appointmentSlot: '2026-09-24T13:00:00.000Z',
    };
    const { rerender } = renderWithQuery(<NewOrderTakeover orders={[]} />);
    rerender(<NewOrderTakeover orders={[normalizeVendorOrder(raw)]} />);
    expect(await screen.findByText('NEW BOOKING')).toBeTruthy();
    expect(screen.getByText(/9:00 AM/)).toBeTruthy();
    expect(screen.queryByText('20 min prep')).toBeNull();
    expect(screen.getByRole('button', { name: 'Decline — tell us why' })).toBeTruthy();
  });

  it('stacks full-width, touch-sized decisions on a narrow phone', async () => {
    const { rerender, user } = renderWithQuery(<NewOrderTakeover orders={[]} />);
    rerender(<NewOrderTakeover orders={[normalizeVendorOrder(wireVendorOrder())]} />);
    await screen.findByText('NEW ORDER');
    const accept = screen.getByRole('button', { name: 'Accept' });
    const reject = screen.getByRole('button', { name: 'Reject — tell us why' });
    const prep = screen.getByRole('combobox', { name: 'Preparation time' });
    for (const control of [prep, accept, reject]) {
      expect(control.className).toContain('w-full');
      expect(control.className).toContain('min-h-11');
    }
    expect(accept.parentElement?.className).toContain('flex-col');
    // The reasons, once asked for, are touch-sized full-width presses too.
    await user.click(reject);
    for (const name of ['Out of stock', 'Kitchen is too busy', 'Closing soon', 'Back']) {
      const control = screen.getByRole('button', { name });
      expect(control.className, name).toContain('w-full');
      expect(control.className, name).toContain('min-h-11');
    }
  });
});

// ---------------------------------------------------------------------------
// [UI-SWEEP U21] A rejection cannot be undone and the customer is told at once.
// The popup rejected on ONE tap with a preselected reason; the phone asks in two
// steps ("Reject — tell us why", then the reason, with Back). And the popup was
// not a dialog: no role, focus stayed on the page behind it, Tab walked out.
// [U48] After a decision the popup refreshed ['orders'], a key the store-scoped
// board never uses, so the order sat under "New" until the next poll.
// ---------------------------------------------------------------------------
describe('new-order popup: a decision is deliberate, and the popup is a dialog', () => {
  beforeEach(() => { stubAudioContext(); });

  const arrive = async () => {
    const rendered = renderWithQuery(<NewOrderTakeover orders={[]} />);
    rendered.rerender(<NewOrderTakeover orders={[normalizeVendorOrder(wireVendorOrder())]} />);
    await screen.findByText('NEW ORDER');
    return rendered;
  };

  it('one stray press never rejects: the first press only asks why, and Back undoes it', async () => {
    const fetchMock = mockApi(() => ({ body: { success: true, data: {} } }));
    const { user } = await arrive();
    await user.click(screen.getByRole('button', { name: 'Reject — tell us why' }));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.getByRole('group', { name: 'Why are you rejecting?' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Closing soon' })).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Back' }));
    expect(screen.queryByRole('button', { name: 'Closing soon' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Reject — tell us why' })).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('is a labelled modal dialog that takes focus on Accept', async () => {
    await arrive();
    const dialog = screen.getByRole('alertdialog', { name: 'NEW ORDER' });
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Accept' }));
    expect(await axeViolations(dialog)).toEqual([]);
  });

  it('keeps Tab inside, and a reflex Escape neither dismisses it nor leaks to the page', async () => {
    const leaked = vi.fn();
    document.addEventListener('keydown', leaked);
    try {
      const { user } = await arrive();
      const dialog = screen.getByRole('alertdialog', { name: 'NEW ORDER' });
      const later = screen.getByRole('button', { name: /View later/ });
      later.focus();
      await user.tab();
      expect(dialog.contains(document.activeElement)).toBe(true);
      await user.tab({ shift: true });
      expect(document.activeElement).toBe(later);
      await user.keyboard('{Escape}');
      expect(screen.getByRole('alertdialog', { name: 'NEW ORDER' })).toBeTruthy();
      expect(leaked.mock.calls.some(([e]) => (e as KeyboardEvent).key === 'Escape')).toBe(false);
    } finally {
      document.removeEventListener('keydown', leaked);
    }
  });

  it('after a decision it refreshes the store\'s own board, not a key nobody reads', async () => {
    mockApi(() => ({ body: { success: true, data: { id: 'order-live', status: 'ACCEPTED' } } }));
    setSelectedStore('store-1');
    const { user, queryClient } = await arrive();
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    await user.click(screen.getByRole('button', { name: 'Accept' }));
    await waitFor(() => expect(invalidate).toHaveBeenCalled());
    const keys = invalidate.mock.calls.map(([filters]) => JSON.stringify(filters?.queryKey));
    expect(keys).toContain(JSON.stringify(storeKey(getSelectedStore(), 'orders')));
    expect(keys).not.toContain(JSON.stringify(['orders']));
  });
});

// [Item 10] The takeover asks a store to accept: never for an order whose MMG
// payment is disputed (the server refuses the accept).
describe('MMG dispute during a new-order takeover', () => {
  beforeEach(() => { stubAudioContext(); });
  it('does not offer acceptance of a newly arrived disputed order', async () => {
    const { rerender } = renderWithQuery(<NewOrderTakeover orders={[]} />);
    rerender(<NewOrderTakeover orders={[normalizeVendorOrder(wireVendorOrder({ paymentMethod: 'MOBILE_MONEY', mmgClaimMismatchAt: '2026-10-07T12:00:00.000Z' }))]} />);
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Accept' })).toBeNull());
  });
  it('a newly arrived disputed order never starts the chime', async () => {
    const created = vi.fn();
    const Base = (globalThis as unknown as { AudioContext: new () => object }).AudioContext;
    (globalThis as unknown as { AudioContext: unknown }).AudioContext = class extends Base { constructor() { super(); created(); } };
    const { rerender } = renderWithQuery(<NewOrderTakeover orders={[]} />);
    rerender(<NewOrderTakeover orders={[normalizeVendorOrder(wireVendorOrder({ paymentMethod: 'MOBILE_MONEY', mmgClaimMismatchAt: '2026-10-07T12:00:00.000Z' }))]} />);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(created).not.toHaveBeenCalled();
  });
  it('withdraws a queued acceptance when the next poll reports a dispute', async () => {
    const { rerender } = renderWithQuery(<NewOrderTakeover orders={[]} />);
    const order = normalizeVendorOrder(wireVendorOrder({ paymentMethod: 'MOBILE_MONEY' }));
    rerender(<NewOrderTakeover orders={[order]} />);
    await screen.findByRole('button', { name: 'Accept' });
    rerender(<NewOrderTakeover orders={[{ ...order, mmgClaimMismatchAt: '2026-10-07T12:00:00.000Z' } as typeof order]} />);
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Accept' })).toBeNull());
  });
});
