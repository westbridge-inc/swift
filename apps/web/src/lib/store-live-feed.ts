// ---------------------------------------------------------------------------
// [PERF row 8] THE STORE'S LIVE FEED ON THE WEBSITE — the business app's.
//
// The partner dashboard learned about a new order, or a change to one, only on
// its next poll: the orders list and the open order every 10 s, the overview
// every 30 s. So a new order reached the website up to 10 s after the phone.
// The business app hears its store through the API's store socket (the
// store's room, vendor:<id>: order:new, order:status_changed,
// order:prep_update, order:pick_state). This is the same socket, the same room
// and the same server checks; the website reaches it at /api/v1/socket.io/ so
// the browser sends its HttpOnly access cookie (the website holds no token,
// W-01), and names itself 'web' in the handshake.
//
// A frame is only a trigger. The client never shows what a frame says: an
// event makes the dashboard re-read the order through its normal request,
// with every check that request has. Polls stay as the fallback: they slow
// only while this feed is live (the phone's rule, pollPolicy.ts), and any
// error, close, refusal or missed heartbeat puts them back at full speed at
// once.
//
// The wire format is the Socket.IO v5 text protocol over Engine.IO v4, the
// small part of it this feed uses (the WebSocket transport, the default
// namespace, text frames). It is written here rather than taken as a package
// so the website gains no dependency (about 2 kB gzipped). The frames below are the
// ones the API really sends: store-live-feed.frames.json, recorded by the
// API's socket-browser-cookie test, which fails if the server ever changes them.
// ---------------------------------------------------------------------------

import { useSyncExternalStore } from 'react';

/** The store-room events that change what the dashboard shows. */
export const STORE_FEED_EVENTS = ['order:new', 'order:status_changed', 'order:prep_update', 'order:pick_state'] as const;
export type StoreFeedEvent = (typeof STORE_FEED_EVENTS)[number];

/** Where the website opens the store socket (under the access cookie's Path). */
export const STORE_FEED_PATH = '/api/v1/socket.io/';

export type FeedFrame =
  | { kind: 'open'; pingInterval: number; pingTimeout: number }
  | { kind: 'ping' }
  | { kind: 'close' }
  | { kind: 'connected' }
  | { kind: 'connect-error'; message: string }
  | { kind: 'disconnect' }
  | { kind: 'event'; name: string; payload: unknown }
  /** Anything else (a noop, an ack, another namespace, a frame this build does not know): ignored. */
  | { kind: 'other' };

const OTHER: FeedFrame = { kind: 'other' };

function json(text: string): unknown {
  try { return JSON.parse(text); } catch { return undefined; }
}

const positive = (value: unknown, fallback: number) =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;

/** One text frame -> what it means to this feed. Never throws. */
export function parseFeedFrame(text: unknown): FeedFrame {
  if (typeof text !== 'string' || text.length === 0) return OTHER;
  switch (text[0]) {
    case '0': {
      const open = json(text.slice(1)) as { pingInterval?: unknown; pingTimeout?: unknown } | undefined;
      if (!open || typeof open !== 'object') return OTHER;
      return { kind: 'open', pingInterval: positive(open.pingInterval, 25_000), pingTimeout: positive(open.pingTimeout, 20_000) };
    }
    case '1': return { kind: 'close' };
    case '2': return { kind: 'ping' };
    case '4': return parseSocketPacket(text.slice(1));
    default: return OTHER;
  }
}

function parseSocketPacket(packet: string): FeedFrame {
  const type = packet[0];
  let rest = packet.slice(1);
  // Another namespace is not this feed's; a namespace is written "/name,".
  if (rest.startsWith('/')) return OTHER;
  switch (type) {
    case '0': return { kind: 'connected' };
    case '1': return { kind: 'disconnect' };
    case '4': {
      const refusal = json(rest) as { message?: unknown } | undefined;
      return { kind: 'connect-error', message: typeof refusal?.message === 'string' ? refusal.message : 'refused' };
    }
    case '2': {
      rest = rest.replace(/^\d+/, ''); // an ack id, if the server ever asks for one
      const event = json(rest);
      if (!Array.isArray(event) || typeof event[0] !== 'string') return OTHER;
      return { kind: 'event', name: event[0], payload: event[1] };
    }
    default: return OTHER;
  }
}

/** The socket URL for an API origin (https -> wss, http -> ws). */
export function storeFeedUrl(apiOrigin: string): string {
  const url = new URL(STORE_FEED_PATH, apiOrigin);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.search = '?EIO=4&transport=websocket';
  return url.toString();
}

/** The reconnect wait after `failures` failures in a row: 1 s doubling to 30 s, with jitter. */
export function reconnectDelayMs(failures: number, random: () => number = Math.random): number {
  const base = Math.min(30_000, 1_000 * 2 ** Math.max(0, Math.min(failures, 5)));
  return Math.round(base * (0.5 + 0.5 * random()));
}

type FeedSocket = Pick<WebSocket, 'send' | 'close'> & {
  onopen: ((_event: unknown) => void) | null;
  onmessage: ((_event: { data: unknown }) => void) | null;
  onclose: ((_event: unknown) => void) | null;
  onerror: ((_event: unknown) => void) | null;
};

