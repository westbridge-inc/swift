-- [ADM-007] Every sensitive admin read leaves a record.
--
-- Two of the 77 admin reads were logged. An admin could open any customer, any
-- driver, any order, any uploaded document and any handover secret and leave
-- nothing behind — which defeats the "every access is logged" commitment this
-- platform makes to the people whose data it holds (Appendix AH, AH-DPA-003).
--
-- The C1 class is exactly the set that discloses identity, location, a
-- document or a secret, so it is the set that writes here.
CREATE TABLE "sensitive_read_logs" (
  "id"          TEXT NOT NULL,
  "tenantId"    TEXT NOT NULL DEFAULT 'swift-default',
  "actorUserId" TEXT NOT NULL,
  "action"      TEXT NOT NULL,
  "capability"  TEXT NOT NULL,
  "subjectId"   TEXT,
  "purpose"     TEXT NOT NULL,
  "at"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "sensitive_read_logs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "sensitive_read_logs_tenantId_idx" ON "sensitive_read_logs"("tenantId");
CREATE INDEX "sensitive_read_logs_actorUserId_at_idx" ON "sensitive_read_logs"("actorUserId", "at");
CREATE INDEX "sensitive_read_logs_subjectId_at_idx" ON "sensitive_read_logs"("subjectId", "at");

-- An access record is evidence about a person: it never crosses a market.
ALTER TABLE "sensitive_read_logs" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "sensitive_read_logs";
CREATE POLICY "tenant_isolation" ON "sensitive_read_logs"
      USING (("tenantId" = current_setting('app.current_tenant', true)
      OR pg_has_role(current_user, 'swift_bypass_rls', 'MEMBER')))
      WITH CHECK (("tenantId" = current_setting('app.current_tenant', true)
      OR pg_has_role(current_user, 'swift_bypass_rls', 'MEMBER')));

-- Append-only, like the admin audit trail (ADM-003): a record of who looked at
-- whose data is worth nothing if the looker can edit it afterwards. UPDATE has
-- no exception at all; DELETE has the same one the audit trail has — a
-- transaction that names itself a retention purge — so the two trails are one
-- rule rather than two, and the same census keeps the licence in one helper.
CREATE OR REPLACE FUNCTION sensitive_read_logs_append_only() RETURNS trigger AS $$
BEGIN
  IF (TG_OP = 'UPDATE') THEN
    RAISE EXCEPTION 'sensitive_read_logs is append-only — row % cannot be modified', OLD."id"
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF coalesce(current_setting('swift.audit_purge', true), '') = '' THEN
    RAISE EXCEPTION 'sensitive_read_logs is append-only — row % cannot be deleted', OLD."id"
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN OLD;
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS sensitive_read_logs_no_mutation ON "sensitive_read_logs";
CREATE TRIGGER sensitive_read_logs_no_mutation
BEFORE UPDATE OR DELETE ON "sensitive_read_logs"
FOR EACH ROW EXECUTE FUNCTION sensitive_read_logs_append_only();
