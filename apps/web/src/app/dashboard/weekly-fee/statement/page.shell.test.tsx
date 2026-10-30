import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChainStatement } from '@/lib/chain-statement';

// [ENTERPRISE E3 · REVIEW-F #2228 9a10328f S3-1] The statement page inside the real console shell: it shares the
// shell's ONE role read (same key, same shape), so the owner sees the statement AND keeps the owner's whole menu, and
// a manager is told only the owner sees it. A second read of another shape under the same key broke both.

const fx = vi.hoisted(() => ({ getStores: vi.fn(), getChainStatement: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ replace: vi.fn(), push: vi.fn() }), usePathname: () => '/dashboard/weekly-fee/statement' }));
vi.mock('@/lib/auth', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/auth')>();
  return { ...real, sessionProbe: vi.fn().mockResolvedValue({ ok: true, user: { id: 'u1' } }), setSelectedStore: vi.fn() };
});
vi.mock('@/lib/vendor-api', async (importOriginal) => ({ ...(await importOriginal<typeof import('@/lib/vendor-api')>()), getStores: fx.getStores }));
vi.mock('@/lib/chain-statement', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/chain-statement')>()), getChainStatement: fx.getChainStatement, lastGuyanaMonth: () => '2026-10',
}));

import { DashboardShell } from '../../dashboard-shell';
import FeeStatementPage from './page';

const statement: ChainStatement = {
  month: '2026-10', from: '2026-10-01T04:00:00.000Z', to: '2026-11-01T04:00:00.000Z',
  issuer: { name: 'Sample Operator Inc.', tradingAs: 'Swift', registrationNo: 'R-1', registeredOffice: 'Sample office', tin: null },
  billedTo: { name: 'Sample Owner', email: null, phone: null }, currencyCode: 'GYD', deal: null, branches: [],
  totals: { weeksCharged: 0, received: 0, owedNow: 0 }, vatNote: 'Not a VAT invoice', generatedAt: '2026-11-02T12:00:00.000Z',
};
const store = { id: 'north', name: 'Royal North', vendorType: 'RESTAURANT', isCurrentlyOpen: true, acceptingOrders: true, city: null, isVerified: true, status: 'ACTIVE', awaitingApproval: false, goLive: null };

beforeEach(() => {
  fx.getStores.mockReset();
  fx.getChainStatement.mockReset().mockResolvedValue(statement);
  window.localStorage.setItem('swift_web_store', 'north');
});

describe('[E3] the fee statement in the console', () => {
  it('the owner sees the statement and keeps the owner menu (Insights)', async () => {
    fx.getStores.mockResolvedValue({ stores: [store], selectedId: 'north', myRole: 'OWNER' });
    render(<DashboardShell><FeeStatementPage /></DashboardShell>);
    expect(await screen.findByRole('article', { name: 'Fee statement for 2026-10' })).toBeTruthy();
    expect(screen.getAllByRole('link', { name: /Insights/ }).length).toBeGreaterThan(0);
    expect(screen.queryByText('Only the business owner sees the fee statement.')).toBeNull();
  });

  it('a manager is told only the owner sees it; the statement is never asked for', async () => {
    fx.getStores.mockResolvedValue({ stores: [store], selectedId: 'north', myRole: 'MANAGER' });
    render(<DashboardShell><FeeStatementPage /></DashboardShell>);
    expect(await screen.findByText('Only the business owner sees the fee statement.')).toBeTruthy();
    expect(fx.getChainStatement).not.toHaveBeenCalled();
  });
});
