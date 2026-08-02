-- CreateEnum
CREATE TYPE "IdentitySignalType" AS ENUM ('ID_DOC_NUMBER', 'TIN', 'BUSINESS_REG', 'PLATE', 'MMG_PAYER', 'FACE_EMBEDDING', 'PHONE', 'DEVICE', 'IP_SUBNET', 'ADDRESS', 'NAME_DOB', 'EMAIL');

-- CreateEnum
CREATE TYPE "SignalStrength" AS ENUM ('HARD', 'STRONG', 'SOFT');

-- CreateEnum
CREATE TYPE "TrialGrantStatus" AS ENUM ('ACTIVE', 'CONSUMED', 'REVOKED');

-- CreateEnum
CREATE TYPE "EnforcementLevel" AS ENUM ('NONE', 'DENY_TRIAL', 'REVIEW_FIRST', 'BLOCK_PENDING_FOUNDER');

-- CreateEnum
CREATE TYPE "AppealStatus" AS ENUM ('NONE', 'OPEN', 'UPHELD', 'OVERTURNED');

-- CreateTable
CREATE TABLE "identity_keys" (
    "id" TEXT NOT NULL,
    "type" "IdentitySignalType" NOT NULL,
    "valueHash" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL DEFAULT 'swift-default',
    "actorRole" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "capturedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "identity_keys_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "identity_clusters" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "mergedIntoId" TEXT,

    CONSTRAINT "identity_clusters_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "identity_cluster_members" (
    "accountId" TEXT NOT NULL,
    "clusterId" TEXT NOT NULL,
    "linkedVia" JSONB NOT NULL,
    "addedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "identity_cluster_members_pkey" PRIMARY KEY ("accountId")
);

-- CreateTable
CREATE TABLE "face_templates" (
    "accountId" TEXT NOT NULL,
    "embedding" BYTEA NOT NULL,
    "modelVer" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "face_templates_pkey" PRIMARY KEY ("accountId")
);

-- CreateTable
CREATE TABLE "trial_grants" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL DEFAULT 'swift-default',
    "clusterId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "status" "TrialGrantStatus" NOT NULL DEFAULT 'ACTIVE',
    "startedAt" TIMESTAMP(3) NOT NULL,
    "endsAt" TIMESTAMP(3) NOT NULL,
    "statusReason" TEXT,

    CONSTRAINT "trial_grants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "enforcement_actions" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "clusterId" TEXT,
    "level" "EnforcementLevel" NOT NULL,
    "reasonCode" TEXT NOT NULL,
    "signalsFired" JSONB NOT NULL,
    "decidedBy" TEXT NOT NULL,
    "appeal" "AppealStatus" NOT NULL DEFAULT 'NONE',
    "appealNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "enforcement_actions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "exception_grants" (
    "id" TEXT NOT NULL,
    "clusterId" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "note" TEXT NOT NULL,
    "grantedBy" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "exception_grants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "signup_attempts" (
    "id" TEXT NOT NULL,
    "phoneHash" TEXT,
    "deviceHash" TEXT,
    "ipHash" TEXT,
    "outcome" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "signup_attempts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "integrity_settings" (
    "id" TEXT NOT NULL DEFAULT 'platform',
    "maxSignupsPerDevice24h" INTEGER NOT NULL DEFAULT 3,
    "maxOtpPerPhonePerHour" INTEGER NOT NULL DEFAULT 5,
    "ipFlagThreshold24h" INTEGER NOT NULL DEFAULT 15,
    "faceLinkCosine" DECIMAL(4,3) NOT NULL DEFAULT 0.92,
    "faceFlagCosine" DECIMAL(4,3) NOT NULL DEFAULT 0.85,
    "retroRevokeNoticeHours" INTEGER NOT NULL DEFAULT 48,
    "tombstoneRetentionEnabled" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "integrity_settings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "identity_keys_type_valueHash_idx" ON "identity_keys"("type", "valueHash");

-- CreateIndex
CREATE INDEX "identity_keys_accountId_idx" ON "identity_keys"("accountId");

-- CreateIndex
CREATE INDEX "identity_cluster_members_clusterId_idx" ON "identity_cluster_members"("clusterId");

-- CreateIndex
CREATE INDEX "trial_grants_accountId_idx" ON "trial_grants"("accountId");

-- CreateIndex
CREATE INDEX "trial_grants_tenantId_clusterId_role_idx" ON "trial_grants"("tenantId", "clusterId", "role");

-- CreateIndex
CREATE INDEX "enforcement_actions_accountId_idx" ON "enforcement_actions"("accountId");

-- CreateIndex
CREATE INDEX "enforcement_actions_level_createdAt_idx" ON "enforcement_actions"("level", "createdAt");

-- CreateIndex
CREATE INDEX "exception_grants_clusterId_idx" ON "exception_grants"("clusterId");

-- CreateIndex
CREATE INDEX "signup_attempts_deviceHash_createdAt_idx" ON "signup_attempts"("deviceHash", "createdAt");

-- CreateIndex
CREATE INDEX "signup_attempts_ipHash_createdAt_idx" ON "signup_attempts"("ipHash", "createdAt");

-- CreateIndex
CREATE INDEX "signup_attempts_phoneHash_createdAt_idx" ON "signup_attempts"("phoneHash", "createdAt");

-- AddForeignKey
ALTER TABLE "identity_cluster_members" ADD CONSTRAINT "identity_cluster_members_clusterId_fkey" FOREIGN KEY ("clusterId") REFERENCES "identity_clusters"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trial_grants" ADD CONSTRAINT "trial_grants_clusterId_fkey" FOREIGN KEY ("clusterId") REFERENCES "identity_clusters"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ★ The race guard: at most ONE ACTIVE grant per (tenant, cluster, role).
-- Partial by design — CONSUMED/REVOKED history coexists after retroactive
-- cluster unions (§3.4). NB raw DDL is invisible to `prisma db push`; tests
-- self-install this index idempotently (the established CI pattern).
CREATE UNIQUE INDEX IF NOT EXISTS "trial_grants_one_active"
  ON "trial_grants" ("tenantId", "clusterId", "role") WHERE status = 'ACTIVE';
