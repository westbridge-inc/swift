import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, it, vi } from 'vitest';
import AppLayout from '@/app/(app)/layout';
import { adoptSession, clearSession } from '@/lib/auth';
import { mockApi, type ApiReply, type ApiRequest } from '@/test/test-utils';
import { FavouriteButton } from './account/favourites';
import BrowsePage from '@/app/(app)/order/browse/page';
import VendorPage from '@/app/(app)/order/vendor/[id]/page';

vi.mock('next/navigation', () => ({
  usePathname: () => '/order/browse',
  useSearchParams: () => new URLSearchParams('type=RESTAURANT'),
  useParams: () => ({ id: 'store' }),
  useRouter: () => ({ push: vi.fn(), back: vi.fn() }),
}));

const ok = (data: unknown): ApiReply => ({ body: { success: true, data } });
const vendor = (name: string) => ({ id: name, name, slug: name, vendorType: 'RESTAURANT', cuisineTypes: [], displayRating: null, ratingBucket: 'New', ratingCount: 0, topRated: false, estimatedPrepTime: 20, isCurrentlyOpen: true, acceptingOrders: true });

beforeEach(() => { clearSession(); sessionStorage.clear(); });

it.each(['browse', 'detail'] as const)('drops mounted %s after rejected refresh with unchanged vendor type or ID, including when the same account returns', async (view) => {
  adoptSession('reviewer');
  const calls: ApiRequest[] = [];
  const pending: Array<{ path: string; finish: (_reply: ApiReply) => void }> = [];
  let holdDiscovery = false;
  const discoveryReply = (path: string, name: string) => path.endsWith('/customer/vendors')
    ? ok([vendor(name)]) : ok({ ...vendor(name), id: 'store', categories: [{ id: 'menu', name: 'Menu', items: [{ id: 'item', name: `${name} meal`, basePrice: 100, isAvailable: true }] }] });
  mockApi((request) => {
    calls.push(request);
    const path = request.url.pathname;
    if (path.endsWith('/auth/me')) return ok({ user: { id: 'reviewer' } });
    if (path.endsWith('/market/depth')) return ok({ visible: false });
    if (path.endsWith('/customer/addresses')) return ok([]);
    if (path.endsWith('/customer/favorites')) return ok([]);
    if (path.endsWith('/auth/refresh') || request.method === 'POST') return { status: 401, body: {} };
    if (path.endsWith('/customer/vendors/store') || path.endsWith('/customer/vendors')) {
      return holdDiscovery
        ? new Promise<ApiReply>((finish) => { pending.push({ path, finish }); })
        : discoveryReply(path, 'Review-only');
    }
    throw new Error(`Unexpected ${request.method} ${path}`);
  });
  const user = userEvent.setup();
  render(<AppLayout>
    {view === 'browse' ? <BrowsePage /> : <VendorPage />}
    <FavouriteButton vendorId="trigger" name="Trigger" />
  </AppLayout>);
  await screen.findByText('Review-only');
  const heart = await screen.findByRole('button', { name: 'Save Trigger to favourites' });
  await waitFor(() => expect((heart as HTMLButtonElement).disabled).toBe(false));
  if (view === 'detail') {
    await user.click(screen.getByRole('button', { name: /Review-only meal/ }));
    expect(screen.getByRole('dialog', { name: 'Review-only meal' })).toBeTruthy();
  }
  const endpoint = view === 'browse' ? '/customer/vendors' : '/customer/vendors/store';
  const reads = () => calls.filter((r) => r.url.pathname.endsWith(endpoint));
  const signedInReads = reads().length;
  const originalQuery = reads()[0]!.url.search;
  expect(originalQuery).toBe(view === 'browse' ? '?type=RESTAURANT' : '');

  holdDiscovery = true;
  await user.click(heart);
  await screen.findByRole('link', { name: 'Sign in to save Trigger' });
  // Both old data and any placeholder must disappear before the guest reply.
  expect(screen.queryByText('Review-only')).toBeNull();
  expect(screen.queryByRole('dialog')).toBeNull();
  await waitFor(() => expect(reads().length).toBeGreaterThan(signedInReads));
  expect(reads().every((r) => r.url.search === originalQuery)).toBe(true);
  expect(calls.filter((r) => r.url.pathname.endsWith('/auth/refresh'))).toHaveLength(1);
  await act(async () => {
    for (const request of pending.splice(0)) request.finish(discoveryReply(request.path, 'Guest-visible'));
  });
  await screen.findByText('Guest-visible');
  expect(screen.queryByText('Review-only')).toBeNull();
  expect(screen.queryByRole('dialog')).toBeNull();

  // Returning to the same scope is a new epoch, not permission to reuse its cache.
  const guestReads = reads().length;
  await act(async () => { adoptSession('reviewer'); });
  expect(screen.queryByText('Review-only')).toBeNull();
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(screen.queryByText('Guest-visible')).toBeNull();
  await waitFor(() => expect(reads().length).toBeGreaterThan(guestReads));
  expect(reads().every((r) => r.url.search === originalQuery)).toBe(true);
  await act(async () => {
    for (const request of pending.splice(0)) request.finish(discoveryReply(request.path, 'Current-session'));
  });
  await screen.findByText('Current-session');
  expect(screen.queryByText('Review-only')).toBeNull();
  expect(screen.queryByRole('dialog')).toBeNull();
});
