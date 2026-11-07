import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { StorefrontExperience, loadCartTaps } from './storefront-experience';
import * as auth from '@/lib/auth';
import * as customer from '@/lib/customer';
import type { StorefrontDetail } from '@/lib/api';

// ---------------------------------------------------------------------------
// [TAP-AUDIT 27 Oct · owner: "every single button tap"] The website store page's + and −.
// Before: one change at a time for the whole page — a + disabled every other +, Choose, × and Checkout until the write
// AND a re-read of the cart came back, the number moved only then, and a second + on the same item had to wait.
// Now the number moves at the tap, other items stay free, taps add up (the next request is built from the write's own
// answer), and the dock's Checkout tapped meanwhile goes once the change has landed. The REAL store page; the cart
// writes are stand-ins that answer when the test says, with the whole cart (as the API does).
// ---------------------------------------------------------------------------

const nav = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => nav }));
// The tap engine's code arrives after the page: held back here until the first describe says it has arrived.
const code = vi.hoisted(() => { let arrive!: () => void; const arrived = new Promise<void>((resolve) => { arrive = resolve; }); return { arrived, arrive }; });
vi.mock('@/lib/cart-taps', async (importOriginal) => { await code.arrived; return importOriginal(); });

const store = {
  id: 'test-store', slug: 'test-kitchen', name: 'Test Kitchen', description: null,
  vendorType: 'RESTAURANT', logoUrl: null, coverImageUrl: null, city: 'Georgetown', region: 'Demerara',
  cuisineTypes: [], tags: [], displayRating: null, ratingBucket: 'NEW', ratingCount: 0, topRated: false,
  isCurrentlyOpen: true, acceptingOrders: true, estimatedPrepTime: 20, minOrderAmount: 0, isFeatured: false,
  addressLine1: 'Test street', operatingHours: [],
  categories: [{ id: 'lunch', name: 'Lunch', items: [
    { id: 'roti', name: 'Pumpkin roti', description: null, basePrice: 800, imageUrl: null, unit: null, isPopular: false, fulfillment: 'DELIVERY' },
    { id: 'soup', name: 'Soup', description: null, basePrice: 600, imageUrl: null, unit: null, isPopular: false, fulfillment: 'DELIVERY' },
  ] }],
} as unknown as StorefrontDetail;
const vendor = { ...store, description: undefined, categories: store.categories.map((category) => ({
  ...category, items: category.items.map((item) => ({ ...item, description: undefined, isAvailable: true })),
})) } as unknown as customer.VendorDetail;

const cartWith = (rotiQuantity: number) => ({
  vendor: { id: store.id, name: store.name },
  items: rotiQuantity > 0 ? [{ id: 'line-roti', itemId: 'roti', name: 'Pumpkin roti', quantity: rotiQuantity, customerPrice: 800, fulfillment: 'DELIVERY' }] : [],
  subtotal: 800 * rotiQuantity, totalAmount: 800 * rotiQuantity,
}) as unknown as customer.Cart;

type Out = { args: unknown[]; ok: (_answer: unknown) => void; fail: (_error: unknown) => void };
let sets: Out[];
let adds: Out[];
let server: customer.Cart;
type Report = (_entries: Array<{ target: Element; isIntersecting: boolean }>) => void;
let intersect: Report | undefined;
const held = (list: Out[]) => (...args: unknown[]) => new Promise<never>((ok, fail) => { list.push({ args, ok: ok as (_a: unknown) => void, fail }); });

beforeEach(() => {
  vi.restoreAllMocks();
  nav.push.mockReset();
  sets = []; adds = [];
  server = cartWith(1);
  intersect = undefined;
  vi.stubGlobal('IntersectionObserver', class {
    private readonly report: Report;
    constructor(callback: Report) { this.report = callback; }
    observe = (target: Element) => { if (target.id === 'checkout') intersect = this.report; };
    disconnect = () => {};
  });
  vi.spyOn(window, 'matchMedia').mockReturnValue({ matches: false } as MediaQueryList);
  vi.spyOn(auth, 'sessionProbe').mockResolvedValue({ ok: true } as Awaited<ReturnType<typeof auth.sessionProbe>>);
  vi.spyOn(customer, 'getPublicStorefront').mockResolvedValue(store);
  vi.spyOn(customer, 'getPublicVendor').mockResolvedValue(vendor);
  vi.spyOn(customer, 'getAddresses').mockResolvedValue([]);
  vi.spyOn(customer, 'getCart').mockImplementation(async () => server);
  vi.spyOn(customer, 'updateCartLine').mockImplementation(held(sets) as typeof customer.updateCartLine);
  vi.spyOn(customer, 'addToCart').mockImplementation(held(adds) as typeof customer.addToCart);
});

