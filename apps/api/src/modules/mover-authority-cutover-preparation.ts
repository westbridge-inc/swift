import { Prisma, type PrismaClient } from '@prisma/client';
import { TERMINAL_ORDER_STATUSES } from './order/order-status';

/**
 * Bounded, restart-safe preparation for the non-rolling mover authority cutover.
 *
 * This is deliberately separate from the final migration transaction. Rewriting
 * millions of profiles while holding the final authority locks creates a large
 * WAL/replication blast radius and makes a five-minute rollback increasingly
 * likely. Each preparation statement commits at most `batchSize` rows. A killed
 * process can be rerun because completed rows no longer match the next batch.
 *
 * The old API/worker fleet MUST already be stopped. We still refuse to mutate
 * anything while an assignment, custody state, or live pointer exists; the final
 * migration repeats the proof under write-conflicting table locks.
 */

export interface MoverAuthorityCutoverState {
  activeAssignments: string;
  physicalCustody: string;
  riderLivePointers: string;
  driverLivePointers: string;
  riderPointers: string;
  driverPointers: string;
  riderSupplyToRetire: string;
  driverSupplyToRetire: string;
}

export type MoverAuthorityPreparationPhase =
  | 'clear-terminal-rider-pointers'
  | 'clear-terminal-driver-pointers'
  | 'retire-rider-supply'
  | 'retire-driver-supply';

export interface MoverAuthorityPreparationProgress {
  phase: MoverAuthorityPreparationPhase;
  batch: number;
  updated: number;
  totalUpdated: number;
}

export interface MoverAuthorityPreparationResult {
  batchSize: number;
  before: MoverAuthorityCutoverState;
  after: MoverAuthorityCutoverState;
  updated: Record<MoverAuthorityPreparationPhase, number>;
}

type CutoverQueryClient = PrismaClient | Prisma.TransactionClient;

const LIVE_WORK_FIELDS: readonly (keyof MoverAuthorityCutoverState)[] = [
  'activeAssignments',
  'physicalCustody',
  'riderLivePointers',
  'driverLivePointers',
];

const ALL_ZERO_FIELDS: readonly (keyof MoverAuthorityCutoverState)[] = [
  ...LIVE_WORK_FIELDS,
  'riderPointers',
  'driverPointers',
  'riderSupplyToRetire',
  'driverSupplyToRetire',
];

function countIsNonzero(value: string): boolean {
  return BigInt(value) !== 0n;
}

function nonzeroFields(
  state: MoverAuthorityCutoverState,
  fields: readonly (keyof MoverAuthorityCutoverState)[],
): string[] {
  return fields
    .filter((field) => countIsNonzero(state[field]))
    .map((field) => `${field}=${state[field]}`);
}

