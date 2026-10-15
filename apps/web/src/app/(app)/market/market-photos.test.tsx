import { screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mockApi, renderWithQuery } from '@/test/test-utils';
import { MarketScreen } from './market-screen';

// PERF #6 (15 Oct): the Market's largest paint was a first-row photo marked
// loading="lazy", so the browser held it back until layout (LCP 3.9 s, the
// worst guest page). The first row now loads at once with high priority;
// every later photo still loads lazily.

vi.mock('next/navigation', () => ({
  usePathname: () => '/market',
  useSearchParams: () => new URLSearchParams(''),
  useRouter: () => ({ push: vi.fn(), back: vi.fn(), replace: vi.fn() }),
}));

const goods = ['Claw hammer', 'Paint brush', 'Tape measure', 'Spirit level', 'Wood glue'].map((name, i) => ({
  id: `m${i + 1}`, name, basePrice: 2500, imageUrl: `https://cdn.example.test/goods/m${i + 1}.jpg`,
  vendorId: 'v9', vendorName: 'City Hardware', categoryName: 'Tools', isNew: false,
}));

beforeEach(() => {
  mockApi(({ url }) => {
    if (url.pathname === '/api/v1/market/depth') return { body: { success: true, data: { visible: true, items: 400, vendors: 6 } } };
    if (url.pathname === '/api/v1/discovery/categories') return { body: { success: true, data: { enabled: true, categories: [] } } };
    if (url.pathname === '/api/v1/market/items') return { body: { success: true, data: { items: goods, nextCursor: null } } };
    return { status: 404, body: { success: false } };
  });
});

describe('Market photos (PERF #6)', () => {
  it('loads the first row eagerly with high priority and every later photo lazily', async () => {
    renderWithQuery(<MarketScreen />);
    await screen.findByRole('link', { name: /Wood glue/ });
    const photos = goods.map((item) => screen.getByRole('link', { name: new RegExp(item.name) }).querySelector('img'));
    expect(photos).toHaveLength(5);
    const policy = photos.map((img) => [img?.getAttribute('loading'), img?.getAttribute('fetchpriority')]);
    expect(policy.slice(0, 2)).toEqual([[null, 'high'], [null, 'high']]);
    for (const later of policy.slice(2)) expect(later).toEqual(['lazy', null]);
  });
});
