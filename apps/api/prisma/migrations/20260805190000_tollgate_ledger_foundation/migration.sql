-- TOLLGATE ledger foundation [tollgate PART 17]: double-entry ledger with the
-- money laws enforced by the DATABASE, not by hope — balanced transactions
-- (deferred constraint trigger), append-only rows, one-side-per-entry, and
-- the wallet floor. Raw-SQL objects are invisible to `db push`, so tests
-- self-install them in beforeAll and migration-check asserts them on replay.

-- CreateTable
CREATE TABLE "ledger_accounts" (
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "currencyCode" TEXT NOT NULL DEFAULT 'GYD',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ledger_accounts_pkey" PRIMARY KEY ("code")
);

-- CreateTable
CREATE TABLE "ledger_transactions" (
    "id" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ledger_transactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ledger_entries" (
    "id" TEXT NOT NULL,
    "transactionId" TEXT NOT NULL,
    "accountCode" TEXT NOT NULL,
    "subledgerId" TEXT,
    "debit" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "credit" DECIMAL(12,2) NOT NULL DEFAULT 0,

    CONSTRAINT "ledger_entries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ledger_transactions_idempotencyKey_key" ON "ledger_transactions"("idempotencyKey");

-- CreateIndex
CREATE INDEX "ledger_transactions_occurredAt_idx" ON "ledger_transactions"("occurredAt");

-- CreateIndex
CREATE INDEX "ledger_entries_accountCode_subledgerId_idx" ON "ledger_entries"("accountCode", "subledgerId");

-- CreateIndex
CREATE INDEX "ledger_entries_transactionId_idx" ON "ledger_entries"("transactionId");

-- AddForeignKey
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_transactionId_fkey" FOREIGN KEY ("transactionId") REFERENCES "ledger_transactions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ============================================================================
-- Raw money laws (below this line: everything `prisma migrate diff` can't say)
-- ============================================================================

-- Each entry carries exactly one positive side; direction is the row's meaning.
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_nonneg" CHECK ("debit" >= 0 AND "credit" >= 0);
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_one_side" CHECK (("debit" = 0) <> ("credit" = 0));

-- The wallet can never go negative — arithmetic bugs die here, not in balances
-- [tollgate 3.1]. (Verified: zero violating rows exist before this migration.)
ALTER TABLE "prepaid_balances" ADD CONSTRAINT "prepaid_balance_nonneg" CHECK ("balance" >= 0);

-- Balanced-transaction law [tollgate LAW M-13]: Σdebits = Σcredits per
-- transaction, checked at COMMIT (deferred) so multi-row inserts assemble
-- freely inside a transaction but can never commit lopsided.
CREATE OR REPLACE FUNCTION assert_ledger_txn_balanced() RETURNS trigger AS $$
DECLARE
  tid text;
  imbalance numeric;
BEGIN
  tid := COALESCE(NEW."transactionId", OLD."transactionId");
  SELECT COALESCE(SUM("debit" - "credit"), 0) INTO imbalance
  FROM "ledger_entries" WHERE "transactionId" = tid;
  IF imbalance <> 0 THEN
    RAISE EXCEPTION 'LEDGER_UNBALANCED: transaction % is off by %', tid, imbalance;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER "ledger_txn_balanced"
AFTER INSERT ON "ledger_entries"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION assert_ledger_txn_balanced();

-- Append-only law: ledger rows are never edited or deleted — corrections are
-- reversing transactions referencing the original.
CREATE OR REPLACE FUNCTION deny_ledger_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'LEDGER_APPEND_ONLY: % on % is forbidden — post a reversing transaction', TG_OP, TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "ledger_entries_append_only"
BEFORE UPDATE OR DELETE ON "ledger_entries"
FOR EACH ROW EXECUTE FUNCTION deny_ledger_mutation();

CREATE TRIGGER "ledger_transactions_append_only"
BEFORE UPDATE OR DELETE ON "ledger_transactions"
FOR EACH ROW EXECUTE FUNCTION deny_ledger_mutation();

-- Chart of accounts (reporting mirror — modules/billing/ledger.ts is truth).
INSERT INTO "ledger_accounts" ("code", "name", "type") VALUES
  ('CLEARING_MMG', 'MMG clearing — confirmed, not yet bank-settled', 'ASSET'),
  ('CLEARING_CARD', 'Card provider clearing', 'ASSET'),
  ('BANK_LOCAL', 'Local bank deposits', 'ASSET'),
  ('WALLET_LIABILITY', 'Payer fee-wallet balances (subledger = subscriptionId)', 'LIABILITY'),
  ('DEFERRED_REVENUE', 'Paid-through service not yet delivered', 'LIABILITY'),
  ('FEE_REVENUE', 'Earned weekly fees', 'REVENUE'),
  ('PROMO_EXPENSE', 'Credit-funded weeks — marketing cost, never revenue', 'EXPENSE'),
  ('PROVIDER_FEES', 'MMG/card per-transaction + settlement fees', 'EXPENSE'),
  ('CHARGEBACK_RESERVE', 'Card dispute reserve', 'LIABILITY'),
  ('CHARGEBACK_LOSS', 'Lost chargebacks', 'EXPENSE'),
  ('SUSPENSE_LIABILITY', 'Unmatched money held — never rejected (SO-6)', 'LIABILITY'),
  ('FX_VARIANCE', 'Settlement-vs-conversion FX differences', 'REVENUE'),
  ('OPENING_BALANCES', 'Ledger-epoch opening balances', 'CONTRA')
ON CONFLICT ("code") DO NOTHING;

-- Ledger epoch: existing prepaid balances enter the books as opening
-- transactions (deterministic ids — this backfill is idempotent and the
-- wallet-vs-ledger invariant is exact from day one, no grace window).
INSERT INTO "ledger_transactions" ("id", "idempotencyKey", "description", "occurredAt", "createdAt")
SELECT 'ltx_open_' || pb."subscriptionId", 'opening:' || pb."subscriptionId",
       'Opening balance at ledger epoch', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "prepaid_balances" pb
WHERE pb."balance" > 0
ON CONFLICT ("idempotencyKey") DO NOTHING;

INSERT INTO "ledger_entries" ("id", "transactionId", "accountCode", "subledgerId", "debit", "credit")
SELECT 'len_opend_' || pb."subscriptionId", 'ltx_open_' || pb."subscriptionId", 'OPENING_BALANCES', pb."subscriptionId", pb."balance", 0
FROM "prepaid_balances" pb
WHERE pb."balance" > 0 AND EXISTS (
  SELECT 1 FROM "ledger_transactions" lt
  WHERE lt."id" = 'ltx_open_' || pb."subscriptionId"
) AND NOT EXISTS (
  SELECT 1 FROM "ledger_entries" le WHERE le."id" = 'len_opend_' || pb."subscriptionId"
)
UNION ALL
SELECT 'len_openc_' || pb."subscriptionId", 'ltx_open_' || pb."subscriptionId", 'WALLET_LIABILITY', pb."subscriptionId", 0, pb."balance"
FROM "prepaid_balances" pb
WHERE pb."balance" > 0 AND EXISTS (
  SELECT 1 FROM "ledger_transactions" lt
  WHERE lt."id" = 'ltx_open_' || pb."subscriptionId"
) AND NOT EXISTS (
  SELECT 1 FROM "ledger_entries" le WHERE le."id" = 'len_openc_' || pb."subscriptionId"
);
