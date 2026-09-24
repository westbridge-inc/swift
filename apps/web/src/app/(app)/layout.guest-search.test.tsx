import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import AppLayout from './layout';

const state = vi.hoisted(() => ({ pathname: '/order/search', replace: vi.fn(), sessionProbe: vi.fn() }));
vi.mock('next/navigation', () => ({ usePathname: () => state.pathname, useRouter: () => ({ replace: state.replace }) }));
vi.mock('@/lib/auth', () => ({ sessionProbe: state.sessionProbe }));
vi.mock('@/components/swift-logo', () => ({ SwiftLogo: () => <span>Swift</span> }));

beforeEach(() => { state.pathname = '/order/search'; state.sessionProbe.mockResolvedValue({ ok: false }); });
describe('guest search access in the customer shell', () => {
  it('renders search for a guest without redirecting to login', async () => {
    render(<AppLayout><p>Catalogue search</p></AppLayout>);
    await waitFor(() => expect(screen.queryByText('Catalogue search')).not.toBeNull());
    expect(state.replace).not.toHaveBeenCalled();
  });
  it('still gates private routes after a guest leaves search', async () => {
    const view = render(<AppLayout><p>Catalogue search</p></AppLayout>);
    await waitFor(() => expect(screen.queryByText('Catalogue search')).not.toBeNull());
    state.pathname = '/account';
    view.rerender(<AppLayout><p>Private account</p></AppLayout>);
    expect(screen.queryByText('Private account')).toBeNull();
    await waitFor(() => expect(state.replace).toHaveBeenCalledWith('/login?next=%2Faccount'));
  });
  it('rechecks private access after an authenticated visitor returns from public search', async () => {
    state.pathname = '/account'; state.sessionProbe.mockResolvedValue({ ok: true });
    const view = render(<AppLayout><p>Private account</p></AppLayout>);
    await waitFor(() => expect(screen.queryByText('Private account')).not.toBeNull());
    state.pathname = '/order/search';
    view.rerender(<AppLayout><p>Catalogue search</p></AppLayout>);
    expect(screen.queryByText('Catalogue search')).not.toBeNull();
    state.pathname = '/account'; state.sessionProbe.mockResolvedValue({ ok: false });
    view.rerender(<AppLayout><p>Private account</p></AppLayout>);
    expect(screen.queryByText('Private account')).toBeNull();
    await waitFor(() => expect(state.replace).toHaveBeenCalledWith('/login?next=%2Faccount'));
  });
  it('still renders authenticated private pages', async () => {
    state.pathname = '/account'; state.sessionProbe.mockResolvedValue({ ok: true });
    render(<AppLayout><p>Private account</p></AppLayout>);
    await waitFor(() => expect(screen.queryByText('Private account')).not.toBeNull());
    expect(state.replace).not.toHaveBeenCalled();
  });
});
