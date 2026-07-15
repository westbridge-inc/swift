-- CreateTable
CREATE TABLE "encrypted_objects" (
    "fileKey" TEXT NOT NULL,
    "iv" BYTEA NOT NULL,
    "authTag" BYTEA NOT NULL,
    "wrappedDek" BYTEA,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "shreddedAt" TIMESTAMP(3),

    CONSTRAINT "encrypted_objects_pkey" PRIMARY KEY ("fileKey")
);

