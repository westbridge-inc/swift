-- [DOC-1 §4.1–4.2] The document registry — data, not code.
--
-- Four tables: doc_type (one row per market per document class), doc_field,
-- requirement_set (per country, actor role, tier, effective window) and
-- requirement_item. Adding Trinidad, or a new Guyanese document class, is rows.
--
-- Reconciled to this repo (recorded in swift-standard/doc-1):
--   * doc_type.code is `<country>.<legacyCode>` and carries `legacyCode`, the
--     bare checklist key the rest of the system speaks; UNIQUE per country.
--   * extraction_profile is a code without an FK: §4.2 references a table the
--     spec never defines (CONFLICT-DOC-5).
--   * requirement_item.sort_order: the checklist facade must return the
--     published order, which the spec's table cannot express.
--   * The three CHECK constraints below are the spec's, verbatim in meaning.
--     `personal_never_external` states the spec's rule; the founder's recorded
--     default (CONFLICT-DOC-2) sends identity images to the KYC processor, so
--     identity rows are seeded external_processing_allowed = false and stay
--     INACTIVE until that ruling — doc1-hard-limits limit [2] stays pinned.
--
-- Expand only: new tables, no row changes anywhere else.

-- CreateEnum
CREATE TYPE "DocBucket" AS ENUM ('BUSINESS', 'PERSONAL', 'VEHICLE');

-- CreateEnum
CREATE TYPE "DocSubjectKind" AS ENUM ('PERSON', 'BUSINESS', 'VEHICLE');

-- CreateEnum
CREATE TYPE "DocImagePolicy" AS ENUM ('PERSIST', 'PERSIST_REDACTED', 'PURGE_AFTER_REVIEW');

-- CreateEnum
CREATE TYPE "AmlRecordClass" AS ENUM ('NOT_APPLICABLE', 'CDD_IDENTITY', 'CDD_ENTITY', 'TRANSACTION_LINKED');

-- CreateTable
CREATE TABLE "doc_type" (
    "code" TEXT NOT NULL,
    "countryCode" CHAR(2) NOT NULL,
    "legacyCode" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "bucket" "DocBucket" NOT NULL,
    "subjectKind" "DocSubjectKind" NOT NULL,
    "issuer" TEXT NOT NULL,
    "imagePolicy" "DocImagePolicy" NOT NULL,
    "intakeTtlHours" INTEGER NOT NULL DEFAULT 336,
    "persistRetentionDays" INTEGER,
    "amlRecordClass" "AmlRecordClass" NOT NULL DEFAULT 'NOT_APPLICABLE',
    "hasExpiry" BOOLEAN NOT NULL,
    "defaultValidityDays" INTEGER,
    "expirySource" TEXT NOT NULL DEFAULT 'PRINTED',
    "extractionProfile" TEXT NOT NULL,
    "externalProcessingAllowed" BOOLEAN NOT NULL DEFAULT false,
    "localAuthorityVariant" TEXT,
    "minConfidenceAutoApprove" DECIMAL(3,2) NOT NULL DEFAULT 0.97,
    "legalFactsVerifiedAt" DATE,
    "legalFactsSourceNote" TEXT,
    "needsSpecimen" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT false,
    "registryVersion" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "doc_type_pkey" PRIMARY KEY ("code")
);

-- CreateTable
CREATE TABLE "doc_field" (
    "docTypeCode" TEXT NOT NULL,
    "fieldCode" TEXT NOT NULL,
    "dataType" TEXT NOT NULL,
    "isRequired" BOOLEAN NOT NULL,
    "isPii" BOOLEAN NOT NULL,
    "isBlindIndexed" BOOLEAN NOT NULL DEFAULT false,
    "validatorRef" TEXT,
    "enumValues" TEXT[],
    "displayOrder" INTEGER NOT NULL,

    CONSTRAINT "doc_field_pkey" PRIMARY KEY ("docTypeCode","fieldCode")
);

-- CreateTable
CREATE TABLE "requirement_set" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "countryCode" CHAR(2) NOT NULL,
    "actorRole" TEXT NOT NULL,
    "tier" TEXT NOT NULL DEFAULT 'STANDARD',
    "effectiveFrom" DATE NOT NULL,
    "effectiveTo" DATE,

    CONSTRAINT "requirement_set_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "requirement_item" (
    "requirementSetId" UUID NOT NULL,
    "docTypeCode" TEXT NOT NULL,
    "isBlocking" BOOLEAN NOT NULL,
    "minCount" INTEGER NOT NULL DEFAULT 1,
    "conditionExpr" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "requirement_item_pkey" PRIMARY KEY ("requirementSetId","docTypeCode")
);

-- CreateIndex
CREATE INDEX "doc_type_countryCode_isActive_idx" ON "doc_type"("countryCode", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "doc_type_countryCode_legacyCode_key" ON "doc_type"("countryCode", "legacyCode");

-- CreateIndex
CREATE UNIQUE INDEX "requirement_set_countryCode_actorRole_tier_effectiveFrom_key" ON "requirement_set"("countryCode", "actorRole", "tier", "effectiveFrom");

-- AddForeignKey
ALTER TABLE "doc_field" ADD CONSTRAINT "doc_field_docTypeCode_fkey" FOREIGN KEY ("docTypeCode") REFERENCES "doc_type"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "requirement_item" ADD CONSTRAINT "requirement_item_requirementSetId_fkey" FOREIGN KEY ("requirementSetId") REFERENCES "requirement_set"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "requirement_item" ADD CONSTRAINT "requirement_item_docTypeCode_fkey" FOREIGN KEY ("docTypeCode") REFERENCES "doc_type"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- The spec's invariants, held by the database (Prisma cannot express CHECK).
ALTER TABLE "doc_type" ADD CONSTRAINT "persist_needs_retention" CHECK (
  ("imagePolicy" = 'PURGE_AFTER_REVIEW' AND "persistRetentionDays" IS NULL)
  OR ("imagePolicy" <> 'PURGE_AFTER_REVIEW' AND "persistRetentionDays" IS NOT NULL)
);
ALTER TABLE "doc_type" ADD CONSTRAINT "active_needs_legal_facts" CHECK (
  "isActive" = false OR "legalFactsVerifiedAt" IS NOT NULL
);
ALTER TABLE "doc_type" ADD CONSTRAINT "personal_never_external" CHECK (
  "bucket" <> 'PERSONAL' OR "externalProcessingAllowed" = false
);
