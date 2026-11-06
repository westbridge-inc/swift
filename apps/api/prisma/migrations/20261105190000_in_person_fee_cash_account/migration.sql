-- [OWNER 5 Nov 2026] A weekly fee may be paid directly to the company in
-- person by cash, cheque or bank transfer. Cash gets its own account in the
-- chart so it is never read as MMG money; a cleared cheque and a bank transfer
-- post to the existing BANK_LOCAL.
--
-- FORWARD: one chart-of-accounts row. No existing row changes.
--
-- ROLLBACK (honest scope). The row stays once any ledger row references it
-- (the ledger is append-only). See rollback.sql.
INSERT INTO "ledger_accounts" ("code", "name", "type") VALUES
  ('CASH_ON_HAND', 'Weekly-fee cash received in person, less cash paid back in person', 'ASSET')
ON CONFLICT ("code") DO NOTHING;
