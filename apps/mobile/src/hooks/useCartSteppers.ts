import { useCallback, useEffect, useRef, useState } from 'react';
import { useAddToCart, useUpdateCartItem } from './customer';
import { heldQty, isSettled, nextSend, tapTo, type Stepper } from '../lib/cartSteppers';

type Line = { id: string; quantity?: unknown } | null | undefined;
/** How to add an item that is not in the cart yet (the store page's + on an option-less item). */
type AddAs = { vendorId: string; itemId: string };

/**
 * [TAP-AUDIT 27 Oct] The cart's steppers (lib/cartSteppers): the number moves at the tap, only that line has a request
 * out, taps add up, and nothing is sent from a quantity the screen has not seen. `readAt` is the cart query's
 * dataUpdatedAt: each fresh read of the cart lets the next request for a line go (or settles it).
 *
 * `qty(key, line)` is what a stepper shows; `set(key, line, next, addAs?)` is a tap; `settled` is false while any line
 * still has taps the server has not confirmed (the cart's Place order waits for it, as it waits for the quote).
 */
export function useCartSteppers(readAt: number) {
  // The cart hooks hand back a new object on every render: keep the latest in a ref so the steps below stay the same
  // functions (the read effect must run on a fresh cart read only, never on a redraw).
  const add = useAddToCart();
  const update = useUpdateCartItem();
  const writes = useRef({ add, update });
  writes.current = { add, update };
  const steppers = useRef(new Map<string, Stepper>());
  const lines = useRef(new Map<string, { line: Line; addAs?: AddAs }>());
  const [, redraw] = useState(0);
  const changed = useCallback(() => redraw((n) => n + 1), []);

  const flush = useCallback((key: string) => {
    const s = steppers.current.get(key);
    const known = lines.current.get(key);
    if (!s || !known) return;
    if (isSettled(s, known.line)) { steppers.current.delete(key); changed(); return; }
    const send = nextSend(s, known.line);
    if (!send) return;
    if (send.kind === 'add' && !known.addAs) return;
    steppers.current.set(key, { ...s, inFlight: true });
    const { add, update } = writes.current;
    const sent = send.kind === 'set'
      ? update.mutateAsync({ id: send.lineId, quantity: send.quantity })
      : add.mutateAsync({ vendorId: known.addAs!.vendorId, itemId: known.addAs!.itemId, quantity: send.quantity });
    sent.then(
      () => {
        const now = steppers.current.get(key);
        // Answered: the cart is re-read (the hooks ask for it); the next request for this line waits for that read.
        if (now) steppers.current.set(key, { ...now, inFlight: false, awaitingRead: true });
        changed();
      },
      () => {
        // Refused or failed (the app-wide notice says why): show what the server holds.
        steppers.current.delete(key);
        changed();
      },
    );
  }, [changed]);

  // Every fresh read of the cart: lines that were waiting for it may settle, or send the taps made meanwhile.
  useEffect(() => {
    for (const [key, s] of steppers.current) {
      if (s.awaitingRead) steppers.current.set(key, { ...s, awaitingRead: false });
      flush(key);
    }
  }, [readAt, flush]);

  const qty = useCallback((key: string, line: Line) => {
    lines.current.set(key, { ...lines.current.get(key), line });
    return steppers.current.get(key)?.target ?? heldQty(line);
  }, []);

  const set = useCallback((key: string, line: Line, next: number, addAs?: AddAs) => {
    lines.current.set(key, { line, addAs: addAs ?? lines.current.get(key)?.addAs });
    steppers.current.set(key, tapTo(steppers.current.get(key), next));
    changed();
    flush(key);
  }, [changed, flush]);

  return { qty, set, settled: steppers.current.size === 0 };
}
