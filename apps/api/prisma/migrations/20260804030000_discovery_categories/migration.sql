-- CreateEnum
CREATE TYPE "DiscoveryCategoryKind" AS ENUM ('CUISINE', 'DISH', 'DIETARY', 'AISLE', 'RETAIL');

-- CreateEnum
CREATE TYPE "DiscoveryCategoryStatus" AS ENUM ('ACTIVE', 'HIDDEN', 'MERGED', 'PENDING');

-- CreateEnum
CREATE TYPE "DiscoveryCategoryVertical" AS ENUM ('FOOD', 'GROCERY', 'RETAIL');

-- CreateEnum
CREATE TYPE "DiscoveryTagSource" AS ENUM ('VENDOR', 'AUTO', 'ADMIN', 'DERIVED');

-- CreateTable
CREATE TABLE "discovery_categories" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL DEFAULT 'swift-default',
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" "DiscoveryCategoryKind" NOT NULL,
    "vertical" "DiscoveryCategoryVertical" NOT NULL,
    "emoji" TEXT NOT NULL,
    "iconKey" TEXT,
    "aliases" TEXT[],
    "sortWeight" INTEGER NOT NULL DEFAULT 100,
    "status" "DiscoveryCategoryStatus" NOT NULL DEFAULT 'ACTIVE',
    "isSeed" BOOLEAN NOT NULL DEFAULT false,
    "mergedIntoId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "discovery_categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vendor_discovery_categories" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL DEFAULT 'swift-default',
    "vendorId" TEXT NOT NULL,
    "categoryId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "source" "DiscoveryTagSource" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "vendor_discovery_categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "item_discovery_categories" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL DEFAULT 'swift-default',
    "itemId" TEXT NOT NULL,
    "categoryId" TEXT NOT NULL,
    "source" "DiscoveryTagSource" NOT NULL,
    "confidence" DECIMAL(3,2),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "item_discovery_categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "discovery_category_suggestions" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL DEFAULT 'swift-default',
    "itemId" TEXT NOT NULL,
    "categoryId" TEXT NOT NULL,
    "confidence" DECIMAL(3,2) NOT NULL,
    "stage" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "discovery_category_suggestions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "discovery_category_requests" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL DEFAULT 'swift-default',
    "vendorId" TEXT NOT NULL,
    "proposedName" TEXT NOT NULL,
    "note" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "resolvedCategoryId" TEXT,
    "resolvedBy" TEXT,
    "resolvedNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "discovery_category_requests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "discovery_categories_tenantId_status_vertical_sortWeight_idx" ON "discovery_categories"("tenantId", "status", "vertical", "sortWeight");

-- CreateIndex
CREATE UNIQUE INDEX "discovery_categories_tenantId_slug_key" ON "discovery_categories"("tenantId", "slug");

-- CreateIndex
CREATE INDEX "vendor_discovery_categories_tenantId_categoryId_idx" ON "vendor_discovery_categories"("tenantId", "categoryId");

-- CreateIndex
CREATE UNIQUE INDEX "vendor_discovery_categories_vendorId_categoryId_key" ON "vendor_discovery_categories"("vendorId", "categoryId");

-- CreateIndex
CREATE INDEX "item_discovery_categories_tenantId_categoryId_idx" ON "item_discovery_categories"("tenantId", "categoryId");

-- CreateIndex
CREATE UNIQUE INDEX "item_discovery_categories_itemId_categoryId_key" ON "item_discovery_categories"("itemId", "categoryId");

-- CreateIndex
CREATE INDEX "discovery_category_suggestions_tenantId_itemId_status_idx" ON "discovery_category_suggestions"("tenantId", "itemId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "discovery_category_suggestions_itemId_categoryId_key" ON "discovery_category_suggestions"("itemId", "categoryId");

-- CreateIndex
CREATE INDEX "discovery_category_requests_tenantId_status_idx" ON "discovery_category_requests"("tenantId", "status");


-- One PRIMARY store category per vendor — the identity-pick race guard.
-- Partial by design; Prisma can't express it; tests self-install (pattern).
CREATE UNIQUE INDEX IF NOT EXISTS "one_primary_discovery_category_per_vendor"
  ON "vendor_discovery_categories"("vendorId") WHERE role = 'PRIMARY';
