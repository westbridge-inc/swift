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
  const raw = input.providerTxnId;
  const [canonical] = await tx.$queryRaw<Array<{ key: string }>>`SELECT mmg_txn_canon(${raw}) AS key`;
  const key = canonical?.key;
  if (!key) throw new AppError(400, 'PROVIDER_TXN_REQUIRED', 'A credit must name the provider transaction it is evidence of.');
  if (!input.tenantId) throw new AppError(500, 'PROVIDER_TXN_TENANT_REQUIRED', 'A provider identity is always filed under a named tenant.');
  // Historical reservations remain visible when RLS hides the owning money
  // row. Such a reservation fails closed; it never licenses another identity.
  const [alias] = await tx.$queryRaw<Array<{ providerPaymentId: string }>>`
    SELECT "providerPaymentId" FROM provider_payment_aliases
    WHERE provider=${input.provider} AND "aliasKey"=mmg_txn_canon(${raw})`;
  type Identity = { id: string; tenantId: string; status: string; amount: Prisma.Decimal; currencyCode: string; creditedPaymentId: string | null; canonicalMatches: boolean };
  const readLive = () => tx.$queryRaw<Identity[]>`
    SELECT p.*,mmg_txn_canon(p."providerTxnId")=mmg_txn_canon(${raw}) AS "canonicalMatches"
    FROM provider_payments p WHERE p.provider=${input.provider}
      AND mmg_txn_canon(p."providerTxnId")=mmg_txn_canon(${raw}) AND p.status<>'HELD_DUPLICATE' FOR UPDATE`;
  let identity: Identity | undefined;
  if (alias) {
    [identity] = await tx.$queryRaw<Identity[]>`
      SELECT p.*,mmg_txn_canon(p."providerTxnId")=mmg_txn_canon(${raw}) AS "canonicalMatches"
      FROM provider_payments p WHERE p.id=${alias.providerPaymentId} FOR UPDATE`;
    if (!identity || !identity.canonicalMatches || identity.status==='HELD_DUPLICATE') {
      throw new ProviderIdentityError('PROVIDER_TXN_ALREADY_CREDITED', 'That payment requires finance review. Nothing was credited.');
    }
  } else {
    [identity] = await readLive();
    if (!identity) {
      await tx.$executeRaw`
        INSERT INTO provider_payments (id,"tenantId",provider,"providerTxnId",status,amount,"currencyCode","createdAt","updatedAt")
        VALUES (gen_random_uuid()::text,${input.tenantId},${input.provider},mmg_txn_canon(${raw}),'OPEN',${input.amount},${input.currencyCode},now(),now())
        ON CONFLICT (provider,mmg_txn_canon("providerTxnId")) WHERE status<>'HELD_DUPLICATE' DO NOTHING`;
      [identity] = await readLive();
    }
  }
  if (!identity) throw new Error('Provider identity unavailable');
  // A committed historical credit is authority even when its observation is
  // stale and the linked identity still says OPEN. Check the money evidence,
  // including the original pre-atomic agent-event suffix, under this lock.
  const historical = await tx.$queryRaw<Array<{ claimant: string }>>`
    SELECT ap.id AS claimant FROM mmg_agent_payments ap
    WHERE (ap."providerPaymentId"=${identity.id} OR mmg_txn_canon(COALESCE(ap."mmgTxnId",
      CASE WHEN ap.channel='MANUAL_ADMIN' THEN regexp_replace(ap."externalId",'^MANUAL:','') ELSE ap."externalId" END))=mmg_txn_canon(${raw}))
      AND EXISTS (SELECT 1 FROM billing_events ev WHERE ev.type='PREPAID_TOPUP' AND (
        ev."idempotencyKey"='agent-cash:pp:'||ap."providerPaymentId" OR ev."idempotencyKey"='agent-cash:'||ap.id OR
        right(ev."idempotencyKey",length(':agent:'||ap.channel||':'||ap."externalId"))=':agent:'||ap.channel||':'||ap."externalId"))
    UNION ALL
    SELECT 'push:'||p.id FROM subscription_payments p WHERE p."paymentMethod"='MOBILE_MONEY' AND p.status='CAPTURED'
      AND mmg_txn_canon(p."externalRef")=mmg_txn_canon(${raw})
    UNION ALL
    SELECT COALESCE('topup:'||tc."adminId"||':'||tc."idempotencyKey",'receipt:'||fr."billingEventId")
    FROM fee_receipts fr LEFT JOIN topup_commands tc ON tc."billingEventId"=fr."billingEventId"
    WHERE fr.channel='ADMIN_TOPUP' AND mmg_txn_canon(fr."mmgRef")=mmg_txn_canon(${raw})`;
  if (historical.some((credit) => credit.claimant !== input.creditedBy)) {
    throw new ProviderIdentityError('PROVIDER_TXN_ALREADY_CREDITED', 'That payment is already recorded or requires finance review. Nothing was credited.');
  }
  // [F7] Ownership first: another tenant's evidence is never ours to credit.
  if (identity.tenantId !== input.tenantId) {
    throw new ProviderIdentityError('PROVIDER_TXN_TENANT_CONFLICT', 'That transaction is on record for another account. Nothing was credited; reconcile it against the MMG statement.');
  }
  if (Number(identity.amount) !== input.amount || identity.currencyCode.trim() !== input.currencyCode) {
    throw new ProviderIdentityError('PROVIDER_TXN_AMOUNT_CONFLICT', 'That transaction is already on record with a different amount or currency. Nothing was credited; reconcile it against the MMG statement.');
  }
  if (identity.status !== 'OPEN' && identity.status !== 'CREDITED') throw new ProviderIdentityError('PROVIDER_TXN_ALREADY_CREDITED', 'That payment requires finance review. Nothing was credited.');
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
