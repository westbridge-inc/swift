-- Phase 5 — Subscription lifecycle: add Retail + Services participant types
-- (spec §1.4 five paying participant types + service providers).

-- AlterEnum
ALTER TYPE "SubscriptionType" ADD VALUE 'RETAIL_STORE';
ALTER TYPE "SubscriptionType" ADD VALUE 'SERVICE_PROVIDER';
