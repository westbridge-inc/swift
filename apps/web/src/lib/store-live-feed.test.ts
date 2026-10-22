import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  feedPollInterval, openStoreFeed, parseFeedFrame, reconnectDelayMs, setStoreFeedLive, storeFeedLive,
  storeFeedUrl, STORE_FEED_PATH,
} from './store-live-feed';

// [PERF row 8] The website hears its store on the business app's socket. The
// frames are the API's own: store-live-feed.frames.json is recorded from the
// server by apps/api/src/__tests__/socket-browser-cookie.test.ts, which fails
// if the server ever sends different ones.
const { frames } = JSON.parse(readFileSync(join(__dirname, 'store-live-feed.frames.json'), 'utf8')) as { frames: Record<string, string> };

describe('the frame parser reads the frames the API really sends', () => {
  it('reads each recorded frame', () => {
    expect(parseFeedFrame(frames['open'])).toEqual({ kind: 'open', pingInterval: 25_000, pingTimeout: 20_000 });
    expect(parseFeedFrame(frames['connected'])).toEqual({ kind: 'connected' });
    expect(parseFeedFrame(frames['authReady'])).toEqual({ kind: 'event', name: 'auth:ready', payload: { expiresAt: '<iso>' } });
    expect(parseFeedFrame(frames['orderNew'])).toEqual({
      kind: 'event', name: 'order:new', payload: { orderId: 'ord-fixture', vendorId: 'store-fixture', orderNumber: 'SW-FIXTURE' },
    });
    expect(parseFeedFrame(frames['statusChanged'])).toMatchObject({ kind: 'event', name: 'order:status_changed', payload: { orderId: 'ord-fixture' } });
    expect(parseFeedFrame(frames['ping'])).toEqual({ kind: 'ping' });
    expect(parseFeedFrame(frames['connectError'])).toEqual({ kind: 'connect-error', message: 'Authentication required' });
    expect(parseFeedFrame(frames['serverDisconnect'])).toEqual({ kind: 'disconnect' });
  });

  it('tolerates every frame it does not know, and never throws', () => {
    for (const unknown of ['', '6', '3', '5', '43["x"]', '42/admin,["order:new",{}]', '42not json', '42{"a":1}', '42[1,2]',
      '0not json', '0', '4', '49', 'zzz', '44', '7', null, undefined, 42, {}, new ArrayBuffer(2)]) {
      expect(() => parseFeedFrame(unknown)).not.toThrow();
      expect(['other', 'connect-error']).toContain(parseFeedFrame(unknown).kind);
    }
    expect(parseFeedFrame('44').kind).toBe('connect-error');
    // An event the server asks to be acknowledged is still the event.
    expect(parseFeedFrame('4212["order:new",{"orderId":"o1"}]')).toEqual({ kind: 'event', name: 'order:new', payload: { orderId: 'o1' } });
    // A heartbeat setting that is not a positive number falls back to the protocol's defaults.
    expect(parseFeedFrame('0{"pingInterval":-1,"pingTimeout":"x"}')).toEqual({ kind: 'open', pingInterval: 25_000, pingTimeout: 20_000 });
  });

  it('opens at /api/v1/socket.io/ on the API origin, wss for https', () => {
    expect(storeFeedUrl('https://api.swiftgy.com')).toBe(`wss://api.swiftgy.com${STORE_FEED_PATH}?EIO=4&transport=websocket`);
    expect(storeFeedUrl('http://localhost:3000')).toBe('ws://localhost:3000/api/v1/socket.io/?EIO=4&transport=websocket');
  });

  it('waits 1 s doubling to 30 s between failed tries, with jitter', () => {
    expect([0, 1, 2, 3, 4, 5, 6, 50].map((n) => reconnectDelayMs(n, () => 1))).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000]);
    expect(reconnectDelayMs(0, () => 0)).toBe(500);
  });
});

