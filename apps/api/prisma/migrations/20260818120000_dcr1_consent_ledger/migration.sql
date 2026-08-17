-- [DCR-1 NR-1] The consent ledger: hash-anchored, append-only.
CREATE TABLE "legal_documents" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "documentType" TEXT NOT NULL,
  "version" TEXT NOT NULL,
  "locale" TEXT NOT NULL DEFAULT 'en-GY',
  "contentHash" TEXT NOT NULL,
  "publishedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "legal_documents_type_version_locale_key"
  ON "legal_documents"("documentType", "version", "locale");

CREATE TABLE "consent_records" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "subjectType" TEXT NOT NULL,
  "subjectId" TEXT NOT NULL,
  "documentType" TEXT NOT NULL,
  "documentVersion" TEXT NOT NULL,
  "documentContentHash" TEXT NOT NULL,
  "action" TEXT NOT NULL,
  "surface" TEXT NOT NULL,
  "locale" TEXT NOT NULL DEFAULT 'en-GY',
  "capturedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "ipHmac" TEXT,
  "appVersion" TEXT,
  "evidence" JSONB NOT NULL DEFAULT '{}'
);
CREATE INDEX "consent_records_subject_doc_time_idx"
  ON "consent_records"("subjectType", "subjectId", "documentType", "capturedAt");

-- INV-NR1c: append-only under privilege. Belt (revoke) AND suspenders (trigger):
-- a withdrawal is a NEW ROW, never an update. Applies to every role, including
-- the migration/service role, so a future "quick fix" cannot rewrite consent history.
REVOKE UPDATE, DELETE ON "consent_records" FROM PUBLIC;
CREATE OR REPLACE FUNCTION consent_records_block_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'consent_records is append-only (DCR-1 NR-1). Withdrawals are new rows.';
END; $$ LANGUAGE plpgsql;
CREATE TRIGGER consent_records_no_mutation
  BEFORE UPDATE OR DELETE ON "consent_records"
  FOR EACH ROW EXECUTE FUNCTION consent_records_block_mutation();

-- Current-state view: the latest action per (subject, document type).
CREATE VIEW "consent_current" AS
SELECT DISTINCT ON ("subjectType", "subjectId", "documentType")
       "subjectType", "subjectId", "documentType", "documentVersion", "action", "capturedAt"
FROM "consent_records"
ORDER BY "subjectType", "subjectId", "documentType", "capturedAt" DESC;
