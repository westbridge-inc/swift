import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockApi, type ApiRequest, type ApiReply } from '@/test/test-utils';
import AppLayout from '@/app/(app)/layout';
import CheckoutPage from '@/app/(app)/checkout/page';
import { StorefrontPage } from '@/components/storefront/storefront-page';
import { storefrontFixture } from '@/test/storefront-fixture';
import { loadItemSheet } from '@/components/storefront/storefront-experience';
import { addAppointmentDays, appointmentDayKey } from '@/lib/appointmentTime';

// ---------------------------------------------------------------------------
// [BOOK-S6b · owner C3 28 Oct 2026] Web customers book a Services store's
// appointment: Book on the listing -> a day and a free time (the server's own
// slots) -> the one checkout books it, one booking per order, with an
// Idempotency-Key. The server's refusals are shown in its words, and the
// success follows the checkout ANSWER (ACCEPTED = confirmed, else requested),
// with INSTANT_BOOKING on or off. Synthetic store, listing and people only.
// ---------------------------------------------------------------------------

const state = vi.hoisted(() => ({ pathname: '/', params: {} as Record<string, string>, push: vi.fn(), back: vi.fn(), replace: vi.fn() }));
vi.mock('next/navigation', () => ({
  usePathname: () => state.pathname,
  useParams: () => state.params,
  useRouter: () => ({ push: state.push, back: state.back, replace: state.replace, refresh: vi.fn() }),
}));

const TOMORROW = addAppointmentDays(appointmentDayKey(new Date()), 1);
// 10:00 and 10:30 in Guyana (UTC-4, no daylight saving) tomorrow.
const SLOT = `${TOMORROW}T14:00:00.000Z`;
const SLOT_2 = `${TOMORROW}T14:30:00.000Z`;

const HAIRCUT = { id: 'i9', name: 'Fixture trim', description: 'Thirty minutes', basePrice: 2500, customerPrice: 2500, imageUrl: null, isAvailable: true, fulfillment: 'APPOINTMENT', optionGroups: [] };
const GOODS = { id: 'i1', name: 'Fixture comb', description: 'Fixture', basePrice: 900, customerPrice: 900, imageUrl: null, isAvailable: true, fulfillment: 'DELIVERY', optionGroups: [] };
const STORE = {
  id: 'v1', name: 'Fixture Studio', slug: 'fixture-studio', vendorType: 'SERVICE', cuisineTypes: [], coverImageUrl: null,
  displayRating: null, ratingBucket: 'NEW', ratingCount: 0, topRated: false, estimatedPrepTime: 20,
  isCurrentlyOpen: true, acceptingOrders: true, categories: [{ id: 'c1', name: 'Services', items: [HAIRCUT, GOODS] }],
};
const caps = (mmg: boolean) => ({ scope: mmg ? 'mmg' : 'cash', cash: { available: true, fundsFlow: 'DIRECT_AT_HANDOVER' }, mmg: { available: mmg, provider: 'MMG', fundsFlow: 'DIRECT_TO_VENDOR', unavailableReason: mmg ? null : 'VENDOR_NOT_CONFIGURED' } });
const bookingLine = { id: 'l9', itemId: 'i9', name: 'Fixture trim', quantity: 1, customerPrice: 2500, lineTotal: 2500, fulfillment: 'APPOINTMENT', isAvailable: true, vendorId: 'v1' };
const goodsLine = { id: 'l1', itemId: 'i1', name: 'Fixture comb', quantity: 1, customerPrice: 900, lineTotal: 900, fulfillment: 'DELIVERY', isAvailable: true, vendorId: 'v1' };
const vendor = { id: 'v1', name: 'Fixture Studio', slug: 'fixture-studio', deliveryRadius: 8, distanceKm: 1, isCurrentlyOpen: true, acceptingOrders: true };
const bookingCart = (overrides: Record<string, unknown> = {}) => ({
  items: [bookingLine], subtotalCustomer: 2500, deliveryFee: 0, discount: 0, tipAmount: 0, totalAmount: 2500,
  deliveryAddress: null, vendor,
  vendors: [{ vendorId: 'v1', name: 'Fixture Studio', fulfillment: 'APPOINTMENT', subtotal: 2500, deliveryFee: 0, totalAmount: 2500, meetsMinimum: true }],
  meetsMinimum: true, minimumOrderAmount: 0, paymentCapabilities: caps(mmg), ...overrides,
});

