-- [ENTERPRISE E2 · owner 29 Oct 2026 "just do whats best"; COORD ruling 21:28Z] A chain deal's END date, and
-- "end deal" / "raise deal", through the 14-day fee-change notice (GUARDRAILS s7 standing rule 2): each branch is
-- told in the app at least 14 days ahead, pays the new fee only from its first weekly fee due after that, and a week
-- already paid keeps its price. Never retroactive. Lowering a deal is unchanged (it applies from the next weekly fee).
-- EXPAND only: eight nullable columns on vendor_owners, empty for every existing owner (no change pending).
--
-- FORWARD
--  1. vendor_owners."dealChangeKind" ('END' | 'RAISE'), "dealChangeFrom" (the deal it changes), "dealChangeTo"
--     (RAISE only: the new deal), "dealChangeNotBefore" (the end date: no branch pays the new fee before it),
--     "dealChangeReason", "dealChangeSetBy", "dealChangeSetAt", "dealChangeSwitchedAt" (when the owner's own deal
--     moved to the new terms).
--  2. CHECK: a change is fully stated or absent; END names no new deal; RAISE names a whole deal above the one it
--     changes; the change starts no sooner than it was asked for.
--
-- ROLLBACK: rollback.sql beside this file (forward repair is preferred). Roll the application back first. The guard
-- refuses while any owner has a change pending: the branches' told fee rises name it.

SET lock_timeout = '10s';

ALTER TABLE "vendor_owners"
  ADD COLUMN "dealChangeKind" TEXT,
  ADD COLUMN "dealChangeFrom" DECIMAL(10,2),
  ADD COLUMN "dealChangeTo" DECIMAL(10,2),
  ADD COLUMN "dealChangeNotBefore" TIMESTAMP(3),
  ADD COLUMN "dealChangeReason" TEXT,
  ADD COLUMN "dealChangeSetBy" TEXT,
  ADD COLUMN "dealChangeSetAt" TIMESTAMP(3),
  ADD COLUMN "dealChangeSwitchedAt" TIMESTAMP(3);

ALTER TABLE "vendor_owners" ADD CONSTRAINT "vendor_owners_deal_change_stated"
  CHECK (
    ("dealChangeKind" IS NULL AND "dealChangeFrom" IS NULL AND "dealChangeTo" IS NULL AND "dealChangeNotBefore" IS NULL
      AND "dealChangeReason" IS NULL AND "dealChangeSetBy" IS NULL AND "dealChangeSetAt" IS NULL AND "dealChangeSwitchedAt" IS NULL)
    OR ("dealChangeKind" IN ('END', 'RAISE') AND "dealChangeFrom" IS NOT NULL AND "dealChangeNotBefore" IS NOT NULL
      AND length(btrim("dealChangeReason")) > 0 AND length(btrim("dealChangeSetBy")) > 0 AND "dealChangeSetAt" IS NOT NULL
      AND "dealChangeFrom" > 0 AND "dealChangeFrom" = trunc("dealChangeFrom")
      AND "dealChangeNotBefore" >= "dealChangeSetAt" - interval '1 minute'
      AND (("dealChangeKind" = 'END' AND "dealChangeTo" IS NULL)
        OR ("dealChangeKind" = 'RAISE' AND "dealChangeTo" IS NOT NULL AND "dealChangeTo" > "dealChangeFrom" AND "dealChangeTo" = trunc("dealChangeTo"))))
  );
