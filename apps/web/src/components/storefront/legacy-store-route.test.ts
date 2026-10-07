import { beforeEach, describe, expect, it, vi } from 'vitest';

// [W6] One store page: the old /order/vendor/<id> address sends every visitor,
// permanently, to the store's /store/<slug> page.
const nav = vi.hoisted(() => ({
  permanentRedirect: vi.fn((path: string) => { throw Object.assign(new Error('NEXT_REDIRECT'), { path }); }),
  notFound: vi.fn(() => { throw new Error('NEXT_NOT_FOUND'); }),
}));
vi.mock('next/navigation', () => nav);
vi.mock('@/lib/browse-server', () => ({ vendorSeed: vi.fn() }));

import { vendorSeed } from '@/lib/browse-server';
import LegacyStorePage from '@/app/(app)/order/vendor/[id]/page';

const open = (id: string, search: Record<string, string | string[]> = {}) =>
  LegacyStorePage({ params: Promise.resolve({ id }), searchParams: Promise.resolve(search) });

beforeEach(() => {
  nav.permanentRedirect.mockClear();
  nav.notFound.mockClear();
  vi.mocked(vendorSeed).mockReset();
});

describe('the old store address', () => {
  it('is sent permanently to the store’s one page, keeping only the item it opened at and a scan’s attribution', async () => {
    vi.mocked(vendorSeed).mockResolvedValue({ data: { id: 'v1', slug: 'sample-kitchen' } as never, at: 0 });
    await expect(open('v1', { item: 'roti', src: 'qr', c: 'SCAN', t: 'card', next: 'https://elsewhere.test', utm_source: 'x' })).rejects.toThrow('NEXT_REDIRECT');
    expect(vendorSeed).toHaveBeenCalledWith('v1');
    expect(nav.permanentRedirect).toHaveBeenCalledExactlyOnceWith('/store/sample-kitchen?src=qr&c=SCAN&t=card&item=roti');
  });

  it('drops an item or code that cannot be one, and a source that is not a scan', async () => {
    vi.mocked(vendorSeed).mockResolvedValue({ data: { id: 'v1', slug: 'sample-kitchen' } as never, at: 0 });
    await expect(open('v1', { item: '../admin', src: 'share', c: 'no spaces allowed' })).rejects.toThrow('NEXT_REDIRECT');
    expect(nav.permanentRedirect).toHaveBeenCalledExactlyOnceWith('/store/sample-kitchen');
  });

  it('does not invent an address for a store the server does not show', async () => {
    vi.mocked(vendorSeed).mockResolvedValue(null);
    await expect(open('absent')).rejects.toThrow('NEXT_NOT_FOUND');
    expect(nav.permanentRedirect).not.toHaveBeenCalled();
  });

  it('does not invent an address for a store the server sent without a name', async () => {
    vi.mocked(vendorSeed).mockResolvedValue({ data: { id: 'v1', slug: '' } as never, at: 0 });
    await expect(open('v1')).rejects.toThrow('NEXT_NOT_FOUND');
    expect(nav.permanentRedirect).not.toHaveBeenCalled();
  });
});
