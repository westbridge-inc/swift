import { screen, waitFor } from '@testing-library/react';
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

describe('user suspension mutation', () => {
  it('confirms and suspends through the exact endpoint and reason payload', async () => {
    const confirm = vi.fn().mockReturnValueOnce(false).mockReturnValueOnce(true);
    vi.stubGlobal('confirm', confirm);
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
    const suspendButton = await screen.findByRole('button', { name: 'Suspend' });

    await user.click(suspendButton);
    expect(confirm).toHaveBeenNthCalledWith(
      1,
      "Suspend Test User? They can't transact until unsuspended.",
    );
    expect(requestsByMethod(fetchMock, 'PUT')).toHaveLength(0);

    await user.click(suspendButton);
    await waitFor(() => expect(requestsByMethod(fetchMock, 'PUT')).toHaveLength(1));
    const [url, init] = requestsByMethod(fetchMock, 'PUT')[0]!;
    expect(confirm).toHaveBeenNthCalledWith(
      2,
      "Suspend Test User? They can't transact until unsuspended.",
    );
    expect(url).toBe(`${API_ORIGIN}/api/v1/admin/users/user-1/suspend`);
    expect(init?.method).toBe('PUT');
    expect(JSON.parse(String(init?.body))).toEqual({ reason: 'Suspended by admin' });
  });

  it('renders a suspension failure and leaves the active account controls intact', async () => {
    vi.stubGlobal('confirm', vi.fn().mockReturnValue(true));
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
    const suspendButton = await screen.findByRole('button', { name: 'Suspend' });

    await user.click(suspendButton);

    expect((await screen.findByRole('alert')).textContent).toContain(
      'Suspension failed: User with id user-1 not found',
    );
    expect(screen.getByRole('heading', { name: 'Test User' })).toBeTruthy();
    expect(screen.getByText('ACTIVE')).toBeTruthy();
    expect((suspendButton as HTMLButtonElement).disabled).toBe(false);
    expect(requestsByMethod(fetchMock, 'PUT')).toHaveLength(1);
    expect(requestsByMethod(fetchMock, 'GET')).toHaveLength(1);
  });
});
