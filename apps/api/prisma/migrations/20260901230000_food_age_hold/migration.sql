-- [TA-S0-001 hold] An order too old to deliver whose money the store already
-- holds (captured MMG) may not be cancelled by the system; it is held for a
-- person. The hold is a column so it is durable, atomic (one UPDATE claims it),
-- and enforceable at every rider-claim predicate.
ALTER TABLE "orders" ADD COLUMN "foodAgeHeldAt" TIMESTAMP(3);
