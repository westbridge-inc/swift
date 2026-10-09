import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import OrdersPage from './orders/page';
import OrderDetailPage from './orders/[id]/page';
import { fulfilledParams, mockApi, renderWithQuery } from '@/test/test-utils';

const held = (id: string) => ({ id, orderNumber: id, orderType: 'FOOD_DELIVERY', status: 'READY_FOR_PICKUP', paymentMethod: 'MOBILE_MONEY', paymentStatus: 'CAPTURED', totalAmount: 1500, readyMinutes: 70, heldMinutes: 10, vendor: { id: 'synthetic-store', name: 'Test Kitchen' } });
const outage = { status: 500, body: { success: false, error: { code: 'INTERNAL_ERROR', message: 'Read unavailable' } } };
function serveHeld(ids: string[], failAfterRelease = false) {
  const released = new Set<string>();
  mockApi((request) => {
    if (request.method === 'GET') {
      if (request.url.pathname.endsWith('/held')) return released.size && failAfterRelease ? outage : { body: { success: true, data: ids.filter((id) => !released.has(id)).map(held) } };
      return { body: { success: true, data: [] } };
    }
    const id = request.url.pathname.split('/')[5]!;
    released.add(id);
    return { body: { success: true, data: { released: true, decision: 'DELIVER_ANYWAY', dispatch: { error: 'Dispatch unavailable' } } } };
  });
}
async function release(user: ReturnType<typeof renderWithQuery>['user'], id: string) {
  await user.click(await screen.findByRole('button', { name: `Deliver order ${id} anyway` }));
  await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Deliver anyway' }));
  await screen.findByRole('button', { name: `Retry dispatch for ${id}` });
}

describe('order review recovery remains reachable', () => {
  it('keeps a dispatch retry after dismissing the message and removing the held row', async () => {
    serveHeld(['HELD-1']);
    const { user } = renderWithQuery(<OrdersPage />);
    await release(user, 'HELD-1');
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Deliver order HELD-1 anyway' })).toBeNull());
    await user.click(screen.getByRole('button', { name: 'Dismiss this message' }));
    expect(screen.getByRole('button', { name: 'Retry dispatch for HELD-1' })).toBeTruthy();
  });
  it('keeps dispatch recovery when the refreshed held queue cannot be read', async () => {
    serveHeld(['HELD-1'], true);
    const { user } = renderWithQuery(<OrdersPage />);
    await user.click(await screen.findByRole('button', { name: 'Deliver order HELD-1 anyway' }));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Deliver anyway' }));
    await screen.findByText("Couldn't load the held orders");
    expect(screen.getByRole('button', { name: 'Retry dispatch for HELD-1' })).toBeTruthy();
  });
  it('keeps a separate retry for every released order whose dispatch failed', async () => {
    serveHeld(['HELD-1', 'HELD-2']);
    const { user } = renderWithQuery(<OrdersPage />);
    await release(user, 'HELD-1');
    await release(user, 'HELD-2');
    expect(screen.getByRole('button', { name: 'Retry dispatch for HELD-1' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Retry dispatch for HELD-2' })).toBeTruthy();
  });
  it('offers a retry after an order evidence read fails', async () => {
    let reads = 0;
    mockApi(() => ++reads === 1 ? outage : { body: { success: true, data: { ...held('HELD-1'), items: [], statusHistory: [] } } });
    const { user } = renderWithQuery(<OrderDetailPage params={fulfilledParams({ id: 'HELD-1' })} />);
    expect(await screen.findByText("Couldn't load this order")).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('heading', { name: '#HELD-1' })).toBeTruthy();
  });
});
