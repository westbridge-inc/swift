# Card rail v2: migration runbook

Card rail v2 ships two migrations:
- `20260925000400_card_rail_v2`: the three new tables and one nullable column. It runs in one transaction.
- `20260925000410_card_rail_v2_payment_instrument_index`: one `CREATE INDEX CONCURRENTLY` on the existing, busy `subscription_payments` table.

Both are expand-only. Card rail v2 stays switched off (`CARD_RAIL_V2=0`) whatever state they are in.

## Recovering an interrupted online index build (`20260925000410`)

`CREATE INDEX CONCURRENTLY` runs outside any transaction. An interrupted build leaves an index named `subscription_payments_instrumentId_idx` with `indisvalid = false` (or `indisready = false`), and the migration ledger shows the migration as failed.

The next deploy does **not** repair this:
- Prisma refuses to continue past a failed migration.
- `IF NOT EXISTS` would keep the invalid index.

This follows `MOVER-AUTHORITY-CUTOVER-RUNBOOK.md`, "Failed migration ledger recovery", section A.

Never blindly rerun `migrate deploy`. Never mark a migration rolled back only because the CLI returned nonzero. First preserve the ledger row's `logs`, the active connections and the server logs.

1. **Inspect.** Keep the serving build unchanged. Run:

   ```sql
   SELECT c.relname, i.indisvalid, i.indisready, pg_get_indexdef(i.indexrelid)
   FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
   WHERE c.relname = 'subscription_payments_instrumentId_idx';

   SELECT migration_name, started_at, finished_at, rolled_back_at, logs
   FROM _prisma_migrations
   WHERE migration_name LIKE '20260925000%'
   ORDER BY migration_name;
   ```

   Every other card rail object must be present and `20260925000400` must be finished. If `20260925000400` itself failed, stop: that transaction rolled back whole, and it is recovered by redeploying, not with these steps.
2. **Drop only the invalid index**, once, by its exact name. Never use a wildcard, `CASCADE` or a transaction block:

   ```sql
   DROP INDEX CONCURRENTLY public."subscription_payments_instrumentId_idx";
   ```

   Do this only if step 1 showed `indisvalid = false` or `indisready = false`. Never drop a valid index.
3. **Mark exactly that migration rolled back**, and nothing else:

   ```sh
   npx prisma migrate resolve --rolled-back 20260925000410_card_rail_v2_payment_instrument_index
   ```
4. **Redeploy:** `npx prisma migrate deploy`.
5. **Verify.** Step 1's first query returns one row with `indisvalid = true` and `indisready = true`, and the ledger shows `20260925000410` finished.

The coordinator proves both migrations on a copy of staging data before any staging deploy.
