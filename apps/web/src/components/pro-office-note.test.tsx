import { screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import PortalHome from '@/app/portal/page';
import PortalHistory from '@/app/portal/history/page';
import { mockApi, renderWithQuery } from '@/test/test-utils';
import { ProviderFeeLink } from './pro-office-note';

// [REVIEW-F #2238 S4-1] A pro with no delivery or taxi profile signs in to the partner office: its Earnings and History
// pages never tell them "start driving or delivering"; they are told where their own weekly fee is.
// [REVIEW-M #2238 S4-2] A store owner who is also a pro finds their pro fee from the store's weekly-fee page.
afterEach(() => { vi.unstubAllGlobals(); });

const noMover = (path: string) => (path === '/api/v1/rider/profile' || path === '/api/v1/driver/profile' ? { status: 404, body: { success: false, error: { message: 'No profile' } } } : null);
const proView = { body: { success: true, data: null, standing: { required: false, operable: true }, coveredBy: null } };
const notPro = { status: 404, body: { success: false, error: { message: 'ServiceProvider not found' } } };
const PRO_WORDS = /^Earnings and history here are for deliveries and taxi rides\. As a service provider you take jobs in the Swift app/;

describe('the partner office for a pro with no delivery or taxi profile', () => {
  it('Earnings: the pro\'s words and the way to their weekly fee, never "start driving or delivering"', async () => {
    mockApi(({ url }) => noMover(url.pathname) ?? (url.pathname === '/api/v1/provider/subscription' ? proView : (() => { throw new Error(url.pathname); })()));
    renderWithQuery(<PortalHome />);
    expect(await screen.findByText(PRO_WORDS)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Your weekly fee' }).getAttribute('href')).toBe('/portal/weekly-fee');
    expect(screen.queryByText(/start driving or delivering/)).toBeNull();
  });

  it('History: the same', async () => {
    mockApi(({ url }) => noMover(url.pathname) ?? (url.pathname === '/api/v1/provider/subscription' ? proView : (() => { throw new Error(url.pathname); })()));
    renderWithQuery(<PortalHistory />);
    expect(await screen.findByText(PRO_WORDS)).toBeTruthy();
    expect(screen.queryByText('No earner profile on this account.')).toBeNull();
  });

  it('someone with no profile at all is told as before', async () => {
    mockApi(({ url }) => noMover(url.pathname) ?? (url.pathname === '/api/v1/provider/subscription' ? notPro : (() => { throw new Error(url.pathname); })()));
    renderWithQuery(<PortalHome />);
    expect(await screen.findByText(/No earner profile on this account — start driving or delivering/)).toBeTruthy();
  });
});

describe('a store owner who is also a pro', () => {
  it('the store\'s weekly-fee page links to their pro fee; nobody else sees the link', async () => {
    mockApi(({ url }) => (url.pathname === '/api/v1/services/providers/me' ? { body: { success: true, data: { id: 'sp1' } } } : (() => { throw new Error(url.pathname); })()));
    renderWithQuery(<ProviderFeeLink />);
    expect((await screen.findByRole('link', { name: 'Your service provider weekly fee' })).getAttribute('href')).toBe('/portal/weekly-fee');
    vi.unstubAllGlobals();
    mockApi(({ url }) => (url.pathname === '/api/v1/services/providers/me' ? { status: 404, body: { success: false } } : (() => { throw new Error(url.pathname); })()));
    const other = renderWithQuery(<ProviderFeeLink />);
    await new Promise((r) => setTimeout(r, 20));
    expect(other.container.querySelector('a')).toBeNull();
  });

  it('the store\'s weekly-fee page carries the link', () => {
    const page = readFileSync(join(__dirname, '..', 'app', 'dashboard', 'weekly-fee', 'page.tsx'), 'utf8');
    expect(page).toMatch(/<ProviderFeeLink \/>/);
  });
});
