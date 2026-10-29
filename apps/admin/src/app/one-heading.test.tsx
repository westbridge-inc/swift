import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { MoverDetail } from '@/components/MoverDetail';
import { mockApi, renderWithQuery } from '@/test/test-utils';
import NotFound from './not-found';

// ---------------------------------------------------------------------------
// [ADMIN-AUDIT S4-2] The shell's header is the page's one h1 (the page's name). The rider/driver page added a second
// h1 (the person's name), and an unknown address showed Next's default 404 (its own h1, no way back) inside the shell.
// The person's name is an h2; an unknown address says so in Mission Control's words, with a door back to Today.
// ---------------------------------------------------------------------------

describe('[ADMIN-AUDIT S4-2] one h1 per page', () => {
  it('the rider page names the person in an h2, never a second h1', async () => {
    mockApi((r) => {
      if (r.url.pathname === '/api/v1/admin/riders/rider-1') return { body: { success: true, data: {
        id: 'rider-1', riderType: 'DELIVERY', vehicleType: 'MOTORCYCLE', documentsVerified: false, isOnline: false, averageRating: 5, totalRatings: 0,
        totalDeliveries: 0, subscription: null, earnings: [], _count: { orders: 0, earnings: 0 },
        user: { id: 'user-rider', firstName: 'Test', lastName: 'Rider', status: 'ACTIVE', createdAt: '2026-09-01T12:00:00.000Z' },
      } } };
      return { body: { success: true, data: null } };
    });
    renderWithQuery(<MoverDetail id="rider-1" kind="rider" />);
    expect((await screen.findByRole('heading', { level: 2, name: /Test Rider/ }))).toBeTruthy();
    expect(screen.queryAllByRole('heading', { level: 1 })).toHaveLength(0);
  });
  it('an unknown address says so, offers the way back, and adds no h1', () => {
    render(<NotFound />);
    expect(screen.getByRole('heading', { level: 2, name: 'There is no page at this address' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Go to Today' }).getAttribute('href')).toBe('/dashboard');
    expect(screen.queryAllByRole('heading', { level: 1 })).toHaveLength(0);
  });
});
