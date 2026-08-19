# Mover Location Authority Cutover

**Release class:** coordinated downtime / non-rolling security cutover
**Current status:** not authorized or executed; production remains NO-GO

## Why this cutover cannot roll

The new API binds each rider/driver location stream to one authenticated
`Session`. An older API binary does not know that generation and can still write
coordinates or change supply after a newer binary has claimed ownership. An
expand-only schema migration therefore does not make a mixed fleet safe.

Fly's normal rolling strategy replaces Machines one at a time, and a release
command runs before deployed Machines are updated. Neither behavior drains old
binaries by itself. This release must use a scheduled maintenance window in
which all old API and worker Machines are stopped before the cutover migration,
then only the exact new image is started. See Fly's official deployment and
scaling references:

- https://fly.io/docs/reference/configuration/#run-one-off-commands-before-releasing-a-deployment
- https://fly.io/docs/blueprints/seamless-deployments/#deployment-strategies-choose-your-own-trade-offs
- https://fly.io/docs/launch/scale-count/#scale-to-zero-and-back-up

### Ad impression token v1 is also nonrolling

This release changes tracked-ad tokens from the legacy unscoped shape to the
principal-bound `v: 1` shape. The new event ingester intentionally rejects every
legacy token. A mixed fleet would let an old server mint tokens that a new
server rejects, or route a v1 token to code whose authority contract was never
reviewed for it. That is lost billing telemetry and is not rolling
compatibility.

Treat `/api/v1/ads/serve` and `/api/v1/ads/events` as one protocol generation:

1. At the edge, close both endpoints together and record the authoritative
   timestamp of the last accepted serve request/token issuance (`T0`). Do not
   let either old or new application instances bypass this quarantine.
2. Stop the old fleet, then keep both endpoints closed until the authoritative
   time is strictly later than `T0 + 15 minutes` (the maximum production token
   lifetime), plus the recorded maximum permitted clock-skew allowance. This is
   a mandatory in-flight-token drain, not an optional observation period.
3. Prove from the exact artifact that production serving has no call site that
   overrides the 15-minute token lifetime, `ADS_EVENT_SECRET` is unchanged,
   every running API instance is the v1 image, and edge logs show zero bypasses.
   Only then may new ad traffic open.
4. If a rollback or forward-recovery target does not implement the identical v1
   token contract, close both endpoints again, record the last v1 issuance, and
   repeat the full minimum 15-minute-plus-skew quarantine before that target can
   receive ad traffic. Other API traffic may resume behind an edge rule that
   keeps both ad endpoints closed; ad traffic may not. If the wait cannot be
   completed, ads stay closed.

Never label legacy-token rejection as a short rolling-upgrade window, and never
use cross-version invalid verdicts as the drain mechanism. The only authorized
transition is a measured, nonrolling protocol cutover with the evidence above.

## Hard preconditions

The operator must record all evidence in the release ticket. Do not proceed
unless every item is true:

1. The exact commit passed API, mobile, migration-replay, contract, secret,
   staging, and rollback gates.
2. A fresh logical PostgreSQL backup and Redis snapshot were created, verified,
   checksummed, and copied outside the runtime volume.
3. The prior Fly release/image identifier, Machine IDs, process-group counts,
   regions, configuration, and secrets inventory were captured.
4. Customer/vendor/mover maintenance messaging is live and new order, ride,
   courier, GO-online, and assignment entry points are closed.
5. All dispatch offers have been allowed to expire. Every non-terminal order
   assignment, every physical-custody state (even with a null/corrupt assignment
   FK), and every mover profile pointer to a non-terminal order is reconciled.
6. Active SOS/safety cases are zero and an on-call owner is present.
7. The real `apps/api/fly.toml`, Docker build, Fly application, production URL,
   process groups, and credentials exist. They are absent from the current
   repository, so the checked-in deploy workflow is not currently executable.
8. The edge can atomically quarantine both ad serve and event endpoints, expose
   an authoritative last-request timestamp, and prove no bypass. The release
   ticket allocates at least the full 15-minute-plus-skew token drain before
   either new traffic or any incompatible rollback traffic.