export interface StoreFeedOptions {
  /** storeFeedUrl(API origin) */
  url: string;
  storeId: string;
  /** true once the server has authorized the socket and the store room is asked for; false on any failure. */
  onLive: (_live: boolean) => void;
  /** A store event: re-read what it names. */
  onEvent: (_event: StoreFeedEvent, _payload: { orderId?: string }) => void;
  /** The feed came back after a gap: re-read the board once (an event may have been missed). */
  onResync: () => void;
  createSocket?: (_url: string) => FeedSocket;
  random?: () => number;
}

/** Open the store's live feed; returns the function that closes it for good. */
export function openStoreFeed(options: StoreFeedOptions): () => void {
  const create = options.createSocket ?? ((url: string) => new WebSocket(url) as unknown as FeedSocket);
  let socket: FeedSocket | null = null;
  let stopped = false;
  let live = false;
  let wasLive = false;
  let failures = 0;
  let heartbeat: ReturnType<typeof setTimeout> | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let heartbeatMs = 45_000;

  const setLive = (next: boolean) => {
    if (live === next) return;
    live = next;
    options.onLive(next);
  };

  const armHeartbeat = () => {
    if (heartbeat) clearTimeout(heartbeat);
    // The server pings every pingInterval and waits pingTimeout for the pong;
    // a silence longer than both together is a dead connection.
    heartbeat = setTimeout(() => down(), heartbeatMs);
  };

  const send = (text: string) => {
    try { socket?.send(text); } catch { down(); }
  };

  const down = () => {
    if (heartbeat) { clearTimeout(heartbeat); heartbeat = undefined; }
    const dead = socket;
    socket = null;
    if (dead) {
      dead.onopen = dead.onmessage = dead.onclose = dead.onerror = null;
      try { dead.close(); } catch { /* already closed */ }
    }
    setLive(false);
    if (stopped || retry) return;
    const wait = reconnectDelayMs(failures, options.random);
    failures += 1;
    retry = setTimeout(() => { retry = undefined; connect(); }, wait);
  };

  const onFrame = (frame: FeedFrame) => {
    switch (frame.kind) {
      case 'open':
        heartbeatMs = frame.pingInterval + frame.pingTimeout;
        armHeartbeat();
        send(`40${JSON.stringify({ client: 'web' })}`);
        return;
      case 'ping':
        armHeartbeat();
        send('3');
        return;
      case 'event':
        if (frame.name === 'auth:ready') {
          send(`42${JSON.stringify(['vendor:subscribe', { vendorId: options.storeId }])}`);
          failures = 0;
          setLive(true);
          if (wasLive) options.onResync();
          wasLive = true;
          return;
        }
        if (live && (STORE_FEED_EVENTS as readonly string[]).includes(frame.name)) {
          const payload = frame.payload && typeof frame.payload === 'object' ? frame.payload as { orderId?: unknown } : {};
          options.onEvent(frame.name as StoreFeedEvent, typeof payload.orderId === 'string' ? { orderId: payload.orderId } : {});
        }
        return;
      case 'close':
      case 'disconnect':
      case 'connect-error':
        down();
        return;
      default:
        return;
    }
  };

  const connect = () => {
    if (stopped) return;
    let next: FeedSocket;
    try {
      next = create(options.url);
    } catch {
      down();
      return;
    }
    socket = next;
    heartbeatMs = 45_000;
    armHeartbeat(); // an open frame that never comes is a failure too
    next.onmessage = (event) => { if (socket === next) onFrame(parseFeedFrame(event.data)); };
    next.onclose = () => { if (socket === next) down(); };
    next.onerror = () => { if (socket === next) down(); };
  };

  connect();
  return () => {
    stopped = true;
    if (retry) { clearTimeout(retry); retry = undefined; }
    down();
  };
}

// ── Is a store's feed live right now? (the pages' poll cadence reads this) ──

const liveStores = new Set<string>();
const listeners = new Set<() => void>();

export function setStoreFeedLive(storeId: string, live: boolean): void {
  if (live === liveStores.has(storeId)) return;
  if (live) liveStores.add(storeId); else liveStores.delete(storeId);
  for (const listener of listeners) listener();
}

export function storeFeedLive(storeId: string | null | undefined): boolean {
  return !!storeId && liveStores.has(storeId);
}

export function subscribeStoreFeedLive(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** A poll's cadence: `normal` while the feed is down, `live` while it is up (never faster than normal). */
export function feedPollInterval(storeId: string | null | undefined, normal: number, live: number): number {
  return storeFeedLive(storeId) ? Math.max(normal, live) : normal;
}

/** A page's poll cadence for one store's board, re-rendered when the feed goes up or down. */
export function useFeedPollInterval(storeId: string | null | undefined, normal: number, live: number): number {
  const isLive = useSyncExternalStore(subscribeStoreFeedLive, () => storeFeedLive(storeId), () => false);
  return isLive ? Math.max(normal, live) : normal;
}
