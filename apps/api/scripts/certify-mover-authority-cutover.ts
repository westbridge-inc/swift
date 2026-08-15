import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const MIGRATION_NAME = '20260808021500_mover_location_authority_cutover';
const EXPECTED_CHECKSUM = '3325cbb26949c11c7582192d1e5d25057bd70e95380693a563f2ad070a3a151a';
const INDEX_MIGRATIONS = [
  {
    migration: '20260808020000_mover_authority_readiness_indexes',
    checksum: 'c2c46c5f6ff56c299816fb3639cb51095f90f04fd9bdb92afeecbcb2f4d5b8d5',
  },
  {
    migration: '20260808020100_mover_authority_rider_availability_index',
    checksum: 'd34b327ccc31be45d3310b660275f3a97598d2919d4a6208d49037bdb70c8bb1',
  },
  {
    migration: '20260808020200_mover_authority_rider_location_session_index',
    checksum: '3b4c66939cd68382820105c3d8ae636042481dc0021bc0cce21cc52f4c135c74',
  },
  {
    migration: '20260808020300_mover_authority_driver_current_ride_index',
    checksum: '31445f7a285b8d971d3e334cbbb1681b9573cd8d1666edd3a82e26de986cb48f',
  },
  {
    migration: '20260808020400_mover_authority_driver_availability_index',
    checksum: '9c6e47dcda856223273f6307dc02f08882919cf778b1c45a9e392ab1c3e7f6ac',
  },
  {
    migration: '20260808020500_mover_authority_driver_location_session_index',
    checksum: 'f0e8dbdcc96c9a019f2992d00b72698b64edf8ef84d9bd1158e1dbfb20f442c0',
  },
] as const;
const OUTBOX_MIGRATION_NAME = '20260808023000_mover_revocation_outbox';
const EXPECTED_OUTBOX_CHECKSUM = '2081ad65eb80e7b5fa07524bf81ca3e8191c1c00028bb0df5b71b665b974da23';

interface PsqlResult {
  status: number;
  stdout: string;
  stderr: string;
}

