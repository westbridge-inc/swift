-- LAUNCH-2: tenant-safe UGC reports and reversible user-block audit episodes.
-- Expand-only: existing report rows and indexes remain intact.
SET lock_timeout = '10s';

ALTER TYPE "ReportTargetType" ADD VALUE IF NOT EXISTS 'CATEGORY';
ALTER TYPE "ReportTargetType" ADD VALUE IF NOT EXISTS 'RATING_RESPONSE';
ALTER TYPE "ReportTargetType" ADD VALUE IF NOT EXISTS 'PROMO_CODE';
ALTER TYPE "ReportTargetType" ADD VALUE IF NOT EXISTS 'SERVICE_PROVIDER';
ALTER TYPE "ReportTargetType" ADD VALUE IF NOT EXISTS 'SERVICE_JOB';
ALTER TYPE "ReportTargetType" ADD VALUE IF NOT EXISTS 'ORDER';
ALTER TYPE "ReportTargetType" ADD VALUE IF NOT EXISTS 'AD_CREATIVE';

-- ContentReport was introduced after the tenancy foundation but without its own
-- tenant column. Attribute every surviving row to its live reporter. Reporter
-- and target ids deliberately remain loose so later account/content deletion
-- cannot erase or cascade report evidence.
ALTER TABLE "content_reports" ADD COLUMN "tenantId" TEXT;
ALTER TABLE "content_reports" ADD COLUMN "targetSnapshot" JSONB;

UPDATE "content_reports" AS report
SET "tenantId" = reporter."tenantId"
FROM "users" AS reporter
WHERE report."reporterId" = reporter."id";

-- A report whose reporter no longer resolves has unknown tenant provenance.
-- Guessing swift-default would expose that evidence to the wrong operator if
-- the orphan came from another tenant. Stop the migration so an operator must
-- explicitly reconcile those rows before retrying.
DO $$
DECLARE
  orphan_count BIGINT;
BEGIN
  SELECT COUNT(*) INTO orphan_count
  FROM "content_reports"
  WHERE "tenantId" IS NULL;

  IF orphan_count > 0 THEN
    RAISE EXCEPTION
      'Cannot backfill content_reports tenant provenance: % orphan report row(s) require explicit remediation',
      orphan_count;
  END IF;
END $$;

ALTER TABLE "content_reports"
  ALTER COLUMN "tenantId" SET DEFAULT 'swift-default',
  ALTER COLUMN "tenantId" SET NOT NULL;

ALTER TABLE "content_reports"
  ADD CONSTRAINT "content_reports_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "tenants"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX "content_reports_tenantId_idx"
  ON "content_reports"("tenantId");
CREATE INDEX "content_reports_tenantId_status_createdAt_idx"
  ON "content_reports"("tenantId", "status", "createdAt");

CREATE TABLE "user_blocks" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL DEFAULT 'swift-default',
  "blockerId" TEXT NOT NULL,
  "blockedId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "unblockedAt" TIMESTAMP(3),

  CONSTRAINT "user_blocks_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "user_blocks_not_self_check" CHECK ("blockerId" <> "blockedId"),
  CONSTRAINT "user_blocks_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "tenants"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE INDEX "user_blocks_tenantId_idx"
  ON "user_blocks"("tenantId");
CREATE INDEX "user_blocks_tenantId_blockerId_unblockedAt_idx"
  ON "user_blocks"("tenantId", "blockerId", "unblockedAt");
CREATE INDEX "user_blocks_tenantId_blockedId_unblockedAt_idx"
  ON "user_blocks"("tenantId", "blockedId", "unblockedAt");

-- Re-blocking records a new episode, while concurrent duplicate block taps can
-- never create two active episodes.
CREATE UNIQUE INDEX "user_blocks_one_active_episode_key"
  ON "user_blocks"("tenantId", "blockerId", "blockedId")
  WHERE "unblockedAt" IS NULL;

-- Both tables are evidence. Product code may resolve reports or close a block
-- episode, but must never physically erase the record. DELETE and TRUNCATE are
-- separate PostgreSQL operations, so both need their own trigger event.
CREATE FUNCTION "prevent_ugc_audit_delete"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION '% is append-only audit evidence; hard-delete is not permitted', TG_TABLE_NAME;
END;
$$;

