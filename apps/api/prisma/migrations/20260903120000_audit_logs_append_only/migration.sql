-- [ADM-003] audit_logs is append-only, enforced by the database.
--
-- Appendix AJ, §AJ.1: behind ONE boolean sit `users/:id/ban`,
-- `finance/settlements/:id/process`, `subscriptions/:id/waive-fee`,
-- `config/:key` and `notifications/broadcast`. The record of every one of
-- those actions lived in a table with no trigger, rule or constraint — so the
-- record of a privileged action could be altered or removed after the fact by
-- anyone able to reach the database, including the application role itself.
-- An audit trail that the actor can edit is not evidence; it is a log.
--
-- EvidenceBundle/EvidenceItem already prove the pattern in this schema
-- (20260730210000_evidence_vault): the database refuses, not the application.
-- This applies the same discipline to the admin audit trail.
--
-- UPDATE is refused unconditionally. Nothing in the tree updates an audit row
-- and nothing legitimately would: a correction is a new row.
--
-- DELETE is refused unless the TRANSACTION names itself a retention purge by
-- setting `swift.audit_purge`. That is not a hole in the guarantee, it is the
-- shape of it: a stray `auditLog.deleteMany(...)` anywhere in the application
-- now fails, and the only code that can remove an audit row is code that said
-- so in the same transaction, in a helper the census test keeps sole.
-- Retention proper is by partition, not deletion (ADM-003 remediation).
--
-- TRUNCATE bypasses row-level triggers entirely, so it has its own.

CREATE OR REPLACE FUNCTION audit_logs_append_only() RETURNS trigger AS $$
BEGIN
  IF (TG_OP = 'UPDATE') THEN
    RAISE EXCEPTION 'audit_logs is append-only — row % cannot be modified', OLD."id"
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF coalesce(current_setting('swift.audit_purge', true), '') = '' THEN
    RAISE EXCEPTION 'audit_logs is append-only — row % cannot be deleted', OLD."id"
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN OLD;
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS audit_logs_no_mutation ON "audit_logs";
CREATE TRIGGER audit_logs_no_mutation
BEFORE UPDATE OR DELETE ON "audit_logs"
FOR EACH ROW EXECUTE FUNCTION audit_logs_append_only();

CREATE OR REPLACE FUNCTION audit_logs_block_truncate() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_logs is append-only — the table cannot be truncated'
    USING ERRCODE = 'restrict_violation';
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS audit_logs_no_truncate ON "audit_logs";
CREATE TRIGGER audit_logs_no_truncate
BEFORE TRUNCATE ON "audit_logs"
FOR EACH STATEMENT EXECUTE FUNCTION audit_logs_block_truncate();
