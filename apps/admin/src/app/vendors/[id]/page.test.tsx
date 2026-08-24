import { screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import VendorDetailPage from './page';
import {
  API_ORIGIN,
  fulfilledParams,
  mockApi,
  renderWithQuery,
  requestsByMethod,
  type ApiRequest,
} from '@/test/test-utils';

const vendor = {
  id: 'vendor-target',
  name: 'Target Store',
  status: 'ACTIVE',
  vendorType: 'RESTAURANT',
  isFeatured: false,
  acceptingOrders: true,
  city: 'Georgetown',
  addressLine1: 'Test address',
  phone: 'test-phone',
  averageRating: null,
  totalRatings: 0,
  mmgPayUrl: null,
  createdAt: '2026-08-01T00:00:00.000Z',
  recentOrders: [],
  subscription: null,
  owner: {
    user: {
      id: 'owner-1',
      firstName: 'Store',
      lastName: 'Owner',
      phone: 'owner-phone',
      email: null,
      status: 'ACTIVE',
    },
    vendors: [{ id: 'vendor-target', name: 'Target Store', status: 'ACTIVE' }],
  },
  _count: { items: 0, orders: 0 },
};

function vendorHandler(mutation: (_request: ApiRequest) => { body: unknown; status?: number }) {
  return (request: ApiRequest) => {
    if (
      request.method === 'GET' &&
      request.url.pathname === '/api/v1/admin/vendors/vendor-target'
    ) {
      return { body: { success: true, data: vendor } };
    }
    return mutation(request);
  };
}

describe('vendor suspension mutation', () => {
  it('names the visible store, confirms, and suspends the exact vendor', async () => {
    const confirm = vi.fn().mockReturnValueOnce(false).mockReturnValueOnce(true);
    vi.stubGlobal('confirm', confirm);
    const fetchMock = mockApi(
      vendorHandler((request) => {
        if (
          request.method === 'PUT' &&
          request.url.pathname === '/api/v1/admin/vendors/vendor-target/suspend'
        ) {
          return { body: { success: true, data: { ...vendor, status: 'SUSPENDED' } } };
        }
        throw new Error(`Unexpected request: ${request.method} ${request.url}`);
      }),
    );
    const { user } = renderWithQuery(
      <VendorDetailPage params={fulfilledParams({ id: 'vendor-target' })} />,
    );
    const suspendButton = await screen.findByRole('button', { name: 'Suspend' });

    await user.click(suspendButton);
    expect(confirm).toHaveBeenNthCalledWith(
      1,
      'Suspend Target Store? They stop taking orders immediately. This cannot be reversed from the console.',
    );
    expect(requestsByMethod(fetchMock, 'PUT')).toHaveLength(0);

    await user.click(suspendButton);
    await waitFor(() => expect(requestsByMethod(fetchMock, 'PUT')).toHaveLength(1));
    const [url, init] = requestsByMethod(fetchMock, 'PUT')[0]!;
    expect(confirm).toHaveBeenNthCalledWith(
      2,
      'Suspend Target Store? They stop taking orders immediately. This cannot be reversed from the console.',
    );
    expect(url).toBe(`${API_ORIGIN}/api/v1/admin/vendors/vendor-target/suspend`);
    expect(init?.method).toBe('PUT');
    expect(JSON.parse(String(init?.body))).toEqual({ reason: 'Suspended by admin' });
  });

  it('surfaces the server rejection and leaves the active store visible', async () => {
    vi.stubGlobal('confirm', vi.fn().mockReturnValue(true));
    const fetchMock = mockApi(
      vendorHandler((request) => {
        if (
          request.method === 'PUT' &&
          request.url.pathname === '/api/v1/admin/vendors/vendor-target/suspend'
        ) {
          return {
            status: 404,
            body: {
              success: false,
              error: {
                code: 'NOT_FOUND',
                message: 'Vendor with id vendor-target not found',
              },
            },
          };
        }
        throw new Error(`Unexpected request: ${request.method} ${request.url}`);
      }),
    );
    const { user } = renderWithQuery(
      <VendorDetailPage params={fulfilledParams({ id: 'vendor-target' })} />,
    );
    const suspendButton = await screen.findByRole('button', { name: 'Suspend' });

    await user.click(suspendButton);

    expect((await screen.findByRole('alert')).textContent).toContain(
      'Suspension did not record: Vendor with id vendor-target not found',
    );
    expect(screen.getByRole('heading', { name: 'Target Store' })).toBeTruthy();
    expect(screen.getByText('ACTIVE')).toBeTruthy();
    expect((suspendButton as HTMLButtonElement).disabled).toBe(false);
    expect(requestsByMethod(fetchMock, 'PUT')).toHaveLength(1);
    expect(requestsByMethod(fetchMock, 'GET')).toHaveLength(1);
  });
});
