-- [DOC-1 §7.1 · P7-1] The validator registry — data, not code. implRef names the
-- implementation resolved at boot; NULL = declared by the spec, not yet implemented,
-- and no ACTIVE document type may depend on it (DOC-INV-2). Global registry data,
-- like doc_type; seeded at boot from doc-registry.ts.

-- CreateEnum
CREATE TYPE "ValidatorScope" AS ENUM ('FIELD', 'DOCUMENT', 'SUBJECT', 'CROSS_SUBJECT');

-- CreateTable
CREATE TABLE "validator" (
    "code" TEXT NOT NULL,
    "docTypeCode" TEXT,
    "scope" "ValidatorScope" NOT NULL,
    "isBlocking" BOOLEAN NOT NULL,
    "detailCode" TEXT NOT NULL,
    "implRef" TEXT,

    CONSTRAINT "validator_pkey" PRIMARY KEY ("code")
);

-- CreateIndex
CREATE INDEX "validator_docTypeCode_idx" ON "validator"("docTypeCode");

-- AddForeignKey
ALTER TABLE "validator" ADD CONSTRAINT "validator_docTypeCode_fkey" FOREIGN KEY ("docTypeCode") REFERENCES "doc_type"("code") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "doc_field" ADD CONSTRAINT "doc_field_validatorRef_fkey" FOREIGN KEY ("validatorRef") REFERENCES "validator"("code") ON DELETE SET NULL ON UPDATE CASCADE;
