import { screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import PortalHome from './page';
import PortalHistory from './history/page';
import MoverWeeklyFeePage from './weekly-fee/page';
import { holdsMoverRole } from '@/lib/partner-profiles';
import { mockApi, renderWithQuery } from '@/test/test-utils';

vi.mock('@/lib/partner-profiles', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/partner-profiles')>();
  return { ...actual, holdsMoverRole: vi.fn(actual.holdsMoverRole) };
});

// A MOVER account that stopped before the vehicle step has no Rider and no Driver profile. The office said "No earner
// profile on this account." with a small underlined link, which reads like a dead end. It now says what is left, with a
// real button to the same door. Any account without the MOVER role keeps the words it had.
afterEach(() => { vi.unstubAllGlobals(); });

const ABSENT = { status: 404, body: { success: false, error: { message: 'Absent' } } };
const account = (roles: string[], provider = false) => ({ url }: { url: URL }) => {
  const path = url.pathname.replace('/api/v1', '');
  if (path === '/auth/me') return { body: { success: true, data: { user: { id: 'u1', roles }, profiles: { rider: false, driver: false, provider } } } };
  if (path === '/provider/subscription' && provider) return { body: { success: true, data: null, standing: { required: false, operable: true }, coveredBy: null } };
  return ABSENT;
};

const WORDS = 'You still need to choose rider or driver and add your vehicle.';

describe.each([
  ['Earnings', PortalHome],
  ['History', PortalHistory],
  ['Weekly fee', MoverWeeklyFeePage],
])('%s for an account with no rider or driver profile', (_page, Page) => {
  it('a MOVER is told what is left, with a real button to the vehicle step', async () => {
    mockApi(account(['CUSTOMER', 'MOVER']));
    renderWithQuery(<Page />);
    expect(await screen.findByText(WORDS)).toBeTruthy();
    const button = screen.getByRole('link', { name: 'Choose rider or driver' });
    expect(button.getAttribute('href')).toBe('/signup?resume=mover');
    expect(button.className).toContain('sw-btn sw-btn-md');
    expect(screen.queryByText(/No earner profile/)).toBeNull();
  });

  it('an account without the MOVER role keeps the old sentence', async () => {
    mockApi(account(['CUSTOMER', 'VENDOR_OWNER']));
    renderWithQuery(<Page />);
    expect(await screen.findByText(/No earner profile on this account\./)).toBeTruthy();
    expect(screen.queryByText(WORDS)).toBeNull();
  });

  it('when /auth/me cannot answer, the old sentence, never a guess', async () => {
    mockApi(({ url }) => (url.pathname === '/api/v1/auth/me' ? { status: 500, body: { success: false } } : ABSENT));
    renderWithQuery(<Page />);
    expect(await screen.findByText(/No earner profile on this account\./)).toBeTruthy();
    expect(screen.queryByText(WORDS)).toBeNull();
  });
});

describe('while the role is still being read', () => {
  it('neither sentence shows: a mover never sees the old dead end first', async () => {
    let answer: ((_mover: boolean) => void) | undefined;
    vi.mocked(holdsMoverRole).mockImplementationOnce(() => new Promise<boolean>((resolve) => { answer = resolve; }));
    mockApi(account(['CUSTOMER', 'MOVER']));
    renderWithQuery(<PortalHistory />);
    await vi.waitFor(() => expect(answer).toBeDefined());
    await new Promise((resolve) => { setTimeout(resolve, 50); });
    expect(screen.queryByText(/No earner profile/)).toBeNull();

    answer!(true);
    expect(await screen.findByText(WORDS)).toBeTruthy();
  });
});

describe('a pro', () => {
  it.each([['Earnings', PortalHome], ['History', PortalHistory]])('%s: keeps the pro words', async (_page, Page) => {
    mockApi(account(['CUSTOMER'], true));
    renderWithQuery(<Page />);
    expect(await screen.findByText(/^Earnings and history here are for deliveries and taxi rides/)).toBeTruthy();
    expect(screen.queryByText(WORDS)).toBeNull();
  });
});
