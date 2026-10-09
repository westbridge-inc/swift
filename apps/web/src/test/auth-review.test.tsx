import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import AppLayout from '@/app/(app)/layout';
import { StorefrontExperience } from '@/components/storefront/storefront-experience';
import { storefrontFixture } from '@/test/storefront-fixture';
import { mockApi } from '@/test/test-utils';
import { clearSession, getSessionPrincipal } from '@/lib/auth';

const nav = vi.hoisted(() => ({ pathname: '/', push: vi.fn(), back: vi.fn() }));
vi.mock('next/navigation', () => ({ usePathname: () => nav.pathname, useRouter: () => nav }));
const store = storefrontFixture({
  id: 'fixture-store', slug: 'fixture-store', name: 'Fixture Store', vendorType: 'RESTAURANT',
  isCurrentlyOpen: true, displayRating: null, estimatedPrepTime: 20,
  categories: [{ id: 'mains', name: 'Mains', items: [{ id: 'soup', name: 'Fixture soup', basePrice: 800,
    customerPrice: 800, imageUrl: null, isAvailable: true, fulfillment: 'DELIVERY', optionGroups: [] }] }],
});
const ok = (data: unknown) => ({ body: { success: true, data } });

beforeEach(() => {
  clearSession(); sessionStorage.clear(); nav.pathname = '/'; nav.push.mockReset();
});

it('renews before sending a known customer to login after Home to store navigation with expired access', async () => {
  let accessAlive = true;
  let refreshes = 0;
  mockApi(({ url }) => {
    if (url.pathname === '/api/v1/auth/me') return accessAlive ? ok({ user: { id: 'fixture-person' } }) : { status: 401, body: { success: false } };
    if (url.pathname === '/api/v1/auth/refresh') { refreshes += 1; accessAlive = true; return ok({}); }
    if (url.pathname === '/api/v1/market/depth') return ok({ visible: false, items: 0, vendors: 0 });
    if (url.pathname === '/api/v1/customer/cart') return accessAlive ? ok({ items: [] }) : { status: 401, body: { success: false } };
    if (url.pathname === '/api/v1/customer/addresses' || url.pathname === '/api/v1/customer/favorites') return ok([]);
    if (url.pathname === '/api/v1/customer/profile') return ok({ firstName: 'Fixture', lastName: 'Customer' });
    if (url.pathname === '/api/v1/customer/vendors/fixture-store' || url.pathname === '/api/v1/public/storefronts/fixture-store') return ok(store);
    return { status: 404, body: { success: false } };
  });
  const view = render(<AppLayout><p>Fixture home</p></AppLayout>);
  await waitFor(() => expect(getSessionPrincipal()).toBe('fixture-person'));
  // Home's shell survives client navigation. Only the access cookie expires;
  // the refresh endpoint will successfully renew if the client calls it.
  accessAlive = false;
  nav.pathname = '/store/fixture-store';
  view.rerender(<AppLayout><StorefrontExperience store={store} returnPath="/store/fixture-store" /></AppLayout>);
  await waitFor(() => expect(refreshes).toBe(1));
  expect(getSessionPrincipal()).toBe('fixture-person');
  const add = await screen.findByRole('button', { name: 'Add Fixture soup' });
  await waitFor(() => expect((add as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(add);
  await waitFor(() => expect(refreshes > 0 || nav.push.mock.calls.length > 0).toBe(true));
  expect({ refreshes, navigations: nav.push.mock.calls }).toEqual({ refreshes: 1, navigations: [] });
});
