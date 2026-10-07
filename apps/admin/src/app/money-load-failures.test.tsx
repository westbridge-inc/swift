import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import SubscriptionsPage from './subscriptions/page';
import ClaimsPage from './claims/page';
import ReturnsPage from './returns/page';
import FinancePage from './finance/page';
import OrderDetailPage from './orders/[id]/page';
import { fulfilledParams, mockApi, renderWithQuery, type ApiRequest } from '@/test/test-utils';

// ---------------------------------------------------------------------------
// [MISSION CONTROL · MONEY · DS768 D3/E2/E3/E4] A failed read on a money
// screen is said as a failed read, with a Retry — never "No subscriptions
// match", "No pending claims", "Nothing here", "No completed orders" or a row
// of confident zeros. An outage must not look like a clear queue.
// ---------------------------------------------------------------------------

const outage = { status: 500, body: { success: false, error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred' } } };

describe('[DS768] money screens say a read failed', () => {
  it('subscriptions (E2)', async () => {
    mockApi(() => outage);
    renderWithQuery(<SubscriptionsPage />);
    expect((await screen.findByRole('alert')).textContent).toContain("Couldn't load the subscriptions");
    expect(screen.queryByText('No subscriptions match.')).toBeNull();
    expect(screen.getByRole('button', { name: /Retry/ })).toBeTruthy();
  });

  it('claims (E4)', async () => {
    mockApi((r: ApiRequest) => (r.url.pathname === '/api/v1/admin/cash-rules/claims' ? outage : { body: { success: true, data: {} } }));
    renderWithQuery(<ClaimsPage />);
    expect((await screen.findByRole('alert')).textContent).toContain("Couldn't load the claims");
    expect(screen.queryByText(/No pending review claims/)).toBeNull();
  });

  it('returns (E4)', async () => {
    mockApi(() => outage);
    renderWithQuery(<ReturnsPage />);
    expect((await screen.findByRole('alert')).textContent).toContain("Couldn't load the returns");
    expect(screen.queryByText(/No requested returns/)).toBeNull();
  });

  it('finance: revenue, payment mix, cash ledger and digests (E3)', async () => {
    mockApi(() => outage);
    renderWithQuery(<FinancePage />);
    await waitFor(() => {
      const text = screen.getAllByRole('alert').map((n) => n.textContent).join(' | ');
      for (const what of ['the revenue figures', 'the payment mix', 'the cash ledger', 'the sales digests']) {
        expect(text).toContain(`Couldn't load ${what}`);
      }
    });
    expect(screen.queryByText('No completed orders yet.')).toBeNull();
    expect(screen.queryByText('No completed orders in the last 30 days.')).toBeNull();
    expect(screen.queryByText(/Nothing here/)).toBeNull();
    expect(screen.queryByText('$0')).toBeNull();
  });

  it('order detail (D3): an outage is a failed read with Retry; only a 404 is "not found"', async () => {
    mockApi(() => outage);
    const first = renderWithQuery(<OrderDetailPage params={fulfilledParams({ id: 'order-1' })} />);
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain("Couldn't load this order");
    expect(within(alert).getByRole('button', { name: /Retry/ })).toBeTruthy();
    expect(screen.queryByText('Order not found.')).toBeNull();
    first.unmount();

    mockApi(() => ({ status: 404, body: { success: false, error: { code: 'NOT_FOUND', message: 'Order not found' } } }));
    renderWithQuery(<OrderDetailPage params={fulfilledParams({ id: 'order-404' })} />);
    expect(await screen.findByText('Order not found.')).toBeTruthy();
  });
});