CREATE TRIGGER "content_reports_no_delete"
  BEFORE DELETE ON "content_reports"
  FOR EACH STATEMENT EXECUTE FUNCTION "prevent_ugc_audit_delete"();

CREATE TRIGGER "user_blocks_no_delete"
  BEFORE DELETE ON "user_blocks"
  FOR EACH STATEMENT EXECUTE FUNCTION "prevent_ugc_audit_delete"();

REVOKE TRUNCATE ON "content_reports" FROM PUBLIC;
REVOKE TRUNCATE ON "user_blocks" FROM PUBLIC;

CREATE TRIGGER "content_reports_no_truncate"
  BEFORE TRUNCATE ON "content_reports"
  FOR EACH STATEMENT EXECUTE FUNCTION "prevent_ugc_audit_delete"();

CREATE TRIGGER "user_blocks_no_truncate"
  BEFORE TRUNCATE ON "user_blocks"
  FOR EACH STATEMENT EXECUTE FUNCTION "prevent_ugc_audit_delete"();

-- A report's provenance and captured evidence are immutable. Only the workflow
-- columns (status/resolution fields) plus Prisma's updatedAt bookkeeping may be
-- changed by a reviewer.
CREATE FUNCTION "guard_content_report_update"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF ROW(
    NEW."id",
    NEW."tenantId",
    NEW."reporterId",
    NEW."targetType",
    NEW."targetId",
    NEW."reason",
    NEW."detail",
    NEW."targetSnapshot",
    NEW."createdAt"
  ) IS DISTINCT FROM ROW(
    OLD."id",
    OLD."tenantId",
    OLD."reporterId",
    OLD."targetType",
    OLD."targetId",
    OLD."reason",
    OLD."detail",
    OLD."targetSnapshot",
    OLD."createdAt"
  ) THEN
    RAISE EXCEPTION 'content_reports provenance and evidence are immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "content_reports_guard_update"
  BEFORE UPDATE ON "content_reports"
  FOR EACH ROW EXECUTE FUNCTION "guard_content_report_update"();

-- A block episode may move in exactly one direction: active (NULL) to closed
-- (a timestamp). Participants, tenant, identity and creation time never change;
-- a later block is a new row rather than a reopened old episode.
CREATE FUNCTION "guard_user_block_update"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF ROW(
    NEW."id",
    NEW."tenantId",
    NEW."blockerId",
    NEW."blockedId",
    NEW."createdAt"
  ) IS DISTINCT FROM ROW(
    OLD."id",
    OLD."tenantId",
    OLD."blockerId",
    OLD."blockedId",
    OLD."createdAt"
  ) THEN
    RAISE EXCEPTION 'user_blocks episode provenance is immutable';
  END IF;

  IF OLD."unblockedAt" IS NOT NULL
     AND NEW."unblockedAt" IS DISTINCT FROM OLD."unblockedAt" THEN
    RAISE EXCEPTION 'a closed user_blocks episode is immutable';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER "user_blocks_guard_update"
  BEFORE UPDATE ON "user_blocks"
  FOR EACH ROW EXECUTE FUNCTION "guard_user_block_update"();

-- Tenant isolation is structural. No request context matches no rows; the
-- audited bypass is a database role capability, not a caller-settable GUC.
ALTER TABLE "content_reports" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "content_reports"
  USING (("tenantId" = current_setting('app.current_tenant', true)
    OR pg_has_role(current_user, 'swift_bypass_rls', 'MEMBER')))
  WITH CHECK (("tenantId" = current_setting('app.current_tenant', true)
    OR pg_has_role(current_user, 'swift_bypass_rls', 'MEMBER')));

ALTER TABLE "user_blocks" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "user_blocks"
  USING (("tenantId" = current_setting('app.current_tenant', true)
    OR pg_has_role(current_user, 'swift_bypass_rls', 'MEMBER')))
  WITH CHECK (("tenantId" = current_setting('app.current_tenant', true)
    OR pg_has_role(current_user, 'swift_bypass_rls', 'MEMBER')));
