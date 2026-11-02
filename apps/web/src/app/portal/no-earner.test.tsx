import { screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import PortalHome from './page';
import { mockApi, renderWithQuery } from '@/test/test-utils';

// [WEB-ONBOARDING · FLOW-QA F27] A business-only account that opens the earner office was told to "start driving or
// delivering from the Swift app", which partners do not have yet. It now gets the website's own doors: deliver with
// Swift (/signup?as=rider) or drive a taxi (/signup?as=driver).
afterEach(() => { vi.unstubAllGlobals(); });

describe('[F27] no earner profile: the website’s rider and driver doors', () => {
  it('links to both doors', async () => {
    mockApi(({ url }) => {
      const path = url.pathname.replace('/api/v1', '');
      if (path === '/rider/profile' || path === '/driver/profile') return { status: 404, body: { success: false } };
      if (path.startsWith('/services/providers') || path.startsWith('/provider')) return { status: 404, body: { success: false } };
      return { status: 404, body: { success: false } };
    });
    renderWithQuery(<PortalHome />);
    expect((await screen.findByRole('link', { name: 'Deliver with Swift' })).getAttribute('href')).toBe('/signup?as=rider');
    expect(screen.getByRole('link', { name: 'Drive a taxi with Swift' }).getAttribute('href')).toBe('/signup?as=driver');
    expect(screen.queryByText(/from the Swift app/)).toBeNull();
  });
});
