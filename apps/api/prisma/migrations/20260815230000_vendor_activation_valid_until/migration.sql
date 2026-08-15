-- [REPORT-013 F-013-06] Wall-clock bound of the vendor's document authority,
-- maintained by the activation projection; bound at checkout in-transaction.
ALTER TABLE "vendors" ADD COLUMN "activationValidUntil" TIMESTAMP(3);
