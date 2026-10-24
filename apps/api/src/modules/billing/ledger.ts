import { Prisma, type PrismaClient } from '@prisma/client';
import { log } from '../../utils/logger';

// TOLLGATE PART 17 — the double-entry ledger. One blessed writer: postLedger.
// Every posting is balanced (app-validated AND database-enforced by a deferred
// constraint trigger), append-only (database trigger), and replay-safe
// (idempotencyKey unique — a second delivery of the same event is a metered
// no-op, LAW M-4). Amounts are Decimal GYD major units like the rest of the
// engine; arithmetic here happens in integer cents to keep float noise out of
// the balance check.

type Db = PrismaClient | Prisma.TransactionClient;

export type LedgerAccountType = 'ASSET' | 'LIABILITY' | 'REVENUE' | 'EXPENSE' | 'CONTRA';

/** The chart of accounts — the in-code map IS the source of truth; the
 *  ledger_accounts table mirrors it for reporting joins (seeded by migration
 *  and by ensureLedgerAccounts in tests). */
export const LEDGER_ACCOUNTS: Record<string, { name: string; type: LedgerAccountType }> = {
  CLEARING_MMG: { name: 'MMG clearing — confirmed, not yet bank-settled', type: 'ASSET' },
  CLEARING_CARD: { name: 'Card provider clearing', type: 'ASSET' },
  BANK_LOCAL: { name: 'Local bank deposits', type: 'ASSET' },
  // [owner Q-1654-BOOKS A] MMG returned money that had already paid for a week: that week's fee is owed again.
  FEE_RECEIVABLE: { name: 'Weekly fees a partner owes again (MMG returned the money that paid them; subledger = subscriptionId)', type: 'ASSET' },
  WALLET_LIABILITY: { name: 'Payer fee-wallet balances (subledger = subscriptionId)', type: 'LIABILITY' },
  DEFERRED_REVENUE: { name: 'Paid-through service not yet delivered', type: 'LIABILITY' },
  FEE_REVENUE: { name: 'Earned weekly fees', type: 'REVENUE' },
  PROMO_EXPENSE: { name: 'Credit-funded weeks — marketing cost, never revenue', type: 'EXPENSE' },
  PROVIDER_FEES: { name: 'MMG/card per-transaction + settlement fees', type: 'EXPENSE' },
  CHARGEBACK_RESERVE: { name: 'Card dispute reserve', type: 'LIABILITY' },
  CHARGEBACK_LOSS: { name: 'Lost chargebacks', type: 'EXPENSE' },
  SUSPENSE_LIABILITY: { name: 'Unmatched money held — never rejected (SO-6)', type: 'LIABILITY' },
  REFUND_PAYABLE: { name: 'Fee credit set aside for a refund, not yet paid back (subledger = subscriptionId)', type: 'LIABILITY' },
  FX_VARIANCE: { name: 'Settlement-vs-conversion FX differences', type: 'REVENUE' },
  OPENING_BALANCES: { name: 'Ledger-epoch opening balances', type: 'CONTRA' },
};

export interface LedgerPosting {
  account: string;
  /** Subledger dimension — subscriptionId for WALLET_LIABILITY rows. */
  subledgerId?: string;
  debit?: number;
  credit?: number;
}

const cents = (n: number) => Math.round(n * 100);

/** One posting's entries as a comparable multiset: account, subledger, and
 *  each side in integer cents (the description is free text, never compared). */
function entryKeys(entries: ReadonlyArray<{ account: string; subledgerId?: string | null; debit?: unknown; credit?: unknown }>): string {
  return entries
    .map((e) => `${e.account}|${e.subledgerId ?? ''}|${cents(Number(e.debit ?? 0))}|${cents(Number(e.credit ?? 0))}`)
    .sort()
    .join('\n');
}

/** [row 163 · DB-04] A posting already stored under this key: the same
 *  entries are a replay (null, metered); anything else is a different money
 *  event under a used key and is refused, never swallowed. */
