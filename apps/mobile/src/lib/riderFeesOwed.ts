/**
 * [MOB-046] A DEBT TO A RIDER DOES NOT DISAPPEAR BECAUSE A QUERY FAILED.
 *
 * The "You owe riders" card read its rows like this:
 *
 *     const rows = q.data?.unsettled ?? [];
 *     if (rows.length === 0) return null;
 *
 * so a failed read produced an empty list, and an empty list removed the card
 * from the screen entirely. To the store owner that is not an outage — it is
 * the absence of a debt. The delivery fees a rider handed over their own cash
 * for, gone from the only screen that shows them, with nothing to say they
 * were ever there.
 *
 * Money owed to a person is the last thing that may be rendered by omission.
 * A read that did not succeed says so, and keeps saying so until it does.
 */

export type OwedLedgerState =
  /** the first read has not finished */
  | 'loading'
  /** the server answered, and there are debts to show */
  | 'ready'
  /** the server answered, and there are none — the only reason to show nothing */
  | 'empty'
  /** the read failed, or answered with something that is not a ledger */
  | 'unavailable';

export interface OwedLedgerRow {
  readonly id: string;
  readonly amount: unknown;
  readonly status?: unknown;
  readonly orderNumber?: unknown;
  readonly createdAt?: unknown;
  readonly rider?: { readonly name?: unknown } | null;
}

export interface OwedLedgerView {
  readonly state: OwedLedgerState;
  readonly rows: OwedLedgerRow[];
  /** The total owed, or null when it is not known — never 0 as a stand-in. */
  readonly owed: number | null;
}

export interface OwedLedgerInput {
  readonly isLoading: boolean;
  readonly error: unknown;
  readonly data: unknown;
  readonly fetched: boolean;
}

/**
 * One classification for the card.
 *
 * `empty` requires a SUCCESSFUL read that found nothing. Everything else that
 * produces no rows — a failure, a payload that is not a ledger, a read still
 * in flight — is `loading` or `unavailable`, because the card disappearing is
 * a statement that the store owes nothing.
 */
export function classifyOwedLedger(input: OwedLedgerInput): OwedLedgerView {
  if (input.error) return { state: 'unavailable', rows: [], owed: null };
  if (input.isLoading || !input.fetched) return { state: 'loading', rows: [], owed: null };
  const data = input.data as { unsettled?: unknown; summary?: { owed?: unknown } } | null | undefined;
  if (data == null || typeof data !== 'object') return { state: 'unavailable', rows: [], owed: null };
  if (!Array.isArray(data.unsettled)) return { state: 'unavailable', rows: [], owed: null };
  const rows = data.unsettled.filter((row): row is OwedLedgerRow => !!row && typeof row === 'object' && typeof (row as OwedLedgerRow).id === 'string');
  // A row the screen cannot identify is not a row it can act on, but it IS
  // money: dropping it silently would understate the debt, so a malformed
  // ledger is unavailable rather than partially shown.
  if (rows.length !== data.unsettled.length) return { state: 'unavailable', rows: [], owed: null };
  const owedRaw = data.summary?.owed;
  const owed = typeof owedRaw === 'number' && Number.isFinite(owedRaw) ? owedRaw : null;
  if (rows.length === 0) return { state: 'empty', rows: [], owed: owed ?? 0 };
  return { state: 'ready', rows, owed };
}

/**
 * What the store is about to attest, in their words.
 *
 * "Mark paid" was one tap with no confirmation and no visible failure. It is a
 * money attestation: the store is saying cash left their hand and reached a
 * named person. It names the rider and the amount, because a mis-tap on the
 * wrong row is the same mistake as not paying at all.
 */
export function markPaidPrompt(row: OwedLedgerRow, formatted: string): { title: string; body: string; confirm: string } {
  const rider = typeof row.rider?.name === 'string' && row.rider.name ? row.rider.name : 'this rider';
  const order = typeof row.orderNumber === 'string' || typeof row.orderNumber === 'number' ? ` for #${row.orderNumber}` : '';
  return {
    title: `Paid ${formatted} to ${rider}?`,
    body: `You are recording that you handed ${rider} ${formatted} in cash${order}. They confirm it on their side, and it stays on both your records.`,
    confirm: `Yes, I paid ${formatted}`,
  };
}
