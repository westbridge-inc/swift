-- [BUG-HUNT F23 · COORD 4 Nov 2026] A partner's last paper waits for ordering day (verification/approval-brake.ts). The
-- reviewer has checked it; the marker says who and when, so nobody checks it twice. Staff-only, never shown to the
-- applicant. EXPAND only: two nullable columns on verification_documents.
--
-- FORWARD
--  1. verification_documents."approvalHeldAt": when a reviewer's approval was held.
--  2. verification_documents."approvalHeldBy": the reviewer.
--
-- ROLLBACK: rollback.sql beside this file (drops both; roll the application back first).
SET lock_timeout = '10s';

ALTER TABLE "verification_documents" ADD COLUMN IF NOT EXISTS "approvalHeldAt" TIMESTAMP(3);
ALTER TABLE "verification_documents" ADD COLUMN IF NOT EXISTS "approvalHeldBy" TEXT;
