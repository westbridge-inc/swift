import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import OrdersPage from './page';
import { StoreLiveFeed } from '@/components/store-live-feed';
import { setSelectedStore } from '@/lib/auth';
import { mockApi, renderWithQuery, stubAudioContext, type ApiRequest } from '@/test/test-utils';
import { wireVendorOrder } from '@/test/vendor-wire-fixtures';

// [PERF row 8] The website's order board hears its store on the business
// app's socket: a new order shows at once instead of at the next 10 s poll,
// and the poll is the fallback (30 s while the feed is live, 10 s the moment
// it is not), as the phone does.
const { frames } = JSON.parse(readFileSync(join(__dirname, '..', '..', '..', 'lib', 'store-live-feed.frames.json'), 'utf8')) as { frames: Record<string, string> };

class BrowserSocket {
  static all: BrowserSocket[] = [];
  onopen: ((_e: unknown) => void) | null = null;
  onmessage: ((_e: { data: unknown }) => void) | null = null;
  onclose: ((_e: unknown) => void) | null = null;
  onerror: ((_e: unknown) => void) | null = null;
  readonly url: string;
  constructor(url: string) {
    this.url = url;
    BrowserSocket.all.push(this);
  }
  send() {}
  close() {}
  frame(text: string) { act(() => { this.onmessage?.({ data: text }); }); }
  admit() { this.frame(frames['open']!); this.frame(frames['connected']!); this.frame(frames['authReady']!); }
}

let orders: unknown[] = [];
const listReads = () => fetchMock.mock.calls.filter(([input]) => new URL(String(input)).pathname === '/api/v1/vendor/orders').length;
let fetchMock: ReturnType<typeof mockApi>;

function board(request: ApiRequest) {
  if (request.method === 'GET' && request.url.pathname === '/api/v1/vendor/orders') {
    return { body: { success: true, data: orders, meta: { total: orders.length } } };
  }
  if (request.method === 'GET' && request.url.pathname === '/api/v1/vendor/items') return { body: { success: true, data: [] } };
  throw new Error(`Unexpected request: ${request.method} ${request.url}`);
}

const renderBoard = () => renderWithQuery(<><StoreLiveFeed storeId="store-1" /><OrdersPage /></>);

describe('[PERF row 8] the website order board and the store feed', () => {
  beforeEach(() => {
    stubAudioContext();
    BrowserSocket.all = [];
    vi.stubGlobal('WebSocket', BrowserSocket);
    setSelectedStore('store-1');
    orders = [];
    fetchMock = mockApi(board);
  });
  afterEach(() => { vi.useRealTimers(); });

  it('a new order shows the moment the store feed says so, not at the next poll', async () => {
    renderBoard();
    await waitFor(() => expect(listReads()).toBe(1));
    BrowserSocket.all[0]!.admit();
    orders = [wireVendorOrder({ id: 'ord-fixture', orderNumber: 'SW-FIXTURE', status: 'PENDING' })];
    const before = performance.now();
    BrowserSocket.all[0]!.frame(frames['orderNew']!);
    expect((await screen.findAllByText(/SW-FIXTURE/, undefined, { timeout: 1_000 })).length).toBeGreaterThan(0);
    expect(listReads()).toBe(2);
    expect(performance.now() - before).toBeLessThan(1_000);
    // ...and it rings: the new-order takeover rises from the same read.
    expect(await screen.findByText(/View later/)).toBeTruthy();
  });

  it('polls every 10 s while the feed is down, every 30 s while it is live, and 10 s again the moment it drops', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
    renderBoard();
    await vi.advanceTimersByTimeAsync(0);
    expect(listReads()).toBe(1);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(listReads()).toBe(2); // no feed yet: the 10 s fallback

    BrowserSocket.all[0]!.admit();
    await vi.advanceTimersByTimeAsync(29_000);
    expect(listReads()).toBe(2); // live: no 10 s poll
    await vi.advanceTimersByTimeAsync(1_000);
    expect(listReads()).toBe(3); // ...the 30 s one

    BrowserSocket.all[0]!.frame(frames['serverDisconnect']!);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(listReads()).toBe(4); // down: back to 10 s at once
  });
});
