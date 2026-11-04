import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mockApi } from '@/test/test-utils';

// [PORTAL-404 · REVIEW-F3 #2315 S4-1] The page every partner lands on after paying through MMG (/weekly-fee) asked
// GET /services/providers/me, a 404 in the console for everyone who is not a pro. It now asks /auth/me's
// `profiles.provider` (the same answer the session check reads). Synthetic data only.
vi.mock('next/navigation', () => ({ useRouter: () => ({ replace: vi.fn() }) }));
import { WeeklyFeeDestination } from './weekly-fee-destination';

afterEach(() => { vi.unstubAllGlobals(); });

describe('[F29] the MMG return page asks /auth/me whether the account is a pro', () => {
  it('a customer who is not a pro: told there is no fee, and no provider request', async () => {
    const asked: string[] = [];
    mockApi(({ url }) => {
      asked.push(url.pathname);
      if (url.pathname === '/api/v1/auth/me') return { body: { success: true, data: { user: { id: 'c1', roles: ['CUSTOMER'] }, profiles: { rider: false, driver: false, provider: false } } } };
      if (url.pathname === '/api/v1/services/providers/me') return { status: 404, body: { success: false } };
      throw new Error(`Unexpected request: ${url.pathname}`);
    });
    render(<WeeklyFeeDestination />);
    expect(await screen.findByText('No business or earner profile on this account.')).toBeTruthy();
    expect(asked).not.toContain('/api/v1/services/providers/me');
  });
});