Canonical live-work preflight (all four counts must be exactly `0` before any
profile preparation starts):

```sql
SELECT
  COUNT(*) FILTER (
    WHERE (o."riderId" IS NOT NULL OR o."driverId" IS NOT NULL)
      AND o.status NOT IN ('DELIVERED', 'COMPLETED', 'CANCELLED', 'REFUNDED', 'FAILED')
  ) AS active_assignments,
  COUNT(*) FILTER (
    WHERE o.status IN ('PICKED_UP', 'EN_ROUTE_DELIVERY', 'ARRIVED', 'RIDE_IN_PROGRESS')
       OR (
         o.status = 'DRIVER_ARRIVED'
         AND (o."ridePinVerified" = true OR o."ridePinVerifiedAt" IS NOT NULL)
       )
  ) AS physical_custody
FROM orders o;

SELECT
  (SELECT COUNT(*)
     FROM riders r
     JOIN orders o ON o.id = r."currentOrderId"
    WHERE o.status NOT IN ('DELIVERED', 'COMPLETED', 'CANCELLED', 'REFUNDED', 'FAILED'))
    AS rider_live_pointers,
  (SELECT COUNT(*)
     FROM drivers d
     JOIN orders o ON o.id = d."currentRideId"
    WHERE o.status NOT IN ('DELIVERED', 'COMPLETED', 'CANCELLED', 'REFUNDED', 'FAILED'))
    AS driver_live_pointers;
```

Do not add reverse-FK predicates to the pointer checks. A profile pointer to a
live order is authority evidence even when that order points to no mover or a
different mover. The cutover migration locks `orders`, `riders`, and `drivers`,
repeats these live-work assertions plus the four prepared-state assertions, and
aborts atomically if any state reappears.

Timestamp-only PIN verification is custody. Never simplify the predicate to the
legacy boolean alone.

The exact reviewed migration SHA-256 values are:

```text
20260808020000_mover_authority_readiness_indexes
  c2c46c5f6ff56c299816fb3639cb51095f90f04fd9bdb92afeecbcb2f4d5b8d5
20260808020100_mover_authority_rider_availability_index
  d34b327ccc31be45d3310b660275f3a97598d2919d4a6208d49037bdb70c8bb1
20260808020200_mover_authority_rider_location_session_index
  3b4c66939cd68382820105c3d8ae636042481dc0021bc0cce21cc52f4c135c74
20260808020300_mover_authority_driver_current_ride_index
  31445f7a285b8d971d3e334cbbb1681b9573cd8d1666edd3a82e26de986cb48f
20260808020400_mover_authority_driver_availability_index
  9c6e47dcda856223273f6307dc02f08882919cf778b1c45a9e392ab1c3e7f6ac
20260808020500_mover_authority_driver_location_session_index
  f0e8dbdcc96c9a019f2992d00b72698b64edf8ef84d9bd1158e1dbfb20f442c0
20260808021500_mover_location_authority_cutover
  3325cbb26949c11c7582192d1e5d25057bd70e95380693a563f2ad070a3a151a
20260808023000_mover_revocation_outbox
  2081ad65eb80e7b5fa07524bf81ca3e8191c1c00028bb0df5b71b665b974da23
```

Verify all eight against both the release artifact and repository before any
migration. Readiness requires the same checksums in successful Prisma ledger
rows plus the exact validated constraints and valid/ready index capabilities.

The readiness-index expansion is six independently ledgered migrations. Each
file contains exactly one `CREATE INDEX CONCURRENTLY` statement. This is not a
stylistic preference: Prisma/PostgreSQL places a multi-statement migration in an
implicit transaction, where concurrent index creation is forbidden. Apply the
six migrations from a separately reviewed expand-only artifact while the old
fleet is still serving, monitor PostgreSQL/replica health after each build, and
verify all six exact ledger rows before scheduling downtime. Never expose a
production database that has not yet applied all six to an artifact that also
contains the final cutover migration: `prisma migrate deploy` applies every
pending migration.

## Execution sequence

