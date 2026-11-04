import { screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import PortalHome from './page';
import { mockApi, renderWithQuery } from '@/test/test-utils';

// [WEB-ONBOARDING · FLOW-QA F27] A business-only account that opens the earner office was told to "start driving or
// delivering from the Swift app", which partners do not have yet. It now gets the website's own doors: deliver with
// Swift or drive a taxi, through the sign-up's resume door for a signed-in account (/signup?resume=mover).
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
    // [REVIEW-LIGHT2 #2309 F S3] a signed-in account adds its vehicle on the sign-up's resume door (the partner door
    // would show "Go to your dashboard"): it picks deliveries or taxi there, then its vehicle
    expect((await screen.findByRole('link', { name: 'Add your vehicle: deliver or drive a taxi with Swift' })).getAttribute('href')).toBe('/signup?resume=mover');
    expect(screen.queryByText(/from the Swift app/)).toBeNull();
  });
});
