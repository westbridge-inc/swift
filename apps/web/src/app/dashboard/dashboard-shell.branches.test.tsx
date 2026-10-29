import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// [CHAINS PR2 · owner 29 Oct 2026] The store switcher names a branch waiting for Swift's approval as such. (The
// Branches and Team pages are reached from Settings: every console page's first load stays where it was.)

const fx = vi.hoisted(() => ({ getStores: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ replace: vi.fn(), push: vi.fn() }), usePathname: () => '/dashboard/orders' }));
vi.mock('@/lib/auth', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/auth')>();
  return { ...real, sessionProbe: vi.fn().mockResolvedValue({ ok: true, user: { id: 'u1' } }), setSelectedStore: vi.fn() };
});
vi.mock('@/lib/vendor-api', () => ({ getStores: fx.getStores }));

import { DashboardShell } from './dashboard-shell';

const row = (id: string, name: string, waiting = false) => ({
  id, name, vendorType: 'RESTAURANT', isCurrentlyOpen: true, acceptingOrders: true, city: null, isVerified: !waiting,
  status: waiting ? 'PENDING_APPROVAL' : 'ACTIVE', awaitingApproval: waiting,
});

beforeEach(async () => {
  fx.getStores.mockReset();
  window.localStorage.setItem('swift_web_store', 'north');
});

describe('[CHAINS] the store switcher', () => {
  it('a branch waiting for approval says so', async () => {
    fx.getStores.mockResolvedValue({ stores: [row('north', 'Royal North'), row('camp', 'Royal Camp', true)], selectedId: 'north', myRole: 'OWNER' });
    const { container } = render(<DashboardShell><p>console</p></DashboardShell>);
    await screen.findAllByText('Royal North');
    for (const button of screen.getAllByRole('button', { name: /Royal North/ })) button.click();
    await waitFor(() => expect(container.ownerDocument.body.textContent).toContain('Royal Camp · waiting for Swift’s approval'));
  });

  it('an approved store reads by its name alone', async () => {
    fx.getStores.mockResolvedValue({ stores: [row('north', 'Royal North')], selectedId: 'north', myRole: 'STAFF' });
    const { container } = render(<DashboardShell><p>console</p></DashboardShell>);
    await screen.findAllByText('Royal North');
    expect(container.ownerDocument.body.textContent).not.toContain('waiting for Swift');
  });
});
