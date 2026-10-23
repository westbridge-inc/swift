import { screen, waitFor, render } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import OrderDetailPage from './page';
import { lineDisplayAmount } from '@/lib/money';
import * as orders from '@/lib/customer-orders';
import * as rides from '@/lib/customer-rides';

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
  vi.spyOn(orders, 'getOrder').mockResolvedValue(ORDER as never);
  // [Row 117] Web taxi booking is off (the server's default) unless a case says otherwise.
  vi.spyOn(rides, 'rideCapabilities').mockResolvedValue({ maxStops: 0 });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const payButton = () => screen.findByRole('button', { name: /Pay Shanta Kitchen by MMG/ });

describe('receipt amount presentation', () => {
  it('shows an unknown line as unknown, while a real zero stays zero', () => {
    expect(lineDisplayAmount(undefined, undefined, 2)).toBeNull();
    expect(lineDisplayAmount(undefined, NaN, 2)).toBeNull();
    expect(lineDisplayAmount(undefined, 0, 2)).toBe(0);
    expect(lineDisplayAmount(undefined, 1200, 2)).toBe(2400);
  });

  it('renders unknown line and order totals as dashes on the receipt', async () => {
    vi.spyOn(orders, 'getOrder').mockResolvedValue({
      ...ORDER, totalAmount: undefined, paymentAction: null,
      items: [{ id: 'line-1', name: 'Rice', quantity: 2 }],
    } as never);
    render(<OrderDetailPage />);
    const receipt = (await screen.findByText('Receipt preview')).closest('aside');
    expect(receipt?.textContent).toMatch(/2× Rice—/);
    expect(receipt?.textContent).toMatch(/Total—/);
    expect(receipt?.textContent).not.toContain('GY$0');
  });
});

