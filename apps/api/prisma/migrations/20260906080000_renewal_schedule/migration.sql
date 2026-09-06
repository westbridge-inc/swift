-- [DOC-1 §9.3 · P4-7] The renewal schedule for an approved document with an expiry:
-- notices at T-30 / T-14 / T-7 / T-1 and suspension at expiry, kept by a trigger on
-- the document itself (DOC-INV-4). Backfilled for every approved document that
-- already carries an expiry; those inside the old 30-day window count as reminded
-- once already (the single notice the previous sweep sent), so nobody is re-told.

-- CreateTable
CREATE TABLE "renewal_schedule" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" TEXT NOT NULL DEFAULT 'swift-default',
    "documentId" TEXT NOT NULL,
    "subjectId" TEXT NOT NULL,
    "expiresOn" TIMESTAMP(3) NOT NULL,
    "notifyAt" TIMESTAMP(3)[],
    "suspendAt" TIMESTAMP(3) NOT NULL,
    "lastNotified" TIMESTAMP(3),
    "suspendedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "renewal_schedule_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "renewal_schedule_documentId_key" ON "renewal_schedule"("documentId");

-- CreateIndex
CREATE INDEX "renewal_schedule_subjectId_idx" ON "renewal_schedule"("subjectId");

-- CreateIndex
CREATE INDEX "renewal_schedule_tenantId_suspendedAt_expiresOn_idx" ON "renewal_schedule"("tenantId", "suspendedAt", "expiresOn");

-- AddForeignKey
ALTER TABLE "renewal_schedule" ADD CONSTRAINT "renewal_schedule_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "renewal_schedule" ADD CONSTRAINT "renewal_schedule_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "verification_documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- The wall, the lineage, and the keeper trigger. Text generated from
-- src/lib/tenant-rls.ts (rlsDdlFor, tenantLineageDdl) and
-- src/modules/verification/renewal-schedule.ts (renewalScheduleDdl).
ALTER TABLE "renewal_schedule" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "renewal_schedule" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "renewal_schedule";
CREATE POLICY "tenant_isolation" ON "renewal_schedule"
      USING (("tenantId" = current_setting('app.current_tenant', true)
      OR pg_has_role(current_user, 'swift_bypass_rls', 'MEMBER')))
      WITH CHECK (("tenantId" = current_setting('app.current_tenant', true)
      OR pg_has_role(current_user, 'swift_bypass_rls', 'MEMBER')));
CREATE OR REPLACE FUNCTION renewal_schedule_tenant_matches_subject() RETURNS trigger AS $$
      DECLARE parent_tenant TEXT;
      BEGIN
        SELECT "tenantId" FROM users WHERE id = NEW."subjectId" INTO parent_tenant;
        IF parent_tenant IS NULL THEN
          -- An UPDATE that unlinks the owner (an FK SET NULL when a mover or user is
          -- deleted) leaves the row's tenant as it was; only a NEW row with no owner is refused.
          IF TG_OP = 'UPDATE' THEN RETURN NEW; END IF;
          RAISE EXCEPTION 'renewal_schedule row % names users row %, which does not exist or is not visible from this tenant [STA-1 lineage]',
            NEW.id, NEW."subjectId" USING ERRCODE = 'check_violation';
        END IF;
        -- The default means "unstamped": derive the truth from the parent.
        IF NEW."tenantId" = 'swift-default' AND parent_tenant <> 'swift-default' THEN
          NEW."tenantId" := parent_tenant;
        ELSIF parent_tenant <> NEW."tenantId" THEN
          RAISE EXCEPTION 'renewal_schedule row % names tenant % but its users row % is in tenant % [STA-1 lineage]',
            NEW.id, NEW."tenantId", NEW."subjectId", parent_tenant USING ERRCODE = 'check_violation';
        END IF;
        RETURN NEW;
      END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS renewal_schedule_tenant_matches_subject ON renewal_schedule;
CREATE TRIGGER renewal_schedule_tenant_matches_subject BEFORE INSERT OR UPDATE OF "tenantId", "subjectId" ON renewal_schedule FOR EACH ROW EXECUTE FUNCTION renewal_schedule_tenant_matches_subject();
CREATE OR REPLACE FUNCTION renewal_schedule_keep() RETURNS trigger AS $$
      DECLARE v_tenant TEXT;
      BEGIN
        IF NEW.status = 'APPROVED' AND NEW."expiresAt" IS NOT NULL THEN
          SELECT "tenantId" INTO v_tenant FROM users WHERE id = NEW."userId";
          INSERT INTO renewal_schedule ("documentId", "tenantId", "subjectId", "expiresOn", "notifyAt", "suspendAt", "createdAt", "updatedAt")
          VALUES (NEW.id, COALESCE(v_tenant, 'swift-default'), NEW."userId", NEW."expiresAt",
                  ARRAY[NEW."expiresAt" - interval '30 days', NEW."expiresAt" - interval '14 days', NEW."expiresAt" - interval '7 days', NEW."expiresAt" - interval '1 day'],
                  NEW."expiresAt", now(), now())
          ON CONFLICT ("documentId") DO UPDATE SET
            "expiresOn" = EXCLUDED."expiresOn",
            "notifyAt" = EXCLUDED."notifyAt",
            "suspendAt" = EXCLUDED."suspendAt",
            "suspendedAt" = CASE WHEN renewal_schedule."expiresOn" = EXCLUDED."expiresOn" THEN renewal_schedule."suspendedAt" ELSE NULL END,
            "lastNotified" = CASE WHEN renewal_schedule."expiresOn" = EXCLUDED."expiresOn" THEN renewal_schedule."lastNotified" ELSE NULL END,
            "updatedAt" = now();
        END IF;
        RETURN NEW;
      END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS verification_documents_keep_renewal ON verification_documents;
CREATE TRIGGER verification_documents_keep_renewal AFTER INSERT OR UPDATE OF status, "expiresAt" ON verification_documents FOR EACH ROW EXECUTE FUNCTION renewal_schedule_keep();

-- Truth first: every approved document with an expiry gets its schedule; a document
-- inside the old 30-day window was already reminded once by the previous sweep.
INSERT INTO "renewal_schedule" ("documentId", "tenantId", "subjectId", "expiresOn", "notifyAt", "suspendAt", "lastNotified", "createdAt", "updatedAt")
SELECT d.id, u."tenantId", d."userId", d."expiresAt",
       ARRAY[d."expiresAt" - interval '30 days', d."expiresAt" - interval '14 days', d."expiresAt" - interval '7 days', d."expiresAt" - interval '1 day'],
       d."expiresAt",
       CASE WHEN d."expiresAt" <= now() + interval '30 days' THEN d."expiresAt" - interval '30 days' ELSE NULL END,
       now(), now()
  FROM "verification_documents" d JOIN "users" u ON u.id = d."userId"
 WHERE d.status = 'APPROVED' AND d."expiresAt" IS NOT NULL
ON CONFLICT ("documentId") DO NOTHING;
