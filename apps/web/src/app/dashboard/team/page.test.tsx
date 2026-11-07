import { screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { mockApi, renderWithQuery, type ApiRequest } from '@/test/test-utils';
import TeamPage from './page';

// ---------------------------------------------------------------------------
// [CHAINS PR2 · owner 29 Oct 2026] The team on the website (the phone's Account > Team). One person can join several
// branches in one step (vendorIds: this branch and the ones ticked). Adding asks this browser to confirm it's you.
// The server's words are shown as they come (its daily allowance included).
// ---------------------------------------------------------------------------

const writes: Array<{ method: string; path: string; body: unknown }> = [];
function api(opts: { role?: string; stepUp?: boolean; cap?: boolean } = {}) {
  let stepped = !opts.stepUp;
  return mockApi(({ method, url, init }: ApiRequest) => {
    const path = url.pathname.replace('/api/v1', '');
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    if (method !== 'GET') writes.push({ method, path, body });
    if (path === '/vendor/stores') return { body: { success: true, data: { stores: [
      { id: 'north', name: 'Royal North', vendorType: 'RESTAURANT', isCurrentlyOpen: true, acceptingOrders: true, city: null, isVerified: true, status: 'ACTIVE', awaitingApproval: false },
      { id: 'camp', name: 'Royal Camp', vendorType: 'RESTAURANT', isCurrentlyOpen: true, acceptingOrders: true, city: null, isVerified: true, status: 'ACTIVE', awaitingApproval: false },
      { id: 'east', name: 'Royal East', vendorType: 'RESTAURANT', isCurrentlyOpen: false, acceptingOrders: false, city: null, isVerified: false, status: 'PENDING_APPROVAL', awaitingApproval: true },
      { id: 'south', name: 'Royal South', vendorType: 'RESTAURANT', isCurrentlyOpen: false, acceptingOrders: false, city: null, isVerified: true, status: 'SUSPENDED', awaitingApproval: false },
      { id: 'old', name: 'Royal Old', vendorType: 'RESTAURANT', isCurrentlyOpen: false, acceptingOrders: false, city: null, isVerified: true, status: 'CLOSED', awaitingApproval: false },
    ], selectedId: 'north', myRole: opts.role ?? 'OWNER' } } };
    if (path === '/vendor/staff' && method === 'GET') return { body: { success: true, data: [{ id: 'm1', role: 'MANAGER', user: { firstName: 'Ann', lastName: null, phone: '+5926000001' } }] } };
    if (path === '/auth/step-up') return { body: { success: true, data: { sentTo: '+592 ••• 1234' } } };
    if (path === '/auth/step-up/verify') { stepped = true; return { body: { success: true, data: {} } }; }
    if (path === '/vendor/staff' && method === 'POST') {
      if (!stepped) return { status: 403, body: { success: false, error: { code: 'STEP_UP_REQUIRED', message: 'Confirm it’s you first.' } } };
      if (opts.cap) return { status: 429, body: { success: false, error: { code: 'STAFF_ADD_DAILY_LIMIT', message: 'You can add up to 10 team members a day. Try again tomorrow.' } } };
      return { body: { success: true, data: { status: 'SENT_IF_ACCOUNT', role: body.role, message: 'If this number has a Swift account, they will get an invite to join your team.' } } };
    }
    return { body: { success: true, data: {} } };
  });
}

beforeEach(async () => {
  writes.length = 0;
  (await import('@/lib/auth')).setSelectedStore('north');
});

describe('[CHAINS] the team page (web)', () => {
  it('adds one person to this branch and the ticked branches in one step, after confirming it\'s you', async () => {
    api({ stepUp: true });
    const { user } = renderWithQuery(<TeamPage />);
    expect(await screen.findByText('Ann')).toBeTruthy();
    expect(screen.queryByRole('checkbox', { name: /Royal East/ }), 'a branch waiting for approval takes no team yet').toBeNull();
    // [REVIEW-F #2220 S4-3] nor a suspended or closed one (the server refuses the whole add)
    expect(screen.queryByRole('checkbox', { name: /Royal South/ })).toBeNull();
    expect(screen.queryByRole('checkbox', { name: /Royal Old/ })).toBeNull();
    await user.type(screen.getByLabelText('Their phone'), '+5926001111');
    await user.click(screen.getByRole('radio', { name: 'Manager' }));
    await user.click(await screen.findByRole('checkbox', { name: 'Royal Camp' }));
    await user.click(screen.getByRole('button', { name: 'Add to team' }));
    await user.type(await screen.findByLabelText('Code'), '654321');
    expect(await screen.findByText('If this number has a Swift account, they will get an invite to join your team.')).toBeTruthy();
    const adds = writes.filter((w) => w.path === '/vendor/staff');
    expect(adds).toHaveLength(2);
    expect(adds[1]!.body).toEqual({ phone: '+5926001111', role: 'MANAGER', vendorIds: ['north', 'camp'] });
  });

  it('with no other branch ticked, only this branch (no vendorIds); the server\'s daily-allowance words are shown', async () => {
    api({ cap: true });
    const { user } = renderWithQuery(<TeamPage />);
    await user.type(await screen.findByLabelText('Their phone'), '+5926001111');
    await user.click(screen.getByRole('button', { name: 'Add to team' }));
    expect(await screen.findByText('You can add up to 10 team members a day. Try again tomorrow.')).toBeTruthy();
    expect(writes.find((w) => w.path === '/vendor/staff')?.body).toEqual({ phone: '+5926001111', role: 'STAFF' });
  });

  it('closing the confirmation is not an error', async () => {
    api({ stepUp: true });
    const { user } = renderWithQuery(<TeamPage />);
    await user.type(await screen.findByLabelText('Their phone'), '+5926001111');
    await user.click(screen.getByRole('button', { name: 'Add to team' }));
    await user.click(await screen.findByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByLabelText('Code')).toBeNull());
    expect(screen.queryAllByRole('alert').map((a) => a.textContent)).toEqual([]);
  });

  it('a manager does not manage the team', async () => {
    api({ role: 'MANAGER' });
    renderWithQuery(<TeamPage />);
    expect(await screen.findByText('The team is managed by the store owner.')).toBeTruthy();
  });
});
