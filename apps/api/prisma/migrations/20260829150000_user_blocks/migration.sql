-- [STORE-002] The block leg of App Store Guideline 1.2 / Google Play UGC.
--
-- Swift carries user-generated content — reviews, ratings, item feedback, chat,
-- store copy — and shipped a content filter, a report door and a published
-- contact. It had no way to block anyone. A person could report a rider for
-- harassment and be matched with them again the same evening.
--
-- ADDITIVE ONLY: one new table. Nothing reads it until the service does, and
-- an EMPTY TABLE BEHAVES EXACTLY AS TODAY.

-- [F-021-25] Bounded lock waits: DDL must never queue unboundedly behind traffic.
SET lock_timeout = '10s';

CREATE TABLE "user_blocks" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL DEFAULT 'swift-default',
    "blockerId" TEXT NOT NULL,
    "blockedId" TEXT NOT NULL,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    -- Separate from "createdAt" because re-blocking REUSES the row: one
    -- timestamp would let the screen date a block placed this morning to the
    -- first time these two ever fell out.
    "blockedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "unblockedAt" TIMESTAMP(3),

    CONSTRAINT "user_blocks_pkey" PRIMARY KEY ("id")
);

-- Blocking yourself is not a coherent request, and a row asserting it would
-- make `contactBlockedUserIds` hand back the caller's own id — which reads, at
-- the dispatch seam, as "this person may not be put in contact with anyone".
-- The route refuses it; the constraint means no other writer can introduce it.
ALTER TABLE "user_blocks"
    ADD CONSTRAINT "user_blocks_not_self" CHECK ("blockerId" <> "blockedId");

-- One row per ordered pair: re-blocking clears "unblockedAt" instead of
-- inserting a second row, so "block someone you already blocked" is idempotent
-- and every read is a single row rather than a latest-of-many.
CREATE UNIQUE INDEX "user_blocks_tenantId_blockerId_blockedId_key"
    ON "user_blocks"("tenantId", "blockerId", "blockedId");

-- "Who have I blocked" — the Blocked people screen.
CREATE INDEX "user_blocks_tenantId_blockerId_unblockedAt_idx"
    ON "user_blocks"("tenantId", "blockerId", "unblockedAt");

-- "May these two be put in contact" — dispatch and chat both ask this, and
-- must ask it in BOTH directions, so the reverse lookup is indexed too.
CREATE INDEX "user_blocks_tenantId_blockedId_unblockedAt_idx"
    ON "user_blocks"("tenantId", "blockedId", "unblockedAt");

-- [ELV-1 W-201] Tenant isolation. The bypass is membership in the
-- swift_bypass_rls ROLE, never the app.bypass_tenant GUC — a GUC is settable
-- by the very role the wall constrains (REPORT-021 F-021-11), which is the
-- defect 20260829140000 had to repair one table over. This DDL is the shape
-- rlsDdlFor() emits; the CI step "Tenant RLS predicate is the role capability,
-- not the GUC" reads it back and fails if it ever drifts again.
ALTER TABLE "user_blocks" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "user_blocks";
CREATE POLICY "tenant_isolation" ON "user_blocks"
      USING (("tenantId" = current_setting('app.current_tenant', true)
      OR pg_has_role(current_user, 'swift_bypass_rls', 'MEMBER')))
      WITH CHECK (("tenantId" = current_setting('app.current_tenant', true)
      OR pg_has_role(current_user, 'swift_bypass_rls', 'MEMBER')));
