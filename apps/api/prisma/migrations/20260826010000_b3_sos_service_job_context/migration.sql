-- [B3] SOS from a service job — the last two uncovered surfaces.
--
-- The safety engine authorised the customer, driver or rider ON AN ORDER, and
-- a ServiceJob is not an order — so a hired professional in a stranger's home
-- (or the customer they visit) had no emergency path at all. The alert row
-- gains a loose service-job reference, exactly like orderId: nullable, no FK,
-- because the alert must survive whatever later happens to the job row.
-- Exactly one of orderId / serviceJobId is set by the route; both null stays
-- the context-free panic. Additive only.

ALTER TABLE "SosAlert" ADD COLUMN "serviceJobId" TEXT;

-- Ops lookup: every alert raised on this job.
CREATE INDEX "SosAlert_serviceJobId_idx" ON "SosAlert"("serviceJobId");