let mmg = false;
let cart: () => unknown = () => bookingCart();
let slotsAnswer: (_date: string) => Record<string, unknown> = () => ({});
let checkoutReply: ApiReply | null = null;
let signedIn = true;
let fetchMock: ReturnType<typeof mockApi>;
const ok = (data: unknown) => ({ body: { success: true, data } });
const refuse = (status: number, code: string, message: string) => ({ status, body: { success: false, error: { code, message } } });
const calls = (method: string, pathname: string) => fetchMock.mock.calls.filter(([url, init]) =>
  new URL(String(url)).pathname === pathname && (init?.method ?? 'GET').toUpperCase() === method) as Array<[unknown, RequestInit]>;
const bodyOf = (call: [unknown, RequestInit] | undefined) => JSON.parse(String(call![1].body));
/** The free times the server offers: tomorrow only, every weekday has hours. */
const slots = (date: string, extra: Record<string, unknown> = {}) => ({
  date, durationMinutes: 30, slots: date === TOMORROW ? [SLOT, SLOT_2] : [], bookableWeekdays: [0, 1, 2, 3, 4, 5, 6],
  serviceMode: 'AT_BUSINESS', serviceRadiusKm: null, ...extra,
});
const holdTime = (appointment: Record<string, unknown>) =>
  sessionStorage.setItem('swift_web_appointment:c1', JSON.stringify({ itemId: 'i9', slotStart: SLOT, mode: 'AT_BUSINESS', serviceMode: 'AT_BUSINESS', ...appointment }));

beforeAll(() => loadItemSheet());

beforeEach(async () => {
  (await import('@/lib/auth')).clearSession();
  sessionStorage.clear(); localStorage.clear();
  window.history.replaceState({}, '', '/');
  state.push.mockReset(); state.replace.mockReset();
  mmg = false;
  signedIn = true;
  cart = () => bookingCart();
  slotsAnswer = (date) => slots(date);
  checkoutReply = null;
  fetchMock = mockApi(({ url, method }: ApiRequest) => {
    if (url.pathname === '/api/v1/auth/me') return signedIn ? ok({ user: { id: 'c1' } }) : { status: 401, body: { success: false } };
    if (url.pathname === '/api/v1/auth/refresh') return { status: 401, body: { success: false } };
    if (url.pathname === '/api/v1/market/depth') return ok({ visible: false, items: 0, vendors: 0 });
    if (url.pathname === '/api/v1/customer/vendors/v1') return ok(STORE);
    if (url.pathname === '/api/v1/public/storefronts/fixture-studio') return ok(storefrontFixture({ ...STORE, addressLine1: '4 Fixture Lane', city: 'Georgetown' }));
    if (url.pathname === '/api/v1/customer/cart' && method === 'GET') return ok(cart());
    if (url.pathname === '/api/v1/customer/cart' && method === 'DELETE') { cart = () => ({ items: [] }); return ok({}); }
    if (url.pathname === '/api/v1/customer/cart/items' && method === 'POST') { cart = () => bookingCart(); return { status: 201, body: { success: true, data: {} } }; }
    if (url.pathname === '/api/v1/customer/items/i9/slots') return ok(slotsAnswer(url.searchParams.get('date') ?? ''));
    if (url.pathname === '/api/v1/customer/addresses') return ok([{ id: 'a1', label: 'Home', addressLine1: 'Fixture street', city: 'Georgetown', isDefault: true }]);
    if (url.pathname === '/api/v1/customer/cart/address' && method === 'PUT') { cart = () => bookingCart({ deliveryAddress: { id: 'a1', label: 'Home', addressLine1: 'Fixture street', city: 'Georgetown' } }); return ok({ cart: cart() }); }
    if (url.pathname === '/api/v1/customer/checkout' && method === 'POST') {
      return checkoutReply ?? ok({ order: { id: 'o9' }, orders: [{ id: 'o9', status: 'PENDING', fulfillment: 'APPOINTMENT' }], paymentAction: null, message: 'Order placed! Fixture Studio will confirm shortly.' });
    }
    return { status: 404, body: { success: false, error: { message: `unmocked ${method} ${url.pathname}` } } };
  });
});

