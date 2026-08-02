-- AlterTable
ALTER TABLE "subscriptions" ADD COLUMN     "san" CHAR(10),
ADD COLUMN     "sanAssignedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "san_tombstones" (
    "san" CHAR(10) NOT NULL,
    "subscriptionId" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL DEFAULT 'swift-default',
    "reason" TEXT,
    "releasedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "san_tombstones_pkey" PRIMARY KEY ("san")
);

-- CreateIndex
CREATE UNIQUE INDEX "subscriptions_san_key" ON "subscriptions"("san");


-- Raw SQL Prisma can't express [san spec 2.5]: the format law at the database.
-- (Diff-invisible to the replay gate by design — tests self-install where needed.)
ALTER TABLE "subscriptions" ADD CONSTRAINT san_format
  CHECK (san IS NULL OR san ~ '^[1-9][0-9]{9}$');
ALTER TABLE "san_tombstones" ADD CONSTRAINT san_tombstone_format
  CHECK (san ~ '^[1-9][0-9]{9}$');
