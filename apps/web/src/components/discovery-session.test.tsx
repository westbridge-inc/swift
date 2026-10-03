import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, it, vi } from 'vitest';
import AppLayout from '@/app/(app)/layout';
import { adoptSession, clearSession } from '@/lib/auth';
import { mockApi, type ApiReply, type ApiRequest } from '@/test/test-utils';
import { FavouriteButton } from './account/favourites';
import { CategoryFeed, CategoryGrid } from './customer-discovery';

vi.mock('next/navigation', () => ({
  usePathname: () => '/order/browse',
  useRouter: () => ({ push: vi.fn(), back: vi.fn() }),
}));

const ok = (data: unknown): ApiReply => ({ body: { success: true, data } });
const category = (name: string) => ({ slug: name, name, emoji: '🍴', kind: 'CUISINE', vertical: 'FOOD', iconKey: null, availableVendors: 1 });
const vendor = (name: string) => ({ id: name, name, slug: name, vendorType: 'RESTAURANT', cuisineTypes: [], displayRating: null, ratingBucket: 'New', ratingCount: 0, topRated: false, estimatedPrepTime: 20, isCurrentlyOpen: true, acceptingOrders: true });

beforeEach(() => { clearSession(); sessionStorage.clear(); });

it.each(['vendors', 'taxonomy'] as const)('drops mounted %s after rejected refresh with unchanged coordinates, including when the same account returns', async (view) => {
  adoptSession('reviewer');
  const calls: ApiRequest[] = [];
  const pending: Array<{ path: string; finish: (_reply: ApiReply) => void }> = [];
  let holdDiscovery = false;
  const discoveryReply = (path: string, name: string) => path.endsWith('/customer/vendors')
    ? ok([vendor(name)]) : ok({ enabled: true, categories: [category(name)] });
  mockApi((request) => {
    calls.push(request);
    const path = request.url.pathname;
    if (path.endsWith('/auth/me')) return ok({ user: { id: 'reviewer' } });
    if (path.endsWith('/market/depth')) return ok({ visible: false });
    if (path.endsWith('/customer/addresses')) return ok([]);
    if (path.endsWith('/customer/favorites')) return ok([]);
    if (path.endsWith('/auth/refresh') || request.method === 'POST') return { status: 401, body: {} };
    if (path.endsWith('/discovery/categories') || path.endsWith('/customer/vendors')) {
      return holdDiscovery
        ? new Promise<ApiReply>((finish) => { pending.push({ path, finish }); })
        : discoveryReply(path, 'Review-only');
    }
    throw new Error(`Unexpected ${request.method} ${path}`);
  });
  const user = userEvent.setup();
  render(<AppLayout>
    {view === 'vendors' ? <CategoryFeed slug="curry" name="Curry" emoji="" /> : <CategoryGrid />}
    <FavouriteButton vendorId="trigger" name="Trigger" />
  </AppLayout>);
  await screen.findByText('Review-only');
  const heart = await screen.findByRole('button', { name: 'Save Trigger to favourites' });
  await waitFor(() => expect((heart as HTMLButtonElement).disabled).toBe(false));
  const endpoint = view === 'vendors' ? '/customer/vendors' : '/discovery/categories';
  const reads = () => calls.filter((r) => r.url.pathname.endsWith(endpoint));
  const signedInReads = reads().length;
  const originalQuery = reads()[0]!.url.search;
  expect(reads().every((r) => !r.url.searchParams.has('lat') && !r.url.searchParams.has('lng'))).toBe(true);

  holdDiscovery = true;
  await user.click(heart);
  await screen.findByRole('link', { name: 'Sign in to save Trigger' });
  // Both old data and any placeholder must disappear before the guest reply.
  expect(screen.queryByText('Review-only')).toBeNull();
  await waitFor(() => expect(reads().length).toBeGreaterThan(signedInReads));
  expect(reads().every((r) => r.url.search === originalQuery)).toBe(true);
  expect(calls.filter((r) => r.url.pathname.endsWith('/auth/refresh'))).toHaveLength(1);
  await act(async () => {
    for (const request of pending.splice(0)) request.finish(discoveryReply(request.path, 'Guest-visible'));
  });
  await screen.findByText('Guest-visible');
  expect(screen.queryByText('Review-only')).toBeNull();

  // Returning to the same scope is a new epoch, not permission to reuse its cache.
  const guestReads = reads().length;
  await act(async () => { adoptSession('reviewer'); });
  expect(screen.queryByText('Review-only')).toBeNull();
  expect(screen.queryByText('Guest-visible')).toBeNull();
  await waitFor(() => expect(reads().length).toBeGreaterThan(guestReads));
  expect(reads().every((r) => r.url.search === originalQuery)).toBe(true);
  await act(async () => {
    for (const request of pending.splice(0)) request.finish(discoveryReply(request.path, 'Current-session'));
  });
  await screen.findByText('Current-session');
  expect(screen.queryByText('Review-only')).toBeNull();
});
