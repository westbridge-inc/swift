import { moverRead, type MoverKind } from './mover';
import { useIdlePrefetch, type VendorTabRead } from './vendorTabPrefetch';

// [SPEED 30 Oct · owner] An earner's Earnings screen opens with its figures: once the Home
// screen's own reads have landed, its two first reads (the summary and the history, the same
// definitions its hooks use) are made once. Nothing in a preview or before the kind is known.
export function earnerReads(kind: MoverKind | null): VendorTabRead[] {
  return kind ? [moverRead.earningsSummary(kind), moverRead.earningsHistory(kind)] : [];
}

export function useEarnerPrefetch({ kind, preview }: { kind: MoverKind | null; preview: boolean }) {
  useIdlePrefetch(preview ? [] : earnerReads(kind), `earner:${kind}`);
}
