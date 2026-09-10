-- Expand-only control plane for the non-rolling verification-object authority
-- cutover. While phase is OPEN this changes no application behavior. Entering
-- MAINTENANCE installs a database-enforced write fence that old binaries cannot
-- bypass because they do not know the random maintenance epoch.

BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE TYPE "VerificationAuthorityCutoverPhase" AS ENUM
  ('OPEN', 'MAINTENANCE', 'PREPARED', 'MIGRATED', 'CERTIFIED');
CREATE TYPE "VerificationAuthorityCutoverRunState" AS ENUM
  ('SEALED', 'APPLYING', 'APPLIED', 'CERTIFIED', 'FAILED');

CREATE TABLE "verification_authority_cutover_control" (
  id TEXT PRIMARY KEY,
  phase "VerificationAuthorityCutoverPhase" NOT NULL DEFAULT 'OPEN',
  "maintenanceEpoch" UUID,
  "certificationDigest" TEXT,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "verification_authority_cutover_control_singleton_check"
    CHECK (id = 'platform'),
  CONSTRAINT "verification_authority_cutover_control_epoch_check"
    CHECK (
      (phase = 'OPEN' AND "maintenanceEpoch" IS NULL)
      OR (phase <> 'OPEN' AND "maintenanceEpoch" IS NOT NULL)
    ),
  CONSTRAINT "verification_authority_cutover_control_digest_check"
    CHECK (
      "certificationDigest" IS NULL
      OR "certificationDigest" ~ '^[0-9a-f]{64}$'
    )
);
INSERT INTO "verification_authority_cutover_control" (id) VALUES ('platform');

