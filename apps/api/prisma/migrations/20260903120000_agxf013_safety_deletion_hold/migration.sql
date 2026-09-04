-- [AG-XF-013] The safety escrow: erasure and a live emergency at the same time.
--
-- Account deletion gated on in-flight orders and service jobs only. A person
-- with a LIVE SOS could erase themselves mid-emergency, taking their verified
-- emergency contacts, their name and their phone number with them — so the
-- queued emergency SMS was skipped as "contact-unverified-or-gone", the ops
-- desk could no longer name or call them, and the all-clear was never sent to
-- the people already told an emergency was happening.
--
-- The deletion still runs in full. Only the minimum response authority is
-- copied here first: encrypted, purpose-declared, owner-scoped, and shredded
-- when the last hold releases or at purgeBy, whichever comes first.

CREATE TYPE "SafetyHoldStatus" AS ENUM ('PENDING', 'RELEASED', 'PURGED');

CREATE TABLE "safety_deletion_holds" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL DEFAULT 'swift-default',
    "userId" TEXT NOT NULL,
    "status" "SafetyHoldStatus" NOT NULL DEFAULT 'PENDING',
    "reasons" TEXT[],
    "holdRefs" JSONB NOT NULL,
    "ciphertext" BYTEA,
    "iv" BYTEA,
    "authTag" BYTEA,
    "dek" BYTEA,
    "dekWrapped" BOOLEAN NOT NULL DEFAULT false,
    "shreddedAt" TIMESTAMP(3),
    "purpose" TEXT NOT NULL,
    "fields" TEXT[],
    "ownerRole" TEXT NOT NULL,
    "reviewBy" TIMESTAMP(3) NOT NULL,
    "purgeBy" TIMESTAMP(3) NOT NULL,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "releasedAt" TIMESTAMP(3),
    "purgedAt" TIMESTAMP(3),
    "purgeGeneration" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "safety_deletion_holds_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "safety_deletion_holds_userId_key" ON "safety_deletion_holds"("userId");
CREATE INDEX "safety_deletion_holds_status_purgeBy_idx" ON "safety_deletion_holds"("status", "purgeBy");
CREATE INDEX "safety_deletion_holds_tenantId_status_idx" ON "safety_deletion_holds"("tenantId", "status");

-- The tenant wall, same predicate as every other tenant table.
ALTER TABLE "safety_deletion_holds" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "safety_deletion_holds";
CREATE POLICY "tenant_isolation" ON "safety_deletion_holds"
  USING (("tenantId" = current_setting('app.current_tenant', true)
      OR pg_has_role(current_user, 'swift_bypass_rls', 'MEMBER')))
  WITH CHECK (("tenantId" = current_setting('app.current_tenant', true)
      OR pg_has_role(current_user, 'swift_bypass_rls', 'MEMBER')));
