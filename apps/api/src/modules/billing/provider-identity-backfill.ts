import { Prisma, type PrismaClient } from '@prisma/client';
import { log } from '../../utils/logger';

/**
 * [MMG checkout F2] Every channel now claims the one provider identity inside
 * its credit (provider-identity.ts). Credits recorded before a channel did so
 * carry none, and an identity that is missing cannot refuse a second credit of
 * the same MMG transaction. This files one for each such credit:
 *   - the push rail's captured MMG payments (`push:<payment id>`),
 *   - admin top-ups: every ADMIN_TOPUP receipt names its transfer
 *     (`topup:<admin>:<key>`, or `receipt:<event id>` before top-up commands),
 *   - agent-cash credits from before M-18 minted identities (`<payment id>`).
 * An identity already OPEN is marked CREDITED by the historical credit. One
 * CREDITED by a different claimant, or on record with another tenant, amount
 * or currency, is left exactly as it is and counted as a conflict for a person.
 *
 * Idempotent: a re-run changes nothing. The first complete run is recorded
 * under PROVIDER_IDENTITY_BACKFILL_KEY, and checkout crediting stays OFF until
 * that record exists (MmgCheckoutService). The key carries a ':' so the admin
 * config route (keys /^[a-z0-9_.-]{1,64}$/i) can never write it by hand.
 */
export const PROVIDER_IDENTITY_BACKFILL_KEY = 'system:billing.provider-identity-backfill.v1';

export interface ProviderIdentityBackfillResult {
  /** Identities filed or marked CREDITED, per source. */
  push: number;
  topups: number;
  agentCash: number;
  /** Historical credits whose transaction is on record for another claimant,
   *  tenant, amount or currency: credited twice before, or disputed. */
  conflicts: number;
}

let backfillDone = false;

/** Tests reset the in-process cache of the completion record. */
export function resetProviderIdentityBackfillCacheForTests(): void {
  backfillDone = false;
}

/** Whether the backfill has completed (checkout crediting is allowed). */
export async function providerIdentityBackfillDone(prisma: Pick<PrismaClient, 'platformConfig'>): Promise<boolean> {
  if (backfillDone) return true;
  const row = await prisma.platformConfig.findUnique({ where: { key: PROVIDER_IDENTITY_BACKFILL_KEY } });
  const value = row?.value;
  backfillDone = !!value && typeof value === 'object' && !Array.isArray(value) && typeof (value as Record<string, unknown>)['completedAt'] === 'string';
  return backfillDone;
}

/** The provider transaction id as every channel stores it (normalizeProviderTxnId: trimmed, upper-cased). */
const keyOf = (column: Prisma.Sql): Prisma.Sql => Prisma.sql`upper(regexp_replace(${column}, '^[[:space:]]+|[[:space:]]+$', '', 'g'))`;

/** The payer whose tenant owns a subscription's money (subscriptionTenantInTx). */
const PAYER = Prisma.sql`
    LEFT JOIN "riders" r ON r."id" = s."riderId"
    LEFT JOIN "drivers" d ON d."id" = s."driverId"
    LEFT JOIN "vendors" v ON v."id" = s."vendorId"
    LEFT JOIN "vendor_owners" vo ON vo."id" = v."ownerId"
    JOIN "users" u ON u."id" = COALESCE(r."userId", d."userId", vo."userId")`;

function pushSource(scope: Prisma.Sql): Prisma.Sql {
  return Prisma.sql`
    SELECT ${keyOf(Prisma.sql`p."externalRef"`)} AS "key", 'push:' || p."id" AS "claimant", p."subscriptionId",
           p."amount"::numeric AS "amount", COALESCE(att."currencyCode", s."currencyCode")::text AS "currencyCode",
           COALESCE(p."paidAt", p."createdAt") AS "creditedAt", u."tenantId"
    FROM "subscription_payments" p
    JOIN "subscriptions" s ON s."id" = p."subscriptionId"
    ${PAYER}
    LEFT JOIN "billing_events" att ON p."clientKey" LIKE 'sub:%' AND att."idempotencyKey" = 'charge:' || substr(p."clientKey", 5)
    WHERE p."paymentMethod" = 'MOBILE_MONEY' AND p."status" = 'CAPTURED'
      AND p."externalRef" IS NOT NULL AND ${keyOf(Prisma.sql`p."externalRef"`)} <> ''
      ${scope}`;
}

function topupSource(scope: Prisma.Sql): Prisma.Sql {
  return Prisma.sql`
    SELECT ${keyOf(Prisma.sql`fr."mmgRef"`)} AS "key",
           COALESCE('topup:' || tc."adminId" || ':' || tc."idempotencyKey", 'receipt:' || fr."billingEventId") AS "claimant",
           fr."subscriptionId", fr."amount"::numeric AS "amount", ev."currencyCode"::text AS "currencyCode",
           ev."createdAt" AS "creditedAt", u."tenantId"
    FROM "fee_receipts" fr
    JOIN "billing_events" ev ON ev."id" = fr."billingEventId"
    LEFT JOIN "topup_commands" tc ON tc."billingEventId" = fr."billingEventId"
    JOIN "subscriptions" s ON s."id" = fr."subscriptionId"
    ${PAYER}
    WHERE fr."channel" = 'ADMIN_TOPUP' AND fr."mmgRef" IS NOT NULL AND ${keyOf(Prisma.sql`fr."mmgRef"`)} <> ''
      ${scope}`;
}

