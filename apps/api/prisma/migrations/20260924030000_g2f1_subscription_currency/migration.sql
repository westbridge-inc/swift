-- [G2-F1] Partner subscriptions were born with the COUNTRY code as their
-- currencyCode ("GY") instead of the ISO-4217 currency configured on the
-- CountryConfig row ("GYD"; TT -> TTD, JM -> JMD, ...). Correct every row the
-- bug wrote — subscriptions, billing_events and prepaid_balances — mapping a
-- stored currencyCode that IS a country code to that country's configured
-- currencyCode. A correct ISO currency (3 letters) is never a country code
-- (2 letters), so the join below only touches corrupted rows; correct rows
-- are untouched.
SET lock_timeout = '10s';

-- The rollback evidence lives in its OWN schema, never in `public`: a retained
-- table sitting in `public` with no Prisma model is permanent schema drift and
-- breaks the CI `prisma migrate diff --exit-code` gate (the same rule as
-- 20260907200000_retire_ai_agent_tables). Drop this schema once the rollback
-- window closes.
CREATE SCHEMA IF NOT EXISTS "g2f1_correction";
COMMENT ON SCHEMA "g2f1_correction" IS 'Temporary rollback evidence for the G2-F1 subscription-currency correction (20260924030000_g2f1_subscription_currency). Drop the schema once the rollback window closes.';

CREATE TABLE IF NOT EXISTS "g2f1_correction"."currency_correction_backup" (
    "tableName" TEXT NOT NULL,
    "rowId" TEXT NOT NULL,
    "oldCurrencyCode" TEXT NOT NULL,
    "newCurrencyCode" TEXT NOT NULL,
    "correctedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY ("tableName", "rowId")
);

INSERT INTO "g2f1_correction"."currency_correction_backup" ("tableName", "rowId", "oldCurrencyCode", "newCurrencyCode")
SELECT 'subscriptions', s."id", s."currencyCode", cc."currencyCode"
FROM "subscriptions" s
JOIN "country_configs" cc ON cc."code" = s."currencyCode"
WHERE s."currencyCode" <> cc."currencyCode"
ON CONFLICT ("tableName", "rowId") DO NOTHING;

UPDATE "subscriptions" s
SET "currencyCode" = cc."currencyCode"
FROM "country_configs" cc
WHERE cc."code" = s."currencyCode"
  AND s."currencyCode" <> cc."currencyCode";

INSERT INTO "g2f1_correction"."currency_correction_backup" ("tableName", "rowId", "oldCurrencyCode", "newCurrencyCode")
SELECT 'billing_events', e."id", e."currencyCode", cc."currencyCode"
FROM "billing_events" e
JOIN "country_configs" cc ON cc."code" = e."currencyCode"
WHERE e."currencyCode" <> cc."currencyCode"
ON CONFLICT ("tableName", "rowId") DO NOTHING;

UPDATE "billing_events" e
SET "currencyCode" = cc."currencyCode"
FROM "country_configs" cc
WHERE cc."code" = e."currencyCode"
  AND e."currencyCode" <> cc."currencyCode";

INSERT INTO "g2f1_correction"."currency_correction_backup" ("tableName", "rowId", "oldCurrencyCode", "newCurrencyCode")
SELECT 'prepaid_balances', b."id", b."currencyCode", cc."currencyCode"
FROM "prepaid_balances" b
JOIN "country_configs" cc ON cc."code" = b."currencyCode"
WHERE b."currencyCode" <> cc."currencyCode"
ON CONFLICT ("tableName", "rowId") DO NOTHING;

UPDATE "prepaid_balances" b
SET "currencyCode" = cc."currencyCode"
FROM "country_configs" cc
WHERE cc."code" = b."currencyCode"
  AND b."currencyCode" <> cc."currencyCode";

-- ROLLBACK (manual, honest scope): restore ONLY the rows recorded in the
-- backup table — a rollback cannot otherwise know which rows were wrong.
--
--   UPDATE "subscriptions" s
--   SET "currencyCode" = b."oldCurrencyCode"
--   FROM "g2f1_correction"."currency_correction_backup" b
--   WHERE b."tableName" = 'subscriptions' AND b."rowId" = s."id";
--
--   UPDATE "billing_events" e
--   SET "currencyCode" = b."oldCurrencyCode"
--   FROM "g2f1_correction"."currency_correction_backup" b
--   WHERE b."tableName" = 'billing_events' AND b."rowId" = e."id";
--
--   UPDATE "prepaid_balances" p
--   SET "currencyCode" = b."oldCurrencyCode"
--   FROM "g2f1_correction"."currency_correction_backup" b
--   WHERE b."tableName" = 'prepaid_balances' AND b."rowId" = p."id";
--
--   DROP TABLE "g2f1_correction"."currency_correction_backup";
--   DROP SCHEMA "g2f1_correction";
