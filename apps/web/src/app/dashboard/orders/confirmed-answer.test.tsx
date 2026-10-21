import { act, screen, waitFor, within } from '@testing-library/react';
import type { UserEvent } from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import OrdersPage from './page';
import { mockApi, renderWithQuery, stubAudioContext, type ApiRequest } from '@/test/test-utils';
import { wireVendorOrderDetail } from '@/test/vendor-wire-fixtures';

// ---------------------------------------------------------------------------
// [PERF row 562] A store's Accept / Start preparing / Mark ready is dispatch:
// it never shows success before the server confirms. But once the server has
// answered, the order kept its OLD status (and its old button: a second Accept
// was a 409) until a re-read came back, one more round trip abroad. Now the
// server's confirmed answer is shown as soon as it lands; the page is still
// re-read; nothing changes before the answer.
// ---------------------------------------------------------------------------

type Reply = { status?: number; body: unknown };
const gate = { holdReads: false, reads: [] as Array<() => void>, puts: [] as Array<(_reply?: Reply) => void> };

function handler(detail: Record<string, unknown>) {
  const server = { ...detail };
  return (request: ApiRequest) => {
    const path = request.url.pathname;
    if (request.method === 'GET' && path === '/api/v1/vendor/orders') {
      return { body: { success: true, data: [server], meta: { total: 1 } } };
    }
    if (request.method === 'GET' && path === '/api/v1/vendor/orders/order-live') {
      const snapshot = { body: { success: true, data: { ...server } } };
      if (!gate.holdReads) return snapshot;
      return new Promise<Reply>((resolve) => { gate.reads.push(() => resolve(snapshot)); });
    }
    if (request.method === 'GET' && path === '/api/v1/vendor/items') return { body: { success: true, data: [] } };
    const step = /\/orders\/order-live\/(accept|preparing|ready)$/.exec(path);
    if (request.method === 'PUT' && step) {
      return new Promise<Reply>((resolve) => {
        gate.puts.push((reply) => {
          if (reply) { resolve(reply); return; }
          const now = new Date().toISOString();
          if (step[1] === 'accept') Object.assign(server, { status: 'ACCEPTED', acceptedAt: now, estimatedPrepTime: 20 });
          if (step[1] === 'preparing') Object.assign(server, { status: 'PREPARING', preparingAt: now });
          if (step[1] === 'ready') Object.assign(server, { status: 'READY_FOR_PICKUP', readyAt: now });
          // The answer is the bare updated row (no relations), like the route's `updated`.
          resolve({ body: { success: true, data: { id: 'order-live', status: server['status'], acceptedAt: server['acceptedAt'] ?? null, preparingAt: server['preparingAt'] ?? null, readyAt: server['readyAt'] ?? null, estimatedPrepTime: server['estimatedPrepTime'] ?? null } } });
        });
      });
    }
    throw new Error(`Unexpected request: ${request.method} ${request.url}`);
  };
}

async function openDetail(detail = wireVendorOrderDetail()) {
  mockApi(handler(detail));
  const { user, queryClient } = renderWithQuery(<OrdersPage />);
  const heading = await screen.findByText('#SW-1001');
  const row = heading.closest('button')!;
  const later = screen.queryByText(/View later/);
  if (later) await user.click(later);
  await waitFor(() => expect(screen.queryByText(/View later/)).toBeNull());
  await user.click(row);
  // The detail has loaded: the money card's payment line (U25, the phone's words) is drawn from it.
  await waitFor(() => expect(screen.getByText('Cash on handover — you keep 100% of the goods total.')).toBeTruthy());
  return { user, queryClient, dialog: () => screen.getByRole('dialog', { name: 'Order details' }) };
}

beforeEach(() => { stubAudioContext(); });
afterEach(() => {
  gate.holdReads = false;
  gate.reads.splice(0).forEach((release) => release());
  gate.puts.splice(0).forEach((release) => release({ status: 503, body: { success: false, error: { message: 'teardown' } } }));
});

const tap = async (user: UserEvent, dialog: HTMLElement, name: string) => { await user.click(within(dialog).getByRole('button', { name })); };

describe('a store tap shows the server\'s confirmed answer as soon as it lands', () => {
  it('Accept: busy at the tap, nothing confirmed before the answer, ACCEPTED at the answer before any re-read', async () => {
    const { user, dialog } = await openDetail();
    await tap(user, dialog(), 'Accept');
    const accept = within(dialog()).getByRole('button', { name: 'Accept' });
    expect(accept.hasAttribute('disabled')).toBe(true);
    expect(accept.getAttribute('aria-busy')).toBe('true');
    expect(within(dialog()).queryByText('ACCEPTED')).toBeNull(); // dispatch: never before the server says so

    gate.holdReads = true; // the re-read after the answer waits
    await act(async () => { gate.puts[0]!(); });
    await waitFor(() => expect(within(dialog()).getByRole('button', { name: 'Start preparing' })).toBeTruthy());
    expect(within(dialog()).queryByRole('button', { name: 'Accept' })).toBeNull(); // no second Accept to tap
    expect(gate.reads.length).toBeGreaterThanOrEqual(1);
  });

  it('a refusal changes nothing and says why', async () => {
    const { user, dialog } = await openDetail();
    await tap(user, dialog(), 'Accept');
    await act(async () => { gate.puts[0]!({ status: 409, body: { success: false, error: { code: 'ORDER_TAKEN', message: 'This order was cancelled by the customer.' } } }); });
    await waitFor(() => expect(within(dialog()).getByText(/This order was cancelled by the customer\./)).toBeTruthy());
    expect(within(dialog()).getByRole('button', { name: 'Accept' })).toBeTruthy();
    expect(within(dialog()).queryByRole('button', { name: 'Start preparing' })).toBeNull();
  });

  it('a read already on its way at the answer does not put the old status back', async () => {
    const { user, dialog, queryClient } = await openDetail(wireVendorOrderDetail({ status: 'ACCEPTED', acceptedAt: new Date().toISOString() }));
    await tap(user, dialog(), 'Start preparing');
    // A poll leaves BEFORE the answer: it will come back saying "ACCEPTED".
    gate.holdReads = true;
    void queryClient.invalidateQueries({ predicate: (query) => JSON.stringify(query.queryKey).includes('"order","order-live"') });
    await waitFor(() => expect(gate.reads.length).toBe(1));
    await act(async () => { gate.puts[0]!(); });
    await waitFor(() => expect(within(dialog()).getByRole('button', { name: 'Mark ready' })).toBeTruthy());
    await act(async () => { gate.reads[0]!(); await new Promise((resolve) => { setTimeout(resolve, 50); }); });
    expect(within(dialog()).getByRole('button', { name: 'Mark ready' })).toBeTruthy();
    expect(within(dialog()).queryByRole('button', { name: 'Start preparing' })).toBeNull();
  });
});
