/**
 * [SUBSTITUTION · owner 17 Oct 2026] The customer's swap question on the web
 * order page, from the server's own swap view (GET /customer/orders/:id with
 * swapDecisions=v1): which answers the server will accept, what approving
 * changes, and how long the question waits. Mirrors the phone's
 * substitutionCopy so both say the same thing.
 */
export interface SwapView {
  priceDelta?: number | null;
  decisions?: { approve: boolean; reject: boolean } | null;
  settlementGuidance?: string | null;
  original?: { options?: ReadonlyArray<{ group?: string; name?: string }> | null } | null;
  decideBy?: string | null;
  ifNoAnswer?: 'REMOVE' | 'WITHDRAW' | null;
  /** [O-4] SWAP = another item proposed; REMOVAL = nothing to swap, asked before the store accepts. */
  kind?: 'SWAP' | 'REMOVAL' | null;
}

/** [O-4 · owner 22 Oct 2026] Asked before the store accepted, with nothing to swap: continue
 *  without the item (the total goes down) or cancel the order. Mirrors the phone. */
export function isRemovalQuestion(view: SwapView | null | undefined): boolean {
  return view?.kind === 'REMOVAL';
}

export function removalChangeText(view: SwapView | null | undefined): string | null {
  const delta = view?.priceDelta;
  if (typeof delta !== 'number' || !Number.isFinite(delta) || delta >= 0) return null;
  return `Continuing without it lowers your total by ${exact(-delta)}. You pay only the new total.`;
}

const exact = (n: number) => `$${n.toLocaleString('en-US', { minimumFractionDigits: Number.isInteger(n) ? 0 : 2, maximumFractionDigits: 2 })}`;

/** Only what the server will accept; nothing when it sent no decisions. */
export function swapPermissions(view: SwapView | null | undefined): { approve: boolean; reject: boolean } {
  return { approve: view?.decisions?.approve === true, reject: view?.decisions?.reject === true };
}

export function swapChangeText(view: SwapView | null | undefined): string | null {
  if (!swapPermissions(view).approve) return null;
  const delta = view?.priceDelta;
  if (typeof delta !== 'number' || !Number.isFinite(delta)) return null;
  const price = delta > 0
    ? `Approving adds ${exact(delta)} to your total.`
    : delta < 0 ? `Approving lowers your total by ${exact(-delta)}.` : 'Approving keeps your total the same.';
  const choices = (view?.original?.options ?? []).map((o) => [o.group, o.name].filter(Boolean).join(': ')).filter(Boolean).join(' · ');
  return choices ? `${price} Your choices (${choices}) don't come with the swap.` : price;
}

function clockOf(d: Date): string {
  try {
    return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  } catch {
    return d.toISOString().slice(11, 16);
  }
}

export function swapDeadlineText(view: SwapView | null | undefined, clock: (_at: Date) => string = clockOf): string | null {
  const raw = view?.decideBy;
  if (!raw) return null;
  const at = new Date(raw);
  if (Number.isNaN(at.getTime())) return null;
  if (view?.ifNoAnswer === 'WITHDRAW') return `If it isn't approved by ${clock(at)}, the store settles this item with you directly.`;
  if (view?.ifNoAnswer === 'REMOVE') return `Please answer by ${clock(at)}. If you don't, it comes off your order and your total goes down.`;
  return null;
}

/** A line that came off the order (store removed it, the swap was declined, or nobody answered in time). */
export function lineRemoved(line: { subStatus?: string | null }): boolean {
  return line.subStatus === 'REFUNDED' || line.subStatus === 'REJECTED';
}
