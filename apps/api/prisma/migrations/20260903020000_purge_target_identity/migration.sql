-- [SCR-001 / SCR-002] Destructive purge has no target-identity or verified-backup binding;
-- "include unclassified" deleted every non-admin account.
ALTER TABLE "users" ADD COLUMN "syntheticRunId" TEXT;
CREATE TABLE "deployment_identity" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "deploymentId" TEXT NOT NULL,
    "environment" TEXT NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "deployment_identity_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "privileged_change_audit" (
    "id" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "planDigest" TEXT NOT NULL,
    "event" TEXT NOT NULL,
    "target" JSONB NOT NULL,
    "detail" JSONB,
    "actor" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "privileged_change_audit_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "privileged_change_audit_planDigest_createdAt_idx" ON "privileged_change_audit"("planDigest", "createdAt");
CREATE INDEX "privileged_change_audit_action_createdAt_idx" ON "privileged_change_audit"("action", "createdAt");
-- The audit is append-only: no row is ever updated or deleted.
CREATE OR REPLACE FUNCTION privileged_change_audit_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'privileged_change_audit is append-only (SCR-001): % is forbidden', TG_OP;
END
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS privileged_change_audit_immutable_trg ON "privileged_change_audit";
CREATE TRIGGER privileged_change_audit_immutable_trg BEFORE UPDATE OR DELETE ON "privileged_change_audit" FOR EACH ROW EXECUTE FUNCTION privileged_change_audit_immutable();
