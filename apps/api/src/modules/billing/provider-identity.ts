import type { Prisma } from '@prisma/client';
import { AppError } from '../../utils/errors';

/**
 * [I3 · M-18] One real-world provider transaction is credited ONCE, whichever
 * channel credits it: an agent-cash observation, an admin top-up that names
 * the transfer, the merchant-initiated MMG request (the push rail), or a
 * confirmed MMG checkout. The provider_payments row is the single point of
 * that decision. Every channel that credits takes it inside its own credit
 * transaction, so two channels racing on the same transaction serialize on one
 * row lock and exactly one of them credits.
 *
 * agent-cash.service keeps its own two-phase form of this (mint the identity,
 * then compare-and-set inside the credit). This helper is the same rule for
 * callers that credit in a single transaction.
 *
 * Credits recorded before a channel claimed identities are backfilled by
 * provider-identity-backfill.ts; checkout crediting stays off until it has run.
 */

export type ProviderIdentityCode =
  | 'PROVIDER_TXN_ALREADY_CREDITED'
  | 'PROVIDER_TXN_AMOUNT_CONFLICT'
  | 'PROVIDER_TXN_TENANT_CONFLICT';

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
 * [F7] The tenant a subscription's money belongs to: its payer's. A
 * Subscription carries no tenantId of its own. Read without the request's
 * tenant scope so a platform operator's command still finds it; throws rather
 * than guessing, because a guessed tenant would file the payment evidence
 * under someone else's books.
 */
export async function subscriptionTenantInTx(tx: Pick<Prisma.TransactionClient, '$queryRaw'>, subscriptionId: string): Promise<string> {
  const rows = await tx.$queryRaw<Array<{ tenantId: string }>>`
    SELECT u."tenantId" AS "tenantId"
    FROM "subscriptions" s
    LEFT JOIN "riders" r ON r."id" = s."riderId"
    LEFT JOIN "drivers" d ON d."id" = s."driverId"
    LEFT JOIN "vendors" v ON v."id" = s."vendorId"
    LEFT JOIN "vendor_owners" vo ON vo."id" = v."ownerId"
    JOIN "users" u ON u."id" = COALESCE(r."userId", d."userId", vo."userId")
    WHERE s."id" = ${subscriptionId}
  `;
  const tenantId = rows[0]?.tenantId;
  if (!tenantId) throw new AppError(500, 'SUBSCRIPTION_TENANT_UNKNOWN', `Subscription ${subscriptionId} has no payer to take a tenant from.`);
  return tenantId;
}

/**
 * Claim the provider transaction for one credit, inside the caller's
 * transaction. Mints the identity (under the claimant's tenant) if it does not
 * exist yet, locks it, and compare-and-sets OPEN → CREDITED naming `creditedBy`.
 *
 * - The same claimant again (a retry of the same credit) gets the identity
 *   back with `already: true`, so the caller can finish idempotently.
 * - Another claimant, an identity on record under ANOTHER tenant [F7], or one
 *   observed with a different amount or currency, is refused and nothing moves.
 */
export async function claimProviderPaymentInTx(
  tx: Prisma.TransactionClient,
  input: {
    provider: 'MMG';
    providerTxnId: string;
    amount: number;
    currencyCode: string;
    subscriptionId: string;
    /** [F7] Whose books the payment evidence belongs to, named explicitly:
     *  system work (a reply, a poll) has no tenant to inherit. */
    tenantId: string;
    /** Who takes the credit: `mco:<checkout id>`, `topup:<admin>:<key>`, `push:<payment id>`… */
    creditedBy: string;
  },
): Promise<{ id: string; already: boolean }> {
  const key = normalizeProviderTxnId(input.providerTxnId);
  if (!key) throw new AppError(400, 'PROVIDER_TXN_REQUIRED', 'A credit must name the provider transaction it is evidence of.');
  if (!input.tenantId) throw new AppError(500, 'PROVIDER_TXN_TENANT_REQUIRED', 'A provider identity is always filed under a named tenant.');
  // Mint without a race: a concurrent claimant's insert collapses on the unique key.
  await tx.$executeRaw`
    INSERT INTO "provider_payments" ("id", "tenantId", "provider", "providerTxnId", "status", "amount", "currencyCode", "createdAt", "updatedAt")
    VALUES (gen_random_uuid()::text, ${input.tenantId}, ${input.provider}, ${key}, 'OPEN', ${input.amount}, ${input.currencyCode}, now(), now())
    ON CONFLICT ("provider", "providerTxnId") DO NOTHING
  `;
  const rows = await tx.$queryRaw<Array<{ id: string; tenantId: string; status: string; amount: Prisma.Decimal; currencyCode: string; creditedPaymentId: string | null }>>`
    SELECT "id", "tenantId", "status", "amount", "currencyCode", "creditedPaymentId"
    FROM "provider_payments"
    WHERE "provider" = ${input.provider} AND "providerTxnId" = ${key}
    FOR UPDATE
  `;
  const identity = rows[0];
  if (!identity) throw new Error('provider identity vanished after it was minted');
  // [F7] Ownership first: another tenant's evidence is never ours to credit.
  if (identity.tenantId !== input.tenantId) {
    throw new ProviderIdentityError('PROVIDER_TXN_TENANT_CONFLICT', 'That transaction is on record for another account. Nothing was credited; reconcile it against the MMG statement.');
  }
  if (Number(identity.amount) !== input.amount || identity.currencyCode.trim() !== input.currencyCode) {
    throw new ProviderIdentityError('PROVIDER_TXN_AMOUNT_CONFLICT', 'That transaction is already on record with a different amount or currency. Nothing was credited; reconcile it against the MMG statement.');
  }
  if (identity.status === 'CREDITED') {
    if (identity.creditedPaymentId === input.creditedBy) return { id: identity.id, already: true };
    throw new ProviderIdentityError('PROVIDER_TXN_ALREADY_CREDITED', 'That transaction has already been credited. Nothing was credited again.');
  }
  // Raw like the mint and the lock: the claim names its tenant explicitly and
  // never inherits a request's scope.
  const won = await tx.$executeRaw`
    UPDATE "provider_payments"
    SET "status" = 'CREDITED', "creditedPaymentId" = ${input.creditedBy}, "subscriptionId" = ${input.subscriptionId},
        "creditedAt" = now(), "updatedAt" = now()
    WHERE "id" = ${identity.id} AND "status" = 'OPEN' AND "tenantId" = ${input.tenantId}
  `;
  if (won !== 1) {
    throw new ProviderIdentityError('PROVIDER_TXN_ALREADY_CREDITED', 'That transaction has already been credited. Nothing was credited again.');
  }
  return { id: identity.id, already: false };
}
