-- Durable ads refund intents: expand-only persistence for exact refund plans,
-- immutable allocation evidence, and crash-safe provider/manual payout work.
-- No existing column is renamed, dropped, backfilled, or made NOT NULL here.
SET lock_timeout = '5s';
SET statement_timeout = '30s';

-- CreateEnum
CREATE TYPE "AdRefundReason" AS ENUM (
  'AUTO_CANCEL_UNAPPROVED',
  'ADVERTISER_CANCEL',
  'ADMIN_KILL',
  'LATE_APPROVAL',
  'PLACEMENT_DOWN'
);

-- CreateEnum
CREATE TYPE "AdRefundIntentStatus" AS ENUM (
  'PENDING',
  'PROCESSING',
  'MANUAL_REQUIRED',
  'SUCCEEDED',
  'FAILED'
);

-- CreateEnum
CREATE TYPE "AdRefundItemKind" AS ENUM ('REFUND', 'CREDIT');

-- CreateEnum
CREATE TYPE "AdRefundPayoutRail" AS ENUM ('PROVIDER', 'MANUAL');

-- Composite ownership keys let every new relation prove tenant/campaign
-- containment at the database boundary. Each is duplicate-proof because the
-- first column is already a primary key; these do not alter existing rows.
CREATE UNIQUE INDEX "ad_campaigns_id_tenantId_key"
  ON "ad_campaigns"("id", "tenantId");

CREATE UNIQUE INDEX "ad_bookings_id_campaignId_key"
  ON "ad_bookings"("id", "campaignId");

CREATE UNIQUE INDEX "ad_invoices_id_tenantId_campaignId_currency_key"
  ON "ad_invoices"("id", "tenantId", "campaignId", "currency");

-- CreateTable
CREATE TABLE "ad_refund_intents" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "invoiceId" TEXT NOT NULL,
  "campaignId" TEXT NOT NULL,
  "idempotencyKey" TEXT NOT NULL,
  "reason" "AdRefundReason" NOT NULL,
  "status" "AdRefundIntentStatus" NOT NULL DEFAULT 'PENDING',
  "amountMinor" BIGINT NOT NULL,
  "currency" TEXT NOT NULL,
  "payoutRail" "AdRefundPayoutRail",
  "provider" TEXT,
  "providerRefundRef" TEXT,
  "manualPayoutRef" TEXT,
  "correlationId" TEXT NOT NULL,
  "requestedByUserId" TEXT,
  "failureCode" TEXT,
  "failureDetail" TEXT,
  "processingStartedAt" TIMESTAMP(3),
  "completedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "ad_refund_intents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ad_refund_items" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "refundIntentId" TEXT NOT NULL,
  "campaignId" TEXT NOT NULL,
  "bookingId" TEXT NOT NULL,
  "kind" "AdRefundItemKind" NOT NULL,
  "amountMinor" BIGINT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "ad_refund_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ad_refund_outbox" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "refundIntentId" TEXT NOT NULL,
  "dedupeKey" TEXT NOT NULL,
  "eventType" TEXT NOT NULL DEFAULT 'ad_refund.execute',
  "eventVersion" INTEGER NOT NULL DEFAULT 1,
  "payload" JSONB NOT NULL,
  "correlationId" TEXT NOT NULL,
  "availableAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "leaseOwner" TEXT,
  "leaseToken" TEXT,
  "leaseExpiresAt" TIMESTAMP(3),
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "maxAttempts" INTEGER NOT NULL DEFAULT 12,
  "lastError" TEXT,
  "processedAt" TIMESTAMP(3),
  "deadLetteredAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "ad_refund_outbox_pkey" PRIMARY KEY ("id")
);

-- Global request/job replay guards. Deliberately not tenant-qualified: the
-- same external request or outbox event can produce at most one global effect.
CREATE UNIQUE INDEX "ad_refund_intents_idempotencyKey_key"
  ON "ad_refund_intents"("idempotencyKey");