class FakeSocket {
  static all: FakeSocket[] = [];
  sent: string[] = [];
  closed = false;
  onopen: ((_e: unknown) => void) | null = null;
  onmessage: ((_e: { data: unknown }) => void) | null = null;
  onclose: ((_e: unknown) => void) | null = null;
  onerror: ((_e: unknown) => void) | null = null;
  readonly url: string;
  constructor(url: string) {
    this.url = url;
    FakeSocket.all.push(this);
  }
  send(text: string) { this.sent.push(text); }
  close() { this.closed = true; }
  frame(text: string) { this.onmessage?.({ data: text }); }
  /** The server's side of a good handshake, frame by frame as recorded. */
  admit() { this.frame(frames['open']!); this.frame(frames['connected']!); this.frame(frames['authReady']!); }
}
const latest = () => FakeSocket.all[FakeSocket.all.length - 1]!;

function feed(overrides: Partial<Parameters<typeof openStoreFeed>[0]> = {}) {
  const live: boolean[] = [];
  const events: Array<[string, { orderId?: string }]> = [];
  const onResync = vi.fn();
  const close = openStoreFeed({
    url: 'ws://api.test/api/v1/socket.io/?EIO=4&transport=websocket', storeId: 'store-1',
    onLive: (v) => live.push(v), onEvent: (e, p) => events.push([e, p]), onResync,
    createSocket: (url) => new FakeSocket(url), random: () => 1, ...overrides,
  });
  return { live, events, onResync, close };
}

