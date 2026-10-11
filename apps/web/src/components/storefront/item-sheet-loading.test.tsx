import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { renderToString } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { StorefrontDetail } from '@/lib/api';
import type * as CustomerModule from '@/lib/customer';
import { storefrontVerticalVariables } from '@/lib/design-tokens';

// ---------------------------------------------------------------------------
// [W6 · size] The item sheet's code (choices, quantity, Add) and the design
// token tables are not part of the store page's first-load JavaScript: the
// sheet's code arrives right after the page's own code has run, and the
// store's tint is worked out on the server. What a customer sees must not
// change: the first paint is the same, a tap opens the sheet with focus on its
// Close button, a link that names an item opens it, and nothing stands in for
// the sheet while its code is on the way. Synthetic store and items only.
// ---------------------------------------------------------------------------

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }), notFound: () => { throw new Error('not found'); } }));

const option = (id: string, name: string, additionalPrice: string) => ({ id, name, additionalPrice, isAvailable: true, isDefault: false });
const SIZE = { id: 'size', name: 'Size', isRequired: true, minSelect: 1, maxSelect: 1, options: [option('regular', 'Regular', '0'), option('large', 'Large', '400')] };
const soup = { id: 'soup', name: 'Pumpkin soup', description: 'Made by this store', basePrice: 800, customerPrice: 800, imageUrl: null, unit: null,
  isPopular: false, fulfillment: 'DELIVERY', isAvailable: true, optionGroups: [] as typeof SIZE[] };
const curry = { ...soup, id: 'curry', name: 'Curry & roti', basePrice: 1200, customerPrice: 1200, optionGroups: [SIZE] };
const store = {
  id: 'menu-store', slug: 'sample-kitchen', name: 'Sample Kitchen', description: null, vendorType: 'RESTAURANT',
  logoUrl: null, coverImageUrl: null, city: 'Georgetown', region: 'Demerara', cuisineTypes: [], tags: [],
  displayRating: null, ratingBucket: 'NEW', ratingCount: 0, topRated: false, isCurrentlyOpen: true, acceptingOrders: true,
  estimatedPrepTime: 20, minOrderAmount: 0, isFeatured: false, addressLine1: 'Fixture street', operatingHours: [],
  categories: [{ id: 'mains', name: 'Mains', items: [soup, curry] }],
} as unknown as StorefrontDetail;
// Re-evaluating the sheet's module after a reset can be slow on a busy test machine.
const ARRIVAL = { timeout: 5000 };
const emptyCart = { items: [], vendor: null, subtotal: 0, subtotalCustomer: 0, totalAmount: 0, meetsMinimum: true };

type Gate = { release: () => void; fail: boolean };

/**
 * A fresh store page whose item-sheet code is held back until `gate.release()`
 * (or fails to arrive while `gate.fail` is set), like a slow or dropped fetch.
 */
async function freshPage(gate: Gate) {
  vi.resetModules();
  let open!: () => void;
  let held = new Promise<void>((resolve) => { open = resolve; });
  gate.release = () => open();
  vi.doMock('@/components/storefront/item-sheet', async (importOriginal) => {
    await held;
    if (gate.fail) {
      held = new Promise<void>((resolve) => { open = resolve; });
      throw new Error('The sheet could not be fetched.');
    }
    return importOriginal();
  });
  const customer: typeof CustomerModule = await import('@/lib/customer');
  const auth = await import('@/lib/auth');
  vi.spyOn(auth, 'sessionProbe').mockResolvedValue({ ok: true } as Awaited<ReturnType<typeof auth.sessionProbe>>);
  vi.spyOn(customer, 'getPublicStorefront').mockResolvedValue(store);
  vi.spyOn(customer, 'getPublicVendor').mockResolvedValue({ ...store, description: undefined } as unknown as CustomerModule.VendorDetail);
  vi.spyOn(customer, 'getCart').mockResolvedValue(emptyCart as unknown as CustomerModule.Cart);
  vi.spyOn(customer, 'getAddresses').mockResolvedValue([]);
  vi.spyOn(customer, 'addToCart').mockResolvedValue(emptyCart as never);
  return import('./storefront-experience');
}

async function chooseCurry() {
  const choose = screen.getByRole('button', { name: 'Choose options for Curry & roti' });
  await waitFor(() => expect((choose as HTMLButtonElement).disabled).toBe(false));
  choose.focus();
  fireEvent.click(choose);
  return choose;
}

afterEach(() => {
  vi.doUnmock('@/components/storefront/item-sheet');
  vi.resetModules();
});

