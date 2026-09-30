import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CustomerSessionProvider, type CustomerSession } from './customer-session';
import { renderWithQuery, mockApi, type ApiReply } from '@/test/test-utils';
import { adoptSession } from '@/lib/auth';
import AccountPage from '@/app/(app)/account/page';
import ProfilePage from '@/app/(app)/account/profile/page';
import SearchPage from '@/app/(app)/order/search/page';
import OrdersPage from '@/app/(app)/orders/page';
import type { ReactNode } from 'react';
import { onlineManager } from '@tanstack/react-query';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }), usePathname: () => '/account' }));
const session: CustomerSession = { status: 'signed-in', scope: 'person-a', epoch: 0, ensureSignedIn: async () => true, nearPoint: null, setNearPoint: () => undefined };
const wrap = (children: ReactNode, identity = session) => <CustomerSessionProvider value={identity}>{children}</CustomerSessionProvider>;
const ok = (data: unknown): ApiReply => ({ body: { success: true, data } });
const profile = { id: 'person-a', firstName: 'Test', lastName: 'Person', phone: '+5920000000', email: null };
const vendor = (name: string) => ({ id: name, name, isCurrentlyOpen: true, displayRating: null, estimatedPrepTime: 10 });
beforeEach(() => adoptSession('person-a'));

describe('per-person reuse without changing live money reads', () => {
  it('reuses Account profile in settings and returns the saved server response to Account', async () => {
    const fetcher = mockApi(({ url, method, init }) => {
      if (url.pathname.endsWith('/auth/me')) return ok({ user: { id: 'person-a' } });
      if (url.pathname.endsWith('/consent')) return ok({ consents: [] });
      return ok(method === 'PUT' ? { ...profile, ...JSON.parse(String(init?.body)) } : profile);
    });
    const view = renderWithQuery(wrap(<AccountPage />));
    await screen.findByText('Test Person');
    view.rerender(wrap(<ProfilePage />));
    const first = await screen.findByLabelText('First name');
    fireEvent.change(first, { target: { value: 'Updated' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save details' }));
    await screen.findByText('Your details are saved.');
    view.rerender(wrap(<AccountPage />));
    await screen.findByText('Updated Person');
    expect(fetcher.mock.calls.filter(([url, init]) => String(url).endsWith('/profile') && init?.method === 'GET')).toHaveLength(1);
  });

  it.each([{ scope: 'person-b', epoch: 0 }, { scope: 'person-a', epoch: 1 }])('never reuses profile across identity $scope epoch $epoch', async (identity) => {
    let resolve!: (_value: ApiReply) => void;
    const delayed = new Promise<ApiReply>((done) => { resolve = done; });
    let count = 0;
    mockApi(() => ++count === 1 ? ok(profile) : delayed);
    const view = renderWithQuery(wrap(<AccountPage />));
    await screen.findByText('Test Person');
    adoptSession(identity.scope);
    view.rerender(wrap(<AccountPage />, { ...session, ...identity }));
    expect(screen.queryByText('Test Person')).toBeNull();
    await act(async () => resolve(ok({ ...profile, id: identity.scope, firstName: 'Other' })));
    await screen.findByText('Other Person');
    expect(count).toBe(2);
  });

  it('reuses a repeated search within its person, then hides old results and late responses on account change', async () => {
    let resolve!: (_value: ApiReply) => void;
    let count = 0;
    let resolveGuest!: (_value: ApiReply) => void;
    const fetcher = mockApi(() => {
      count += 1;
      if (count === 1) return ok([vendor('First shop')]);
      // Resolve the previous person's request, never whichever newer request
      // happened to start last (the guest has its own pending response).
      return new Promise<ApiReply>((done) => { if (count === 2) resolve = done; else resolveGuest = done; });
    });
    const view = renderWithQuery(wrap(<SearchPage />));
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'tools' } });
    await screen.findByText('First shop');
    view.rerender(wrap(<div>away</div>));
    view.rerender(wrap(<SearchPage />));
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'tools' } });
    await screen.findByText('First shop');
    expect(fetcher).toHaveBeenCalledTimes(1);
    view.rerender(wrap(<SearchPage />, { ...session, scope: 'person-b', epoch: 1 }));
    expect(screen.queryByText('First shop')).toBeNull();
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
    view.rerender(wrap(<SearchPage />, { ...session, status: 'guest', scope: 'guest', epoch: 2 }));
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(3));
    await act(async () => resolve(ok([vendor('Second person shop')])));
    expect(screen.queryByText('Second person shop')).toBeNull();
    await act(async () => resolveGuest(ok([vendor('Guest shop')])));
    await screen.findByText('Guest shop');
    expect(screen.queryByText('Second person shop')).toBeNull();
  });

  it('debounces and ignores a slow answer for an older search term', async () => {
    let resolve!: (_value: ApiReply) => void;
    const fetcher = mockApi(({ url }) => url.searchParams.get('search') === 'old'
      ? new Promise<ApiReply>((done) => { resolve = done; }) : ok([vendor('New shop')]));
    renderWithQuery(wrap(<SearchPage />));
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'old' } });
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'n' } });
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'ne' } });
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'new' } });
    await screen.findByText('New shop');
    await act(async () => resolve(ok([vendor('Old shop')])));
    expect(screen.queryByText('Old shop')).toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('rechecks cached orders immediately and does not present the old price or status as final', async () => {
    let resolve!: (_value: ApiReply) => void;
    let count = 0;
    const order = { id: 'o1', vendorName: 'Test store', status: 'PENDING', totalAmount: 1000 };
    mockApi(() => ++count === 1 ? ok([order]) : new Promise<ApiReply>((done) => { resolve = done; }));
    const view = renderWithQuery(wrap(<OrdersPage />));
    await screen.findByText('Pending');
    view.rerender(wrap(<div>away</div>));
    view.rerender(wrap(<OrdersPage />));
    await screen.findByText('Checking status…');
    expect(screen.queryByText('Pending')).toBeNull();
    expect(screen.queryByText('GY$1,000')).toBeNull();
    await act(async () => resolve(ok([{ ...order, status: 'DELIVERED', totalAmount: 1500 }])));
    await screen.findByText('Delivered');
    expect(screen.getByText('GY$1,500')).toBeTruthy();
    expect(count).toBe(2);
  });

  it('does not present cached orders as current when a refetch is paused offline', async () => {
    mockApi(() => ok([{ id: 'o1', vendorName: 'Test store', status: 'PENDING', totalAmount: 1000 }]));
    const view = renderWithQuery(wrap(<OrdersPage />));
    await screen.findByText('Pending');
    view.rerender(wrap(<div>away</div>));
    onlineManager.setOnline(false);
    try {
      view.rerender(wrap(<OrdersPage />));
      await screen.findByText('Waiting for connection…');
      expect(screen.queryByText('Pending')).toBeNull();
      expect(screen.queryByText('GY$1,000')).toBeNull();
    } finally {
      view.unmount(); onlineManager.setOnline(true);
    }
  });
});