1. Freeze deploy concurrency and announce the maintenance start.
2. Before the window, confirm all six expand-only readiness-index migrations
   have the exact checksums above and successful ledger rows, and all eleven
   required indexes report `indisvalid = true` and `indisready = true`. The six newly
   built indexes are `riders_currentOrderId_idx`, `riders_isAvailable_idx`,
   `riders_locationSessionId_idx`, `drivers_currentRideId_idx`,
   `drivers_isAvailable_idx`, and `drivers_locationSessionId_idx`. Also verify
   the existing `orders_status_idx`, `orders_riderId_idx`,
   `orders_driverId_idx`, `riders_isOnline_idx`, and
   `drivers_isOnline_isAvailable_idx` capabilities.
3. Confirm final backup hashes, all eight migration hashes, and all four
   live-work preconditions above.
4. Atomically quarantine both ad endpoints and record `T0`, then stop every old
   API and worker Machine. Confirm the public API cannot accept a request, no
   worker/scheduler lease remains, and the old image has zero live Machines in
   every region and process group. Keep ad traffic closed until authoritative
   time is strictly later than `T0 + 15 minutes` plus the recorded clock-skew
   allowance. Attach the edge rule, `T0`, zero-bypass logs, elapsed-time proof,
   exact-artifact 15-minute TTL proof, stable `ADS_EVENT_SECRET` proof, and fleet
   image inventory to the release ticket. Do not continue to new traffic if any
   part of this token-v1 drain is missing.
5. Close Redis rider online-hours at one exact Redis-server timestamp while the
   old fleet is stopped:

   ```bash
   MOVER_AUTHORITY_CUTOVER_CONFIRM=CLOSE_RIDER_ONLINE_HOURS \
     REDIS_URL='<release-secret>' \
     pnpm --filter @swift/api exec tsx scripts/close-mover-online-hours-cutover.ts
   ```

   Attach the script's JSON result to the release ticket. It pins Redis `TIME`
   once under the durable proof key
   `cutover:mover_authority:20260808021500:online_hours_epoch_ms`, so a partial
   retry reuses the identical cutoff. It atomically folds every
   `rider:online_since:*` marker into that Guyana day's `rider:online_ms:*`
   bucket, removes the open marker, and fails if any marker remains. Retain the
   proof key. Do not substitute `KEYS`, host time, or a best-effort loop.
6. Run the resumable bounded preparation from the exact release image. It
   refuses to mutate while any assignment, custody state, or live pointer
   exists, commits at most 1,000 rows per transaction, and can be rerun after a
   process or connection failure:

   ```bash
   MOVER_AUTHORITY_CUTOVER_CONFIRM=PREPARE_MOVER_AUTHORITY_CUTOVER \
     MOVER_AUTHORITY_PREPARE_BATCH_SIZE=1000 \
     DATABASE_URL='<release-secret>' \
     pnpm --filter @swift/api exec tsx scripts/prepare-mover-authority-cutover.ts
   ```

   Attach every progress line and the final JSON to the release ticket. The
   final `after` object must report string value `"0"` for all eight fields:
   assignments, custody, both live-pointer classes, both remaining-pointer
   classes, and both supply-to-retire classes. Keep every writer stopped for the
   remainder of the cutover. A retry is expected to skip already committed rows.
7. Run `prisma migrate deploy` from a one-off Machine built from the exact new
   image. Do not use `flyctl ssh console` against an old serving Machine. The
   final cutover file performs no mass update: it uses indexed `EXISTS` guards
   under write-conflicting locks, a 15-second lock timeout, a five-minute
   statement timeout, and one explicit PostgreSQL transaction for proof plus
   constraint activation. Its `VALIDATE CONSTRAINT` scans are read-only but
   must be timed on a production-scale rehearsal before the window.
