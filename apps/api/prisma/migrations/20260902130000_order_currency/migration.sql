-- [M-36] Every order carries its currency (ISO 4217). Backfilled to GYD — the
-- only market with orders — and stamped from the buyer's market from now on.
SET lock_timeout = '10s';
ALTER TABLE "orders" ADD COLUMN "currencyCode" TEXT NOT NULL DEFAULT 'GYD';
ALTER TABLE "orders" ADD CONSTRAINT "orders_currency_iso_check" CHECK (char_length("currencyCode") = 3 AND "currencyCode" = upper("currencyCode")) NOT VALID;
