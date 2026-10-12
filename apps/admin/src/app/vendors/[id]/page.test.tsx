import { screen, waitFor, within } from '@testing-library/react';
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
  // [MC-PR1] The confirmation and the reason are one in-page panel now (owner
  // ruling: no browser prompts). Every guarantee of the old prompt/confirm test
  // is kept: the panel names the visible store and the consequence, cancelling
  // sends nothing, and confirming suspends exactly this vendor with the
  // operator's own words.
  it('names the visible store, confirms, and suspends the exact vendor', async () => {
    const confirm = vi.fn();
    const prompt = vi.fn();
    vi.stubGlobal('confirm', confirm);
    vi.stubGlobal('prompt', prompt);
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
    const suspendButton = await screen.findByRole('button', { name: 'Suspend…' });

    await user.click(suspendButton);
    let dialog = screen.getByRole('dialog', { name: 'Suspend Target Store?' });
    expect(dialog.textContent).toContain('It stops taking orders immediately');
    expect(dialog.textContent).toContain('The console cannot undo a suspension yet.');
    // [ADM-006] the operator is asked why; the reason is theirs, not a template
    await user.type(within(dialog).getByRole('textbox', { name: /reason/i }), 'Repeated no-shows after three written warnings');
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(requestsByMethod(fetchMock, 'PUT')).toHaveLength(0);

    await user.click(suspendButton);
    dialog = screen.getByRole('dialog', { name: 'Suspend Target Store?' });
    await user.type(within(dialog).getByRole('textbox', { name: /reason/i }), 'Repeated no-shows after three written warnings');
    await user.click(within(dialog).getByRole('button', { name: 'Suspend store' }));
    await waitFor(() => expect(requestsByMethod(fetchMock, 'PUT')).toHaveLength(1));
    const [url, init] = requestsByMethod(fetchMock, 'PUT')[0]!;
    expect(url).toBe(`${API_ORIGIN}/api/v1/admin/vendors/vendor-target/suspend`);
    expect(init?.method).toBe('PUT');
    expect(JSON.parse(String(init?.body))).toEqual({ reason: 'Repeated no-shows after three written warnings' });
    expect((init?.headers as Record<string, string>)['x-swift-reason']).toBe('Repeated no-shows after three written warnings');
    expect((await screen.findByRole('status')).textContent).toContain('Target Store is suspended');
    expect(confirm).not.toHaveBeenCalled();
    expect(prompt).not.toHaveBeenCalled();
  });

  it('surfaces the server rejection and leaves the active store visible', async () => {
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
    const suspendButton = await screen.findByRole('button', { name: 'Suspend…' });

    await user.click(suspendButton);
    const dialog = screen.getByRole('dialog', { name: 'Suspend Target Store?' });
    const reason = within(dialog).getByRole('textbox', { name: /reason/i });
    await user.type(reason, 'Repeated no-shows after three written warnings');
    await user.click(within(dialog).getByRole('button', { name: 'Suspend store' }));

    // the refusal, in words, inside the panel — with the typed reason still there
    const alert = await within(dialog).findByRole('alert');
    expect(alert.textContent).toContain("This record doesn't exist, or isn't in your market");
    expect(alert.textContent).toContain('Vendor with id vendor-target not found');
    expect(alert.textContent).toContain('Code NOT_FOUND · HTTP 404');
    expect((reason as HTMLTextAreaElement).value).toBe('Repeated no-shows after three written warnings');
    expect((within(dialog).getByRole('button', { name: 'Suspend store' }) as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getByRole('heading', { name: 'Target Store' })).toBeTruthy();
    expect(screen.getByText('Live')).toBeTruthy();
    expect(requestsByMethod(fetchMock, 'PUT')).toHaveLength(1);
    expect(requestsByMethod(fetchMock, 'GET')).toHaveLength(1);

    // closing the panel does not make the refusal vanish: the page keeps it
    await user.click(within(dialog).getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect((await screen.findByRole('alert')).textContent).toContain('Vendor with id vendor-target not found');
    expect((suspendButton as HTMLButtonElement).disabled).toBe(false);
  });
});
