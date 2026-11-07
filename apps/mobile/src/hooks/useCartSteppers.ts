import { useEffect, useRef, useSyncExternalStore } from 'react';
import { useAddToCart, useUpdateCartItem } from './customer';
import { useAuthStore } from '../stores/authStore';
import { answeredCart, clampQty, heldQty, isPlainLine, maxQtyFor, nextSend, type CartLine } from '../lib/cartSteppers';

/** How to add an item that is not in the cart yet (the store page's + on an option-less item). */
type AddAs = { vendorId: string; itemId: string };
type Entry = {
  /** 'line:<id>' — or 'item:<id>' for an item whose add has no line yet. */
  key: string;
  /** What the customer tapped to; null after a refusal (the cart's own number shows until it is read again). */
  target: number | null;
  /** The server's line as it last said (null: none yet); undefined: not known until the cart is read again. */
  line: CartLine | null | undefined;
  sent: number | null;
  out: boolean;
  /** When its last write answered: a cart read after that includes it (the cart hooks ask for one before answering). */
  answeredAt: number;
  addAs?: AddAs;
};
type Sender = {
  add: (_body: AddAs & { quantity: number }) => Promise<unknown>;
  update: (_body: { id: string; quantity: number }) => Promise<unknown>;
  reread: () => void;
};

// [TAP-AUDIT · REVIEW-F #2145 S4-2] ONE stepper per cart line for the whole app: the store page and the cart show and
// change the same one (a store page left open under the cart can no longer send over a change made in the cart), it
// keeps going when the screen that started it closes (a tap is never dropped), and the cart's Place order waits for
// every line's taps, wherever they were made.
const entries = new Map<string, Entry>();
const aliases = new Map<string, string>();
const listeners = new Set<() => void>();
let version = 0;
let sender: Sender | null = null;
let generation: number | null = null;

const notify = () => { version += 1; listeners.forEach((listener) => listener()); };
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
const snapshot = () => version;

function keyOf(key: string, line: CartLine | null | undefined) {
  if (!line) return aliases.get(`item:${key}`) ?? `item:${key}`;
  const byLine = `line:${line.id}`;
  // [REVIEW-F #2148 S4-1] A read can show the line an add made before the add's own answer arrives: that line is the
  // add's stepper (never a second one for the same line).
  const adding = !entries.has(byLine) && line.itemId && isPlainLine(line) ? entries.get(`item:${line.itemId}`) : undefined;
  return adding ? adding.key : byLine;
}
const plainLineOf = (items: CartLine[], itemId: string) => {
  const lines = items.filter((line) => line.itemId === itemId);
  return lines.find(isPlainLine) ?? (lines.length === 1 ? lines[0] : undefined);
};

function drop(entry: Entry) {
  if (entries.get(entry.key) === entry) entries.delete(entry.key);
  for (const [from, to] of aliases) if (to === entry.key) aliases.delete(from);
}

/** Its add has a line now: the store page (still asking by item) and the cart (asking by line) find the same stepper. */
function rekey(entry: Entry, key: string) {
  if (entry.key === key || entries.has(key)) return;
  entries.delete(entry.key);
  if (entry.key.startsWith('item:')) aliases.set(entry.key, key);
  entry.key = key;
  entries.set(key, entry);
}

/** One request at a time for the line, each built from what the server last said about it. */
async function drive(entry: Entry) {
  if (entry.out || entry.target === null || entry.line === undefined) return;
  entry.out = true;
  try {
    while (entry.target !== null && entry.line !== undefined && entry.sent !== entry.target && sender) {
      const send = nextSend(entry.target, entry.line);
      if (!send || (send.kind === 'add' && !entry.addAs)) {
        // Nothing to tell the server. Never answered: the screen's cart is the server's; else a read is on its way.
        entry.sent = entry.target;
        if (!entry.answeredAt) drop(entry);
        break;
      }
      entry.sent = entry.target;
      const answer = send.kind === 'set'
        ? await sender.update({ id: send.lineId, quantity: send.quantity })
        : await sender.add({ ...entry.addAs!, quantity: send.quantity });
      entry.answeredAt = Date.now();
      const cart = answeredCart(answer);
      const fresh = !cart ? undefined
        : send.kind === 'set' ? cart.items.find((line) => line.id === send.lineId) ?? null
          : plainLineOf(cart.items, entry.addAs!.itemId);
      entry.line = fresh;
      if (fresh) rekey(entry, `line:${fresh.id}`);
      // [REVIEW-F #2145 S4-1] No new tap since: the server's quantity is the answer (never sent again).
      if (fresh !== undefined && entry.sent === entry.target) entry.target = entry.sent = heldQty(fresh);
    }
  } catch {
    // Refused or failed (the app-wide notice says why): the cart's own number shows, and the cart is read again.
    entry.target = null;
    entry.sent = null;
    entry.line = undefined;
    entry.answeredAt = Date.now();
    sender?.reread();
  } finally {
    entry.out = false;
    notify();
  }
}

