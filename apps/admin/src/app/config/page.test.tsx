import { fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import ConfigPage from './page';
import { mockApi, renderWithQuery, requestsByMethod, type ApiRequest } from '@/test/test-utils';

// [Row 3 · force update] Ops set the oldest phone build Swift still serves from
// this page — no deploy, no re-seed — and the saved value is the number typed,
// under the key the API reads (apps/api/src/modules/ops/app-version.ts).

const rows = [{ key: 'order_auto_reject_minutes', value: 5 }, { key: 'app_min_build_android', value: 8 }];

function handler(request: ApiRequest) {
  if (request.method === 'GET' && request.url.pathname === '/api/v1/admin/config') return { body: { success: true, data: rows, switches: { staffInviteAccept: false } } };
  if (request.method === 'PUT' && request.url.pathname.startsWith('/api/v1/admin/config/')) return { body: { success: true, data: {} } };
  throw new Error(`Unexpected request: ${request.method} ${request.url}`);
}

describe('App updates', () => {
  it('shows both platforms’ minimums with what raising one does', async () => {
    mockApi(handler);
    renderWithQuery(<ConfigPage />);
    expect(await screen.findByText('App updates')).toBeTruthy();
    expect(screen.getByText('Oldest iPhone build allowed')).toBeTruthy();
    expect(screen.getByText('Oldest Android build allowed (version code)')).toBeTruthy();
    expect(screen.getByText(/Builds 9–11 cannot read this and keep working/)).toBeTruthy();
    expect(screen.getByText(/raise it only after that build is live in the App Store/)).toBeTruthy();
    // The stored Android minimum is shown; the unset iPhone one is empty.
    expect(screen.getByDisplayValue('8')).toBeTruthy();
  });

  it('saving sends the typed number under the iPhone key, with the operator’s reason', async () => {
    vi.stubGlobal('prompt', vi.fn(() => 'Build 13 is live in the App Store; build 12 has the checkout bug'));
    const fetchMock = mockApi(handler);
    const { user } = renderWithQuery(<ConfigPage />);
    await screen.findByText('App updates');
    const inputs = screen.getAllByRole('spinbutton') as HTMLInputElement[];
    // Order on the page: auto-reject, iPhone, Android.
    fireEvent.change(inputs[1]!, { target: { value: '13' } });
    await user.click(screen.getByRole('button', { name: 'Save Configuration' }));
    await waitFor(() => expect(requestsByMethod(fetchMock, 'PUT')).toHaveLength(1));
    const [url, init] = requestsByMethod(fetchMock, 'PUT')[0]!;
    expect(String(url)).toContain('/api/v1/admin/config/app_min_build_ios');
    expect(JSON.parse(String(init?.body))).toEqual({ value: 13 });
    expect((init?.headers as Record<string, string>)['x-swift-reason']).toBe('Build 13 is live in the App Store; build 12 has the checkout bug');
  });
});
