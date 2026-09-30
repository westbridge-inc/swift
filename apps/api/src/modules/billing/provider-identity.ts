import type { Prisma } from '@prisma/client';
import { AppError } from '../../utils/errors';

/**
 * [I3 · M-18] One real-world provider transaction is credited ONCE, whichever
 * channel credits it: an agent-cash observation, an admin top-up that names
 * the transfer, or a confirmed MMG checkout. The provider_payments row is the
 * single point of that decision. Every channel that credits takes it inside
 * its own credit transaction, so two channels racing on the same transaction
 * serialize on one row lock and exactly one of them credits.
 *
 * agent-cash.service keeps its own two-phase form of this (mint the identity,
 * then compare-and-set inside the credit). This helper is the same rule for
 * callers that credit in a single transaction.
 */

export type ProviderIdentityCode = 'PROVIDER_TXN_ALREADY_CREDITED' | 'PROVIDER_TXN_AMOUNT_CONFLICT';

export class ProviderIdentityError extends AppError {
  constructor(readonly identityCode: ProviderIdentityCode, message: string) {
    super(409, identityCode, message);
  }
}

/** The provider transaction id as every channel stores it: trimmed, upper-cased. */
export function normalizeProviderTxnId(raw: string): string {
  return raw.trim().toUpperCase();
}

/**
 * Claim the provider transaction for one credit, inside the caller's
 * transaction. Mints the identity if it does not exist yet, locks it, and
 * compare-and-sets OPEN → CREDITED naming `creditedBy`.
 *
 * - The same claimant again (a retry of the same credit) gets the identity
 *   back with `already: true`, so the caller can finish idempotently.
 * - Another claimant, or an identity observed with a different amount or
 *   currency, is refused and nothing moves.
 */
export async function claimProviderPaymentInTx(
  tx: Prisma.TransactionClient,
  input: {
    provider: 'MMG';
    providerTxnId: string;
    amount: number;
    currencyCode: string;
    subscriptionId: string;
    /** Who takes the credit: `mco:<checkout id>`, `topup:<command key>`… */
    creditedBy: string;
  },
): Promise<{ id: string; already: boolean }> {
  const key = normalizeProviderTxnId(input.providerTxnId);
  if (!key) throw new AppError(400, 'PROVIDER_TXN_REQUIRED', 'A credit must name the provider transaction it is evidence of.');
  // Mint without a race: a concurrent claimant's insert collapses on the unique key.
  await tx.$executeRaw`
    INSERT INTO "provider_payments" ("id", "provider", "providerTxnId", "status", "amount", "currencyCode", "createdAt", "updatedAt")
    VALUES (gen_random_uuid()::text, ${input.provider}, ${key}, 'OPEN', ${input.amount}, ${input.currencyCode}, now(), now())
    ON CONFLICT ("provider", "providerTxnId") DO NOTHING
  `;
  const rows = await tx.$queryRaw<Array<{ id: string; status: string; amount: Prisma.Decimal; currencyCode: string; creditedPaymentId: string | null }>>`
    SELECT "id", "status", "amount", "currencyCode", "creditedPaymentId"
    FROM "provider_payments"
    WHERE "provider" = ${input.provider} AND "providerTxnId" = ${key}
    FOR UPDATE
  `;
  const identity = rows[0];
  if (!identity) throw new Error('provider identity vanished after it was minted');
  if (Number(identity.amount) !== input.amount || identity.currencyCode.trim() !== input.currencyCode) {
    throw new ProviderIdentityError('PROVIDER_TXN_AMOUNT_CONFLICT', 'That transaction is already on record with a different amount or currency. Nothing was credited; reconcile it against the MMG statement.');
  }
  if (identity.status === 'CREDITED') {
    if (identity.creditedPaymentId === input.creditedBy) return { id: identity.id, already: true };
    throw new ProviderIdentityError('PROVIDER_TXN_ALREADY_CREDITED', 'That transaction has already been credited. Nothing was credited again.');
  }
  const won = await tx.providerPayment.updateMany({
    where: { id: identity.id, status: 'OPEN' },
    data: { status: 'CREDITED', creditedPaymentId: input.creditedBy, subscriptionId: input.subscriptionId, creditedAt: new Date() },
  });
  if (won.count !== 1) {
    throw new ProviderIdentityError('PROVIDER_TXN_ALREADY_CREDITED', 'That transaction has already been credited. Nothing was credited again.');
  }
  return { id: identity.id, already: false };
}
