import type { FastifyInstance } from 'fastify';
import { readInfrastructureClocks } from '../utils/infrastructure-clock';
import { positiveDurationMs, withTimeout } from '../utils/async-lifecycle';

export interface RuntimeReadinessState {
  checkQueues: () => boolean | Promise<boolean>;
  checkConsumers?: () => boolean | Promise<boolean>;
  checkRealtime?: () => boolean | Promise<boolean>;
}

export interface ReadinessSnapshot {
  ready: boolean;
  deps: {
    database: boolean;
    redis: boolean;
    queueInit: boolean;
    queueConsumers: boolean;
    realtime: boolean;
    clock: boolean;
  };
  timestamp: string;
}

export const MOVER_AUTHORITY_CUTOVER_MIGRATION =
  '20260808021500_mover_location_authority_cutover';
export const MOVER_AUTHORITY_CUTOVER_CHECKSUM =
  '3325cbb26949c11c7582192d1e5d25057bd70e95380693a563f2ad070a3a151a';
export const MOVER_AUTHORITY_READINESS_INDEX_MIGRATIONS = [
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
export const MOVER_REVOCATION_OUTBOX_MIGRATION =
  '20260808023000_mover_revocation_outbox';
export const MOVER_REVOCATION_OUTBOX_CHECKSUM =
  '2081ad65eb80e7b5fa07524bf81ca3e8191c1c00028bb0df5b71b665b974da23';

/** Schema capability required by the current mover authority model. Checking a
 * generic table is not sufficient: an instance with an older partial schema
 * can connect successfully and then fail every GO/logout request. */
export async function hasRequiredSchema(
  prisma: Pick<FastifyInstance, 'prisma'>['prisma'],
): Promise<boolean> {
  const rows = await prisma.$queryRaw<Array<{ ok: boolean }>>`
    SELECT (
      to_regclass('public.users') IS NOT NULL
      AND to_regclass('public.riders') IS NOT NULL
      AND to_regclass('public.drivers') IS NOT NULL
      AND to_regclass('public.sessions') IS NOT NULL
      AND to_regclass('public.mover_revocation_outbox') IS NOT NULL
      AND to_regclass('public._prisma_migrations') IS NOT NULL
      AND EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'users'
          AND column_name = 'lastMoverRole'
          AND data_type = 'USER-DEFINED'
          AND udt_name = 'MoverRole'
      )
      AND EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'riders'
          AND column_name = 'locationSessionId'
          AND data_type = 'text'
      )
      AND EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'drivers'
          AND column_name = 'locationSessionId'
          AND data_type = 'text'
      )
      AND EXISTS (
        SELECT 1
        FROM pg_constraint c
        WHERE c.conrelid = to_regclass('public.riders')
          AND c.conname = 'riders_online_requires_location_owner'
          AND c.contype = 'c'
          AND c.convalidated = true
      )
      AND EXISTS (
        SELECT 1
        FROM pg_constraint c
        WHERE c.conrelid = to_regclass('public.drivers')
          AND c.conname = 'drivers_online_requires_location_owner'
          AND c.contype = 'c'
          AND c.convalidated = true
      )
      -- Require the exact valid/ready index-to-table capabilities used by the
      -- bounded preparation and final cutover proof. The explicit certification
      -- command owns fleet-wide business-invariant scans; a high-frequency
      -- readiness probe must remain a cheap capability/dependency check.
      AND (
        SELECT COUNT(DISTINCT idx.relname) = 11
        FROM pg_index i
        JOIN pg_class idx ON idx.oid = i.indexrelid
        JOIN pg_class tbl ON tbl.oid = i.indrelid
        JOIN pg_namespace n ON n.oid = idx.relnamespace
        JOIN pg_namespace tn ON tn.oid = tbl.relnamespace
        WHERE n.nspname = 'public'
          AND tn.nspname = 'public'
          AND i.indisvalid = true
          AND i.indisready = true
          AND (idx.relname, tbl.relname) IN (
            ('orders_status_idx', 'orders'),
            ('orders_riderId_idx', 'orders'),
            ('orders_driverId_idx', 'orders'),
            ('riders_isOnline_idx', 'riders'),
            ('riders_currentOrderId_idx', 'riders'),
            ('riders_isAvailable_idx', 'riders'),
            ('riders_locationSessionId_idx', 'riders'),
            ('drivers_isOnline_isAvailable_idx', 'drivers'),
            ('drivers_currentRideId_idx', 'drivers'),
            ('drivers_isAvailable_idx', 'drivers'),
            ('drivers_locationSessionId_idx', 'drivers')
          )
      )
    ) AS ok
  `;
  if (rows[0]?.ok !== true) return false;

  // The columns above are created by the expand migration and are not proof
  // that every old binary was drained or that ownerless supply was retired.
  // Query the ledger only after proving it exists so a db-pushed development
  // schema fails closed without a noisy undefined-relation error.
  const cutover = await prisma.$queryRaw<Array<{ ok: boolean }>>`
    SELECT (
      NOT EXISTS (
        SELECT 1
        FROM (
          VALUES
            (${MOVER_AUTHORITY_READINESS_INDEX_MIGRATIONS[0].migration}, ${MOVER_AUTHORITY_READINESS_INDEX_MIGRATIONS[0].checksum}),
            (${MOVER_AUTHORITY_READINESS_INDEX_MIGRATIONS[1].migration}, ${MOVER_AUTHORITY_READINESS_INDEX_MIGRATIONS[1].checksum}),
            (${MOVER_AUTHORITY_READINESS_INDEX_MIGRATIONS[2].migration}, ${MOVER_AUTHORITY_READINESS_INDEX_MIGRATIONS[2].checksum}),
            (${MOVER_AUTHORITY_READINESS_INDEX_MIGRATIONS[3].migration}, ${MOVER_AUTHORITY_READINESS_INDEX_MIGRATIONS[3].checksum}),
            (${MOVER_AUTHORITY_READINESS_INDEX_MIGRATIONS[4].migration}, ${MOVER_AUTHORITY_READINESS_INDEX_MIGRATIONS[4].checksum}),
            (${MOVER_AUTHORITY_READINESS_INDEX_MIGRATIONS[5].migration}, ${MOVER_AUTHORITY_READINESS_INDEX_MIGRATIONS[5].checksum})
        ) AS required(migration_name, checksum)
        WHERE NOT EXISTS (
          SELECT 1
          FROM "_prisma_migrations" migration
          WHERE migration.migration_name = required.migration_name
            AND migration.checksum = required.checksum
            AND migration.finished_at IS NOT NULL
            AND migration.rolled_back_at IS NULL
            AND migration.applied_steps_count = 1
        )
      )
      AND EXISTS (
        SELECT 1
        FROM "_prisma_migrations"
        WHERE migration_name = ${MOVER_AUTHORITY_CUTOVER_MIGRATION}
          AND checksum = ${MOVER_AUTHORITY_CUTOVER_CHECKSUM}
          AND finished_at IS NOT NULL
          AND rolled_back_at IS NULL
          AND applied_steps_count = 1
      )
      AND EXISTS (
        SELECT 1
        FROM "_prisma_migrations"
        WHERE migration_name = ${MOVER_REVOCATION_OUTBOX_MIGRATION}
          AND checksum = ${MOVER_REVOCATION_OUTBOX_CHECKSUM}
          AND finished_at IS NOT NULL
          AND rolled_back_at IS NULL
          AND applied_steps_count = 1
      )
    ) AS ok
  `;
  return cutover[0]?.ok === true;
}

function fulfilledBoolean(result: PromiseSettledResult<boolean>): boolean {
  return result.status === 'fulfilled' && result.value;
}

export async function evaluateReadiness(
  app: Pick<FastifyInstance, 'prisma' | 'redis'>,
  state: RuntimeReadinessState,
): Promise<ReadinessSnapshot> {
  const timeoutMs = positiveDurationMs(process.env['READINESS_DEPENDENCY_TIMEOUT_MS'], 2_000);
  const bounded = <T>(operation: PromiseLike<T>, label: string) =>
    withTimeout(operation, timeoutMs, label);
  const [
    databaseResult,
    redisResult,
    queueResult,
    consumerResult,
    realtimeResult,
    clockResult,
  ] = await Promise.allSettled([
    bounded(
      hasRequiredSchema(app.prisma),
      'Readiness database check',
    ),
    bounded(
      app.redis.ping().then((pong) => pong === 'PONG'),
      'Readiness Redis check',
    ),
    bounded(
      Promise.resolve().then(() => state.checkQueues()),
      'Readiness queue producer check',
    ),
    bounded(
      Promise.resolve().then(() => state.checkConsumers?.() ?? true),
      'Readiness queue consumer check',
    ),
    bounded(
      Promise.resolve().then(() => state.checkRealtime?.() ?? true),
      'Readiness realtime adapter check',
    ),
    bounded(
      readInfrastructureClocks(app.prisma, app.redis).then((sample) => sample.aligned),
      'Readiness clock check',
    ),
  ]);

  const deps = {
    database: fulfilledBoolean(databaseResult),
    redis: fulfilledBoolean(redisResult),
    queueInit: fulfilledBoolean(queueResult),
    queueConsumers: fulfilledBoolean(consumerResult),
    realtime: fulfilledBoolean(realtimeResult),
    clock: fulfilledBoolean(clockResult),
  };
  return {
    ready: Object.values(deps).every(Boolean),
    deps,
    timestamp: new Date().toISOString(),
  };
}

export function registerReadinessRoute(
  app: FastifyInstance,
  state: RuntimeReadinessState,
): void {
  // Infra probes are deliberately unauthenticated but expose booleans only.
  app.get('/ready', async (_request, reply) => {
    const snapshot = await evaluateReadiness(app, state);
    reply.status(snapshot.ready ? 200 : 503);
    return snapshot;
  });
}
