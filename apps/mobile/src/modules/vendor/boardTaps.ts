// ---------------------------------------------------------------------------
// [STORE-DASH · owner 22 Oct 2026 "fast taps and simple"] WHAT A TAP ON A
// BOARD CARD DOES, and which cards wait for the server.
//
// - Only the order that was tapped waits. The board used to share one busy
//   flag, so while order A's tap was out (one round trip abroad) every other
//   card's buttons were disabled too.
// - A step that needs more than a tap opens the order instead of sending a
//   request the server must refuse: the takeaway hand-over needs the code the
//   customer reads out, and that is typed on the order screen. The card used
//   to send "Mark picked up" with no code, which every server refuses.
// - Reject always asks for the reason first (it tells the customer and cannot
//   be undone).
// ---------------------------------------------------------------------------
import type { VendorOrderActionKind } from './shared';

export type CardTap = 'reject' | 'open' | 'send';

export function cardTapFor(action: VendorOrderActionKind): CardTap {
  if (action === 'reject') return 'reject';
  if (action === 'complete-pickup') return 'open';
  return 'send';
}

/** The order ids with a store tap still waiting for the server's answer. */
export function pendingOrderIds(variables: ReadonlyArray<unknown>): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const v of variables) {
    const id = (v as { id?: unknown } | null | undefined)?.id;
    if (typeof id === 'string' && id) ids.add(id);
  }
  return ids;
}
