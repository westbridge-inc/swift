import type { PrismaClient } from '@prisma/client';

/**
 * Test-setup DDL installer for db-push environments (CI): raw-SQL guards
 * (triggers, policies, CHECKs) live in migrations, so suites install them
 * idempotently in beforeAll. Multiple test files do this IN PARALLEL while
 * other files run app-path transactions — unserialized, the brief ACCESS
 * EXCLUSIVE locks can deadlock against those transactions and 500 an
 * unrelated test (seen on PR #655's CI run).
 *
 * One global advisory lock serializes every installer, keeping each
 * exclusive-lock window tiny and ordered; a short retry absorbs the
 * remaining deadlock/lock-timeout races.
 */
const INSTALL_LOCK = 7_741_990_001n; // arbitrary app-unique advisory key

export async function installDdl(prisma: PrismaClient, statements: string[]): Promise<void> {
  await prisma.$executeRawUnsafe(`SELECT pg_advisory_lock(${INSTALL_LOCK})`);
  try {
    for (const ddl of statements) {
      for (let attempt = 1; ; attempt++) {
        try {
          await prisma.$executeRawUnsafe(ddl);
          break;
        } catch (err) {
          const code = (err as { meta?: { code?: string }; code?: string })?.meta?.code
            ?? (err as { code?: string })?.code;
          const retryable = code === '40P01' || code === '55P03';
          if (!retryable || attempt >= 3) throw err;
          await new Promise((r) => setTimeout(r, 150 * attempt));
        }
      }
    }
  } finally {
    await prisma.$executeRawUnsafe(`SELECT pg_advisory_unlock(${INSTALL_LOCK})`);
  }
}
