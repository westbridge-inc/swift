import { addToCart, getCart, removeCartLine, updateCartLine, type Cart } from './customer';
import { isPlainLine } from './menu-options';

// [TAP-AUDIT 27 Oct · owner: "every single button tap"] The store page's + and − on the website.
//
// Before: one change at a time for the whole page. A + disabled EVERY + (and Choose, Customise, ×, Checkout) until the
// write AND a re-read of the cart came back (2 round trips), the number moved only then, and a tap on another item in
// that window was dropped without a word.
//
// Now each item keeps what the customer tapped to (`target`): the number shows it at once, other items stay free, and
// taps add up. One request at a time per item, built from what the server last said about THAT item — its write's own
// answer (POST/PUT/DELETE /cart/items answer with the whole cart) or a fresh read — never from a quantity nobody has
// confirmed, so an add is never counted twice. A request is sent again only for a NEW tap (a server that keeps a
// different quantity is believed, never argued with). When nothing is out for an item the cart is read once and the
// page shows the server's cart again. Prices are never computed here: only the quantity the customer asked for.

type Line = Cart['items'][number];
/** What the server holds for an item: its total across lines, and the line a tap may set (its only line, plain). */
export type ItemHold = { total: number; line: Line | null };
export type TapSend = { kind: 'add'; quantity: number } | { kind: 'set'; lineId: string; quantity: number } | { kind: 'remove'; lineId: string };

const MAX_LINE = 99;

export function itemHold(cart: Cart | null | undefined, itemId: string): ItemHold {
  const lines = (cart?.items ?? []).filter((line) => line.itemId === itemId);
  return { total: lines.reduce((sum, line) => sum + line.quantity, 0), line: lines.length > 0 && lines.every(isPlainLine) ? lines.at(-1)! : null };
}

/** The highest total a tap can ask for: a line holds at most 99 (the server's cap); an add is one more line's worth. */
function ceiling(held: ItemHold): number {
  return held.line ? MAX_LINE + held.total - held.line.quantity : held.total + MAX_LINE;
}

/** The request that takes the item from what the server holds to the tapped total; null when there is none. */
export function tapSend(target: number, held: ItemHold): TapSend | null {
  if (target === held.total) return null;
  if (held.line) {
    const quantity = target - (held.total - held.line.quantity);
    return quantity > 0 ? { kind: 'set', lineId: held.line.id, quantity } : { kind: 'remove', lineId: held.line.id };
  }
  // No line a tap may set (none yet, or a chosen one): + adds the plain item; a − has nothing it may take.
  return target > held.total ? { kind: 'add', quantity: target - held.total } : null;
}

/** The cart a cart write answered with (null: its last line went); undefined when the answer is not one. */
export function answeredCart(answer: unknown): Cart | null | undefined {
  const body = answer && typeof answer === 'object' && 'success' in answer ? (answer as { data?: unknown }).data : answer;
  if (!body || typeof body !== 'object' || !('cart' in body)) return undefined;
  const cart = (body as { cart: unknown }).cart;
  if (cart === null) return null;
  return cart && typeof cart === 'object' && Array.isArray((cart as Cart).items) ? (cart as Cart) : undefined;
}

type Entry = {
  name: string;
  /** What the customer tapped to; null for a change that is not a tap (a chosen add, a ×): the cart's number shows. */
  target: number | null;
  /** What the server last said about this item; null until a read says it (an answer that was not a cart, a refusal). */
  held: ItemHold | null;
  sent: number | null;
  out: boolean;
  /** Which write answer this item's last one was (a read started after it includes it). */
  answered: number;
};

export type CartTapsIO = {
  /** The store whose + adds an item. */
  vendorId: string;
  /** Stand-ins for the cart's own requests (tests); the page leaves them out (this chunk sends them, not the page). */
  send?: (_itemId: string, _request: TapSend) => Promise<unknown>;
  read?: () => Promise<Cart>;
  /** A fresh read of the cart: show it. */
  show: (_cart: Cart) => void;
  changed: () => void;
  failed: (_error: unknown) => void;
  added: (_name: string) => void;
};

