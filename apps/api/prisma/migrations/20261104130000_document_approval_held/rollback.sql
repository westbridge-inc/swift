-- [BUG-HUNT F23] Rollback of 20261104130000_document_approval_held: roll the application back first (it writes these).
SET lock_timeout = '10s';
ALTER TABLE "verification_documents" DROP COLUMN IF EXISTS "approvalHeldBy";
ALTER TABLE "verification_documents" DROP COLUMN IF EXISTS "approvalHeldAt";
