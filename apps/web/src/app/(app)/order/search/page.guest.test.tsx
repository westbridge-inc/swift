import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import AppLayout from '../../layout';
import SearchPage from './page';

const navigation = vi.hoisted(() => ({ replace: vi.fn() }));
vi.mock('next/navigation', () => ({ usePathname: () => '/order/search', useRouter: () => navigation }));
vi.mock('@/components/swift-logo', () => ({ SwiftLogo: () => <span>Swift</span> }));
vi.mock('@/components/order-ui', () => ({
  VendorCard: ({ v }: any) => <p>{v.name}</p>, EmptyNote: ({ children }: any) => <p>{children}</p>,
}));

describe('web guest catalogue search', () => {
  it('mounts the public page and uses the existing guest browse client', async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({ success: true, data: [{ id: 'public', name: 'Public pepper shop' }] }), { status: 200 }));
    vi.stubGlobal('fetch', fetcher);
    render(<AppLayout><SearchPage /></AppLayout>);
    fireEvent.change(screen.getByPlaceholderText('Search stores, cuisines…'), { target: { value: 'Pepper' } });
    await waitFor(() => expect(screen.queryByText('Public pepper shop')).not.toBeNull());
    // [Q7b] The shell asks once who is browsing and once whether Market is
    // open; the search itself is still the one guest browse call. Nothing
    // else — in particular, no refresh is spent on a guest.
    expect(fetcher.mock.calls.map(([url]) => String(url)).sort()).toEqual([
      'http://vendor-api.test/api/v1/auth/me',
      'http://vendor-api.test/api/v1/customer/vendors?search=Pepper',
      'http://vendor-api.test/api/v1/market/depth',
    ]);
    expect(fetcher).toHaveBeenCalledWith('http://vendor-api.test/api/v1/customer/vendors?search=Pepper', expect.objectContaining({ credentials: 'include' }));
    expect(navigation.replace).not.toHaveBeenCalled();
  });
});
