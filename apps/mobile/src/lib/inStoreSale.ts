// [IN-STORE-SALE · owner 27 Oct: "build it, but safely"] "Sold in store −1" on a tracked item's row.
//
// A store with no till system sells an item at the counter and must take it off its Swift stock at once, so an app
// order never sells the one that is gone. Before, that took ~5 taps inside the item editor (Adjust stock, type -1,
// pick a reason, Apply). Now it is ONE tap on the item's row in the menu list, on the phone and on the website (the
// website imports this file, so the words and the rules are the same).
//
// The rules for a tap (the TAP-AUDIT patterns): the count moves at the tap and settles on the server's answer. Each
// item keeps its own line of taps: only that item waits, taps add up, one request at a time per item, each tap with
// its OWN key (POST /vendor/items/:id/in-store-sale, Idempotency-Key): a resend of the same tap is answered with its
// receipt and never takes two; two taps take two. No tap is lost and nothing is sent again by itself:
//   - a refusal (the server answered no, e.g. "0 left") drops that item's waiting taps and says why in the server's
//     words; the list is read again;
//   - no answer (offline, a timeout, a server error) keeps the taps and offers "Try again", which sends the SAME
//     keys (a tap that did land is answered with its receipt; one that did not is taken now).
// Undo (shown for a short time after a tap) takes back the newest tap of the burst: a tap never sent is simply
// removed; a sent one is answered by POST .../in-store-sale/undo { saleKey }, which the server writes as a NEW
// compensating ledger row (once per sale, whatever the resends).
//
// Pure: no React, no network, no imports. The phone (hooks/vendorops useSoldInStoreSender) and the website
// (dashboard/inventory/sold-in-store) give it a sender; subscribers hear whenever what a row shows may differ.

export const SOLD_IN_STORE = {
  button: 'Sold in store −1',
  a11yHint: 'Takes one off your Swift stock, for one you sold in person.',
  sold: (n: number) => `Sold ${n} in store`,
  undo: 'Undo',
  tryAgain: 'Try again',
  notSent: (n: number) => (n === 1 ? 'This sale hasn’t reached Swift yet.' : `${n} sales haven’t reached Swift yet.`),
  noneLeft: "You have 0 of this left on Swift. Update the stock if that's wrong.",
  untracked: "Stock isn't counted for this item. Add a stock number to track it.",
} as const;

/** How long "Sold 1 in store · Undo" stays after the last tap. */
export const SOLD_UNDO_MS = 8000;

export type SaleOp = { kind: 'sale'; key: string } | { kind: 'undo'; saleKey: string };
/** The server's answer to a tap or an Undo (only what a row needs). */
export type SaleAnswer = { stockQuantity?: unknown; isAvailable?: unknown } | null | undefined;
/** A failure: the server said no (`refused`, in its words), or no answer came (`noAnswer`: it may or may not have landed). */
export type SaleFailure = { refused: string } | 'noAnswer';

export interface SaleSender {
  /** A fresh key for a new tap (a random UUID: two taps never share one). */
  newKey: () => string;
  send: (_itemId: string, _op: SaleOp) => Promise<SaleAnswer>;
  /** The server's answer for that item: written into the list on screen (for the store the tap was made in). */
  answered: (_itemId: string, _answer: SaleAnswer, _scope: unknown) => void;
  /** After a refusal: read the list again (it shows the server's count). */
  reread: () => void;
  classify: (_error: unknown) => SaleFailure;
}

type Queued = SaleOp & { scope: unknown; /** sent at least once: it may have landed, so it is never dropped quietly */ tried: boolean };
type Entry = {
  queue: Queued[];
  out: boolean;
  /** Taps of the current burst that still count (newest last): Undo takes back the last one. */
  burst: string[];
  undoUntil: number;
  timer: ReturnType<typeof setTimeout> | null;
  /** Taps waiting for "Try again" (no answer came). */
  stalled: boolean;
  notice: string | null;
  /** The server's count in its last answer, shown until the list on screen moves (it is written into the list, but
   *  the list may draw a moment after this row: without it the row would flash the count from before the tap). */
  answered: number | null;
  /** The list's count when the row first drew after that answer (undefined: not drawn since). */
  basis: number | undefined;
};

/** What an item's row shows. `pending` is added to the server's count (−1 per tap not answered yet, +1 per Undo). */
export type SaleView = { pending: number; sold: number; notice: string | null; stalled: boolean; unsent: number };

const IDLE: SaleView = { pending: 0, sold: 0, notice: null, stalled: false, unsent: 0 };