function at(pathname: string, page: React.ReactNode) {
  state.pathname = pathname;
  window.history.replaceState({}, '', pathname);
  return render(<AppLayout>{page}</AppLayout>);
}
const storePage = async () => StorefrontPage({ params: Promise.resolve({ slug: 'fixture-studio' }), searchParams: Promise.resolve({}) });

describe('[BOOK-S6b] the one checkout books an appointment', () => {
  it('a bookings-only cart is a booking: the time picked, no delivery choice, no rider tip, pay at your appointment', async () => {
    holdTime({});
    at('/checkout', <CheckoutPage />);
    const panel = await screen.findByRole('region', { name: 'Your booking' });
    expect(panel.textContent).toMatch(/10:00\sAM/);
    expect(screen.queryByRole('radiogroup', { name: 'How would you like your order?' })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Tip your rider' })).toBeNull();
    expect(screen.queryByLabelText('Saved delivery address')).toBeNull();
    expect(screen.getByText('Pay at your appointment')).toBeTruthy();
    // Switch off (no instantConfirmation on the slots answer): a request, never "Book now".
    expect(await screen.findByRole('button', { name: 'Request booking · $2,500' })).toBeTruthy();
    expect(screen.getByText('Your time is confirmed when the business accepts the booking.')).toBeTruthy();
    expect(screen.queryByText(/appointment checkout is not available/i)).toBeNull();
  });

  it('sends the booking with its time, no tip and an Idempotency-Key, once; the success follows the answer: requested', async () => {
    holdTime({});
    at('/checkout', <CheckoutPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Request booking · $2,500' }));
    expect(await screen.findByRole('heading', { name: 'Booking requested' })).toBeTruthy();
    expect(screen.getByText('Your time is confirmed when the business accepts — pay cash directly to them when the service is done.')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'View booking' }).getAttribute('href')).toBe('/orders/o9');
    const checkouts = calls('POST', '/api/v1/customer/checkout');
    expect(checkouts).toHaveLength(1);
    expect(bodyOf(checkouts[0])).toEqual({
      paymentMethod: 'CASH', tipAmount: 0, appointments: [{ itemId: 'i9', slotStart: SLOT, mode: 'AT_BUSINESS' }],
      expectedTotal: 2500, expectedLines: [{ lineId: 'l9', unitPrice: 2500 }],
    });
    expect((checkouts[0]![1].headers as Record<string, string>)['Idempotency-Key']).toMatch(/.{8,}/);
    // At the business: no address is priced or sent.
    expect(calls('PUT', '/api/v1/customer/cart/address')).toHaveLength(0);
    // The held time is spent.
    expect(sessionStorage.getItem('swift_web_appointment:c1')).toBeNull();
    expect(state.push).not.toHaveBeenCalled();
  });

  it('switch on, an instant listing paid cash: "Book now", and "Booking confirmed" only because the answer is ACCEPTED', async () => {
    holdTime({ instant: true });
    checkoutReply = ok({ order: { id: 'o9' }, orders: [{ id: 'o9', status: 'ACCEPTED', fulfillment: 'APPOINTMENT' }], paymentAction: null, message: 'Booking confirmed with Fixture Studio.' });
    at('/checkout', <CheckoutPage />);
    expect(await screen.findByText('Your time is confirmed as soon as you book.')).toBeTruthy();
    fireEvent.click(await screen.findByRole('button', { name: 'Book now · $2,500' }));
    expect(await screen.findByRole('heading', { name: 'Booking confirmed' })).toBeTruthy();
    expect(screen.getByText('Your time is confirmed — pay cash directly to the business when the service is done.')).toBeTruthy();
  });

  it('never says "confirmed" on the picker’s word alone: an instant listing answered PENDING is a request', async () => {
    holdTime({ instant: true });
    at('/checkout', <CheckoutPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Book now · $2,500' }));
    expect(await screen.findByRole('heading', { name: 'Booking requested' })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Booking confirmed' })).toBeNull();
  });

  it('paying by MMG is always "Request booking": the business confirms an MMG booking first', async () => {
    mmg = true;
    holdTime({ instant: true });
    at('/checkout', <CheckoutPage />);
    await screen.findByRole('button', { name: 'Book now · $2,500' });
    fireEvent.click(screen.getByRole('radio', { name: /Pay with MMG/ }));
    expect(await screen.findByRole('button', { name: 'Request booking · $2,500' })).toBeTruthy();
    expect(screen.getByText('Paying by MMG: the business confirms the booking first.')).toBeTruthy();
  });

  it('no time held: the free times are the server’s, and the one picked is the one sent', async () => {
    at('/checkout', <CheckoutPage />);
    expect(await screen.findByRole('button', { name: 'Pick a time to book' })).toBeTruthy();
    fireEvent.click(await screen.findByRole('button', { name: 'Tomorrow' }));
    fireEvent.click(await screen.findByRole('button', { name: /10:30\sAM/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Request booking · $2,500' }));
    await screen.findByRole('heading', { name: 'Booking requested' });
    expect(bodyOf(calls('POST', '/api/v1/customer/checkout')[0]).appointments).toEqual([{ itemId: 'i9', slotStart: SLOT_2, mode: 'AT_BUSINESS' }]);
    const reads = calls('GET', '/api/v1/customer/items/i9/slots').map(([url]) => new URL(String(url)).searchParams.get('date'));
    expect(reads).toContain(TOMORROW);
  });

  it('a time someone else just booked: the server’s words, the time let go, the free times open again', async () => {
    holdTime({});
    checkoutReply = refuse(409, 'SLOT_TAKEN', 'That slot was just taken — pick another time');
    at('/checkout', <CheckoutPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Request booking · $2,500' }));
    expect(await screen.findByText('That slot was just taken — pick another time')).toBeTruthy();
    expect(await screen.findByRole('button', { name: 'Pick a time to book' })).toBeTruthy();
    expect(await screen.findByRole('button', { name: 'Tomorrow' })).toBeTruthy();
    expect(sessionStorage.getItem('swift_web_appointment:c1')).toBeNull();
    expect(screen.queryByRole('heading', { name: /Booking (requested|confirmed)/ })).toBeNull();
  });

  it.each([
    ['BOOKING_LIMIT_REACHED', 'You already have 3 upcoming bookings waiting. Cancel one or wait for it before booking another.'],
    ['HOME_VISIT_UNAVAILABLE', 'Fixture Studio can’t come to your home yet. You can book this service at their place instead.'],
    ['OUT_OF_SERVICE_AREA', 'Fixture Studio travels within 5 km. You are 9.2 km away.'],
  ])('%s is shown in the server’s own words, and nothing is placed', async (code, message) => {
    holdTime({});
    checkoutReply = refuse(409, code, message);
    at('/checkout', <CheckoutPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Request booking · $2,500' }));
    expect(await screen.findByText(message)).toBeTruthy();
    expect(screen.queryByRole('heading', { name: /Booking (requested|confirmed)/ })).toBeNull();
  });

  it('a home visit asks where they come to, and prices that address before booking', async () => {
    holdTime({ mode: 'MOBILE', serviceMode: 'MOBILE' });
    at('/checkout', <CheckoutPage />);
    expect(await screen.findByRole('heading', { name: 'They come to you at' })).toBeTruthy();
    expect(await screen.findByLabelText('Saved delivery address')).toBeTruthy();
    // The address is checked by the server first; nothing is booked by that tap.
    fireEvent.click(await screen.findByRole('button', { name: 'Check this address' }));
    await waitFor(() => expect(calls('PUT', '/api/v1/customer/cart/address')).toHaveLength(1));
    expect(calls('POST', '/api/v1/customer/checkout')).toHaveLength(0);
    expect(await screen.findByText('Swift checked this address: the booking comes to $2,500. Review it, then book.')).toBeTruthy();
    fireEvent.click(await screen.findByRole('button', { name: 'Request booking · $2,500' }));
    await screen.findByRole('heading', { name: 'Booking requested' });
    expect(bodyOf(calls('PUT', '/api/v1/customer/cart/address')[0])).toEqual({ addressId: 'a1' });
    expect(bodyOf(calls('POST', '/api/v1/customer/checkout')[0]).appointments).toEqual([{ itemId: 'i9', slotStart: SLOT, mode: 'MOBILE' }]);
  });

  it('one booking per order: a booking mixed with goods, or two bookings, is refused before anything is sent', async () => {
    holdTime({});
    cart = () => bookingCart({ items: [bookingLine, goodsLine] });
    const { unmount } = at('/checkout', <CheckoutPage />);
    expect(await screen.findByText('A booking is placed on its own. Remove the booking to order the other items, or remove them to book it.')).toBeTruthy();
    unmount();
    cart = () => bookingCart({ items: [bookingLine, { ...bookingLine, id: 'l10', itemId: 'i10' }] });
    at('/checkout', <CheckoutPage />);
    expect(await screen.findByText('Book one appointment at a time on the web. Remove the other bookings to continue.')).toBeTruthy();
    expect(calls('POST', '/api/v1/customer/checkout')).toHaveLength(0);
  });
});

describe('[BOOK-S6b] Book on the store page', () => {
  it('a bookable listing has Book (not "Appointment checkout unavailable"); its sheet shows the server’s free times', async () => {
    cart = () => ({ items: [] });
    at('/store/fixture-studio', await storePage());
    const book = await screen.findByRole('button', { name: 'Book Fixture trim' });
    await waitFor(() => expect((book as HTMLButtonElement).disabled).toBe(false));
    expect(screen.queryByText('Appointment checkout unavailable')).toBeNull();
    fireEvent.click(book);
    const sheet = await screen.findByRole('dialog', { name: 'Fixture trim' });
    expect(within(sheet).getByText('At Fixture Studio — 4 Fixture Lane, Georgetown')).toBeTruthy();
    // Switch off: no "instant" word anywhere.
    await within(sheet).findByText('No times left this day — try another.');
    expect(within(sheet).queryByText('Instant confirmation')).toBeNull();
    fireEvent.click(within(sheet).getByRole('button', { name: 'Tomorrow' }));
    fireEvent.click(await within(sheet).findByRole('button', { name: /10:00\sAM/ }));
    fireEvent.click(within(sheet).getByRole('button', { name: /^Book 10:00\sAM · \$2,500$/ }));
    await waitFor(() => expect(state.push).toHaveBeenCalledWith('/checkout'));
    expect(bodyOf(calls('POST', '/api/v1/customer/cart/items')[0])).toEqual({ vendorId: 'v1', itemId: 'i9', quantity: 1 });
    expect(JSON.parse(sessionStorage.getItem('swift_web_appointment:c1')!)).toEqual({ itemId: 'i9', slotStart: SLOT, mode: 'AT_BUSINESS', serviceMode: 'AT_BUSINESS' });
  });

  it('the "Instant confirmation" badge shows only on the server’s instantConfirmation, and the held time remembers it', async () => {
    cart = () => ({ items: [] });
    slotsAnswer = (date) => slots(date, { instantConfirmation: true });
    at('/store/fixture-studio', await storePage());
    const book = await screen.findByRole('button', { name: 'Book Fixture trim' });
    await waitFor(() => expect((book as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(book);
    const sheet = await screen.findByRole('dialog', { name: 'Fixture trim' });
    expect(await within(sheet).findByText('Instant confirmation')).toBeTruthy();
    expect(within(sheet).getByText('Pay at your appointment and your time is confirmed as soon as you book.')).toBeTruthy();
    fireEvent.click(within(sheet).getByRole('button', { name: 'Tomorrow' }));
    fireEvent.click(await within(sheet).findByRole('button', { name: /10:00\sAM/ }));
    fireEvent.click(within(sheet).getByRole('button', { name: /^Book 10:00\sAM/ }));
    await waitFor(() => expect(state.push).toHaveBeenCalledWith('/checkout'));
    expect(JSON.parse(sessionStorage.getItem('swift_web_appointment:c1')!).instant).toBe(true);
  });

  it('a business that offers both lets the customer choose, and the choice is what checkout sends', async () => {
    cart = () => ({ items: [] });
    slotsAnswer = (date) => slots(date, { serviceMode: 'BOTH', serviceRadiusKm: 5 });
    at('/store/fixture-studio', await storePage());
    const book = await screen.findByRole('button', { name: 'Book Fixture trim' });
    await waitFor(() => expect((book as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(book);
    const sheet = await screen.findByRole('dialog', { name: 'Fixture trim' });
    fireEvent.click(await within(sheet).findByRole('button', { name: 'They come to you' }));
    expect(within(sheet).getByText('They travel to your saved address (within 5 km).')).toBeTruthy();
    fireEvent.click(within(sheet).getByRole('button', { name: 'Tomorrow' }));
    fireEvent.click(await within(sheet).findByRole('button', { name: /10:00\sAM/ }));
    fireEvent.click(within(sheet).getByRole('button', { name: /^Book 10:00\sAM/ }));
    await waitFor(() => expect(state.push).toHaveBeenCalledWith('/checkout'));
    expect(JSON.parse(sessionStorage.getItem('swift_web_appointment:c1')!)).toMatchObject({ mode: 'MOBILE', serviceMode: 'BOTH' });
  });

  it('a cart with other items is emptied only when the customer says so', async () => {
    cart = () => bookingCart({ items: [goodsLine] });
    const confirm = vi.fn().mockReturnValue(false);
    vi.stubGlobal('confirm', confirm);
    at('/store/fixture-studio', await storePage());
    const book = await screen.findByRole('button', { name: 'Book Fixture trim' });
    await waitFor(() => expect((book as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(book);
    const sheet = await screen.findByRole('dialog', { name: 'Fixture trim' });
    fireEvent.click(within(sheet).getByRole('button', { name: 'Tomorrow' }));
    fireEvent.click(await within(sheet).findByRole('button', { name: /10:00\sAM/ }));
    fireEvent.click(within(sheet).getByRole('button', { name: /^Book 10:00\sAM/ }));
    expect(confirm).toHaveBeenCalledWith('A booking is placed on its own. Empty your cart and book this instead?');
    expect(calls('DELETE', '/api/v1/customer/cart')).toHaveLength(0);
    expect(calls('POST', '/api/v1/customer/cart/items')).toHaveLength(0);
    confirm.mockReturnValue(true);
    fireEvent.click(within(sheet).getByRole('button', { name: /^Book 10:00\sAM/ }));
    await waitFor(() => expect(state.push).toHaveBeenCalledWith('/checkout'));
    expect(calls('DELETE', '/api/v1/customer/cart')).toHaveLength(1);
    expect(calls('POST', '/api/v1/customer/cart/items')).toHaveLength(1);
  });

  it('a guest is sent to sign in first (the free times are read signed in), and nothing is added', async () => {
    signedIn = false;
    at('/store/fixture-studio', await storePage());
    const book = await screen.findByRole('button', { name: 'Book Fixture trim' });
    await waitFor(() => expect((book as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(book);
    await waitFor(() => expect(state.push).toHaveBeenCalledWith(`/login?next=${encodeURIComponent('/store/fixture-studio')}`));
    expect(calls('GET', '/api/v1/customer/items/i9/slots')).toHaveLength(0);
    expect(calls('POST', '/api/v1/customer/cart/items')).toHaveLength(0);
  });
});
