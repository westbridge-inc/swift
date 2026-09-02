-- [M-29] The guarantee claim may belong to a driver: a cash ride's fare
-- outcome at the destination runs on the same rail as the rider's handover at
-- the door. riderId becomes optional, driverId is added, and exactly one of
-- them names the mover. Additive; existing rows keep their rider.
SET lock_timeout = '10s';

ALTER TABLE "reimbursement_claims" ALTER COLUMN "riderId" DROP NOT NULL;
ALTER TABLE "reimbursement_claims" ADD COLUMN "driverId" TEXT;
CREATE INDEX "reimbursement_claims_driverId_idx" ON "reimbursement_claims"("driverId");
ALTER TABLE "reimbursement_claims"
  ADD CONSTRAINT "reimbursement_claims_one_mover_check"
  CHECK (("riderId" IS NOT NULL) <> ("driverId" IS NOT NULL));