CREATE UNIQUE INDEX "ad_refund_outbox_refundIntentId_key"
  ON "ad_refund_outbox"("refundIntentId");

CREATE UNIQUE INDEX "ad_refund_outbox_dedupeKey_key"
  ON "ad_refund_outbox"("dedupeKey");

-- Composite relation keys used by tenant-contained foreign keys.
CREATE UNIQUE INDEX "ad_refund_intents_id_tenantId_key"
  ON "ad_refund_intents"("id", "tenantId");

CREATE UNIQUE INDEX "ad_refund_intents_id_tenantId_campaignId_key"
  ON "ad_refund_intents"("id", "tenantId", "campaignId");

CREATE UNIQUE INDEX "ad_refund_outbox_refundIntentId_tenantId_key"
  ON "ad_refund_outbox"("refundIntentId", "tenantId");

CREATE UNIQUE INDEX "ad_refund_items_intent_booking_kind_key"
  ON "ad_refund_items"("refundIntentId", "bookingId", "kind");

-- A human-entered payment proof may never discharge two debts. PostgreSQL's
-- partial unique is intentional; Prisma cannot represent it in the schema.
CREATE UNIQUE INDEX "ad_refund_intents_manualPayoutRef_key"
  ON "ad_refund_intents"("manualPayoutRef")
  WHERE "manualPayoutRef" IS NOT NULL;

-- Provider references are provider-scoped because separate acquirers may use
-- the same reference format. Null/incomplete attempts do not participate.
CREATE UNIQUE INDEX "ad_refund_intents_provider_ref_key"
  ON "ad_refund_intents"("provider", "providerRefundRef")
  WHERE "provider" IS NOT NULL AND "providerRefundRef" IS NOT NULL;

-- Foreign-key and operational indexes.
CREATE INDEX "ad_refund_intents_tenantId_status_createdAt_idx"
  ON "ad_refund_intents"("tenantId", "status", "createdAt");

CREATE INDEX "ad_refund_intents_invoiceId_idx"
  ON "ad_refund_intents"("invoiceId");

CREATE INDEX "ad_refund_intents_campaignId_status_idx"
  ON "ad_refund_intents"("campaignId", "status");

CREATE INDEX "ad_refund_items_tenantId_refundIntentId_idx"
  ON "ad_refund_items"("tenantId", "refundIntentId");

CREATE INDEX "ad_refund_items_bookingId_idx"
  ON "ad_refund_items"("bookingId");

CREATE INDEX "ad_refund_outbox_tenant_pending_idx"
  ON "ad_refund_outbox"("tenantId", "processedAt", "deadLetteredAt", "availableAt");

CREATE INDEX "ad_refund_outbox_leaseExpiresAt_idx"
  ON "ad_refund_outbox"("leaseExpiresAt");

-- Hot worker scans stay bounded to unfinished work. These partial indexes are
-- raw SQL because Prisma cannot model their predicates.
CREATE INDEX "ad_refund_outbox_pending_scan_idx"
  ON "ad_refund_outbox"("availableAt", "id")
  WHERE "processedAt" IS NULL AND "deadLetteredAt" IS NULL;

CREATE INDEX "ad_refund_outbox_expired_lease_idx"
  ON "ad_refund_outbox"("leaseExpiresAt", "id")
  WHERE "processedAt" IS NULL
    AND "deadLetteredAt" IS NULL
    AND "leaseExpiresAt" IS NOT NULL;

