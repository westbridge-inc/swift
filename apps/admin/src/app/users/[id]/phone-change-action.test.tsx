import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import UserDetailPage from './page';
import { fulfilledParams, mockApi, renderWithQuery, requestsByMethod } from '@/test/test-utils';

// [BUG-HUNT F22] Moving an account to a new number: a second admin agrees, the code goes out, the person reads it back.
const person = {
  id: 'user-1', firstName: 'Test', lastName: 'Person', phone: 'person-phone', status: 'ACTIVE', roles: ['CUSTOMER'],
  createdAt: '2026-08-01T00:00:00.000Z', lastActiveAt: null, isPhoneVerified: true, orders: [], strikes: [], addresses: [], _count: { orders: 0, strikes: 0 },
};
const REASON = 'Read the old code back from the owner in person';

describe('[BUG-HUNT F22] Change number', () => {
  it('asks a second admin, and the read-back is its own step, each with a reason', async () => {
    const fetchMock = mockApi((request) => {
      if (request.url.pathname === '/api/v1/admin/users/user-1' && request.method === 'GET') return { body: { success: true, data: person } };
      if (request.url.pathname.endsWith('/phone-change')) return { status: 202, body: { success: false, error: { code: 'APPROVAL_REQUIRED', message: 'A second admin must approve this before it happens.', details: { approvalId: 'ap_1' } } } };
      if (request.url.pathname.endsWith('/phone-change/confirm')) return { body: { success: true, data: { moved: true } } };
      return { body: { success: true, data: [] } };
    });
    const { user } = renderWithQuery(<UserDetailPage params={fulfilledParams({ id: 'user-1' })} />);
    await user.click(await screen.findByRole('button', { name: 'Change number…' }));
    const first = screen.getByRole('dialog', { name: /Move Test Person to a new number/ });
    await user.type(within(first).getByRole('textbox', { name: 'New number' }), '+5926001234');
    await user.type(within(first).getByRole('textbox', { name: 'Reason' }), REASON);
    await user.click(within(first).getByRole('button', { name: 'Ask a second admin' }));
    await waitFor(() => expect(requestsByMethod(fetchMock, 'POST')).toHaveLength(1));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: /Move Test Person/ })).toBeNull());
    expect(screen.queryByRole('dialog', { name: 'What code did they read back?' })).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Enter number code…' }));
    const second = await screen.findByRole('dialog', { name: 'What code did they read back?' });
    await user.type(within(second).getByRole('textbox', { name: 'Code' }), '246810');
    await user.type(within(second).getByRole('textbox', { name: 'Reason' }), REASON);
    await user.click(within(second).getByRole('button', { name: 'Move the account' }));
    await waitFor(() => expect(requestsByMethod(fetchMock, 'POST')).toHaveLength(2));
    const [start, confirm] = requestsByMethod(fetchMock, 'POST');
    expect(String(start![0])).toMatch(/\/users\/user-1\/phone-change$/);
    expect(JSON.parse(String(start![1]?.body))).toEqual({ phone: '+5926001234' });
    expect(String(confirm![0])).toMatch(/\/users\/user-1\/phone-change\/confirm$/);
    expect(JSON.parse(String(confirm![1]?.body))).toEqual({ code: '246810' });
  });

  it('a staff account is not offered the door at all: the server refuses it for everyone', async () => {
    mockApi((request) => {
      if (request.url.pathname === '/api/v1/admin/users/user-1' && request.method === 'GET') return { body: { success: true, data: { ...person, roles: ['SUPER_ADMIN', 'CUSTOMER'] } } };
      return { body: { success: true, data: [] } };
    });
    renderWithQuery(<UserDetailPage params={fulfilledParams({ id: 'user-1' })} />);
    await screen.findByRole('button', { name: /Suspend/ });
    expect(screen.queryByRole('button', { name: 'Change number…' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Enter number code…' })).toBeNull();
  });

  it('a refused number stops at the first step, with the server\'s words in the panel', async () => {
    const fetchMock = mockApi((request) => {
      if (request.url.pathname === '/api/v1/admin/users/user-1' && request.method === 'GET') return { body: { success: true, data: person } };
      if (request.url.pathname.endsWith('/phone-change')) return { status: 409, body: { success: false, error: { code: 'PHONE_IN_USE', message: 'Another account uses that number. Sort that account out first.' } } };
      return { body: { success: true, data: [] } };
    });
    const { user } = renderWithQuery(<UserDetailPage params={fulfilledParams({ id: 'user-1' })} />);
    await user.click(await screen.findByRole('button', { name: 'Change number…' }));
    const first = screen.getByRole('dialog', { name: /Move Test Person to a new number/ });
    await user.type(within(first).getByRole('textbox', { name: 'New number' }), '+5926001234');
    await user.type(within(first).getByRole('textbox', { name: 'Reason' }), REASON);
    await user.click(within(first).getByRole('button', { name: 'Ask a second admin' }));
    expect((await within(first).findByRole('alert')).textContent).toContain('Another account uses that number');
    await user.click(within(first).getByRole('button', { name: /^(Cancel|Close)$/ }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: /Move Test Person/ })).toBeNull());
    expect(screen.queryByRole('dialog', { name: 'What code did they read back?' })).toBeNull();
    expect(requestsByMethod(fetchMock, 'POST')).toHaveLength(1);
  });
});
