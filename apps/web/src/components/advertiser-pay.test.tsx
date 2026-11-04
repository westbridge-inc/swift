import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { mockApi, renderWithQuery } from '@/test/test-utils';
import { CampaignRead } from './advertiser-campaigns';

// [ADS-ON · owner ruling, 3 Nov] An advertiser pays on MMG's checkout page, from the website. The server says whether
// an invoice can be paid and how much; the page never infers "paid" from anything but the server's own answer.

const campaign = (invoice: Record<string, unknown>) => ({
  id: 'c1', name: 'Lunch special', status: 'PENDING_PAYMENT', statusReason: null, placement: { name: 'Home card', key: 'HOME', tier: 'STANDARD', mediaKind: 'IMAGE' },
  cities: ['Georgetown'], startWeek: '2026-10-05T00:00:00.000Z', endWeek: '2026-10-11T00:00:00.000Z', totalAmount: 2500, currency: 'GYD',
  invoices: [{ id: 'inv/1', number: 'ADS-2026-000001', status: 'UNPAID', amount: 2500, payable: true, ...invoice }], creatives: [], bookings: [],
});
function api(invoice: Record<string, unknown>, answer?: () => { status?: number; body: unknown }) {
  return mockApi(({ method }) => (method === 'POST' && answer ? answer() : { body: { success: true, data: [campaign(invoice)] } }));
}
const assign = vi.fn();
beforeEach(() => { assign.mockClear(); vi.stubGlobal('location', { ...window.location, assign }); });
afterEach(() => { vi.unstubAllGlobals(); });
const posts = (fetchMock: ReturnType<typeof mockApi>) => fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST');
const page = { ref: 'r1', status: 'OPEN', checkoutUrl: 'https://mmg.example/page', amountGyd: 2500, currencyCode: 'GYD', expiresAt: '2026-10-05T00:30:00.000Z' };

describe('paying an ad invoice', () => {
  it('an invoice the server says can be paid offers MMG, and opens the page the server handed back', async () => {
    const fetchMock = api({}, () => ({ status: 201, body: { success: true, data: page } }));
    const { user } = renderWithQuery(<CampaignRead advertiserId="a1" campaignId="c1" />);
    await user.click(await screen.findByRole('button', { name: 'Pay with MMG' }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith('https://mmg.example/page'));
    const [input, init] = posts(fetchMock)[0]!;
    expect(new URL(String(input)).pathname).toBe('/api/v1/ads/invoices/inv%2F1/mmg-checkout');
    expect((init?.headers as Record<string, string>)['Idempotency-Key']).toMatch(/.{8,}/);
  });

  it.each([
    ['not payable', { payable: false }],
    ['paid', { status: 'PAID', payable: false }],
    ['from an older API', { payable: undefined }],
  ])('an invoice %s offers nothing', async (_w, invoice) => {
    api(invoice);
    renderWithQuery(<CampaignRead advertiserId="a1" campaignId="c1" />);
    await screen.findByText('ADS-2026-000001');
    expect(screen.queryByRole('button', { name: 'Pay with MMG' })).toBeNull();
  });

  it('a retry of the same tap carries the same key, so it can never open a second page', async () => {
    let n = 0;
    const fetchMock = api({}, () => { n += 1; return n === 1 ? { status: 503, body: { success: false, error: { code: 'MMG_CHECKOUT_UNAVAILABLE', message: 'x' } } } : { status: 200, body: { success: true, data: page } }; });
    const { user } = renderWithQuery(<CampaignRead advertiserId="a1" campaignId="c1" />);
    await user.click(await screen.findByRole('button', { name: 'Pay with MMG' }));
    expect((await screen.findByRole('alert')).textContent).toContain('MMG could not be opened');
    await user.click(screen.getByRole('button', { name: 'Pay with MMG' }));
    await waitFor(() => expect(assign).toHaveBeenCalled());
    const keys = posts(fetchMock).map(([, init]) => (init?.headers as Record<string, string>)['Idempotency-Key']);
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]);
  });

  it('a page that is no longer open is not opened: the server\'s word that it is being confirmed stands', async () => {
    api({}, () => ({ body: { success: true, data: { ...page, status: 'CONFIRMING', checkoutUrl: null } } }));
    const { user } = renderWithQuery(<CampaignRead advertiserId="a1" campaignId="c1" />);
    await user.click(await screen.findByRole('button', { name: 'Pay with MMG' }));
    expect((await screen.findByRole('alert')).textContent).toContain('being confirmed. Do not pay again.');
    expect(assign).not.toHaveBeenCalled();
  });

  it.each(['PAYMENT_CONFIRMING', 'CHECKOUT_CONFIRMING'])('%s says do not pay again, and the button leaves', async (code) => {
    api({}, () => ({ status: 409, body: { success: false, error: { code, message: 'x' } } }));
    const { user } = renderWithQuery(<CampaignRead advertiserId="a1" campaignId="c1" />);
    await user.click(await screen.findByRole('button', { name: 'Pay with MMG' }));
    expect((await screen.findByRole('alert')).textContent).toContain('Do not pay again.');
    expect(screen.queryByRole('button', { name: 'Pay with MMG' })).toBeNull();
  });

  it('an invoice that can no longer be paid says so, and the button leaves', async () => {
    api({}, () => ({ status: 409, body: { success: false, error: { code: 'INVOICE_NOT_PAYABLE', message: 'x' } } }));
    const { user } = renderWithQuery(<CampaignRead advertiserId="a1" campaignId="c1" />);
    await user.click(await screen.findByRole('button', { name: 'Pay with MMG' }));
    expect((await screen.findByRole('alert')).textContent).toContain('can no longer be paid. Do not pay again.');
    expect(screen.queryByRole('button', { name: 'Pay with MMG' })).toBeNull();
  });

  it('one tap, one request: the button waits while it goes through', async () => {
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => { release = resolve; });
    mockApi(async ({ method }) => {
      if (method === 'POST') { await held; return { body: { success: true, data: page } }; }
      return { body: { success: true, data: [campaign({})] } };
    });
    const { user } = renderWithQuery(<CampaignRead advertiserId="a1" campaignId="c1" />);
    await user.click(await screen.findByRole('button', { name: 'Pay with MMG' }));
    await waitFor(() => expect((screen.getByRole('button', { name: 'Pay with MMG' }) as HTMLButtonElement).disabled).toBe(true));
    release();
  });
});
