import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { LiveOrderFeed } from './LiveOrderFeed';
import { mockApi, renderWithQuery, type ApiReply, type ApiRequest } from '@/test/test-utils';

// ---------------------------------------------------------------------------
// [U59] The dashboard's live order feed rendered `data?.data?.map(...) || (...)`:
// while the first read was loading it said "No recent orders", and a real
// empty answer (an empty array maps to [], which is truthy) left a blank
// panel. Four states, each said once: loading, failed, none, rows.
// ---------------------------------------------------------------------------

function feed(reply: () => ApiReply | Promise<ApiReply>) {
  mockApi((r: ApiRequest) => {
    if (r.method === 'GET' && r.url.pathname === '/api/v1/admin/orders') return reply();
    throw new Error(`Unexpected request: ${r.method} ${r.url}`);
  });
}

describe('[U59] the live order feed says which state it is in', () => {
  it('loading says loading, never "No recent orders"', async () => {
    feed(() => new Promise<ApiReply>(() => {}));
    renderWithQuery(<LiveOrderFeed />);
    expect(await screen.findByText(/Loading recent orders/)).toBeTruthy();
    expect(screen.queryByText('No recent orders')).toBeNull();
  });

  it('an empty answer says "No recent orders" (it used to be a blank panel)', async () => {
    feed(() => ({ body: { success: true, data: [] } }));
    renderWithQuery(<LiveOrderFeed />);
    expect(await screen.findByText('No recent orders')).toBeTruthy();
  });

  it('a failed read says the feed is unavailable, never "No recent orders"', async () => {
    feed(() => ({ status: 500, body: { success: false, error: { code: 'INTERNAL_ERROR', message: 'Something went wrong' } } }));
    renderWithQuery(<LiveOrderFeed />);
    expect(await screen.findByText(/This is not an empty queue/)).toBeTruthy();
    expect(screen.queryByText('No recent orders')).toBeNull();
  });

  it('rows show the status in words, never a raw enum', async () => {
    feed(() => ({ body: { success: true, data: [{ id: 'o1', orderNumber: 'SW-1001', status: 'EN_ROUTE_DELIVERY', totalAmount: 2500 }] } }));
    renderWithQuery(<LiveOrderFeed />);
    expect(await screen.findByText('#SW-1001')).toBeTruthy();
    expect(screen.getByText('en route delivery')).toBeTruthy();
    expect(screen.queryByText('EN_ROUTE_DELIVERY')).toBeNull();
  });
});
