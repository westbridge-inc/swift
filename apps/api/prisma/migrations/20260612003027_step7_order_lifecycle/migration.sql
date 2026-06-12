-- AlterTable
ALTER TABLE "orders" ADD COLUMN     "appointmentSlot" TIMESTAMP(3),
ADD COLUMN     "fulfillment" "FulfillmentType" NOT NULL DEFAULT 'DELIVERY',
ADD COLUMN     "riskFlagged" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "riskReason" TEXT;

