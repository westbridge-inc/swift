-- [Off-site erasure ledger] LOAD THE OFF-SITE LEDGER INTO THE REPLAY. Run by deploy/restore.sh on the
-- scratch copy, inside the replay transaction, after the restore_ledger_* tables exist (and hold the
-- live ledger, when there is a live database) and restore_offsite holds the off-site entries (one
-- JSON object per row: {id, kind, entry, createdAt}, as deploy/erasure-ledger-ship.sh shipped them).
--
-- The off-site entries JOIN the live ledger (or stand alone in a disaster recovery without the live
-- database). Each fact is added only when the ledger does not already hold it. An account the live
-- ledger already describes keeps the live database's list of kept rows; for any other closed account
-- the kept rows are its tombstone's list minus the rows deleted later (kind deleted_rows).

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM restore_offsite o WHERE o.line->>'kind' NOT IN (
      'receipts', 'destroyed_keys', 'retired_documents', 'shredded_runs', 'shredded_fields',
      'closed_accounts', 'deleted_rows', 'erased_rating_text', 'erased_outbox_text')) THEN
    RAISE EXCEPTION 'off-site erasure ledger: an entry of an unknown kind';
  END IF;
END $$;

-- Kept rows first, and only for accounts the live ledger does not already describe.
INSERT INTO restore_ledger_closed_account_rows (tbl, id)
SELECT DISTINCT k->>'tbl', k->>'id'
FROM restore_offsite o CROSS JOIN LATERAL jsonb_array_elements(coalesce(o.line->'entry'->'kept', '[]'::jsonb)) AS k
WHERE o.line->>'kind' = 'closed_accounts'
  AND NOT EXISTS (SELECT 1 FROM restore_ledger_closed_accounts l WHERE l.id = o.line->'entry'->>'id')
  AND NOT EXISTS (SELECT 1 FROM restore_offsite d WHERE d.line->>'kind' = 'deleted_rows'
                    AND d.line->'entry'->>'tbl' = k->>'tbl' AND d.line->'entry'->>'id' = k->>'id')
  AND NOT EXISTS (SELECT 1 FROM restore_ledger_closed_account_rows x WHERE x.tbl = k->>'tbl' AND x.id = k->>'id');

INSERT INTO restore_ledger_closed_accounts
SELECT DISTINCT ON (r.id) r.* FROM restore_offsite o
  CROSS JOIN LATERAL jsonb_populate_record(NULL::restore_ledger_closed_accounts, o.line->'entry') AS r
WHERE o.line->>'kind' = 'closed_accounts' AND NOT EXISTS (SELECT 1 FROM restore_ledger_closed_accounts l WHERE l.id = r.id)
ORDER BY r.id, o.line->>'createdAt' DESC;

INSERT INTO restore_ledger_receipts
SELECT DISTINCT ON (r.id) r.* FROM restore_offsite o
  CROSS JOIN LATERAL jsonb_populate_record(NULL::restore_ledger_receipts, o.line->'entry') AS r
WHERE o.line->>'kind' = 'receipts' AND NOT EXISTS (SELECT 1 FROM restore_ledger_receipts l WHERE l.id = r.id)
ORDER BY r.id;

INSERT INTO restore_ledger_destroyed_keys
SELECT DISTINCT ON (r."fileKey") r.* FROM restore_offsite o
  CROSS JOIN LATERAL jsonb_populate_record(NULL::restore_ledger_destroyed_keys, o.line->'entry') AS r
WHERE o.line->>'kind' = 'destroyed_keys' AND NOT EXISTS (SELECT 1 FROM restore_ledger_destroyed_keys l WHERE l."fileKey" = r."fileKey")
ORDER BY r."fileKey", o.line->>'createdAt' DESC;

INSERT INTO restore_ledger_retired_documents
SELECT DISTINCT ON (r.id) r.* FROM restore_offsite o
  CROSS JOIN LATERAL jsonb_populate_record(NULL::restore_ledger_retired_documents, o.line->'entry') AS r
WHERE o.line->>'kind' = 'retired_documents' AND NOT EXISTS (SELECT 1 FROM restore_ledger_retired_documents l WHERE l.id = r.id)
ORDER BY r.id, o.line->>'createdAt' DESC;

INSERT INTO restore_ledger_shredded_runs
SELECT DISTINCT r.* FROM restore_offsite o CROSS JOIN LATERAL jsonb_populate_record(NULL::restore_ledger_shredded_runs, o.line->'entry') AS r
WHERE o.line->>'kind' = 'shredded_runs' AND NOT EXISTS (SELECT 1 FROM restore_ledger_shredded_runs l WHERE l.id = r.id);
INSERT INTO restore_ledger_shredded_fields
SELECT DISTINCT r.* FROM restore_offsite o CROSS JOIN LATERAL jsonb_populate_record(NULL::restore_ledger_shredded_fields, o.line->'entry') AS r
WHERE o.line->>'kind' = 'shredded_fields' AND NOT EXISTS (SELECT 1 FROM restore_ledger_shredded_fields l WHERE l.id = r.id);
INSERT INTO restore_ledger_erased_rating_text
SELECT DISTINCT r.* FROM restore_offsite o CROSS JOIN LATERAL jsonb_populate_record(NULL::restore_ledger_erased_rating_text, o.line->'entry') AS r
WHERE o.line->>'kind' = 'erased_rating_text' AND NOT EXISTS (SELECT 1 FROM restore_ledger_erased_rating_text l WHERE l.id = r.id);
INSERT INTO restore_ledger_erased_outbox_text
SELECT DISTINCT r.* FROM restore_offsite o CROSS JOIN LATERAL jsonb_populate_record(NULL::restore_ledger_erased_outbox_text, o.line->'entry') AS r
WHERE o.line->>'kind' = 'erased_outbox_text' AND NOT EXISTS (SELECT 1 FROM restore_ledger_erased_outbox_text l WHERE l.id = r.id);

-- A row the live database deleted for a closed account AFTER its tombstone, when the live ledger is
-- gone: never in a kept list (removed above), so the replay's step 5 deletes it with the rest.
