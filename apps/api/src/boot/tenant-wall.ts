import type { PrismaClient } from '@prisma/client';
import { assertTenantWall, attestationLine, attestationOf, readRlsFacts, type RlsAttestation } from '../lib/rls-attestation';
import { rlsAttestationGauge } from '../plugins/observability';

type EnvLike = Record<string, string | undefined>;
interface BootLog {
  info(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
}

/**
 * [TA-S0-003 · MASTER-075] The boot attestation of the database tenant wall,
 * run by EVERY composition root that serves Swift's data — the API before it
 * listens, the standalone worker before its first job. Say out loud whether
 * the wall binds THIS credential, and refuse a posture that must not run (an
 * undeclared wall-less production, a second tenant without a wall, or an
 * enforced wall the application does not bind): see assertTenantWall.
 */
export async function attestTenantWallAtBoot(db: PrismaClient, log: BootLog, env: EnvLike = process.env): Promise<RlsAttestation> {
  const rls = attestationOf(await readRlsFacts(db));
  rlsAttestationGauge.labels(rls.enforced ? 'enforced' : 'bypassed').set(1);
  log[rls.enforced ? 'info' : 'warn']({ rls: rls.facts, bypasses: rls.bypasses }, `tenant wall: ${attestationLine(rls)}`);
  assertTenantWall(rls, await db.tenant.count({ where: { isActive: true } }), env);
  return rls;
}