function agentCashSource(scope: Prisma.Sql): Prisma.Sql {
  const raw = Prisma.sql`COALESCE(ap."mmgTxnId", CASE WHEN ap."channel" = 'MANUAL_ADMIN' THEN regexp_replace(ap."externalId", '^MANUAL:', '') ELSE ap."externalId" END)`;
  return Prisma.sql`
    SELECT ${keyOf(raw)} AS "key", ap."id" AS "claimant", ap."subscriptionId",
           ap."amount"::numeric AS "amount", ap."currencyCode"::text AS "currencyCode", ap."paidAt" AS "creditedAt", ap."tenantId"
    FROM "mmg_agent_payments" ap
    WHERE ap."providerPaymentId" IS NULL AND ap."status" IN ('MATCHED', 'RESOLVED') AND ap."subscriptionId" IS NOT NULL
      AND ${keyOf(raw)} <> ''
      ${scope}`;
}

async function fileIdentities(prisma: PrismaClient, source: Prisma.Sql): Promise<{ filed: number; conflicts: number }> {
  // One identity per transaction: the earliest credit is the one on record.
  const filed = await prisma.$executeRaw`
    INSERT INTO "provider_payments" ("id", "tenantId", "provider", "providerTxnId", "status", "creditedPaymentId",
                                     "subscriptionId", "creditedAt", "amount", "currencyCode", "createdAt", "updatedAt")
    SELECT gen_random_uuid()::text, src."tenantId", 'MMG', src."key", 'CREDITED', src."claimant",
           src."subscriptionId", src."creditedAt", src."amount", src."currencyCode", now(), now()
    FROM (SELECT DISTINCT ON ("key") * FROM (${source}) credits ORDER BY "key", "creditedAt", "claimant") src
    ON CONFLICT ("provider", "providerTxnId") DO UPDATE
      SET "status" = 'CREDITED', "creditedPaymentId" = EXCLUDED."creditedPaymentId", "subscriptionId" = EXCLUDED."subscriptionId",
          "creditedAt" = EXCLUDED."creditedAt", "updatedAt" = now()
      WHERE "provider_payments"."status" = 'OPEN'
        AND "provider_payments"."tenantId" = EXCLUDED."tenantId"
        AND "provider_payments"."amount" = EXCLUDED."amount"
        AND btrim("provider_payments"."currencyCode") = btrim(EXCLUDED."currencyCode")
  `;
  const rows = await prisma.$queryRaw<Array<{ n: number }>>`
    SELECT count(*)::int AS "n"
    FROM (${source}) src
    JOIN "provider_payments" pp ON pp."provider" = 'MMG' AND pp."providerTxnId" = src."key"
    WHERE pp."status" <> 'CREDITED'
       OR pp."creditedPaymentId" IS DISTINCT FROM src."claimant"
       OR pp."tenantId" <> src."tenantId"
       OR pp."amount" <> src."amount"
       OR btrim(pp."currencyCode") <> btrim(src."currencyCode")
  `;
  return { filed, conflicts: rows[0]?.n ?? 0 };
}

/**
 * File the identities of historical credits. `subscriptionIds` limits the run
 * (tests); a limited run is never recorded as the backfill.
 */
export async function runProviderIdentityBackfill(
  prisma: PrismaClient,
  opts: { subscriptionIds?: string[] } = {},
): Promise<ProviderIdentityBackfillResult> {
  const only = (column: Prisma.Sql): Prisma.Sql => (opts.subscriptionIds
    ? (opts.subscriptionIds.length > 0 ? Prisma.sql`AND ${column} IN (${Prisma.join(opts.subscriptionIds)})` : Prisma.sql`AND false`)
    : Prisma.empty);
  const push = await fileIdentities(prisma, pushSource(only(Prisma.sql`p."subscriptionId"`)));
  const topups = await fileIdentities(prisma, topupSource(only(Prisma.sql`fr."subscriptionId"`)));
  const agentCash = await fileIdentities(prisma, agentCashSource(only(Prisma.sql`ap."subscriptionId"`)));
  return {
    push: push.filed,
    topups: topups.filed,
    agentCash: agentCash.filed,
    conflicts: push.conflicts + topups.conflicts + agentCash.conflicts,
  };
}

/**
 * The startup guard: run the backfill once, record its completion, and from
 * then on let checkout crediting through. Returns the run's result, or null
 * when it had already completed.
 */
export async function ensureProviderIdentityBackfill(prisma: PrismaClient): Promise<ProviderIdentityBackfillResult | null> {
  if (await providerIdentityBackfillDone(prisma)) return null;
  const result = await runProviderIdentityBackfill(prisma);
  const value = { completedAt: new Date().toISOString(), ...result };
  await prisma.platformConfig.upsert({
    where: { key: PROVIDER_IDENTITY_BACKFILL_KEY },
    create: { key: PROVIDER_IDENTITY_BACKFILL_KEY, value },
    update: { value },
  });
  backfillDone = true;
  if (result.conflicts > 0) {
    log().error({ ...result }, '[MMG checkout F2] provider-identity backfill: historical credits name a transaction on record for another claimant, tenant or amount; reconcile them against the MMG statement');
  } else {
    log().info({ ...result }, '[MMG checkout F2] provider-identity backfill complete; checkout crediting is on');
  }
  return result;
}
