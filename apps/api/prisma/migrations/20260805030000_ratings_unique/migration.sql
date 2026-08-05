-- Movement R (RAT-A): exactly one rating per (context, rater, direction) —
-- DB-enforced. Dedupe keeps the newest row first (defensive; live code
-- already guarded in-service).
DELETE FROM "ratings" a USING "ratings" b
  WHERE a."orderId" = b."orderId" AND a."raterId" = b."raterId"
    AND a."type" = b."type" AND a."id" < b."id";
CREATE UNIQUE INDEX IF NOT EXISTS "ratings_one_per_context"
  ON "ratings"("orderId", "raterId", "type");
