import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { StorefrontExperience, loadCartTaps } from './storefront-experience';
import * as auth from '@/lib/auth';
import * as customer from '@/lib/customer';
import type { StorefrontDetail } from '@/lib/api';

// ---------------------------------------------------------------------------
// [TAP-AUDIT · REVIEW-M #2146 S4-1] The store page's tap code cannot be fetched. A + made before it arrives is counted
// (its number moves, Checkout waits, the dock's Checkout tapped meanwhile is held); when the fetch fails the customer is
// told in plain words, the number goes back to the cart's, Checkout is free again, nothing is sent and the dock does
// not go to checkout. Lifted from REVIEW-M's probe. The REAL store page.
// ---------------------------------------------------------------------------

const nav = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => nav }));
// The tap engine's code cannot be fetched (a dropped connection): held back until the test says, then it fails.
const code = vi.hoisted(() => { let arrive!: () => void; const arrived = new Promise<void>((resolve) => { arrive = resolve; }); return { arrived, arrive }; });
vi.mock('@/lib/cart-taps', async () => { await code.arrived; throw new Error('chunk failed'); });

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

describe('[REVIEW-M #2146 S4-1] the tap code cannot be fetched', () => {
  it('a tap before a failed fetch: counted, then said; the number goes back, Checkout is free, nothing is sent', async () => {
    await open();
    act(() => intersect!([{ target: panel(), isIntersecting: false }]));
    fireEvent.click(plus());
    const checkout = () => within(panel()).getByRole('button', { name: /^Checkout · / }) as HTMLButtonElement;
    expect(count()).toBe('2');
    expect(checkout().disabled).toBe(true);
    fireEvent.click(screen.getByRole('link', { name: /^Checkout · \d+ item/ }));
    await act(async () => { code.arrive(); await loadCartTaps().catch(() => {}); await new Promise((r) => setTimeout(r, 0)); });
    await waitFor(() => expect(checkout().disabled).toBe(false));
    expect(count()).toBe('1');
    expect(document.body.textContent).toContain('Could not update your order.');
    expect(sets).toHaveLength(0);
    expect(adds).toHaveLength(0);
    expect(nav.push, 'the dock does not go to checkout without the tap').not.toHaveBeenCalled();
  });
});
