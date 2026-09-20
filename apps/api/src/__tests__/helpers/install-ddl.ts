import type { Prisma, PrismaClient } from '@prisma/client';

/**
 * Test-setup DDL installer for db-push environments: raw-SQL guards (triggers, policies,
 * CHECKs) live in migrations, so suites install them idempotently in beforeAll.
 *
 * Two hazards, both seen on real CI runs:
 *
 *  1. Several files install in PARALLEL while other files run app-path transactions. The
 *     brief ACCESS EXCLUSIVE locks deadlock against those transactions and 500 an unrelated
 *     test (PR #655). One global advisory lock serializes every installer.
 *
 *  2. [09-07] Serializing is not enough. A statement that queues behind a long transaction
 *     waits FOREVER — Postgres has no default lock timeout — so `tenant-lineage-items`
 *     blew its 120 s beforeAll on `main`, which also skipped its afterAll and stranded
 *     fixtures for whatever ran next. Two changes fix it: every statement runs under a
 *     bounded `lock_timeout` so a blocked one fails fast into the retry below, and
 *     statements whose effect is ALREADY PRESENT are skipped without taking a lock at all.
 *
 * Policies are NEVER skipped. `rlsDdlFor` emits `DROP POLICY IF EXISTS` before each
 * `CREATE POLICY`, so a snapshot taken before the loop is stale by the time the CREATE is
 * reached — skipping it would leave the table with no policy at all, which the RLS-N1/N2/N5
 * tests catch immediately. Only ENABLE/FORCE ROW LEVEL SECURITY are skipped, and only when
 * nothing in the same batch turns them back off.
 *
 * The skip is the real win. Since 2026-09-05 the migrations themselves ENABLE and FORCE row
 * level security on 104 tables, so in any environment that ran `migrate deploy` these
 * statements are pure lock contention for no effect.
 */
const INSTALL_LOCK = 7_741_990_001n; // arbitrary app-unique advisory key
const LOCK_TIMEOUT = '4s';
const MAX_ATTEMPTS = 5;
const TRANSACTION_MAX_WAIT_MS = 10_000;
const TRANSACTION_TIMEOUT_MS = 90_000;

type DdlTransaction = Pick<
  Prisma.TransactionClient,
  '$executeRawUnsafe' | '$queryRawUnsafe'
>;

const ENABLE_RLS = /^\s*ALTER\s+TABLE\s+"?([A-Za-z0-9_]+)"?\s+ENABLE\s+ROW\s+LEVEL\s+SECURITY/i;
const FORCE_RLS = /^\s*ALTER\s+TABLE\s+"?([A-Za-z0-9_]+)"?\s+FORCE\s+ROW\s+LEVEL\s+SECURITY/i;

/** What the database already has, read once, so the skip costs one query per install. */
async function currentState(prisma: DdlTransaction) {
  const rls = await prisma.$queryRawUnsafe<Array<{ relname: string; enabled: boolean; forced: boolean }>>(
    `SELECT c.relname, c.relrowsecurity AS enabled, c.relforcerowsecurity AS forced
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'r'`,
  );
  return {
    enabled: new Set(rls.filter((r) => r.enabled).map((r) => r.relname)),
    forced: new Set(rls.filter((r) => r.forced).map((r) => r.relname)),
  };
}

function databaseCode(err: unknown): string | undefined {
  if (typeof err !== 'object' || err === null) return undefined;
  const value = err as { code?: unknown; meta?: { code?: unknown } };
  if (typeof value.meta?.code === 'string') return value.meta.code;
  return typeof value.code === 'string' ? value.code : undefined;
}

const UNDOES_RLS = /(DISABLE\s+ROW\s+LEVEL\s+SECURITY|NO\s+FORCE\s+ROW\s+LEVEL\s+SECURITY)/i;

/** True when running the statement would change nothing. Unrecognised statements always run. */
function alreadyApplied(ddl: string, state: Awaited<ReturnType<typeof currentState>>): boolean {
  const enable = ENABLE_RLS.exec(ddl);
  if (enable) return state.enabled.has(enable[1]!);
  const force = FORCE_RLS.exec(ddl);
  if (force) return state.forced.has(force[1]!);
  return false;
}

export async function installDdl(prisma: PrismaClient, statements: string[]): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await prisma.$transaction(async (tx) => {
        // Every operation below must share one pinned connection. SET LOCAL and
        // the xact-scoped lock are automatically cleared even when a statement fails.
        await tx.$executeRawUnsafe(`SET LOCAL lock_timeout = '${LOCK_TIMEOUT}'`);
        await tx.$executeRawUnsafe(`SELECT pg_advisory_xact_lock(${INSTALL_LOCK})`);

        const state = await currentState(tx);
        // If anything in this batch turns RLS off again, the snapshot cannot be trusted: run it all.
        const batchUndoes = statements.some((ddl) => UNDOES_RLS.test(ddl));
        const pending = batchUndoes ? statements : statements.filter((ddl) => !alreadyApplied(ddl, state));
        for (const ddl of pending) {
          await tx.$executeRawUnsafe(ddl);
        }
      }, {
        maxWait: TRANSACTION_MAX_WAIT_MS,
        timeout: TRANSACTION_TIMEOUT_MS,
      });
      return;
    } catch (err) {
      const code = databaseCode(err);
      // 40P01 deadlock · 55P03 lock_not_available · P2034 Prisma write conflict/deadlock.
      // PostgreSQL aborts a transaction after a statement error, so retry the whole
      // atomic batch on a new connection instead of continuing inside the failed one.
      const retryable = code === '40P01' || code === '55P03' || code === 'P2034';
      if (!retryable || attempt >= MAX_ATTEMPTS) throw err;
      await new Promise((resolve) => setTimeout(resolve, 150 * attempt));
    }
  }
}