export async function readMoverAuthorityCutoverState(
  db: CutoverQueryClient,
): Promise<MoverAuthorityCutoverState> {
  const rows = await db.$queryRaw<MoverAuthorityCutoverState[]>`
    SELECT
      (
        SELECT COUNT(*)::text
        FROM "orders" o
        WHERE (o."riderId" IS NOT NULL OR o."driverId" IS NOT NULL)
          AND o."status"::text NOT IN (${Prisma.join(TERMINAL_ORDER_STATUSES)})
      ) AS "activeAssignments",
      (
        SELECT COUNT(*)::text
        FROM "orders" o
        WHERE o."status" IN ('PICKED_UP', 'EN_ROUTE_DELIVERY', 'ARRIVED', 'RIDE_IN_PROGRESS')
           OR (
             o."status" = 'DRIVER_ARRIVED'
             AND (o."ridePinVerified" = true OR o."ridePinVerifiedAt" IS NOT NULL)
           )
      ) AS "physicalCustody",
      (
        SELECT COUNT(*)::text
        FROM "riders" r
        JOIN "orders" o ON o."id" = r."currentOrderId"
        WHERE o."status"::text NOT IN (${Prisma.join(TERMINAL_ORDER_STATUSES)})
      ) AS "riderLivePointers",
      (
        SELECT COUNT(*)::text
        FROM "drivers" d
        JOIN "orders" o ON o."id" = d."currentRideId"
        WHERE o."status"::text NOT IN (${Prisma.join(TERMINAL_ORDER_STATUSES)})
      ) AS "driverLivePointers",
      (SELECT COUNT(*)::text FROM "riders" WHERE "currentOrderId" IS NOT NULL) AS "riderPointers",
      (SELECT COUNT(*)::text FROM "drivers" WHERE "currentRideId" IS NOT NULL) AS "driverPointers",
      (
        SELECT COUNT(*)::text
        FROM "riders"
        WHERE "isOnline" = true OR "isAvailable" = true OR "locationSessionId" IS NOT NULL
      ) AS "riderSupplyToRetire",
      (
        SELECT COUNT(*)::text
        FROM "drivers"
        WHERE "isOnline" = true OR "isAvailable" = true OR "locationSessionId" IS NOT NULL
      ) AS "driverSupplyToRetire"
  `;
  const state = rows[0];
  if (!state) throw new Error('Mover authority cutover state query returned no row');
  return state;
}

function validateBatchSize(value: number): number {
  if (!Number.isInteger(value) || value < 100 || value > 10_000) {
    throw new Error('Mover authority preparation batch size must be an integer from 100 through 10000');
  }
  return value;
}