/** A fresh read of the cart: lines it includes are settled; taps made while a line was not known go now. */
function onRead(items: CartLine[], readAt: number) {
  let changed = false;
  for (const entry of [...entries.values()]) {
    if (entry.out || readAt <= entry.answeredAt) continue;
    if (entry.target !== null && entry.sent !== entry.target) {
      const line = entry.key.startsWith('line:')
        ? items.find((l) => `line:${l.id}` === entry.key) ?? null
        : plainLineOf(items, entry.addAs?.itemId ?? entry.key.slice(5)) ?? null;
      entry.line = line;
      if (line) rekey(entry, `line:${line.id}`);
      // [REVIEW-M #2148 S4-1] Only what can be sent: a line gone (another device) with no add details is done.
      const next = nextSend(entry.target, line);
      if (next && (next.kind === 'set' || entry.addAs)) { void drive(entry); continue; }
    }
    drop(entry);
    changed = true;
  }
  if (changed) notify();
}

/** Forget every line's taps (tests; a change of person does this by itself). */
export function forgetCartSteppers() { entries.clear(); aliases.clear(); notify(); }

/**
 * [TAP-AUDIT 27 Oct] The cart's steppers (lib/cartSteppers): the number moves at the tap, only that line has a request
 * out, taps add up, and nothing is sent from a quantity nobody has confirmed. `cart` is the screen's cart query: each
 * fresh read settles the lines it includes.
 *
 * `qty(key, line)` is what a stepper shows; `set(key, line, next, addAs?)` is a tap; `settled` is false while any line,
 * on any screen, still has taps the server has not confirmed (the cart's Place order waits for it, as for the quote).
 */
export function useCartSteppers(cart: { data?: unknown; dataUpdatedAt?: number; refetch?: () => unknown }) {
  const add = useAddToCart();
  const update = useUpdateCartItem();
  const session = useAuthStore((state) => state.sessionGeneration);
  // Another person signed in (or out): nothing of the last one's cart carries over.
  if (generation !== session) { entries.clear(); aliases.clear(); generation = session; }
  // The newest screen's cart writes (a closed screen's still finish: the request is already on its way).
  sender = {
    add: (body) => add.mutateAsync(body),
    update: (body) => update.mutateAsync(body),
    reread: () => { void cart.refetch?.(); },
  };
  useSyncExternalStore(subscribe, snapshot, snapshot);

  const items = (cart.data as { items?: CartLine[] } | null | undefined)?.items ?? [];
  const latest = useRef(items);
  latest.current = items;
  const readAt = cart.dataUpdatedAt ?? 0;
  useEffect(() => { onRead(latest.current, readAt); }, [readAt]);

  return {
    qty: (key: string, line: CartLine | null | undefined) => entries.get(keyOf(key, line))?.target ?? heldQty(line),
    set: (key: string, line: CartLine | null | undefined, next: number, addAs?: AddAs) => {
      const k = keyOf(key, line);
      // [BOOK-POLISH] A booking line never goes past 1 (no request for a number the server refuses).
      const target = clampQty(next, maxQtyFor(line));
      let entry = entries.get(k);
      if (!entry) {
        if (target === heldQty(line)) return;
        entry = { key: k, target, line: line ?? null, sent: null, out: false, answeredAt: 0, addAs };
        entries.set(k, entry);
      } else {
        entry.target = target;
        if (addAs) entry.addAs = addAs;
      }
      notify();
      void drive(entry);
    },
    settled: entries.size === 0,
  };
}
