-- CreateTable
CREATE TABLE "booking_exceptions" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL DEFAULT 'swift-default',
    "itemId" TEXT,
    "vendorId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "start" TEXT,
    "end" TEXT,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "booking_exceptions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "booking_exceptions_vendorId_date_idx" ON "booking_exceptions"("vendorId", "date");

