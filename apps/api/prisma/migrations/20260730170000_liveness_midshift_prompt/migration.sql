-- AlterTable
ALTER TABLE "drivers" ADD COLUMN     "livenessPromptDeadlineAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "riders" ADD COLUMN     "livenessPromptDeadlineAt" TIMESTAMP(3);

