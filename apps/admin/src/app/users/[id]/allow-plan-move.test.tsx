import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import UserDetailPage from './page';
import { fulfilledParams, mockApi, renderWithQuery, requestsByMethod } from '@/test/test-utils';

// [BUG-HUNT F05] The door "Contact support to move it to taxi work" points at.
const person = (extra: Record<string, unknown>) => ({
  id: 'user-1', firstName: 'Test', lastName: 'Rider', phone: 'person-phone', status: 'ACTIVE', roles: ['MOVER', 'CUSTOMER'],
  createdAt: '2026-08-01T00:00:00.000Z', lastActiveAt: null, isPhoneVerified: true, orders: [], strikes: [], addresses: [], _count: { orders: 0, strikes: 0 }, ...extra,
});
const REASON = 'Bought a car and sent the papers to support';

function serve(data: unknown) {
  return mockApi((request) => {
    if (request.method === 'GET' && request.url.pathname === '/api/v1/admin/users/user-1') return { body: { success: true, data } };
    if (request.method === 'POST') return { body: { success: true, data: {} } };
    return { body: { success: true, data: [] } };
  });
}

describe('[BUG-HUNT F05] Allow plan move', () => {
  it('a rider gets the door, it takes a reason, and it says what happens to the fee', async () => {
    const fetchMock = serve(person({ rider: { id: 'r1', documentsVerified: false } }));
    const { user } = renderWithQuery(<UserDetailPage params={fulfilledParams({ id: 'user-1' })} />);
    await user.click(await screen.findByRole('button', { name: 'Allow plan move…' }));
    const dialog = screen.getByRole('dialog', { name: /Let Test Rider move/ });
    expect(dialog.textContent).toContain('14 days’ notice');
    expect(dialog.textContent).toContain('No money moves');
    await user.type(within(dialog).getByRole('textbox', { name: 'Reason' }), REASON);
    await user.click(within(dialog).getByRole('button', { name: 'Allow the move' }));
    await waitFor(() => expect(requestsByMethod(fetchMock, 'POST')).toHaveLength(1));
    const [url, init] = requestsByMethod(fetchMock, 'POST')[0]!;
    expect(String(url)).toMatch(/\/users\/user-1\/mover-plan\/allow-move$/);
    expect((init?.headers as Record<string, string>)['x-swift-reason']).toBe(REASON);
  });

  it('someone with no rider or driver profile has nothing to move', async () => {
    serve(person({ roles: ['CUSTOMER'] }));
    renderWithQuery(<UserDetailPage params={fulfilledParams({ id: 'user-1' })} />);
    await screen.findByRole('button', { name: /Ban/ });
    expect(screen.queryByRole('button', { name: 'Allow plan move…' })).toBeNull();
  });
});
