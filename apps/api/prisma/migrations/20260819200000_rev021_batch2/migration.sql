-- [REPORT-021 batch 2]
-- F-021-14: a typo'd retention window must not become an erase-everything
-- cutoff — floor it at the database.
ALTER TABLE "retention_policies"
  ADD CONSTRAINT "retention_policies_min_window" CHECK ("retainDays" >= 7);

-- F-021-20: the sweep's cutoff scans get real indexes.
CREATE INDEX IF NOT EXISTS "sessions_expiresAt_idx" ON "sessions"("expiresAt");
CREATE INDEX IF NOT EXISTS "signup_attempts_createdAt_idx" ON "signup_attempts"("createdAt");
CREATE INDEX IF NOT EXISTS "notifications_createdAt_idx" ON "notifications"("createdAt");

-- F-021-24: the document side of the hash anchor becomes evidence-grade —
-- store the exact words, and make published rows immutable (text/hash can
-- never change; deletion is denied outright).
ALTER TABLE "legal_documents" ADD COLUMN "renderedText" TEXT;
CREATE OR REPLACE FUNCTION legal_documents_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'legal_documents rows are permanent evidence (DCR-1 NR-1).';
  END IF;
  IF OLD."publishedAt" IS NOT NULL AND (
       NEW."contentHash" IS DISTINCT FROM OLD."contentHash"
    OR NEW."documentType" IS DISTINCT FROM OLD."documentType"
    OR NEW."version"      IS DISTINCT FROM OLD."version"
    OR NEW."locale"       IS DISTINCT FROM OLD."locale"
    OR (OLD."renderedText" IS NOT NULL AND NEW."renderedText" IS DISTINCT FROM OLD."renderedText")
  ) THEN
    RAISE EXCEPTION 'published legal_documents are immutable (DCR-1 NR-1): publish a NEW version.';
  END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS legal_documents_immutable ON "legal_documents";
CREATE TRIGGER legal_documents_immutable
  BEFORE UPDATE OR DELETE ON "legal_documents"
  FOR EACH ROW EXECUTE FUNCTION legal_documents_guard();
