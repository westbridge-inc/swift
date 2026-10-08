import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import UserDetailPage from './page';
import {
  API_ORIGIN,
  fulfilledParams,
  mockApi,
  renderWithQuery,
  requestsByMethod,
  type ApiRequest,
} from '@/test/test-utils';

const userRecord = {
  id: 'user-1',
  firstName: 'Test',
  lastName: 'User',
  phone: 'test-phone',
  email: null,
  status: 'ACTIVE',
  roles: ['CUSTOMER'],
  createdAt: '2026-08-01T00:00:00.000Z',
  lastActiveAt: null,
  isPhoneVerified: true,
  orders: [],
  strikes: [],
  addresses: [],
  _count: { orders: 0, strikes: 0 },
};

function userHandler(mutation: (_request: ApiRequest) => { body: unknown; status?: number }) {
  return (request: ApiRequest) => {
    if (request.method === 'GET' && request.url.pathname === '/api/v1/admin/users/user-1') {
      return { body: { success: true, data: userRecord } };
    }
    return mutation(request);
  };
}

const REASON = 'Repeated no-shows after three written warnings';

describe('user suspension mutation', () => {
  // [MC-PR3] The confirmation and the reason are one in-page panel (owner ruling: no browser prompts). The old
  // guarantees hold: the panel names the person and the consequence, dismissing it sends nothing, and confirming
  // suspends exactly this account with the operator's own words.
  it('confirms and suspends through the exact endpoint and reason payload', async () => {
    const confirm = vi.fn();
    const prompt = vi.fn();
    vi.stubGlobal('confirm', confirm);
    vi.stubGlobal('prompt', prompt);
    const fetchMock = mockApi(
      userHandler((request) => {
        if (request.method === 'PUT' && request.url.pathname === '/api/v1/admin/users/user-1/suspend') {
          return { body: { success: true, data: {} } };
        }
        throw new Error(`Unexpected request: ${request.method} ${request.url}`);
      }),
    );
    const { user } = renderWithQuery(
      <UserDetailPage params={fulfilledParams({ id: 'user-1' })} />,
    );
    const suspendButton = await screen.findByRole('button', { name: 'Suspend…' });

    await user.click(suspendButton);
    let dialog = screen.getByRole('dialog', { name: 'Suspend Test User?' });
    expect(dialog.textContent).toContain('They are signed out and cannot transact until the account is unsuspended.');
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(requestsByMethod(fetchMock, 'PUT')).toHaveLength(0);

    await user.click(suspendButton);
    dialog = screen.getByRole('dialog', { name: 'Suspend Test User?' });
    await user.type(within(dialog).getByRole('textbox', { name: 'Reason' }), REASON);
    await user.click(within(dialog).getByRole('button', { name: 'Suspend account' }));
    await waitFor(() => expect(requestsByMethod(fetchMock, 'PUT')).toHaveLength(1));
    const [url, init] = requestsByMethod(fetchMock, 'PUT')[0]!;
    expect(url).toBe(`${API_ORIGIN}/api/v1/admin/users/user-1/suspend`);
    expect(init?.method).toBe('PUT');
    expect(JSON.parse(String(init?.body))).toEqual({ reason: REASON });
    expect(confirm).not.toHaveBeenCalled();
    expect(prompt).not.toHaveBeenCalled();
  });

  it('renders a suspension failure and leaves the active account controls intact', async () => {
    const fetchMock = mockApi(
      userHandler((request) => {
        if (request.method === 'PUT' && request.url.pathname === '/api/v1/admin/users/user-1/suspend') {
          return {
            status: 404,
            body: {
              success: false,
              error: { code: 'NOT_FOUND', message: 'User with id user-1 not found' },
            },
          };
        }
        throw new Error(`Unexpected request: ${request.method} ${request.url}`);
      }),
    );
    const { user } = renderWithQuery(
      <UserDetailPage params={fulfilledParams({ id: 'user-1' })} />,
    );
    const suspendButton = await screen.findByRole('button', { name: 'Suspend…' });

    await user.click(suspendButton);
    const dialog = screen.getByRole('dialog', { name: 'Suspend Test User?' });
    await user.type(within(dialog).getByRole('textbox', { name: 'Reason' }), REASON);
    await user.click(within(dialog).getByRole('button', { name: 'Suspend account' }));

    const alert = await within(dialog).findByRole('alert');
    expect(alert.textContent).toContain("This record doesn't exist, or isn't in your market");
    expect(alert.textContent).toContain('User with id user-1 not found');
    expect(screen.getByRole('heading', { name: 'Test User' })).toBeTruthy();
    expect(screen.getByText('Active')).toBeTruthy();
    expect((suspendButton as HTMLButtonElement).disabled).toBe(false);
    expect(requestsByMethod(fetchMock, 'PUT')).toHaveLength(1);
    expect(requestsByMethod(fetchMock, 'GET')).toHaveLength(1);
  });

  it('[MC-PR3] a failed load says so with a Retry — not "User not found"', async () => {
    mockApi(() => ({ status: 500, body: { success: false, error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred' } } }));
    renderWithQuery(<UserDetailPage params={fulfilledParams({ id: 'user-1' })} />);
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain("Couldn't load this person");
    expect(screen.queryByText('User not found.')).toBeNull();
  });
});
