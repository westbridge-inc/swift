import { act, render, screen, waitFor } from '@testing-library/react';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { StorefrontExperience, loadItemSheet } from './storefront-experience';
import { CustomerSessionProvider, type CustomerSession } from '@/components/customer-session';
import * as customer from '@/lib/customer';
import * as auth from '@/lib/auth';
import type { StorefrontDetail } from '@/lib/api';

// ---------------------------------------------------------------------------
// [Row 109] No signed-out flash on the store page.
//
// The page started signed-OUT and switched only when the session answered, so
// a signed-in customer first saw the guest basket ("Sign in with your phone at
// Place order…", "No account needed") and could add to the guest basket. While
// the session is being checked the basket is now neutral: it says it is
// checking, offers no guest copy, and takes no adds; then it becomes the
// signed-in or the guest basket. Synthetic store and items only.
// ---------------------------------------------------------------------------

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));

const soup = { id: 'soup', name: 'Pumpkin soup', description: 'Made by this store', basePrice: 800, imageUrl: null, unit: null,
  isPopular: false, fulfillment: 'DELIVERY', isAvailable: true, customerPrice: 800, optionGroups: [] as customer.OptionGroup[] };
const store = {
  id: 'menu-store', slug: 'sample-kitchen', name: 'Sample Kitchen', description: null, vendorType: 'RESTAURANT',
  logoUrl: null, coverImageUrl: null, city: 'Georgetown', region: 'Demerara', cuisineTypes: [], tags: [],
  displayRating: null, ratingBucket: 'NEW', ratingCount: 0, topRated: false, isCurrentlyOpen: true, acceptingOrders: true,
  estimatedPrepTime: 20, minOrderAmount: 0, isFeatured: false, addressLine1: 'Fixture street', operatingHours: [],
  categories: [{ id: 'mains', name: 'Mains', items: [soup] }],
} as unknown as StorefrontDetail;
const emptyCart = { items: [], vendor: null, subtotal: 0, subtotalCustomer: 0, totalAmount: 0, meetsMinimum: true } as unknown as customer.Cart;
const GUEST_COPY = /Sign in with your phone at Place order|No account needed/;
const CHECKING = 'Checking your basket…';

function shell(status: CustomerSession['status']): CustomerSession {
  return { status, scope: status === 'signed-in' ? 'c1' : 'guest', epoch: 0, ensureSignedIn: async () => status === 'signed-in', nearPoint: null, setNearPoint: () => undefined };
}
const page = <StorefrontExperience store={store} returnPath="/store/sample-kitchen" />;

beforeAll(() => loadItemSheet());

beforeEach(() => {
  sessionStorage.clear(); localStorage.clear();
  vi.restoreAllMocks();
  vi.spyOn(customer, 'getPublicStorefront').mockResolvedValue(store);
  vi.spyOn(customer, 'getPublicVendor').mockResolvedValue({ ...store, description: undefined } as unknown as customer.VendorDetail);
  vi.spyOn(customer, 'getCart').mockResolvedValue(emptyCart);
  vi.spyOn(customer, 'addToCart').mockResolvedValue(emptyCart);
});

describe('[row 109] the store page while the session is being checked', () => {
  it('on its own page: neutral while the probe is out, never the guest basket, and no add lands anywhere', async () => {
    let answer: (_v: { ok: boolean }) => void = () => undefined;
    vi.spyOn(auth, 'sessionProbe').mockImplementation(() => new Promise((resolve) => { answer = resolve as typeof answer; }) as ReturnType<typeof auth.sessionProbe>);
    render(page);
    expect(await screen.findByText(CHECKING)).toBeTruthy();
    expect(screen.queryByText(GUEST_COPY)).toBeNull();
    const add = await screen.findByRole('button', { name: 'Add Pumpkin soup' });
    expect((add as HTMLButtonElement).disabled).toBe(true);
    await act(async () => { answer({ ok: true }); });
    await waitFor(() => expect(screen.queryByText(CHECKING)).toBeNull());
    expect(screen.queryByText(GUEST_COPY)).toBeNull();
    await waitFor(() => expect((screen.getByRole('button', { name: 'Add Pumpkin soup' }) as HTMLButtonElement).disabled).toBe(false));
    expect(customer.getCart).toHaveBeenCalled();
  });

  it('inside the app frame: neutral while the shell says "checking", then the guest basket once it says guest', async () => {
    vi.spyOn(auth, 'sessionProbe').mockResolvedValue({ ok: false } as Awaited<ReturnType<typeof auth.sessionProbe>>);
    const { rerender } = render(<CustomerSessionProvider value={shell('checking')}>{page}</CustomerSessionProvider>);
    expect(await screen.findByText(CHECKING)).toBeTruthy();
    expect(screen.queryByText(GUEST_COPY)).toBeNull();
    rerender(<CustomerSessionProvider value={shell('guest')}>{page}</CustomerSessionProvider>);
    expect(await screen.findByText(/Sign in with your phone at Place order/)).toBeTruthy();
    expect(screen.queryByText(CHECKING)).toBeNull();
    expect(customer.getCart).not.toHaveBeenCalled();
  });
});
