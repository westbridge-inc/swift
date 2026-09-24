import { screen, waitFor, render } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import OrderDetailPage from './page';
import * as customer from '@/lib/customer';

// ---------------------------------------------------------------------------
// [W-32] CONSENT IS TO A SPECIFIC PAYMENT.
//
// Tapping "Pay X by MMG" refetches the order before opening — a real positive
// control, and only half of one. It re-verified that SOME payment action was
// still available and then opened WHATEVER CAME BACK. A link that changed
// between render and tap — a poisoned server answer, or merely a stale one —
// sent the customer to a destination they had never seen, having agreed to a
// different recipient and a different amount.
//
// The action that opens must be the one that was on screen when the button was
// pressed, in every field the customer was shown.
// ---------------------------------------------------------------------------

const ACTION = {
  kind: 'OPEN_EXTERNAL_URL' as const,
  method: 'MOBILE_MONEY' as const,
  provider: 'MMG' as const,
  fundsFlow: 'DIRECT_TO_VENDOR' as const,
  recipientName: 'Shanta Kitchen',
  amount: 3500,
  url: 'https://pay.mmg.gy/checkout/abc123',
};

const ORDER = {
  id: 'order-1',
  orderNumber: 'SW-2001',
  status: 'ACCEPTED',
  paymentMethod: 'MOBILE_MONEY',
  paymentStatus: 'PENDING',
  totalAmount: 3500,
  items: [],
  statusHistory: [],
  vendor: { id: 'v1', name: 'Shanta Kitchen' },
  paymentAction: ACTION,
};

vi.mock('next/navigation', () => ({ useParams: () => ({ id: 'order-1' }) }));

let opened: { location: { replace: ReturnType<typeof vi.fn> }; close: ReturnType<typeof vi.fn>; opener: unknown };

beforeEach(() => {
  opened = { location: { replace: vi.fn() }, close: vi.fn(), opener: {} };
  vi.stubGlobal('open', vi.fn(() => opened));
  vi.spyOn(customer, 'getOrder').mockResolvedValue(ORDER as never);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const payButton = () => screen.findByRole('button', { name: /Pay Shanta Kitchen by MMG/ });

describe('[W-32] the payment that opens is the payment that was shown', () => {
  it('shows a service appointment at the market time on the order page', async () => {
    vi.spyOn(customer, 'getOrder').mockResolvedValue({
      ...ORDER, fulfillment: 'APPOINTMENT', appointmentSlot: '2026-09-24T13:00:00.000Z',
    } as never);
    render(<OrderDetailPage />);
    expect(await screen.findByText(/Thu, Sep 24, 9:00 AM/)).toBeTruthy();
  });

  it('says who is paid and how much BEFORE anything opens', async () => {
    render(<OrderDetailPage />);
    expect(await screen.findByText(/sends .* directly to Shanta Kitchen/)).toBeTruthy();
    expect(await payButton()).toBeTruthy();
  });

  it('opens the verified link when the refetch returns the same payment', async () => {
    const user = userEvent.setup();
    render(<OrderDetailPage />);
    await user.click(await payButton());
    await waitFor(() => expect(opened.location.replace).toHaveBeenCalledWith(ACTION.url));
  });

  it('a RECIPIENT that changed under the customer opens nothing, and says so', async () => {
    const user = userEvent.setup();
    render(<OrderDetailPage />);
    const button = await payButton();
    vi.spyOn(customer, 'getOrder').mockResolvedValue({
      ...ORDER, paymentAction: { ...ACTION, recipientName: 'Someone Else' },
    } as never);

    await user.click(button);
    await waitFor(() => expect(opened.close).toHaveBeenCalled());
    expect(opened.location.replace).not.toHaveBeenCalled();
    expect(await screen.findByText(/changed while you were looking at it/)).toBeTruthy();
  });

  it('an AMOUNT that changed under the customer opens nothing', async () => {
    const user = userEvent.setup();
    render(<OrderDetailPage />);
    const button = await payButton();
    vi.spyOn(customer, 'getOrder').mockResolvedValue({
      ...ORDER, paymentAction: { ...ACTION, amount: 99_000 },
    } as never);

    await user.click(button);
    await waitFor(() => expect(opened.close).toHaveBeenCalled());
    expect(opened.location.replace).not.toHaveBeenCalled();
  });

  it('a swapped DESTINATION opens nothing — the whole point of the control', async () => {
    const user = userEvent.setup();
    render(<OrderDetailPage />);
    const button = await payButton();
    vi.spyOn(customer, 'getOrder').mockResolvedValue({
      ...ORDER, paymentAction: { ...ACTION, url: 'https://pay.mmg.gy/checkout/attacker' },
    } as never);

    await user.click(button);
    await waitFor(() => expect(opened.close).toHaveBeenCalled());
    expect(opened.location.replace).not.toHaveBeenCalled();
  });

  it('a non-https destination is never offered at all', async () => {
    vi.spyOn(customer, 'getOrder').mockResolvedValue({
      ...ORDER, paymentAction: { ...ACTION, url: 'http://pay.mmg.gy/checkout/abc123' },
    } as never);
    render(<OrderDetailPage />);
    await screen.findByText(/do not pay from unverified details/);
    expect(screen.queryByRole('button', { name: /Pay .* by MMG/ })).toBeNull();
  });
});

describe('taxi safety continues in the mobile app', () => {
  it.each(['REQUESTED', 'DRIVER_ARRIVED', 'RIDE_IN_PROGRESS', 'COMPLETED', 'CANCELLED'])(
    '%s shows the mobile safety notice without pretending web can start the ride', async (status) => {
      vi.spyOn(customer, 'getOrder').mockResolvedValue({
        ...ORDER, orderType: 'TAXI', status, paymentMethod: 'CASH', paymentAction: null,
      } as never);
      vi.spyOn(customer, 'getRide').mockResolvedValue({ id: ORDER.id } as never);
      vi.spyOn(customer, 'activeRide').mockResolvedValue(null);
      render(<OrderDetailPage />);
      expect(await screen.findByText(/Open the Swift app for your safety PIN and SOS/)).toBeTruthy();
      expect(screen.getByText(/You cannot start or manage ride safety on the web/)).toBeTruthy();
      expect(screen.getByRole('link', { name: 'Open Swift app' }).getAttribute('href')).toBe('swift://');
      expect(screen.queryByRole('button', { name: /start ride|SOS|share trip|not my driver/i })).toBeNull();
    },
  );

  it('does not show the taxi notice for a delivery', async () => {
    render(<OrderDetailPage />);
    await payButton();
    expect(screen.queryByText(/Open the Swift app for your safety PIN and SOS/)).toBeNull();
  });
});
