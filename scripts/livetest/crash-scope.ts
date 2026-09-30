import { createHash } from 'node:crypto';
import { FICTIONAL_GY } from './guard.js';

/** Only the fixture command may mint this tenant. Public signup has no tenant
 * selector; authenticated partner activation keeps the account's tenant. */
export const crashTenantId = (runId: string): string => `drill-crash-${createHash('sha256').update(runId).digest('hex').slice(0, 32)}`;
export interface CrashActor { userId: string; phone: string }
export interface CrashScope {
  version: 1;
  runId: string;
  tenantId: string;
  target: { deploymentId: string; environment: string; database: string };
  admin: CrashActor;
  customer: CrashActor;
  storeOwner: CrashActor;
  riders: Array<CrashActor & { riderId: string }>;
  store: { vendorId: string; itemId: string };
}

export function parseCrashScope(raw: unknown, runId: string, target: { deploymentId: string; environment: string }): CrashScope {
  const m = raw as CrashScope | null;
  if (!m || m.version !== 1 || m.runId !== runId || m.tenantId !== crashTenantId(runId)
      || m.target?.deploymentId !== target.deploymentId || m.target?.environment !== target.environment
      || !m.store?.vendorId || !m.store?.itemId || m.riders?.length !== 3) {
    throw new Error('an isolated crash fixture scope for this run and deployment is required');
  }
  const actors = [m.admin, m.customer, m.storeOwner, ...m.riders];
  if (actors.some((a) => !a?.userId || !FICTIONAL_GY.test(a.phone))
      || new Set(actors.map((a) => a.userId)).size !== 6
      || new Set(actors.map((a) => a.phone)).size !== 6
      || m.riders.some((a) => !a.riderId) || new Set(m.riders.map((a) => a.riderId)).size !== 3) {
    throw new Error('the isolated crash fixture actors are incomplete or ambiguous');
  }
  return m;
}
