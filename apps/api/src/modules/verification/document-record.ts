/**
 * [DOC-1 §4.4 · P4-2] `document_record` — the durable, post-purge truth, KEPT BY THE
 * DATABASE from the state machine (P5-1):
 *   COMMITTED  → a VALID record for the submission (upsert), and any older VALID record
 *                of the same account + type + subject becomes SUPERSEDED, its submission
 *                moving COMMITTED → SUPERSEDED (§22 renewal);
 *   EXPIRED / REVOKED / SUPERSEDED → the record follows.
 * Fires on `status` and `purgedAt` too: a legacy status-driven write (the expiry sweep)
 * changes `state` inside the BEFORE trigger, and UPDATE OF keys on the columns the
 * statement names. No application code writes records. The migration carries this DDL verbatim (the
 * suite asserts the mirror) and backfills every pre-existing approval as a VALID record
 * with a recheck date 90 days out (§10.3: no already-verified actor is suspended).
 */

export const DOCUMENT_RECORD_TRIGGER = 'verification_documents_keep_record';

export function documentRecordDdl(): string[] {
  return [
    `CREATE OR REPLACE FUNCTION verification_documents_keep_record() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_tenant TEXT;
BEGIN
  IF NEW.state = 'COMMITTED' THEN
    SELECT "tenantId" INTO v_tenant FROM users WHERE id = NEW."userId";
    INSERT INTO document_record (id, "tenantId", "accountId", "subjectId", "docType", "submissionId", status, "expiresOn", "approvedBy", "approvedAt", "createdAt", "updatedAt")
    VALUES (gen_random_uuid(), COALESCE(v_tenant, 'swift-default'), NEW."userId", NEW."subjectId", NEW."docType", NEW.id, 'VALID',
            NEW."expiresAt", COALESCE(NEW."reviewedBy", 'system'), COALESCE(NEW."reviewedAt", now()), now(), now())
    ON CONFLICT ("submissionId") DO UPDATE
      SET status = 'VALID', "expiresOn" = EXCLUDED."expiresOn", "subjectId" = EXCLUDED."subjectId", "updatedAt" = now();
    -- A newer commit of the same type, for the same account and subject, supersedes the older
    -- committed submissions (§22); their records follow through this same trigger (one mechanism).
    UPDATE verification_documents SET state = 'SUPERSEDED'
      WHERE "userId" = NEW."userId" AND "docType" = NEW."docType" AND id <> NEW.id
        AND "subjectId" IS NOT DISTINCT FROM NEW."subjectId" AND state = 'COMMITTED';
  ELSIF NEW.state IN ('EXPIRED', 'REVOKED', 'SUPERSEDED') THEN
    UPDATE document_record SET status = NEW.state::text::"DocumentRecordStatus", "updatedAt" = now()
      WHERE "submissionId" = NEW.id AND status <> NEW.state::text::"DocumentRecordStatus";
  END IF;
  RETURN NULL;
END
$$;`,
    `DROP TRIGGER IF EXISTS ${DOCUMENT_RECORD_TRIGGER} ON verification_documents;`,
    `CREATE TRIGGER ${DOCUMENT_RECORD_TRIGGER}
AFTER INSERT OR UPDATE OF state, status, "purgedAt", "expiresAt", "subjectId" ON verification_documents
FOR EACH ROW EXECUTE FUNCTION verification_documents_keep_record();`,
  ];
}

/** §10.3 grandfather: every pre-existing approval carries forward as a record, recheck in 90 days. */
export const DOCUMENT_RECORD_BACKFILL_SQL = `INSERT INTO document_record (id, "tenantId", "accountId", "subjectId", "docType", "submissionId", status, "expiresOn", "recheckBy", "approvedBy", "approvedAt", "createdAt", "updatedAt")
SELECT gen_random_uuid(), u."tenantId", d."userId", d."subjectId", d."docType", d.id,
       (CASE d.state WHEN 'COMMITTED' THEN 'VALID' ELSE d.state::text END)::"DocumentRecordStatus",
       d."expiresAt", now() + interval '90 days', COALESCE(d."reviewedBy", 'system'), COALESCE(d."reviewedAt", d."updatedAt"), now(), now()
FROM verification_documents d JOIN users u ON u.id = d."userId"
WHERE d.state IN ('COMMITTED', 'EXPIRED', 'REVOKED', 'SUPERSEDED')
ON CONFLICT ("submissionId") DO NOTHING;`;
