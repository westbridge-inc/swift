-- Alert delivery tracking (alerts spec §A4)
CREATE TABLE "alert_deliveries" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "subjectId" TEXT NOT NULL,
    "recipientId" TEXT NOT NULL,
    "sentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "acknowledgedAt" TIMESTAMP(3),
    CONSTRAINT "alert_deliveries_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "alert_deliveries_kind_sentAt_idx" ON "alert_deliveries"("kind", "sentAt");
CREATE INDEX "alert_deliveries_subjectId_recipientId_idx" ON "alert_deliveries"("subjectId", "recipientId");
