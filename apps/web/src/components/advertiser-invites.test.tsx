import { describe, expect, it } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import { mockApi, renderWithQuery } from '@/test/test-utils';
import AdvertiserPage from '@/app/advertiser/page';

// [ADS-ON · owner ruling, 3 Nov] Advertiser team invitations are answered on the website: no new app build.
// The screen says what the notice said (the company and the role), nothing is granted until Accept, and
// Decline removes the invitation. The server has held all of that since #1995; this is its only door.

const invite = { advertiserId: 'a 1', companyName: 'Roti Shop', role: 'MANAGER', invitedAt: '2026-11-01T00:00:00.000Z' };

function api(state: { invites: unknown[]; memberships?: unknown[] }, onAnswer?: (_path: string) => { status?: number; body?: unknown } | undefined) {
  return mockApi(({ url, method }) => {
    if (url.pathname === '/api/v1/ads/advertiser/invites') return { body: { success: true, data: state.invites } };
    if (url.pathname === '/api/v1/ads/advertiser/me') return { body: { success: true, data: state.memberships ?? [] } };
    if (method === 'POST') {
      const replied = onAnswer?.(url.pathname);
      if (replied) return { status: replied.status ?? 200, body: replied.body ?? { success: true, data: {} } };
    }
    return { body: { success: true, data: [] } };
  });
}
const posts = (fetchMock: ReturnType<typeof mockApi>) => fetchMock.mock.calls
  .filter(([, init]) => init?.method === 'POST')
  .map(([input]) => new URL(String(input)).pathname);

describe('a team invitation on the website', () => {
  it('names the company and the role, as the notice did, and says nothing changes until you accept', async () => {
    api({ invites: [invite] });
    renderWithQuery(<AdvertiserPage />);
    const card = await screen.findByRole('group', { name: 'Team invitation from Roti Shop' });
    expect(card.textContent).toContain('Roti Shop invited you to join their advertiser team as a manager.');
    expect(card.textContent).toContain('Nothing changes unless you accept.');
    expect(within(card).getByRole('button', { name: 'Accept' })).toBeTruthy();
    expect(within(card).getByRole('button', { name: 'Decline' })).toBeTruthy();
  });

  it('an analyst invitation says analyst, never the server code', async () => {
    api({ invites: [{ ...invite, role: 'ANALYST' }] });
    renderWithQuery(<AdvertiserPage />);
    const card = await screen.findByRole('group', { name: 'Team invitation from Roti Shop' });
    expect(card.textContent).toContain('as an analyst.');
    expect(card.textContent).not.toContain('ANALYST');
  });

  it('Accept goes to the endpoint that grants it, with the id encoded, and the account appears', async () => {
    const state = { invites: [invite] as unknown[], memberships: [] as unknown[] };
    const fetchMock = api(state, () => {
      state.invites = [];
      state.memberships = [{ id: 'a 1', companyName: 'Roti Shop', status: 'APPROVED', memberRole: 'MANAGER' }];
      return {};
    });
    const { user } = renderWithQuery(<AdvertiserPage />);
    await user.click(await screen.findByRole('button', { name: 'Accept' }));
    await waitFor(() => expect(posts(fetchMock)).toEqual(['/api/v1/ads/advertiser/a%201/members/accept']));
    await waitFor(() => expect(screen.queryByRole('group', { name: /Team invitation/ })).toBeNull());
    expect(await screen.findByRole('heading', { name: 'Roti Shop' })).toBeTruthy();
  });

  it('Decline goes to the endpoint that removes it, grants nothing, and the invitation is gone', async () => {
    const state = { invites: [invite] as unknown[] };
    const fetchMock = api(state, () => { state.invites = []; return {}; });
    const { user } = renderWithQuery(<AdvertiserPage />);
    await user.click(await screen.findByRole('button', { name: 'Decline' }));
    await waitFor(() => expect(posts(fetchMock)).toEqual(['/api/v1/ads/advertiser/a%201/members/decline']));
    await waitFor(() => expect(screen.queryByRole('group', { name: /Team invitation/ })).toBeNull());
    expect(screen.queryByRole('heading', { name: 'Roti Shop' })).toBeNull();
  });

  it('an invitation that ran out says so, and leaves the screen', async () => {
    const state = { invites: [invite] as unknown[] };
    api(state, () => { state.invites = []; return { status: 404, body: { success: false, error: { code: 'NOT_FOUND', message: 'Invitation not found' } } }; });
    const { user } = renderWithQuery(<AdvertiserPage />);
    await user.click(await screen.findByRole('button', { name: 'Accept' }));
    expect((await screen.findByRole('alert')).textContent).toContain('This invitation is no longer open.');
    await waitFor(() => expect(screen.queryByRole('group', { name: /Team invitation/ })).toBeNull());
  });

  it('a failure that is not ours to explain never pretends it worked: the invitation stays', async () => {
    api({ invites: [invite] }, () => ({ status: 503, body: { success: false, error: { code: 'INTERNAL', message: 'Down' } } }));
    const { user } = renderWithQuery(<AdvertiserPage />);
    await user.click(await screen.findByRole('button', { name: 'Accept' }));
    expect((await screen.findByRole('alert')).textContent).toContain('That did not go through. Nothing changed. Try again.');
    expect(screen.getByRole('group', { name: 'Team invitation from Roti Shop' })).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Accept' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('one tap is one answer: both buttons wait while it goes through', async () => {
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => { release = resolve; });
    mockApi(async ({ url, method }) => {
      if (method === 'POST') { await held; return { body: { success: true, data: {} } }; }
      return { body: { success: true, data: url.pathname.endsWith('/invites') ? [invite] : [] } };
    });
    const { user } = renderWithQuery(<AdvertiserPage />);
    await user.click(await screen.findByRole('button', { name: 'Accept' }));
    await waitFor(() => expect((screen.getByRole('button', { name: 'Accept' }) as HTMLButtonElement).disabled).toBe(true));
    expect((screen.getByRole('button', { name: 'Decline' }) as HTMLButtonElement).disabled).toBe(true);
    release();
  });

  it('with no invitation there is nothing on the page about one', async () => {
    api({ invites: [] });
    renderWithQuery(<AdvertiserPage />);
    await screen.findByRole('heading', { name: 'Your business can advertise here' });
    expect(screen.queryByRole('group', { name: /Team invitation/ })).toBeNull();
  });

  it('while ads are off the page says Swift Ads is not open, once, and offers no invitation', async () => {
    mockApi(() => ({ status: 403, body: { success: false, error: { code: 'ADS_DISABLED', message: 'Advertising is currently unavailable.' } } }));
    renderWithQuery(<AdvertiserPage />);
    expect(await screen.findByRole('heading', { name: 'Swift Ads is not open yet' })).toBeTruthy();
    expect(screen.queryByRole('group', { name: /Team invitation/ })).toBeNull();
    expect(screen.queryByText(/could not/i)).toBeNull();
  });

  it('when the invitations cannot be read it says so, and the campaigns still show', async () => {
    mockApi(({ url }) => {
      if (url.pathname === '/api/v1/ads/advertiser/invites') return { status: 503, body: { success: false, error: { code: 'INTERNAL', message: 'Down' } } };
      return { body: { success: true, data: [] } };
    });
    renderWithQuery(<AdvertiserPage />);
    expect(await screen.findByText(/your team invitations/)).toBeTruthy();
    expect(await screen.findByRole('heading', { name: 'Your business can advertise here' })).toBeTruthy();
  });
});