async function runBoundedBatch(
  prisma: PrismaClient,
  operation: (tx: Prisma.TransactionClient) => Promise<number>,
): Promise<number> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SET LOCAL lock_timeout = '5s'`;
    await tx.$executeRaw`SET LOCAL statement_timeout = '30s'`;
    return operation(tx);
  }, { maxWait: 10_000, timeout: 45_000 });
}

async function clearTerminalRiderPointers(tx: Prisma.TransactionClient, batchSize: number): Promise<number> {
  return tx.$executeRaw`
    WITH batch AS (
      SELECT r."id"
      FROM "riders" r
      WHERE r."currentOrderId" IS NOT NULL
        AND NOT EXISTS (
          SELECT 1
          FROM "orders" o
          WHERE o."id" = r."currentOrderId"
            AND o."status"::text NOT IN (${Prisma.join(TERMINAL_ORDER_STATUSES)})
        )
      ORDER BY r."id"
      FOR UPDATE SKIP LOCKED
      LIMIT ${batchSize}
    )
    UPDATE "riders" r
    SET "currentOrderId" = NULL,
        "updatedAt" = CURRENT_TIMESTAMP
    FROM batch
    WHERE r."id" = batch."id"
  `;
}

async function clearTerminalDriverPointers(tx: Prisma.TransactionClient, batchSize: number): Promise<number> {
  return tx.$executeRaw`
    WITH batch AS (
      SELECT d."id"
      FROM "drivers" d
      WHERE d."currentRideId" IS NOT NULL
        AND NOT EXISTS (
          SELECT 1
          FROM "orders" o
          WHERE o."id" = d."currentRideId"
            AND o."status"::text NOT IN (${Prisma.join(TERMINAL_ORDER_STATUSES)})
        )
      ORDER BY d."id"
      FOR UPDATE SKIP LOCKED
      LIMIT ${batchSize}
    )
    UPDATE "drivers" d
    SET "currentRideId" = NULL,
        "updatedAt" = CURRENT_TIMESTAMP
    FROM batch
    WHERE d."id" = batch."id"
  `;
}

async function retireRiderSupply(tx: Prisma.TransactionClient, batchSize: number): Promise<number> {
  return tx.$executeRaw`
    WITH batch AS (
      SELECT r."id"
      FROM "riders" r
      WHERE r."currentOrderId" IS NULL
        AND (r."isOnline" = true OR r."isAvailable" = true OR r."locationSessionId" IS NOT NULL)
      ORDER BY r."id"
      FOR UPDATE SKIP LOCKED
      LIMIT ${batchSize}
    )
    UPDATE "riders" r
    SET "isOnline" = false,
        "isAvailable" = false,
        "locationSessionId" = NULL,
        "updatedAt" = CURRENT_TIMESTAMP
    FROM batch
    WHERE r."id" = batch."id"
  `;
}

async function retireDriverSupply(tx: Prisma.TransactionClient, batchSize: number): Promise<number> {
  return tx.$executeRaw`
    WITH batch AS (
      SELECT d."id"
      FROM "drivers" d
      WHERE d."currentRideId" IS NULL
        AND (d."isOnline" = true OR d."isAvailable" = true OR d."locationSessionId" IS NOT NULL)
      ORDER BY d."id"
      FOR UPDATE SKIP LOCKED
      LIMIT ${batchSize}
    )
    UPDATE "drivers" d
    SET "isOnline" = false,
        "isAvailable" = false,
        "locationSessionId" = NULL,
        "updatedAt" = CURRENT_TIMESTAMP
    FROM batch
    WHERE d."id" = batch."id"
  `;
}

export async function prepareMoverAuthorityCutover(
  prisma: PrismaClient,
  options: {
    batchSize?: number;
    maxBatchesPerPhase?: number;
    onProgress?: (progress: MoverAuthorityPreparationProgress) => void;
  } = {},
): Promise<MoverAuthorityPreparationResult> {
  const batchSize = validateBatchSize(options.batchSize ?? 1_000);
  const maxBatchesPerPhase = options.maxBatchesPerPhase ?? 1_000_000;
  if (!Number.isInteger(maxBatchesPerPhase) || maxBatchesPerPhase < 1) {
    throw new Error('Mover authority preparation max batches must be a positive integer');
  }

  const before = await readMoverAuthorityCutoverState(prisma);
  const unsafe = nonzeroFields(before, LIVE_WORK_FIELDS);
  if (unsafe.length > 0) {
    throw new Error(
      `Mover authority preparation refused while live work exists: ${unsafe.join(', ')}`,
    );
  }

  const operations: Array<[
    MoverAuthorityPreparationPhase,
    (tx: Prisma.TransactionClient, size: number) => Promise<number>,
  ]> = [
    ['clear-terminal-rider-pointers', clearTerminalRiderPointers],
    ['clear-terminal-driver-pointers', clearTerminalDriverPointers],
    ['retire-rider-supply', retireRiderSupply],
    ['retire-driver-supply', retireDriverSupply],
  ];
  const updated = Object.fromEntries(
    operations.map(([phase]) => [phase, 0]),
  ) as Record<MoverAuthorityPreparationPhase, number>;

  for (const [phase, operation] of operations) {
    for (let batch = 1; batch <= maxBatchesPerPhase; batch += 1) {
      const count = await runBoundedBatch(prisma, (tx) => operation(tx, batchSize));
      if (!Number.isInteger(count) || count < 0 || count > batchSize) {
        throw new Error(`${phase} returned invalid bounded row count ${count}`);
      }
      updated[phase] += count;
      options.onProgress?.({ phase, batch, updated: count, totalUpdated: updated[phase] });
      if (count === 0) break;
      if (batch === maxBatchesPerPhase) {
        throw new Error(`${phase} exceeded ${maxBatchesPerPhase} batches; keep maintenance mode and inspect unexpected writers`);
      }
    }
  }

  const after = await readMoverAuthorityCutoverState(prisma);
  const residual = nonzeroFields(after, ALL_ZERO_FIELDS);
  if (residual.length > 0) {
    throw new Error(
      `Mover authority preparation incomplete: ${residual.join(', ')}. Keep every old writer stopped and rerun after reconciliation.`,
    );
  }

  return { batchSize, before, after, updated };
}
