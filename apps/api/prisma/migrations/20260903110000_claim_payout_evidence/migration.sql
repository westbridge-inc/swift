-- [A-11] A claim payout is a REAL transfer to a claimant on a manual rail, and
-- it was closed by one person typing a reference. Nothing checked that the
-- reference had not already been used, and nothing bound the payment to the
-- claim's amount.
--
-- The reference becomes the evidence it was always described as: UNIQUE, so one
-- bank/MMG reference settles one claim. Nullable, so the many unpaid claims do
-- not collide with each other.
ALTER TABLE "reimbursement_claims" ADD COLUMN "paidAmount" DECIMAL(12,2);
ALTER TABLE "reimbursement_claims" ADD COLUMN "paidById" TEXT;

-- Existing PAID rows keep their reference. If any duplicate references already
-- exist this index build FAILS, and that is the correct outcome: it means two
-- claims were closed against one payment and a person must decide which is real.
CREATE UNIQUE INDEX "reimbursement_claims_paymentRef_key" ON "reimbursement_claims"("paymentRef");
