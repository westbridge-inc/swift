import { Prisma, type PrismaClient } from '@prisma/client';
import { claimProviderPaymentInTx, ProviderIdentityError } from './provider-identity';
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
export const PROVIDER_IDENTITY_BACKFILL_KEY = 'system:billing.provider-identity-backfill.v2';

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
const keyOf = (column: Prisma.Sql): Prisma.Sql => Prisma.sql`mmg_txn_canon(${column})`;

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
    WHERE ap."subscriptionId" IS NOT NULL AND (ap."status" IN ('MATCHED', 'RESOLVED') OR EXISTS (
      -- A committed credit is authority whatever its observation says: every
      -- event key agent cash has written (the same three the historical check of a claim reads).
      SELECT 1 FROM billing_events ev WHERE ev.type='PREPAID_TOPUP' AND (
        ev."idempotencyKey"='agent-cash:pp:'||ap."providerPaymentId" OR ev."idempotencyKey"='agent-cash:'||ap.id
        OR right(ev."idempotencyKey",length(':agent:'||ap.channel||':'||ap."externalId"))=':agent:'||ap.channel||':'||ap."externalId")))
      AND ${keyOf(raw)} <> ''
      ${scope}`;
}

async function fileIdentities(prisma: PrismaClient, source: Prisma.Sql): Promise<{ filed: number; conflicts: number }> {
  // Use the same SQL canonical relation, alias reservation and historical
  // evidence guard as every new credit. An OPEN linked row is not proof that
  // its cash was never credited.
  const rows = await prisma.$queryRaw<Array<{ key: string; claimant: string; subscriptionId: string; tenantId: string; amount: Prisma.Decimal; currencyCode: string }>>`
    SELECT * FROM (${source}) credits ORDER BY "key", "creditedAt", "claimant"`;
  let filed = 0;
  let conflicts = 0;
  for (const row of rows) {
    try {
      const result = await prisma.$transaction((tx) => claimProviderPaymentInTx(tx, {
        provider: 'MMG', providerTxnId: row.key, amount: Number(row.amount), currencyCode: row.currencyCode,
        subscriptionId: row.subscriptionId, tenantId: row.tenantId, creditedBy: row.claimant,
      }));
      if (!result.already) filed += 1;
    } catch (error) {
      if (!(error instanceof ProviderIdentityError)) throw error;
      conflicts += 1;
    }
  }
  return { filed, conflicts };
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
  // A conflict is a historical transaction on record for more than one
  // claimant, tenant or amount. It stays exactly as it is, and every later
  // claim of that transaction is refused under the identity lock by the same
  // historical-evidence check. It is recorded once and paged once (the caller),
  // never re-run and re-paged on every poll: completion is recorded either way.
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
