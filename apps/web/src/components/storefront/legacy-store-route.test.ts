import { beforeEach, describe, expect, it, vi } from 'vitest';

// [W6] One store page: the old /order/vendor/<id> address sends every visitor,
// with a real 301, to the store's /store/<slug> page.
vi.mock('@/lib/browse-server', () => ({ vendorSeed: vi.fn() }));

import { vendorSeed } from '@/lib/browse-server';
import { GET } from '@/app/(app)/order/vendor/[id]/route';

const open = (id: string, query = '') =>
  GET(new Request(`https://web.test/order/vendor/${id}${query}`), { params: Promise.resolve({ id }) });

beforeEach(() => {
  vi.mocked(vendorSeed).mockReset();
});

describe('the old store address', () => {
  it('is sent with a 301 to the store’s one page, keeping only the item it opened at and a scan’s attribution', async () => {
    vi.mocked(vendorSeed).mockResolvedValue({ data: { id: 'v1', slug: 'sample-kitchen' } as never, at: 0 });
    const response = await open('v1', '?item=roti&src=qr&c=SCAN&t=card&next=https://elsewhere.test&utm_source=x');
    expect(vendorSeed).toHaveBeenCalledWith('v1');
    expect(response.status).toBe(301);
    expect(response.headers.get('Location')).toBe('/store/sample-kitchen?src=qr&c=SCAN&t=card&item=roti');
  });

  it('drops an item or code that cannot be one, and a source that is not only a scan', async () => {
    vi.mocked(vendorSeed).mockResolvedValue({ data: { id: 'v1', slug: 'sample-kitchen' } as never, at: 0 });
    for (const query of ['?item=..%2Fadmin&src=share&c=no%20spaces', '?src=qr&src=share']) {
      const response = await open('v1', query);
      expect(response.status, query).toBe(301);
      expect(response.headers.get('Location'), query).toBe('/store/sample-kitchen');
    }
  });

  it('does not invent an address for a store the server does not show', async () => {
    vi.mocked(vendorSeed).mockResolvedValue(null);
    const response = await open('absent');
    expect(response.status).toBe(404);
    expect(response.headers.get('Location')).toBeNull();
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(await response.text()).toContain('noindex');
  });

  it('does not invent an address for a store the server sent without a name', async () => {
    vi.mocked(vendorSeed).mockResolvedValue({ data: { id: 'v1', slug: '' } as never, at: 0 });
    const response = await open('v1');
    expect(response.status).toBe(404);
    expect(response.headers.get('Location')).toBeNull();
  });
});
