-- [DOC-1 §18.3 · P18-2] Documents control what can be sold. A gate names a category
-- (by slug, or by kind for a family) in a country and the document type a vendor
-- must hold VALID to list in it; BLOCK_ORDER also fails the order at checkout.
-- Country-keyed registry data, like doc_type; seeded at boot from doc-registry.ts.

-- CreateEnum
CREATE TYPE "GateEnforcement" AS ENUM ('BLOCK_LISTING', 'BLOCK_ORDER', 'WARN');

-- CreateTable
CREATE TABLE "category_document_gate" (
    "code" TEXT NOT NULL,
    "countryCode" CHAR(2) NOT NULL,
    "categorySlug" TEXT,
    "categoryKind" "DiscoveryCategoryKind",
    "requiredDocTypeCode" TEXT NOT NULL,
    "requiredField" TEXT,
    "requiredValues" TEXT[],
    "enforcement" "GateEnforcement" NOT NULL,
    "enforcedFrom" TIMESTAMP(3),
    "note" TEXT,

    CONSTRAINT "category_document_gate_pkey" PRIMARY KEY ("code")
);

-- CreateIndex
CREATE INDEX "category_document_gate_countryCode_idx" ON "category_document_gate"("countryCode");

-- AddForeignKey
ALTER TABLE "category_document_gate" ADD CONSTRAINT "category_document_gate_requiredDocTypeCode_fkey" FOREIGN KEY ("requiredDocTypeCode") REFERENCES "doc_type"("code") ON DELETE RESTRICT ON UPDATE CASCADE;
