import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// [DISPATCH 1/3 · AX299 F2] THE CARD ON SCREEN IS A CARD THAT IS LIVE.
//
// A cancel withdraws the order's live card and frees the mover at once, so the
// next offer can ring a second later. The app kept the dead card on top of its
// queue until that card's own deadline; the new card queued behind it and was
// marked seen the moment it arrived, so it could lapse hidden and be charged
// as an offer the mover saw and ignored. Now:
//   * the server says which card went (`dispatch:offer_withdrawn`, order AND
//     attempt) and the app drops exactly that card;
//   * a card is marked seen when it is on screen, never on arrival;
//   * (server side, dispatch-races.test.ts) a card sent while a withdrawn one
//     could still be showing is never charged, whatever the app did.
//
// Driven through the REAL hook. A plain function call has no renderer behind
// it, so React's three hooks are answered by the small runtime below (state,
// effects with their dependencies and cleanups, refs), and the hook's four
// collaborators are stubbed: the socket, the offer API, the query client and
// the preview flag.
// ---------------------------------------------------------------------------

type Slot = {
  state?: unknown;
  ref?: { current: unknown };
  deps?: readonly unknown[];
  cleanup?: void | (() => void);
  pending?: () => void | (() => void);
};

const h = vi.hoisted(() => {
  const rt = { slots: [] as Slot[], i: 0, dirty: false };
  const handlers = new Map<string, Set<(payload: unknown) => void>>();
  const socket = {
    on: (event: string, fn: (payload: unknown) => void) => {
      if (!handlers.has(event)) handlers.set(event, new Set());
      handlers.get(event)!.add(fn);
    },
    off: (event: string, fn: (payload: unknown) => void) => { handlers.get(event)?.delete(fn); },
  };
  /** The server emits to this device. */
  const server = (event: string, payload?: unknown) => {
    for (const fn of [...(handlers.get(event) ?? [])]) fn(payload);
  };
  const api = {
    offerSeen: (..._args: unknown[]) => Promise.resolve({}),
    currentOffer: () => Promise.resolve({ data: { data: { offer: null as unknown } } }),
  };
  const queryClient = { invalidateQueries: () => undefined };
  return { rt, handlers, socket, server, api, queryClient };
});

vi.mock('react', () => {
  const next = (): Slot => {
    const i = h.rt.i++;
    h.rt.slots[i] ??= {};
    return h.rt.slots[i]!;
  };
  function useState<T>(initial: T | (() => T)) {
    const slot = next();
    if (!('state' in slot)) slot.state = typeof initial === 'function' ? (initial as () => T)() : initial;
    const set = (value: T | ((prev: T) => T)) => {
      slot.state = typeof value === 'function' ? (value as (prev: T) => T)(slot.state as T) : value;
      h.rt.dirty = true;
    };
    return [slot.state as T, set] as const;
  }
  function useEffect(effect: () => void | (() => void), deps?: readonly unknown[]) {
    const slot = next();
    const changed = !slot.deps || !deps || deps.length !== slot.deps.length || deps.some((d, k) => !Object.is(d, slot.deps![k]));
    if (changed) {
      slot.deps = deps;
      slot.pending = effect;
    }
  }
  function useRef<T>(initial: T) {
    const slot = next();
    slot.ref ??= { current: initial };
    return slot.ref as { current: T };
  }
  const hooks = { useState, useEffect, useRef };
  return { ...hooks, default: hooks };
});
vi.mock('@tanstack/react-query', () => ({ useQueryClient: () => h.queryClient }));
vi.mock('../services/api', () => ({ driverApi: h.api, riderApi: h.api }));
vi.mock('../services/socket', () => ({ connectSocket: () => undefined, getSocket: () => h.socket }));
vi.mock('../stores/moverPreview', () => ({
  useMoverPreview: (select: (s: { preview: boolean }) => unknown) => select({ preview: false }),
}));

import { useDispatchOffers, type DispatchOffer } from './dispatchOffers';

/** The mover home screen's use of the hook, as a component: called as a plain
 *  function once per render pass, the kit tests' way (card.test.ts). */
function OfferHost({ kind, online }: { kind: 'DRIVER' | 'RIDER'; online: boolean }) {
  return useDispatchOffers(kind, online);
}

/** Render until the state settles: run each effect whose dependencies changed
 *  (its previous cleanup first), re-render while an effect or event set state. */
function render(kind: 'DRIVER' | 'RIDER' = 'DRIVER', online = true) {
  let view!: ReturnType<typeof OfferHost>;
  let passes = 0;
  do {
    h.rt.dirty = false;
    h.rt.i = 0;
    view = OfferHost({ kind, online });
    for (const slot of h.rt.slots) {
      if (!slot.pending) continue;
      const run = slot.pending;
      slot.pending = undefined;
      if (typeof slot.cleanup === 'function') slot.cleanup();
      slot.cleanup = run();
    }
  } while (h.rt.dirty && ++passes < 20);
  return view;
}

/** Let the recovery request (a resolved promise) land, then render. */
async function settle(kind: 'DRIVER' | 'RIDER' = 'DRIVER') {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  return render(kind);
}

