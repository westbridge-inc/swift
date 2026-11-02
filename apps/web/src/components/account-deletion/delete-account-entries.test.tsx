import { render, screen, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mockApi, renderWithQuery } from '@/test/test-utils';
import { setSelectedStore } from '@/lib/auth';
import * as vendorApi from '@/lib/vendor-api';
import * as moverApi from '@/lib/mover-api';
import * as storeVatRead from '@/lib/store-vat-read';
import * as storeFeeApi from '@/lib/store-fee-api';
import { CustomerSessionProvider, type CustomerSession } from '@/components/customer-session';
import SettingsPage from '@/app/dashboard/settings/page';
import PortalAccountPage from '@/app/portal/account/page';
import AccountPage from '@/app/(app)/account/page';
import ProfilePage from '@/app/(app)/account/profile/page';
import DeleteInfoPage from '@/app/(marketing)/account/delete/page';

// ---------------------------------------------------------------------------
// [WEB-DELETE · owner 1 Nov 2026] Where a website partner (and a customer) finds "Delete my account": the store
// dashboard's Account, the rider and driver portal's Account, the customer's Account and Personal details (the
// phone's Personal data). The public how-to page names the website route too.
// ---------------------------------------------------------------------------

vi.mock('next/navigation', () => ({ useRouter: () => ({ replace: vi.fn(), push: vi.fn() }), usePathname: () => '/account' }));
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); localStorage.clear(); });

function stubStoreReads(myRole: string) {
  vi.spyOn(vendorApi, 'getProfile').mockResolvedValue({
    id: 'owner-1', userId: 'user-1', myRole,
    vendors: [{ id: 'store-1', name: 'First Sample Shop', vendorType: 'STORE', city: 'Town A', description: null, isVerified: false, activationValidUntil: null }],
  } as never);
  for (const read of ['getSubscription', 'getCashSettlements', 'getHours'] as const) vi.spyOn(vendorApi, read).mockReturnValue(new Promise(() => {}) as never);
  vi.spyOn(storeVatRead, 'getStoreVat').mockReturnValue(new Promise(() => {}) as never);
  vi.spyOn(storeFeeApi, 'getStoreFee').mockReturnValue(new Promise(() => {}) as never);
  // The page's other cards read on their own: they wait (this file is about the Account card only).
  vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})));
}

describe('[WEB-DELETE] the store dashboard\'s Account', () => {
  it('an owner is offered "Request account closure" (the server closes a store owner\'s account by request)', async () => {
    stubStoreReads('OWNER');
    setSelectedStore('store-1');
    renderWithQuery(<SettingsPage />);
    expect(await screen.findByRole('heading', { name: 'First Sample Shop' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Request account closure' }).getAttribute('href')).toBe('/dashboard/settings/delete-account');
    // [owner ruling 1 Nov] the request itself stops new orders, and the card says so before the owner opens it
    expect(screen.getByText(/New orders stop as soon as you ask/)).toBeTruthy();
  });

  it.each(['MANAGER', 'STAFF'])('a %s is offered "Delete my account"', async (role) => {
    stubStoreReads(role);
    setSelectedStore('store-1');
    renderWithQuery(<SettingsPage />);
    expect(await screen.findByRole('heading', { name: 'First Sample Shop' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Delete my account' }).getAttribute('href')).toBe('/dashboard/settings/delete-account');
  });
});

describe('[WEB-DELETE] the rider and driver portal\'s Account', () => {
  it('offers "Delete my account"', async () => {
    vi.spyOn(moverApi, 'getRiderProfile').mockResolvedValue({ id: 'r1', user: { firstName: 'Ann', lastName: 'Rider', phone: '+5920000001' } } as never);
    vi.spyOn(moverApi, 'getDriverProfile').mockResolvedValue(null as never);
    renderWithQuery(<PortalAccountPage />);
    expect((await screen.findByRole('link', { name: 'Delete my account' })).getAttribute('href')).toBe('/portal/account/delete');
  });

  it('still offers it when the profile cannot be read', async () => {
    vi.spyOn(moverApi, 'getRiderProfile').mockRejectedValue(new Error('Swift is busy'));
    vi.spyOn(moverApi, 'getDriverProfile').mockResolvedValue(null as never);
    renderWithQuery(<PortalAccountPage />);
    expect(await screen.findByText(/Couldn.t load your earner profile/)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Delete my account' }).getAttribute('href')).toBe('/portal/account/delete');
  });
});

describe('[WEB-DELETE] the customer\'s Account', () => {
  const signedIn: CustomerSession = { status: 'signed-in', scope: 'test-customer', epoch: 0, ensureSignedIn: async () => true, nearPoint: null, setNearPoint: () => undefined };
  const view = (children: ReactNode) => <CustomerSessionProvider value={signedIn}>{children}</CustomerSessionProvider>;
  const reads = () => mockApi(({ url }) => {
    const path = url.pathname.replace('/api/v1/customer', '');
    if (path === '/profile') return { body: { success: true, data: { id: 'c1', firstName: 'Test', lastName: 'Customer', phone: '+5920000000', email: null } } };
    if (path === '/consent') return { body: { success: true, data: { consents: [] } } };
    return { body: { success: true, data: {} } };
  });

  it('Account -> Privacy and legal -> "Delete my account" opens the delete flow, not only the how-to page', async () => {
    reads();
    renderWithQuery(view(<AccountPage />));
    const legal = await screen.findByRole('region', { name: 'Privacy and legal' });
    expect(within(legal).getByRole('link', { name: 'Delete my account' }).getAttribute('href')).toBe('/account/profile/delete');
  });

  it('Personal details -> Privacy and data -> "Delete my account" (the phone\'s Personal data)', async () => {
    reads();
    renderWithQuery(view(<ProfilePage />));
    const privacy = await screen.findByRole('region', { name: 'Privacy and data' });
    expect(within(privacy).getByRole('link', { name: 'Delete my account' }).getAttribute('href')).toBe('/account/profile/delete');
  });
});

describe('[WEB-DELETE] the public how-to page', () => {
  it('names the website route for stores, riders and drivers, and customers, beside the app\'s', () => {
    render(<DeleteInfoPage />);
    expect(screen.getByRole('heading', { name: 'In the app or on the website — the fastest way' })).toBeTruthy();
    expect(screen.getByText(/On the website, sign in at/)).toBeTruthy();
    const routes = screen.getAllByRole('listitem').map((li) => li.textContent);
    expect(routes).toEqual(expect.arrayContaining([
      'A store: Account, then Request account closure (owners) or Delete my account (managers and staff)',
      'A rider or driver: Account, then Delete my account',
      'A customer: Account, then Personal details, then Delete my account',
    ]));
    expect(screen.getByText(/A store owner closes the account by a request/).textContent).toMatch(/stops taking new orders as soon as the request is sent; orders already placed still finish, and cancelling the request lifts the pause/);
    // Still no one-click form: the page itself deletes nothing.
    expect(screen.queryByRole('button')).toBeNull();
  });
});