describe('[W6] the item sheet is not in the store page’s first load', () => {
  it('the page loads the sheet’s code separately, and its tint comes from the server, not the design-token tables', () => {
    const page = readFileSync(join(process.cwd(), 'src/components/storefront/storefront-experience.tsx'), 'utf8');
    expect(page).not.toMatch(/from '\.\/item-sheet'/);
    expect(page).toMatch(/import\('\.\/item-sheet'\)/);
    expect(page).not.toMatch(/@\/lib\/design-tokens/);
    const server = readFileSync(join(process.cwd(), 'src/components/storefront/storefront-page.tsx'), 'utf8');
    expect(server).toMatch(/verticalStyle=\{storefrontVerticalVariables\(store\.vendorType\)\}/);
  });

  it('the server-drawn page carries the store’s tint, as before', async () => {
    const api = await import('@/lib/api');
    vi.spyOn(api, 'fetchStorefront').mockResolvedValue(store);
    const { StorefrontPage } = await import('./storefront-page');
    const html = renderToString(await StorefrontPage({ params: Promise.resolve({ slug: store.slug }), searchParams: Promise.resolve({}) }));
    const tint = storefrontVerticalVariables('RESTAURANT') as Record<string, string>;
    expect(html).toContain(`--swift-vertical-bg:${tint['--swift-vertical-bg']}`);
    expect(html).toContain(`--swift-vertical-ink:${tint['--swift-vertical-ink']}`);
  });

  it('once its code has arrived, a tap opens the sheet in the same update, with focus on Close', async () => {
    const gate: Gate = { release: () => undefined, fail: false };
    const { StorefrontExperience, loadItemSheet } = await freshPage(gate);
    gate.release();
    await loadItemSheet();
    render(<StorefrontExperience store={store} returnPath="/store/sample-kitchen" />);
    await chooseCurry();
    const sheet = screen.getByRole('dialog', { name: 'Curry & roti' });
    await waitFor(() => expect(document.activeElement).toBe(within(sheet).getByRole('button', { name: 'Close item options' })));
  });

  it('a tap before its code arrives shows nothing in the sheet’s place, then opens the sheet with focus on Close', async () => {
    const gate: Gate = { release: () => undefined, fail: false };
    const { StorefrontExperience } = await freshPage(gate);
    render(<StorefrontExperience store={store} returnPath="/store/sample-kitchen" />);
    const choose = await chooseCurry();
    await new Promise((resolve) => setTimeout(resolve, 20));
    // Nothing stands in for the sheet: no dialog, no placeholder, the page is not locked.
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.querySelector('[data-swift-modal]')).toBeNull();
    expect(document.body.style.overflow).toBe('');
    expect(document.activeElement).toBe(choose);
    gate.release();
    const sheet = await screen.findByRole('dialog', { name: 'Curry & roti' }, ARRIVAL);
    await waitFor(() => expect(document.activeElement).toBe(within(sheet).getByRole('button', { name: 'Close item options' })));
    fireEvent.click(within(sheet).getByRole('button', { name: 'Close item options' }));
    await waitFor(() => expect(document.activeElement).toBe(choose));
  });

  it('a link that names an item (?item=) opens its sheet once the live menu and the sheet’s code are in', async () => {
    const gate: Gate = { release: () => undefined, fail: false };
    const { StorefrontExperience } = await freshPage(gate);
    render(<StorefrontExperience store={store} returnPath="/store/sample-kitchen" initialItemId="soup" />);
    await waitFor(() => expect((screen.getByRole('button', { name: 'Add Pumpkin soup' }) as HTMLButtonElement).disabled).toBe(false));
    expect(screen.queryByRole('dialog')).toBeNull();
    gate.release();
    const sheet = await screen.findByRole('dialog', { name: 'Pumpkin soup' }, ARRIVAL);
    await waitFor(() => expect(document.activeElement).toBe(within(sheet).getByRole('button', { name: 'Close item options' })));
  });

  it('if its code cannot be fetched, the customer is told, and the next tap fetches it again', async () => {
    const gate: Gate = { release: () => undefined, fail: true };
    const { StorefrontExperience } = await freshPage(gate);
    render(<StorefrontExperience store={store} returnPath="/store/sample-kitchen" />);
    await chooseCurry();
    gate.release();
    expect((await screen.findAllByText('Swift could not open this item. Check your connection and try again.', {}, ARRIVAL)).length).toBeGreaterThan(0);
    expect(screen.queryByRole('dialog')).toBeNull();
    gate.fail = false;
    await chooseCurry();
    gate.release();
    expect(await screen.findByRole('dialog', { name: 'Curry & roti' }, ARRIVAL)).toBeTruthy();
  });
});
