-- Dispatch search journal (availability spec §3) — additive, beside the state machines
CREATE TABLE "dispatch_searches" (
    "id" TEXT NOT NULL,
    "vertical" TEXT NOT NULL,
    "subjectType" TEXT NOT NULL DEFAULT 'ORDER',
    "subjectId" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "wave" INTEGER NOT NULL DEFAULT 1,
    "radiusKm" DOUBLE PRECISION NOT NULL,
    "candidatesTried" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "assignedAt" TIMESTAMP(3),
    "assignedTo" TEXT,
    "exhaustedAt" TIMESTAMP(3),
    "resolution" TEXT,
    CONSTRAINT "dispatch_searches_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "dispatch_searches_status_startedAt_idx" ON "dispatch_searches"("status", "startedAt");
CREATE INDEX "dispatch_searches_subjectId_idx" ON "dispatch_searches"("subjectId");