8. Confirm all eight successful ledger rows have the exact checksums above,
   `finished_at IS NOT NULL`, `rolled_back_at IS NULL`, and
   `applied_steps_count = 1`. Confirm both named constraints are validated:

   ```sql
   SELECT migration_name, checksum, started_at, finished_at, rolled_back_at,
          applied_steps_count, logs
   FROM "_prisma_migrations"
   WHERE migration_name IN (
     '20260808020000_mover_authority_readiness_indexes',
     '20260808020100_mover_authority_rider_availability_index',
     '20260808020200_mover_authority_rider_location_session_index',
     '20260808020300_mover_authority_driver_current_ride_index',
     '20260808020400_mover_authority_driver_availability_index',
     '20260808020500_mover_authority_driver_location_session_index',
     '20260808021500_mover_location_authority_cutover',
     '20260808023000_mover_revocation_outbox'
   )
   ORDER BY started_at;

   SELECT c.conname, c.convalidated
   FROM pg_constraint c
   WHERE c.conname IN (
     'riders_online_requires_location_owner',
     'drivers_online_requires_location_owner'
   );
   ```

   Then rerun the explicit full invariant proof and require all profiles
   offline, owner columns null, live pointers absent, and Redis open-hour markers
   absent. `/ready` intentionally does not scan fleet business rows: it fails
   closed on exact migration ledgers, validated constraints, valid/ready index
   capabilities, dependencies, queue consumers, and infrastructure clocks.
   Run the full business-invariant query as a separately scheduled monitor.
9. Start exactly one new API Machine with workers disabled and one new worker
   Machine. Require `/ready`, queue producer/consumer PING, schema capability,
   worker lease, scheduler heartbeat, database/Redis clock, and fatal-handler
   checks to pass.
10. Run safe staging/production smoke: authentication, role picker, GO with a
   fresh session owner, location publish, one controlled dispatch/decline/cancel,
   logout cleanup, and ops visibility. Use designated release accounts only.
11. Restore the approved Machine counts one process group at a time while
   watching readiness, error rate, queue lag, dispatch latency, and session
   ownership conflicts.
12. Reopen traffic only after the release commander records GO.

## Failed migration ledger recovery

Never blindly rerun `migrate deploy` and never mark a migration rolled back
merely because the CLI returned nonzero. Preserve the ledger `logs`, active
connections, server logs, object definitions, and preparation JSON first.

### A. Concurrent readiness-index expansion failed

`CREATE INDEX CONCURRENTLY` is intentionally outside a transaction. Earlier
indexes may be valid and durable while an interrupted build leaves one same-name
index with `indisvalid = false` or `indisready = false`.

1. Keep the serving artifact unchanged. Inspect all eleven exact index names,
   their owning table, `indisvalid`, `indisready`, and `pg_get_indexdef`.
2. Independently compare every valid definition to `schema.prisma` and the
   reviewed migration. Do not drop a valid production index.
3. For each exact invalid index only, issue one separately reviewed
   `DROP INDEX CONCURRENTLY public."<exact-index-name>"`. Never use a wildcard,
   an unqualified name, `CASCADE`, or a transaction block.
4. Prove no invalid required index remains. Only then mark the one exact failed
   single-index migration rolled back and rerun the expand-only artifact.
   Never mark a successful sibling migration rolled back. `IF NOT EXISTS`
   preserves already-valid builds.
5. Do not schedule the authority window until all six ledger checksums and all
   eleven valid/ready definitions pass independent review.

### B. Final authority cutover failed

The cutover migration's explicit transaction contains the locked final proof and
both constraints. Bounded preparation commits happened earlier and intentionally
remain; they are not partial migration writes.

1. Keep maintenance mode active and every API/worker Machine stopped.
2. Prove neither cutover constraint exists, the cutover ledger has no successful
   row, both preparation/full-invariant proofs still report zero, and no
   migration connection remains `idle in transaction` in `pg_stat_activity`.
3. Reconcile the guard, lock-timeout, or validation-time cause. Rehearse a larger
   window instead of raising timeouts without evidence.
4. Only after independent rollback proof, run:

   ```bash
   pnpm --filter @swift/api exec prisma migrate resolve \
     --rolled-back 20260808021500_mover_location_authority_cutover
   ```

