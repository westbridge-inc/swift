import type { PrismaClient } from '@prisma/client';
import {
  assertTenantPolicyContract, assertTenantWall, attestationLine, attestationOf, readRlsFacts, readTenantPolicyContract,
  tenantPolicyContractGaps, type RlsAttestation,
} from '../lib/rls-attestation';
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
  // [DB-01] The policies themselves, against the versioned contract — refused
  // in production at any posture (see assertTenantPolicyContract).
  const contract = await readTenantPolicyContract(db);
  const gaps = tenantPolicyContractGaps(contract);
  log[gaps.length === 0 ? 'info' : 'warn']({ contract, gaps }, `tenant policy contract v${contract.version}: ${gaps.length === 0 ? 'holds' : `${gaps.length} gap(s)`}`);
  assertTenantPolicyContract(contract, env);
  assertTenantWall(rls, await db.tenant.count({ where: { isActive: true } }), env);
  return rls;
}
