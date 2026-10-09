import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import * as api from '@/lib/customer';
import * as auth from '@/lib/auth';
import { CustomerHome } from './customer-home';
import SearchPage from '@/app/(app)/order/search/page';
import { StoreSkeleton } from './storefront/store-skeleton';
import { StorefrontExperience } from './storefront/storefront-experience';
import storeStyles from './storefront/storefront.module.css';
import { MarketScreen as MarketPage } from '@/app/(app)/market/market-screen';
import OrdersPage from '@/app/(app)/orders/page';
import CartPage from '@/app/(app)/cart/page';
import OrderPage from '@/app/(app)/orders/[id]/page';

const person = vi.hoisted(() => ({ scope: 'guest', epoch: 0 }));

vi.mock('next/navigation', () => ({
  useParams: () => ({ id: 'v1' }), useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: vi.fn() }),
}));
vi.mock('./customer-session', () => ({ useOptionalCustomerSession: () => null, useCustomerSession: () => ({
  status: 'guest', ...person, nearPoint: null, setNearPoint: vi.fn(), ensureSignedIn: vi.fn(),
}) }));

function pending<T>() {
  let resolve!: (_value: T) => void;
  return { promise: new Promise<T>((done) => { resolve = done; }), finish: async (value: T) => { await act(async () => { resolve(value); }); } };
}
function mount(page: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(page, { wrapper: ({ children }) => <QueryClientProvider client={client}>{children}</QueryClientProvider> });
}
const vendor = { id: 'v1', name: 'Local store', isCurrentlyOpen: true, displayRating: null, estimatedPrepTime: 20, categories: [{ id: 'c1', name: 'Lunch', items: [{ id: 'i1', name: 'Lunch box', basePrice: 500, isAvailable: true }] }] } as api.VendorDetail;

