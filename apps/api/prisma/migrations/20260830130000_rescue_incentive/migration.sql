-- [ALG-06 / ALG-INV-19] A rescue incentive is Swift's own money, recorded as
-- an earning of its own type so the rider's sentence can say so.
ALTER TYPE "EarningType" ADD VALUE 'RESCUE_INCENTIVE';
