# Billing confirmation cutover (migrations 20260930170000 and 20260930180000)

**Release class:** coordinated downtime. Old API and worker processes must be stopped before these migrations and stay stopped
until the backfill below reports READY. A mixed old/new rollout is unsupported: an old writer can dun, suspend or send a fee demand
without the shared confirmation clock.

## What the migrations do
- `20260930170000_mover_fee_authority` adds the one weekly-fee authority per mover payer (taxi drivers, riders, both roles).
- `20260930180000_shared_billing_confirmation_clock` is expand-only. It adds the shared dunning clock, payment confirmation holds,
  fee-demand notices and their channel handoffs, with lineage, RLS and immutability guards. It records the cutover marker
  `system:billing-confirmation-cutover:v1` as `BLOCKED` and marks every existing subscription paused for confirmation.
- While the marker is `BLOCKED`, the new code starts no new collection, sends no fee demand and suspends nobody. Existing
  suspensions, manual stops and paid receipts are unchanged; verified payment evidence is still recorded.

## Steps
1. Stop every API and worker process (`deploy/deploy.sh update` stops them before migrating; confirm none is running).
2. Apply migrations: `pnpm --filter @swift/api exec prisma migrate deploy`.
3. Run the versioned backfill against the named database and deployment (read the identity first; never guess it):
   ```
   pnpm --filter @swift/api exec tsx src/scripts/backfill-billing-confirmation.ts --execute \
     --version 20260930180000-v1 --expected-database <database> --expected-deployment <deploymentId>
   ```
   It maps every subscription to its clock with the same resolver the runtime uses (no provider calls, no collection, no notices,
   no balance change), then the owner-only SQL function repeats the full coverage check and records `READY` with a digest and an
   immutable audit row. It is restartable: an interrupted run leaves `BLOCKED` and is simply run again.
4. Check, as the migration owner:
   ```
   SELECT value->>'state', value->>'coverageDigest' FROM platform_config WHERE key = 'system:billing-confirmation-cutover:v1';  -- READY
   SELECT billing_confirmation_missing_coverage();                                                                           -- 0
   ```
5. Start the API and workers.

## If the backfill refuses
- "invalid or orphan subscription owners": a subscription without exactly one payer. Finance reviews those rows; nothing is
  deleted by the backfill. Fix ownership, then rerun step 3. Billing stays `BLOCKED` (safe: no charge, no dunning) until then.
- "coverage incomplete": rerun step 3; it resumes from committed rows.

## Rollback
`rollback.sql` for 180000 runs only while the expansion is unused (no clock, hold, notice, handoff, transition, READY marker or
clock audit exists) and refuses otherwise. After any backfill or runtime adoption, repair forward; never drop the history.
