import { mmgCreationInstant } from '../../modules/billing/mmg-checkout.service';
import type { MmgCreationZone } from '../../providers/mmg/mmg-checkout';
import type { MmgHistoryAnswer, MmgHistoryQuery } from '../../providers/mmg/mmg-provider';

// ---------------------------------------------------------------------------
// [7 Oct] MMG's Transaction History for the checkout suites, as MMG UAT
// answered Swift's merchant credentials on 7 Oct (read-only probe):
// - one row per payment, naming the checkout's transactionId in BOTH
//   transactionReference and transactionReceipt, transactionStatus
//   "completed", the amount as a major-unit string, the currency, and
//   modificationDate: when the payment was made, written as Guyana wall
//   clock with a "Z"; external_id is the checkout reference supplied by the
//   test (probe 2). Party values are synthetic; they do not identify the merchant;
// - only the rows whose time lies within the query's dates, read the same
//   way, oldest first, at most `rows` (MMG's `offset`) of them.
// ---------------------------------------------------------------------------

/** A time written as MMG writes it in `zone`. */
export function mmgTimeOf(at: Date, zone: MmgCreationZone = 'GUYANA_WALL_CLOCK'): string {
  return zone === 'UTC' ? at.toISOString() : new Date(at.getTime() - 4 * 3_600_000).toISOString();
}

/** MMG's history row for a payment of `amountGyd`, made now unless `patch` says when. */
export function mmgHistoryRow(txn: string, amountGyd: number, patch: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    amount: String(amountGyd), currency: 'GYD', displayType: 'EMerchant Payment', transactionStatus: 'completed', descriptionText: '',
    modificationDate: mmgTimeOf(new Date()), transactionReference: txn, transactionReceipt: txn,
    debitParty: [{ key: 'accountid', value: '6000002' }, { key: 'accountcategory', value: 'P-CAT' }],
    creditParty: [{ key: 'accountid', value: 'P-CREDIT' }, { key: 'accountcategory', value: 'P-CAT' }],
    ...patch,
  };
}

export class FakeMmgHistory {
  /** The payments MMG's history holds, by transaction. */
  readonly rows = new Map<string, Record<string, unknown>>();
  /** Every query Swift made, in order. */
  readonly queries: MmgHistoryQuery[] = [];
  /** How MMG writes and reads times. */
  zone: MmgCreationZone = 'GUYANA_WALL_CLOCK';
  /** Replaces MMG's answer outright (an outage, a malformed answer, rows as given). */
  answer: ((query: MmgHistoryQuery) => Promise<MmgHistoryAnswer>) | null = null;

  /** MMG's history holds this payment. */
  holds(txn: string, amountGyd: number, patch: Record<string, unknown> = {}): void {
    this.rows.set(txn, mmgHistoryRow(txn, amountGyd, patch));
  }

  reset(): void {
    this.rows.clear();
    this.queries.length = 0;
    this.zone = 'GUYANA_WALL_CLOCK';
    this.answer = null;
  }

  readonly transactionHistoryRows = async (query: MmgHistoryQuery): Promise<MmgHistoryAnswer> => {
    this.queries.push(query);
    if (this.answer) return this.answer(query);
    const timeOf = (stamp: unknown) => (typeof stamp === 'string' ? mmgCreationInstant(stamp, this.zone) : null);
    const from = timeOf(query.fromdate);
    const to = timeOf(query.todate);
    if (from === null || to === null) return { outcome: 'error', reason: 'MMG history HTTP 422' };
    const rows = [...this.rows.values()]
      .filter((row) => { const at = timeOf(row['modificationDate']); return at !== null && at >= from && at <= to; })
      .sort((a, b) => timeOf(a['modificationDate'])! - timeOf(b['modificationDate'])!);
    return { outcome: 'rows', rows: rows.slice(0, query.rows) };
  };
}
