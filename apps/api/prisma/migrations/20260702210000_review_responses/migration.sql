-- Review responses (master plan §4.1): operators reply to customer reviews.
ALTER TABLE "ratings" ADD COLUMN     "response" TEXT;
ALTER TABLE "ratings" ADD COLUMN     "respondedAt" TIMESTAMP(3);
ALTER TABLE "ratings" ADD COLUMN     "respondedBy" TEXT;