export function createSoldInStore(now: () => number = Date.now) {
  const entries = new Map<string, Entry>();
  const listeners = new Set<() => void>();
  let sender: SaleSender | null = null;
  let version = 0;
  const changed = () => { version += 1; listeners.forEach((listener) => listener()); };

  const entryOf = (itemId: string): Entry => {
    let entry = entries.get(itemId);
    if (!entry) {
      entry = { queue: [], out: false, burst: [], undoUntil: 0, timer: null, stalled: false, notice: null, answered: null, basis: undefined };
      entries.set(itemId, entry);
    }
    return entry;
  };
  const showUndo = (entry: Entry) => {
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = null;
    if (entry.burst.length === 0) { entry.undoUntil = 0; return; }
    entry.undoUntil = now() + SOLD_UNDO_MS;
    entry.timer = setTimeout(() => { entry.timer = null; entry.burst = []; entry.undoUntil = 0; changed(); }, SOLD_UNDO_MS);
  };

  /** One request at a time for the item, in tap order, until its line is empty, refused, or unanswered. */
  async function drive(itemId: string, entry: Entry) {
    if (entry.out || entry.stalled) return;
    entry.out = true;
    try {
      while (entry.queue.length > 0 && sender) {
        const head = entry.queue[0]!; // the loop runs only while the line has one
        head.tried = true;
        let answer: SaleAnswer;
        try {
          answer = await sender.send(itemId, head.kind === 'sale' ? { kind: 'sale', key: head.key } : { kind: 'undo', saleKey: head.saleKey });
        } catch (error) {
          const failure = sender?.classify(error) ?? 'noAnswer';
          if (failure === 'noAnswer') {
            // It may have landed: keep every tap, send the same keys again only when the person asks.
            entry.stalled = true;
          } else {
            // The server said no: nothing of this one moved. The taps behind it would be refused too: they go, and
            // the words say why; the list is read again for the server's count.
            entry.queue = [];
            entry.burst = [];
            showUndo(entry);
            entry.notice = failure.refused;
            sender?.reread();
          }
          break;
        }
        entry.queue.shift();
        const count = (answer as { stockQuantity?: unknown } | null | undefined)?.stockQuantity;
        if (typeof count === 'number') { entry.answered = count; entry.basis = undefined; }
        sender.answered(itemId, answer, head.scope);
        changed();
      }
    } finally {
      entry.out = false;
      changed();
    }
  }

  function view(itemId: string): SaleView {
    const entry = entries.get(itemId);
    if (!entry) return IDLE;
    let pending = 0;
    for (const op of entry.queue) pending += op.kind === 'sale' ? -1 : 1;
    const sold = entry.undoUntil > now() ? entry.burst.length : 0;
    return { pending, sold, notice: entry.notice, stalled: entry.stalled, unsent: entry.queue.length };
  }

  return {
    /** The page or screen that sends now (the newest one: a closed screen's taps still finish). */
    setSender(next: SaleSender) { sender = next; },
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    snapshot: () => version,

    view,

    /** One sold in person. `scope` comes back with its answer (the store it was tapped in). */
    tap(itemId: string, scope?: unknown) {
      if (!sender) return;
      const entry = entryOf(itemId);
      const key = sender.newKey();
      entry.notice = null;
      entry.queue.push({ kind: 'sale', key, scope, tried: false });
      entry.burst.push(key);
      showUndo(entry);
      changed();
      void drive(itemId, entry);
    },

    /** Take back the newest tap of the burst. */
    undo(itemId: string, scope?: unknown) {
      const entry = entries.get(itemId);
      const key = entry?.burst.pop();
      if (!entry || !key) return;
      const unsent = entry.queue.findIndex((op) => op.kind === 'sale' && op.key === key && !op.tried);
      if (unsent >= 0) entry.queue.splice(unsent, 1); // never sent: nothing to put back
      else entry.queue.push({ kind: 'undo', saleKey: key, scope, tried: false });
      showUndo(entry);
      changed();
      void drive(itemId, entry);
    },

    /** "Try again" after no answer: the same taps, the same keys. */
    retry(itemId: string) {
      const entry = entries.get(itemId);
      if (!entry || !entry.stalled) return;
      entry.stalled = false;
      changed();
      void drive(itemId, entry);
    },

    /** Is a request on its way for any item? (A re-read of the list waits for it: landing first, it would show the
     *  count from before the tap for a moment.) */
    inFlight: () => [...entries.values()].some((entry) => entry.out),
    /** A row's snapshot for a subscriber that redraws only when ITS item's view changes. */
    viewKey(itemId: string): string {
      const v = view(itemId);
      return `${v.pending}|${v.sold}|${v.stalled ? 1 : 0}|${v.unsent}|${v.notice ?? ''}|${entries.get(itemId)?.answered ?? ''}`;
    },

    /**
     * The count a tracked row shows, given the list's count: moved by the taps not answered yet, and settled on the
     * server's last answer until the list itself moves (the answer's own write, or a re-read). Never below 0.
     */
    shown(itemId: string, listCount: number): number {
      const entry = entries.get(itemId);
      let base = listCount;
      if (entry && entry.answered !== null) {
        if (entry.basis === undefined) entry.basis = listCount;
        if (listCount === entry.basis) base = entry.answered;
        else { entry.answered = null; entry.basis = undefined; }
      }
      return Math.max(0, base + view(itemId).pending);
    },

    /** Forget every item's taps (another person signed in; tests). */
    reset() {
      for (const entry of entries.values()) if (entry.timer) clearTimeout(entry.timer);
      entries.clear();
      changed();
    },
  };
}

export type SoldInStore = ReturnType<typeof createSoldInStore>;