describe('[W-32] the payment that opens is the payment that was shown', () => {
  it('shows a service appointment at the market time on the order page', async () => {
    vi.spyOn(orders, 'getOrder').mockResolvedValue({
      ...ORDER, fulfillment: 'APPOINTMENT', appointmentSlot: '2026-09-24T13:00:00.000Z',
    } as never);
    render(<OrderDetailPage />);
    expect(await screen.findByText(/Thu, Sep 24, 9:00 AM/)).toBeTruthy();
  });

  // [R14 · legal research D12] The server says when the store delivers with its own rider; the page prints exactly that.
  it('shows the own-rider notice the server sent, and nothing when it sent none', async () => {
    const NOTICE = "This order is delivered by the store's own rider, not a Swift rider.";
    vi.spyOn(orders, 'getOrder').mockResolvedValue({ ...ORDER, fulfillment: 'DELIVERY', ownRiderNotice: NOTICE } as never);
    const view = render(<OrderDetailPage />);
    expect((await screen.findByText(NOTICE)).getAttribute('role')).toBe('note');
    view.unmount();
    vi.spyOn(orders, 'getOrder').mockResolvedValue({ ...ORDER, fulfillment: 'DELIVERY', ownRiderNotice: null } as never);
    render(<OrderDetailPage />);
    expect(await screen.findByText(/sends .* directly to Shanta Kitchen/)).toBeTruthy();
    expect(screen.queryByText(/store's own rider/)).toBeNull();
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
    vi.spyOn(orders, 'getOrder').mockResolvedValue({
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
    vi.spyOn(orders, 'getOrder').mockResolvedValue({
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
    vi.spyOn(orders, 'getOrder').mockResolvedValue({
      ...ORDER, paymentAction: { ...ACTION, url: 'https://pay.mmg.gy/checkout/attacker' },
    } as never);

    await user.click(button);
    await waitFor(() => expect(opened.close).toHaveBeenCalled());
    expect(opened.location.replace).not.toHaveBeenCalled();
  });

  it('a non-https destination is never offered at all', async () => {
    vi.spyOn(orders, 'getOrder').mockResolvedValue({
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
      vi.spyOn(orders, 'getOrder').mockResolvedValue({
        ...ORDER, orderType: 'TAXI', status, paymentMethod: 'CASH', paymentAction: null,
      } as never);
      vi.spyOn(rides, 'getRide').mockResolvedValue({ id: ORDER.id } as never);
      vi.spyOn(rides, 'activeRide').mockResolvedValue(null);
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

  it('a failed capabilities read keeps the app notice: nothing on the web claims ride safety', async () => {
    vi.mocked(rides.rideCapabilities).mockRejectedValue(new Error('down'));
    vi.spyOn(orders, 'getOrder').mockResolvedValue({ ...ORDER, orderType: 'TAXI', status: 'DRIVER_EN_ROUTE', paymentMethod: 'CASH', paymentAction: null } as never);
    vi.spyOn(rides, 'getRide').mockResolvedValue({ id: ORDER.id, ridePin: '482913', ridePinVerified: false } as never);
    vi.spyOn(rides, 'activeRide').mockResolvedValue(null);
    render(<OrderDetailPage />);
    expect(await screen.findByText(/Open the Swift app for your safety PIN and SOS/)).toBeTruthy();
    expect(screen.queryByText('482913')).toBeNull();
    expect(screen.queryByRole('button', { name: /Emergency/ })).toBeNull();
  });
});

describe('[Row 117] with web taxi booking on, the trip page carries the ride’s safety tools', () => {
  beforeEach(() => {
    vi.mocked(rides.rideCapabilities).mockResolvedValue({ maxStops: 0, webBooking: true });
    vi.spyOn(orders, 'getOrder').mockResolvedValue({ ...ORDER, orderType: 'TAXI', status: 'DRIVER_EN_ROUTE', paymentMethod: 'CASH', paymentAction: null } as never);
    vi.spyOn(rides, 'getRide').mockResolvedValue({
      id: ORDER.id, ridePin: '482913', ridePinVerified: false,
      driver: { vehicleMake: 'Toyota', vehicleModel: 'Axio', vehicleColor: 'White', licensePlate: 'PXX 1234', user: { firstName: 'Dev' } },
    } as never);
    vi.spyOn(rides, 'activeRide').mockResolvedValue({ id: ORDER.id, driver: { currentLat: 6.81, currentLng: -58.16, user: { firstName: 'Dev', phone: '+5920000000' } } } as never);
  });

  it('shows the ride code, the driver’s position and SOS — and no "open the app" notice', async () => {
    render(<OrderDetailPage />);
    expect(await screen.findByText('482913')).toBeTruthy();
    // The driver's first name from the ride read, as the phone says it.
    expect(screen.getByText(/It proves this is your ride — Dev types it to start\./)).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Ride safety' })).toBeTruthy();
    expect(screen.getByRole('img', { name: 'Your driver’s position' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Emergency — get help now' })).toBeTruthy();
    expect(screen.queryByText(/Open the Swift app for your safety PIN and SOS/)).toBeNull();
  });

  it('the SOS pages Swift for THIS ride', async () => {
    vi.spyOn(rides, 'rideSos').mockResolvedValue({ status: 'ACTIVE' });
    const user = userEvent.setup();
    render(<OrderDetailPage />);
    await user.click(await screen.findByRole('button', { name: 'Emergency — get help now' }));
    await user.click(screen.getByRole('button', { name: 'Alert Swift now' }));
    await waitFor(() => expect(rides.rideSos).toHaveBeenCalledWith('order-1', null));
  });

  it('a delivery never asks whether web taxi booking is on', async () => {
    vi.spyOn(orders, 'getOrder').mockResolvedValue(ORDER as never);
    render(<OrderDetailPage />);
    await payButton();
    expect(rides.rideCapabilities).not.toHaveBeenCalled();
    expect(screen.queryByRole('heading', { name: 'Ride safety' })).toBeNull();
  });
});

describe('[E17 · DS231 F4] a courier parcel on its way back has its own heading', () => {
  it.each([
    ['RETURNING', 'Your parcel is coming back to you'],
    ['RETURNED', 'Parcel returned to you'],
  ])('%s reads "%s", never the "Order placed" fallback', async (status, heading) => {
    vi.spyOn(orders, 'getOrder').mockResolvedValue({
      ...ORDER, orderType: 'COURIER', status, paymentMethod: 'CASH', paymentAction: null,
    } as never);
    render(<OrderDetailPage />);
    const h1 = await screen.findByRole('heading', { level: 1 });
    await waitFor(() => expect(h1.textContent).toBe(heading));
  });
});

describe('order page polish (owner screenshots 13 Oct)', () => {
  const pickupOrder = {
    ...ORDER, status: 'PENDING', fulfillment: 'PICKUP', paymentMethod: 'CASH', paymentAction: null,
    deliveryFee: 0, subtotalCustomer: 4500, totalAmount: 4500,
    items: [{ id: 'l1', name: 'Feast Box', quantity: 1, lineTotal: 4500 }],
    timeline: [{ status: 'PENDING', timestamp: '2026-10-13T21:46:00.000Z', note: 'Order placed' }],
  };

  it('names the first timeline step like the status card ("Placed"), never the raw "pending"', async () => {
    vi.spyOn(orders, 'getOrder').mockResolvedValue(pickupOrder as never);
    render(<OrderDetailPage />);
    const timeline = (await screen.findByRole('heading', { name: 'Order timeline' })).closest('section');
    expect(timeline?.textContent).toContain('Placed');
    expect(timeline?.textContent?.toLowerCase()).not.toContain('pending');
  });

  it('a pickup order says it has no delivery fee instead of "Delivery fee $0"', async () => {
    vi.spyOn(orders, 'getOrder').mockResolvedValue(pickupOrder as never);
    render(<OrderDetailPage />);
    const receipt = (await screen.findByText('Receipt preview')).closest('aside');
    expect(receipt?.textContent).toContain('No delivery fee');
    expect(receipt?.textContent).not.toMatch(/Delivery fee/);
  });

  it('the timeline and the receipt keep the same 16 px gap as every other card on a narrow screen', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const css = readFileSync(join(process.cwd(), 'src/app/(app)/orders/[id]/tracking.module.css'), 'utf8');
    const base = css.slice(0, css.indexOf('@media'));
    expect(base).toMatch(/\.detailGrid\s*\{[^}]*display:\s*grid;[^}]*gap:\s*16px;/);
  });
});

// ---------------------------------------------------------------------------
// [owner #46/#50/#52, 13–14 Oct] No cancellation fee is ever shown. A cancel is
// free or refused: when the server refuses it, the page says why in the
// server's words and offers the store's published number instead.
// ---------------------------------------------------------------------------
describe('[owner #46/#50] cancel: free, or contact the store — never a fee', () => {
  const cashOrder = { ...ORDER, paymentMethod: 'CASH', paymentAction: null, cancellationFee: 0 };

  it('an accepted order offers no Cancel: the server’s reason and the store’s number instead', async () => {
    vi.spyOn(orders, 'getOrder').mockResolvedValue({
      ...cashOrder, status: 'ACCEPTED', canCancel: false,
      cancelUnavailable: { code: 'STORE_ACCEPTED', message: 'The store has accepted your order, so it can no longer be cancelled in the app. Contact the store to change or cancel it.', contactPhone: '+5926001234' },
    } as never);
    render(<OrderDetailPage />);
    expect(await screen.findByText(/can no longer be cancelled in the app/)).toBeTruthy();
    const call = screen.getByRole('link', { name: 'Call +5926001234' });
    expect(call.getAttribute('href')).toBe('tel:+5926001234');
    expect(screen.queryByRole('button', { name: 'Review cancellation' })).toBeNull();
    expect(document.body.textContent).not.toMatch(/cancellation fee|late-cancellation/i);
  });

  it('a free cancel says it is free in the server’s words — no fee wording anywhere', async () => {
    vi.spyOn(orders, 'getOrder').mockResolvedValue({
      ...cashOrder, status: 'PENDING', canCancel: true, cancelUnavailable: null,
      cancellationMessage: 'You can cancel for free until the store accepts your order.',
    } as never);
    render(<OrderDetailPage />);
    await userEvent.click(await screen.findByRole('button', { name: 'Review cancellation' }));
    expect(screen.getByText(/You can cancel for free until the store accepts your order\./)).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/fee was recorded|cancellation fee|late-cancellation/i);
  });

  it('[DS1141 S1] with no server message (an older server) the page never authors "free" itself', async () => {
    vi.spyOn(orders, 'getOrder').mockResolvedValue({
      ...cashOrder, status: 'DRIVER_ASSIGNED', canCancel: true, cancellationFee: 500,
    } as never);
    render(<OrderDetailPage />);
    await userEvent.click(await screen.findByRole('button', { name: 'Review cancellation' }));
    const quote = document.getElementById('cancellation-quote');
    expect(quote?.textContent).toMatch(/shows the final result/);
    expect(quote?.textContent?.toLowerCase()).not.toContain('free');
  });
});

// [owner 17-18 Oct 2026 · PAYMENT-SIMPLIFY] MMG goes to the store's NUMBER: shown only on the customer's own
// accepted order, with who confirms it and when the order cancels if it is not marked paid (30 minutes).
describe("[PAYMENT-SIMPLIFY] the store's MMG number on the order page", () => {
  const PAYMENT = {
    payTo: 'STORE_NUMBER', provider: 'MMG', fundsFlow: 'DIRECT_TO_VENDOR', recipientName: 'Shanta Kitchen',
    number: '+5926001234', numberDisplay: '+592 600 1234', amount: 3500, currencyCode: 'GYD',
    instruction: "Pay $3,500 by MMG to Shanta Kitchen's MMG number +592 600 1234.",
    payBy: '2026-10-18T19:45:00.000Z',
    deadline: "If Shanta Kitchen hasn't marked it paid by 3:45 PM, the order is cancelled automatically.",
  };

  it('an accepted order shows the number sentence, who confirms it, and the deadline; no link button', async () => {
    vi.spyOn(orders, 'getOrder').mockResolvedValue({ ...ORDER, paymentAction: null, mmgPayment: PAYMENT } as never);
    render(<OrderDetailPage />);
    expect(await screen.findByText(PAYMENT.instruction, { exact: false })).toBeTruthy();
    expect(screen.getByText(/Shanta Kitchen marks your order paid when the money arrives\. Swift never holds this money\./)).toBeTruthy();
    expect(screen.getByText(PAYMENT.deadline)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /by MMG/ })).toBeNull();
  });

  it('before the store accepts: the page says the number comes after acceptance, and shows none', async () => {
    vi.spyOn(orders, 'getOrder').mockResolvedValue({ ...ORDER, status: 'PENDING', paymentAction: null, mmgPayment: null } as never);
    render(<OrderDetailPage />);
    expect(await screen.findByText(/When the business accepts, this page shows its MMG number and the exact amount\. Pay within 30 minutes of it accepting, or the order cancels automatically\./)).toBeTruthy();
    expect(document.body.textContent).not.toContain('600 1234');
  });

  // [REVIEW-F S4-1] The page's own gate, behind the server's: a paid or closed order never shows a number.
  it.each([
    ['marked paid by the store', { paymentStatus: 'CLAIMED' }],
    ['cancelled', { status: 'CANCELLED' }],
  ])('a %s order never shows the number, even if one arrives', async (_label, change) => {
    vi.spyOn(orders, 'getOrder').mockResolvedValue({ ...ORDER, paymentAction: null, mmgPayment: PAYMENT, ...change } as never);
    render(<OrderDetailPage />);
    expect(await screen.findByText('SW-2001', { exact: false })).toBeTruthy();
    expect(document.body.textContent).not.toContain('600 1234');
    expect(document.body.textContent).not.toContain(PAYMENT.deadline);
  });

  it('an order cancelled because it was not marked paid in time says why', async () => {
    const notice = "Shanta Kitchen didn't mark your MMG payment as received within 30 minutes of accepting, so this order was cancelled automatically. If you already sent the MMG payment, Shanta Kitchen refunds you directly.";
    vi.spyOn(orders, 'getOrder').mockResolvedValue({
      ...ORDER, status: 'CANCELLED', paymentAction: null, mmgPayment: null,
      cancellationReason: 'Cancelled automatically: not marked "Paid by MMG" within 30 minutes of being accepted', cancellationNotice: notice,
    } as never);
    render(<OrderDetailPage />);
    expect(await screen.findByText(notice)).toBeTruthy();
  });

  // [UI-SWEEP U14 · COORD ruling 21 Oct] The customer never reads a raw code.
  it('a cancellation code the server writes reads as words, never as the code', async () => {
    vi.spyOn(orders, 'getOrder').mockResolvedValue({ ...ORDER, status: 'CANCELLED', paymentAction: null, mmgPayment: null, cancellationReason: 'FOOD_TOO_OLD', cancellationNotice: null } as never);
    render(<OrderDetailPage />);
    expect(await screen.findByText('Your order was ready but no rider could be found, so it was cancelled rather than delivered cold.')).toBeTruthy();
    expect(document.body.textContent).not.toContain('FOOD_TOO_OLD');
  });

  it('a cancellation code this build does not know says only that the order was cancelled', async () => {
    vi.spyOn(orders, 'getOrder').mockResolvedValue({ ...ORDER, status: 'CANCELLED', paymentAction: null, mmgPayment: null, cancellationReason: 'SOME_NEW_CODE', cancellationNotice: null } as never);
    render(<OrderDetailPage />);
    expect(await screen.findByText('This order was cancelled.')).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/SOME_NEW_CODE|some new code/i);
  });

  it('a reason the store typed is kept as written', async () => {
    vi.spyOn(orders, 'getOrder').mockResolvedValue({ ...ORDER, status: 'CANCELLED', paymentAction: null, mmgPayment: null, cancellationReason: 'Out of stock', cancellationNotice: null } as never);
    render(<OrderDetailPage />);
    expect(await screen.findByText('Out of stock')).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// [SUBSTITUTION · owner live test 17 Oct 2026] A store's swap question never
// reached the customer. On the web the customer now sees it, from the server's
// own swap view (permitted answers, price change, deadline), and answers it;
// a line that came off the order reads removed and charges nothing.
// ---------------------------------------------------------------------------
describe('[SUBSTITUTION] the store asks the customer about a swap', () => {
  const swapOrder = (substitution: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
    ...ORDER, status: 'PREPARING', paymentMethod: 'CASH', paymentAction: null, totalAmount: 7600,
    items: [
      { id: 'line-1', name: 'Fried Rice', quantity: 1, lineTotal: 1500, customerPrice: 1500, subStatus: 'PENDING', substituteName: 'Chilly Fish', substitutePrice: 2500, substitution },
    ],
    ...extra,
  });
  const CASH_VIEW = { state: 'PENDING', priceDelta: 1000, decisions: { approve: true, reject: true }, settlementGuidance: null, original: { options: [] }, decideBy: '2026-10-17T21:23:00.000Z', ifNoAnswer: 'REMOVE' };

  it('shows the question with the price change and the deadline, and both answers post to the server', async () => {
    const get = vi.spyOn(orders, 'getOrder').mockResolvedValue(swapOrder(CASH_VIEW) as never);
    const decide = vi.spyOn(orders, 'decideSubstitution').mockResolvedValue({} as never);
    render(<OrderDetailPage />);
    expect(await screen.findByRole('heading', { name: 'Swap Fried Rice for Chilly Fish?' })).toBeTruthy();
    expect(screen.getByText(/Approving adds \$1,000 to your total\./)).toBeTruthy();
    expect(screen.getByText(/Please answer by .+\. If you don't, it comes off your order and your total goes down\./)).toBeTruthy();
    const loadsBefore = get.mock.calls.length;
    await userEvent.click(screen.getByRole('button', { name: 'Approve swap' }));
    expect(decide).toHaveBeenCalledWith('order-1', 'line-1', true);
    await waitFor(() => expect(get.mock.calls.length).toBeGreaterThan(loadsBefore));
    await userEvent.click(screen.getByRole('button', { name: 'Decline' }));
    expect(decide).toHaveBeenLastCalledWith('order-1', 'line-1', false);
  });

  it('offers only the answers the server accepts, and says why', async () => {
    vi.spyOn(orders, 'getOrder').mockResolvedValue(swapOrder({
      ...CASH_VIEW, priceDelta: 0, decisions: { approve: false, reject: false },
      settlementGuidance: 'MMG order totals can’t change in-app — the store settles item changes with you directly until in-app MMG adjustments arrive.',
      ifNoAnswer: 'WITHDRAW',
    }, { paymentMethod: 'MOBILE_MONEY' }) as never);
    render(<OrderDetailPage />);
    await screen.findByRole('heading', { name: 'Swap Fried Rice for Chilly Fish?' });
    expect((screen.getByRole('button', { name: 'Approve swap' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Decline' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/the store settles item changes with you directly/)).toBeTruthy();
    expect(screen.getByText(/If it isn't approved by .+, the store settles this item with you directly\./)).toBeTruthy();
  });

  // [O-4 · owner 22 Oct 2026] Nothing to swap, asked before the store accepted.
  it('a removal question: "Continue without it" answers yes; "Cancel order" opens the checked cancel; no decline is offered', async () => {
    const removal = { ...CASH_VIEW, kind: 'REMOVAL', priceDelta: -1500, decisions: { approve: true, reject: false } };
    vi.spyOn(orders, 'getOrder').mockResolvedValue(swapOrder(removal, { status: 'PENDING', canCancel: true }) as never);
    const decide = vi.spyOn(orders, 'decideSubstitution').mockResolvedValue({} as never);
    render(<OrderDetailPage />);
    expect(await screen.findByRole('heading', { name: 'Fried Rice is out of stock' })).toBeTruthy();
    expect(screen.getByText('Continuing without it lowers your total by $1,500. You pay only the new total.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Decline' })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Continue without it' }));
    expect(decide).toHaveBeenCalledWith('order-1', 'line-1', true);
    expect((screen.getByRole('button', { name: 'Cancel order' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('[REVIEW-F S3-1] the only item left: no "Continue", the reason in words, and only the free cancel', async () => {
    const only = { ...CASH_VIEW, kind: 'REMOVAL', lastItem: true, priceDelta: null, decisions: { approve: false, reject: false },
      settlementGuidance: "This was the only item on your order, so the order can't go ahead. Cancel it — nothing has been charged.", ifNoAnswer: 'CANCEL' };
    vi.spyOn(orders, 'getOrder').mockResolvedValue(swapOrder(only, { status: 'PENDING', canCancel: true }) as never);
    render(<OrderDetailPage />);
    expect(await screen.findByRole('heading', { name: 'Fried Rice is out of stock' })).toBeTruthy();
    expect(screen.getByText("This was the only item on your order, so the order can't go ahead. Cancel it — nothing has been charged.")).toBeTruthy();
    expect(screen.getByText(/If you don't, the order is cancelled\. Nothing has been charged\./)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Continue without it' })).toBeNull();
    expect((screen.getByRole('button', { name: 'Cancel order' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('a removed line reads removed and charges nothing on the receipt preview', async () => {
    vi.spyOn(orders, 'getOrder').mockResolvedValue({
      ...ORDER, status: 'PREPARING', paymentMethod: 'CASH', paymentAction: null, totalAmount: 1900, subtotalCustomer: 1900,
      items: [
        { id: 'line-1', name: 'Fried Rice', quantity: 1, lineTotal: 1500, customerPrice: 1500, subStatus: 'REFUNDED', substitution: { state: 'REFUNDED' } },
        { id: 'line-2', name: 'Noodles', quantity: 1, lineTotal: 1900, customerPrice: 1900, subStatus: 'NONE', substitution: null },
      ],
    } as never);
    render(<OrderDetailPage />);
    const receipt = (await screen.findByText('Receipt preview')).closest('aside');
    expect(receipt?.textContent).toContain('1× Fried Rice (removed, not charged)$0');
    expect(receipt?.textContent).not.toContain('1,500');
    expect(screen.queryByRole('heading', { name: /^Swap / })).toBeNull();
  });
});

it('[SUBSTITUTION] the web opts in to the server swap view and posts the answer to the decision route', async () => {
  vi.restoreAllMocks();
  const auth = await import('@/lib/auth');
  const fetchSpy = vi.spyOn(auth, 'apiFetch').mockResolvedValue({ data: {} } as never);
  await orders.getOrder('order-9');
  // [O-4] v2: this page renders the pre-accept removal question too (a v1 client is served a legacy line).
  expect(fetchSpy).toHaveBeenCalledWith('/api/v1/customer/orders/order-9?swapDecisions=v2');
  await orders.decideSubstitution('order-9', 'line-3', false);
  expect(fetchSpy).toHaveBeenLastCalledWith('/api/v1/customer/orders/order-9/items/line-3/substitution', { method: 'POST', body: JSON.stringify({ approve: false }) });
});

// ---------------------------------------------------------------------------
// [UI-SWEEP U14 / U15 / U16] The status pill and the timeline printed codes in
// lower case ("rider en route pickup"); the phone speaks by the order's own
// vertical. At 360 px the no-wrap pill squeezed the title until it overlapped.
// And there was no way to report a problem with the order (the help form
// already takes ?orderId=).
// ---------------------------------------------------------------------------
describe('[U14 / U15 / U16] the order page speaks the phone\'s words and has a support door', () => {
  const live = {
    ...ORDER, status: 'RIDER_EN_ROUTE_PICKUP', orderType: 'FOOD_DELIVERY', paymentMethod: 'CASH', paymentAction: null,
    timeline: [
      { status: 'PENDING', timestamp: '2026-10-19T14:00:00.000Z', note: null },
      { status: 'ACCEPTED', timestamp: '2026-10-19T14:02:00.000Z', note: null },
      { status: 'RIDER_EN_ROUTE_PICKUP', timestamp: '2026-10-19T14:10:00.000Z', note: null },
    ],
  };

  it('the pill and the timeline say the phone\'s words, never a code', async () => {
    vi.spyOn(orders, 'getOrder').mockResolvedValue(live as never);
    render(<OrderDetailPage />);
    const timeline = (await screen.findByRole('heading', { name: 'Order timeline' })).closest('section')!;
    expect(timeline.textContent).toContain('Order accepted');
    expect(timeline.textContent).toContain('Rider on the way to the store');
    expect(screen.getAllByText('Rider on the way to the store').length).toBeGreaterThan(1);
    expect(document.body.textContent?.toLowerCase()).not.toMatch(/rider en route pickup|rider_en_route/);
  });

  it('a parcel uses the parcel\'s words', async () => {
    vi.spyOn(orders, 'getOrder').mockResolvedValue({ ...live, orderType: 'COURIER', timeline: [] } as never);
    render(<OrderDetailPage />);
    expect(await screen.findByText('Rider on the way to collect')).toBeTruthy();
  });

  it('offers "Report a problem" tied to this order', async () => {
    vi.spyOn(orders, 'getOrder').mockResolvedValue(live as never);
    render(<OrderDetailPage />);
    const link = await screen.findByRole('link', { name: 'Report a problem' });
    expect(link.getAttribute('href')).toBe('/account/help?orderId=order-1');
  });

  it('the header wraps the pill under the copy on a narrow screen instead of squeezing the title', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const css = readFileSync(join(process.cwd(), 'src/app/(app)/orders/[id]/tracking.module.css'), 'utf8');
    const rule = (name: string) => css.match(new RegExp(`\\n\\.${name}\\s*\\{([^}]*)\\}`))?.[1] ?? '';
    expect(rule('hero')).toMatch(/flex-wrap:\s*wrap;/);
    expect(rule('heroCopy')).toMatch(/overflow-wrap:\s*anywhere;/);
    expect(rule('heroCopy')).toMatch(/flex:\s*1 1 200px;/);
    expect(rule('statusPill')).not.toMatch(/white-space:\s*nowrap|text-transform:\s*capitalize/);
    expect(rule('statusPill')).toMatch(/max-width:\s*100%;/);
  });
});
