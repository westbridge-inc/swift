-- [DS110-13] TWO-PERSON APPROVAL MUST NOT BE BLIND.
--
-- PrivilegedApproval stored what was asked as a fingerprint only: the method,
-- route, params and body were hashed but never kept, so the approving admin saw
-- an opaque id and a reason with no amount or beneficiary — and nothing could
-- later re-execute the reviewed request. This column persists a canonical
-- `{ params, body, query }` copy of the request beside its fingerprint. The approvals
-- screen renders it, and the new POST /approvals/:id/apply replays it, so the
-- body that executes is the body that was displayed, bound by the fingerprint.
--
-- Additive and nullable: rows raised before this migration carry no snapshot,
-- keep their PENDING/APPROVED/REJECTED/APPLIED state unchanged, and simply
-- cannot be applied (their body was never stored).
SET lock_timeout = '10s';
ALTER TABLE "privileged_approvals" ADD COLUMN "bodySnapshot" JSONB;