describe('the store feed client', () => {
  beforeEach(() => { FakeSocket.all = []; vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('names itself web, then asks for its store room once the server has authorized it, and only then is live', () => {
    const f = feed();
    const ws = latest();
    ws.frame(frames['open']!);
    expect(ws.sent).toEqual(['40{"client":"web"}']);
    ws.frame(frames['connected']!);
    expect(f.live).toEqual([]);
    ws.frame(frames['authReady']!);
    expect(ws.sent).toEqual(['40{"client":"web"}', '42["vendor:subscribe",{"vendorId":"store-1"}]']);
    expect(f.live).toEqual([true]);
    expect(f.onResync).not.toHaveBeenCalled();
    f.close();
  });

  it('hands on each store event with the order it names; other events and early events are ignored', () => {
    const f = feed();
    const ws = latest();
    ws.frame(frames['open']!);
    ws.frame(frames['orderNew']!); // before authorization: not the feed's yet
    ws.frame(frames['connected']!);
    ws.frame(frames['authReady']!);
    ws.frame(frames['orderNew']!);
    ws.frame(frames['statusChanged']!);
    ws.frame('42["order:prep_update",{"orderId":"o2"}]');
    ws.frame('42["order:pick_state",{"orderId":"o3","lineId":"l1"}]');
    ws.frame('42["bookings:changed",{"itemId":"svc-1"}]');
    ws.frame('42["vendor:order_alert",{"orderId":"o4"}]');
    ws.frame('42["order:status_changed",{"orderId":7}]');
    expect(f.events).toEqual([
      ['order:new', { orderId: 'ord-fixture' }],
      ['order:status_changed', { orderId: 'ord-fixture' }],
      ['order:prep_update', { orderId: 'o2' }],
      ['order:pick_state', { orderId: 'o3' }],
      ['bookings:changed', {}],
      ['order:status_changed', {}],
    ]);
    f.close();
  });

  it('answers the heartbeat, and stays live through frames it does not know', () => {
    const f = feed();
    const ws = latest();
    ws.admit();
    ws.frame(frames['ping']!);
    expect(ws.sent.at(-1)).toBe('3');
    for (const unknown of ['6', '43[]', '42/admin,["x"]', 'zzz', '']) ws.frame(unknown);
    expect(f.live).toEqual([true]);
    expect(ws.closed).toBe(false);
    f.close();
  });

  it('a missed heartbeat (pingInterval + pingTimeout of silence) is a dead connection: back to polls, then a new try', () => {
    const f = feed();
    const ws = latest();
    ws.admit();
    vi.advanceTimersByTime(25_000 + 20_000 - 1);
    ws.frame(frames['ping']!); // a ping in time re-arms it
    vi.advanceTimersByTime(44_999);
    expect(f.live).toEqual([true]);
    vi.advanceTimersByTime(1);
    expect(f.live).toEqual([true, false]);
    expect(ws.closed).toBe(true);
    expect(FakeSocket.all).toHaveLength(1);
    vi.advanceTimersByTime(1_000);
    expect(FakeSocket.all).toHaveLength(2);
    f.close();
  });

  it('an open frame that never comes is a failure too', () => {
    const f = feed();
    vi.advanceTimersByTime(45_000);
    expect(latest().closed).toBe(true);
    expect(f.live).toEqual([]);
    f.close();
  });

  for (const [name, fail] of [
    ['a refused handshake (44)', (ws: FakeSocket) => ws.frame(frames['connectError']!)],
    ['a server disconnect (41)', (ws: FakeSocket) => ws.frame(frames['serverDisconnect']!)],
    ['an engine close (1)', (ws: FakeSocket) => ws.frame('1')],
    ['a socket error', (ws: FakeSocket) => ws.onerror?.({})],
    ['a socket close', (ws: FakeSocket) => ws.onclose?.({})],
  ] as const) {
    it(`${name} puts the polls back at once and tries again after a backoff`, () => {
      const f = feed();
      latest().admit();
      fail(latest());
      expect(f.live).toEqual([true, false]);
      expect(latest().closed).toBe(true);
      vi.advanceTimersByTime(999);
      expect(FakeSocket.all).toHaveLength(1);
      vi.advanceTimersByTime(1);
      expect(FakeSocket.all).toHaveLength(2);
      f.close();
    });
  }

  it('backs off 1, 2, 4, 8 s while it keeps failing, and starts again from 1 s after a live session', () => {
    const f = feed();
    const waits: number[] = [];
    for (let i = 0; i < 4; i += 1) {
      const before = FakeSocket.all.length;
      latest().onclose?.({});
      let waited = 0;
      while (FakeSocket.all.length === before) { vi.advanceTimersByTime(250); waited += 250; }
      waits.push(waited);
    }
    expect(waits).toEqual([1000, 2000, 4000, 8000]);
    latest().admit();
    latest().onclose?.({});
    vi.advanceTimersByTime(1000);
    expect(FakeSocket.all).toHaveLength(6);
    f.close();
  });

  it('after a gap it re-reads the board once (an event may have been missed), never on the first connection', () => {
    const f = feed();
    latest().admit();
    expect(f.onResync).not.toHaveBeenCalled();
    latest().onclose?.({});
    vi.advanceTimersByTime(1000);
    latest().admit();
    expect(f.onResync).toHaveBeenCalledTimes(1);
    expect(f.live).toEqual([true, false, true]);
    f.close();
  });

  it('a socket that cannot be made leaves the polls in charge and tries again', () => {
    let calls = 0;
    const f = feed({ createSocket: (url) => { calls += 1; if (calls === 1) throw new Error('blocked'); return new FakeSocket(url); } });
    expect(f.live).toEqual([]);
    vi.advanceTimersByTime(1000);
    expect(calls).toBe(2);
    f.close();
  });

  it('closing it ends it for good: not live, no new try, late frames ignored', () => {
    const f = feed();
    const ws = latest();
    ws.admit();
    f.close();
    expect(f.live).toEqual([true, false]);
    expect(ws.closed).toBe(true);
    ws.frame(frames['orderNew']!);
    vi.advanceTimersByTime(60_000);
    expect(FakeSocket.all).toHaveLength(1);
    expect(f.events).toEqual([]);
  });
});

describe('the polls slow only while a store feed is live', () => {
  it('is per store, and never faster than the normal cadence', () => {
    expect(feedPollInterval('s1', 10_000, 30_000)).toBe(10_000);
    setStoreFeedLive('s1', true);
    expect(storeFeedLive('s1')).toBe(true);
    expect(storeFeedLive('s2')).toBe(false);
    expect(storeFeedLive(null)).toBe(false);
    expect(feedPollInterval('s1', 10_000, 30_000)).toBe(30_000);
    expect(feedPollInterval('s2', 10_000, 30_000)).toBe(10_000);
    expect(feedPollInterval('s1', 10_000, 5_000)).toBe(10_000);
    setStoreFeedLive('s1', false);
    expect(feedPollInterval('s1', 10_000, 30_000)).toBe(10_000);
  });
});