CREATE TABLE "verification_authority_cutover_run" (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenantId" TEXT NOT NULL REFERENCES "tenants"(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  "maintenanceEpoch" UUID NOT NULL,
  "candidateSha" TEXT NOT NULL,
  "migrationSha256" TEXT NOT NULL,
  "planDigest" TEXT NOT NULL,
  "planFacts" JSONB NOT NULL,
  state "VerificationAuthorityCutoverRunState" NOT NULL DEFAULT 'SEALED',
  "plannedCount" INTEGER NOT NULL,
  "appliedCount" INTEGER NOT NULL DEFAULT 0,
  "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completedAt" TIMESTAMP(3),
  CONSTRAINT "verification_authority_cutover_run_candidate_check"
    CHECK ("candidateSha" ~ '^[0-9a-f]{40}$'),
  CONSTRAINT "verification_authority_cutover_run_migration_check"
    CHECK ("migrationSha256" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "verification_authority_cutover_run_digest_check"
    CHECK ("planDigest" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "verification_authority_cutover_run_counts_check"
    CHECK ("plannedCount" >= 0 AND "appliedCount" >= 0 AND "appliedCount" <= "plannedCount"),
  UNIQUE ("tenantId", "maintenanceEpoch")
);

CREATE TABLE "verification_authority_cutover_item" (
  "runId" UUID NOT NULL REFERENCES "verification_authority_cutover_run"(id) ON DELETE RESTRICT,
  "tenantId" TEXT NOT NULL REFERENCES "tenants"(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  "maintenanceEpoch" UUID NOT NULL,
  "documentId" TEXT NOT NULL REFERENCES "verification_documents"(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  "priorState" "DocState" NOT NULL,
  "priorStatus" "VerificationDocumentStatus" NOT NULL,
  "pointerSha256" TEXT NOT NULL,
  "pointerWasEmpty" BOOLEAN NOT NULL,
  disposition TEXT NOT NULL DEFAULT 'PENDING',
  "appliedAt" TIMESTAMP(3),
  "quarantinedAt" TIMESTAMP(3),
  CONSTRAINT "verification_authority_cutover_item_pointer_hash_check"
    CHECK ("pointerSha256" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "verification_authority_cutover_item_disposition_check"
    CHECK (disposition IN ('PENDING', 'REVOKED', 'REVIEW_RESET', 'NO_TRUST')),
  CONSTRAINT "verification_authority_cutover_item_applied_check"
    CHECK (
      (disposition = 'PENDING' AND "appliedAt" IS NULL)
      OR (disposition <> 'PENDING' AND "appliedAt" IS NOT NULL)
    ),
  PRIMARY KEY ("runId", "documentId"),
  UNIQUE ("tenantId", "maintenanceEpoch", "documentId")
);

CREATE INDEX "verification_authority_cutover_run_epoch_state_idx"
  ON "verification_authority_cutover_run"("maintenanceEpoch", state, "tenantId");
CREATE INDEX "verification_authority_cutover_item_run_disposition_idx"
  ON "verification_authority_cutover_item"("runId", disposition, "documentId");

ALTER TABLE "verification_authority_cutover_run" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "verification_authority_cutover_run" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "verification_authority_cutover_run"
  USING (
    "tenantId" = current_setting('app.current_tenant', true)
    OR pg_has_role(current_user, 'swift_bypass_rls', 'MEMBER')
  )
  WITH CHECK (
    "tenantId" = current_setting('app.current_tenant', true)
    OR pg_has_role(current_user, 'swift_bypass_rls', 'MEMBER')
  );

ALTER TABLE "verification_authority_cutover_item" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "verification_authority_cutover_item" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "verification_authority_cutover_item"
  USING (
    "tenantId" = current_setting('app.current_tenant', true)
    OR pg_has_role(current_user, 'swift_bypass_rls', 'MEMBER')
  )
  WITH CHECK (
    "tenantId" = current_setting('app.current_tenant', true)
    OR pg_has_role(current_user, 'swift_bypass_rls', 'MEMBER')
  );

CREATE OR REPLACE FUNCTION verification_authority_cutover_epoch_matches(epoch UUID)
RETURNS BOOLEAN
LANGUAGE sql STABLE
AS $$
  SELECT current_setting('app.verification_cutover_epoch', true) = epoch::text
$$;

CREATE OR REPLACE FUNCTION verification_authority_cutover_control_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'VERIFICATION_CUTOVER_CONTROL_IMMUTABLE: singleton cannot be deleted';
  END IF;
  IF TG_OP = 'INSERT' THEN
    RETURN NEW;
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW."maintenanceEpoch" IS DISTINCT FROM OLD."maintenanceEpoch"
        AND NOT (
          (OLD.phase = 'OPEN' AND NEW.phase = 'MAINTENANCE' AND OLD."maintenanceEpoch" IS NULL)
          OR (OLD.phase = 'CERTIFIED' AND NEW.phase = 'OPEN' AND NEW."maintenanceEpoch" IS NULL)
        ) THEN
    RAISE EXCEPTION 'VERIFICATION_CUTOVER_CONTROL_IMMUTABLE: epoch may change only on enter/reopen';
  END IF;
  IF NOT (
    (OLD.phase = 'OPEN' AND NEW.phase = 'MAINTENANCE' AND NEW."maintenanceEpoch" IS NOT NULL)
    OR (OLD.phase = 'MAINTENANCE' AND NEW.phase = 'PREPARED')
    OR (OLD.phase = 'PREPARED' AND NEW.phase = 'MIGRATED')
    OR (OLD.phase = 'MIGRATED' AND NEW.phase = 'CERTIFIED' AND NEW."certificationDigest" IS NOT NULL)
    OR (OLD.phase = 'CERTIFIED' AND NEW.phase = 'OPEN' AND NEW."maintenanceEpoch" IS NULL)
  ) THEN
    RAISE EXCEPTION 'VERIFICATION_CUTOVER_PHASE_INVALID: % -> %', OLD.phase, NEW.phase;
  END IF;
  IF NOT verification_authority_cutover_epoch_matches(
    COALESCE(NEW."maintenanceEpoch", OLD."maintenanceEpoch")
  ) THEN
    RAISE EXCEPTION 'VERIFICATION_CUTOVER_EPOCH_INVALID: exact maintenance epoch required';
  END IF;
  NEW."updatedAt" := CURRENT_TIMESTAMP;
  RETURN NEW;
END
$$;
CREATE TRIGGER verification_authority_cutover_control_guard
BEFORE UPDATE OR DELETE ON "verification_authority_cutover_control"
FOR EACH ROW EXECUTE FUNCTION verification_authority_cutover_control_guard();

CREATE OR REPLACE FUNCTION verification_authority_cutover_run_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'VERIFICATION_CUTOVER_RUN_APPEND_ONLY: run evidence cannot be deleted';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.state <> 'SEALED' OR NEW."appliedCount" <> 0 OR NEW."completedAt" IS NOT NULL THEN
      RAISE EXCEPTION 'VERIFICATION_CUTOVER_RUN_INVALID: a run must begin sealed and unapplied';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW."tenantId" IS DISTINCT FROM OLD."tenantId"
     OR NEW."maintenanceEpoch" IS DISTINCT FROM OLD."maintenanceEpoch"
     OR NEW."candidateSha" IS DISTINCT FROM OLD."candidateSha"
     OR NEW."migrationSha256" IS DISTINCT FROM OLD."migrationSha256"
     OR NEW."planDigest" IS DISTINCT FROM OLD."planDigest"
     OR NEW."planFacts" IS DISTINCT FROM OLD."planFacts"
     OR NEW."plannedCount" IS DISTINCT FROM OLD."plannedCount"
     OR NEW."startedAt" IS DISTINCT FROM OLD."startedAt" THEN
    RAISE EXCEPTION 'VERIFICATION_CUTOVER_RUN_IMMUTABLE: sealed plan facts cannot change';
  END IF;
  IF NOT (
    (OLD.state = 'SEALED' AND NEW.state IN ('APPLYING', 'FAILED'))
    OR (OLD.state = 'APPLYING' AND NEW.state IN ('APPLIED', 'FAILED'))
    OR (OLD.state = 'APPLIED' AND NEW.state = 'CERTIFIED')
    OR NEW.state = OLD.state
  ) THEN
    RAISE EXCEPTION 'VERIFICATION_CUTOVER_RUN_STATE_INVALID: % -> %', OLD.state, NEW.state;
  END IF;
  IF NEW."appliedCount" < OLD."appliedCount" THEN
    RAISE EXCEPTION 'VERIFICATION_CUTOVER_RUN_INVALID: applied count is monotonic';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER verification_authority_cutover_run_guard
BEFORE INSERT OR UPDATE OR DELETE ON "verification_authority_cutover_run"
FOR EACH ROW EXECUTE FUNCTION verification_authority_cutover_run_guard();

CREATE OR REPLACE FUNCTION verification_authority_cutover_item_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'VERIFICATION_CUTOVER_ITEM_APPEND_ONLY: item evidence cannot be deleted';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.disposition <> 'PENDING' OR NEW."appliedAt" IS NOT NULL OR NEW."quarantinedAt" IS NOT NULL THEN
      RAISE EXCEPTION 'VERIFICATION_CUTOVER_ITEM_INVALID: an item must begin pending';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW."runId" IS DISTINCT FROM OLD."runId"
     OR NEW."tenantId" IS DISTINCT FROM OLD."tenantId"
     OR NEW."maintenanceEpoch" IS DISTINCT FROM OLD."maintenanceEpoch"
     OR NEW."documentId" IS DISTINCT FROM OLD."documentId"
     OR NEW."priorState" IS DISTINCT FROM OLD."priorState"
     OR NEW."priorStatus" IS DISTINCT FROM OLD."priorStatus"
     OR NEW."pointerSha256" IS DISTINCT FROM OLD."pointerSha256"
     OR NEW."pointerWasEmpty" IS DISTINCT FROM OLD."pointerWasEmpty" THEN
    RAISE EXCEPTION 'VERIFICATION_CUTOVER_ITEM_IMMUTABLE: item identity cannot change';
  END IF;
  IF OLD.disposition = 'PENDING' AND NEW.disposition = 'PENDING'
     OR OLD.disposition <> 'PENDING' AND NEW.disposition <> OLD.disposition THEN
    RAISE EXCEPTION 'VERIFICATION_CUTOVER_ITEM_STATE_INVALID: disposition may be sealed once';
  END IF;
  IF NEW."appliedAt" IS DISTINCT FROM OLD."appliedAt"
     AND NOT (OLD."appliedAt" IS NULL AND NEW."appliedAt" IS NOT NULL) THEN
    RAISE EXCEPTION 'VERIFICATION_CUTOVER_ITEM_IMMUTABLE: applied time is monotonic';
  END IF;
  IF NEW."quarantinedAt" IS DISTINCT FROM OLD."quarantinedAt"
     AND NOT (OLD."quarantinedAt" IS NULL AND NEW."quarantinedAt" IS NOT NULL) THEN
    RAISE EXCEPTION 'VERIFICATION_CUTOVER_ITEM_IMMUTABLE: quarantine time is monotonic';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER verification_authority_cutover_item_guard
BEFORE INSERT OR UPDATE OR DELETE ON "verification_authority_cutover_item"
FOR EACH ROW EXECUTE FUNCTION verification_authority_cutover_item_guard();

CREATE OR REPLACE FUNCTION verification_authority_maintenance_write_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  control_phase "VerificationAuthorityCutoverPhase";
  control_epoch UUID;
BEGIN
  SELECT phase, "maintenanceEpoch"
    INTO control_phase, control_epoch
  FROM "verification_authority_cutover_control"
  WHERE id = 'platform';
  IF control_phase <> 'OPEN'
     AND NOT verification_authority_cutover_epoch_matches(control_epoch) THEN
    RAISE EXCEPTION 'VERIFICATION_AUTHORITY_MAINTENANCE: verification authority writes are fenced';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END
$$;

CREATE TRIGGER verification_documents_authority_maintenance_guard
BEFORE INSERT OR UPDATE OR DELETE ON "verification_documents"
FOR EACH ROW EXECUTE FUNCTION verification_authority_maintenance_write_guard();
CREATE TRIGGER document_record_authority_maintenance_guard
BEFORE INSERT OR UPDATE OR DELETE ON "document_record"
FOR EACH ROW EXECUTE FUNCTION verification_authority_maintenance_write_guard();
CREATE TRIGGER users_verification_authority_maintenance_guard
BEFORE UPDATE OF "trustLevel" ON "users"
FOR EACH ROW EXECUTE FUNCTION verification_authority_maintenance_write_guard();
CREATE TRIGGER riders_verification_authority_maintenance_guard
BEFORE UPDATE OF "documentsVerified", "documentsVerifiedAt", "documentsVerifiedBy", "isOnline", "isAvailable", "locationSessionId", "currentOrderId" ON "riders"
FOR EACH ROW EXECUTE FUNCTION verification_authority_maintenance_write_guard();
CREATE TRIGGER drivers_verification_authority_maintenance_guard
BEFORE UPDATE OF "documentsVerified", "documentsVerifiedAt", "documentsVerifiedBy", "isOnline", "isAvailable", "locationSessionId", "currentRideId" ON "drivers"
FOR EACH ROW EXECUTE FUNCTION verification_authority_maintenance_write_guard();
CREATE TRIGGER vendors_verification_authority_maintenance_guard
BEFORE UPDATE OF "isVerified", "acceptingOrders", "isCurrentlyOpen", "activationValidUntil" ON "vendors"
FOR EACH ROW EXECUTE FUNCTION verification_authority_maintenance_write_guard();
CREATE TRIGGER service_providers_verification_authority_maintenance_guard
BEFORE UPDATE OF "isVerified" ON "service_providers"
FOR EACH ROW EXECUTE FUNCTION verification_authority_maintenance_write_guard();

COMMIT;