async function replayOf(db: Db, input: { idempotencyKey: string; entries: LedgerPosting[] }): Promise<null | 'ABSENT'> {
  const stored = await db.ledgerTransaction.findUnique({
    where: { idempotencyKey: input.idempotencyKey },
    select: { entries: { select: { accountCode: true, subledgerId: true, debit: true, credit: true } } },
  });
  if (!stored) return 'ABSENT';
  const storedKeys = entryKeys(stored.entries.map((e) => ({ account: e.accountCode, subledgerId: e.subledgerId, debit: e.debit, credit: e.credit })));
  if (storedKeys !== entryKeys(input.entries)) {
    throw new Error(`LEDGER_REPLAY_MISMATCH: ${input.idempotencyKey} is already posted with different entries`);
  }
  log().info({ idempotencyKey: input.idempotencyKey }, 'ledger: duplicate posting is a replay (no-op)');
  return null;
}

/**
 * Post one balanced transaction. Call INSIDE the same database transaction as
 * the money mutation it describes — atomicity is the whole point. Returns null
 * on idempotency replay (the same entries already posted under the key —
 * metered no-op). Throws on an unbalanced or malformed posting (a code bug
 * that must never ship) and on a different posting under a used key.
 *
 * [row 163 · DB-04] The replay is decided by READING the stored posting
 * first, never by catching the unique violation: in PostgreSQL that error
 * aborts the caller's transaction, so swallowing it broke the rest of the
 * money mutation. A violation can still happen when two writers race for one
 * key; inside a transaction it is rethrown (that transaction is dead and must
 * fail and retry), outside one the stored posting is compared.
 */
