-- Removes the chart row only while no ledger entry names it. A ledger row that
-- does name it keeps the account: the ledger is append-only.
DELETE FROM "ledger_accounts" a
WHERE a."code" = 'CASH_ON_HAND'
  AND NOT EXISTS (SELECT 1 FROM "ledger_entries" e WHERE e."accountCode" = a."code");
