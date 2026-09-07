-- [OTA-021] ORDER NUMBERS MUST BE UNIQUE BY CONSTRUCTION, NOT BY LUCK.
--
-- Checkout counted today's orders OUTSIDE its transaction and used that count as the
-- sequence, so every concurrent checkout read the same number. Uniqueness then rested on
-- three random suffix characters over a 30-symbol alphabet — 27,000 possibilities. At 200
-- orders sharing one sequence number the chance of a collision is ~0.52, and a collision
-- is not cosmetic: `orders.orderNumber` is UNIQUE, so the loser's transaction aborts and a
-- real customer's order fails.
--
-- This counter is read and advanced INSIDE the checkout transaction with a single
-- INSERT .. ON CONFLICT DO UPDATE .. RETURNING, which serialises concurrent checkouts on
-- one row per day and hands each a number nobody else can hold.
--
-- FORWARD: create the table and seed today's row from the orders already placed today, so
-- the first number issued after deploy cannot repeat one already in use.
-- ROLLBACK: DROP TABLE "order_number_counter";  -- the previous code path counts rows and
--           needs no state; no order data is touched by either direction.
CREATE TABLE IF NOT EXISTS "order_number_counter" (
  "day"       DATE NOT NULL PRIMARY KEY,
  "next"      INTEGER NOT NULL,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO "order_number_counter" ("day", "next")
SELECT (now() AT TIME ZONE 'UTC')::date, COUNT(*)
  FROM "orders"
 WHERE "placedAt" >= date_trunc('day', now() AT TIME ZONE 'UTC')
ON CONFLICT ("day") DO NOTHING;
