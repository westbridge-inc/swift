import { describe, expect, it } from 'vitest';
import { screen, within, waitFor } from '@testing-library/react';
import { mockApi, renderWithQuery } from '@/test/test-utils';
import { AdvertiserCampaigns, CampaignRead } from './advertiser-campaigns';
import { Notifications } from './notifications';
import { BusinessStatus } from './business-status';
import InventoryPage from '@/app/dashboard/inventory/page';

const campaign = { id: 'c1', name: 'Lunch special', status: 'DRAFT', statusReason: null, placement: { name: 'Home card', key: 'HOME', tier: 'STANDARD', mediaKind: 'IMAGE' }, cities: ['Georgetown'], startWeek: '2026-10-05', endWeek: '2026-10-12', totalAmount: 2500, currency: 'GYD', invoices: [{ id: 'invoice1', number: 'ADS-1', status: 'PAID', amount: 2500 }], creatives: [], bookings: [] };
describe('partner read views and controls', () => {
  it('shows only server memberships and links each campaign to its own advertiser', async () => {
    mockApi(({ url }) => ({ body: { success: true, data: url.pathname.endsWith('/me') ? [{ id: 'a1', companyName: 'Test shop', status: 'APPROVED', memberRole: 'OWNER' }] : [campaign] } }));
    renderWithQuery(<AdvertiserCampaigns />);
    const link = await screen.findByRole('link', { name: /Lunch special/ });
    expect(link.getAttribute('href')).toBe('/advertiser/campaigns/a1/c1');
    expect(link.textContent).toContain('$2,500');
    expect(screen.queryByRole('button', { name: /New campaign/ })).toBeNull();
  });
  it('shows payment-record currency and no invented zero campaign price', async () => {
    mockApi(() => ({ body: { success: true, data: [{ ...campaign, totalAmount: null }] } }));
    renderWithQuery(<CampaignRead advertiserId="a1" campaignId="c1" />);
    await screen.findByText('Lunch special');
    expect(screen.getByText('GYD $2,500')).toBeTruthy();
    expect(screen.getByText('—')).toBeTruthy();
    expect(screen.queryByText('$0')).toBeNull();
  });
  it('does not present a failed campaign read as an empty account', async () => {
    mockApi(() => ({ status: 503, body: { success: false, error: { message: 'Unavailable' } } }));
    renderWithQuery(<AdvertiserCampaigns />);
    await screen.findByText(/Couldn’t load your advertising accounts|Couldn't load your advertising accounts/);
    expect(screen.queryByText('Your business can advertise here')).toBeNull();
  });
  it('reads notification pages without following untrusted payload links', async () => {
    const pages: string[] = [];
    mockApi(({ url }) => { pages.push(url.searchParams.get('page')!); return { body: { success: true, data: [{ id: 'n1', title: 'Order update', body: 'Your order is ready.', isRead: false, createdAt: '2026-10-04T12:00:00Z', data: { url: 'https://untrusted.test' } }], meta: { total: 21 } } }; });
    const view = renderWithQuery(<Notifications />);
    await screen.findByText('Order update');
    expect(screen.queryByRole('link')).toBeNull();
    await view.user.click(screen.getByRole('button', { name: 'Next' }));
    await waitFor(() => expect(pages).toEqual(['1', '2']));
    expect(screen.getByText('Page 2')).toBeTruthy();
  });
  it('pauses orders through the existing accepting-orders endpoint', async () => {
    const writes: unknown[] = [];
    mockApi(({ method, url, init }) => {
      if (method === 'PUT') { writes.push({ path: url.pathname, body: JSON.parse(String(init?.body)) }); return { body: { success: true } }; }
      return { body: { success: true, data: { vendor: { name: 'Test shop', isCurrentlyOpen: true, acceptingOrders: true }, today: { revenue: 2500 }, pendingOrders: 2 } } };
    });
    const view = renderWithQuery(<BusinessStatus />);
    await view.user.click(await screen.findByRole('button', { name: 'Pause orders' }));
    await waitFor(() => expect(writes).toEqual([{ path: '/api/v1/vendor/vendor/toggle-orders', body: { acceptingOrders: false } }]));
  });
  it('turns the selected menu item off without changing its stock count', async () => {
    const writes: unknown[] = [];
    mockApi(({ method, url, init }) => {
      if (method === 'PUT') { writes.push({ path: url.pathname, body: JSON.parse(String(init?.body)) }); return { body: { success: true } }; }
      return { body: { success: true, data: url.pathname.endsWith('/categories') ? [] : [{ id: 'rice', name: 'Rice', basePrice: '2500', isAvailable: true, stockQuantity: 4 }] } };
    });
    const view = renderWithQuery(<InventoryPage />);
    const item = await screen.findByRole('article', { name: 'Rice' });
    await view.user.click(within(item).getByRole('switch', { name: 'In stock: Rice' }));
    await waitFor(() => expect(writes).toEqual([{ path: '/api/v1/vendor/items/rice/availability', body: { isAvailable: false } }]));
  });
});
