-- CreateEnum
CREATE TYPE "ComplianceReviewStatus" AS ENUM ('OPEN', 'PASSED', 'FAILED');

-- CreateTable
CREATE TABLE "compliance_audit_runs" (
    "id" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "moversChecked" INTEGER NOT NULL DEFAULT 0,
    "violations" INTEGER NOT NULL DEFAULT 0,
    "trigger" TEXT NOT NULL DEFAULT 'SCHEDULED',

    CONSTRAINT "compliance_audit_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "compliance_violations" (
    "id" TEXT NOT NULL,
    "runId" TEXT,
    "userId" TEXT NOT NULL,
    "moverKind" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "evidence" JSONB NOT NULL,
    "actionTaken" TEXT NOT NULL DEFAULT 'FORCED_OFFLINE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "compliance_violations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "compliance_review_cases" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "status" "ComplianceReviewStatus" NOT NULL DEFAULT 'OPEN',
    "dueAt" TIMESTAMP(3) NOT NULL,
    "decidedBy" TEXT,
    "decidedAt" TIMESTAMP(3),
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "compliance_review_cases_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "compliance_audit_runs_startedAt_idx" ON "compliance_audit_runs"("startedAt");

-- CreateIndex
CREATE INDEX "compliance_violations_userId_idx" ON "compliance_violations"("userId");

-- CreateIndex
CREATE INDEX "compliance_violations_createdAt_idx" ON "compliance_violations"("createdAt");

-- CreateIndex
CREATE INDEX "compliance_violations_resolvedAt_idx" ON "compliance_violations"("resolvedAt");

-- CreateIndex
CREATE INDEX "compliance_review_cases_status_idx" ON "compliance_review_cases"("status");

-- CreateIndex
CREATE INDEX "compliance_review_cases_userId_idx" ON "compliance_review_cases"("userId");

-- AddForeignKey
ALTER TABLE "compliance_violations" ADD CONSTRAINT "compliance_violations_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "compliance_review_cases" ADD CONSTRAINT "compliance_review_cases_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

