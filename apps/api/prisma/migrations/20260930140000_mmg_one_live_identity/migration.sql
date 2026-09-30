-- [AX384] PostgreSQL owns the MMG transaction equivalence relation.
-- Include NBSP, narrow NBSP and BOM: portal/CSV adapters already trim them.
-- Resolve historical duplicate identities before enforcing it. No ledger,
-- receipt, wallet, subscription or already-credited observation is changed.
-- Statement markers also let the transactional forward test execute this
-- exact file without a SQL parser or a second database driver.
BEGIN;
-- statement-breakpoint
SET LOCAL lock_timeout = '10s';
-- statement-breakpoint
-- Credits lock observations before identities; use the same order here.
LOCK TABLE "mmg_agent_payments", "provider_payments" IN SHARE ROW EXCLUSIVE MODE;
-- statement-breakpoint
CREATE FUNCTION mmg_txn_canon(text) RETURNS text
LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
AS $$ SELECT upper(regexp_replace($1, U&'^[[:space:]\00A0\202F\FEFF]+|[[:space:]\00A0\202F\FEFF]+$', '', 'g')) $$;
-- statement-breakpoint
-- A stored JS key can differ from the canonical RAW observation (ß, ﬁ,
-- NBSP). Connect BOTH sets of aliases, including transitive overlaps. Never
-- let choosing one spelling conceal an already-credited sibling.
CREATE TEMP TABLE mmg_identity_resolution ON COMMIT DROP AS
WITH RECURSIVE aliases AS (
  SELECT p."id", p."provider", mmg_txn_canon(p."providerTxnId") AS key
    FROM "provider_payments" p
  UNION
  SELECT p."id", p."provider", mmg_txn_canon(COALESCE(m."mmgTxnId",
    CASE WHEN m."channel" = 'MANUAL_ADMIN' THEN regexp_replace(m."externalId", '^MANUAL:', '') ELSE m."externalId" END))
    FROM "provider_payments" p JOIN "mmg_agent_payments" m ON m."providerPaymentId" = p."id"
   WHERE p."provider" = 'MMG'
), connected(root, id) AS (
  SELECT "id", "id" FROM "provider_payments"
  UNION
  SELECT c.root, b."id" FROM connected c JOIN aliases a ON a."id" = c.id
    JOIN aliases b ON b."provider" = a."provider" AND b.key = a.key
), groups AS (
  SELECT id, min(root) AS group_id FROM connected GROUP BY id
), ranked AS (
  SELECT p.*, g.group_id,
    COALESCE((SELECT mmg_txn_canon(COALESCE(m."mmgTxnId",
      CASE WHEN m."channel" = 'MANUAL_ADMIN' THEN regexp_replace(m."externalId", '^MANUAL:', '') ELSE m."externalId" END))
      FROM "mmg_agent_payments" m WHERE m."providerPaymentId" = p."id" AND p."provider" = 'MMG'
      ORDER BY (m."id" = p."creditedPaymentId") DESC, m."createdAt", m."id" LIMIT 1), mmg_txn_canon(p."providerTxnId")) AS canonical_key,
    row_number() OVER (PARTITION BY g.group_id ORDER BY (p."status" = 'CREDITED') DESC,
      (p."status" <> 'HELD_DUPLICATE') DESC, p."createdAt", p."id") AS rank,
    count(*) OVER (PARTITION BY g.group_id) AS group_size,
    count(*) FILTER (WHERE p."status" = 'CREDITED') OVER (PARTITION BY g.group_id) AS credited_count
  FROM "provider_payments" p JOIN groups g ON g.id = p."id"
)
SELECT * FROM ranked;
-- statement-breakpoint
-- Preserve the original credit facts in this permanent finance record.
INSERT INTO "audit_logs" ("id", "action", "entity", "entityId", "changes", "createdAt")
SELECT gen_random_uuid()::text,
  CASE WHEN winner.credited_count > 1 THEN 'FINANCE_ALERT_PROVIDER_ID_CONFLICT' ELSE 'PROVIDER_ID_CONFLICT' END,
  'ProviderPayment', winner."id",
  jsonb_build_object('migration', '20260930140000_mmg_one_live_identity',
    'failureCode', 'PROVIDER_ID_CONFLICT', 'requiresFinanceReview', true,
    'historicalDoubleCredit', winner.credited_count > 1, 'creditedCount', winner.credited_count,
    'liveIdentityId', winner."id", 'canonicalKey', winner.canonical_key,
    'identities', (SELECT jsonb_agg(jsonb_build_object('id', r."id", 'key', r."providerTxnId",
      'status', r."status", 'creditedPaymentId', r."creditedPaymentId", 'canonicalKey', r.canonical_key)
      ORDER BY r.rank) FROM mmg_identity_resolution r WHERE r.group_id = winner.group_id)), CURRENT_TIMESTAMP
FROM mmg_identity_resolution winner
WHERE winner.rank = 1 AND (winner.group_size > 1 OR winner."providerTxnId" <> winner.canonical_key);
-- statement-breakpoint
UPDATE "provider_payments" p SET "status" = 'HELD_DUPLICATE', "updatedAt" = CURRENT_TIMESTAMP
FROM mmg_identity_resolution r WHERE r."id" = p."id" AND r.rank > 1;
-- statement-breakpoint
UPDATE "mmg_agent_payments" m SET "status" = 'UNMATCHED', "failureCode" = 'PROVIDER_ID_CONFLICT',
  "note" = 'Provider identity held by AX384 migration; finance review required. No money reversed.'
FROM "provider_payments" p WHERE m."providerPaymentId" = p."id" AND p."status" = 'HELD_DUPLICATE'
  AND m."status" IN ('RECEIVED', 'UNMATCHED');
-- statement-breakpoint
-- The partial canonical index supersedes the exact unique. Held evidence
-- may retain exactly the same key as the surviving re-keyed live identity.
DROP INDEX "provider_payments_provider_providerTxnId_key";
-- statement-breakpoint
UPDATE "provider_payments" p SET "providerTxnId" = r.canonical_key, "updatedAt" = CURRENT_TIMESTAMP
FROM mmg_identity_resolution r WHERE r."id" = p."id" AND r.rank = 1;
-- statement-breakpoint
CREATE INDEX "provider_payments_provider_providerTxnId_idx" ON "provider_payments" ("provider", "providerTxnId");
-- statement-breakpoint
CREATE UNIQUE INDEX "provider_payments_one_live_canonical" ON "provider_payments"
  ("provider", mmg_txn_canon("providerTxnId")) WHERE "status" <> 'HELD_DUPLICATE';
-- statement-breakpoint
COMMIT;
