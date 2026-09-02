-- [S-05] Fixed unpaginated safety sweeps can starve people forever.
-- A persisted keyset cursor per sweep work type, with the poison rows.
CREATE TABLE "sweep_cursors" (
    "workType" TEXT NOT NULL,
    "cursorId" TEXT,
    "passStartedAt" TIMESTAMP(3),
    "passCompletedAt" TIMESTAMP(3),
    "passesCompleted" INTEGER NOT NULL DEFAULT 0,
    "lastPassVisited" INTEGER NOT NULL DEFAULT 0,
    "lastPassFailed" INTEGER NOT NULL DEFAULT 0,
    "lastPageAt" TIMESTAMP(3),
    "lastPageSize" INTEGER NOT NULL DEFAULT 0,
    "poison" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "sweep_cursors_pkey" PRIMARY KEY ("workType")
);