export async function postLedger(
  db: Db,
  input: { idempotencyKey: string; description: string; occurredAt?: Date; entries: LedgerPosting[] },
): Promise<{ id: string } | null> {
  if (input.entries.length < 2) {
    throw new Error(`LEDGER_MALFORMED: a transaction needs at least two entries (${input.idempotencyKey})`);
  }
  let debits = 0;
  let credits = 0;
  for (const e of input.entries) {
    if (!LEDGER_ACCOUNTS[e.account]) {
      throw new Error(`LEDGER_UNKNOWN_ACCOUNT: ${e.account} (${input.idempotencyKey})`);
    }
    const d = cents(e.debit ?? 0);
    const c = cents(e.credit ?? 0);
    if (d < 0 || c < 0 || (d === 0) === (c === 0)) {
      throw new Error(`LEDGER_MALFORMED: each entry carries exactly one positive side (${input.idempotencyKey})`);
    }
    debits += d;
    credits += c;
  }
  if (debits !== credits) {
    throw new Error(`LEDGER_UNBALANCED: ${debits} vs ${credits} cents (${input.idempotencyKey})`);
  }

  if ((await replayOf(db, input)) === null) return null;
  try {
    return await db.ledgerTransaction.create({
      data: {
        idempotencyKey: input.idempotencyKey,
        description: input.description,
        occurredAt: input.occurredAt ?? new Date(),
        entries: {
          create: input.entries.map((e) => ({
            accountCode: e.account,
            subledgerId: e.subledgerId ?? null,
            debit: e.debit ?? 0,
            credit: e.credit ?? 0,
          })),
        },
      },
      select: { id: true },
    });
  } catch (error) {
    // A root client is no transaction: the racing writer's posting is stored, compare it.
    if ((error as Prisma.PrismaClientKnownRequestError).code === 'P2002' && '$transaction' in db) {
      if ((await replayOf(db, input)) === null) return null;
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Posting rules — pure functions from money event to balanced entries
// (tollgate 17.2). A1 mirrors what the engine DOES today: revenue recognizes
// at charge success. DEFERRED_REVENUE amortization arrives with the
// WeekApplication slice, which gives it a per-week anchor to amortize from.
// ---------------------------------------------------------------------------

/** Money arrived from outside and credited a payer's wallet. */
export function topupPostings(subscriptionId: string, amount: number, rail: 'EXTERNAL' | 'CARD' = 'EXTERNAL'): LedgerPosting[] {
  return [
    { account: rail === 'CARD' ? 'CLEARING_CARD' : 'CLEARING_MMG', debit: amount },
    { account: 'WALLET_LIABILITY', subledgerId: subscriptionId, credit: amount },
  ];
}

/** Unused wallet credit set aside for a refund: it is no longer the payer's
 *  to spend on fees, and is owed back to them until it is paid or released. */
export function refundSetAsidePostings(subscriptionId: string, amount: number): LedgerPosting[] {
  return [
    { account: 'WALLET_LIABILITY', subledgerId: subscriptionId, debit: amount },
    { account: 'REFUND_PAYABLE', subledgerId: subscriptionId, credit: amount },
  ];
}

/** A set-aside refund paid back outside Swift. Swift never moves the money: an
 *  admin pays it and records the reference, so it leaves the account it would
 *  have come from (MMG clearing, or the bank). */
export function refundPaidPostings(subscriptionId: string, amount: number, method: 'MMG' | 'BANK_TRANSFER'): LedgerPosting[] {
  return [
    { account: 'REFUND_PAYABLE', subledgerId: subscriptionId, debit: amount },
    { account: method === 'BANK_TRANSFER' ? 'BANK_LOCAL' : 'CLEARING_MMG', credit: amount },
  ];
}

/** A set-aside refund that could not be paid goes back to the payer's wallet. */
export function refundReleasePostings(subscriptionId: string, amount: number): LedgerPosting[] {
  return [
    { account: 'REFUND_PAYABLE', subledgerId: subscriptionId, debit: amount },
    { account: 'WALLET_LIABILITY', subledgerId: subscriptionId, credit: amount },
  ];
}

/** [MMG REVERSAL] MMG returned a weekly-fee payment to the payer: the exact
 *  reverse of its MMG top-up — the wallet owes the payer less, and the MMG
 *  clearing account holds less. */
export function walletReversalPostings(subscriptionId: string, amount: number): LedgerPosting[] {
  return [
    { account: 'WALLET_LIABILITY', subledgerId: subscriptionId, debit: amount },
    { account: 'CLEARING_MMG', credit: amount },
  ];
}

/** [owner Q-1654-BOOKS A] MMG returned a payment whose money had already paid
 *  for a week ("returned, not booked"): the partner owes that week's fee again,
 *  and the MMG clearing account holds less. */
export function returnedNotBookedPostings(subscriptionId: string, amount: number): LedgerPosting[] {
  return [
    { account: 'FEE_RECEIVABLE', subledgerId: subscriptionId, debit: amount },
    { account: 'CLEARING_MMG', credit: amount },
  ];
}

/** A weekly fee was collected. `rail` decides where the debit lands: prepaid
 *  consumes the wallet; external rails hit their clearing account. */
export function chargeSuccessPostings(
  subscriptionId: string,
  amount: number,
  rail: 'prepaid' | 'CARD' | 'EXTERNAL',
): LedgerPosting[] {
  const debit: LedgerPosting =
    rail === 'prepaid'
      ? { account: 'WALLET_LIABILITY', subledgerId: subscriptionId, debit: amount }
      : { account: rail === 'CARD' ? 'CLEARING_CARD' : 'CLEARING_MMG', debit: amount };
  return [debit, { account: 'FEE_REVENUE', credit: amount }];
}

/** Mirror the in-code chart into ledger_accounts (reporting joins). Idempotent;
 *  the migration seeds production, tests call this in beforeAll. */
export async function ensureLedgerAccounts(db: Db): Promise<void> {
  for (const [code, meta] of Object.entries(LEDGER_ACCOUNTS)) {
    await db.ledgerAccount.upsert({
      where: { code },
      update: { name: meta.name, type: meta.type },
      create: { code, name: meta.name, type: meta.type },
    });
  }
}
