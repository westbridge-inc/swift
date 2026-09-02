import { PrismaClient } from '@prisma/client';
import type { RawClient } from '../../src/modules/ops/bootstrap-plan';

/**
 * [INF-002] The raw executor for the bootstrap statements — a bare Prisma
 * connection with no models required (the database may be empty).
 *
 * It lives HERE, under apps/api/scripts, not in production source: the
 * SQL-safety census refuses Prisma's unsafe raw APIs anywhere under src/, and
 * this is the one place that legitimately runs the DDL, role and grant
 * statements the plan built itself. The dev bootstrap script and its test are
 * the only importers, each behind the RawClient seam.
 */
export async function prismaRawClient(url: string): Promise<RawClient> {
  const prisma = new PrismaClient({ datasources: { db: { url } }, log: [] });
  await prisma.$connect();
  return {
    query: <T = Record<string, unknown>>(sql: string) => prisma.$queryRawUnsafe<T[]>(sql),
    exec: async (sql: string) => { await prisma.$executeRawUnsafe(sql); },
    close: () => prisma.$disconnect(),
  };
}