5. Reinspect the ledger and retry from the exact authority-aware image. If either
   cutover constraint survived or the ledger says the cutover succeeded, do not
   mark it rolled back and do not resume an old binary.

### C. Authority cutover succeeded but revocation outbox failed

This is application-forward recovery. The authority cutover is already durable;
never mark it rolled back and never start the old image.

1. Keep maintenance mode active. Prove the cutover checksum row succeeded and
   both online-owner constraints are validated.
2. Inspect the outbox ledger and exact table/index definitions. If
   `mover_revocation_outbox` is absent, its explicit transaction rolled back;
   after independent review, resolve only
   `20260808023000_mover_revocation_outbox` as rolled back and rerun
   `migrate deploy` from the same reviewed image.
3. If the table and all three exact indexes exist despite a failed/incomplete
   ledger (for example, the connection was lost after `COMMIT`), do not drop the
   table and do not resolve it rolled back. Compare every definition byte-for-
   byte with the migration, prove there are no partial objects, then use the
   Prisma `--applied` reconciliation path only with database-owner and release-
   commander approval.
4. Readiness remains false until the outbox ledger checksum is successful. Start
   no API or worker process before that proof.

Prisma documents PostgreSQL migration transactions as opt-in and
`migrate resolve` as a failed-migration reconciliation tool, not a retry switch:

- https://www.prisma.io/blog/prisma-migrate-dx-primitives
- https://www.prisma.io/docs/orm/reference/prisma-cli-reference#migrate-resolve

## Rollback boundary: application-forward only

Never resume an image that predates session-owned mover location authority,
even if the schema additions appear backward-readable. The old binary can
publish without a generation and is therefore not a rollback target after this
cutover.

If the new release fails, keep traffic closed and all mover supply offline,
stop the failing fleet, and deploy only a separately reviewed image that
contains the same authority model, readiness capability, and cutover checksum
contract (normally a forward hotfix). If no such image exists, maintenance
continues. There is no automatic binary rollback and no database down migration.

An authority-aware recovery image with an incompatible ads-token contract is
still not allowed to receive ad traffic immediately. Quarantine both ad
endpoints and repeat the complete token-v1 drain described above: record the
last v1 issuance and wait until authoritative time is strictly later than that
timestamp plus 15 minutes plus the clock-skew allowance. Keep ads closed if the
evidence or wait is incomplete.

If canonical data changed incorrectly, stop and execute the verified backup
recovery plan. Even after recovery, traffic may reopen only behind an
authority-aware image; never improvise a partial database rollback or restore
the pre-authority application.

## Abort conditions

Abort and keep maintenance mode if any live-work count is nonzero, any of the
eight post-preparation fields is nonzero, an index is missing/invalid/not ready,
migration drift/checksum mismatch exists, backup proof is missing, an old
Machine remains live, exact-time Redis closure is incomplete, readiness is
false, worker lease/heartbeat is absent, clock skew is unsafe, ownerless or
expired-owner supply appears, custody/pointer state drifts, smoke state does not
reconcile, or forward-recovery evidence is incomplete.

## Certification evidence required before scheduling

Run the destructive fixture harness only against a dedicated database whose
name starts with `swift_cutover_cert_`; it refuses every other database name and
requires the exact name as a second confirmation:

```bash
MOVER_CUTOVER_CERT_DATABASE_URL='<isolated-cert-db-url>' \
MOVER_CUTOVER_CERT_CONFIRM='<exact-database-name>' \
  pnpm --filter @swift/api exec tsx scripts/certify-mover-authority-cutover.ts
```

The harness verifies all eight reviewed migration hashes before touching its
isolated database and creates the eleven index capabilities in every fixture.
Attach its output plus a fresh, empty-database `prisma migrate deploy` replay to
the release ticket. Required fixtures are: prepared safe cutover and constraint
enforcement, unprepared pointer/supply refusal, active assignment refusal,
unassigned physical-custody refusal, boolean PIN custody refusal, timestamp-only
PIN custody refusal, mismatched live rider/driver pointer refusal, and rollback
of an earlier constraint when the second capability statement fails. The
certification database is evidence; retain it until release sign-off.