const card = (orderId: string, offerAttemptId: string, expiresInSeconds = 20): DispatchOffer => ({ orderId, offerAttemptId, expiresInSeconds });
let seenCalls: string[] = [];
const deadlineOf = (offer: DispatchOffer | null) => (offer as (DispatchOffer & { deadlineAt?: number }) | null)?.deadlineAt;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-09-30T02:00:00.000Z'));
  h.rt.slots = [];
  h.handlers.clear();
  seenCalls = [];
  h.api.offerSeen = (orderId: unknown, attemptId: unknown) => {
    seenCalls.push(`${String(orderId)}:${String(attemptId)}`);
    return Promise.resolve({});
  };
  h.api.currentOffer = () => Promise.resolve({ data: { data: { offer: null } } });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('[AX299 F2] a withdrawn card leaves the screen at once', () => {
  it('cancel A, then B at once: the withdrawal drops A the moment it lands, and B is on screen with its whole window, seen once', async () => {
    await settle();
    h.server('dispatch:offer', card('A', 'a1'));
    expect(render().offer?.orderId).toBe('A');
    expect(seenCalls).toEqual(['A:a1']);

    vi.advanceTimersByTime(3_000);
    h.server('dispatch:offer_withdrawn', { orderId: 'A', offerAttemptId: 'a1', reason: 'ORDER_CANCELLED' });
    expect(render().offer, 'the withdrawn card is gone from the screen').toBeNull();

    h.server('dispatch:offer', card('B', 'b1'));
    const view = render();
    expect(view.offer?.orderId).toBe('B');
    expect(view.queuedBehind).toBe(0);
    expect(deadlineOf(view.offer), 'B shows its whole window, not what A left of it').toBe(Date.now() + 20_000);
    expect(seenCalls).toEqual(['A:a1', 'B:b1']);
  });

  it('a withdrawal names ONE card: a newer attempt of the same order stays, and so does every other order', async () => {
    await settle();
    h.server('dispatch:offer', card('A', 'a2'));
    h.server('dispatch:offer', card('C', 'c1'));
    expect(render().queuedBehind).toBe(1);

    // An older attempt of A was withdrawn: the card on screen is a2, it stays.
    h.server('dispatch:offer_withdrawn', { orderId: 'A', offerAttemptId: 'a1', reason: 'ORDER_CANCELLED' });
    let view = render();
    expect([view.offer?.orderId, view.offer?.offerAttemptId, view.queuedBehind]).toEqual(['A', 'a2', 1]);

    // C was withdrawn while it waited: it goes, A stays on screen.
    h.server('dispatch:offer_withdrawn', { orderId: 'C', offerAttemptId: 'c1', reason: 'ORDER_CANCELLED' });
    view = render();
    expect([view.offer?.orderId, view.offer?.offerAttemptId, view.queuedBehind]).toEqual(['A', 'a2', 0]);
    expect(seenCalls, 'C never reached the screen, so it was never marked seen').toEqual(['A:a2']);
  });
});

describe('[AX299 F2] seen means shown', () => {
  it('a card queued behind another is not marked seen until it reaches the screen', async () => {
    await settle();
    h.server('dispatch:offer', card('A', 'a1'));
    h.server('dispatch:offer', card('B', 'b1'));
    const view = render();
    expect([view.offer?.orderId, view.queuedBehind]).toEqual(['A', 1]);
    expect(seenCalls, 'B is waiting behind A, not on screen').toEqual(['A:a1']);

    view.dismiss(); // the mover answered A
    expect(render().offer?.orderId).toBe('B');
    expect(seenCalls).toEqual(['A:a1', 'B:b1']);
  });

  it('the withdrawal never arrives: B waits unseen behind the dead card, is shown and marked seen when A runs out, and a card whose window ran out while it waited leaves unseen', async () => {
    await settle();
    h.server('dispatch:offer', card('A', 'a1', 20));
    render();
    vi.advanceTimersByTime(5_000);
    h.server('dispatch:offer', card('B', 'b1', 20)); // deadline: 25 s from A's arrival
    render();
    expect(seenCalls).toEqual(['A:a1']);

    vi.advanceTimersByTime(15_000); // A's own deadline
    let view = render();
    expect(view.offer?.orderId, 'A leaves at its deadline').toBe('B');
    expect(seenCalls).toEqual(['A:a1', 'B:b1']);

    h.server('dispatch:offer', card('D', 'd1', 3)); // queued behind B, its 3 s run out first
    render();
    vi.advanceTimersByTime(5_000); // B's deadline; D's passed 2 s ago
    view = render();
    expect(view.offer, 'D ran out while it waited: it is dropped, not shown').toBeNull();
    expect(seenCalls, 'and never marked seen').toEqual(['A:a1', 'B:b1']);
  });

  it('a recovered card is marked seen when it is on screen, like a live one', async () => {
    h.api.currentOffer = () => Promise.resolve({ data: { data: { offer: { orderId: 'R', offerAttemptId: 'r1', expiresInSeconds: 12 } } } });
    render();
    const view = await settle();
    expect([view.offer?.orderId, view.offer?.offerAttemptId]).toEqual(['R', 'r1']);
    expect(seenCalls).toEqual(['R:r1']);
  });
});