-- Restrictive, tenant-contained relations. Financial evidence is never
-- cascade-deleted with an operator, campaign, invoice, booking, or intent.
ALTER TABLE "ad_refund_intents"
  ADD CONSTRAINT "ad_refund_intents_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "tenants"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "ad_refund_intents"
  ADD CONSTRAINT "ad_refund_intents_invoice_tenant_campaign_currency_fkey"
  FOREIGN KEY ("invoiceId", "tenantId", "campaignId", "currency")
  REFERENCES "ad_invoices"("id", "tenantId", "campaignId", "currency")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "ad_refund_intents"
  ADD CONSTRAINT "ad_refund_intents_campaign_tenant_fkey"
  FOREIGN KEY ("campaignId", "tenantId")
  REFERENCES "ad_campaigns"("id", "tenantId")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "ad_refund_items"
  ADD CONSTRAINT "ad_refund_items_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "tenants"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "ad_refund_items"
  ADD CONSTRAINT "ad_refund_items_intent_tenant_campaign_fkey"
  FOREIGN KEY ("refundIntentId", "tenantId", "campaignId")
  REFERENCES "ad_refund_intents"("id", "tenantId", "campaignId")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "ad_refund_items"
  ADD CONSTRAINT "ad_refund_items_booking_campaign_fkey"
  FOREIGN KEY ("bookingId", "campaignId")
  REFERENCES "ad_bookings"("id", "campaignId")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "ad_refund_outbox"
  ADD CONSTRAINT "ad_refund_outbox_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "tenants"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "ad_refund_outbox"
  ADD CONSTRAINT "ad_refund_outbox_intent_tenant_fkey"
  FOREIGN KEY ("refundIntentId", "tenantId")
  REFERENCES "ad_refund_intents"("id", "tenantId")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- Exact-money and payout-proof laws.
ALTER TABLE "ad_refund_intents"
  ADD CONSTRAINT "ad_refund_intents_amount_positive"
  CHECK ("amountMinor" > 0);

ALTER TABLE "ad_refund_items"
  ADD CONSTRAINT "ad_refund_items_amount_positive"
  CHECK ("amountMinor" > 0);

ALTER TABLE "ad_refund_intents"
  ADD CONSTRAINT "ad_refund_intents_currency_supported"
  CHECK ("currency" IN ('GYD', 'USD', 'TTD', 'JMD', 'BBD', 'XCD'));

ALTER TABLE "ad_refund_intents"
  ADD CONSTRAINT "ad_refund_intents_reference_shape"
  CHECK (
    ("provider" IS NULL OR btrim("provider") <> '')
    AND ("providerRefundRef" IS NULL OR btrim("providerRefundRef") <> '')
    AND ("manualPayoutRef" IS NULL OR btrim("manualPayoutRef") <> '')
    AND ("providerRefundRef" IS NULL OR ("payoutRail" = 'PROVIDER' AND "provider" IS NOT NULL))
    AND ("manualPayoutRef" IS NULL OR "payoutRail" = 'MANUAL')
  );

ALTER TABLE "ad_refund_intents"
  ADD CONSTRAINT "ad_refund_intents_success_has_proof"
  CHECK (
    "status" <> 'SUCCEEDED'
    OR (
      "completedAt" IS NOT NULL
      AND (
        ("payoutRail" = 'PROVIDER' AND "provider" IS NOT NULL AND "providerRefundRef" IS NOT NULL)
        OR ("payoutRail" = 'MANUAL' AND "manualPayoutRef" IS NOT NULL)
      )
    )
  );

-- Lease fields move as one fencing tuple. Terminal rows must release the lease,
-- and a row cannot be both processed and dead-lettered.
ALTER TABLE "ad_refund_outbox"
  ADD CONSTRAINT "ad_refund_outbox_attempts_valid"
  CHECK ("attempts" >= 0 AND "maxAttempts" > 0 AND "eventVersion" > 0);

ALTER TABLE "ad_refund_outbox"
  ADD CONSTRAINT "ad_refund_outbox_lease_tuple"
  CHECK (
    ("leaseOwner" IS NULL AND "leaseToken" IS NULL AND "leaseExpiresAt" IS NULL)
    OR ("leaseOwner" IS NOT NULL AND "leaseToken" IS NOT NULL AND "leaseExpiresAt" IS NOT NULL)
  );

