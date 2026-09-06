-- [DOC-1 Part XXV · P25] A person's request to correct an extracted field. It re-opens
-- a review case; the correction is a reviewer action with provenance (DOC-INV-34).

-- CreateTable
CREATE TABLE "rectification_request" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" TEXT NOT NULL DEFAULT 'swift-default',
    "userId" TEXT NOT NULL,
    "submissionId" TEXT NOT NULL,
    "caseId" UUID NOT NULL,
    "fieldCode" TEXT NOT NULL,
    "note" TEXT NOT NULL,
    "resolvedAt" TIMESTAMP(3),
    "resolvedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "rectification_request_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "rectification_request_submissionId_resolvedAt_idx" ON "rectification_request"("submissionId", "resolvedAt");

-- CreateIndex
CREATE INDEX "rectification_request_caseId_idx" ON "rectification_request"("caseId");

-- AddForeignKey
ALTER TABLE "rectification_request" ADD CONSTRAINT "rectification_request_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- The wall, on the row itself (enabled AND forced), and the lineage held by the
-- database. Text generated from src/lib/tenant-rls.ts (rlsDdlFor, tenantLineageDdl).
ALTER TABLE "rectification_request" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "rectification_request" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "rectification_request";
CREATE POLICY "tenant_isolation" ON "rectification_request"
      USING (("tenantId" = current_setting('app.current_tenant', true)
      OR pg_has_role(current_user, 'swift_bypass_rls', 'MEMBER')))
      WITH CHECK (("tenantId" = current_setting('app.current_tenant', true)
      OR pg_has_role(current_user, 'swift_bypass_rls', 'MEMBER')));
CREATE OR REPLACE FUNCTION rectification_request_tenant_matches_user() RETURNS trigger AS $$
      DECLARE parent_tenant TEXT;
      BEGIN
        SELECT "tenantId" FROM users WHERE id = NEW."userId" INTO parent_tenant;
        IF parent_tenant IS NULL THEN
          -- An UPDATE that unlinks the owner (an FK SET NULL when a mover or user is
          -- deleted) leaves the row's tenant as it was; only a NEW row with no owner is refused.
          IF TG_OP = 'UPDATE' THEN RETURN NEW; END IF;
          RAISE EXCEPTION 'rectification_request row % names users row %, which does not exist or is not visible from this tenant [STA-1 lineage]',
            NEW.id, NEW."userId" USING ERRCODE = 'check_violation';
        END IF;
        -- The default means "unstamped": derive the truth from the parent.
        IF NEW."tenantId" = 'swift-default' AND parent_tenant <> 'swift-default' THEN
          NEW."tenantId" := parent_tenant;
        ELSIF parent_tenant <> NEW."tenantId" THEN
          RAISE EXCEPTION 'rectification_request row % names tenant % but its users row % is in tenant % [STA-1 lineage]',
            NEW.id, NEW."tenantId", NEW."userId", parent_tenant USING ERRCODE = 'check_violation';
        END IF;
        RETURN NEW;
      END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS rectification_request_tenant_matches_user ON rectification_request;
CREATE TRIGGER rectification_request_tenant_matches_user BEFORE INSERT OR UPDATE OF "tenantId", "userId" ON rectification_request FOR EACH ROW EXECUTE FUNCTION rectification_request_tenant_matches_user();
