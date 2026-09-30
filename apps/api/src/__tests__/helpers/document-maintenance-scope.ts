import type { PrismaClient } from '@prisma/client';

/** Keep maintenance tests inside their own retained synthetic custody records.
 * The production selector still runs; this adds only the fixture-owner fence. */
export function documentMaintenanceScope(db: PrismaClient, users: readonly string[]): PrismaClient {
  return db.$extends({ query: {
    verificationDocument: { async findMany({ args, query }) {
      const imageSweep = args.where?.imagePurgedAt === null && args.where?.extractionRuns;
      if (!args.where?.retentionExpiresAt && args.where?.subjectId !== null && !imageSweep) return query(args);
      return query({ ...args, where: { AND: [args.where ?? {}, { userId: { in: [...users] } }] } });
    } },
    documentPurgeClaim: { async findMany({ args, query }) {
      if (args.where?.state !== 'COMMITTED' || !args.where.documentId) return query(args);
      return query({ ...args, where: { AND: [args.where ?? {}, { userId: { in: [...users] } }] } });
    } },
  } }) as unknown as PrismaClient;
}
