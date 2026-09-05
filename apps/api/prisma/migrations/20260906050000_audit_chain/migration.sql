-- [DOC-1 §20.1 · P20-1] The tamper-evident audit chain (DOC-INV-35).
--
-- One append-only, hash-chained sequence for the whole platform: digests of
-- audit-bearing writes (audit_logs, review_decision, deletion_receipt), never
-- the bodies. Appended by AFTER INSERT triggers through audit_chain_append(),
-- which serialises on an advisory lock so prev_hash is never stale; UPDATE,
-- DELETE and TRUNCATE are refused. The daily head lives in its own append-only
-- table. Function and trigger text mirrors src/lib/audit-chain.ts.

-- CreateTable
CREATE TABLE "audit_chain" (
    "seq" BIGSERIAL NOT NULL,
    "occurredAt" TIMESTAMPTZ(3) NOT NULL,
    "actorId" TEXT,
    "actorRole" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "subjectRef" TEXT,
    "submissionRef" TEXT,
    "payloadDigest" BYTEA NOT NULL,
    "prevHash" BYTEA NOT NULL,
    "entryHash" BYTEA NOT NULL,

    CONSTRAINT "audit_chain_pkey" PRIMARY KEY ("seq")
);

-- CreateTable
CREATE TABLE "audit_chain_anchor" (
    "id" BIGSERIAL NOT NULL,
    "headSeq" BIGINT NOT NULL,
    "headHash" BYTEA NOT NULL,
    "verified" BOOLEAN NOT NULL,
    "anchoredAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_chain_anchor_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "audit_chain_occurredAt_idx" ON "audit_chain"("occurredAt");

-- CreateIndex
CREATE INDEX "audit_chain_submissionRef_idx" ON "audit_chain"("submissionRef");

-- The chain itself: append function, append-only guards, and the three sources.
-- Text generated from src/lib/audit-chain.ts (auditChainDdl).
CREATE OR REPLACE FUNCTION audit_chain_append_only() RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION 'audit_chain is append-only — % refused [DOC-INV-35]', TG_OP USING ERRCODE = 'restrict_violation';
      END $$ LANGUAGE plpgsql;
CREATE OR REPLACE FUNCTION audit_chain_append(p_actor_id text, p_actor_role text, p_event_type text, p_subject_ref text, p_submission_ref text, p_payload_digest bytea) RETURNS bigint AS $$
      DECLARE v_prev bytea; v_seq bigint; v_at timestamptz; v_entry bytea;
      BEGIN
        PERFORM pg_advisory_xact_lock(7741990020);
        SELECT "entryHash" INTO v_prev FROM audit_chain ORDER BY seq DESC LIMIT 1;
        IF v_prev IS NULL THEN v_prev := decode(repeat('00', 32), 'hex'); END IF;
        v_seq := nextval('audit_chain_seq_seq');
        v_at := date_trunc('milliseconds', clock_timestamp());
        v_entry := sha256(v_prev || convert_to(v_seq::text, 'UTF8') || convert_to(to_char(v_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'), 'UTF8') || p_payload_digest);
        INSERT INTO audit_chain (seq, "occurredAt", "actorId", "actorRole", "eventType", "subjectRef", "submissionRef", "payloadDigest", "prevHash", "entryHash")
        VALUES (v_seq, v_at, p_actor_id, p_actor_role, p_event_type, p_subject_ref, p_submission_ref, p_payload_digest, v_prev, v_entry);
        RETURN v_seq;
      END $$ LANGUAGE plpgsql;
CREATE OR REPLACE FUNCTION audit_chain_from_audit_logs() RETURNS trigger AS $$
      BEGIN
        PERFORM audit_chain_append(
          NEW."userId",
          CASE WHEN NEW.action LIKE 'KYC_AUTO%' OR NEW.action = 'VERIFICATION_SUBMIT' THEN 'SYSTEM' ELSE 'ADMIN' END,
          NEW.action,
          NEW."entityId",
          CASE WHEN NEW.entity = 'VerificationDocument' THEN NEW."entityId" ELSE NULL END,
          sha256(convert_to(row_to_json(NEW)::text, 'UTF8')));
        RETURN NEW;
      END $$ LANGUAGE plpgsql;
CREATE OR REPLACE FUNCTION audit_chain_from_review_decision() RETURNS trigger AS $$
      BEGIN
        PERFORM audit_chain_append(
          NEW."reviewerId", 'REVIEWER', 'REVIEW_DECISION_' || NEW.outcome::text, NULL,
          (SELECT "submissionId" FROM review_case WHERE id = NEW."caseId"),
          sha256(convert_to(row_to_json(NEW)::text, 'UTF8')));
        RETURN NEW;
      END $$ LANGUAGE plpgsql;
CREATE OR REPLACE FUNCTION audit_chain_from_deletion_receipt() RETURNS trigger AS $$
      BEGIN
        PERFORM audit_chain_append(
          NEW."deletedBy", 'REAPER', 'DELETION_RECEIPT', NEW."subjectId", NEW."submissionId",
          sha256(convert_to(row_to_json(NEW)::text, 'UTF8')));
        RETURN NEW;
      END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS audit_chain_no_mutation ON audit_chain;
CREATE TRIGGER audit_chain_no_mutation BEFORE UPDATE OR DELETE ON audit_chain FOR EACH ROW EXECUTE FUNCTION audit_chain_append_only();
DROP TRIGGER IF EXISTS audit_chain_no_truncate ON audit_chain;
CREATE TRIGGER audit_chain_no_truncate BEFORE TRUNCATE ON audit_chain FOR EACH STATEMENT EXECUTE FUNCTION audit_chain_append_only();
DROP TRIGGER IF EXISTS audit_chain_anchor_no_mutation ON audit_chain_anchor;
CREATE TRIGGER audit_chain_anchor_no_mutation BEFORE UPDATE OR DELETE ON audit_chain_anchor FOR EACH ROW EXECUTE FUNCTION audit_chain_append_only();
DROP TRIGGER IF EXISTS audit_logs_to_chain ON audit_logs;
CREATE TRIGGER audit_logs_to_chain AFTER INSERT ON audit_logs FOR EACH ROW EXECUTE FUNCTION audit_chain_from_audit_logs();
DROP TRIGGER IF EXISTS review_decision_to_chain ON review_decision;
CREATE TRIGGER review_decision_to_chain AFTER INSERT ON review_decision FOR EACH ROW EXECUTE FUNCTION audit_chain_from_review_decision();
DROP TRIGGER IF EXISTS deletion_receipt_to_chain ON deletion_receipt;
CREATE TRIGGER deletion_receipt_to_chain AFTER INSERT ON deletion_receipt FOR EACH ROW EXECUTE FUNCTION audit_chain_from_deletion_receipt();
