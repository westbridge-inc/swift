import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mockApi, renderWithQuery, type ApiRequest } from '@/test/test-utils';
import SellerStatusPage from './page';
import { TIER_WORDS } from './tier-words';

// ---------------------------------------------------------------------------
// [WEB-SETTINGS PR-B · owner 31 Oct 2026] Seller status on the website, as the phone's VendorTierScreen: GET
// /vendor/tier, read-only, in the phone's words (its tier-view module). Managers and owners (the server's rule).
// Synthetic values only.
// ---------------------------------------------------------------------------

const CAPPED = {
  tier: 'UNREGISTERED', capped: true, nearCap: true, promotedPlacement: false,
  caps: { ordersPerDay: 20, grossPerWeek: 100000, nudgeAtFraction: 0.8 },
  usage: { ordersToday: 17, grossThisWeek: 25000 },
  registration: { onFile: false, submission: { status: 'PENDING', submittedAt: '2026-10-30T12:00:00.000Z' } },
  declaration: { status: 'APPROVED', signedAt: '2026-10-01T12:00:00.000Z', expiresAt: '2027-10-01T00:00:00.000Z' },
};
const REGISTERED = {
  ...CAPPED, tier: 'REGISTERED', capped: false, nearCap: false, promotedPlacement: true,
  registration: { onFile: true, recordId: 'rec-1' }, declaration: null,
};

function api(opts: { role?: string; roleFail?: boolean; tier?: unknown; fail?: boolean } = {}) {
  return mockApi(({ url }: ApiRequest) => {
    const path = url.pathname.replace('/api/v1', '');
    if (path === '/vendor/stores' && opts.roleFail) return { status: 500, body: { success: false, error: { code: 'INTERNAL', message: 'Something went wrong' } } };
    if (path === '/vendor/stores') return { body: { success: true, data: { stores: [{ id: 'store-1', name: 'Sample Kitchen' }], selectedId: 'store-1', myRole: opts.role ?? 'OWNER' } } };
    if (path === '/vendor/tier') {
      if (opts.fail) return { status: 500, body: { success: false, error: { code: 'INTERNAL', message: 'Something went wrong' } } };
      return { body: { success: true, data: opts.tier ?? CAPPED } };
    }
    return { body: { success: true, data: {} } };
  });
}

beforeEach(async () => {
  (await import('@/lib/auth')).setSelectedStore('store-1');
});

describe('[WEB-SETTINGS PR-B] seller status (web)', () => {
  it('a capped store: its tier, both limits with their bars, the near-limit warning and how to lift them', async () => {
    api();
    renderWithQuery(<SellerStatusPage />);
    expect(await screen.findByText('Unregistered seller — limits apply')).toBeTruthy();
    expect(screen.getByText('Orders today: 17 of 20')).toBeTruthy();
    expect(screen.getByText(/^Sales this week: .*25,000 of .*100,000$/)).toBeTruthy();
    const orders = screen.getByRole('progressbar', { name: 'Orders today' });
    expect(orders.getAttribute('aria-valuenow')).toBe('85');
    expect((orders.firstElementChild as HTMLElement).className).toContain('amber');
    const sales = screen.getByRole('progressbar', { name: 'Sales this week' });
    expect(sales.getAttribute('aria-valuenow')).toBe('25');
    expect((sales.firstElementChild as HTMLElement).className).not.toContain('amber');
    expect(screen.getByRole('alert').textContent).toBe(TIER_WORDS.near);
    expect(screen.getByText('Business registration submitted — under review.')).toBeTruthy();
    expect(screen.getByText('Self-declaration approved · valid to 1 Oct 2027')).toBeTruthy();
    for (const step of TIER_WORDS.steps) expect(screen.getByText(step)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Documents' }).getAttribute('href')).toBe('/dashboard/documents');
    expect(screen.getByRole('link', { name: 'Need help registering? Ask a person' }).getAttribute('href')).toBe('/contact');
  });

  it('a registered store: no limits, no steps', async () => {
    api({ tier: REGISTERED });
    renderWithQuery(<SellerStatusPage />);
    expect(await screen.findByText('Registered seller')).toBeTruthy();
    expect(screen.getByText(TIER_WORDS.noLimits)).toBeTruthy();
    expect(screen.getByText('Business registration on file.')).toBeTruthy();
    expect(screen.queryByRole('progressbar')).toBeNull();
    expect(screen.queryByText('How to lift the limits')).toBeNull();
  });

  it('a manager is not sent to Documents (the owner\'s page)', async () => {
    api({ role: 'MANAGER' });
    renderWithQuery(<SellerStatusPage />);
    expect(await screen.findByText('How to lift the limits')).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Documents' })).toBeNull();
  });

  it('a failed read says so and shows no tier', async () => {
    api({ fail: true });
    renderWithQuery(<SellerStatusPage />);
    expect(await screen.findByRole('button', { name: /Try again|Retry/ })).toBeTruthy();
    expect(screen.queryByText(/seller —|Registered seller/)).toBeNull();
  });

  // [REVIEW-F #2281 S4-1]
  it('a failed role read says so, never "Checking…" for ever', async () => {
    api({ roleFail: true });
    renderWithQuery(<SellerStatusPage />);
    expect(await screen.findByRole('button', { name: /Try again|Retry/ })).toBeTruthy();
    expect(screen.queryByText('Checking your seller status…')).toBeNull();
  });

  it('staff are told who sees it, and nothing is read', async () => {
    const fetchMock = api({ role: 'STAFF' });
    renderWithQuery(<SellerStatusPage />);
    expect(await screen.findByText(TIER_WORDS.staff)).toBeTruthy();
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes('/vendor/tier'))).toBe(false);
    vi.unstubAllGlobals();
  });

  it('every sentence is the phone\'s own (VendorTierScreen)', () => {
    const phone = readFileSync(join(process.cwd(), '..', 'mobile', 'src', 'modules', 'vendor', 'screens', 'VendorTierScreen.tsx'), 'utf8');
    for (const words of [TIER_WORDS.near, TIER_WORDS.promotedLater, TIER_WORDS.noLimits, ...TIER_WORDS.steps, 'Seller status', 'Your tier',
      'Business registration', 'How to lift the limits', 'Need help registering? Ask a person']) {
      expect(phone, words).toContain(words);
    }
  });
});
