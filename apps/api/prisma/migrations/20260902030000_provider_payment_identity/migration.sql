-- [M-18] One real-world provider transaction is ONE identity with ONE
-- lifecycle, whatever channel observed it (webhook, settlement file, manual
-- entry). Channel records become immutable observations that point at it;
-- the credit becomes a single compare-and-set on the identity. Additive:
-- one new table, one nullable column, and a backfill that groups every
-- existing observation by its provider transaction id — an identity is
-- CREDITED when any of its observations already credited (the earliest
-- credited one is named), OPEN otherwise. Nothing is reversed here: legacy
-- double credits are reported by the sweep for human reconciliation.
SET lock_timeout = '10s';

CREATE TABLE "provider_payments" (
    "id"                TEXT NOT NULL,
    "tenantId"          TEXT NOT NULL DEFAULT 'swift-default',
    "provider"          TEXT NOT NULL,
    "providerTxnId"     TEXT NOT NULL,
    "status"            TEXT NOT NULL DEFAULT 'OPEN',
    "creditedPaymentId" TEXT,
    "subscriptionId"    TEXT,
    "creditedAt"        TIMESTAMP(3),
    "amount"            DECIMAL(12,2) NOT NULL,
    "currencyCode"      CHAR(3) NOT NULL,
    "createdAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"         TIMESTAMP(3) NOT NULL,

    CONSTRAINT "provider_payments_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "provider_payments_provider_providerTxnId_key" ON "provider_payments"("provider", "providerTxnId");
CREATE INDEX "provider_payments_tenantId_idx" ON "provider_payments"("tenantId");
CREATE INDEX "provider_payments_status_idx" ON "provider_payments"("status");

-- [W-201] Tenant isolation, the canonical predicate (F-021-11): the bypass is
-- a ROLE, never a GUC a session could set on itself.
ALTER TABLE "provider_payments" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "provider_payments";
CREATE POLICY "tenant_isolation" ON "provider_payments"
      USING (("tenantId" = current_setting('app.current_tenant', true)
      OR pg_has_role(current_user, 'swift_bypass_rls', 'MEMBER')))
      WITH CHECK (("tenantId" = current_setting('app.current_tenant', true)
      OR pg_has_role(current_user, 'swift_bypass_rls', 'MEMBER')));

ALTER TABLE "mmg_agent_payments" ADD COLUMN "providerPaymentId" TEXT;
CREATE INDEX "mmg_agent_payments_providerPaymentId_idx" ON "mmg_agent_payments"("providerPaymentId");

-- Backfill: one identity per (tenant, normalized provider transaction id).
INSERT INTO "provider_payments" ("id", "tenantId", "provider", "providerTxnId", "status", "creditedPaymentId", "subscriptionId", "creditedAt", "amount", "currencyCode", "createdAt", "updatedAt")
SELECT gen_random_uuid()::text,
       g."tenantId",
       'MMG',
       g.key,
       CASE WHEN g.credited_id IS NOT NULL THEN 'CREDITED' ELSE 'OPEN' END,
       g.credited_id,
       g.credited_sub,
       g.credited_at,
       g.amount,
       g.currency,
       g.first_seen,
       CURRENT_TIMESTAMP
FROM (
  SELECT "tenantId",
         upper(trim(COALESCE("mmgTxnId", regexp_replace("externalId", '^MANUAL:', '')))) AS key,
         (array_agg("id" ORDER BY "createdAt") FILTER (WHERE "status" IN ('MATCHED', 'RESOLVED')))[1] AS credited_id,
         (array_agg("subscriptionId" ORDER BY "createdAt") FILTER (WHERE "status" IN ('MATCHED', 'RESOLVED')))[1] AS credited_sub,
         min("createdAt") FILTER (WHERE "status" IN ('MATCHED', 'RESOLVED')) AS credited_at,
         (array_agg("amount" ORDER BY "createdAt"))[1] AS amount,
         (array_agg("currencyCode" ORDER BY "createdAt"))[1] AS currency,
         min("createdAt") AS first_seen
  FROM "mmg_agent_payments"
  GROUP BY "tenantId", upper(trim(COALESCE("mmgTxnId", regexp_replace("externalId", '^MANUAL:', ''))))
) g
ON CONFLICT ("provider", "providerTxnId") DO NOTHING;

UPDATE "mmg_agent_payments" m
   SET "providerPaymentId" = p."id"
  FROM "provider_payments" p
 WHERE p."provider" = 'MMG'
   AND p."providerTxnId" = upper(trim(COALESCE(m."mmgTxnId", regexp_replace(m."externalId", '^MANUAL:', ''))))
   AND m."providerPaymentId" IS NULL;
