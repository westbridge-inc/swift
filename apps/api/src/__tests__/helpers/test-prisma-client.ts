/**
 * [AUD-G7-040] A raw Prisma client for a test — only ever on a disposable test
 * database. `new PrismaClient()` reads DATABASE_URL (or, when it is unset,
 * Prisma's own dotenv: the development .env); this checks the URL first, in
 * any harness, and refuses anything that is not a loopback swift_test… target.
 */
import { PrismaClient } from '@prisma/client';
import { refuseNonTestDatabaseInVitest } from '../../lib/test-target-lock';

export function testPrismaClient(url: string | undefined = process.env['DATABASE_URL']): PrismaClient {
  refuseNonTestDatabaseInVitest('DATABASE_URL', url);
  return new PrismaClient({ datasourceUrl: url });
}