function certificationDatabaseUrl(): { url: string; databaseName: string } {
  const raw = process.env['MOVER_CUTOVER_CERT_DATABASE_URL'];
  if (!raw) throw new Error('MOVER_CUTOVER_CERT_DATABASE_URL is required');

  const parsed = new URL(raw);
  if (parsed.protocol !== 'postgresql:' && parsed.protocol !== 'postgres:') {
    throw new Error('Certification URL must use postgresql:// or postgres://');
  }
  const databaseName = decodeURIComponent(parsed.pathname.replace(/^\//, ''));
  if (!/^swift_cutover_cert_[a-z0-9_]+$/.test(databaseName)) {
    throw new Error('Refusing destructive fixtures: database name must start with swift_cutover_cert_');
  }
  if (process.env['MOVER_CUTOVER_CERT_CONFIRM'] !== databaseName) {
    throw new Error('MOVER_CUTOVER_CERT_CONFIRM must equal the exact certification database name');
  }
  return { url: raw, databaseName };
}

function runPsql(databaseUrl: string, sql: string): PsqlResult {
  const result = spawnSync(
    'psql',
    [databaseUrl, '-X', '--set', 'ON_ERROR_STOP=1', '--quiet', '--tuples-only', '--no-align'],
    {
      input: sql,
      encoding: 'utf8',
      env: {
        ...process.env,
        PGAPPNAME: 'swift-mover-authority-cutover-certification',
        PGCONNECT_TIMEOUT: '5',
      },
    },
  );
  if (result.error) throw result.error;
  return {
    status: result.status ?? 1,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

function requirePsqlSuccess(databaseUrl: string, sql: string, context: string): string {
  const result = runPsql(databaseUrl, sql);
  if (result.status !== 0) {
    throw new Error(`${context} failed: ${result.stderr.trim()}`);
  }
  return result.stdout.trim();
}

function schemaSql(schema: string, sql: string): string {
  if (!/^[a-z0-9_]+$/.test(schema)) throw new Error('Unsafe fixture schema identifier');
  return `SET search_path TO "${schema}", public;\n${sql}`;
}

function assertScalarTrue(databaseUrl: string, schema: string, sql: string, context: string): void {
  const actual = requirePsqlSuccess(databaseUrl, schemaSql(schema, sql), context);
  if (actual !== 't') throw new Error(`${context} failed (query returned ${JSON.stringify(actual)})`);
}

function createFixtureSchema(databaseUrl: string, schema: string): void {
  requirePsqlSuccess(databaseUrl, `
    CREATE SCHEMA "${schema}";
    SET search_path TO "${schema}", public;
    CREATE TABLE "orders" (
      "id" TEXT PRIMARY KEY,
      "riderId" TEXT,
      "driverId" TEXT,
      "status" TEXT NOT NULL,
      "ridePinVerified" BOOLEAN NOT NULL DEFAULT false,
      "ridePinVerifiedAt" TIMESTAMP(3)
    );
    CREATE TABLE "riders" (
      "id" TEXT PRIMARY KEY,
      "currentOrderId" TEXT,
      "isOnline" BOOLEAN NOT NULL DEFAULT false,
      "isAvailable" BOOLEAN NOT NULL DEFAULT true,
      "locationSessionId" TEXT
    );
    CREATE TABLE "drivers" (
      "id" TEXT PRIMARY KEY,
      "currentRideId" TEXT,
      "isOnline" BOOLEAN NOT NULL DEFAULT false,
      "isAvailable" BOOLEAN NOT NULL DEFAULT true,
      "locationSessionId" TEXT
    );
    CREATE INDEX "orders_status_idx" ON "orders"("status");
    CREATE INDEX "orders_riderId_idx" ON "orders"("riderId");
    CREATE INDEX "orders_driverId_idx" ON "orders"("driverId");
    CREATE INDEX "riders_isOnline_idx" ON "riders"("isOnline");
    CREATE INDEX "riders_currentOrderId_idx" ON "riders"("currentOrderId");
    CREATE INDEX "riders_isAvailable_idx" ON "riders"("isAvailable");
    CREATE INDEX "riders_locationSessionId_idx" ON "riders"("locationSessionId");
    CREATE INDEX "drivers_isOnline_isAvailable_idx" ON "drivers"("isOnline", "isAvailable");
    CREATE INDEX "drivers_currentRideId_idx" ON "drivers"("currentRideId");
    CREATE INDEX "drivers_isAvailable_idx" ON "drivers"("isAvailable");
    CREATE INDEX "drivers_locationSessionId_idx" ON "drivers"("locationSessionId");
  `, `create fixture schema ${schema}`);
}

function expectMigrationFailure(
  databaseUrl: string,
  schema: string,
  migrationSql: string,
  expectedMessage: string,
): void {
  const result = runPsql(databaseUrl, schemaSql(schema, migrationSql));
  if (result.status === 0) {
    throw new Error(`${schema}: migration unexpectedly succeeded`);
  }
  const output = `${result.stdout}\n${result.stderr}`;
  if (!output.includes(expectedMessage)) {
    throw new Error(`${schema}: migration failed for the wrong reason: ${result.stderr.trim()}`);
  }
}

function assertGuardRollback(
  databaseUrl: string,
  schema: string,
  preservedStateSql: string,
): void {
  assertScalarTrue(databaseUrl, schema, `
    SELECT (
      (${preservedStateSql})
      AND NOT EXISTS (
        SELECT 1
        FROM pg_constraint c
        JOIN pg_class t ON t.oid = c.conrelid
        JOIN pg_namespace n ON n.oid = t.relnamespace
        WHERE n.nspname = '${schema}'
          AND c.conname IN (
            'riders_online_requires_location_owner',
            'drivers_online_requires_location_owner'
          )
      )
    );
  `, `${schema}: refused migration transaction rollback proof`);
}

async function main(): Promise<void> {
  const { url: databaseUrl, databaseName } = certificationDatabaseUrl();
  const migrationPath = resolve(
    process.cwd(),
    'prisma',
    'migrations',
    MIGRATION_NAME,
    'migration.sql',
  );
  const migrationSql = readFileSync(migrationPath, 'utf8');
  const checksum = createHash('sha256').update(migrationSql).digest('hex');
  if (checksum !== EXPECTED_CHECKSUM) {
    throw new Error(`Cutover migration checksum mismatch: expected ${EXPECTED_CHECKSUM}, got ${checksum}`);
  }
  const outboxMigrationPath = resolve(
    process.cwd(),
    'prisma',
    'migrations',
    OUTBOX_MIGRATION_NAME,
    'migration.sql',
  );
  const outboxMigrationSql = readFileSync(outboxMigrationPath, 'utf8');
  const outboxChecksum = createHash('sha256').update(outboxMigrationSql).digest('hex');
  if (outboxChecksum !== EXPECTED_OUTBOX_CHECKSUM) {
    throw new Error(
      `Revocation outbox migration checksum mismatch: expected ${EXPECTED_OUTBOX_CHECKSUM}, got ${outboxChecksum}`,
    );
  }
  const verifiedIndexMigrations = INDEX_MIGRATIONS.map((required) => {
    const indexMigrationPath = resolve(
      process.cwd(),
      'prisma',
      'migrations',
      required.migration,
      'migration.sql',
    );
    const indexMigrationSql = readFileSync(indexMigrationPath, 'utf8');
    const checksum = createHash('sha256').update(indexMigrationSql).digest('hex');
    if (checksum !== required.checksum) {
      throw new Error(
        `Readiness index migration checksum mismatch for ${required.migration}: expected ${required.checksum}, got ${checksum}`,
      );
    }
    const executableStatements = indexMigrationSql
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('--'))
      .join('\n')
      .trim();
    if (
      (executableStatements.match(/CREATE INDEX CONCURRENTLY IF NOT EXISTS/g)?.length ?? 0) !== 1
      || (executableStatements.match(/;/g)?.length ?? 0) !== 1
      || /\b(?:BEGIN|COMMIT|SET|RESET)\b/.test(executableStatements)
    ) {
      throw new Error(`${required.migration} must contain exactly one concurrent index statement`);
    }
    return { migration: required.migration, checksum };
  });

  const connectedDatabase = requirePsqlSuccess(databaseUrl, 'SELECT current_database();', 'database identity proof');
  if (connectedDatabase !== databaseName) {
    throw new Error(`Connection identity mismatch: expected ${databaseName}, got ${connectedDatabase}`);
  }

  const runId = randomUUID().replaceAll('-', '').slice(0, 12);
  const retainedSchemas: string[] = [];
  const makeSchema = (label: string) => {
    const schema = `swift_cutover_${label}_${runId}`;
    retainedSchemas.push(schema);
    createFixtureSchema(databaseUrl, schema);
    return schema;
  };

  const safe = makeSchema('safe');
  requirePsqlSuccess(databaseUrl, schemaSql(safe, `
    INSERT INTO "orders" ("id", "status") VALUES
      ('terminal-order', 'COMPLETED'),
      ('unassigned-open-order', 'PENDING');
    INSERT INTO "riders" ("id", "isOnline", "isAvailable")
      VALUES ('safe-rider', false, false);
    INSERT INTO "drivers" ("id", "isOnline", "isAvailable")
      VALUES ('safe-driver', false, false);
  `), 'seed safe fixture');
  requirePsqlSuccess(databaseUrl, schemaSql(safe, migrationSql), 'safe cutover migration');
  assertScalarTrue(databaseUrl, safe, `
    SELECT (
      (SELECT NOT "isOnline" AND NOT "isAvailable"
              AND "locationSessionId" IS NULL AND "currentOrderId" IS NULL
         FROM "riders" WHERE "id" = 'safe-rider')
      AND
      (SELECT NOT "isOnline" AND NOT "isAvailable"
              AND "locationSessionId" IS NULL AND "currentRideId" IS NULL
         FROM "drivers" WHERE "id" = 'safe-driver')
      AND
      (SELECT COUNT(*) = 2
         FROM pg_constraint c
         JOIN pg_class t ON t.oid = c.conrelid
         JOIN pg_namespace n ON n.oid = t.relnamespace
        WHERE n.nspname = '${safe}'
          AND c.conname IN (
            'riders_online_requires_location_owner',
            'drivers_online_requires_location_owner'
          )
          AND c.contype = 'c'
          AND c.convalidated = true)
    );
  `, 'prepared safe fixture and capability proof');
  expectMigrationFailure(
    databaseUrl,
    safe,
    'UPDATE "riders" SET "isOnline" = true, "locationSessionId" = NULL WHERE "id" = \'safe-rider\';',
    'riders_online_requires_location_owner',
  );

  const unprepared = makeSchema('unprepared_supply');
  requirePsqlSuccess(databaseUrl, schemaSql(unprepared, `
    INSERT INTO "orders" ("id", "status") VALUES ('terminal-order', 'COMPLETED');
    INSERT INTO "riders" ("id", "currentOrderId", "isOnline", "isAvailable")
      VALUES ('unprepared-rider', 'terminal-order', true, true);
  `), 'seed unprepared-supply fixture');
  expectMigrationFailure(databaseUrl, unprepared, migrationSql, 'Mover authority cutover refused');
  assertGuardRollback(databaseUrl, unprepared, `
    SELECT "isOnline" AND "isAvailable" AND "currentOrderId" = 'terminal-order'
    FROM "riders" WHERE "id" = 'unprepared-rider'
  `);

  const active = makeSchema('active_assignment');
  requirePsqlSuccess(databaseUrl, schemaSql(active, `
    INSERT INTO "orders" ("id", "driverId", "status")
      VALUES ('active-ride', 'active-driver', 'DRIVER_ASSIGNED');
    INSERT INTO "drivers" ("id", "isOnline", "isAvailable")
      VALUES ('active-driver', false, false);
  `), 'seed active-assignment fixture');
  expectMigrationFailure(databaseUrl, active, migrationSql, 'Mover authority cutover refused');
  assertGuardRollback(databaseUrl, active, `
    (SELECT NOT "isOnline" AND NOT "isAvailable" FROM "drivers" WHERE "id" = 'active-driver')
    AND (SELECT "driverId" = 'active-driver' FROM "orders" WHERE "id" = 'active-ride')
  `);

  const custody = makeSchema('unassigned_custody');
  requirePsqlSuccess(databaseUrl, schemaSql(custody, `
    INSERT INTO "orders" ("id", "status") VALUES ('custody-delivery', 'PICKED_UP');
    INSERT INTO "riders" ("id", "isOnline", "isAvailable")
      VALUES ('custody-rider', false, false);
  `), 'seed unassigned-custody fixture');
  expectMigrationFailure(databaseUrl, custody, migrationSql, 'Mover authority cutover refused');
  assertGuardRollback(databaseUrl, custody, `
    (SELECT NOT "isOnline" AND NOT "isAvailable" FROM "riders" WHERE "id" = 'custody-rider')
    AND (SELECT "riderId" IS NULL FROM "orders" WHERE "id" = 'custody-delivery')
  `);

  const verifiedPin = makeSchema('verified_pin_custody');
  requirePsqlSuccess(databaseUrl, schemaSql(verifiedPin, `
    INSERT INTO "orders" ("id", "status", "ridePinVerified")
      VALUES ('verified-pin-ride', 'DRIVER_ARRIVED', true);
  `), 'seed verified-PIN custody fixture');
  expectMigrationFailure(databaseUrl, verifiedPin, migrationSql, 'Mover authority cutover refused');
  assertGuardRollback(databaseUrl, verifiedPin, `
    SELECT "driverId" IS NULL AND "ridePinVerified"
    FROM "orders" WHERE "id" = 'verified-pin-ride'
  `);

  const verifiedPinTimestamp = makeSchema('verified_pin_timestamp_custody');
  requirePsqlSuccess(databaseUrl, schemaSql(verifiedPinTimestamp, `
    INSERT INTO "orders" ("id", "status", "ridePinVerified", "ridePinVerifiedAt")
      VALUES ('verified-pin-timestamp-ride', 'DRIVER_ARRIVED', false, CURRENT_TIMESTAMP);
  `), 'seed timestamp-only verified-PIN custody fixture');
  expectMigrationFailure(databaseUrl, verifiedPinTimestamp, migrationSql, 'Mover authority cutover refused');
  assertGuardRollback(databaseUrl, verifiedPinTimestamp, `
    SELECT "driverId" IS NULL AND NOT "ridePinVerified" AND "ridePinVerifiedAt" IS NOT NULL
    FROM "orders" WHERE "id" = 'verified-pin-timestamp-ride'
  `);

  const riderPointer = makeSchema('rider_pointer');
  requirePsqlSuccess(databaseUrl, schemaSql(riderPointer, `
    INSERT INTO "orders" ("id", "status") VALUES ('live-rider-order', 'PENDING');
    INSERT INTO "riders" ("id", "currentOrderId", "isOnline", "isAvailable")
      VALUES ('pointer-rider', 'live-rider-order', false, false);
  `), 'seed mismatched rider-pointer fixture');
  expectMigrationFailure(databaseUrl, riderPointer, migrationSql, 'Mover authority cutover refused');
  assertGuardRollback(databaseUrl, riderPointer, `
    SELECT NOT "isOnline" AND NOT "isAvailable" AND "currentOrderId" = 'live-rider-order'
    FROM "riders" WHERE "id" = 'pointer-rider'
  `);

  const driverPointer = makeSchema('driver_pointer');
  requirePsqlSuccess(databaseUrl, schemaSql(driverPointer, `
    INSERT INTO "orders" ("id", "status") VALUES ('live-driver-order', 'PENDING');
    INSERT INTO "drivers" ("id", "currentRideId", "isOnline", "isAvailable")
      VALUES ('pointer-driver', 'live-driver-order', false, false);
  `), 'seed mismatched driver-pointer fixture');
  expectMigrationFailure(databaseUrl, driverPointer, migrationSql, 'Mover authority cutover refused');
  assertGuardRollback(databaseUrl, driverPointer, `
    SELECT NOT "isOnline" AND NOT "isAvailable" AND "currentRideId" = 'live-driver-order'
    FROM "drivers" WHERE "id" = 'pointer-driver'
  `);

  // Force an error after the final proof but during capability activation. The
  // explicit transaction must roll back the new rider constraint when the
  // pre-existing driver constraint makes the second ALTER fail.
  const lateFailure = makeSchema('late_failure');
  requirePsqlSuccess(databaseUrl, schemaSql(lateFailure, `
    INSERT INTO "riders" ("id", "isOnline", "isAvailable")
      VALUES ('late-rider', false, false);
    ALTER TABLE "drivers"
      ADD CONSTRAINT "drivers_online_requires_location_owner" CHECK (true);
  `), 'seed late-failure transaction fixture');
  expectMigrationFailure(databaseUrl, lateFailure, migrationSql, 'already exists');
  assertScalarTrue(databaseUrl, lateFailure, `
    SELECT (
      (SELECT NOT "isOnline" AND NOT "isAvailable" AND "currentOrderId" IS NULL
         FROM "riders" WHERE "id" = 'late-rider')
      AND NOT EXISTS (
        SELECT 1
        FROM pg_constraint c
        JOIN pg_class t ON t.oid = c.conrelid
        JOIN pg_namespace n ON n.oid = t.relnamespace
        WHERE n.nspname = '${lateFailure}'
          AND c.conname = 'riders_online_requires_location_owner'
      )
      AND EXISTS (
        SELECT 1
        FROM pg_constraint c
        JOIN pg_class t ON t.oid = c.conrelid
        JOIN pg_namespace n ON n.oid = t.relnamespace
        WHERE n.nspname = '${lateFailure}'
          AND c.conname = 'drivers_online_requires_location_owner'
      )
    );
  `, 'late-statement failure rolled back capability activation');

  process.stdout.write(`${JSON.stringify({
    certification: 'mover-authority-cutover',
    database: databaseName,
    requiredMigrations: [
      ...verifiedIndexMigrations,
      { migration: MIGRATION_NAME, checksum },
      { migration: OUTBOX_MIGRATION_NAME, checksum: outboxChecksum },
    ],
    passed: true,
    cases: [
      'prepared-safe-cutover',
      'online-owner-constraint-enforcement',
      'unprepared-supply-and-pointer-refusal',
      'active-assignment-refusal',
      'unassigned-physical-custody-refusal',
      'verified-pin-custody-refusal',
      'verified-pin-timestamp-custody-refusal',
      'mismatched-live-rider-pointer-refusal',
      'mismatched-live-driver-pointer-refusal',
      'late-statement-transaction-rollback',
    ],
    retainedSchemas,
  })}\n`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`Mover authority cutover certification failed: ${message}\n`);
  process.exitCode = 1;
});
