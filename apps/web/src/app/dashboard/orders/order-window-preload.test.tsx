import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mockApi, renderWithQuery, stubAudioContext, type ApiRequest } from '@/test/test-utils';
import { wireVendorOrder, wireVendorOrderDetail } from '@/test/vendor-wire-fixtures';

// ---------------------------------------------------------------------------
// [PERF · UI-FIX-WEB note 05:18Z] /dashboard/orders is the heaviest console
// page. The order window (OrderDetail + its shelf PickList) shows only after a
// tap, so it now ships in its own chunk. The tap must stay instant: the chunk
// is fetched when the page mounts, and the window is drawn in the tap's own
// render once it is here (no Suspense placeholder in between).
// ---------------------------------------------------------------------------

const fx = vi.hoisted(() => ({ fetched: 0, arrived: false }));
vi.mock('./order-detail', async (importOriginal) => {
  fx.fetched += 1;
  const real = await importOriginal<typeof import('./order-detail')>();
  fx.arrived = true;
  return {
    ...real,
    OrderDetail: (props: Parameters<typeof real.OrderDetail>[0]) => <div data-testid="order-window-part"><real.OrderDetail {...props} /></div>,
  };
});

import OrdersPage from './page';

function handler(order: Record<string, unknown>) {
  return (request: ApiRequest) => {
    if (request.method === 'GET' && request.url.pathname === '/api/v1/vendor/orders') {
      return { body: { success: true, data: [order], meta: { total: 1 } } };
    }
    if (request.method === 'GET' && request.url.pathname.startsWith('/api/v1/vendor/orders/')) {
      return { body: { success: true, data: { ...wireVendorOrderDetail(), ...order } } };
    }
    if (request.method === 'GET' && request.url.pathname === '/api/v1/vendor/items') {
      return { body: { success: true, data: [] } };
    }
    throw new Error(`Unexpected request: ${request.method} ${request.url}`);
  };
}

describe('[PERF] the order window: its own chunk, fetched at mount, drawn at the tap', () => {
  beforeEach(() => { stubAudioContext(); });

  it('the window\'s code is fetched when the page mounts, before any order is tapped', async () => {
    mockApi(handler({ ...wireVendorOrder(), status: 'PREPARING' }));
    renderWithQuery(<OrdersPage />);
    await screen.findByText('#SW-1001');
    await waitFor(() => expect(fx.fetched).toBe(1));
    expect(screen.queryByRole('dialog', { name: 'Order details' })).toBeNull();
  });

  it('a tap on an order draws the real window in that same render, then the order fills it', async () => {
    mockApi(handler({ ...wireVendorOrder(), status: 'PREPARING' }));
    renderWithQuery(<OrdersPage />);
    const card = (await screen.findByText('#SW-1001')).closest('button')!;
    // The code was fetched at mount (above); once it has arrived, the tap needs nothing more.
    await waitFor(() => expect(fx.arrived).toBe(true));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    fireEvent.click(card);
    const dialog = screen.getByRole('dialog', { name: 'Order details' });
    expect(within(dialog).getByTestId('order-window-part')).toBeTruthy();
    expect(within(dialog).getByRole('button', { name: 'Close order detail' })).toBeTruthy();
    expect(await within(dialog).findByRole('button', { name: 'Mark ready' })).toBeTruthy();
    expect(fx.fetched).toBe(1);
  });
});

describe('[PERF] the split holds (source contract)', () => {
  const read = (name: string) => readFileSync(join(__dirname, name), 'utf8');
  const page = read('page.tsx');

  it('the page fetches the window through preloadedPart and never imports it statically', () => {
    expect(page).toContain("const orderDetail = preloadedPart(() => import('./order-detail').then((module) => module.OrderDetail));");
    expect(page).toContain('const OrderDetail = orderDetail.usePart(!!selected);');
    expect(page).not.toMatch(/^import [^;]*from '\.\/order-detail';/m);
    expect(page).not.toMatch(/next\/dynamic|lazyRetry|<Suspense/);
  });

  it('the window and the pick list live in the chunk, not in the page', () => {
    expect(page).not.toMatch(/function (OrderDetail|PickList|actionsFor)\b/);
    expect(read('order-detail.tsx')).toMatch(/export function OrderDetail\(/);
    expect(read('order-detail.tsx')).toMatch(/function PickList\(/);
  });
});