ALTER TABLE "ad_refund_outbox"
  ADD CONSTRAINT "ad_refund_outbox_terminal_state"
  CHECK (
    NOT ("processedAt" IS NOT NULL AND "deadLetteredAt" IS NOT NULL)
    AND (
      ("processedAt" IS NULL AND "deadLetteredAt" IS NULL)
      OR ("leaseOwner" IS NULL AND "leaseToken" IS NULL AND "leaseExpiresAt" IS NULL)
    )
  );

-- Immutable plan inputs/proof rows. Lifecycle fields on the intent and lease
-- fields on the outbox remain intentionally mutable.
CREATE OR REPLACE FUNCTION guard_ad_refund_intent_mutation() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'AD_REFUND_INTENT_IMMUTABLE: deleting intent % is forbidden', OLD."id";
  END IF;

  IF ROW(
    NEW."id", NEW."tenantId", NEW."invoiceId", NEW."campaignId",
    NEW."idempotencyKey", NEW."reason", NEW."amountMinor", NEW."currency",
    NEW."correlationId", NEW."requestedByUserId", NEW."createdAt"
  ) IS DISTINCT FROM ROW(
    OLD."id", OLD."tenantId", OLD."invoiceId", OLD."campaignId",
    OLD."idempotencyKey", OLD."reason", OLD."amountMinor", OLD."currency",
    OLD."correlationId", OLD."requestedByUserId", OLD."createdAt"
  ) THEN
    RAISE EXCEPTION 'AD_REFUND_INTENT_IMMUTABLE: policy identity or amount cannot change for %', OLD."id";
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "ad_refund_intents_guard_mutation"
BEFORE UPDATE OR DELETE ON "ad_refund_intents"
FOR EACH ROW EXECUTE FUNCTION guard_ad_refund_intent_mutation();

CREATE OR REPLACE FUNCTION deny_ad_refund_item_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'AD_REFUND_ITEM_IMMUTABLE: % on item % is forbidden; create a compensating intent', TG_OP, OLD."id";
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "ad_refund_items_immutable"
BEFORE UPDATE OR DELETE ON "ad_refund_items"
FOR EACH ROW EXECUTE FUNCTION deny_ad_refund_item_mutation();

CREATE OR REPLACE FUNCTION guard_ad_refund_outbox_mutation() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'AD_REFUND_OUTBOX_IMMUTABLE: deleting outbox row % is forbidden', OLD."id";
  END IF;

  IF ROW(
    NEW."id", NEW."tenantId", NEW."refundIntentId", NEW."dedupeKey",
    NEW."eventType", NEW."eventVersion", NEW."payload", NEW."correlationId",
    NEW."maxAttempts", NEW."createdAt"
  ) IS DISTINCT FROM ROW(
    OLD."id", OLD."tenantId", OLD."refundIntentId", OLD."dedupeKey",
    OLD."eventType", OLD."eventVersion", OLD."payload", OLD."correlationId",
    OLD."maxAttempts", OLD."createdAt"
  ) THEN
    RAISE EXCEPTION 'AD_REFUND_OUTBOX_IMMUTABLE: identity or payload cannot change for %', OLD."id";
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "ad_refund_outbox_guard_mutation"
BEFORE UPDATE OR DELETE ON "ad_refund_outbox"
FOR EACH ROW EXECUTE FUNCTION guard_ad_refund_outbox_mutation();

-- The exact current schema has both DECIMAL(12,2) columns. NOT VALID avoids a
-- table scan/long validation lock while immediately rejecting new over-refunds.
-- Reconciliation must prove and then VALIDATE this constraint in a later phase.
ALTER TABLE "ad_invoices"
  ADD CONSTRAINT "ad_invoices_refunded_amount_bounds"
  CHECK ("refundedAmount" >= 0 AND "refundedAmount" <= "amount")
  NOT VALID;
