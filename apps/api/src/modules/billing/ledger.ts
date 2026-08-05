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
  WALLET_LIABILITY: { name: 'Payer fee-wallet balances (subledger = subscriptionId)', type: 'LIABILITY' },
  DEFERRED_REVENUE: { name: 'Paid-through service not yet delivered', type: 'LIABILITY' },
  FEE_REVENUE: { name: 'Earned weekly fees', type: 'REVENUE' },
  PROMO_EXPENSE: { name: 'Credit-funded weeks — marketing cost, never revenue', type: 'EXPENSE' },
  PROVIDER_FEES: { name: 'MMG/card per-transaction + settlement fees', type: 'EXPENSE' },
  CHARGEBACK_RESERVE: { name: 'Card dispute reserve', type: 'LIABILITY' },
  CHARGEBACK_LOSS: { name: 'Lost chargebacks', type: 'EXPENSE' },
  SUSPENSE_LIABILITY: { name: 'Unmatched money held — never rejected (SO-6)', type: 'LIABILITY' },
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

/**
 * Post one balanced transaction. Call INSIDE the same database transaction as
 * the money mutation it describes — atomicity is the whole point. Returns null
 * on idempotency replay (already posted — swallowed, metered). Throws on an
 * unbalanced or malformed posting: that is a code bug and must never ship.
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
    if ((error as Prisma.PrismaClientKnownRequestError).code === 'P2002') {
      log().info({ idempotencyKey: input.idempotencyKey }, 'ledger: duplicate posting swallowed');
      return null;
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
export function topupPostings(subscriptionId: string, amount: number): LedgerPosting[] {
  return [
    { account: 'CLEARING_MMG', debit: amount },
    { account: 'WALLET_LIABILITY', subledgerId: subscriptionId, credit: amount },
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