describe('loading surfaces become content in the reserved layout', () => {
  it('Home reserves both horizontal rails and a grid of store cards', async () => {
    const response = pending<api.HomeFeed>();
    // [W2] A guest's Home is the public feed, read with no session.
    vi.spyOn(api, 'getPublicHome').mockReturnValue(response.promise);
    const view = mount(<CustomerHome market="Georgetown" />);
    const region = screen.getByLabelText('Loading home feed');
    expect(region.querySelectorAll('ul')).toHaveLength(2);
    const cardShape = region.querySelector('[data-store-part="copy"]')!.className;
    await response.finish({ activeOrder: null, featured: [], popularItems: [], orderAgain: [vendor], nearby: [], openVendors: [vendor], closedVendors: [], categories: [] } as api.HomeFeed);
    expect(await screen.findByRole('region', { name: 'Order again' })).toBeTruthy();
    expect(view.container.querySelector('[data-store-part="copy"]')!.className).toBe(cardShape);
    expect(screen.queryByLabelText('Loading home feed')).toBeNull();
  });

  it('the store keeps its cover, heading, chips and menu card sizing as the page arrives', () => {
    // [W6] The store's placeholder is drawn with the page's own classes, so
    // the store lands in the space its placeholder held.
    const shape = [storeStyles.cover, storeStyles.titleRow, storeStyles.facts, storeStyles.categoryNav, storeStyles.layout, storeStyles.rows, storeStyles.menuRow, storeStyles.itemCopy, storeStyles.itemFoot, storeStyles.itemImage];
    const loading = mount(<StoreSkeleton />);
    const region = screen.getByLabelText('Loading this store');
    for (const part of shape) expect(region.querySelector(`.${part}`), part).toBeTruthy();
    loading.unmount();
    const store = { ...vendor, slug: 'local-store', vendorType: 'RESTAURANT', logoUrl: null, coverImageUrl: null, city: 'Georgetown', region: 'Demerara',
      cuisineTypes: [], tags: [], ratingBucket: 'NEW', ratingCount: 0, topRated: false, acceptingOrders: true, minOrderAmount: 0, isFeatured: false,
      addressLine1: 'Market Road', operatingHours: [], description: null,
      categories: [{ id: 'c1', name: 'Lunch', items: [{ id: 'i1', name: 'Lunch box', description: null, basePrice: 500, imageUrl: null, unit: null, isPopular: false, fulfillment: 'DELIVERY' }] }],
    } as unknown as Parameters<typeof StorefrontExperience>[0]['store'];
    vi.spyOn(api, 'getPublicStorefront').mockReturnValue(new Promise(() => undefined));
    vi.spyOn(api, 'getPublicVendor').mockReturnValue(new Promise(() => undefined));
    vi.spyOn(auth, 'sessionProbe').mockResolvedValue({ ok: false });
    const page = mount(<StorefrontExperience store={store} returnPath="/store/local-store" />);
    expect(screen.getByRole('heading', { name: 'Lunch box' })).toBeTruthy();
    for (const part of shape) expect(page.container.querySelector(`.${part}`), part).toBeTruthy();
  });

  it('Market reserves its title, category strip and item image heights', async () => {
    vi.spyOn(api, 'getMarketDepth').mockResolvedValue({ visible: true, items: 400, vendors: 9 });
    vi.spyOn(api, 'getMarketCategories').mockResolvedValue([]);
    const response = pending<Awaited<ReturnType<typeof api.getMarketItems>>>();
    vi.spyOn(api, 'getMarketItems').mockReturnValue(response.promise);
    const view = mount(<MarketPage />);
    const region = screen.getByLabelText('Loading market items');
    // [WEB-REDESIGN] Square item photos, as in the design.
    expect(region.querySelector('.aspect-square')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Market' })).toBeTruthy();
    await response.finish({ items: [{ id: 'i1', name: 'Hammer', basePrice: 500, vendorId: 'v1', vendorName: 'Local store', imageUrl: null, isNew: false, categoryName: 'Tools' }], nextCursor: null });
    expect(await screen.findByRole('link', { name: /Hammer/ })).toBeTruthy();
    expect(view.container.querySelector('.aspect-square')).toBeTruthy();
    expect(screen.getByRole('navigation', { name: 'Market categories' }).className).toContain('h-[60px]');
  });

  it('orders use the same row size before and after the list arrives', async () => {
    const response = pending<Awaited<ReturnType<typeof api.getOrders>>>();
    vi.spyOn(api, 'getOrders').mockReturnValue(response.promise);
    const view = mount(<OrdersPage />);
    expect(screen.getByLabelText('Loading your orders').querySelector('.swift-order-row')).toBeTruthy();
    await response.finish([{ id: 'o1', vendorName: 'Local store', status: 'PENDING', totalAmount: 500 }]);
    // The row (its name first); the in-progress band's Track link names it too.
    expect(await screen.findByRole('link', { name: /^Local store/ })).toBeTruthy();
    expect(view.container.querySelector('.swift-order-row')).toBeTruthy();
  });

  it('the cart retains its actual two-column CSS layout when data arrives', async () => {
    const response = pending<api.Cart>();
    vi.spyOn(api, 'getCart').mockReturnValue(response.promise);
    vi.spyOn(api, 'getAddresses').mockResolvedValue([]);
    vi.spyOn(api, 'getPublicVendor').mockResolvedValue(vendor);
    const view = mount(<CartPage />);
    const layout = screen.getByLabelText('Loading your cart').className;
    expect(screen.getByLabelText('Loading your cart').children).toHaveLength(2);
    await response.finish({ items: [{ id: 'l1', itemId: 'i1', name: 'Lunch box', quantity: 1, customerPrice: 500, isAvailable: true }], vendor: { id: 'v1', name: 'Local store' }, subtotalCustomer: 500 } as api.Cart);
    expect(await screen.findByText('Lunch box')).toBeTruthy();
    expect(view.container.firstElementChild?.className).toBe(layout);
  });

  it('tracking retains its page, hero and progress CSS layout when the order arrives', async () => {
    const response = pending<Awaited<ReturnType<typeof api.getOrder>>>();
    vi.spyOn(api, 'getOrder').mockReturnValue(response.promise);
    const view = mount(<OrderPage />);
    const region = screen.getByLabelText('Loading order tracking');
    const shape = [region.className, region.children[0]!.className, region.children[1]!.className];
    await response.finish({ id: 'o1', orderNumber: 'SW-1', status: 'ACCEPTED', paymentMethod: 'CASH', paymentStatus: 'PENDING', totalAmount: 500, items: [], statusHistory: [] });
    expect(await screen.findByText(/SW-1/)).toBeTruthy();
    const content = view.container.firstElementChild!;
    expect([content.className, content.children[0]!.className, content.children[1]!.className]).toEqual(shape);
  });
});

it('search shows store-shaped placeholders during debounce and ignores a late answer after clearing', async () => {
  const response = pending<api.Vendor[]>();
  vi.spyOn(api, 'searchVendors').mockReturnValue(response.promise);
  mount(<SearchPage />);
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Lunch' } });
  expect(screen.getByLabelText('Searching').querySelector('[data-store-part="copy"]')).toBeTruthy();
  expect(screen.getByRole('status').textContent).toBe('Searching…');
  await new Promise((resolve) => setTimeout(resolve, 320));
  expect(api.searchVendors).toHaveBeenCalledWith('Lunch');
  fireEvent.change(screen.getByRole('textbox'), { target: { value: '' } });
  await response.finish([vendor]);
  expect(screen.queryByLabelText('Searching')).toBeNull();
  expect(screen.queryByText('Local store')).toBeNull();
});

it('orders cached for one person never appear while a different person’s list is loading', async () => {
  vi.spyOn(api, 'getOrders').mockResolvedValueOnce([{ id: 'o1', vendorName: 'First order', status: 'PENDING' }])
    .mockReturnValueOnce(new Promise(() => undefined));
  const view = mount(<OrdersPage />);
  await screen.findByText('First order');
  person.scope = 'another-person'; person.epoch += 1;
  view.rerender(<OrdersPage />);
  expect(screen.queryByText('First order')).toBeNull();
  expect(screen.getByLabelText('Loading your orders')).toBeTruthy();
});
