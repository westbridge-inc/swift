import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act, render, renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StoreLiveFeed } from './store-live-feed';
import { storeFeedLive, useFeedPollInterval } from '@/lib/store-live-feed';
import { storeKey } from '@/lib/store-scope';

// [PERF row 8] Mounted by the dashboard shell: a store event re-reads what it
// names through the dashboard's normal requests, and the pages' polls slow
// only while the feed is live.
const { frames } = JSON.parse(readFileSync(join(__dirname, '..', 'lib', 'store-live-feed.frames.json'), 'utf8')) as { frames: Record<string, string> };

class BrowserSocket {
  static all: BrowserSocket[] = [];
  sent: string[] = [];
  onopen: ((_e: unknown) => void) | null = null;
  onmessage: ((_e: { data: unknown }) => void) | null = null;
  onclose: ((_e: unknown) => void) | null = null;
  onerror: ((_e: unknown) => void) | null = null;
  readonly url: string;
  constructor(url: string) {
    this.url = url;
    BrowserSocket.all.push(this);
  }
  send(text: string) { this.sent.push(text); }
  close() { this.onclose = null; }
  frame(text: string) { act(() => { this.onmessage?.({ data: text }); }); }
}

function mount(storeId = 'store-1') {
  const client = new QueryClient();
  const invalidate = vi.spyOn(client, 'invalidateQueries').mockResolvedValue(undefined);
  const view = render(<QueryClientProvider client={client}><StoreLiveFeed storeId={storeId} /></QueryClientProvider>);
  const keys = () => invalidate.mock.calls.map(([filters]) => (filters as { queryKey: unknown }).queryKey);
  return { view, keys, invalidate };
}

describe('the dashboard shell\'s store feed', () => {
  beforeEach(() => { BrowserSocket.all = []; vi.stubGlobal('WebSocket', BrowserSocket); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it("opens the API's socket at /api/v1/socket.io/ and is live once the server authorizes it", () => {
    const { view } = mount();
    const ws = BrowserSocket.all[0]!;
    expect(ws.url).toBe('ws://vendor-api.test/api/v1/socket.io/?EIO=4&transport=websocket');
    expect(storeFeedLive('store-1')).toBe(false);
    ws.frame(frames['open']!);
    ws.frame(frames['connected']!);
    ws.frame(frames['authReady']!);
    expect(storeFeedLive('store-1')).toBe(true);
    view.unmount();
    expect(storeFeedLive('store-1')).toBe(false);
  });

  it('a new order re-reads the orders list, that order and the overview', () => {
    const { keys } = mount();
    const ws = BrowserSocket.all[0]!;
    ws.frame(frames['open']!); ws.frame(frames['connected']!); ws.frame(frames['authReady']!);
    ws.frame(frames['orderNew']!);
    expect(keys()).toEqual([
      storeKey('store-1', 'orders'), storeKey('store-1', 'order', 'ord-fixture'), storeKey('store-1', 'overview'),
    ]);
  });

  it('a kitchen or picking change re-reads the list and that order, not the figures', () => {
    const { keys } = mount();
    const ws = BrowserSocket.all[0]!;
    ws.frame(frames['open']!); ws.frame(frames['connected']!); ws.frame(frames['authReady']!);
    ws.frame('42["order:prep_update",{"orderId":"o2"}]');
    expect(keys()).toEqual([storeKey('store-1', 'orders'), storeKey('store-1', 'order', 'o2')]);
  });

  it('after a gap, the whole board once', () => {
    vi.useFakeTimers();
    try {
      const { keys, invalidate } = mount();
      BrowserSocket.all[0]!.frame(frames['open']!); BrowserSocket.all[0]!.frame(frames['connected']!); BrowserSocket.all[0]!.frame(frames['authReady']!);
      act(() => { BrowserSocket.all[0]!.onerror?.({}); });
      expect(storeFeedLive('store-1')).toBe(false);
      act(() => { vi.advanceTimersByTime(1000); });
      const again = BrowserSocket.all[1]!;
      invalidate.mockClear();
      again.frame(frames['open']!); again.frame(frames['connected']!); again.frame(frames['authReady']!);
      expect(keys()).toEqual([storeKey('store-1', 'orders'), storeKey('store-1', 'order'), storeKey('store-1', 'overview')]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("the pages' poll cadence follows the feed: 10 s down, 30 s live, 10 s again the moment it drops", () => {
    const { result } = renderHook(() => useFeedPollInterval('store-1', 10_000, 30_000));
    expect(result.current).toBe(10_000);
    mount();
    const ws = BrowserSocket.all[0]!;
    ws.frame(frames['open']!); ws.frame(frames['connected']!); ws.frame(frames['authReady']!);
    expect(result.current).toBe(30_000);
    ws.frame(frames['serverDisconnect']!);
    expect(result.current).toBe(10_000);
  });

  it('without WebSocket the board keeps its polls', () => {
    vi.stubGlobal('WebSocket', undefined);
    const { result } = renderHook(() => useFeedPollInterval('store-1', 10_000, 30_000));
    mount();
    expect(BrowserSocket.all).toHaveLength(0);
    expect(result.current).toBe(10_000);
  });
});
