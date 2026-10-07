import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// A business account that has not created its store yet: the server answers
// GET /vendor/stores with 404 (no store), which is a step still to do, not a
// failure. The console says so and links back to the business step, instead
// of "Couldn't load your stores".
// ---------------------------------------------------------------------------

const fx = vi.hoisted(() => ({ getStores: vi.fn(), replace: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ replace: fx.replace, push: vi.fn() }), usePathname: () => '/dashboard' }));
vi.mock('@/lib/auth', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/auth')>();
  return { ...real, sessionProbe: vi.fn().mockResolvedValue({ ok: true, user: { id: 'u1' } }), setSelectedStore: vi.fn() };
});
vi.mock('@/lib/vendor-api', () => ({ getStores: fx.getStores }));

import { ApiRequestError } from '@/lib/auth';
import { DashboardShell } from './dashboard-shell';

beforeEach(() => {
  fx.getStores.mockReset();
});

describe('business console before the store exists', () => {
  it('a 404 from the stores list is "finish setting up", linking to the business step — not an error', async () => {
    fx.getStores.mockRejectedValue(new ApiRequestError('Vendor not found', 404, 'NOT_FOUND'));
    render(<DashboardShell><p>console</p></DashboardShell>);
    const link = await screen.findByRole('link', { name: /Finish setting up your business/ });
    expect(link.getAttribute('href')).toBe('/signup?resume=business');
    expect(screen.queryByText(/Couldn.t load your stores/)).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('any other failure is still reported as one', async () => {
    fx.getStores.mockRejectedValue(new ApiRequestError('Server error', 500));
    render(<DashboardShell><p>console</p></DashboardShell>);
    // (one retry first, as for any request)
    expect((await screen.findAllByRole('alert', {}, { timeout: 5000 }))[0]!.textContent).toMatch(/Couldn.t load your stores/);
    expect(screen.queryByRole('link', { name: /Finish setting up your business/ })).toBeNull();
  });
});