const panel = () => screen.getByRole('complementary', { name: 'Your order and checkout' });
const count = () => screen.getByLabelText('Pumpkin roti quantity').textContent;
const plus = () => screen.getByRole('button', { name: 'Add another Pumpkin roti' }) as HTMLButtonElement;
async function open() {
  render(<StorefrontExperience store={store} returnPath="/store/test-kitchen" />);
  await waitFor(() => expect(within(panel()).getByText('1× Pumpkin roti')).toBeTruthy());
  await waitFor(() => expect(plus().disabled).toBe(false));
}
/** The server answers a cart write with the whole cart, and the page's next read shows the same. */
const answer = async (out: Out, rotiQuantity: number) => {
  server = cartWith(rotiQuantity);
  await act(async () => { out.ok({ success: true, data: { cart: server, message: 'Cart updated' } }); });
};

describe('[TAP-AUDIT] a tap before the tap code has arrived', () => {
  it('is kept, not dropped: sent (added up) once the code is here', async () => {
    await open();
    act(() => intersect!([{ target: panel(), isIntersecting: false }]));
    fireEvent.click(plus());
    fireEvent.click(plus());
    expect(sets).toHaveLength(0);
    // [REVIEW-M #2146 S3-1] Before the code is here the taps already count: the number moves, Checkout waits and the
    // dock's Checkout tapped meanwhile goes only once they have landed (never to a cart without them).
    expect(count()).toBe('3');
    expect((within(panel()).getByRole('button', { name: /^Checkout · / }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('link', { name: /^Checkout · \d+ item/ }));
    expect(nav.push).not.toHaveBeenCalled();
    await act(async () => { code.arrive(); await loadCartTaps(); });
    await waitFor(() => expect(sets.map((s) => s.args)).toEqual([['line-roti', 2]]));
    expect(count()).toBe('3');
    expect(nav.push).not.toHaveBeenCalled();
    await answer(sets[0]!, 2);
    expect(sets.map((s) => s.args)[1]).toEqual(['line-roti', 3]);
    await answer(sets[1]!, 3);
    await waitFor(() => expect(nav.push).toHaveBeenCalledWith('/checkout'));
  });
});

describe('[TAP-AUDIT] the website store page\'s + and −', () => {
  // As in a browser shortly after the store page is up: the code has arrived (it is fetched as soon as the visitor is
  // signed in), so a tap moves the number in the same frame.
  beforeAll(async () => { code.arrive(); await loadCartTaps(); });

  it('the number moves at the tap, and another item\'s Add stays free and goes at once', async () => {
    await open();
    fireEvent.click(plus());
    expect(count(), 'at the tap').toBe('2');
    expect(sets.map((s) => s.args)).toEqual([['line-roti', 2]]);
    const addSoup = screen.getByRole('button', { name: 'Add Soup' }) as HTMLButtonElement;
    expect(addSoup.disabled, 'another item is not held by this one').toBe(false);
    fireEvent.click(addSoup);
    expect(adds.map((a) => a.args)).toEqual([[{ vendorId: 'test-store', itemId: 'soup', quantity: 1 }]]);
  });

  it('+, + quickly: one request out, the next built from its answer; ends at 3', async () => {
    await open();
    fireEvent.click(plus());
    fireEvent.click(plus());
    expect(count()).toBe('3');
    expect(sets.map((s) => s.args)).toEqual([['line-roti', 2]]);
    await answer(sets[0]!, 2);
    expect(sets.map((s) => s.args)).toEqual([['line-roti', 2], ['line-roti', 3]]);
    await answer(sets[1]!, 3);
    await waitFor(() => expect(within(panel()).getByText('3× Pumpkin roti')).toBeTruthy());
    expect(count()).toBe('3');
  });

  it('Checkout waits while a change is out; the dock tapped meanwhile goes once it has landed', async () => {
    await open();
    act(() => intersect!([{ target: panel(), isIntersecting: false }]));
    fireEvent.click(plus());
    expect((within(panel()).getByRole('button', { name: /^Checkout · / }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('link', { name: /^Checkout · \d+ item/ }));
    expect(nav.push).not.toHaveBeenCalled();
    await answer(sets[0]!, 2);
    await waitFor(() => expect(nav.push).toHaveBeenCalledWith('/checkout'));
  });

  it('a refused + shows the server\'s number again and says why', async () => {
    await open();
    fireEvent.click(plus());
    expect(count()).toBe('2');
    await act(async () => { sets[0]!.fail(new Error('Only 1 left today.')); });
    await waitFor(() => expect(count()).toBe('1'));
    expect((await screen.findAllByText('Only 1 left today.')).length).toBeGreaterThan(0);
    expect(nav.push).not.toHaveBeenCalled();
  });
});
