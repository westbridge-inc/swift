import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { TEST_PHONE_BLOCK_SIZE, TEST_PHONE_DIR_ENV } from '../helpers/fixture-ids';
import { environmentForTests, lockTestTarget } from './target-lock';

/**
 * [VERIFY row 302 · flake class 2] Starts the run-wide test-phone count
 * (helpers/fixture-ids.ts testPhone()).
 *
 * Runs in vitest's main process before any worker, after the target lock (it
 * runs the same gate again, so it can never read a database that gate would
 * refuse). One read-only query finds the highest `+59206nnnnn` number already
 * in the users table — a local database keeps earlier runs' fixtures — and the
 * count starts just past it. Workers inherit the claim directory through the
 * environment; the directory is removed when the run ends.
 */
export default async function setup(): Promise<() => void> {
  const env = environmentForTests();
  await lockTestTarget(env);
  const db = new PrismaClient({ datasourceUrl: env['DATABASE_URL'] });
  let start = 0;
  try {
    const rows = await db.$queryRaw<Array<{ phone: string }>>`
      SELECT phone FROM users WHERE phone ~ '^\\+59206[0-9]{5}$' ORDER BY phone DESC LIMIT 1`;
    if (rows[0]) start = (Number(rows[0].phone.slice(-5)) + 1) % TEST_PHONE_BLOCK_SIZE;
  } finally {
    await db.$disconnect();
  }
  const dir = mkdtempSync(join(tmpdir(), 'swift-test-phones-'));
  writeFileSync(join(dir, 'next'), String(start));
  process.env[TEST_PHONE_DIR_ENV] = dir;
  return () => rmSync(dir, { recursive: true, force: true });
}
