-- [DGP-1 · CONFLICT-DOC-2 mechanism] A PERSONAL doc type may be marked for external processing only
-- under a RECORDED decision: the reference of the founder's decision (FD-DOC-3b) and the date. The
-- default stays false; the CHECK still refuses "allowed" for a PERSONAL type with no reference.
-- Forward: add the two columns, replace `personal_never_external` with `personal_external_needs_decision`.
-- Rollback: DROP CONSTRAINT personal_external_needs_decision; re-add personal_never_external
--           (fails if any PERSONAL row is allowed=true — revoke first); DROP the two columns.
ALTER TABLE "doc_type" ADD COLUMN "externalProcessingDecisionRef" TEXT;
ALTER TABLE "doc_type" ADD COLUMN "externalProcessingDecidedAt" TIMESTAMP(3);
ALTER TABLE "doc_type" DROP CONSTRAINT "personal_never_external";
ALTER TABLE "doc_type" ADD CONSTRAINT "personal_external_needs_decision" CHECK (
  "bucket" <> 'PERSONAL' OR "externalProcessingAllowed" = false OR "externalProcessingDecisionRef" IS NOT NULL
);
