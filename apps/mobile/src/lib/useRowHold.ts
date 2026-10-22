import { useCallback, useMemo, useRef, useState } from 'react';

/**
 * [BUG-GUARDS C2 · #1952 review S3-2] Hold a press PER ROW while its request runs.
 *
 * One `x.isPending` shared by a whole list dropped a tap on a DIFFERENT row
 * silently (rate item A, then item B while A saves: B's rating was lost; the
 * same for list hearts and cart removes). This holds only the row that is
 * sending: a second tap on the same row is ignored, another row goes through.
 *
 *   const holdRow = useRowHold();
 *   onPress={() => holdRow(line.itemId, () => itemFeedback.mutateAsync(body).catch(rollback))}
 *
 * `run` must return the request's own promise (mutateAsync, not mutate): each
 * call's promise settles for that call, while mutate's per-call callbacks only
 * reach the LATEST call (a row's rollback would be lost). The lock is a ref,
 * so a double tap inside one frame is held too. A rejection is the caller's
 * to handle (the hook only releases the row).
 * `holdRow.busy` is true while ANY row sends: with two rows in flight, the
 * mutation's own isPending follows only the latest call, so a gate that must
 * wait for every request (the cart's quote) reads `busy` too.
 * The census (a-press-never-fires-a-mutation-twice) counts `holdRow(key, () => …)` as held.
 */
export type RowHold = ((key: string, run: () => Promise<unknown>) => boolean) & { readonly busy: boolean };

export function useRowHold(): RowHold {
  const held = useRef(new Set<string>());
  const [sending, setSending] = useState(0);
  const hold = useCallback((key: string, run: () => Promise<unknown>) => {
    if (held.current.has(key)) return false;
    held.current.add(key);
    let sent: Promise<unknown>;
    try {
      sent = run();
    } catch (error) {
      held.current.delete(key);
      throw error;
    }
    setSending(held.current.size);
    void Promise.resolve(sent).catch(() => undefined).finally(() => {
      held.current.delete(key);
      setSending(held.current.size);
    });
    return true;
  }, []);
  return useMemo(() => Object.assign((key: string, run: () => Promise<unknown>) => hold(key, run), { busy: sending > 0 }), [hold, sending]);
}