/** `io` hands back the page's current callbacks (they change with every render). */
export function cartTaps(io: () => CartTapsIO) {
  const items = new Map<string, Entry>();
  let answers = 0;
  let reading = false;
  let readAgain = false;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;

  const send = (itemId: string, request: TapSend) => io().send?.(itemId, request) ?? (request.kind === 'add'
    ? addToCart({ vendorId: io().vendorId, itemId, quantity: request.quantity })
    : request.kind === 'set' ? updateCartLine(request.lineId, request.quantity) : removeCartLine(request.lineId));

  const drive = async (id: string) => {
    const entry = items.get(id);
    if (!entry || entry.out || !entry.held || entry.target === null) return;
    entry.out = true;
    let wrote = false;
    try {
      while (entry.held && entry.sent !== entry.target) {
        const request = tapSend(entry.target, entry.held);
        if (!request) {
          // [REVIEW-F #2146 S3-1] Nothing can take the item there (it is already there, or only a chosen line is left
          // for a −): it is done — never read again and again for it. The read already asked for shows the server's.
          entry.sent = entry.target;
          break;
        }
        wrote = true;
        const sent = entry.target;
        const from = entry.held.total;
        entry.sent = sent;
        const fresh = answeredCart(await send(id, request));
        entry.answered = ++answers;
        entry.held = fresh === undefined ? null : itemHold(fresh, id);
        if (sent > from) io().added(entry.name);
      }
    } catch (error) {
      // Refused or failed: the cart's own number shows again once it is read (the words say why).
      entry.target = null;
      entry.held = null;
      entry.answered = ++answers;
      io().failed(error);
    } finally {
      entry.out = false;
      // Never told the server anything: the page's cart is the server's, nothing to wait for.
      if (!wrote && !entry.answered && entry.target !== null) items.delete(id);
      io().changed();
      if (wrote) void settle();
    }
  };

  /** Read the cart once nothing is out for an item; each item whose last answer the read includes is settled by it. */
  const settle = async () => {
    if (stopped) return;
    if (reading) { readAgain = true; return; }
    if (![...items.values()].some((entry) => !entry.out)) return;
    reading = true;
    clearTimeout(retry);
    const from = answers;
    try {
      const cart = await (io().read ?? getCart)();
      if (stopped) return;
      io().show(cart);
      for (const [id, entry] of items) {
        if (entry.out || entry.answered > from) continue;
        // Taps made while the server's number was not known go now, from this read.
        if (entry.target !== null && entry.sent !== entry.target) {
          entry.held = itemHold(cart, id);
          if (tapSend(entry.target, entry.held)) { void drive(id); continue; }
        }
        items.delete(id);
      }
    } catch (error) {
      // Nothing is built from a cart this page could not read: say so and read again shortly.
      io().failed(error);
      retry = setTimeout(() => void settle(), 3000);
    } finally {
      reading = false;
      io().changed();
      if (readAgain) { readAgain = false; void settle(); }
    }
  };

  return {
    /** What a row shows: the tapped number while the item has taps the page has not read back. */
    shown: (id: string, cartTotal: number) => items.get(id)?.target ?? cartTotal,
    /** The item cannot take a tap now (a chosen add or × is out, or its number is being read again). */
    blocked: (id: string) => {
      const entry = items.get(id);
      return !!entry && (entry.target === null || (!entry.out && !entry.held));
    },
    /** The item has any change the page has not read back (its Choose, Customise and × wait). */
    busy: (id: string) => items.has(id),
    /** Any change not read back yet: Checkout waits. */
    pending: () => items.size > 0,
    /** A tap on + or −: `cart` is the one this page shows (trusted only while the item has nothing out). */
    tap: (id: string, name: string, step: 1 | -1, cart: Cart | null) => {
      const now = itemHold(cart, id);
      let entry = items.get(id);
      if (entry && (entry.target === null || (!entry.out && !entry.held))) return;
      const held = entry?.held ?? now;
      const target = Math.max(0, Math.min(ceiling(held), (entry?.target ?? now.total) + step));
      if (!entry) {
        if (target === now.total) return;
        entry = { name, target, held: now, sent: null, out: false, answered: 0 };
        items.set(id, entry);
      } else entry.target = target;
      io().changed();
      void drive(id);
    },
    /** A change that is not a tap (an add with choices, a ×): the item waits until the cart is read again. */
    hold: async (id: string, name: string, work: () => Promise<unknown>) => {
      if (items.has(id)) return false;
      const entry: Entry = { name, target: null, held: null, sent: null, out: true, answered: 0 };
      items.set(id, entry);
      io().changed();
      try {
        await work();
        return true;
      } catch (error) {
        io().failed(error);
        return false;
      } finally {
        entry.answered = ++answers;
        entry.out = false;
        io().changed();
        void settle();
      }
    },
    /** The page is shown (again) or gone: a gone page reads nothing. */
    live: (on: boolean) => { stopped = !on; clearTimeout(retry); if (on) void settle(); },
  };
}

export type CartTaps = ReturnType<typeof cartTaps>;
