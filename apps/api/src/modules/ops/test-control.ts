import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { runtimeMode } from '../../utils/runtime-mode';

/**
 * [SCR-003] Write-load tools can target production without a code-level interlock.
 *
 * Stop-ship register SCR-003: the load harness accepted any BASE_URL and live
 * bearer tokens and then deleted carts, added items and placed orders; the
 * comment "never production" was not enforcement.
 *
 * The API now exposes `/test-control/identity` ONLY in isolated load builds
 * (runtime mode `loadtest`, or `test`, with TEST_CONTROL_ENABLED=1): the
 * deployment identity the database declares, the data classification, the
 * build SHA, the test tenant, and an expiring, signed lease nonce. Production
 * never registers the route, so a production target answers 404 and every
 * mutating load setup aborts before its first write. The tools compare the
 * identity with a signed run manifest field by field and send the lease and a
 * run id on every mutation.
 */
export const testControlEnabled = (env: Record<string, string | undefined> = process.env): boolean => {
  const mode = runtimeMode(env);
  return (mode === 'loadtest' || mode === 'test') && env['TEST_CONTROL_ENABLED'] === '1';
};
export const LEASE_TTL_MS = 10 * 60_000;
export interface LoadLease { nonce: string; expiresAt: string; signature: string }
export interface TestControlIdentity { deploymentId: string; environment: string; dataClassification: string; buildSha: string; testTenant: string; lease: LoadLease }

const sign = (secret: string, nonce: string, expiresAt: string, deploymentId: string) => createHmac('sha256', secret).update(`lease:${nonce}:${expiresAt}:${deploymentId}`).digest('hex');

export function mintLoadLease(secret: string, deploymentId: string, now = new Date()): LoadLease {
  const nonce = randomBytes(16).toString('hex');
  const expiresAt = new Date(now.getTime() + LEASE_TTL_MS).toISOString();
  return { nonce, expiresAt, signature: sign(secret, nonce, expiresAt, deploymentId) };
}
export function verifyLoadLease(secret: string, lease: LoadLease | null | undefined, deploymentId: string, now = new Date()): boolean {
  if (!lease || typeof lease.nonce !== 'string' || typeof lease.expiresAt !== 'string' || typeof lease.signature !== 'string') return false;
  if (!(Date.parse(lease.expiresAt) > now.getTime())) return false;
  const expected = sign(secret, lease.nonce, lease.expiresAt, deploymentId);
  return expected.length === lease.signature.length && timingSafeEqual(Buffer.from(expected), Buffer.from(lease.signature));
}

/** The identity the database declares, plus what the build and environment say about themselves. */
export async function testControlIdentity(prisma: PrismaClient, env: Record<string, string | undefined> = process.env, now = new Date()): Promise<TestControlIdentity> {
  const identity = await prisma.deploymentIdentity.findUnique({ where: { id: 'singleton' } }).catch(() => null);
  const deploymentId = identity?.deploymentId ?? 'unknown';
  const secret = env['TEST_CONTROL_SECRET'] || 'test-control-dev-secret';
  return {
    deploymentId,
    environment: identity?.environment ?? 'unknown',
    dataClassification: env['LOAD_TEST_DATA_CLASSIFICATION'] || 'synthetic',
    buildSha: env['BUILD_SHA'] || 'unknown',
    testTenant: env['LOAD_TEST_TENANT'] || 'swift-default',
    lease: mintLoadLease(secret, deploymentId, now),
  };
}
