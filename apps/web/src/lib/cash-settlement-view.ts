// ---------------------------------------------------------------------------
// [UI-SWEEP U19 / U66] The delivery-fee cash ledger, read the way the server
// sends it (api modules/cash/delivery-cash-settlement.service.ts toWire):
//   { id, orderNumber, amount, status, createdAt,
//     rider: { name, phone } | null, vendor: { name, phone } | null }
//
// U66: both web cards read `r.order.orderNumber` and `r.rider.user.firstName` —
// fields the wire never carries — so every row said "#undefined · Rider" and the
// confirmation a store signs ("Hand Rider $X?") never named the person it pays.
// U19: a failed or malformed read rendered NOTHING, which to a store is the
// absence of a debt. Same rule as the phone (lib/riderFeesOwed.ts
// classifyOwedLedger): a row the screen cannot identify is still money, so a
// malformed ledger is unavailable, never partly shown.
// ---------------------------------------------------------------------------

import { parseAmount } from './money';

export interface SettlementRow {
  id: string;
  orderNumber: string | null;
  /** The other party's name as the server wrote it, or null. */
  counterparty: string | null;
  amount: number | null;
  /** The figure exactly as sent: the confirmation restates the ledger's own amount. */
  rawAmount: string;
  status: string;
}

export type SettlementLedger =
  | { state: 'loading' }
  | { state: 'unavailable' }
  | { state: 'empty' }
  | { state: 'ready'; rows: SettlementRow[]; owed: number | null; count: number };

const text = (value: unknown): string | null => (typeof value === 'string' && value.trim() ? value.trim() : null);

/** `side` names whose name the reader needs: the store pays a rider, a rider collects from a store. */
export function readSettlementLedger(
  query: { isLoading: boolean; isError: boolean; data: unknown },
  side: 'rider' | 'vendor',
): SettlementLedger {
  if (query.isError) return { state: 'unavailable' };
  if (query.isLoading || query.data === undefined) return { state: 'loading' };
  const data = query.data as { unsettled?: unknown; summary?: { owed?: unknown; count?: unknown } } | null;
  if (!data || typeof data !== 'object' || !Array.isArray(data.unsettled)) return { state: 'unavailable' };
  const rows: SettlementRow[] = [];
  for (const raw of data.unsettled as unknown[]) {
    const r = raw as Record<string, unknown> | null;
    if (!r || typeof r !== 'object' || typeof r['id'] !== 'string') return { state: 'unavailable' };
    const party = r[side] as { name?: unknown } | null | undefined;
    const orderNumber = r['orderNumber'];
    rows.push({
      id: r['id'],
      orderNumber: typeof orderNumber === 'string' || typeof orderNumber === 'number' ? String(orderNumber) : null,
      counterparty: text(party?.name),
      amount: parseAmount(r['amount']),
      rawAmount: String(r['amount'] ?? ''),
      status: String(r['status'] ?? ''),
    });
  }
  if (rows.length === 0) return { state: 'empty' };
  const count = typeof data.summary?.count === 'number' ? data.summary.count : rows.length;
  return { state: 'ready', rows, owed: parseAmount(data.summary?.owed), count };
}
